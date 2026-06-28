// A runnable live-broadcast server slice (docs/PHASE2.md §8.5/§11). Minimal
// node:http — no framework — so it actually runs and can be hit by a client; the
// NestJS version exposes the same shapes. It wraps the tick core + the live
// embargo: REST serves spoiler-safe fixture views and gated replays, and an SSE
// endpoint streams the synced live match-center (everyone watching a division
// sees the same wall-clock moment). The result + snapshot stay sealed until the
// broadcast plays out.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatchTimeline } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { standings, planFive, overall, planOf, worldDivisions, divisionSchedule, membersOfDiv, marketBoard, marketEntry, resolveWorldBid, applySigning, resolveSale, applySale, squadView, resolveAiMarket, scoutCost, chargeScout, scoutedRange, SCOUT_MAX, defaultAcademy, academyView, upgradeAcademy, takeIntake, graduateProspect, cutProspect, developAcademy, topPlayers, topClubs, clubPhase, clubTeam, soloRank, ownedClubs, RANK_TIERS, type Academy, type WorldState, type WorldClub } from '@ace/world';
import type { Player } from '@ace/shared';
import { MemoryStore, type FixtureRow } from './store.js';
import { seedWorld } from './seed.js';
import { runTick, seasonLength } from './tick.js';
import { navOf } from './nav.js';
import { publicView, liveMatchState, fixtureStatus } from './live.js';
import { claim, savePlan, myClub } from './owner.js';
import { AuthService, MemoryAccountStore } from './accounts.js';
import { IntervalScheduler, type Scheduler } from './scheduler.js';
import { buildCircuitView, type CircuitView } from './circuitView.js';
import { randomBytes } from 'node:crypto';

export interface LiveServerOpts {
  seed?: number; broadcastSecs?: number; port?: number;
  clock?: () => number;   // seconds; default real wall-clock
  /** If set, a Scheduler auto-advances the world a match-day every N seconds — the
   *  production "matches resolve on a schedule" behaviour (BullMQ in prod; an in-process
   *  IntervalScheduler here). Unset → manual /advance only. */
  autoAdvanceSecs?: number;
}
export interface LiveServer { server: Server; url: string; id: string; store: MemoryStore; auth: AuthService; close: () => Promise<void> }

const key = (f: { season: number; day: number; slot: number }) => `${f.season}:${f.day}:${f.slot}`;

// Season player stats — accumulated from the full-simmed (watched) match timelines.
// The engine keys every kill by player handle, so this is a pure tally; the match's
// top fragger earns an MVP. Gives the watched division real player careers.
interface PlayerStat { handle: string; club: string; role: string; kills: number; deaths: number; matches: number; fb: number; mvp: number }
function tallyTimeline(tl: MatchTimeline, into: Map<string, PlayerStat>): void {
  const kills: Record<string, number> = {}, deaths: Record<string, number> = {}, fb: Record<string, number> = {};
  for (const r of tl.rounds) {
    const ks = r.events.filter((e): e is Extract<typeof e, { kind: 'kill' }> => e.kind === 'kill').sort((a, b) => a.t - b.t);
    ks.forEach((e, i) => { kills[e.killer] = (kills[e.killer] || 0) + 1; deaths[e.victim] = (deaths[e.victim] || 0) + 1; if (i === 0) fb[e.killer] = (fb[e.killer] || 0) + 1; });
  }
  let mvp = '', best = -1;
  for (const tm of tl.teams) for (const p of tm.players) { const k = kills[p.handle] || 0; if (k > best) { best = k; mvp = p.handle; } }
  tl.teams.forEach(tm => tm.players.forEach(p => {
    const s = into.get(p.handle) ?? { handle: p.handle, club: tm.tag, role: p.role, kills: 0, deaths: 0, matches: 0, fb: 0, mvp: 0 };
    s.kills += kills[p.handle] || 0; s.deaths += deaths[p.handle] || 0; s.fb += fb[p.handle] || 0; s.matches += 1;
    if (p.handle === mvp) s.mvp += 1;
    into.set(p.handle, s);
  }));
}
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage): Promise<unknown> => new Promise(resolve => {
  let buf = '';
  req.on('data', c => (buf += c));
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
});

/** The public club page (§9) — identity, division, lifecycle, the fielded five, and
 *  whether a human owns it. Read-only, always available (no embargo on a club). */
const publicClub = (w: WorldState, c: WorldClub) => ({
  tag: c.tag, name: c.name, tier: c.tier, group: c.group, titles: c.titles, intlTitles: c.intlTitles ?? 0,
  owned: c.owner != null, rating: Math.round(c.strength * 100), phase: clubPhase(clubTeam(c)),
  five: planFive(c).map(p => {
    const ovr = Math.round(overall(p)), sr = soloRank(ovr);
    return { handle: p.handle, role: p.role, overall: ovr, igl: !!p.igl, solo: sr.label, soloTier: sr.tier };
  }),
});

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
  const store = new MemoryStore();
  const id = await seedWorld(store, { seed: opts.seed ?? 7, region: 'AMER' });
  const auth = new AuthService(new MemoryAccountStore(), randomBytes(32).toString('hex'), clock);
  const circuitSeed = opts.seed ?? 7;
  let circuit: CircuitView | undefined;   // the international circuit, computed once on demand
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
  // happening — signings, champions. Newest pushed last; the API returns it reversed.
  const news: { kind: 'transfer' | 'champion' | 'season' | 'award'; text: string; season: number; day: number }[] = [];
  const pushNews = (kind: 'transfer' | 'champion' | 'season' | 'award', text: string, season: number, day: number) => {
    news.push({ kind, text, season, day });
    if (news.length > 60) news.shift();   // keep it bounded
  };
  // per-account notifications — the world news feed targeted to YOU (your fixtures +
  // results, season outcomes, your player's awards). In-memory keyed by account (the
  // PgStore per-account table is the same follow-up as academy/scout state).
  type NotifKind = 'fixture' | 'result' | 'season' | 'award' | 'system';
  interface Notif { id: number; kind: NotifKind; text: string; season: number; day: number; read: boolean; at: number }
  const notifs = new Map<string, Notif[]>();
  let notifSeq = 0;
  const notify = (account: string, kind: NotifKind, text: string, season: number, day: number) => {
    const list = notifs.get(account) ?? [];
    list.unshift({ id: ++notifSeq, kind, text, season, day, read: false, at: clock() });
    if (list.length > 50) list.length = 50;   // bounded inbox
    notifs.set(account, list);
  };
  const notifiedLive = new Set<string>(), notifiedResults = new Set<string>();   // fixture keys already notified (no dupes)
  // owner-to-owner mail (human-to-human, DESIGN §16 social) — real CONVERSATIONS: every
  // message is delivered to BOTH participants' mailboxes (sender's copy read, recipient's
  // unread) and tagged with a `threadId` so a reply continues the thread. `mine` is set
  // per copy (did this mailbox's owner send it). Keyed by account.
  interface MailMsg { id: number; threadId: number; fromAccount: string; fromTag: string; fromName: string; toTag: string; subject: string; body: string; season: number; day: number; read: boolean; mine: boolean; at: number }
  const mailboxes = new Map<string, MailMsg[]>();
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
  });
  for (const { account, data } of await store.listAccountData(id)) {
    if (data.academy) academies.set(account, data.academy as Academy);
    if (data.scout) scoutReports.set(account, new Map(Object.entries(data.scout as Record<string, number>)));
    if (Array.isArray(data.notifs)) notifs.set(account, data.notifs as Notif[]);
    if (Array.isArray(data.mail)) mailboxes.set(account, data.mail as MailMsg[]);
  }
  for (const list of notifs.values()) for (const n of list) notifSeq = Math.max(notifSeq, n.id);
  for (const box of mailboxes.values()) for (const m of box) mailSeq = Math.max(mailSeq, m.id);
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
  await runTick(store, id, { full: (d) => d === 0, navOf, kickoffAt: liveKickoff, broadcastSecs });

  // re-sim each watchable fixture once → the live source the match-center streams.
  // Keyed by season:day:slot, so days accumulate as the season advances.
  const timelines = new Map<string, MatchTimeline>();
  const cacheDay = async (season: number, day: number) => {
    for (const f of await store.fixtures(id, season)) if (f.day === day && f.inputSnapshot && !timelines.has(key(f))) timelines.set(key(f), simulateMatch(f.inputSnapshot, navOf(f.inputSnapshot.map), 0));
  };
  await cacheDay(1, 0);
  /** Tick the next match-day onto the air (a fresh broadcast window). The owner's
   *  authored tactics drive their fixtures, so a season plays out under your plan.
   *  At the season boundary it rolls the season over (playoffs → settle → develop →
   *  patch → promote/relegate) and puts the NEW season's day 0 on air — so the season
   *  cycle completes: a champion is crowned and a fresh season begins. */
  const advance = async (): Promise<{ broadcastDay: number; done: boolean; rollover?: boolean; season?: number; champion?: string; rivalSignings?: number }> => {
    const tickDay = async (w: WorldState) => {
      liveKickoff = clock();
      await runTick(store, id, { full: (d) => d === 0, navOf, kickoffAt: liveKickoff, broadcastSecs });
      liveDay = w.day;
      await cacheDay(w.season, w.day);
    };
    // the living market: a couple of AI clubs sign the best free agents each tick
    const churnMarket = async (): Promise<number> => {
      const avail = (await getBoard()).filter(p => !sold.has(p.handle));
      const w0 = (await store.loadWorld(id))!;
      const { world: nw, signings } = resolveAiMarket(w0, avail, 2);
      if (signings.length) {
        await store.saveWorld(id, nw);
        signings.forEach(s => { sold.add(s.handle); pushNews('transfer', `${s.club} signed ${s.handle} ($${(s.fee / 1000).toFixed(1)}k)`, w0.season, liveDay); });
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
            notify(c.owner, 'result', `${us > them ? 'WON' : 'LOST'} ${us}–${them} vs ${opp.tag}`, wn.season, f.day);
          }
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
    // season's match-days exhausted → roll it over, then open the new season's day 0
    const roll = await runTick(store, id);   // kind: 'rollover' (advanceWorld); world is now season+1, day 0
    if (roll.champion) { honors.push({ season: roll.season, champion: roll.champion }); pushNews('champion', `${roll.champion} are crowned Season ${roll.season} champions 🏆`, roll.season, liveDay); }
    if (mvp) pushNews('award', `Season ${roll.season} MVP: ${mvp.handle} (${mvp.club}) — ${mvp.kills} kills, ${mvp.mvp} POTMs`, roll.season, liveDay);
    pushNews('season', `Season ${roll.season + 1} begins`, roll.season + 1, 0);
    // season-end notifications per owner: final placement (from the finished season, using
    // the pre-rollover world `w` for the right tier), the title, and your-player-is-MVP.
    {
      const rows = await store.fixtures(id, roll.season);
      for (const c of ownedClubs(w)) {
        if (!c.owner) continue;
        const table = standingsView(w, rows, c.tier, c.group, clock());
        const pos = table.findIndex(t => t.club === c.tag) + 1;
        if (pos) notify(c.owner, 'season', `Season ${roll.season}: ${c.tag} finished ${ord(pos)} in ${tierName(c.tier)}`, roll.season, liveDay);
        if (roll.champion === c.tag) notify(c.owner, 'award', `🏆 ${c.tag} are Season ${roll.season} champions!`, roll.season, liveDay);
        if (mvp && c.roster.some(p => p.handle === mvp.handle)) notify(c.owner, 'award', `★ Your player ${mvp.handle} won Season ${roll.season} MVP (${mvp.kills} kills)`, roll.season, liveDay);
        await persistAccount(c.owner);
      }
    }
    await tickAcademies(roll.season + 1);   // develop prospects + deliver the new class
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

    if (path[0] === 'health') return json(res, 200, { ok: true, id, now, broadcastDay: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs });

    // ── self-owned auth (§5/§9): register / login / refresh / verify ──────────
    if (path[0] === 'auth' && req.method === 'POST') {
      const b = (await readBody(req)) as { email?: string; password?: string; refreshToken?: string; token?: string };
      try {
        if (path[1] === 'register') return json(res, 201, await auth.register(b.email ?? '', b.password ?? ''));
        if (path[1] === 'login') return json(res, 200, await auth.login(b.email ?? '', b.password ?? ''));
        if (path[1] === 'refresh') return json(res, 200, await auth.refresh(b.refreshToken ?? ''));
        if (path[1] === 'verify') {
          const acct = await auth.verifyEmail(b.token ?? '');
          return acct ? json(res, 200, { verified: true, accountId: acct }) : json(res, 400, { error: 'invalid or expired verification token' });
        }
      } catch (e) { return json(res, 401, { error: (e as Error).message }); }
      return json(res, 404, { error: 'unknown auth route' });
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
    // GET /live/:season/:day  → SSE: the synced live match-center for that day
    if (path[0] === 'live' && path.length === 3) {
      const season = +path[1], day = +path[2];
      const watched = (await store.fixtures(id, season)).filter(f => f.day === day && timelines.has(key(f)));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      const frame = () => {
        const t = clock();
        const fixtures = watched.map(f => {
          const v = publicView(f, t), m = liveMatchState(timelines.get(key(f))!, v.frac);
          return { slot: f.slot, status: v.status, frac: +v.frac.toFixed(3), running: [m.scoreA, m.scoreB], round: m.round + 1, rounds: timelines.get(key(f))!.rounds.length, final: v.score ?? null, home: labelOf(f.home), away: labelOf(f.away), map: f.inputSnapshot?.map ?? null };
        });
        res.write(`data: ${JSON.stringify({ now: t, fixtures })}\n\n`);
        if (fixtures.every(f => f.status === 'resolved')) { clearInterval(timer); res.write('event: done\ndata: {}\n\n'); res.end(); }
      };
      const timer = setInterval(frame, 1000);
      frame();
      req.on('close', () => clearInterval(timer));
      return;
    }
    // GET /clubs/:slug  → public club page (read-only, no embargo)
    if (path[0] === 'clubs' && path.length === 2 && (req.method ?? 'GET') === 'GET') {
      const w = (await store.loadWorld(id))!;
      const c = w.clubs.find(x => x.tag.toLowerCase() === path[1].toLowerCase());
      return c ? json(res, 200, publicClub(w, c)) : json(res, 404, { error: 'no such club' });
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
      const cost = scoutCost(level);
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
      await store.saveWorld(id, applySigning(w, mine.id, player, result.paid!));
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
      const after = (await store.loadWorld(id))!;
      const ci = after.clubs.findIndex(c => c.id === mine.id);
      return json(res, 200, { ...sale, club: publicClub(after, after.clubs[ci]) });
    }
    // GET /honors  → the Hall of Fame: season champions + all-time title leaders
    if (path[0] === 'honors' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const allTime = w.clubs.filter(c => c.titles > 0).map(c => ({ tag: c.tag, name: c.name, titles: c.titles })).sort((a, b) => b.titles - a.titles || a.tag.localeCompare(b.tag));
      return json(res, 200, { honors: [...honors].reverse(), allTime });
    }
    // GET /leaderboard  → the world's best players (cross-club prestige board), optional ?role=
    if (path[0] === 'leaderboard' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const role = new URL(req.url ?? '/', 'http://x').searchParams.get('role') || undefined;
      return json(res, 200, { players: topPlayers(w, 25, role) });
    }
    // GET /powerrankings  → the world's strongest clubs by squad power (+ lifecycle stage)
    if (path[0] === 'powerrankings' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, { clubs: topClubs(w, 25) });
    }
    // GET /stats  → season player stats (top fraggers) from RESOLVED watched matches only
    // (embargo-safe — a sealed match contributes nothing until it reveals).
    if (path[0] === 'stats' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      const rows = await store.fixtures(id, w.season);
      const acc = new Map<string, PlayerStat>();
      for (const f of rows) {
        if (fixtureStatus(f, now) !== 'resolved') continue;
        const tl = timelines.get(key(f));
        if (tl) tallyTimeline(tl, acc);
      }
      const players = [...acc.values()]
        .sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths) || a.handle.localeCompare(b.handle))
        .slice(0, 25)
        .map((s, i) => ({ rank: i + 1, ...s, kd: s.deaths ? Math.round((s.kills / s.deaths) * 100) / 100 : s.kills }));
      return json(res, 200, { season: w.season, players });
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
    // GET /world  → the shard summary (region, clock, the division pyramid + the
    // live broadcast cursor so the client streams the right match-day)
    if (path[0] === 'world' && path.length === 1) {
      const w = (await store.loadWorld(id))!;
      return json(res, 200, { id, region: w.region, season: w.season, day: w.day, tiers: w.tiers, layout: w.layout, divisions: worldDivisions(w).length, clubs: w.clubs.length, broadcastDay: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs, lastDay: seasonLength(w) - 1, now });
    }
    // POST /advance  → tick the next match-day onto the air (owner action; the
    // scheduler does this in production). The day reveals, the standings move.
    if (path[0] === 'advance' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      return json(res, 200, await advance());
    }
    // GET /schedule/:tier/:group  → a division's fixtures (pure, with live status)
    if (path[0] === 'schedule' && path.length === 3) {
      const w = (await store.loadWorld(id))!;
      const tier = +path[1], group = +path[2];
      const members = membersOfDiv(w.clubs.map(c => c.tier), w.clubs.map(c => c.group), tier, group);
      const rows = await store.fixtures(id, w.season);
      const matchdays = divisionSchedule(members).map((day, d) => day.map(fx => {
        const row = rows.find(r => r.day === d && r.home === fx.home && r.away === fx.away);
        return { day: d, home: w.clubs[fx.home].tag, away: w.clubs[fx.away].tag, status: row ? fixtureStatus(row, now) : 'scheduled' };
      }));
      return json(res, 200, { tier, group, matchdays });
    }
    // GET /me  → the club this account owns (+ its academy: the youth pipeline)
    if (path[0] === 'me' && path.length === 1) {
      if (!account) return json(res, 401, { error: 'no account' });
      const c = await myClub(store, id, account);
      const wm = (await store.loadWorld(id))!;
      if (!c) return json(res, 200, null);
      const academy = academyView(acadOf(account), c.balance, h => scoutLevelOf(account, h));
      return json(res, 200, { ...publicClub(wm, c), plan: planOf(c), balance: c.balance, squad: squadView(wm, c), academy });
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
      const cost = scoutCost(level);
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
    return json(res, 404, { error: 'not found' });
  });

  // the scheduled tick worker (PHASE2 §6): when autoAdvanceSecs is set, a Scheduler
  // resolves the next match-day on a cadence — the production "matches resolve on a
  // schedule" behaviour (BullMQ in prod; an in-process IntervalScheduler here, the same
  // `advance` fn either way). Unset → manual /advance only.
  let scheduler: Scheduler | null = null;
  if (opts.autoAdvanceSecs) {
    scheduler = new IntervalScheduler(opts.autoAdvanceSecs * 1000);
    scheduler.start(() => advance());
  }

  return new Promise(resolve => {
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://127.0.0.1:${port}`, id, store, auth, close: () => new Promise(r => { scheduler?.stop(); server.close(() => r()); }) });
    });
  });
}
