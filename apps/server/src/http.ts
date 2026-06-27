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
import { MemoryStore, type FixtureRow } from './store.js';
import { seedWorld } from './seed.js';
import { runTick } from './tick.js';
import { navOf } from './nav.js';
import { publicView, liveMatchState, fixtureStatus } from './live.js';

export interface LiveServerOpts {
  seed?: number; broadcastSecs?: number; port?: number;
  clock?: () => number;   // seconds; default real wall-clock
}
export interface LiveServer { server: Server; url: string; id: string; store: MemoryStore; close: () => Promise<void> }

const key = (f: { season: number; day: number; slot: number }) => `${f.season}:${f.day}:${f.slot}`;
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

/** Boot a world, kick its Premier (division 0) off live *now*, and serve it. The
 *  watchable fixtures' timelines are re-simmed once and cached as the live source
 *  the stream gates; everything else quick-resolves and is just a sealed score. */
export function startLiveServer(opts: LiveServerOpts = {}): Promise<LiveServer> {
  const clock = opts.clock ?? (() => Date.now() / 1000);
  const broadcastSecs = opts.broadcastSecs ?? 2400;
  const store = new MemoryStore();
  const id = seedWorld(store, { seed: opts.seed ?? 7, region: 'AMER' });
  const kickoffAt = clock();
  runTick(store, id, { full: (d) => d === 0, navOf, kickoffAt, broadcastSecs });

  // re-sim each watchable fixture once → the live source the match-center streams
  const timelines = new Map<string, MatchTimeline>();
  for (const f of store.fixtures(id, 1)) if (f.inputSnapshot) timelines.set(key(f), simulateMatch(f.inputSnapshot, navOf(f.inputSnapshot.map), 0));
  const fixtureAt = (season: number, day: number, slot: number): FixtureRow | undefined =>
    store.fixtures(id, season).find(f => f.day === day && f.slot === slot);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const now = clock();
    const path = (req.url ?? '/').split('?')[0].split('/').filter(Boolean);

    if (path[0] === 'health') return json(res, 200, { ok: true, id, now, kickoffAt, revealAt: kickoffAt + broadcastSecs });

    // GET /fixtures/:season/:day/:slot  → spoiler-safe public view
    if (path[0] === 'fixtures' && path.length === 4) {
      const f = fixtureAt(+path[1], +path[2], +path[3]);
      if (!f) return json(res, 404, { error: 'no such fixture' });
      return json(res, 200, publicView(f, now));
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
          return { slot: f.slot, status: v.status, frac: +v.frac.toFixed(3), running: [m.scoreA, m.scoreB], round: m.round + 1, final: v.score ?? null };
        });
        res.write(`data: ${JSON.stringify({ now: t, fixtures })}\n\n`);
        if (fixtures.every(f => f.status === 'resolved')) { clearInterval(timer); res.write('event: done\ndata: {}\n\n'); res.end(); }
      };
      const timer = setInterval(frame, 1000);
      frame();
      req.on('close', () => clearInterval(timer));
      return;
    }
    return json(res, 404, { error: 'not found' });
  });

  return new Promise(resolve => {
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://127.0.0.1:${port}`, id, store, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}
