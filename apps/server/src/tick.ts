// The tick worker (docs/PHASE2.md §6): resolve the world one match-day at a time,
// idempotently, then roll the season over at the boundary. This is the exact loop
// the BullMQ job will run; here it's driven synchronously against a WorldStore so
// the whole thing is testable headless. It owns NO resolution math — it loads a
// world, calls the shared pure `resolveSeasonDay` / `advanceWorld` from @ace/world,
// and persists. Matchdays within a season are sequential (economy/dev carry);
// fixtures within a day are resolved by the pure core (parallel-safe).
import { resolveSeasonDay, advanceWorld, quickResult, membersOf, divisionSchedule, type WorldState, type Fixture, type MatchResult } from '@ace/world';
import type { Navmesh } from '@ace/maps';
import type { MatchInput, MapId } from '@ace/shared';
import { Rng } from '@ace/engine';
import { fixtureRow, type WorldStore, type TickKind } from './store.js';
import { fullSimResolver } from './sim.js';

/** How a tick resolves fixtures: dormant divisions quick-resolve, but a division
 *  the predicate marks WATCHABLE (a human owner / live spectator) is full-simmed
 *  with the engine, capturing the input_snapshot. Omit to quick-resolve everything
 *  (the headless default). `navOf` is injected so nothing browser-bound is pulled. */
export interface TickOptions {
  full?: (division: number) => boolean;
  navOf?: (map: MapId) => Navmesh;
  forks?: number;
  // broadcast window: when this match-day's matches kick off (wall-clock secs) and
  // how long they play out live before the result reveals (see live.ts). The
  // scheduler passes the real 8pm slot; omit for an instantly-revealed tick.
  kickoffAt?: number;
  broadcastSecs?: number;
}

/** Number of match-days in a season = the top division's double round-robin
 *  length (every tier has `size` clubs → the same schedule length). */
export function seasonLength(w: WorldState): number {
  return divisionSchedule(membersOf(w.clubs.map(c => c.tier), 0)).length;
}

/** A deterministic per-(season, day) dev-rng seed. The day-granular runtimes (the
 *  store, this worker) seed development per tick — vs `simulateSeason`'s single
 *  season-long rng — because a tick can't hold an rng across persistence. Both are
 *  reproducible; this is the server's canonical stream. */
function devSeed(seed: number, season: number, day: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ season, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ day, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

export interface TickReport {
  kind: TickKind; skipped: boolean;
  season: number; day: number; fixtures: number;
  fullSimmed?: number;               // how many fixtures got the engine this tick
  seasonComplete?: boolean;          // matchday tick that filled the last day
  champion?: string; promoted?: number;   // rollover tick
}

/** Resolve the world's current match-day (or roll the season over if the season's
 *  matchdays are all done). Idempotent: a repeated (season, day, kind) is a no-op.
 *  Returns a report of what happened. */
export function runTick(store: WorldStore, id: string, opts?: TickOptions): TickReport {
  const w = store.loadWorld(id);
  if (!w) throw new Error(`runTick: unknown world ${id}`);
  const total = seasonLength(w);

  // season's match-days exhausted → the next tick is the off-season rollover
  if (w.day >= total) return rollover(store, id, w);

  if (store.tickDone(id, w.season, w.day, 'matchday')) {
    return { kind: 'matchday', skipped: true, season: w.season, day: w.day, fixtures: 0 };
  }

  // relevance-scoped resolution: full-sim the watchable divisions, quick the rest.
  let snapshots: Map<number, MatchInput> | undefined;
  let resolve: ((fx: Fixture, seed: number, division: number) => MatchResult) | undefined;
  let fullSimmed = 0;
  if (opts?.full && opts.navOf) {
    const sim = fullSimResolver(w, opts.navOf, opts.forks ?? 0);
    snapshots = sim.snapshots;
    resolve = (fx, seed, division) => {
      if (opts.full!(division)) { fullSimmed++; return sim.resolve(fx, seed, division); }
      return quickResult(fx.home, fx.away, w.clubs[fx.home].strength, w.clubs[fx.away].strength, seed);
    };
  }

  const devRng = new Rng(devSeed(w.seed, w.season, w.day));
  const { results, clubs } = resolveSeasonDay(w, w.day, devRng, { resolve });
  const next: WorldState = { ...w, clubs, results: [...w.results, ...results], day: w.day + 1 };

  const rows = results.map((r, slot) => {
    const row = fixtureRow(id, w.season, w.day, slot, r);
    const snap = snapshots?.get(r.seed);
    if (snap) row.inputSnapshot = snap;   // persist only for watchable fixtures (§7)
    if (opts?.kickoffAt != null) row.kickoffAt = opts.kickoffAt;       // broadcast window: seal the
    if (opts?.broadcastSecs != null) row.broadcastSecs = opts.broadcastSecs;  // result until it plays out
    return row;
  });
  store.appendFixtures(id, rows);
  store.recordTick({ worldId: id, season: w.season, day: w.day, kind: 'matchday', fixtures: results.length });
  store.saveWorld(id, next);
  return { kind: 'matchday', skipped: false, season: w.season, day: w.day, fixtures: results.length, fullSimmed, seasonComplete: next.day >= total };
}

function rollover(store: WorldStore, id: string, w: WorldState): TickReport {
  if (store.tickDone(id, w.season, w.day, 'rollover')) {
    return { kind: 'rollover', skipped: true, season: w.season, day: w.day, fixtures: 0 };
  }
  const { world: next, champion, moves } = advanceWorld(w);   // playoffs · settle · develop · patch · promote/relegate
  store.recordTick({ worldId: id, season: w.season, day: w.day, kind: 'rollover', fixtures: 0 });
  store.saveWorld(id, next);
  return { kind: 'rollover', skipped: false, season: w.season, day: w.day, fixtures: 0, champion: w.clubs[champion].tag, promoted: moves.length };
}

/** Drive one full season to its rollover (a convenience over `runTick` for the
 *  scheduler/tests): tick through every match-day, then the season boundary. */
export function runSeason(store: WorldStore, id: string, opts?: TickOptions): TickReport[] {
  const out: TickReport[] = [];
  for (;;) {
    const r = runTick(store, id, opts);
    out.push(r);
    if (r.kind === 'rollover') return out;
    if (r.skipped) return out;   // already fully resolved up to here — stop rather than spin
  }
}
