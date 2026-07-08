// A runnable live-broadcast server slice (docs/PHASE2.md §8.5/§11). Minimal
// node:http — no framework — so it actually runs and can be hit by a client; the
// NestJS version exposes the same shapes. It wraps the tick core + the live
// embargo: REST serves spoiler-safe fixture views and gated replays, and an SSE
// endpoint streams the synced live match-center (everyone watching a division
// sees the same wall-clock moment). The result + snapshot stay sealed until the
// broadcast plays out.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MapId, MatchTimeline, Tactics, MatchInput } from '@ace/shared';
import { DEFAULT_TACTICS } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { fanSponsorMul, baseFans, cupRoundName, standings, planFive, MAP_POOL, fixtureMap, fixtureSeed, divSeedOffset, seasonSeedOf, overall, planOf, worldDivisions, divisionSchedule, membersOfDiv, marketBoard, marketEntry, resolveWorldBid, applySigning, resolveSale, applySale, resolveDirect, loanOut, recallLoan, squadView, resolveAiMarket, scoutCost, chargeScout, scoutedRange, SCOUT_MAX, defaultAcademy, academyView, upgradeAcademy, takeIntake, graduateProspect, cutProspect, developAcademy, topPlayers, topClubs, clubPhase, soloRank, ownedClubs, RANK_TIERS, aiStyle, aiComp, aiBestFive, aiTactics, traitOf, personOf, matchDate, birthdayPassed, displayAge, nationPools, pickFive, bestFive, newContract, renewContract, processContracts, CONTRACT_YEARS, defaultFacilities, facilityCost, facilityUpkeep, FACILITY_MAX, staffMarket, staffWageBill, STAFF_ROLES, sponsorOffers, sponsorGoalText, confidenceStatus, squadMood, talkFit, canPickCamp, teamCohesion, injuryOf, type Talk, type Camp, type FacilityId, type Facilities, type StaffHires, type StaffRole, type Academy, type WorldState, type WorldClub } from '@ace/world';
import type { Player } from '@ace/shared';
import { MemoryStore, CachedStore, type WorldStore, type FixtureRow } from './store.js';
import { seedWorld } from './seed.js';
import { runTick, seasonLength } from './tick.js';
import { resolveFriendly } from './sim.js';
import { navOf } from './nav.js';
import { publicView, liveMatchState, fixtureStatus, liveFrac } from './live.js';
import { claim, savePlan, savePlay, myClub } from './owner.js';
import { AuthService, MemoryAccountStore } from './accounts.js';
import { verifyStripeSig, vipFromEvent, vipActive, VIP_DAYS } from './billing.js';
import { IntervalScheduler, type Scheduler } from './scheduler.js';
import { authorizeUrl, exchangeCode, fetchIdentity, type OAuthProvider } from './oauth.js';
import { newRefreshToken } from './auth.js';
import { buildCircuitView, type CircuitView } from './circuitView.js';
import { buildWorldCupView, type WorldCupView } from './worldCupView.js';
import { cupViewFromState } from './cupView.js';
import { randomBytes } from 'node:crypto';

export interface LiveServerOpts {
  seed?: number; broadcastSecs?: number; port?: number;
  clock?: () => number;   // seconds; default real wall-clock
  /** If set, a Scheduler auto-advances the world a match-day every N seconds — the
   *  production "matches resolve on a schedule" behaviour (BullMQ in prod; an in-process
   *  IntervalScheduler here). The tick is the ONLY thing that owns the world clock. */
  autoAdvanceSecs?: number;
  /** DEV/DEMO ONLY: allow `POST /advance` to tick the shared world's clock from a
   *  client. Default FALSE — in the product no user action may advance a match-day
   *  (one player must never move time for everyone); the scheduled tick owns it. */
  allowManualAdvance?: boolean;
  /** Event-bus replay backlog size (tests shrink it to exercise the resync path). */
  eventBacklogMax?: number;
  /** Social sign-in providers (Google/Discord/...) — plain configs, ids/secrets from
   *  env. Empty/omitted → the buttons don't render and the routes 404. */
  oauth?: OAuthProvider[];
  /** The server's public base URL (the OAuth redirect_uri host). Defaults to the
   *  local listen address — set it in any real deployment. */
  publicBase?: string;
  /** Outbound mail seam (verification + password-reset). Configured → tokens are
   *  MAILED and never appear in responses; omitted → the dev flow surfaces them
   *  inline (an honest stand-in, same server gates). */
  mailer?: (to: string, subject: string, text: string) => Promise<void>;
  /** DEPLOYMENT SEAM — inject durable stores and the server RESUMES the world they
   *  hold instead of seeding a fresh one: the day cursor, standings, ownership,
   *  academies/mail/social all come back (verified by the restart-resume test).
   *  Omitted → an in-memory world seeded per boot (the dev/demo behaviour). */
  store?: WorldStore;
  accounts?: import('./accounts.js').AccountStore;
  /** Stable JWT signing secret (env in production) — with an injected account
   *  store this keeps issued tokens VALID across restarts. Default: random per boot. */
  jwtSecret?: string;
  /** Stripe webhook signing secret (`whsec_…`). Set → POST /billing/webhook verifies
   *  Stripe's exact signature scheme and is the VIP source of truth, and /billing/checkout
   *  returns the hosted-checkout stub. Unset (dev) → checkout activates VIP directly so
   *  the loop works without Stripe. */
  stripeWebhookSecret?: string;
}
export interface LiveServer { server: Server; url: string; id: string; store: WorldStore; auth: AuthService; close: () => Promise<void> }

const key = (f: { season: number; day: number; slot: number }) => `${f.season}:${f.day}:${f.slot}`;

// Season player stats — accumulated from the full-simmed (watched) match timelines.
// The engine keys every kill by player handle, so this is a pure tally; the match's
// top fragger earns an MVP. Gives the watched division real player careers.
interface PlayerStat { handle: string; club: string; role: string; kills: number; deaths: number; matches: number; fb: number; mvp: number; hs: number; clutch: number }
function tallyTimeline(tl: MatchTimeline, into: Map<string, PlayerStat>): void {
  const kills: Record<string, number> = {}, deaths: Record<string, number> = {}, fb: Record<string, number> = {}, hs: Record<string, number> = {}, clutch: Record<string, number> = {};
  const sideOf = new Map<string, 0 | 1>();
  tl.teams.forEach((tm, ti) => tm.players.forEach(p => sideOf.set(p.handle, ti as 0 | 1)));
  for (const r of tl.rounds) {
    const ks = r.events.filter((e): e is Extract<typeof e, { kind: 'kill' }> => e.kind === 'kill').sort((a, b) => a.t - b.t);
    // clutch detection: replay the round's alive counts — when a side first drops to a
    // LONE survivor facing 2+ enemies, that player is "in a clutch"; if their side then
    // wins the round, it converts (the 1vX every highlight reel is made of).
    const alive: [Set<string>, Set<string>] = [new Set(tl.teams[0].players.map(p => p.handle)), new Set(tl.teams[1].players.map(p => p.handle))];
    const clutcher: (string | null)[] = [null, null];
    ks.forEach((e, i) => {
      kills[e.killer] = (kills[e.killer] || 0) + 1; deaths[e.victim] = (deaths[e.victim] || 0) + 1;
      if (i === 0) fb[e.killer] = (fb[e.killer] || 0) + 1;
      if (e.hs) hs[e.killer] = (hs[e.killer] || 0) + 1;
      const vs = sideOf.get(e.victim);
      if (vs != null) {
        alive[vs].delete(e.victim);
        if (alive[vs].size === 1 && alive[1 - vs].size >= 2 && clutcher[vs] == null) clutcher[vs] = [...alive[vs]][0];
      }
    });
    const c = clutcher[r.winner];
    if (c) clutch[c] = (clutch[c] || 0) + 1;
  }
  let mvp = '', best = -1;
  for (const tm of tl.teams) for (const p of tm.players) { const k = kills[p.handle] || 0; if (k > best) { best = k; mvp = p.handle; } }
  tl.teams.forEach(tm => tm.players.forEach(p => {
    const s = into.get(p.handle) ?? { handle: p.handle, club: tm.tag, role: p.role, kills: 0, deaths: 0, matches: 0, fb: 0, mvp: 0, hs: 0, clutch: 0 };
    s.kills += kills[p.handle] || 0; s.deaths += deaths[p.handle] || 0; s.fb += fb[p.handle] || 0; s.hs += hs[p.handle] || 0; s.clutch += clutch[p.handle] || 0; s.matches += 1;
    if (p.handle === mvp) s.mvp += 1;
    into.set(p.handle, s);
  }));
}
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};
// bodies are BOUNDED (256 KB — playbooks are a few KB; sanitizePlay caps deeper):
// past the cap the socket is destroyed, so a hostile client can't stream gigabytes
// into server memory. Oversized → {} (routes then fail their own validation).
const BODY_MAX = 256 * 1024;
const readBounded = (req: IncomingMessage): Promise<string | null> => new Promise(resolve => {
  let buf = '', dead = false;
  req.on('data', c => {
    if (dead) return;
    buf += c;
    if (buf.length > BODY_MAX) { dead = true; req.destroy(); resolve(null); }
  });
  req.on('end', () => { if (!dead) resolve(buf); });
  req.on('error', () => { if (!dead) { dead = true; resolve(null); } });
});
const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const buf = await readBounded(req);
  try { return buf ? JSON.parse(buf) : {}; } catch { return {}; }
};
// the RAW body — the Stripe webhook signature is computed over the exact bytes,
// so it must be verified BEFORE any JSON parse.
const readRaw = async (req: IncomingMessage): Promise<string> => (await readBounded(req)) ?? '';

/** A player's highest-mastery agent (the engine's default pick; name tiebreak). */
const topAgentOf = (p: { agents: { agent: string; level: number }[] }) =>
  [...p.agents].sort((a, b) => b.level - a.level || (a.agent < b.agent ? -1 : 1))[0]?.agent ?? 'Jett';

/** A plain-English scouting DOSSIER from an AI club's deterministic tactics — the
 *  pre-match read (better than a CS-manager flavour blurb: it's derived from the same
 *  dials the engine resolves, so it's the truth, and it tells you how to counter). */
const scoutDossier = (t: { attack: { siteBias: number; tempo: number; lurk?: string }; defense: { read: number; aggression: number } }) => {
  const site = t.attack.siteBias > 0.12 ? 'favours A' : t.attack.siteBias < -0.12 ? 'favours B' : 'hits both sites';
  const tempo = t.attack.tempo > 0.6 ? 'fast executes' : t.attack.tempo < 0.42 ? 'slow, default-heavy' : 'measured tempo';
  const hold = t.defense.read > 0.12 ? 'stacks A on defense' : t.defense.read < -0.12 ? 'stacks B on defense' : 'reads both sites';
  const aggro = t.defense.aggression > 0.55 ? 'aggressive holds / early picks' : t.defense.aggression < 0.4 ? 'passive, retake-oriented' : 'standard holds';
  // a counter tip: attack the side they under-defend; hold the side they like to hit.
  const counter = t.defense.read > 0.12 ? 'attack B — they over-stack A'
    : t.defense.read < -0.12 ? 'attack A — they over-stack B'
    : t.attack.siteBias > 0.12 ? 'stack A on defense — they love hitting A'
    : t.attack.siteBias < -0.12 ? 'stack B on defense — they love hitting B'
    : 'balanced — no obvious tell to exploit';
  return { attack: `${site}, ${tempo}`, defense: `${hold}, ${aggro}`, lurk: !!t.attack.lurk, counter };
};

/** The controller's smoke SHAPE, read off the fielded agent — the utility scouting
 *  line (walls cut a lane, recasts leave a swing gap, Brimstone holds one big
 *  window). Mirrors the engine's WALL_AGENTS/RECAST_AGENTS identity. */
const smokeShape = (ctrlAgent: string | undefined): string | null => {
  if (!ctrlAgent) return null;
  if (ctrlAgent === 'Viper' || ctrlAgent === 'Harbor') return `${ctrlAgent} WALLS the lane — expect a cut; trade around its ends`;
  if (ctrlAgent === 'Brimstone') return 'Brimstone: one big smoke window — hit as it expires';
  if (ctrlAgent === 'Omen' || ctrlAgent === 'Astra' || ctrlAgent === 'Clove') return `${ctrlAgent} RECASTS — an open gap between blooms; time the swing`;
  return null;
};

/** The full KIT read — every fielded agent's archetype line, mirrored from the
 *  engine's identity sets (initiator recon/concuss, sentinel lockdown/wire/slow,
 *  duelist dash/nade/flash). The comp IS the utility geometry now; this makes an
 *  opponent's comp legible as a game plan, not a list of names. */
const kitRead = (five: { role: string; handle: string }[], agentOf: (i: number) => string): string[] => {
  const lines: string[] = [];
  five.forEach((p, i) => {
    const a = agentOf(i);
    if (p.role === 'initiator') {
      if (['Sova', 'Fade', 'Gekko'].includes(a)) lines.push(`${a} recon — they take the first shot off the reveal; don't hold the obvious angle`);
      else if (['Breach', 'Skye', 'KAY/O'].includes(a)) lines.push(`${a} concuss — set holds get stripped in the pulse; don't anchor inside it`);
    } else if (p.role === 'sentinel') {
      if (['Cypher', 'Deadlock', 'Vyse'].includes(a)) lines.push(`${a} wires — an info NET (flank + connector); your rotations get lit`);
      else if (a === 'Sage') lines.push(`Sage slow-field — crossing costs time but reveals nothing; pay the delay, not the flank`);
      else lines.push(`${a} lockdown — one deep flank zone; a lurk walks into it`);
    } else if (p.role === 'duelist') {
      if (['Jett', 'Neon'].includes(a)) lines.push(`${a} dash — the opening pick may not stick (escapes once a round); re-hit while she recovers`);
      else if (a === 'Raze') lines.push(`Raze nade — entries come with chip damage; don't stack the entry cone`);
    }
  });
  return lines;
};

/** The public club page (§9) — identity, division, lifecycle, the fielded five (with each
 *  player's fielded AGENT, so you scout the real comp), and whether a human owns it. For an
 *  AI club this is exactly what it'll field next: `aiBestFive` (the patch-aware five) + the
 *  meta-aware `aiComp`. Read-only, always available (no embargo on a club). */
const publicClub = (w: WorldState, c: WorldClub) => {
  const ai = c.owner == null;
  const fivePlayers = ai ? aiBestFive(c.roster, w.patch) : planFive(c);
  const team = { id: c.id, tag: c.tag, name: c.name, players: fivePlayers };
  const comp = ai ? aiComp(team, w.patch) : c.comp;
  return {
    tag: c.tag, name: c.name, tier: c.tier, group: c.group, titles: c.titles, intlTitles: c.intlTitles ?? 0,
    owned: !ai, rating: Math.round(c.strength * 100), phase: clubPhase(team),
    // the FOLLOWING: real for an owned club, the stature baseline for AI
    fans: c.fans ?? baseFans(c.strength, c.tier, c.titles),
    // an AI club's tactical IDENTITY (Phase 5) — scout it to know how a rival plays; a
    // human-owned club authors its own tactics, so it has no fixed AI style.
    style: ai ? (({ archetype, label }) => ({ archetype, label }))(aiStyle(team)) : null,
    // the pre-match scouting read — tendencies + a counter tip, from the AI's real dials
    // (+ the controller's smoke SHAPE from the fielded comp — walls / recast / big window).
    dossier: ai ? {
      ...scoutDossier(aiTactics(team)),
      smoke: smokeShape(fivePlayers.map(p => comp[p.id] ?? topAgentOf(p)).find(a2 =>
        ['Viper', 'Harbor', 'Brimstone', 'Omen', 'Astra', 'Clove'].includes(a2))),
      kit: kitRead(fivePlayers, i => comp[fivePlayers[i].id] ?? topAgentOf(fivePlayers[i])),
    } : null,
    five: fivePlayers.map(p => {
      const ovr = Math.round(overall(p)), sr = soloRank(ovr);
      // the person behind the handle — real name + nationality (hash-derived, pure)
      const person = personOf(p.id);
      return { handle: p.handle, role: p.role, overall: ovr, igl: !!p.igl, solo: sr.label, soloTier: sr.tier,
               agent: comp[p.id] ?? topAgentOf(p), trait: traitOf(p.id)?.label ?? null,
               name: person.name, country: person.nation.country, flag: person.nation.flag, age: p.age,
               accolades: p.accolades };
    }),
  };
};

/** Embargo-aware standings (§8.5): derived from RESOLVED fixtures only, so the
 *  table never moves mid-broadcast. Built from the store's fixture rows (not the
 *  world's results) so the `revealAt` gate is honoured. */
function standingsView(w: WorldState, rows: FixtureRow[], tier: number, group: number, now: number) {
  const inDiv = rows.filter(r => fixtureStatus(r, now) === 'resolved' && w.clubs[r.home].tier === tier && w.clubs[r.home].group === group);
  const results = inDiv.map(r => ({ home: r.home, away: r.away, score: [r.homeScore, r.awayScore] as [number, number], winner: r.winner, seed: r.seed }));
  return standings(w.clubs.length, results)
    .filter(s => w.clubs[s.club].tier === tier && w.clubs[s.club].group === group)
    .map(s => ({ club: w.clubs[s.club].tag, played: s.played, won: s.won, lost: s.lost, diff: s.diff, points: s.points }));
}

/** Boot a world, kick its Premier (division 0) off live *now*, and serve it. The
 *  watchable fixtures' timelines are re-simmed once and cached as the live source
 *  the stream gates; everything else quick-resolves and is just a sealed score. */
export async function startLiveServer(opts: LiveServerOpts = {}): Promise<LiveServer> {
  const clock = opts.clock ?? (() => Date.now() / 1000);
  const broadcastSecs = opts.broadcastSecs ?? 2400;
  // the read-cache wrapper is the scale fix: 60+ read routes load the world per
  // request, and a raw store clones the multi-MB WorldState each time — behind
  // the cache a read is a shared reference (cloned once per WRITE instead).
  const store = new CachedStore(opts.store ?? new MemoryStore());
  // RESUME an existing world (an injected durable store across a restart) or
  // seed a fresh one (dev/demo). Resume restores the live cursor from the world
  // itself; the interrupted broadcast window is treated as already revealed.
  const priorIds = await store.listWorlds();
  const resumed = priorIds.length > 0;
  const id = resumed ? priorIds[0] : await seedWorld(store, { seed: opts.seed ?? 7, region: 'AMER' });
  const accounts = opts.accounts ?? new MemoryAccountStore();
  const auth = new AuthService(accounts, opts.jwtSecret ?? randomBytes(32).toString('hex'), clock);
  /** Is this account VIP right now? Feature checks read this and nothing else —
   *  VIP is convenience/depth (scout discount, badge), never the sim. */
  const isVip = async (acct: string | null): Promise<boolean> =>
    !!acct && vipActive((await accounts.byId(acct))?.vipUntil, clock());
  const circuitSeed = opts.seed ?? 7;
  let circuit: CircuitView | undefined;   // the international circuit, computed once on demand
  let worldCupCache: WorldCupView | undefined;   // the World Cup, recomputed each season
  let worldCupGames = new Map<string, MatchInput>();   // game id → snapshot (re-simmed to watch)
  /** Rebuild the World Cup (every game engine-simmed) if stale, and return the view. */
  const ensureWorldCup = (w: WorldState): WorldCupView => {
    if (!worldCupCache || worldCupCache.season !== w.season) {
      const built = buildWorldCupView(w, navOf, wcHooks(w));
      worldCupCache = built.view; worldCupGames = built.games;
    }
    return worldCupCache;
  };
  // National-team manager ELECTIONS (the World Cup social layer): human club-owners run
  // to manage a nation, others vote, and the winner authors the nation's tactics — which
  // drive the engine-simmed final. In-memory per server (Pg follow-up like the other
  // per-account state). Keyed by 3-letter country code.
  interface NationElection { candidates: string[]; votes: Map<string, string>; tactics?: Tactics; lineup?: string[]; comp?: Record<string, string> }
  // World Cup legacy: a champion crowns the NATION and its elected MANAGER (the trophy is
  // theirs). Recorded at each season rollover; drives the manager/nation honor boards.
  interface WCTitle { season: number; code: string; country: string; flag: string; managerTag: string | null; managerAccount: string | null }
  const worldCupHistory: WCTitle[] = [];
  const elections = new Map<string, NationElection>();
  const electionOf = (code: string): NationElection => {
    let e = elections.get(code);
    if (!e) { e = { candidates: [], votes: new Map() }; elections.set(code, e); }
    return e;
  };
  const clubTagOf = (w: WorldState, account: string): string | null => w.clubs.find(c => c.owner === account)?.tag ?? null;
  const tallyVotes = (e: NationElection, cand: string): number => { let n = 0; for (const v of e.votes.values()) if (v === cand) n++; return n; };
  // the elected manager: the candidate with the most votes (ties → first to run)
  const electedManager = (code: string): string | null => {
    const e = elections.get(code); if (!e || !e.candidates.length) return null;
    let best = e.candidates[0], bestN = -1;
    for (const cand of e.candidates) { const n = tallyVotes(e, cand); if (n > bestN) { bestN = n; best = cand; } }
    return best;
  };
  // the nation's plan: the ELECTED manager's authored tactics (an ousted manager's plan
  // doesn't drive the team — only the sitting manager's does).
  const nationTactics = (code: string): Tactics | undefined => {
    const mgr = electedManager(code); if (!mgr) return undefined;
    return elections.get(code)?.tactics;
  };
  // the manager's chosen XI (player ids); only applies while there's a sitting manager
  const nationLineup = (code: string): string[] | undefined => {
    const mgr = electedManager(code); if (!mgr) return undefined;
    return elections.get(code)?.lineup;
  };
  // the manager's per-player agent picks (the comp) — manager-gated too
  const nationComp = (code: string): Record<string, string> | undefined => {
    const mgr = electedManager(code); if (!mgr) return undefined;
    return elections.get(code)?.comp;
  };
  const wcHooks = (w: WorldState) => ({
    tacticsOf: nationTactics, lineupOf: nationLineup, compOf: nationComp,
    managerOf: (code: string) => { const a = electedManager(code); return a ? clubTagOf(w, a) : null; },
  });
  const bustWorldCup = () => { worldCupCache = undefined; };   // an election change re-sims the final
  // cup legacy: the season's winners, recorded at each rollover (drives the news + honors).
  // The cup itself is DURABLE in WorldState.cup (the tick resolves it day-by-day); `/cup`
  // just shapes that persisted state — see cupViewFromState.
  interface CupTitle { season: number; tag: string; name: string; tier: number }
  const cupHistory: CupTitle[] = [];
  // the transfer market: a free-agent board built once (stable) + a `sold` set of
  // handles already signed this session (a regenerated board would shift, so cache it)
  let board: Player[] | undefined;
  const sold = new Set<string>();
  // scouting reports: per-account private knowledge (account → handle → level 0..MAX).
  // Knowledge is the owner's session state; only the money it costs is world state.
  const scoutReports = new Map<string, Map<string, number>>();
  const scoutLevelOf = (account: string | null, handle: string) => (account && scoutReports.get(account)?.get(handle)) || 0;
  const addReport = (account: string, handle: string, level: number) => {
    const r = scoutReports.get(account) ?? new Map<string, number>();
    r.set(handle, level); scoutReports.set(account, r);
  };
  // the academy: each owner's homegrown youth pipeline (account → Academy). Knowledge
  // + prospects are the owner's state; the money (upgrade, upkeep) hits the club balance.
  const academies = new Map<string, Academy>();
  const acadOf = (account: string) => academies.get(account) ?? defaultAcademy();
  // (persistAccount + hydration live below, once the notif + mail maps are declared too)
  // every handle in the world that an intake must avoid (engine assumes unique handles):
  // every rostered player, every academy prospect, AND the cached free-agent board (a
  // promoted prospect must never collide with a signable free agent).
  const allHandles = (w: WorldState): Set<string> => {
    const s = new Set<string>();
    for (const c of w.clubs) for (const p of c.roster) s.add(p.handle);
    for (const a of academies.values()) for (const p of a.prospects) s.add(p.handle);
    if (board) for (const p of board) s.add(p.handle);
    return s;
  };
  // a stable per-account salt so each owner's prospect development draws its own stream
  const acadSalt = (account: string) => { let h = 2166136261 >>> 0; for (let i = 0; i < account.length; i++) h = Math.imul(h ^ account.charCodeAt(i), 16777619) >>> 0; return h >>> 0; };
  // the legacy engine (DESIGN §9.2): the world remembers its champions, season by season
  const honors: { season: number; champion: string }[] = [];
  // the world news feed (DESIGN §9 — the world feels alive): a rolling log of what's
  // ── the WORLD EVENT BUS (the live-sync spine) ──────────────────────────────
  // One SSE stream (`GET /events`) every client hangs on; every state change the
  // FE cares about is emitted as a SEQUENCE-NUMBERED event. Sync is guaranteed
  // three ways: (1) push replaces polling, so a connected client is fresh within
  // one RTT of the change; (2) EventSource auto-reconnect presents Last-Event-ID
  // and the server REPLAYS the missed tail from a bounded backlog; (3) a gap the
  // backlog can't cover gets an explicit `resync` event — the client refetches
  // everything. A client can be behind, but never silently stale.
  // Account-targeted events (notif/mail) only reach that account's connections.
  // Fan-out is O(connections) string writes of ONE prebuilt payload — no
  // per-client compute — so thousands of subscribers are fine.
  interface EvClient { res: ServerResponse; account: string | null }
  const evClients = new Set<EvClient>();
  let evSeq = 0;
  const EV_BACKLOG_MAX = opts.eventBacklogMax ?? 800;
  const evBacklog: { seq: number; ev: string; data: string; account?: string }[] = [];
  const emit = (ev: string, data: unknown, account?: string) => {
    const seq = ++evSeq;
    const payload = JSON.stringify(data ?? {});
    evBacklog.push({ seq, ev, data: payload, account });
    if (evBacklog.length > EV_BACKLOG_MAX) evBacklog.splice(0, evBacklog.length - EV_BACKLOG_MAX);
    const msg = `id: ${seq}\nevent: ${ev}\ndata: ${payload}\n\n`;
    for (const c of evClients) {
      if (account && c.account !== account) continue;
      try { c.res.write(msg); } catch { evClients.delete(c); }
    }
  };
  // one shared heartbeat keeps idle streams alive through proxies + prunes the dead
  const evHeartbeat = setInterval(() => {
    for (const c of evClients) { try { c.res.write(':hb\n\n'); } catch { evClients.delete(c); } }
  }, 25000);
  // the reveal moment is a real event (standings/results unlock) — armed per live day
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  const armReveal = (season: number, day: number, revealAt: number) => {
    if (revealTimer) clearTimeout(revealTimer);
    const ms = Math.max(0, (revealAt - clock()) * 1000);
    revealTimer = setTimeout(() => emit('reveal', { season, day }), ms);
  };

  // happening — signings, champions. Newest pushed last; the API returns it reversed.
  const news: { kind: 'transfer' | 'champion' | 'season' | 'award'; text: string; season: number; day: number; tag?: string }[] = [];
  const pushNews = (kind: 'transfer' | 'champion' | 'season' | 'award', text: string, season: number, day: number, tag?: string) => {
    news.push({ kind, text, season, day, tag });
    if (news.length > 60) news.shift();   // keep it bounded
    emit('news', { kind, text, season, day, tag });
  };
  // per-account notifications — the world news feed targeted to YOU (your fixtures +
  // results, season outcomes, your player's awards). In-memory keyed by account (the
  // PgStore per-account table is the same follow-up as academy/scout state).
  type NotifKind = 'fixture' | 'result' | 'season' | 'award' | 'system';
  type NotifLink = { kind: 'replay'; season: number; day: number; slot: number } | { kind: 'club'; tag: string };
  interface Notif { id: number; kind: NotifKind; text: string; season: number; day: number; read: boolean; at: number; link?: NotifLink }
  const notifs = new Map<string, Notif[]>();
  let notifSeq = 0;
  const notify = (account: string, kind: NotifKind, text: string, season: number, day: number, link?: NotifLink) => {
    const list = notifs.get(account) ?? [];
    list.unshift({ id: ++notifSeq, kind, text, season, day, read: false, at: clock(), link });
    if (list.length > 50) list.length = 50;   // bounded inbox
    notifs.set(account, list);
    emit('notif', { kind, text }, account);   // targeted push — the bell updates live
  };
  const notifiedLive = new Set<string>(), notifiedResults = new Set<string>();   // fixture keys already notified (no dupes)
  const notifiedDraws = new Set<string>();   // cup draws already announced (season:round)
  const fanMarks = new Map<string, number>();   // owner → last fan milestone told (init silently at claim baseline)
  const FAN_MARKS = [500, 1000, 2000, 5000, 10000, 15000, 20000, 30000, 50000, 75000, 100000, 150000, 250000];
  const fanMark = (f: number) => { let m = 0; for (const t of FAN_MARKS) if (f >= t) m = t; return m; };
  const notifiedBdays = new Set<string>();   // season:day:playerId birthdays already shouted out
  const injuredKnown = new Set<string>();    // account:playerId currently known injured (fire once per spell)
  // owner-to-owner mail (human-to-human, DESIGN §16 social) — real CONVERSATIONS: every
  // message is delivered to BOTH participants' mailboxes (sender's copy read, recipient's
  // unread) and tagged with a `threadId` so a reply continues the thread. `mine` is set
  // per copy (did this mailbox's owner send it). Keyed by account.
  interface MailMsg { id: number; threadId: number; fromAccount: string; fromTag: string; fromName: string; toTag: string; subject: string; body: string; season: number; day: number; read: boolean; mine: boolean; at: number }
  const mailboxes = new Map<string, MailMsg[]>();
  // the owner's CAREER LOG — one record per season at the rollover (the personal legacy the
  // Trophy Room aggregates: titles, promotions, cup wins, briefs met). Persisted per account.
  interface CareerEntry { season: number; tier: number; divName: string; finish: number; champion: boolean; promoted: boolean; relegated: boolean; cupWon: boolean; intlWon: boolean; briefMet: boolean }
  const careers = new Map<string, CareerEntry[]>();
  let mailSeq = 0;
  const pushMail = (account: string, m: MailMsg) => { const box = mailboxes.get(account) ?? []; box.unshift(m); if (box.length > 200) box.length = 200; mailboxes.set(account, box); };
  // The academy + scout + notif + mail Maps are a write-through CACHE over the store's
  // per-account data blob (`ace_account_data`), so a PgStore-backed deployment keeps a
  // human's youth pipeline, scout reports, and inboxes across restarts. Hydrated at
  // startup; the seq counters resume past the restored ids so new ones never collide.
  const persistAccount = (account: string) => store.saveAccountData(id, account, {
    academy: academies.get(account) ?? null,
    scout: Object.fromEntries(scoutReports.get(account) ?? []),
    notifs: notifs.get(account) ?? [],
    mail: mailboxes.get(account) ?? [],
    career: careers.get(account) ?? [],
  });
  for (const { account, data } of await store.listAccountData(id)) {
    if (data.academy) academies.set(account, data.academy as Academy);
    if (data.scout) scoutReports.set(account, new Map(Object.entries(data.scout as Record<string, number>)));
    if (Array.isArray(data.notifs)) notifs.set(account, data.notifs as Notif[]);
    if (Array.isArray(data.mail)) mailboxes.set(account, data.mail as MailMsg[]);
    if (Array.isArray(data.career)) careers.set(account, data.career as CareerEntry[]);
  }
  for (const list of notifs.values()) for (const n of list) notifSeq = Math.max(notifSeq, n.id);
  for (const box of mailboxes.values()) for (const m of box) mailSeq = Math.max(mailSeq, m.id);
  // PREMIER PLAYOFFS — the season climax, engine-simmed at the rollover with the
  // real map veto over the live pool: the bracket view + every game's snapshot
  // (watchable) are kept per season. Bounded history.
  interface PlayoffGameView { seed: number; map: string; score: [number, number]; winner: string }
  interface PlayoffSeriesView { label: string; need: number; hi: string; lo: string; wins: [number, number]; winner: string; veto: { team: string; action: string; map: string }[]; games: PlayoffGameView[] }
  interface PlayoffView { season: number; qualified: string[]; rounds: PlayoffSeriesView[][]; champion: string }
  const playoffHistory: PlayoffView[] = [];
  const playoffSnaps = new Map<string, MatchInput>();   // `${season}:${seed}` → input

  // FRIENDLY CHALLENGES — on-demand matches (human vs human, or a scrim vs an AI
  // club): resolved INSTANTLY with the real engine (playbooks/fitness/morale all
  // bite), no standings impact, no embargo — the snapshot is stored verbatim so
  // the replay reproduces byte-for-byte. Bounded list, newest first.
  interface Friendly { id: number; at: number; season: number; day: number; map: string; home: { tag: string; name: string }; away: { tag: string; name: string }; score: [number, number]; snapshot: MatchInput; accounts: string[] }
  const friendlies: Friendly[] = [];
  let friendlySeq = 0;
  // anti-spam: one challenge per PAIR per match-day (either direction) — a rival
  // can't flood your bell, and a farmed H2H means nothing.
  const challengedToday = new Set<string>();
  const pairKey = (a: string, b: string) => { const [x, y] = [a, b].sort(); return `${x}|${y}`; };

  // WORLD-SCOPED social state (friendlies + playoff brackets) rides the same
  // durable blob store under a reserved key — a Pg-backed deployment keeps the
  // friendly history and every playoff bracket + snapshot across restarts.
  const SOCIAL_KEY = '__social__';
  // human-to-human TRANSFER OFFERS (the direct PvP economy): a pending offer from
  // one owner for a player on another owner's roster — accept moves player + fee
  // through the same applySale commit every transfer path uses. Durable (social blob).
  interface TransferOffer { id: number; from: string; fromTag: string; to: string; toTag: string; playerId: string; handle: string; amount: number; status: 'pending' | 'accepted' | 'declined' | 'withdrawn'; season: number; day: number; at: number }
  const transferOffers: TransferOffer[] = [];
  let transferSeq = 0;
  // season individual honours (MVP + Young Gun), crowned at each rollover from
  // the real stat tallies — the Hall of Fame remembers people, not just clubs
  interface SeasonAward { season: number; mvp: { handle: string; club: string; kills: number } | null; youngGun: { handle: string; club: string; kills: number; age: number } | null }
  const seasonAwards: SeasonAward[] = [];
  // ALL-TIME player careers: each rollover folds the finishing season's stat tally
  // into this ledger, so legends accumulate across seasons (handles are globally
  // unique; `club` tracks the latest). Durable — legends survive restarts.
  const careerStats: Record<string, PlayerStat & { seasons: number }> = {};
  // the induction bar (deliberately high — enshrinement should be rare): a completed
  // career with a monster body of work or a season-MVP title
  const isLegend = (c2: PlayerStat & { seasons: number; retired?: boolean }) =>
    !!c2.retired && (c2.kills >= 1000 || seasonAwards.some(a => a.mvp?.handle === c2.handle));
  const persistSocial = () => store.saveAccountData(id, SOCIAL_KEY, {
    friendlies, friendlySeq,
    playoffHistory, playoffSnaps: Object.fromEntries(playoffSnaps),
    honors, worldCupHistory, cupHistory,
    transferOffers, transferSeq, seasonAwards, careerStats,
  });
  {
    const social = await store.loadAccountData(id, SOCIAL_KEY);
    if (social) {
      if (Array.isArray(social.friendlies)) friendlies.push(...(social.friendlies as Friendly[]));
      friendlySeq = (social.friendlySeq as number) ?? friendlies.reduce((m, f) => Math.max(m, f.id), 0);
      if (Array.isArray(social.playoffHistory)) playoffHistory.push(...(social.playoffHistory as PlayoffView[]));
      for (const [k, v] of Object.entries((social.playoffSnaps as Record<string, MatchInput>) ?? {})) playoffSnaps.set(k, v);
      if (Array.isArray(social.honors)) honors.push(...(social.honors as typeof honors));
      if (Array.isArray(social.worldCupHistory)) worldCupHistory.push(...(social.worldCupHistory as typeof worldCupHistory));
      if (Array.isArray(social.cupHistory)) cupHistory.push(...(social.cupHistory as typeof cupHistory));
      if (Array.isArray(social.transferOffers)) transferOffers.push(...(social.transferOffers as TransferOffer[]));
      if (Array.isArray(social.seasonAwards)) seasonAwards.push(...(social.seasonAwards as SeasonAward[]));
      if (social.careerStats && typeof social.careerStats === 'object') Object.assign(careerStats, social.careerStats as typeof careerStats);
      transferSeq = (social.transferSeq as number) ?? transferOffers.reduce((m, o) => Math.max(m, o.id), 0);
    }
  }
  // live chat — real-time channels (SSE fan-out), one ROOM per channel: 'global' (the
  // whole league) + a per-division room `div:<tier>:<group>`, so owners get a community
  // alongside the league-wide chat. Each room has a bounded backlog + its own subscriber
  // set; a connection carries the owner's club `tag` for PRESENCE (who's online).
  interface ChatMsg { id: number; room: string; fromTag: string; fromName: string; text: string; at: number }
  interface ChatConn { res: ServerResponse; tag: string | null }
  const chatLogs = new Map<string, ChatMsg[]>();
  const chatRooms = new Map<string, Set<ChatConn>>();
  let chatSeq = 0;
  const roomConns = (room: string) => { let s = chatRooms.get(room); if (!s) { s = new Set(); chatRooms.set(room, s); } return s; };
  const presenceOf = (room: string) => [...new Set([...roomConns(room)].map(c => c.tag).filter((t): t is string => !!t))].sort();
  const chatWrite = (conns: Iterable<ChatConn>, payload: string) => { for (const c of conns) { try { c.res.write(payload); } catch { /* dead socket pruned on close */ } } };
  const chatBroadcast = (m: ChatMsg) => chatWrite(roomConns(m.room), `data: ${JSON.stringify(m)}\n\n`);
  const broadcastPresence = (room: string) => chatWrite(roomConns(room), `event: presence\ndata: ${JSON.stringify(presenceOf(room))}\n\n`);
  const ord = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };
  const tierName = (t: number) => RANK_TIERS[t] ?? `Tier ${t + 1}`;
  const getBoard = async () => (board ??= marketBoard((await store.loadWorld(id))!));
  // the live broadcast cursor — which match-day is on air + when it kicked off. Mutable
  // so the season can PROGRESS: `advance` ticks the next day and moves the cursor.
  let liveDay = 0;
  let liveKickoff = clock();
  // relevance scoping: the Premier is always on air, and ANY division holding a human-owned
  // club is full-simmed too — so a relegated owner's matches stay watchable and their
  // match-night levers (fitness/morale/team talk) keep biting the engine, not the quick-resolve.
  const fullDivs = (w: WorldState) => {
    const owned = new Set(w.clubs.filter(c => c.owner).map(c => c.tier));
    return (d: number) => d === 0 || owned.has(d);
  };
  if (resumed) {
    // the world's day cursor is the NEXT day to resolve; the last resolved one is
    // back on air as already-revealed history (its window ended with the old process)
    const w0 = (await store.loadWorld(id))!;
    liveDay = Math.max(0, w0.day - 1);
    liveKickoff = clock() - broadcastSecs - 1;
  } else {
    await runTick(store, id, { full: fullDivs((await store.loadWorld(id))!), navOf, kickoffAt: liveKickoff, broadcastSecs });
  }

  // re-sim each watchable fixture once → the live source the match-center streams.
  // Keyed by season:day:slot, so days accumulate as the season advances.
  const timelines = new Map<string, MatchTimeline>();
  // shared live-broadcast frame hubs, one per (season, day) — see the /live route
  interface LiveHub { clients: Set<ServerResponse>; timer: ReturnType<typeof setInterval> | null; frame?: () => void }
  const liveHubs = new Map<string, LiveHub>();
  // season stat-leaders memo (recomputed only when a new reveal lands)
  let statsMemo: { key: string; body: unknown } | null = null;
  // leaderboard/power-rankings memos, keyed by (season, day[, role]) — bounded
  const rankMemo = new Map<string, unknown>();
  const cacheDay = async (season: number, day: number) => {
    for (const f of await store.fixtures(id, season)) if (f.day === day && f.inputSnapshot && !timelines.has(key(f))) timelines.set(key(f), simulateMatch(f.inputSnapshot, navOf(f.inputSnapshot.map), 0));
  };
  {
    // rebuild the live-source timelines from the stored snapshots: the boot day on a
    // fresh world, EVERY resolved day of the current season on a resume (stats +
    // live views need them; each is one deterministic re-sim of a stored input).
    const w0 = (await store.loadWorld(id))!;
    for (let d = 0; d <= liveDay; d++) await cacheDay(w0.season, d);
    armReveal(w0.season, liveDay, liveKickoff + broadcastSecs);
  }
  /** Tick the next match-day onto the air (a fresh broadcast window). The owner's
   *  authored tactics drive their fixtures, so a season plays out under your plan.
   *  At the season boundary it rolls the season over (playoffs → settle → develop →
   *  patch → promote/relegate) and puts the NEW season's day 0 on air — so the season
   *  cycle completes: a champion is crowned and a fresh season begins. */
  let nextTickAt: number | null = null;   // when the scheduled tick next fires (the client countdown)
  const advance = async (): Promise<{ broadcastDay: number; done: boolean; rollover?: boolean; season?: number; champion?: string; rivalSignings?: number }> => {
    const tickDay = async (w: WorldState) => {
      liveKickoff = clock();
      await runTick(store, id, { full: fullDivs(w), navOf, kickoffAt: liveKickoff, broadcastSecs });
      liveDay = w.day;
      await cacheDay(w.season, w.day);
      // push the new live day to every connected client + arm the reveal moment
      emit('day', { season: w.season, day: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs });
      armReveal(w.season, liveDay, liveKickoff + broadcastSecs);
    };
    // the living market: a couple of AI clubs sign the best free agents each tick
    const churnMarket = async (): Promise<number> => {
      const avail = (await getBoard()).filter(p => !sold.has(p.handle));
      const w0 = (await store.loadWorld(id))!;
      const { world: nw, signings } = resolveAiMarket(w0, avail, 2);
      if (signings.length) {
        await store.saveWorld(id, nw);
        signings.forEach(s => { sold.add(s.handle); pushNews('transfer', `${s.club} signed ${s.handle} ($${(s.fee / 1000).toFixed(1)}k)`, w0.season, liveDay, s.club); });
        emit('market', { sold: signings.map(s => s.handle) });   // boards refresh live
      }
      return signings.length;
    };
    // each owner's academy ticks at the season boundary: a full season of prospect
    // development (reps + bootcamp + age), then the new season's intake class arrives.
    const tickAcademies = async (newSeason: number) => {
      if (!academies.size) return;
      await getBoard();   // the intake must exclude FA-board handles too
      for (const [acct, a] of academies) {
        const c = await myClub(store, id, acct);
        if (!c) continue;
        const dev = developAcademy((await store.loadWorld(id))!, c.id, a, newSeason, acadSalt(acct));
        let acad = dev.academy;
        acad = takeIntake(((dev.world.seed ^ 0x5f356495) >>> 0), newSeason, acad, allHandles(dev.world));
        academies.set(acct, acad);
        await store.saveWorld(id, dev.world);
        await persistAccount(acct);
      }
    };
    // targeted notifications: each owner gets their fixture-going-live + any new result
    // (deduped by fixture key, so the same event never double-notifies).
    const notifyOwners = async () => {
      const wn = (await store.loadWorld(id))!;
      // the CUP DRAW SHOW: one world-news item per freshly-drawn round (owners or not)
      {
        const pend = wn.cup?.pending;
        if (pend && !notifiedDraws.has(`world:${wn.season}:${pend.round}`)) {
          notifiedDraws.add(`world:${wn.season}:${pend.round}`);
          const marquee = [...pend.pairs].sort((x, y) => (wn.clubs[y[0]].strength + wn.clubs[y[1]].strength) - (wn.clubs[x[0]].strength + wn.clubs[x[1]].strength))[0];
          if (marquee) pushNews('season', `🎱 Cup draw: ${cupRoundName(pend.pairs.length * 2)} — the marquee tie is ${wn.clubs[marquee[0]].tag} vs ${wn.clubs[marquee[1]].tag}`, wn.season, liveDay, wn.clubs[marquee[0]].tag);
        }
      }
      const owned = ownedClubs(wn);
      if (!owned.length) return;
      const rows = await store.fixtures(id, wn.season);
      for (const c of owned) {
        if (!c.owner) continue;
        const ci = wn.clubs.indexOf(c);
        for (const f of rows) {
          if (f.home !== ci && f.away !== ci) continue;
          const k = key(f), opp = labelOf(f.home === ci ? f.away : f.home);
          if (f.day === liveDay && !notifiedLive.has(k)) {
            notifiedLive.add(k);
            notify(c.owner, 'fixture', `Match-day ${f.day + 1}: ${c.tag} vs ${opp.tag}${f.inputSnapshot ? ' · ' + f.inputSnapshot.map : ''} — live now`, wn.season, f.day);
          }
          if (fixtureStatus(f, clock()) === 'resolved' && !notifiedResults.has(k)) {
            notifiedResults.add(k);
            const us = f.home === ci ? f.homeScore : f.awayScore, them = f.home === ci ? f.awayScore : f.homeScore;
            const won = us > them;
            // a derby (vs your rival) carries extra weight — bragging rights either way
            const derby = c.rival === wn.clubs[f.home === ci ? f.away : f.home].id;
            const msg = derby
              ? `⚔ ${won ? 'WON the derby' : 'lost the derby'} ${us}–${them} vs ${opp.tag} — ${won ? 'bragging rights are yours' : 'they get the bragging rights'}`
              : `${won ? 'WON' : 'LOST'} ${us}–${them} vs ${opp.tag}`;
            notify(c.owner, 'result', msg + ' · tap to watch it back', wn.season, f.day, { kind: 'replay', season: f.season, day: f.day, slot: f.slot });
          }
        }
        // the CUP DRAW: announce a freshly-drawn round to any owner whose club is in it
        const pend = wn.cup?.pending;
        if (pend) {
          const dk = `${wn.season}:${pend.round}`;
          const myIdx = wn.clubs.findIndex(x => x.id === c.id);
          const myPair = pend.pairs.find(([h, a]) => h === myIdx || a === myIdx);
          if (myPair && !notifiedDraws.has(`${dk}:${c.id}`)) {
            notifiedDraws.add(`${dk}:${c.id}`);
            const opp = wn.clubs[myPair[0] === myIdx ? myPair[1] : myPair[0]];
            notify(c.owner, 'fixture', `🏆 Cup draw: you face ${opp.tag} (${tierName(opp.tier)}) — the balls are out`, wn.season, liveDay, { kind: 'club', tag: opp.tag });
          }
        }
        // birthdays: any roster player whose birthday falls between the last match-day and
        // this one turns a year older — shout them out (mirrors the single-player banner).
        if (liveDay >= 1) {
          const today = matchDate(wn.season, liveDay), prev = matchDate(wn.season, liveDay - 1);
          for (const p of c.roster) {
            const bd = personOf(p.id).birthday;
            if (!(birthdayPassed(bd, today) && !birthdayPassed(bd, prev))) continue;
            const bk = `${wn.season}:${liveDay}:${p.id}`;
            if (notifiedBdays.has(bk)) continue;
            notifiedBdays.add(bk);
            notify(c.owner, 'system', `🎂 ${p.handle} (${personOf(p.id).name}) turns ${displayAge(p.age, bd, today)} today`, wn.season, liveDay);
          }
        }
        // fan milestones: crossing a follower line is a brand moment worth telling.
        // Initialized SILENTLY on first sight, so claiming a club never fires one
        // for the baseline following it inherited — only real growth announces.
        if (c.fans != null) {
          // high-water: a mark is told ONCE — dipping under and re-crossing is not news
          const mark = fanMark(c.fans), prev = fanMarks.get(c.owner);
          if (prev == null) fanMarks.set(c.owner, mark);
          else if (mark > prev) {
            fanMarks.set(c.owner, mark);
            const label = mark >= 1000 ? `${mark / 1000}k` : `${mark}`;
            notify(c.owner, 'system', `◉ Your following crossed ${label} — the brand is growing, and sponsors price it in`, wn.season, liveDay);
          }
        }
        // injuries: a starter who just picked up a knock — fire once per spell (tracked so a
        // multi-day injury doesn't re-notify each match-day), clear when he heals up.
        for (const p of c.roster) {
          const ik = `${c.owner}:${p.id}`, hurt = injuryOf(wn.fitness, p.id) > 0;
          if (hurt && !injuredKnown.has(ik)) {
            injuredKnown.add(ik);
            notify(c.owner, 'system', `⚕ ${p.handle} picked up an injury — out ${injuryOf(wn.fitness, p.id)} match-day(s); rotate a reserve in`, wn.season, liveDay);
          } else if (!hurt && injuredKnown.has(ik)) injuredKnown.delete(ik);
        }
        await persistAccount(c.owner);   // durable: the owner's freshly-pushed notifications
      }
    };
    const w = (await store.loadWorld(id))!;
    if (w.day < seasonLength(w)) { await tickDay(w); const rs = await churnMarket(); await notifyOwners(); return { broadcastDay: liveDay, done: false, rivalSignings: rs }; }
    // capture the finishing season's MVP (top fragger) before the world rolls over —
    // the season's resolved timelines are still current here; tie it into the legacy feed.
    const mvpAcc = new Map<string, PlayerStat>();
    for (const f of await store.fixtures(id, w.season)) { if (fixtureStatus(f, clock()) !== 'resolved') continue; const tl = timelines.get(key(f)); if (tl) tallyTimeline(tl, mvpAcc); }
    const mvp = [...mvpAcc.values()].sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths))[0];
    // the YOUNG GUN: the best U22 in the watched division — the development model's
    // poster child (handles are globally unique, so the roster lookup is exact)
    const ageOf = (handle: string) => { for (const c of w.clubs) { const pp = c.roster.find(x => x.handle === handle); if (pp) return pp.age; } return 99; };
    const yg = [...mvpAcc.values()].filter(r2 => ageOf(r2.handle) <= 21)
      .sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths))[0];
    // World Cup: crown the finishing season's champion NATION + its elected MANAGER (the
    // trophy is theirs) from the pre-rollover world, and record it into the legacy.
    const wcv = ensureWorldCup(w);
    const wcChampCode = wcv.bracket.champion.code;
    const wcMgrAccount = electedManager(wcChampCode);
    const wcMgrTag = wcMgrAccount ? clubTagOf(w, wcMgrAccount) : null;
    worldCupHistory.push({ season: w.season, code: wcChampCode, country: wcv.bracket.champion.country, flag: wcv.bracket.champion.flag, managerTag: wcMgrTag, managerAccount: wcMgrAccount });
    // domestic cup: crown the finishing season's winners from the durable WorldState.cup
    const cupChampIdx = w.cup?.champion ?? null;
    const cupChampClub = cupChampIdx != null ? w.clubs[cupChampIdx] : null;
    if (cupChampClub) cupHistory.push({ season: w.season, tag: cupChampClub.tag, name: cupChampClub.name, tier: cupChampClub.tier });
    // season's match-days exhausted → roll it over, then open the new season's day 0
    const roll = await runTick(store, id, { navOf });   // rollover — the Premier playoffs are ENGINE-SIMMED (watchable)
    if (roll.bracket) {
      const tag = (i: number) => w.clubs[i]?.tag ?? '?';
      const view: PlayoffView = {
        season: roll.season, qualified: roll.bracket.qualified.map(tag), champion: tag(roll.bracket.champion ?? roll.bracket.qualified[0]),
        rounds: roll.bracket.rounds.map(rd => rd.map(sr => ({
          label: sr.label, need: sr.need, hi: tag(sr.hi), lo: tag(sr.lo), wins: sr.wins, winner: tag(sr.winner ?? sr.hi),
          veto: sr.veto.map(v => ({ team: v.team === 'hi' ? tag(sr.hi) : tag(sr.lo), action: v.action, map: v.map })),
          games: sr.games.map(g => ({ seed: g.seed, map: (roll.playoffSnapshots?.get(g.seed)?.map ?? 'ascent') as string, score: g.score, winner: tag(g.winner) })),
        }))),
      };
      playoffHistory.unshift(view);
      if (playoffHistory.length > 10) playoffHistory.length = 10;
      for (const [seed, input] of roll.playoffSnapshots ?? []) playoffSnaps.set(`${roll.season}:${seed}`, input);
      // prune snapshots for brackets that fell out of the bounded history, then persist
      const kept = new Set(playoffHistory.map(v => v.season));
      for (const k of playoffSnaps.keys()) if (!kept.has(+k.split(':')[0])) playoffSnaps.delete(k);
      await persistSocial();
      // notify the four qualified owners — their climax is up (seed + how it ended)
      for (const q of roll.bracket.qualified) {
        const qc = w.clubs[q];
        if (!qc?.owner) continue;
        const fin = view.champion === qc.tag ? 'CHAMPIONS 🏆' : view.rounds[1][0].hi === qc.tag || view.rounds[1][0].lo === qc.tag ? 'runners-up' : 'out in the semis';
        notify(qc.owner, 'season', `🏆 Playoffs: ${qc.tag} qualified seed ${roll.bracket.qualified.indexOf(q) + 1} — ${fin} (watch the bracket in 🏆 Playoffs)`, roll.season, liveDay);
        await persistAccount(qc.owner);
      }
      pushNews('champion', `🏆 Playoffs: ${view.rounds.at(-1)![0].hi} vs ${view.rounds.at(-1)![0].lo} — ${view.champion} take the title`, roll.season, liveDay);
    }
    // CONTRACTS tick down at the rollover (owner-scoped): a deal that hits 0 unrenewed WALKS
    // FREE — the player leaves, the club backfills from free agency to stay valid. AI clubs
    // float at the market wage (untouched), so a world with no owners is unaffected.
    {
      const nw = (await store.loadWorld(id))!;
      const allHandles = new Set(nw.clubs.flatMap(c => c.roster.map(p => p.handle)));
      for (const h of nw.retired ?? []) allHandles.add(h);   // retired handles are closed careers
      let changed = false;
      const clubs = nw.clubs.map(c => {
        if (!c.owner) return c;
        const faSeed = (nw.seed ^ (nw.season * 0x9e3779b1) ^ (c.tier * 131 + 7)) >>> 0;
        const r = processContracts(c.roster, nw.patch, faSeed, allHandles);
        if (!r.departed.length) return c;
        changed = true;
        r.signed.forEach(p => allHandles.add(p.handle));
        for (const d of r.departed) notify(c.owner!, 'system', `📄 ${d.handle} left on a free — his contract expired unrenewed`, nw.season, 0);
        for (const s of r.signed) notify(c.owner!, 'system', `✍ ${s.handle} signed to fill the gap (free agent, ${CONTRACT_YEARS}y deal)`, nw.season, 0);
        return { ...c, roster: r.roster };
      });
      if (changed) await store.saveWorld(id, { ...nw, clubs });
    }
    if (roll.champion) { honors.push({ season: roll.season, champion: roll.champion }); pushNews('champion', `${roll.champion} are crowned Season ${roll.season} champions 🏆`, roll.season, liveDay, roll.champion); await persistSocial(); }
    // retirements: the age-curve loop closing in public — legends get a send-off,
    // owners get told who left and who was called up, the career ledger closes
    for (const rt of roll.retirements ?? []) {
      const career = careerStats[rt.handle];
      if (career) careerStats[rt.handle] = { ...career, retired: true } as typeof career & { retired: boolean };
      if (career && (career.kills >= 300 || career.mvp >= 5)) pushNews('award', `🎙 ${rt.handle} (${rt.club}, ${rt.age}) retires — ${career.kills} career kills over ${career.seasons} season(s). A legend hangs it up.`, roll.season, liveDay, rt.club);
      // induction fires the moment a qualifying career completes — front-page news,
      // and the last club's owner gets the moment too
      const done = careerStats[rt.handle];
      if (done && isLegend(done)) {
        pushNews('champion', `🏛 ${rt.handle} is INDUCTED into the Hall of Fame — ${done.kills.toLocaleString()} career kills, ${seasonAwards.filter(a => a.mvp?.handle === rt.handle).length}× MVP. Enshrined forever.`, roll.season, liveDay, rt.club);
        const oc = w.clubs.find(c => c.tag === rt.club);
        if (oc?.owner) notify(oc.owner, 'award', `🏛 ${rt.handle} — YOUR retired star — has been inducted into the Hall of Fame`, roll.season, liveDay);
      }
    }
    {
      const ownedRet = (roll.retirements ?? []).filter(rt => rt.owned);
      for (const rt of ownedRet) {
        const oc = w.clubs.find(c => c.tag === rt.club);
        if (oc?.owner) notify(oc.owner, 'system', `🎙 ${rt.handle} (${rt.age}) has retired${rt.replacement ? ` — ${rt.replacement} signed from free agency to cover` : ''}`, roll.season, liveDay);
      }
    }
    if (mvp) pushNews('award', `Season ${roll.season} MVP: ${mvp.handle} (${mvp.club}) — ${mvp.kills} kills, ${mvp.mvp} POTMs`, roll.season, liveDay, mvp.club);
    if (yg && yg.handle !== mvp?.handle) pushNews('award', `Season ${roll.season} Young Gun: ${yg.handle} (${yg.club}), ${ageOf(yg.handle)} — ${yg.kills} kills. A star is forming.`, roll.season, liveDay, yg.club);
    seasonAwards.push({ season: roll.season,
      mvp: mvp ? { handle: mvp.handle, club: mvp.club, kills: mvp.kills } : null,
      youngGun: yg ? { handle: yg.handle, club: yg.club, kills: yg.kills, age: ageOf(yg.handle) } : null });
    for (const r2 of mvpAcc.values()) {
      const c2 = careerStats[r2.handle] ?? { handle: r2.handle, club: r2.club, role: r2.role, kills: 0, deaths: 0, matches: 0, fb: 0, mvp: 0, hs: 0, clutch: 0, seasons: 0 };
      careerStats[r2.handle] = { ...c2, club: r2.club, role: r2.role, kills: c2.kills + r2.kills, deaths: c2.deaths + r2.deaths, matches: c2.matches + r2.matches, fb: c2.fb + r2.fb, mvp: c2.mvp + r2.mvp, hs: c2.hs + r2.hs, clutch: c2.clutch + r2.clutch, seasons: c2.seasons + 1 };
    }
    await persistSocial();
    // stamp the winners' ACCOLADES onto their Player objects (post-rollover world —
    // an MVP season is proof the market prices: playerValue carries the premium)
    {
      const nw2 = (await store.loadWorld(id))!;
      const stamp = (handle: string, tag: string) => (cl: WorldClub): WorldClub =>
        ({ ...cl, roster: cl.roster.map(pp => pp.handle === handle ? { ...pp, accolades: [...(pp.accolades ?? []), tag] } : pp) });
      let clubs2 = nw2.clubs;
      if (mvp) clubs2 = clubs2.map(stamp(mvp.handle, `MVP S${roll.season}`));
      if (yg) clubs2 = clubs2.map(stamp(yg.handle, `YG S${roll.season}`));
      if (mvp || yg) await store.saveWorld(id, { ...nw2, clubs: clubs2 });
    }
    pushNews('champion', `🌍 ${wcv.bracket.champion.flag} ${wcv.bracket.champion.country} win the Season ${roll.season} World Cup${wcMgrTag ? ` — managed by ${wcMgrTag}` : ''}`, roll.season, liveDay);
    if (cupChampClub) {
      pushNews('champion', `🏆 ${cupChampClub.tag} lift the Season ${roll.season} ACE Cup`, roll.season, liveDay, cupChampClub.tag);
      if (cupChampClub.owner) { notify(cupChampClub.owner, 'award', `🏆 ${cupChampClub.tag} won the Season ${roll.season} ACE Cup!`, roll.season, liveDay); await persistAccount(cupChampClub.owner); }
    }
    if (wcMgrAccount) { notify(wcMgrAccount, 'award', `🏆🌍 You led ${wcv.bracket.champion.country} to the Season ${roll.season} World Cup title!`, roll.season, liveDay); await persistAccount(wcMgrAccount); }
    pushNews('season', `Season ${roll.season + 1} begins`, roll.season + 1, 0);
    // season-end notifications per owner: final placement (from the finished season, using
    // the pre-rollover world `w` for the right tier), the title, and your-player-is-MVP.
    {
      const rows = await store.fixtures(id, roll.season);
      const postWorld = (await store.loadWorld(id))!;   // season+1: tiers reflect promotion/relegation
      for (const c of ownedClubs(w)) {
        if (!c.owner) continue;
        const table = standingsView(w, rows, c.tier, c.group, clock());
        const pos = table.findIndex(t => t.club === c.tag) + 1;
        if (pos) notify(c.owner, 'season', `Season ${roll.season}: ${c.tag} finished ${ord(pos)} in ${tierName(c.tier)}`, roll.season, liveDay);
        if (roll.champion === c.tag) notify(c.owner, 'award', `🏆 ${c.tag} are Season ${roll.season} champions!`, roll.season, liveDay);
        if (mvp && c.roster.some(p => p.handle === mvp.handle)) notify(c.owner, 'award', `★ Your player ${mvp.handle} won Season ${roll.season} MVP (${mvp.kills} kills)`, roll.season, liveDay);
        if (yg && yg.handle !== mvp?.handle && c.roster.some(p => p.handle === yg.handle)) notify(c.owner, 'award', `★ Your player ${yg.handle} is the Season ${roll.season} Young Gun — the development is paying off`, roll.season, liveDay);
        // career log: one record for the season just finished (the Trophy Room aggregates these).
        const post = postWorld.clubs.find(x => x.id === c.id);
        const promoted = !!post && post.tier < c.tier, relegated = !!post && post.tier > c.tier;
        const entry: CareerEntry = {
          season: roll.season, tier: c.tier, divName: tierName(c.tier), finish: pos || 0,
          champion: roll.champion === c.tag, promoted, relegated,
          cupWon: cupChampClub?.id === c.id, intlWon: !!post && (post.intlTitles ?? 0) > (c.intlTitles ?? 0),
          briefMet: !!post?.boardOutcome?.met,
        };
        const log = careers.get(c.owner) ?? [];
        if (!log.some(e => e.season === entry.season)) careers.set(c.owner, [...log, entry]);   // idempotent per season
        if (promoted) notify(c.owner, 'season', `▲ ${c.tag} PROMOTED to ${tierName(post!.tier)}!`, roll.season, liveDay);
        else if (relegated) notify(c.owner, 'season', `▼ ${c.tag} relegated to ${tierName(post!.tier)}`, roll.season, liveDay);
        await persistAccount(c.owner);
      }
    }
    await tickAcademies(roll.season + 1);   // develop prospects + deliver the new class
    emit('season', { season: roll.season + 1, champion: roll.champion ?? null });
    await tickDay((await store.loadWorld(id))!);
    await notifyOwners();   // the new season's day-0 fixture going live
    return { broadcastDay: liveDay, done: false, rollover: true, season: roll.season + 1, champion: roll.champion };
  };
  const fixtureAt = async (season: number, day: number, slot: number): Promise<FixtureRow | undefined> =>
    (await store.fixtures(id, season)).find(f => f.day === day && f.slot === slot);
  // a static tag/name lookup (club identities don't change tag) — for labelling the
  // live feed + fixture views with who's actually playing (not a spoiler)
  const meta = (await store.loadWorld(id))!;
  const labelOf = (i: number) => ({ tag: meta.clubs[i]?.tag ?? '?', name: meta.clubs[i]?.name ?? '?' });

  // ── abuse hardening: an in-memory token-bucket limiter per (ip, class) ──────
  // 'auth' is tight (scrypt is compute-heavy — a login flood is a CPU DoS),
  // 'chat' stops spam, 'write' is generous (a real manager never hits it) and
  // reads are unlimited (cached + cheap). Behind a proxy, set trust for
  // X-Forwarded-For at the proxy layer; here the socket address is the identity.
  const RATES: Record<string, { capacity: number; perSec: number }> = {
    auth: { capacity: 10, perSec: 10 / 60 },      // 10 burst, ~10/min sustained
    chat: { capacity: 8, perSec: 0.75 },          // 8 burst, ~45/min
    write: { capacity: 60, perSec: 2 },           // 60 burst, ~120/min
  };
  // OAuth flow state: CSRF `state` values (10 min TTL, carry the web redirect) and
  // ONE-TIME login codes the callback mints (60s TTL — the browser lands back on
  // the web app with ?oauthCode=..., which it swaps for the session over POST so
  // tokens never ride a URL).
  const oauthStates = new Map<string, { redirect: string; at: number }>();
  const oauthCodes = new Map<string, { session: import('./accounts.js').Session; at: number }>();
  const oauthProviders = opts.oauth ?? [];
  const providerOf = (pid: string) => oauthProviders.find(x => x.id === pid);
  const buckets = new Map<string, { tokens: number; at: number }>();
  const allow = (ip: string, cls: keyof typeof RATES): boolean => {
    const r = RATES[cls], k = `${ip}|${cls}`, t = clock();
    const b = buckets.get(k) ?? { tokens: r.capacity, at: t };
    b.tokens = Math.min(r.capacity, b.tokens + (t - b.at) * r.perSec); b.at = t;
    if (b.tokens < 1) { buckets.set(k, b); return false; }
    b.tokens -= 1; buckets.set(k, b);
    return true;
  };
  const bucketSweep = setInterval(() => { const t = clock(); for (const [k, b] of buckets) if (t - b.at > 600) buckets.delete(k); }, 120_000);

  let selfBase = '';   // the server's own URL (set at listen; publicBase overrides in deployments)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const now = clock();
    // CORS preflight: a cross-origin POST/PATCH with a JSON body or Authorization
    // header triggers an OPTIONS preflight — answer it so the browser allows the call.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', 'access-control-max-age': '600' });
      return res.end();
    }
    const path = (req.url ?? '/').split('?')[0].split('/').filter(Boolean);
    // the account making the request: a verified Bearer access token (the
    // `x-account` header is a dev fallback for unauthenticated local pokes).
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const account = (bearer && auth.verify(bearer)) || (req.headers['x-account'] as string | undefined) || null;

    // rate limits: auth endpoints (scrypt), chat sends, and all other writes
    {
      const ip = req.socket.remoteAddress ?? '?';
      // the tight 'auth' bucket prices the scrypt POSTs; the OAuth GET redirect
      // legs are cheap bounces and ride free (their state map is size-guarded)
      const cls = path[0] === 'auth' && req.method === 'POST' ? 'auth'
        : path[0] === 'chat' && path[1] === 'send' ? 'chat'
        : (req.method === 'POST' || req.method === 'PATCH') && path[0] !== 'billing' ? 'write'
        : null;   // reads + the Stripe webhook (signature-gated) are unthrottled
      if (cls && !allow(ip, cls)) return json(res, 429, { error: 'slow down — too many requests; try again shortly' });
    }

    if (path[0] === 'health') return json(res, 200, { ok: true, id, now, broadcastDay: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs });

    // GET /events[?token=][&since=N]  → the WORLD EVENT STREAM (SSE) — the one
    // channel a client hangs on for live sync. `hello` carries the current live
    // cursor + latest seq so a fresh client aligns immediately; a reconnect
    // presents Last-Event-ID (EventSource does this natively) or ?since= and the
    // missed tail replays from the backlog; a gap the backlog can't cover gets
    // `resync` — the client refetches everything. Behind, never silently stale.
    if (path[0] === 'events' && path.length === 1) {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const acct = (q.get('token') ? auth.verify(q.get('token')!) : null) || account;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      const w = (await store.loadWorld(id))!;
      res.write(`event: hello\ndata: ${JSON.stringify({ seq: evSeq, season: w.season, day: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs })}\n\n`);
      const since = Number(req.headers['last-event-id'] ?? q.get('since') ?? NaN);
      if (!Number.isNaN(since) && since < evSeq) {
        const oldest = evBacklog[0]?.seq ?? evSeq + 1;
        if (since < oldest - 1) res.write('event: resync\ndata: {}\n\n');   // gap — full refetch
        else for (const e of evBacklog) if (e.seq > since && (!e.account || e.account === acct)) res.write(`id: ${e.seq}\nevent: ${e.ev}\ndata: ${e.data}\n\n`);
      }
      const client: EvClient = { res, account: acct || null };
      evClients.add(client);
      req.on('close', () => evClients.delete(client));
      return;
    }

    // ── social sign-in (OAuth2 code flow — Google/Discord/injected mocks) ─────
    // GET /auth/providers → which buttons to render
    if (path[0] === 'auth' && path[1] === 'providers' && req.method === 'GET') {
      return json(res, 200, { providers: oauthProviders.map(x => ({ id: x.id, label: x.label })) });
    }
    // GET /auth/oauth/:provider?redirect=<web app URL> → 302 to the provider
    if (path[0] === 'auth' && path[1] === 'oauth' && path.length === 3 && req.method === 'GET') {
      const p2 = providerOf(path[2]);
      if (!p2) return json(res, 404, { error: 'unknown provider' });
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      for (const [k, v] of oauthStates) if (clock() - v.at > 600) oauthStates.delete(k);   // 10 min TTL sweep
      if (oauthStates.size > 10000) return json(res, 429, { error: 'too many pending sign-ins — try again shortly' });   // an unthrottled GET can't bloat the map
      const state = newRefreshToken();
      oauthStates.set(state, { redirect: q.get('redirect') ?? '/', at: clock() });
      const cb = `${opts.publicBase ?? selfBase}/auth/oauth/${p2.id}/callback`;
      res.writeHead(302, { location: authorizeUrl(p2, cb, state) });
      return res.end();
    }
    // GET /auth/oauth/:provider/callback?code&state → exchange, identify, mint a
    // ONE-TIME code and bounce back to the web app (tokens never ride a URL)
    if (path[0] === 'auth' && path[1] === 'oauth' && path.length === 4 && path[3] === 'callback' && req.method === 'GET') {
      const p2 = providerOf(path[2]);
      if (!p2) return json(res, 404, { error: 'unknown provider' });
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const st = oauthStates.get(q.get('state') ?? '');
      if (!st || clock() - st.at > 600) return json(res, 400, { error: 'invalid or expired oauth state' });
      oauthStates.delete(q.get('state')!);
      const cb = `${opts.publicBase ?? selfBase}/auth/oauth/${p2.id}/callback`;
      const tok = await exchangeCode(p2, q.get('code') ?? '', cb);
      const ident = tok && await fetchIdentity(p2, tok);
      if (!ident) return json(res, 401, { error: 'the provider rejected the sign-in' });
      const session = await auth.oauthLogin(p2.id, ident.subject, ident.email);
      const code = newRefreshToken();
      oauthCodes.set(code, { session, at: clock() });
      for (const [k, v] of oauthCodes) if (clock() - v.at > 60) oauthCodes.delete(k);   // 60s TTL sweep
      const back = new URL(st.redirect, opts.publicBase ?? selfBase);
      back.searchParams.set('oauthCode', code);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    // POST /auth/oauth/complete { code } → swap the one-time code for the session
    if (path[0] === 'auth' && path[1] === 'oauth' && path[2] === 'complete' && req.method === 'POST') {
      const b = (await readBody(req)) as { code?: string };
      const row = oauthCodes.get(b.code ?? '');
      if (!row || clock() - row.at > 60) return json(res, 401, { error: 'invalid or expired sign-in code' });
      oauthCodes.delete(b.code!);
      return json(res, 200, row.session);
    }

    // ── self-owned auth (§5/§9): register / login / refresh / verify ──────────
    if (path[0] === 'auth' && req.method === 'POST') {
      const b = (await readBody(req)) as { email?: string; password?: string; refreshToken?: string; token?: string };
      try {
        if (path[1] === 'register') {
          const reg = await auth.register(b.email ?? '', b.password ?? '');
          // a configured mailer carries the verification token (never the response —
          // the dev flow without one surfaces it inline, same contract as /forgot)
          if (opts.mailer) {
            await opts.mailer(b.email ?? '', 'Verify your ACE account', `Your verification token: ${reg.verifyToken}`);
            const { verifyToken: _vt, ...rest } = reg;
            return json(res, 201, { ...rest, sent: true });
          }
          return json(res, 201, reg);
        }
        if (path[1] === 'login') return json(res, 200, await auth.login(b.email ?? '', b.password ?? ''));
        if (path[1] === 'refresh') return json(res, 200, await auth.refresh(b.refreshToken ?? ''));
        if (path[1] === 'verify') {
          const acct = await auth.verifyEmail(b.token ?? '');
          return acct ? json(res, 200, { verified: true, accountId: acct }) : json(res, 400, { error: 'invalid or expired verification token' });
        }
        // account recovery: ALWAYS 200 (no account enumeration); the token is
        // mailed when a mailer is configured, surfaced inline in dev
        if (path[1] === 'forgot') {
          const tok = await auth.forgot((b as { email?: string }).email ?? '');
          if (tok && opts.mailer) { await opts.mailer((b as { email: string }).email, 'Reset your ACE password', `Your reset token (15 min): ${tok}`); return json(res, 200, { sent: true }); }
          return json(res, 200, tok ? { sent: true, devResetToken: tok } : { sent: true });
        }
        if (path[1] === 'reset') {
          const ok2 = await auth.reset((b as { token?: string }).token ?? '', (b as { password?: string }).password ?? '');
          return ok2 ? json(res, 200, { reset: true }) : json(res, 400, { error: 'invalid or expired reset token' });
        }
      } catch (e) { return json(res, 401, { error: (e as Error).message }); }
      return json(res, 404, { error: 'unknown auth route' });
    }

    // ── Stripe VIP billing (PHASE2 §12 — the webhook is the source of truth) ──
    // POST /billing/checkout → start a VIP subscription. With a Stripe secret
    // configured this returns the hosted-checkout stub (the NestJS build creates
    // the real session via the SDK); in dev it activates VIP directly so the
    // full loop works without Stripe. Never pay-to-win: VIP gates convenience.
    if (path[0] === 'billing' && path[1] === 'checkout' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      if (opts.stripeWebhookSecret) {
        return json(res, 200, { url: `https://checkout.stripe.com/c/pay/ace-vip#${account}`, note: 'complete checkout with Stripe — the webhook flips VIP' });
      }
      const until = Math.floor(clock()) + VIP_DAYS * 86400;
      await accounts.setVip(account, until);
      return json(res, 200, { dev: true, vip: true, vipUntil: until });
    }
    // POST /billing/webhook → Stripe events, verified with Stripe's exact
    // `stripe-signature` scheme over the RAW body. 400 on a bad signature;
    // events that don't change VIP are acknowledged and ignored.
    if (path[0] === 'billing' && path[1] === 'webhook' && req.method === 'POST') {
      const secret = opts.stripeWebhookSecret;
      if (!secret) return json(res, 501, { error: 'no webhook secret configured' });
      const raw = await readRaw(req);
      if (!verifyStripeSig(req.headers['stripe-signature'] as string | undefined, raw, secret, Math.floor(clock()))) {
        return json(res, 400, { error: 'invalid signature' });
      }
      let evt: { type?: string; data?: { object?: Record<string, unknown> } };
      try { evt = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid payload' }); }
      const change = vipFromEvent(evt, Math.floor(clock()));
      if (change) await accounts.setVip(change.accountId, change.vipUntil);
      return json(res, 200, { received: true, applied: !!change });
    }

    // GET /fixtures/:season/:day/:slot  → spoiler-safe public view (+ who's playing)
    if (path[0] === 'fixtures' && path.length === 4) {
      const f = await fixtureAt(+path[1], +path[2], +path[3]);
      if (!f) return json(res, 404, { error: 'no such fixture' });
      return json(res, 200, { ...publicView(f, now), home: labelOf(f.home), away: labelOf(f.away), map: f.inputSnapshot?.map ?? null });
    }
    // GET /fixtures/:season/:day/:slot/replay  → snapshot, but only once resolved
    if (path[0] === 'fixtures' && path.length === 5 && path[4] === 'replay') {
      const f = await fixtureAt(+path[1], +path[2], +path[3]);
      if (!f) return json(res, 404, { error: 'no such fixture' });
      if (fixtureStatus(f, now) !== 'resolved') return json(res, 425, { error: 'too early — match still live', status: fixtureStatus(f, now) });
      return json(res, 200, { seed: f.seed, snapshot: f.inputSnapshot ?? null, score: [f.homeScore, f.awayScore] });
    }
    // GET /fixtures/:season/:day/:slot/live  → the timeline GATED to the live broadcast
    // position: COMPLETED rounds only (never the round being decided, never the final), so
    // a client can watch the match unfold round-by-round but cannot see ahead. This is the
    // live-watch source — the snapshot/replay path stays sealed (425) until reveal precisely
    // because handing over the snapshot would let a client re-sim the ENTIRE match early.
    // On resolve it ships the full timeline + final (the embargo is over). The server derives
    // the position from its OWN clock, so the gate can't be bypassed by the caller.
    if (path[0] === 'fixtures' && path.length === 5 && path[4] === 'live') {
      const f = await fixtureAt(+path[1], +path[2], +path[3]);
      if (!f) return json(res, 404, { error: 'no such fixture' });
      const tl = timelines.get(key(f));
      if (!tl) return json(res, 404, { error: 'not a watched fixture' });
      const st = fixtureStatus(f, now), resolved = st === 'resolved';
      const frac = liveFrac(f, now);
      // liveMatchState.round is the index of the round currently being decided → exactly the
      // count of COMPLETED rounds. Resolved → the whole match (and the real final).
      const completed = resolved ? tl.rounds.length : (st === 'scheduled' ? 0 : liveMatchState(tl, frac).round);
      const timeline = completed === 0 ? null
        : resolved ? tl
        : { ...tl, rounds: tl.rounds.slice(0, completed), finalScore: [0, 0] as [number, number] };
      return json(res, 200, { status: st, frac: +frac.toFixed(3), completed, total: tl.rounds.length, resolved, timeline });
    }
    // GET /live/:season/:day  → SSE: the synced live match-center for that day
    if (path[0] === 'live' && path.length === 3) {
      const season = +path[1], day = +path[2];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      // SHARED frame hub per (season, day): the frame is computed + stringified
      // ONCE a second no matter how many clients watch — fan-out is a string
      // write per socket (the scale property; per-connection compute would be
      // O(clients × fixtures) JSON work every second).
      const hubKey = `${season}:${day}`;
      let hub = liveHubs.get(hubKey);
      if (!hub) {
        const watched = (await store.fixtures(id, season)).filter(f => f.day === day && timelines.has(key(f)));
        const again = liveHubs.get(hubKey);   // an await ran — another request may have built it
        if (again) hub = again;
        else {
          const h: LiveHub = { clients: new Set(), timer: null };
          const frame = () => {
            const t = clock();
            const fixtures = watched.map(f => {
              const v = publicView(f, t), m = liveMatchState(timelines.get(key(f))!, v.frac);
              return { slot: f.slot, status: v.status, frac: +v.frac.toFixed(3), running: [m.scoreA, m.scoreB], round: m.round + 1, rounds: timelines.get(key(f))!.rounds.length, final: v.score ?? null, home: labelOf(f.home), away: labelOf(f.away), map: f.inputSnapshot?.map ?? null };
            });
            const payload = `data: ${JSON.stringify({ now: t, fixtures })}\n\n`;
            for (const c of h.clients) { try { c.write(payload); } catch { h.clients.delete(c); } }
            if (fixtures.every(f => f.status === 'resolved')) {
              for (const c of h.clients) { try { c.write('event: done\ndata: {}\n\n'); c.end(); } catch { /* gone */ } }
              if (h.timer) clearInterval(h.timer);
              liveHubs.delete(hubKey);
            }
          };
          h.timer = setInterval(frame, 1000);
          h.frame = frame;
          liveHubs.set(hubKey, h);
          hub = h;
        }
      }
      hub.clients.add(res);
      hub.frame?.();   // immediate first frame for the newcomer (shared with everyone — idempotent data)
      req.on('close', () => {
        hub!.clients.delete(res);
        if (hub!.clients.size === 0) { if (hub!.timer) clearInterval(hub!.timer); liveHubs.delete(hubKey); }
      });
      return;
    }
    // GET /clubs/:slug  → public club PROFILE: identity + the fielded five + how the club
    // RANKS (world power rank, division, infra) + its legacy (titles, intl, World Cup
    // manager honors). The showcase a rival scouts you by. Read-only, no embargo.
    if (path[0] === 'clubs' && path.length === 2 && (req.method ?? 'GET') === 'GET') {
      const w = (await store.loadWorld(id))!;
      const c = w.clubs.find(x => x.tag.toLowerCase() === path[1].toLowerCase());
      if (!c) return json(res, 404, { error: 'no such club' });
      const ranked = topClubs(w, w.clubs.length);   // every club, by squad power
      const row = ranked.find(r => r.tag === c.tag);
      // CURRENT form (the "how good right now" read, distinct from squad power) — recent
      // results + season record + division standing, all from RESOLVED fixtures only.
      const ci = w.clubs.indexOf(c);
      const rows = await store.fixtures(id, w.season);
      const played = rows.filter(f => (f.home === ci || f.away === ci) && fixtureStatus(f, clock()) === 'resolved').sort((a, b) => a.day - b.day);
      const scoreOf = (f: typeof played[number]) => (f.home === ci ? [f.homeScore, f.awayScore] : [f.awayScore, f.homeScore]) as [number, number];
      const form = played.slice(-6).map(f => { const [us, them] = scoreOf(f); return { r: us > them ? 'W' : 'L', us, them, opp: labelOf(f.home === ci ? f.away : f.home).tag, day: f.day + 1 }; });
      const wins = played.filter(f => { const [us, them] = scoreOf(f); return us > them; }).length;
      const table = standingsView(w, rows, c.tier, c.group, clock());
      const standing = table.findIndex(t => t.club === c.tag) + 1;
      // VS YOU: if a signed-in owner scouts another club, how they stack up — the power
      // gap + this season's head-to-head series (resolved games only).
      let vsYou: { tag: string; power: number; w: number; l: number; played: number } | undefined;
      const mine = account ? w.clubs.find(x => x.owner === account) : undefined;
      if (mine && mine.id !== c.id) {
        const myi = w.clubs.indexOf(mine);
        const h2h = rows.filter(f => fixtureStatus(f, clock()) === 'resolved' && ((f.home === myi && f.away === ci) || (f.home === ci && f.away === myi)));
        let hw = 0, hl = 0;
        for (const f of h2h) { const meHome = f.home === myi, us = meHome ? f.homeScore : f.awayScore, them = meHome ? f.awayScore : f.homeScore; if (us > them) hw++; else hl++; }
        vsYou = { tag: mine.tag, power: ranked.find(r => r.tag === mine.tag)?.power ?? Math.round(mine.strength * 100), w: hw, l: hl, played: h2h.length };
      }
      return json(res, 200, {
        ...publicClub(w, c),
        // FRANCHISE legends — retired careers that finished wearing this tag (the
        // club-level bar sits below world induction: 300+ career kills means
        // something here; ⚑ marks the world-inducted)
        clubLegends: Object.values(careerStats)
          .filter(c2 => (c2 as { retired?: boolean }).retired && c2.club === c.tag && c2.kills >= 300)
          .sort((a, b) => b.kills - a.kills).slice(0, 3)
          .map(c2 => ({ handle: c2.handle, kills: c2.kills, seasons: c2.seasons, inducted: isLegend(c2) })),
        division: tierName(c.tier),
        power: row?.power ?? Math.round(c.strength * 100),
        powerRank: row?.rank ?? null, totalClubs: w.clubs.length,
        infra: row?.infra ?? 0,
        wcTitles: worldCupHistory.filter(t => t.managerTag === c.tag).length,
        cupTitles: cupHistory.filter(t => t.tag === c.tag).length,
        form, record: { w: wins, l: played.length - wins }, standing: standing || null, divSize: table.length,
        vsYou,
        // the owner's VIP badge (cosmetic — a supporter flag on the public page)
        vip: c.owner ? await isVip(c.owner) : false,
        // scouting read on a HUMAN rival: WHICH maps they've authored plays on
        // (coverage only, never the plays themselves — expect set pieces there)
        playbookMaps: c.owner ? Object.keys(c.plays ?? {}) : [],
      });
    }
    // GET /standings/:season/:tier/:group  → embargo-aware table (resolved only)
    if (path[0] === 'standings' && path.length === 4) {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, { tier: +path[2], group: +path[3], table: standingsView(w, await store.fixtures(id, +path[1]), +path[2], +path[3], now) });
    }
    // GET /market  → the free-agent board (value + contested flag, current world).
    // If a Bearer account is present, each entry's ceiling band reflects THAT owner's
    // commissioned scouting reports (private knowledge — the consensus value is fogged).
    if (path[0] === 'market' && path.length === 1 && (req.method ?? 'GET') === 'GET') {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, { board: (await getBoard()).filter(p => !sold.has(p.handle)).map(p => marketEntry(w, p, scoutLevelOf(account, p.handle))) });
    }
    // POST /market/scout  → commission a scouting report on a board free agent (the
    // paid investment, DESIGN §4.1/§5.3). Charges your club, raises your private
    // confidence one level, and returns the tightened ceiling band — so you can bid
    // on the gem the consensus is mispricing. Capped at SCOUT_MAX.
    if (path[0] === 'market' && path[1] === 'scout' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { handle?: string };
      const player = (await getBoard()).find(p => p.handle === b.handle && !sold.has(p.handle));
      if (!player) return json(res, 404, { error: 'not on the board' });
      const level = scoutLevelOf(account, player.handle);
      if (level >= SCOUT_MAX) return json(res, 200, { ok: false, reason: 'fully scouted', level, ceiling: scoutedRange(player, false, level) });
      // VIP perk (faster scouting — DESIGN §8.4): reports at half price. Pure
      // convenience: the information itself is identical for everyone.
      const cost = Math.round(scoutCost(level) * ((await isVip(account)) ? 0.5 : 1));
      if (cost > mine.balance) return json(res, 200, { ok: false, reason: 'insufficient funds', cost, level, ceiling: scoutedRange(player, false, level) });
      await store.saveWorld(id, chargeScout((await store.loadWorld(id))!, mine.id, cost));
      const reports = scoutReports.get(account) ?? new Map<string, number>();
      reports.set(player.handle, level + 1);
      scoutReports.set(account, reports);
      await persistAccount(account);
      const after = (await store.loadWorld(id))!;
      return json(res, 200, { ok: true, level: level + 1, cost, ceiling: scoutedRange(player, false, level + 1), nextCost: level + 1 < SCOUT_MAX ? scoutCost(level + 1) : null, balance: after.clubs.find(c => c.id === mine.id)!.balance });
    }
    // POST /market/bid  → bid on a free agent (the war); signs if you clear the field
    if (path[0] === 'market' && path[1] === 'bid' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { handle?: string; amount?: number };
      const player = (await getBoard()).find(p => p.handle === b.handle && !sold.has(p.handle));
      if (!player) return json(res, 404, { error: 'not on the board' });
      const w = (await store.loadWorld(id))!;
      const clubIdx = w.clubs.findIndex(c => c.id === mine.id);
      const result = resolveWorldBid(w, clubIdx, player, b.amount ?? 0);
      if (!result.ok) return json(res, 200, result);                 // outbid / below / broke → raise or walk
      sold.add(player.handle);
      // the signing carries a fresh contract (a wage LOCKED for the term) — the lasting cost
      const signed = applySigning(w, mine.id, player, result.paid!);
      const withDeal = { ...signed, clubs: signed.clubs.map(c => c.id === mine.id ? { ...c, roster: c.roster.map(p => p.handle === player.handle ? { ...p, contract: newContract(p, signed.patch, CONTRACT_YEARS) } : p) } : c) };
      await store.saveWorld(id, withDeal);
      emit('market', { sold: [player.handle] });   // every open board drops him live
      const after = (await store.loadWorld(id))!;
      return json(res, 200, { ...result, club: publicClub(after, after.clubs[clubIdx]) });
    }
    // POST /market/sell  → sell a rostered player to the richest willing AI club
    if (path[0] === 'market' && path[1] === 'sell' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { ref?: string };
      const w = (await store.loadWorld(id))!;
      const sale = resolveSale(w, mine.id, b.ref ?? '');
      if (!sale.ok) return json(res, 200, sale);                      // blocked / no buyer → client shows why
      await store.saveWorld(id, applySale(w, mine.id, b.ref!, sale.buyerIdx!, sale.fee!));
      emit('market', { sold: [] });   // rosters moved — market/squad views refresh
      const after = (await store.loadWorld(id))!;
      const ci = after.clubs.findIndex(c => c.id === mine.id);
      return json(res, 200, { ...sale, club: publicClub(after, after.clubs[ci]) });
    }
    // POST /challenge { tag }  → a FRIENDLY, right now: your club vs theirs (another
    // human's club, or any AI club as a practice scrim), full engine, instantly
    // watchable. Both owners are notified; nothing touches the standings.
    if (path[0] === 'challenge' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { tag?: string };
      const w = (await store.loadWorld(id))!;
      const target = w.clubs.find(c => c.tag.toLowerCase() === (b.tag ?? '').toLowerCase());
      if (!target) return json(res, 404, { error: 'no such club' });
      if (target.id === mine.id) return json(res, 400, { error: 'you cannot challenge yourself' });
      const ck = `${pairKey(mine.id, target.id)}:${w.season}:${liveDay}`;
      if (challengedToday.has(ck)) return json(res, 429, { error: 'you two already played a friendly this match-day — advance a day and rematch' });
      challengedToday.add(ck);
      const hi = w.clubs.findIndex(c => c.id === mine.id), ai = w.clubs.findIndex(c => c.id === target.id);
      const seed = (Math.floor(clock()) ^ (++friendlySeq * 0x9e3779b1)) >>> 0;
      const { input, map, score } = resolveFriendly(w, hi, ai, seed, navOf);
      const f: Friendly = { id: friendlySeq, at: clock(), season: w.season, day: liveDay, map,
        home: { tag: mine.tag, name: mine.name }, away: { tag: target.tag, name: target.name },
        score, snapshot: input, accounts: [account, target.owner ?? ''].filter(Boolean) };
      friendlies.unshift(f);
      if (friendlies.length > 200) friendlies.length = 200;
      await persistSocial();
      const won = score[0] > score[1];
      // two OWNERS clashing is world news — the whole server sees the scrap
      if (target.owner) pushNews('transfer', `⚔ Friendly: ${mine.tag} ${score[0]}–${score[1]} ${target.tag} on ${map}`, w.season, liveDay, mine.tag);
      notify(account, 'result', `⚔ Friendly: ${won ? 'WON' : 'lost'} ${score[0]}–${score[1]} vs ${target.tag} on ${map}`, w.season, liveDay);
      if (target.owner) notify(target.owner, 'result', `⚔ ${mine.tag} challenged you to a friendly — you ${score[1] > score[0] ? 'WON' : 'lost'} ${score[1]}–${score[0]} on ${map} (watch it under ⚔ friendlies)`, w.season, liveDay);
      await persistAccount(account);   // durable: the result notif survives a restart
      if (target.owner) await persistAccount(target.owner);
      return json(res, 200, { ok: true, id: f.id, map, score, home: f.home, away: f.away, human: !!target.owner });
    }
    // GET /friendlies  → your recent friendlies (either side), light rows
    // ── player LOANS (development via minutes — the CS-manager staple) ─────
    // POST /loan { id } → send a non-starter for a season of STARTER reps at a
    // lower-tier club; he can't be fielded until recalled/returned.
    if (path[0] === 'loan' && path.length === 1 && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { id?: string };
      const w = (await store.loadWorld(id))!;
      const r = loanOut(w, mine.id, b.id ?? '');
      if (!r.ok) return json(res, 200, { ok: false, reason: r.reason });
      await store.saveWorld(id, r.world!);
      return json(res, 200, { ok: true, loan: { tag: r.loan!.hostTag, tier: r.loan!.hostTier } });
    }
    // POST /loan/recall { id } → bring him home mid-season
    if (path[0] === 'loan' && path[1] === 'recall' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { id?: string };
      const w = (await store.loadWorld(id))!;
      const r = recallLoan(w, mine.id, b.id ?? '');
      if (!r.ok) return json(res, 200, { ok: false, reason: r.reason });
      await store.saveWorld(id, r.world!);
      return json(res, 200, { ok: true });
    }
    // ── human-to-human transfers (the direct PvP economy) ─────────────────
    // POST /transfer/offer { tag, handle, amount } → bid for a player on another
    // HUMAN owner's roster (AI clubs go through the normal market). The seller's
    // owner is notified and accepts/declines; nothing moves until they do.
    if (path[0] === 'transfer' && path[1] === 'offer' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { tag?: string; handle?: string; amount?: number };
      const amount = Math.round(Number(b.amount ?? 0));
      if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: 'a real offer needs a real number' });
      const w = (await store.loadWorld(id))!;
      const target = w.clubs.find(c => c.tag.toLowerCase() === (b.tag ?? '').toLowerCase());
      if (!target) return json(res, 404, { error: 'no such club' });
      if (target.id === mine.id) return json(res, 400, { error: 'that is your own club' });
      if (target.owner == null) return json(res, 400, { error: 'an AI club — sign their players through the market' });
      const player = target.roster.find(pp => pp.handle.toLowerCase() === (b.handle ?? '').toLowerCase());
      if (!player) return json(res, 404, { error: 'no such player on that roster' });
      const me = w.clubs.find(c => c.id === mine.id)!;
      if (me.balance < amount) return json(res, 400, { error: 'you cannot afford that offer' });
      // one live offer per (buyer, player): a new one replaces the old
      for (const o of transferOffers) if (o.status === 'pending' && o.from === account && o.playerId === player.id) o.status = 'withdrawn';
      const offer: TransferOffer = { id: ++transferSeq, from: account, fromTag: me.tag, to: target.owner, toTag: target.tag,
        playerId: player.id, handle: player.handle, amount, status: 'pending', season: w.season, day: liveDay, at: clock() };
      transferOffers.unshift(offer);
      if (transferOffers.length > 200) transferOffers.length = 200;   // bounded history
      await persistSocial();
      notify(target.owner, 'system', `⇄ ${me.tag} bid $${amount.toLocaleString()} for ${player.handle} — accept or decline in the transfers panel`, w.season, liveDay);
      return json(res, 200, { ok: true, offer });
    }
    // POST /transfer/respond { id, accept } → the seller's call. Accept re-validates
    // (roster, valid five, buyer funds) and commits through applySale — player moves
    // ungelled with his contract, the fee moves to the seller, the league reads it
    // in the news. Decline just closes the offer.
    if (path[0] === 'transfer' && path[1] === 'respond' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const b = (await readBody(req)) as { id?: number; accept?: boolean };
      const offer = transferOffers.find(o => o.id === +(b.id ?? -1));
      if (!offer) return json(res, 404, { error: 'no such offer' });
      if (offer.to !== account) return json(res, 403, { error: 'not your offer to answer' });
      if (offer.status !== 'pending') return json(res, 400, { error: 'that offer is closed' });
      const w = (await store.loadWorld(id))!;
      if (!b.accept) {
        offer.status = 'declined';
        await persistSocial();
        notify(offer.from, 'system', `${offer.toTag} declined your $${offer.amount.toLocaleString()} bid for ${offer.handle}`, w.season, liveDay);
        return json(res, 200, { ok: true, offer });
      }
      const seller = w.clubs.find(c => c.owner === account);
      const buyer = w.clubs.find(c => c.owner === offer.from);
      if (!seller || !buyer) { offer.status = 'withdrawn'; await persistSocial(); return json(res, 400, { error: 'a club changed hands — offer void' }); }
      const deal = resolveDirect(w, seller.id, buyer.id, offer.playerId, offer.amount);
      if (!deal.ok) return json(res, 200, { ok: false, reason: deal.reason, offer });
      await store.saveWorld(id, applySale(w, seller.id, offer.playerId, deal.buyerIdx!, offer.amount));
      offer.status = 'accepted';
      await persistSocial();
      notify(offer.from, 'system', `✓ ${seller.tag} accepted — ${offer.handle} joins you for $${offer.amount.toLocaleString()}`, w.season, liveDay);
      pushNews('transfer', `⇄ ${offer.handle} moves ${seller.tag} → ${buyer.tag} for $${offer.amount.toLocaleString()} — an owner-to-owner deal`, w.season, liveDay, buyer.tag);
      emit('market', { sold: [] });   // rosters + banks moved — squad/market views refresh
      return json(res, 200, { ok: true, offer });
    }
    // POST /transfer/withdraw { id } → the buyer pulls a pending offer
    if (path[0] === 'transfer' && path[1] === 'withdraw' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const b = (await readBody(req)) as { id?: number };
      const offer = transferOffers.find(o => o.id === +(b.id ?? -1));
      if (!offer || offer.from !== account) return json(res, 404, { error: 'no such offer' });
      if (offer.status !== 'pending') return json(res, 400, { error: 'that offer is closed' });
      offer.status = 'withdrawn';
      await persistSocial();
      return json(res, 200, { ok: true, offer });
    }
    // GET /transfers → my offer desk (incoming + outgoing, pending first)
    if (path[0] === 'transfers' && req.method === 'GET') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mineO = transferOffers.filter(o => o.from === account).slice(0, 20);
      const inc = transferOffers.filter(o => o.to === account).slice(0, 20);
      return json(res, 200, { incoming: inc, outgoing: mineO });
    }
    if (path[0] === 'friendlies' && path.length === 1) {
      if (!account) return json(res, 401, { error: 'no account' });
      const minec = await myClub(store, id, account);
      const rows = friendlies.filter(f => f.accounts.includes(account));
      // the friendly HEAD-TO-HEAD ledger: your record vs each opponent (bragging rights)
      const h2h: Record<string, { w: number; l: number }> = {};
      if (minec) for (const f of rows) {
        const meHome = f.home.tag === minec.tag;
        const opp = meHome ? f.away.tag : f.home.tag;
        const won = meHome ? f.score[0] > f.score[1] : f.score[1] > f.score[0];
        (h2h[opp] ??= { w: 0, l: 0 })[won ? 'w' : 'l']++;
      }
      return json(res, 200, { friendlies: rows.slice(0, 20).map(({ snapshot: _s, accounts: _a, ...rest }) => rest), h2h });
    }
    // GET /friendlies/:id/replay  → the stored snapshot (no embargo — already resolved)
    if (path[0] === 'friendlies' && path.length === 3 && path[2] === 'replay') {
      const f = friendlies.find(x => x.id === +path[1]);
      if (!f) return json(res, 404, { error: 'no such friendly' });
      return json(res, 200, { snapshot: f.snapshot, score: f.score, home: f.home, away: f.away, map: f.map });
    }
    // GET /presence  → the managers ONLINE right now (accounts holding a live
    // /events stream, mapped to their club tags) — the world feels inhabited.
    if (path[0] === 'presence' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const online = new Set<string>();
      for (const c of evClients) if (c.account) online.add(c.account);
      const tags = [...online].map(a => w.clubs.find(c => c.owner === a)?.tag).filter((t): t is string => !!t).sort();
      return json(res, 200, { online: online.size, tags });
    }
    // GET /playoffs  → the Premier playoff brackets (newest first), engine-simmed + watchable
    if (path[0] === 'playoffs' && path.length === 1) {
      return json(res, 200, { history: playoffHistory });
    }
    // GET /playoffs/:season/:seed/replay  → a playoff game's snapshot (re-sim to watch)
    if (path[0] === 'playoffs' && path.length === 4 && path[3] === 'replay') {
      const snap = playoffSnaps.get(`${path[1]}:${path[2]}`);
      if (!snap) return json(res, 404, { error: 'no such playoff game' });
      return json(res, 200, { snapshot: snap });
    }
    // GET /honors  → the Hall of Fame: season champions + all-time title leaders
    if (path[0] === 'honors' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const allTime = w.clubs.filter(c => c.titles > 0).map(c => ({ tag: c.tag, name: c.name, titles: c.titles })).sort((a, b) => b.titles - a.titles || a.tag.localeCompare(b.tag));
      // the INDUCTED — retirement completes a career; an exceptional one is enshrined:
      // a season-MVP winner, or a monster body of work (1000+ career kills)
      const legends = Object.values(careerStats)
        .filter(c2 => isLegend(c2))
        .sort((a, b) => b.kills - a.kills)
        .slice(0, 8)
        .map(c2 => ({ handle: c2.handle, club: c2.club, kills: c2.kills, seasons: c2.seasons, mvps: seasonAwards.filter(a => a.mvp?.handle === c2.handle).length }));
      return json(res, 200, { honors: [...honors].reverse(), allTime, awards: [...seasonAwards].reverse().slice(0, 10), legends });
    }
    // GET /leaderboard  → the world's best players (cross-club prestige board), optional ?role=
    if (path[0] === 'leaderboard' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const role = new URL(req.url ?? '/', 'http://x').searchParams.get('role') || undefined;
      // memoized per (season, day, role): rosters only change on a tick — a full
      // cross-club sort per request is pure waste under load
      const mk = `${w.season}:${w.day}:${role ?? ''}`;
      if (!rankMemo.has(mk)) { if (rankMemo.size > 24) rankMemo.clear(); rankMemo.set(mk, { players: topPlayers(w, 25, role) }); }
      return json(res, 200, rankMemo.get(mk));
    }
    // GET /powerrankings  → the world's strongest clubs by squad power (+ lifecycle stage)
    if (path[0] === 'powerrankings' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const mk = `pr:${w.season}:${w.day}`;
      if (!rankMemo.has(mk)) { if (rankMemo.size > 24) rankMemo.clear(); rankMemo.set(mk, { clubs: topClubs(w, 25) }); }
      return json(res, 200, rankMemo.get(mk));
    }
    // GET /stats  → season player stats (top fraggers) from RESOLVED watched matches only
    // (embargo-safe — a sealed match contributes nothing until it reveals).
    if (path[0] === 'stats' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const rows = await store.fixtures(id, w.season);
      // memoized per (season, resolved-count): the tally walks every resolved
      // timeline's full event stream — recompute only when a new reveal lands,
      // not per request (this endpoint sits on the standings panel of every client)
      const resolved = rows.filter(f => fixtureStatus(f, now) === 'resolved' && timelines.has(key(f)));
      const memoKey = `${w.season}:${resolved.length}`;
      if (statsMemo?.key !== memoKey) {
        const acc = new Map<string, PlayerStat>();
        for (const f of resolved) tallyTimeline(timelines.get(key(f))!, acc);
        const players = [...acc.values()]
          .sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths) || a.handle.localeCompare(b.handle))
          .slice(0, 25)
          .map((s, i) => ({ rank: i + 1, ...s, kd: s.deaths ? Math.round((s.kills / s.deaths) * 100) / 100 : s.kills, hsPct: s.kills ? Math.round((s.hs / s.kills) * 100) : 0 }));
        statsMemo = { key: memoKey, body: { season: w.season, players } };
      }
      return json(res, 200, statsMemo.body);
    }
    // GET /stats/career  → the ALL-TIME ledger (folded at each rollover + the live
    // season on top, so a career never looks frozen mid-season)
    if (path[0] === 'stats' && path[1] === 'career') {
      const w = (await store.loadWorld(id))!;
      const rows = await store.fixtures(id, w.season);
      const acc = new Map<string, PlayerStat>();
      for (const f of rows) if (fixtureStatus(f, now) === 'resolved' && timelines.has(key(f))) tallyTimeline(timelines.get(key(f))!, acc);
      const merged = new Map<string, PlayerStat & { seasons: number }>();
      for (const c2 of Object.values(careerStats)) merged.set(c2.handle, { ...c2 });
      for (const r2 of acc.values()) {
        const c2 = merged.get(r2.handle) ?? { handle: r2.handle, club: r2.club, role: r2.role, kills: 0, deaths: 0, matches: 0, fb: 0, mvp: 0, hs: 0, clutch: 0, seasons: 0 };
        merged.set(r2.handle, { ...c2, club: r2.club, role: r2.role, kills: c2.kills + r2.kills, deaths: c2.deaths + r2.deaths, matches: c2.matches + r2.matches, fb: c2.fb + r2.fb, mvp: c2.mvp + r2.mvp, hs: c2.hs + r2.hs, clutch: c2.clutch + r2.clutch, seasons: c2.seasons + (r2.matches ? 1 : 0) });
      }
      const players = [...merged.values()]
        .sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths) || a.handle.localeCompare(b.handle))
        .slice(0, 25)
        .map((s2, i) => ({ rank: i + 1, ...s2, kd: s2.deaths ? Math.round((s2.kills / s2.deaths) * 100) / 100 : s2.kills, hsPct: s2.kills ? Math.round((s2.hs / s2.kills) * 100) : 0, retired: (s2 as { retired?: boolean }).retired ?? false }));
      return json(res, 200, { players });
    }
    // GET /notifications  → your targeted inbox (your fixtures/results/season events) + unread
    if (path[0] === 'notifications' && path.length === 1 && (req.method ?? 'GET') === 'GET') {
      if (!account) return json(res, 401, { error: 'no account' });
      const list = notifs.get(account) ?? [];
      return json(res, 200, { items: list, unread: list.filter(n => !n.read).length });
    }
    // POST /notifications/read  → mark one (by id) or all read
    if (path[0] === 'notifications' && path[1] === 'read' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const b = (await readBody(req)) as { id?: number };
      notifs.set(account, (notifs.get(account) ?? []).map(n => (b.id == null || n.id === b.id ? { ...n, read: true } : n)));
      await persistAccount(account);
      return json(res, 200, { ok: true, unread: (notifs.get(account) ?? []).filter(n => !n.read).length });
    }
    // GET /mail  → your owner-to-owner inbox (received messages) + unread count
    if (path[0] === 'mail' && path.length === 1 && (req.method ?? 'GET') === 'GET') {
      if (!account) return json(res, 401, { error: 'no account' });
      const box = mailboxes.get(account) ?? [];
      return json(res, 200, { items: box, unread: box.filter(m => !m.read).length });
    }
    // GET /mail/recipients  → the other human-owned clubs you can message
    if (path[0] === 'mail' && path[1] === 'recipients' && (req.method ?? 'GET') === 'GET') {
      if (!account) return json(res, 401, { error: 'no account' });
      const w = (await store.loadWorld(id))!;
      const list = ownedClubs(w).filter(c => c.owner && c.owner !== account).map(c => ({ tag: c.tag, name: c.name }));
      return json(res, 200, { recipients: list });
    }
    // POST /mail/send  → send a message (or reply) — delivered to BOTH parties, threaded.
    // A `replyTo` (a message id in your mailbox) continues that thread to its other party.
    if (path[0] === 'mail' && path[1] === 'send' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { toTag?: string; subject?: string; body?: string; replyTo?: number };
      if (!(b.body ?? '').trim()) return json(res, 400, { error: 'an empty message' });
      const w = (await store.loadWorld(id))!;
      let toTag = b.toTag ?? '', subject = (b.subject ?? '').slice(0, 80) || '(no subject)', threadId = 0;
      if (b.replyTo != null) {
        const orig = (mailboxes.get(account) ?? []).find(m => m.id === b.replyTo);
        if (!orig) return json(res, 404, { error: 'no such message to reply to' });
        toTag = orig.mine ? orig.toTag : orig.fromTag;                          // the OTHER party in the thread
        subject = orig.subject.startsWith('Re: ') ? orig.subject : `Re: ${orig.subject}`;
        threadId = orig.threadId;
      }
      const target = w.clubs.find(c => c.tag.toLowerCase() === toTag.toLowerCase());
      if (!target) return json(res, 404, { error: 'no such club' });
      if (target.id === mine.id) return json(res, 400, { error: 'you cannot mail yourself' });
      if (!target.owner) return json(res, 400, { error: `${target.tag} is AI-run — no human to read it` });
      const mid = ++mailSeq;
      if (!threadId) threadId = mid;                                            // a new conversation roots at this message
      const base = { id: mid, threadId, fromAccount: account, fromTag: mine.tag, fromName: mine.name, toTag: target.tag, subject, body: (b.body ?? '').slice(0, 1000), season: w.season, day: liveDay, at: clock() };
      pushMail(target.owner, { ...base, read: false, mine: false });           // recipient: unread, incoming
      pushMail(account, { ...base, read: true, mine: true });                   // sender: a read copy (sent items)
      emit('mail', { from: mine.tag, subject }, target.owner);                  // the recipient's ✉ badge updates live
      notify(target.owner, 'system', `✉ New message from ${mine.tag}: ${subject}`, w.season, liveDay);
      await persistAccount(target.owner); await persistAccount(account);        // durable: both mailboxes (+ recipient's notif)
      return json(res, 200, { ok: true });
    }
    // POST /mail/read  → mark one message (id), a whole thread (threadId), or all read
    if (path[0] === 'mail' && path[1] === 'read' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const b = (await readBody(req)) as { id?: number; threadId?: number };
      const all = b.id == null && b.threadId == null;
      mailboxes.set(account, (mailboxes.get(account) ?? []).map(m => (all || m.id === b.id || m.threadId === b.threadId ? { ...m, read: true } : m)));
      await persistAccount(account);
      return json(res, 200, { ok: true, unread: (mailboxes.get(account) ?? []).filter(m => !m.read).length });
    }
    // GET /chat/stream/:room  → SSE for a room ('global' | 'div:<tier>:<group>'): a
    // backlog event, a presence event (online club tags), then live messages. A `?token=`
    // query identifies the connection for presence (EventSource can't set headers).
    if (path[0] === 'chat' && path[1] === 'stream' && path.length >= 3) {
      const room = decodeURIComponent(path.slice(2).join('/'));
      const qtoken = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
      const acct = qtoken ? auth.verify(qtoken) : null;
      const mineC = acct ? await myClub(store, id, acct) : null;
      const conn: ChatConn = { res, tag: mineC?.tag ?? null };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(`event: backlog\ndata: ${JSON.stringify((chatLogs.get(room) ?? []).slice(-60))}\n\n`);
      roomConns(room).add(conn);
      res.write(`event: presence\ndata: ${JSON.stringify(presenceOf(room))}\n\n`);
      if (conn.tag) broadcastPresence(room);                              // announce my arrival to the room
      req.on('close', () => { roomConns(room).delete(conn); if (conn.tag) broadcastPresence(room); });
      return;
    }
    // POST /chat/send  → post to a room ('global' or your OWN division room).
    if (path[0] === 'chat' && path[1] === 'send' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { room?: string; text?: string };
      const room = b.room || 'global';
      const text = (b.text ?? '').trim().slice(0, 300);
      if (!text) return json(res, 400, { error: 'empty message' });
      if (room !== 'global' && room !== `div:${mine.tier}:${mine.group}`) return json(res, 403, { error: 'you can only post to global or your own division' });
      const m: ChatMsg = { id: ++chatSeq, room, fromTag: mine.tag, fromName: mine.name, text, at: clock() };
      const log = chatLogs.get(room) ?? [];
      log.push(m);
      if (log.length > 200) log.shift();
      chatLogs.set(room, log);
      chatBroadcast(m);
      return json(res, 200, { ok: true });
    }
    // GET /news  → the world news feed (transfers + champions, newest first)
    if (path[0] === 'news' && path.length === 1) {
      return json(res, 200, { news: [...news].reverse().slice(0, 40) });
    }
    // GET /circuit  → the international circuit (Masters bracket; full-sims the final)
    if (path[0] === 'circuit' && path.length === 1) {
      if (!circuit) circuit = buildCircuitView(circuitSeed, navOf);
      return json(res, 200, circuit);
    }
    // GET /cup  → the domestic ACE Cup (every club entered, open draw). Full-sims the
    // watchable ties (Premier / human-owned); cached per season. The client highlights its
    // own club and re-sims any watchable tie via /cup/replay/:id.
    if (path[0] === 'cup' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, cupViewFromState(w).view);
    }
    // GET /cup/replay/:id  → a watchable cup tie's snapshot (stored in WorldState.cup), re-simmed.
    if (path[0] === 'cup' && path[1] === 'replay' && path.length === 3) {
      const w = (await store.loadWorld(id))!;
      const snap = cupViewFromState(w).games.get(decodeURIComponent(path[2]));
      return snap ? json(res, 200, { snapshot: snap }) : json(res, 404, { error: 'no such tie' });
    }
    // GET /worldcup  → the World Cup (national teams by nationality; full-sims the final).
    // Cached per season (the squads shift as the world's talent develops/moves); the
    // elected managers' tactics drive the final, so an election change busts the cache.
    if (path[0] === 'worldcup' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, ensureWorldCup(w));
    }
    // GET /worldcup/replay/:id  → a watchable game's snapshot (group, knockout, third-place,
    // or final) — the client re-sims it in the viewer. Every World Cup game is full-simmed.
    if (path[0] === 'worldcup' && path[1] === 'replay' && path.length === 3) {
      const w = (await store.loadWorld(id))!;
      ensureWorldCup(w);
      const snap = worldCupGames.get(decodeURIComponent(path[2]));
      return snap ? json(res, 200, { snapshot: snap }) : json(res, 404, { error: 'no such game' });
    }
    // GET /worldcup/elections  → the manager election state for each qualified nation
    // (current manager, candidates + vote counts, and — with a Bearer — your own status).
    if (path[0] === 'worldcup' && path[1] === 'elections' && path.length === 2 && req.method === 'GET') {
      const w = (await store.loadWorld(id))!;
      const wcv = ensureWorldCup(w);
      const myTag = account ? clubTagOf(w, account) : null;
      const pools = nationPools(w);
      const nations = wcv.squads.map(s => {
        const e = electionOf(s.code), mgr = electedManager(s.code);
        const candidates = e.candidates.map(a => ({ tag: clubTagOf(w, a) ?? '—', votes: tallyVotes(e, a), you: a === account }))
          .sort((x, y) => y.votes - x.votes || x.tag.localeCompare(y.tag));
        const youManager = account != null && mgr === account;
        // the manager sees the full eligible pool to pick the XI from + the fielded ids
        let pool: { id: string; handle: string; name: string; role: string; overall: number }[] | undefined;
        let fielded: string[] | undefined;
        if (youManager) {
          const ps = pools.get(s.code) ?? [];
          pool = ps.map(p => ({ id: p.id, handle: p.handle, name: personOf(p.id).name, role: p.role, overall: Math.round(overall(p)) }))
            .sort((a, b) => b.overall - a.overall);
          fielded = ((e.lineup && pickFive(ps, e.lineup)) || bestFive(ps) || []).map(p => p.id);
        }
        return {
          code: s.code, country: s.country, flag: s.flag,
          manager: mgr ? clubTagOf(w, mgr) : null,
          candidates, hasTactics: !!e.tactics && mgr != null, custom: !!e.lineup && mgr != null,
          youCandidate: account != null && e.candidates.includes(account),
          youManager,
          yourVoteTag: account ? (e.votes.has(account) ? (clubTagOf(w, e.votes.get(account)!) ?? null) : null) : null,
          tactics: youManager ? (e.tactics ?? DEFAULT_TACTICS) : undefined,
          pool, fielded, comp: youManager ? (e.comp ?? {}) : undefined,
        };
      });
      return json(res, 200, { nations, you: myTag });
    }
    // POST /worldcup/:code/run  → stand as a candidate to manage a nation (auto-backs self)
    if (path[0] === 'worldcup' && path.length === 3 && path[2] === 'run' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const w = (await store.loadWorld(id))!;
      if (!clubTagOf(w, account)) return json(res, 403, { error: 'claim a club first — only owners can run' });
      const code = path[1].toUpperCase(), e = electionOf(code);
      if (!e.candidates.includes(account)) e.candidates.push(account);
      e.votes.set(account, account);   // running backs yourself
      bustWorldCup();
      return json(res, 200, { ok: true, manager: clubTagOf(w, electedManager(code)!) });
    }
    // POST /worldcup/:code/vote  { candidateTag }  → back a candidate (by their club tag)
    if (path[0] === 'worldcup' && path.length === 3 && path[2] === 'vote' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const w = (await store.loadWorld(id))!;
      const code = path[1].toUpperCase(), e = electionOf(code);
      const body = (await readBody(req)) as { candidateTag?: string };
      const cand = e.candidates.find(a => clubTagOf(w, a)?.toLowerCase() === (body.candidateTag ?? '').toLowerCase());
      if (!cand) return json(res, 404, { error: 'no such candidate' });
      e.votes.set(account, cand);
      bustWorldCup();
      return json(res, 200, { ok: true, manager: clubTagOf(w, electedManager(code)!) });
    }
    // PATCH /worldcup/:code/tactics  { tactics }  → the elected manager authors the plan
    if (path[0] === 'worldcup' && path.length === 3 && path[2] === 'tactics' && req.method === 'PATCH') {
      if (!account) return json(res, 401, { error: 'no account' });
      const code = path[1].toUpperCase();
      if (electedManager(code) !== account) return json(res, 403, { error: 'only the elected manager can author tactics' });
      const body = (await readBody(req)) as { tactics?: Tactics };
      if (!body.tactics) return json(res, 422, { error: 'no tactics' });
      electionOf(code).tactics = body.tactics;
      bustWorldCup();
      return json(res, 200, { ok: true });
    }
    // PATCH /worldcup/:code/lineup  { lineup: id[] }  → the elected manager selects the XI
    // from the nation's eligible pool. Rejected unless it's a valid five (2 duelist + 1
    // each) drawn from the pool — managing a nation is a real second team to pick.
    if (path[0] === 'worldcup' && path.length === 3 && path[2] === 'lineup' && req.method === 'PATCH') {
      if (!account) return json(res, 401, { error: 'no account' });
      const code = path[1].toUpperCase();
      if (electedManager(code) !== account) return json(res, 403, { error: 'only the elected manager can pick the five' });
      const w = (await store.loadWorld(id))!;
      const body = (await readBody(req)) as { lineup?: string[] };
      const ids = body.lineup ?? [];
      if (!pickFive(nationPools(w).get(code) ?? [], ids)) return json(res, 422, { error: 'not a valid five (need 2 duelists + 1 initiator/controller/sentinel, all eligible)' });
      electionOf(code).lineup = ids;
      bustWorldCup();
      return json(res, 200, { ok: true });
    }
    // PATCH /worldcup/:code/comp  { comp: {playerId: agent} }  → the manager picks agents
    if (path[0] === 'worldcup' && path.length === 3 && path[2] === 'comp' && req.method === 'PATCH') {
      if (!account) return json(res, 401, { error: 'no account' });
      const code = path[1].toUpperCase();
      if (electedManager(code) !== account) return json(res, 403, { error: 'only the elected manager can pick the comp' });
      const body = (await readBody(req)) as { comp?: Record<string, string> };
      electionOf(code).comp = body.comp ?? {};
      bustWorldCup();
      return json(res, 200, { ok: true });
    }
    // GET /worldcup/honors  → the World Cup legacy: past champions (nation + manager) and
    // the manager / nation title boards. The trophy is the manager's AND the team's.
    if (path[0] === 'worldcup' && path[1] === 'honors' && path.length === 2 && req.method === 'GET') {
      const mgrTally = new Map<string, number>(), natTally = new Map<string, { country: string; flag: string; titles: number }>();
      for (const t of worldCupHistory) {
        if (t.managerTag) mgrTally.set(t.managerTag, (mgrTally.get(t.managerTag) ?? 0) + 1);
        const n = natTally.get(t.code) ?? { country: t.country, flag: t.flag, titles: 0 };
        n.titles++; natTally.set(t.code, n);
      }
      return json(res, 200, {
        history: [...worldCupHistory].reverse(),
        managers: [...mgrTally.entries()].map(([tag, titles]) => ({ tag, titles })).sort((a, b) => b.titles - a.titles),
        nations: [...natTally.entries()].map(([code, n]) => ({ code, ...n })).sort((a, b) => b.titles - a.titles),
      });
    }
    // GET /world  → the shard summary (region, clock, the division pyramid + the
    // live broadcast cursor so the client streams the right match-day)
    if (path[0] === 'world' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, { id, region: w.region, season: w.season, day: w.day, tiers: w.tiers, layout: w.layout, divisions: worldDivisions(w).length, clubs: w.clubs.length, promo: w.promo, broadcastDay: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs, lastDay: seasonLength(w) - 1, now,
        // the world-clock contract: who advances time and when the next tick lands
        autoAdvanceSecs: opts.autoAdvanceSecs ?? 0, nextTickAt, manualAdvance: !!opts.allowManualAdvance });
    }
    // POST /advance — DEV/DEMO ONLY. The world clock is SERVER-OWNED: match-days
    // resolve on the scheduled tick, never on a user's click (one player must not
    // move time for everyone). A server booted without the explicit dev opt-in
    // refuses this outright.
    if (path[0] === 'advance' && req.method === 'POST') {
      if (!opts.allowManualAdvance) return json(res, 403, { error: 'the world clock is server-owned — match-days resolve on the scheduled tick' });
      if (!account) return json(res, 401, { error: 'no account' });
      return json(res, 200, await advance());
    }
    // GET /schedule/:tier/:group  → a division's fixtures (pure, with live status)
    if (path[0] === 'schedule' && path.length === 3) {
      const w = (await store.loadWorld(id))!;
      const tier = +path[1], group = +path[2];
      const members = membersOfDiv(w.clubs.map(c => c.tier), w.clubs.map(c => c.group), tier, group);
      const rows = await store.fixtures(id, w.season);
      const matchdays = divisionSchedule(members).map((day, d) => day.map((fx, slot) => {
        const row = rows.find(r => r.day === d && r.home === fx.home && r.away === fx.away);
        // the map is knowable in advance (seed-derived) — a published rotation the
        // manager can PREPARE for (author the playbook before the fixture lands)
        const map = fixtureMap(fixtureSeed(seasonSeedOf(w), d, slot + divSeedOffset(tier, group)));
        return { day: d, slot, map, home: w.clubs[fx.home].tag, away: w.clubs[fx.away].tag, status: row ? fixtureStatus(row, now) : 'scheduled' };
      }));
      return json(res, 200, { tier, group, matchdays });
    }
    // GET /me  → the club this account owns (+ its academy: the youth pipeline)
    if (path[0] === 'me' && path.length === 1) {
      if (!account) return json(res, 401, { error: 'no account' });
      const c = await myClub(store, id, account);
      const wm = (await store.loadWorld(id))!;
      const acct = await accounts.byId(account);
      const vip = vipActive(acct?.vipUntil, clock());
      if (!c) return json(res, 200, vip ? { vip, vipUntil: acct?.vipUntil ?? null } : null);
      const academy = academyView(acadOf(account), c.balance, h => scoutLevelOf(account, h));
      const facilities = c.facilities ?? defaultFacilities();
      const staff = c.staff ?? {};
      const ci = wm.clubs.findIndex(x => x.id === c.id);
      const fanMul = fanSponsorMul(c.fans, baseFans(c.strength, c.tier, c.titles));
      const sponsorList = c.sponsor ? [] : sponsorOffers(wm.seed, wm.season, c.strength, ci).map(o => ({ ...o, base: Math.round(o.base * fanMul), bonus: Math.round(o.bonus * fanMul), goalText: sponsorGoalText(o) }));
      // the board's brief: the target + live rank vs it (from resolved fixtures) + confidence
      const meRows = await store.fixtures(id, wm.season);
      const meTable = standingsView(wm, meRows, c.tier, c.group, clock());
      const objectiveRank = meTable.findIndex(t => t.club === c.tag) + 1;
      const conf = c.boardConfidence ?? 60;
      // team-talk read: find the next fixture's opponent → favourite/underdog edge + squad mood,
      // then grade each tone (great/ok/poor) so the manager can read the room before the match.
      const divSched = divisionSchedule(membersOfDiv(wm.clubs.map(x => x.tier), wm.clubs.map(x => x.group), c.tier, c.group));
      const dayFx = (divSched[wm.day] ?? []).find(f => f.home === ci || f.away === ci);
      const oppIdx = dayFx ? (dayFx.home === ci ? dayFx.away : dayFx.home) : -1;
      const favEdge = oppIdx >= 0 ? c.strength - wm.clubs[oppIdx].strength : 0;
      const mood = squadMood(wm.morale, planFive(c).map(p => p.id));
      const talkReads = Object.fromEntries((['calm', 'rally', 'demand'] as const).map(t => [t, talkFit(t, favEdge, mood)]));
      // derby: the rival club + the head-to-head, and whether this match-day's fixture is the derby
      const rivalClub = c.rival ? wm.clubs.find(x => x.id === c.rival) : null;
      const rival = rivalClub ? { tag: rivalClub.tag, name: rivalClub.name } : null;
      const nextDerby = oppIdx >= 0 && c.rival === wm.clubs[oppIdx].id;
      return json(res, 200, { ...publicClub(wm, c), plan: planOf(c), balance: c.balance, squad: squadView(wm, c), academy, facilities, facilityUpkeep: facilityUpkeep(facilities), staff, staffMarket: staffMarket(wm.seed, wm.season), staffWageBill: staffWageBill(staff), sponsor: c.sponsor ? { ...c.sponsor, goalText: sponsorGoalText(c.sponsor) } : null, sponsorOffers: sponsorList, objective: c.boardObjective ?? null, objectiveRank, boardConfidence: conf, boardStatus: confidenceStatus(conf), boardOutcome: c.boardOutcome ?? null, teamTalk: c.teamTalk ?? null, talkReads, squadMood: mood, favourite: favEdge > 0.02 ? 'fav' : favEdge < -0.02 ? 'dog' : 'even', rival, derbyRecord: c.derby ?? { w: 0, l: 0 }, nextDerby, camp: c.camp ?? null, campOpen: canPickCamp(wm.day), cohesion: Math.round(teamCohesion(planFive(c).map(p => p.tenure)) * 100), career: careers.get(account) ?? [], leagueTitles: c.titles, cupTitles: c.cupTitles ?? 0, intlTitles: c.intlTitles ?? 0, vip, vipUntil: acct?.vipUntil ?? null, plays: c.plays ?? {}, planFive: planFive(c).map(p => ({ id: p.id, handle: p.handle, role: p.role, utility: p.attr.utility })) });
    }
    // POST /me/sponsor  { index }  → sign one of the three offered multi-season deals (base
    // cheque + a bonus if its goal is met; paid at the season settle). Only when unsigned.
    if (path[0] === 'me' && path[1] === 'sponsor' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const w = (await store.loadWorld(id))!;
      const ci = w.clubs.findIndex(x => x.id === mine.id);
      if (w.clubs[ci].sponsor) return json(res, 200, { ok: false, reason: 'already signed' });
      const fanMul2 = fanSponsorMul(w.clubs[ci].fans, baseFans(w.clubs[ci].strength, w.clubs[ci].tier, w.clubs[ci].titles));
      const offers = sponsorOffers(w.seed, w.season, w.clubs[ci].strength, ci).map(o => ({ ...o, base: Math.round(o.base * fanMul2), bonus: Math.round(o.bonus * fanMul2) }));
      const b = (await readBody(req)) as { index?: number };
      const offer = offers[b.index ?? -1];
      if (!offer) return json(res, 400, { error: 'no such offer' });
      const clubs = w.clubs.map((x, i) => i === ci ? { ...x, sponsor: { ...offer, yearsLeft: offer.years } } : x);
      await store.saveWorld(id, { ...w, clubs });
      return json(res, 200, { ok: true, sponsor: { ...offer, yearsLeft: offer.years, goalText: sponsorGoalText(offer) } });
    }
    // POST /me/staff  { role, id?, release? }  → hire a backroom staffer from the season's
    // shortlist (no fee, a recurring wage) or release one. Coach → dev growth, analyst →
    // ceiling + cheaper scouting, psych → less fatigue + injury. Owner-scoped.
    if (path[0] === 'me' && path[1] === 'staff' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { role?: string; id?: string; release?: boolean };
      const role = b.role as StaffRole;
      if (!STAFF_ROLES.includes(role)) return json(res, 400, { error: 'unknown role' });
      const w = (await store.loadWorld(id))!;
      const staff: StaffHires = { ...(w.clubs.find(x => x.id === mine.id)!.staff) };
      if (b.release) { delete staff[role]; }
      else {
        const cand = staffMarket(w.seed, w.season)[role].find(m => m.id === b.id);
        if (!cand) return json(res, 404, { error: 'not on the shortlist' });
        staff[role] = cand;
      }
      const clubs = w.clubs.map(x => x.id === mine.id ? { ...x, staff } : x);
      await store.saveWorld(id, { ...w, clubs });
      return json(res, 200, { ok: true, staff, staffWageBill: staffWageBill(staff) });
    }
    // POST /me/facility  { room }  → build/expand an HQ room (charges the club balance). The
    // boost threads into development at the next tick; a built room costs recurring upkeep.
    if (path[0] === 'me' && path[1] === 'facility' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { room?: string };
      const room = b.room as FacilityId;
      if (!['bootcamp', 'recovery', 'analyst'].includes(room)) return json(res, 400, { error: 'unknown room' });
      const w = (await store.loadWorld(id))!;
      const c = w.clubs.find(x => x.id === mine.id)!;
      const fac: Facilities = { ...defaultFacilities(), ...c.facilities };
      if (fac[room] >= FACILITY_MAX) return json(res, 200, { ok: false, reason: 'maxed' });
      const cost = facilityCost(fac[room]);
      if (c.balance < cost) return json(res, 200, { ok: false, reason: 'insufficient funds', cost });
      const next = { ...fac, [room]: fac[room] + 1 };
      const clubs = w.clubs.map(x => x.id === mine.id ? { ...x, facilities: next, balance: x.balance - cost } : x);
      await store.saveWorld(id, { ...w, clubs });
      return json(res, 200, { ok: true, facilities: next, balance: c.balance - cost, facilityUpkeep: facilityUpkeep(next) });
    }
    // POST /academy/upgrade  → build/expand the youth wing (charges the club balance);
    // a freshly-built academy delivers its first intake immediately.
    if (path[0] === 'academy' && path[1] === 'upgrade' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const w = (await store.loadWorld(id))!;
      try {
        await getBoard();   // materialize the FA board so the intake excludes its handles
        const up = upgradeAcademy(w, mine.id, acadOf(account));
        let acad = up.academy;
        acad = takeIntake(((w.seed ^ 0x5f356495) >>> 0), w.season, acad, allHandles(up.world));   // first class arrives
        academies.set(account, acad);
        await store.saveWorld(id, up.world);
        await persistAccount(account);
        const after = (await store.loadWorld(id))!;
        return json(res, 200, academyView(acad, after.clubs.find(c => c.id === mine.id)!.balance, h => scoutLevelOf(account, h)));
      } catch (e) { return json(res, 200, { error: (e as Error).message }); }
    }
    // POST /academy/promote  → graduate a prospect into the senior roster (no fee)
    if (path[0] === 'academy' && path[1] === 'promote' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { ref?: string };
      const w = (await store.loadWorld(id))!;
      try {
        const g = graduateProspect(w, mine.id, acadOf(account), w.patch, b.ref ?? '');
        academies.set(account, g.academy);
        await store.saveWorld(id, g.world);
        await persistAccount(account);
        const after = (await store.loadWorld(id))!;
        const c = after.clubs.find(x => x.id === mine.id)!;
        return json(res, 200, { ok: true, academy: academyView(g.academy, c.balance, h => scoutLevelOf(account, h)), squad: squadView(after, c) });
      } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }); }
    }
    // POST /academy/cut  → release a prospect you've given up on
    if (path[0] === 'academy' && path[1] === 'cut' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { ref?: string };
      academies.set(account, cutProspect(acadOf(account), b.ref ?? ''));
      await persistAccount(account);
      const w = (await store.loadWorld(id))!;
      return json(res, 200, academyView(acadOf(account), w.clubs.find(c => c.id === mine.id)!.balance, h => scoutLevelOf(account, h)));
    }
    // POST /academy/scout  → commission a report on one of YOUR prospects (owned →
    // a tighter read, the residual is real plasticity). Reuses the scout machinery.
    if (path[0] === 'academy' && path[1] === 'scout' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { ref?: string };
      const p = acadOf(account).prospects.find(x => x.id === b.ref || x.handle === b.ref);
      if (!p) return json(res, 404, { error: 'not in your academy' });
      const level = scoutLevelOf(account, p.handle);
      if (level >= SCOUT_MAX) return json(res, 200, { ok: false, reason: 'fully scouted', level, ceiling: scoutedRange(p, true, level) });
      // VIP perk: half-price reports (same discount as the market — convenience only)
      const cost = Math.round(scoutCost(level) * ((await isVip(account)) ? 0.5 : 1));
      if (cost > mine.balance) return json(res, 200, { ok: false, reason: 'insufficient funds', cost, level, ceiling: scoutedRange(p, true, level) });
      await store.saveWorld(id, chargeScout((await store.loadWorld(id))!, mine.id, cost));
      addReport(account, p.handle, level + 1);
      await persistAccount(account);
      const after = (await store.loadWorld(id))!;
      return json(res, 200, { ok: true, level: level + 1, cost, ceiling: scoutedRange(p, true, level + 1), nextCost: level + 1 < SCOUT_MAX ? scoutCost(level + 1) : null, balance: after.clubs.find(c => c.id === mine.id)!.balance });
    }
    // POST /clubs/:id/claim  → take over an AI club (x-account)
    if (path[0] === 'clubs' && path.length === 3 && path[2] === 'claim' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      if (!(await auth.isVerified(account))) return json(res, 403, { error: 'verify your email before claiming a club' });
      const w = (await store.loadWorld(id))!;
      const c = w.clubs.find(x => x.tag.toLowerCase() === path[1].toLowerCase() || x.id === path[1]);
      if (!c) return json(res, 404, { error: 'no such club' });
      try {
        const club = await claim(store, id, c.id, account);
        notify(account, 'system', `Welcome to ${club.name} — you're the new owner. Author your tactics + lineup to drive your matches.`, (await store.loadWorld(id))!.season, liveDay);
        // surface the current live fixture immediately (the bell shouldn't be empty)
        const ci = (await store.loadWorld(id))!.clubs.findIndex(x => x.id === club.id);
        const fx = (await store.fixtures(id, (await store.loadWorld(id))!.season)).find(f => f.day === liveDay && (f.home === ci || f.away === ci));
        if (fx) { notifiedLive.add(key(fx)); const opp = labelOf(fx.home === ci ? fx.away : fx.home); notify(account, 'fixture', `Match-day ${fx.day + 1}: ${club.tag} vs ${opp.tag}${fx.inputSnapshot ? ' · ' + fx.inputSnapshot.map : ''} — live now`, (await store.loadWorld(id))!.season, fx.day); }
        await persistAccount(account);   // durable: the welcome + first-fixture notifications
        return json(res, 200, publicClub((await store.loadWorld(id))!, club));
      }
      catch (e) { return json(res, 409, { error: (e as Error).message }); }
    }
    // PATCH /me/plan  → author your club's plan (x-account)
    if (path[0] === 'me' && path[1] === 'plan' && req.method === 'PATCH') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const body = (await readBody(req)) as { tactics?: WorldClub['tactics']; comp?: WorldClub['comp']; lineup?: string[] };
      const cur = planOf(mine);
      try { await savePlan(store, id, mine.id, { tactics: body.tactics ?? cur.tactics, comp: body.comp ?? cur.comp, lineup: body.lineup ?? cur.lineup }); }
      catch (e) { return json(res, 422, { error: (e as Error).message }); }
      return json(res, 200, planOf((await myClub(store, id, account))!));
    }
    // POST /me/play  { map, slot, play|null }  → set/clear one slot of your PER-MAP
    // playbook (attack | attack2 | defense). The pure setClubPlay transform sanitizes
    // + caps the authored play at the write boundary; the tick overlays the fixture
    // map's slots at resolution time, so what you author here is what your club
    // actually runs when the rotation lands on that map.
    if (path[0] === 'me' && path[1] === 'play' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { map?: string; slot?: string; play?: unknown };
      if (!MAP_POOL.includes(b.map as MapId)) return json(res, 400, { error: 'not a pool map' });
      if (!['attack', 'attack2', 'defense'].includes(b.slot ?? '')) return json(res, 400, { error: 'slot must be attack | attack2 | defense' });
      try { await savePlay(store, id, mine.id, b.map as MapId, b.slot as 'attack' | 'attack2' | 'defense', (b.play ?? null) as never); }
      catch (e) { return json(res, 422, { error: (e as Error).message }); }
      const after = (await myClub(store, id, account))!;
      return json(res, 200, { ok: true, plays: after.plays ?? {} });
    }
    // POST /me/renew  { playerId }  → re-sign one of your players to a fresh deal at his
    // current market wage (a raise for a risen youngster, a cut for a faded vet). Free — it
    // just re-locks the wage so he can't walk. Returns the updated squad.
    if (path[0] === 'me' && path[1] === 'renew' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { playerId?: string; years?: number };
      if (!mine.roster.some(p => p.id === b.playerId)) return json(res, 404, { error: 'not on your roster' });
      const w = (await store.loadWorld(id))!;
      const clubs = w.clubs.map(c => c.id === mine.id ? { ...c, roster: renewContract(c.roster, b.playerId!, w.patch, b.years) } : c);
      await store.saveWorld(id, { ...w, clubs });
      const after = (await store.loadWorld(id))!;
      return json(res, 200, { ok: true, squad: squadView(after, after.clubs.find(c => c.id === mine.id)!) });
    }
    // POST /me/focus  { playerId, attr }  → direct a player's training reps at one skill (that
    // skill grows faster, the rest a touch slower — a tradeoff). attr null clears to balanced.
    // Owner-scoped development, engine-blind. Returns the updated squad.
    if (path[0] === 'me' && path[1] === 'focus' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { playerId?: string; attr?: keyof import('@ace/shared').Attributes | null };
      if (!mine.roster.some(p => p.id === b.playerId)) return json(res, 404, { error: 'not on your roster' });
      const ATTR_KEYS = ['aim', 'movement', 'entry', 'gameSense', 'utility', 'clutch'];
      if (b.attr != null && !ATTR_KEYS.includes(b.attr)) return json(res, 422, { error: 'bad attr' });
      const w = (await store.loadWorld(id))!;
      const clubs = w.clubs.map(c => {
        if (c.id !== mine.id) return c;
        const focuses = { ...(c.focuses ?? {}) };
        if (b.attr) focuses[b.playerId!] = b.attr; else delete focuses[b.playerId!];
        return { ...c, focuses };
      });
      await store.saveWorld(id, { ...w, clubs });
      const after = (await store.loadWorld(id))!;
      return json(res, 200, { ok: true, squad: squadView(after, after.clubs.find(c => c.id === mine.id)!) });
    }
    // POST /me/talk  { tone }  → set the pre-match team talk (calm/rally/demand); it lands next
    // match then clears. tone null clears it. Owner-scoped, engine-blind (a one-match attr edge).
    if (path[0] === 'me' && path[1] === 'talk' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { tone?: Talk | null };
      if (b.tone != null && !['calm', 'rally', 'demand'].includes(b.tone)) return json(res, 422, { error: 'bad tone' });
      const w = (await store.loadWorld(id))!;
      const clubs = w.clubs.map(c => c.id === mine.id ? { ...c, teamTalk: b.tone ?? undefined } : c);
      await store.saveWorld(id, { ...w, clubs });
      return json(res, 200, { ok: true, teamTalk: b.tone ?? null });
    }
    // POST /me/captain  { playerId }  → name the club captain (a leader steadies + lifts the room).
    // Must be one of your players; null clears to the auto pick (best leader). Engine-blind (morale).
    if (path[0] === 'me' && path[1] === 'captain' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { playerId?: string | null };
      if (b.playerId != null && !mine.roster.some(p => p.id === b.playerId)) return json(res, 404, { error: 'not on your roster' });
      const w = (await store.loadWorld(id))!;
      const clubs = w.clubs.map(c => c.id === mine.id ? { ...c, captain: b.playerId ?? undefined } : c);
      await store.saveWorld(id, { ...w, clubs });
      const after = (await store.loadWorld(id))!;
      return json(res, 200, { ok: true, squad: squadView(after, after.clubs.find(c => c.id === mine.id)!) });
    }
    // POST /me/camp  { camp }  → pick the pre-season training camp (fitness/chemistry/sharpness);
    // only in the early-season window (match-day ≤ CAMP_WINDOW), locked once the campaign's underway.
    // camp null clears it. Owner-scoped, engine-blind (it plugs into fitness/tenure/morale).
    if (path[0] === 'me' && path[1] === 'camp' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = await myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { camp?: Camp | null };
      if (b.camp != null && !['fitness', 'chemistry', 'sharpness'].includes(b.camp)) return json(res, 422, { error: 'bad camp' });
      const w = (await store.loadWorld(id))!;
      if (!canPickCamp(w.day)) return json(res, 422, { error: 'the camp window has closed for this season' });
      const clubs = w.clubs.map(c => c.id === mine.id ? { ...c, camp: b.camp ?? undefined } : c);
      await store.saveWorld(id, { ...w, clubs });
      return json(res, 200, { ok: true, camp: b.camp ?? null });
    }
    return json(res, 404, { error: 'not found' });
  });

  // the scheduled tick worker (PHASE2 §6): when autoAdvanceSecs is set, a Scheduler
  // resolves the next match-day on a cadence — the production "matches resolve on a
  // schedule" behaviour (BullMQ in prod; an in-process IntervalScheduler here, the same
  // `advance` fn either way). Unset → manual /advance only.
  let scheduler: Scheduler | null = null;
  if (opts.autoAdvanceSecs) {
    scheduler = new IntervalScheduler(opts.autoAdvanceSecs * 1000);
    nextTickAt = clock() + opts.autoAdvanceSecs;
    scheduler.start(async () => { await advance(); nextTickAt = clock() + opts.autoAdvanceSecs!; });
  }

  return new Promise(resolve => {
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      selfBase = `http://127.0.0.1:${port}`;
      resolve({ server, url: `http://127.0.0.1:${port}`, id, store, auth, close: () => new Promise(r => {
      scheduler?.stop();
      clearInterval(evHeartbeat);
      clearInterval(bucketSweep);
      if (revealTimer) clearTimeout(revealTimer);
      for (const h of liveHubs.values()) { if (h.timer) clearInterval(h.timer); for (const c of h.clients) { try { c.end(); } catch { /* gone */ } } }
      liveHubs.clear();
      for (const c of evClients) { try { c.res.end(); } catch { /* gone */ } }
      evClients.clear();
      server.close(() => r());
    }) });
    });
  });
}
