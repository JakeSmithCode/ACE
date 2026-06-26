// The tick worker (docs/PHASE2.md §6): resolve the world one match-day at a time,
// idempotently, then roll the season over at the boundary. This is the exact loop
// the BullMQ job will run; here it's driven synchronously against a WorldStore so
// the whole thing is testable headless. It owns NO resolution math — it loads a
// world, calls the shared pure `resolveSeasonDay` / `advanceWorld` from @ace/world,
// and persists. Matchdays within a season are sequential (economy/dev carry);
// fixtures within a day are resolved by the pure core (parallel-safe).
import { resolveSeasonDay, advanceWorld, membersOf, divisionSchedule, type WorldState } from '@ace/world';
import { Rng } from '@ace/engine';
import { fixtureRow, type WorldStore, type TickKind } from './store.js';

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
  seasonComplete?: boolean;          // matchday tick that filled the last day
  champion?: string; promoted?: number;   // rollover tick
}

/** Resolve the world's current match-day (or roll the season over if the season's
 *  matchdays are all done). Idempotent: a repeated (season, day, kind) is a no-op.
 *  Returns a report of what happened. */
export function runTick(store: WorldStore, id: string): TickReport {
  const w = store.loadWorld(id);
  if (!w) throw new Error(`runTick: unknown world ${id}`);
  const total = seasonLength(w);

  // season's match-days exhausted → the next tick is the off-season rollover
  if (w.day >= total) return rollover(store, id, w);

  if (store.tickDone(id, w.season, w.day, 'matchday')) {
    return { kind: 'matchday', skipped: true, season: w.season, day: w.day, fixtures: 0 };
  }
  const devRng = new Rng(devSeed(w.seed, w.season, w.day));
  const { results, clubs } = resolveSeasonDay(w, w.day, devRng);   // headless: all divisions quick-resolved
  const next: WorldState = { ...w, clubs, results: [...w.results, ...results], day: w.day + 1 };

  store.appendFixtures(id, results.map((r, slot) => fixtureRow(id, w.season, w.day, slot, r)));
  store.recordTick({ worldId: id, season: w.season, day: w.day, kind: 'matchday', fixtures: results.length });
  store.saveWorld(id, next);
  return { kind: 'matchday', skipped: false, season: w.season, day: w.day, fixtures: results.length, seasonComplete: next.day >= total };
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
export function runSeason(store: WorldStore, id: string): TickReport[] {
  const out: TickReport[] = [];
  for (;;) {
    const r = runTick(store, id);
    out.push(r);
    if (r.kind === 'rollover') return out;
    if (r.skipped) return out;   // already fully resolved up to here — stop rather than spin
  }
}
