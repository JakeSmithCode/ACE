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
import { standings, planFive, overall, planOf, worldDivisions, divisionSchedule, membersOfDiv, marketBoard, marketEntry, resolveWorldBid, applySigning, resolveSale, applySale, squadView, type WorldState, type WorldClub } from '@ace/world';
import type { Player } from '@ace/shared';
import { MemoryStore, type FixtureRow } from './store.js';
import { seedWorld } from './seed.js';
import { runTick, seasonLength } from './tick.js';
import { navOf } from './nav.js';
import { publicView, liveMatchState, fixtureStatus } from './live.js';
import { claim, savePlan, myClub } from './owner.js';
import { AuthService, MemoryAccountStore } from './accounts.js';
import { buildCircuitView, type CircuitView } from './circuitView.js';
import { randomBytes } from 'node:crypto';

export interface LiveServerOpts {
  seed?: number; broadcastSecs?: number; port?: number;
  clock?: () => number;   // seconds; default real wall-clock
}
export interface LiveServer { server: Server; url: string; id: string; store: MemoryStore; auth: AuthService; close: () => Promise<void> }

const key = (f: { season: number; day: number; slot: number }) => `${f.season}:${f.day}:${f.slot}`;
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
  tag: c.tag, name: c.name, tier: c.tier, group: c.group, titles: c.titles,
  owned: c.owner != null, rating: Math.round(c.strength * 100),
  five: planFive(c).map(p => ({ handle: p.handle, role: p.role, overall: Math.round(overall(p)), igl: !!p.igl })),
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
export function startLiveServer(opts: LiveServerOpts = {}): Promise<LiveServer> {
  const clock = opts.clock ?? (() => Date.now() / 1000);
  const broadcastSecs = opts.broadcastSecs ?? 2400;
  const store = new MemoryStore();
  const id = seedWorld(store, { seed: opts.seed ?? 7, region: 'AMER' });
  const auth = new AuthService(new MemoryAccountStore(), randomBytes(32).toString('hex'), clock);
  const circuitSeed = opts.seed ?? 7;
  let circuit: CircuitView | undefined;   // the international circuit, computed once on demand
  // the transfer market: a free-agent board built once (stable) + a `sold` set of
  // handles already signed this session (a regenerated board would shift, so cache it)
  let board: Player[] | undefined;
  const sold = new Set<string>();
  const getBoard = () => (board ??= marketBoard(store.loadWorld(id)!));
  // the live broadcast cursor — which match-day is on air + when it kicked off. Mutable
  // so the season can PROGRESS: `advance` ticks the next day and moves the cursor.
  let liveDay = 0;
  let liveKickoff = clock();
  runTick(store, id, { full: (d) => d === 0, navOf, kickoffAt: liveKickoff, broadcastSecs });

  // re-sim each watchable fixture once → the live source the match-center streams.
  // Keyed by season:day:slot, so days accumulate as the season advances.
  const timelines = new Map<string, MatchTimeline>();
  const cacheDay = (season: number, day: number) => {
    for (const f of store.fixtures(id, season)) if (f.day === day && f.inputSnapshot && !timelines.has(key(f))) timelines.set(key(f), simulateMatch(f.inputSnapshot, navOf(f.inputSnapshot.map), 0));
  };
  cacheDay(1, 0);
  /** Tick the next match-day onto the air (a fresh broadcast window). The owner's
   *  authored tactics drive their fixtures, so a season plays out under your plan.
   *  At the season boundary it rolls the season over (playoffs → settle → develop →
   *  patch → promote/relegate) and puts the NEW season's day 0 on air — so the season
   *  cycle completes: a champion is crowned and a fresh season begins. */
  const advance = (): { broadcastDay: number; done: boolean; rollover?: boolean; season?: number; champion?: string } => {
    const tickDay = (w: WorldState) => {
      liveKickoff = clock();
      runTick(store, id, { full: (d) => d === 0, navOf, kickoffAt: liveKickoff, broadcastSecs });
      liveDay = w.day;
      cacheDay(w.season, w.day);
    };
    const w = store.loadWorld(id)!;
    if (w.day < seasonLength(w)) { tickDay(w); return { broadcastDay: liveDay, done: false }; }
    // season's match-days exhausted → roll it over, then open the new season's day 0
    const roll = runTick(store, id);   // kind: 'rollover' (advanceWorld); world is now season+1, day 0
    tickDay(store.loadWorld(id)!);
    return { broadcastDay: liveDay, done: false, rollover: true, season: roll.season + 1, champion: roll.champion };
  };
  const fixtureAt = (season: number, day: number, slot: number): FixtureRow | undefined =>
    store.fixtures(id, season).find(f => f.day === day && f.slot === slot);
  // a static tag/name lookup (club identities don't change tag) — for labelling the
  // live feed + fixture views with who's actually playing (not a spoiler)
  const meta = store.loadWorld(id)!;
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

    // ── self-owned auth (§5/§9): register / login / refresh ──────────────────
    if (path[0] === 'auth' && req.method === 'POST') {
      const b = (await readBody(req)) as { email?: string; password?: string; refreshToken?: string };
      try {
        if (path[1] === 'register') return json(res, 201, auth.register(b.email ?? '', b.password ?? ''));
        if (path[1] === 'login') return json(res, 200, auth.login(b.email ?? '', b.password ?? ''));
        if (path[1] === 'refresh') return json(res, 200, auth.refresh(b.refreshToken ?? ''));
      } catch (e) { return json(res, 401, { error: (e as Error).message }); }
      return json(res, 404, { error: 'unknown auth route' });
    }

    // GET /fixtures/:season/:day/:slot  → spoiler-safe public view (+ who's playing)
    if (path[0] === 'fixtures' && path.length === 4) {
      const f = fixtureAt(+path[1], +path[2], +path[3]);
      if (!f) return json(res, 404, { error: 'no such fixture' });
      return json(res, 200, { ...publicView(f, now), home: labelOf(f.home), away: labelOf(f.away), map: f.inputSnapshot?.map ?? null });
    }
    // GET /fixtures/:season/:day/:slot/replay  → snapshot, but only once resolved
    if (path[0] === 'fixtures' && path.length === 5 && path[4] === 'replay') {
      const f = fixtureAt(+path[1], +path[2], +path[3]);
      if (!f) return json(res, 404, { error: 'no such fixture' });
      if (fixtureStatus(f, now) !== 'resolved') return json(res, 425, { error: 'too early — match still live', status: fixtureStatus(f, now) });
      return json(res, 200, { seed: f.seed, snapshot: f.inputSnapshot ?? null, score: [f.homeScore, f.awayScore] });
    }
    // GET /live/:season/:day  → SSE: the synced live match-center for that day
    if (path[0] === 'live' && path.length === 3) {
      const season = +path[1], day = +path[2];
      const watched = store.fixtures(id, season).filter(f => f.day === day && timelines.has(key(f)));
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
      const w = store.loadWorld(id)!;
      const c = w.clubs.find(x => x.tag.toLowerCase() === path[1].toLowerCase());
      return c ? json(res, 200, publicClub(w, c)) : json(res, 404, { error: 'no such club' });
    }
    // GET /standings/:season/:tier/:group  → embargo-aware table (resolved only)
    if (path[0] === 'standings' && path.length === 4) {
      const w = store.loadWorld(id)!;
      return json(res, 200, { tier: +path[2], group: +path[3], table: standingsView(w, store.fixtures(id, +path[1]), +path[2], +path[3], now) });
    }
    // GET /market  → the free-agent board (value + contested flag, current world)
    if (path[0] === 'market' && path.length === 1 && (req.method ?? 'GET') === 'GET') {
      const w = store.loadWorld(id)!;
      return json(res, 200, { board: getBoard().filter(p => !sold.has(p.handle)).map(p => marketEntry(w, p)) });
    }
    // POST /market/bid  → bid on a free agent (the war); signs if you clear the field
    if (path[0] === 'market' && path[1] === 'bid' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { handle?: string; amount?: number };
      const player = getBoard().find(p => p.handle === b.handle && !sold.has(p.handle));
      if (!player) return json(res, 404, { error: 'not on the board' });
      const w = store.loadWorld(id)!;
      const clubIdx = w.clubs.findIndex(c => c.id === mine.id);
      const result = resolveWorldBid(w, clubIdx, player, b.amount ?? 0);
      if (!result.ok) return json(res, 200, result);                 // outbid / below / broke → raise or walk
      sold.add(player.handle);
      store.saveWorld(id, applySigning(w, mine.id, player, result.paid!));
      const after = store.loadWorld(id)!;
      return json(res, 200, { ...result, club: publicClub(after, after.clubs[clubIdx]) });
    }
    // POST /market/sell  → sell a rostered player to the richest willing AI club
    if (path[0] === 'market' && path[1] === 'sell' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const b = (await readBody(req)) as { ref?: string };
      const w = store.loadWorld(id)!;
      const sale = resolveSale(w, mine.id, b.ref ?? '');
      if (!sale.ok) return json(res, 200, sale);                      // blocked / no buyer → client shows why
      store.saveWorld(id, applySale(w, mine.id, b.ref!, sale.buyerIdx!, sale.fee!));
      const after = store.loadWorld(id)!;
      const ci = after.clubs.findIndex(c => c.id === mine.id);
      return json(res, 200, { ...sale, club: publicClub(after, after.clubs[ci]) });
    }
    // GET /circuit  → the international circuit (Masters bracket; full-sims the final)
    if (path[0] === 'circuit' && path.length === 1) {
      if (!circuit) circuit = buildCircuitView(circuitSeed, navOf);
      return json(res, 200, circuit);
    }
    // GET /world  → the shard summary (region, clock, the division pyramid + the
    // live broadcast cursor so the client streams the right match-day)
    if (path[0] === 'world' && path.length === 1) {
      const w = store.loadWorld(id)!;
      return json(res, 200, { id, region: w.region, season: w.season, day: w.day, tiers: w.tiers, layout: w.layout, divisions: worldDivisions(w).length, clubs: w.clubs.length, broadcastDay: liveDay, kickoffAt: liveKickoff, revealAt: liveKickoff + broadcastSecs, lastDay: seasonLength(w) - 1, now });
    }
    // POST /advance  → tick the next match-day onto the air (owner action; the
    // scheduler does this in production). The day reveals, the standings move.
    if (path[0] === 'advance' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      return json(res, 200, advance());
    }
    // GET /schedule/:tier/:group  → a division's fixtures (pure, with live status)
    if (path[0] === 'schedule' && path.length === 3) {
      const w = store.loadWorld(id)!;
      const tier = +path[1], group = +path[2];
      const members = membersOfDiv(w.clubs.map(c => c.tier), w.clubs.map(c => c.group), tier, group);
      const rows = store.fixtures(id, w.season);
      const matchdays = divisionSchedule(members).map((day, d) => day.map(fx => {
        const row = rows.find(r => r.day === d && r.home === fx.home && r.away === fx.away);
        return { day: d, home: w.clubs[fx.home].tag, away: w.clubs[fx.away].tag, status: row ? fixtureStatus(row, now) : 'scheduled' };
      }));
      return json(res, 200, { tier, group, matchdays });
    }
    // GET /me  → the club this account owns (x-account)
    if (path[0] === 'me' && path.length === 1) {
      if (!account) return json(res, 401, { error: 'no account' });
      const c = myClub(store, id, account);
      return json(res, 200, c ? { ...publicClub(store.loadWorld(id)!, c), plan: planOf(c), balance: c.balance, squad: squadView(store.loadWorld(id)!, c) } : null);
    }
    // POST /clubs/:id/claim  → take over an AI club (x-account)
    if (path[0] === 'clubs' && path.length === 3 && path[2] === 'claim' && req.method === 'POST') {
      if (!account) return json(res, 401, { error: 'no account' });
      const w = store.loadWorld(id)!;
      const c = w.clubs.find(x => x.tag.toLowerCase() === path[1].toLowerCase() || x.id === path[1]);
      if (!c) return json(res, 404, { error: 'no such club' });
      try { return json(res, 200, publicClub(store.loadWorld(id)!, claim(store, id, c.id, account))); }
      catch (e) { return json(res, 409, { error: (e as Error).message }); }
    }
    // PATCH /me/plan  → author your club's plan (x-account)
    if (path[0] === 'me' && path[1] === 'plan' && req.method === 'PATCH') {
      if (!account) return json(res, 401, { error: 'no account' });
      const mine = myClub(store, id, account);
      if (!mine) return json(res, 404, { error: 'you own no club' });
      const body = (await readBody(req)) as { tactics?: WorldClub['tactics']; comp?: WorldClub['comp']; lineup?: string[] };
      const cur = planOf(mine);
      try { savePlan(store, id, mine.id, { tactics: body.tactics ?? cur.tactics, comp: body.comp ?? cur.comp, lineup: body.lineup ?? cur.lineup }); }
      catch (e) { return json(res, 422, { error: (e as Error).message }); }
      return json(res, 200, planOf(myClub(store, id, account)!));
    }
    return json(res, 404, { error: 'not found' });
  });

  return new Promise(resolve => {
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://127.0.0.1:${port}`, id, store, auth, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}
