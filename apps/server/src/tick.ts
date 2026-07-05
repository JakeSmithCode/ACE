// The tick worker (docs/PHASE2.md §6): resolve the world one match-day at a time,
// idempotently, then roll the season over at the boundary. This is the exact loop
// the BullMQ job will run; here it's driven synchronously against a WorldStore so
// the whole thing is testable headless. It owns NO resolution math — it loads a
// world, calls the shared pure `resolveSeasonDay` / `advanceWorld` from @ace/world,
// and persists. Matchdays within a season are sequential (economy/dev carry);
// fixtures within a day are resolved by the pure core (parallel-safe).
import { resolveSeasonDay, advanceWorld, quickResult, membersOfDiv, divisionSchedule, createCup, cupRoundDue, resolveCupRound, planFive, fitFive, tickFitness, emptyFitness, isInjured, traitKeyOf, staffEffect, updateMorale, emptyMorale, captainOf, CAMP_FAT, MAP_POOL, mapAffinity, type Bracket, type WorldState, type Fixture, type MatchResult } from '@ace/world';
import type { Navmesh } from '@ace/maps';
import type { MatchInput, MapId } from '@ace/shared';
import { Rng } from '@ace/engine';
import { fixtureRow, type WorldStore, type TickKind } from './store.js';
import { fullSimResolver, playoffGameResolver } from './sim.js';

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
  return divisionSchedule(membersOfDiv(w.clubs.map(c => c.tier), w.clubs.map(c => c.group), 0, 0)).length;
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
  bracket?: Bracket;                 // rollover: the Premier playoff bracket (engine-simmed when navOf given)
  playoffSnapshots?: Map<number, MatchInput>;   // rollover + navOf: per-game snapshots (seed → input), watchable
}

/** Resolve the world's current match-day (or roll the season over if the season's
 *  matchdays are all done). Idempotent: a repeated (season, day, kind) is a no-op.
 *  Returns a report of what happened. */
export async function runTick(store: WorldStore, id: string, opts?: TickOptions): Promise<TickReport> {
  const w = await store.loadWorld(id);
  if (!w) throw new Error(`runTick: unknown world ${id}`);
  const total = seasonLength(w);

  // season's match-days exhausted → the next tick is the off-season rollover
  if (w.day >= total) return rollover(store, id, w, opts);

  if (await store.tickDone(id, w.season, w.day, 'matchday')) {
    return { kind: 'matchday', skipped: true, season: w.season, day: w.day, fixtures: 0 };
  }

  // relevance-scoped resolution: full-sim the watchable divisions, quick the rest.
  let snapshots: Map<number, MatchInput> | undefined;
  let resolve: ((fx: Fixture, seed: number, division: number) => MatchResult) | undefined;
  let sim: ReturnType<typeof fullSimResolver> | undefined;
  let fullSimmed = 0;
  if (opts?.full && opts.navOf) {
    sim = fullSimResolver(w, opts.navOf, opts.forks ?? 0);
    snapshots = sim.snapshots;
    resolve = (fx, seed, division) => {
      if (opts.full!(division)) { fullSimmed++; return sim!.resolve(fx, seed, division); }
      return quickResult(fx.home, fx.away, w.clubs[fx.home].strength, w.clubs[fx.away].strength, seed);
    };
  }

  const devRng = new Rng(devSeed(w.seed, w.season, w.day));
  const { results, clubs } = resolveSeasonDay(w, w.day, devRng, { resolve });

  // the domestic cup ticks WITH the league (durable in WorldState): on a cup match-day, draw +
  // resolve that round — full-sim the WATCHABLE ties (Premier / human-owned, capturing the
  // input snapshot for re-sim) and quick-resolve the rest.
  let cup = w.cup ?? createCup(w.clubs.map((_, i) => i), w.season);
  if (cupRoundDue(cup, w.day)) {
    cup = resolveCupRound(cup, i => w.clubs[i].strength, w.seed, w.season, (home, away, seed) => {
      const watch = !!(opts?.full && (opts.full(w.clubs[home].tier) || opts.full(w.clubs[away].tier))) || !!w.clubs[home].owner || !!w.clubs[away].owner;
      if (watch && sim) { const r = sim.resolve({ home, away }, seed, 0); return { result: r, input: sim.snapshots.get(seed) }; }
      return { result: quickResult(home, away, w.clubs[home].strength, w.clubs[away].strength, seed) };
    });
  }

  // fitness + morale tick for HUMAN-OWNED clubs (depth + man-management matter on match night):
  // the five who played tire + risk injury (the rest recover), and the room's mood drifts from
  // the result, minutes, the captain, a psychologist, and the pre-match team talk (then the talk
  // is consumed). Only owned clubs model either — a world with no owners is byte-identical.
  let fitness = w.fitness;
  let morale = w.morale;
  const resultOf = new Map<number, MatchResult>();
  for (const r of results) { resultOf.set(r.home, r); resultOf.set(r.away, r); }
  const derbyByIdx = new Map<number, boolean>();   // owned club idx → won its derby this day (for the H2H tally)
  let clubsOut = clubs;
  const ownedIdx = w.clubs.map((c, i) => (c.owner ? i : -1)).filter(i => i >= 0);
  if (ownedIdx.length) {
    const fr = new Rng((devSeed(w.seed, w.season, w.day) ^ 0xF17a7) >>> 0);
    let fit = fitness ?? emptyFitness();
    let mor = morale ?? emptyMorale();
    for (const i of ownedIdx) {
      const c = w.clubs[i];
      const fielded = fitFive(c.roster, planFive(c), fit).five;   // who actually played (pre-match fitness)
      const fivIds = new Set(fielded.map(p => p.id));
      const eff = c.staff ? staffEffect(c.staff) : null;          // a sports psych cuts fatigue + injury rates + lifts mood
      const campFat = c.camp === 'fitness' ? CAMP_FAT : 1;        // a fitness camp slows the fatigue burn all season
      fit = tickFitness(fit, c.roster, fivIds, fr, fitId => traitKeyOf(fitId) === 'workhorse', (eff?.fatigueMul ?? 1) * campFat, eff?.injuryMul ?? 1).fitness;
      const r = resultOf.get(i);
      const won = r ? r.winner === i : null;
      const opp = r ? (r.home === i ? r.away : r.home) : -1;
      const favEdge = opp >= 0 ? c.strength - w.clubs[opp].strength : 0;
      const derby = opp >= 0 && c.rival === w.clubs[opp].id;   // a derby win/loss hits the room harder + builds the H2H
      mor = updateMorale(mor, c.roster, fivIds, won, {
        captain: captainOf(fielded, c.captain), talk: c.teamTalk, favEdge, psych: eff?.morale ?? 0, derby,
        injured: id => isInjured(fit, id), sharpnessCamp: c.camp === 'sharpness',
      });
      if (derby && won != null) derbyByIdx.set(i, won);   // record the derby result for the H2H tally
    }
    fitness = fit; morale = mor;
    // the team talk was a one-shot for this match — clear it; a derby updates the H2H record
    clubsOut = clubs.map((c, idx) => {
      const d = derbyByIdx.get(idx);
      const rec = d != null ? { w: (c.derby?.w ?? 0) + (d ? 1 : 0), l: (c.derby?.l ?? 0) + (d ? 0 : 1) } : c.derby;
      return c.owner && (c.teamTalk || d != null) ? { ...c, teamTalk: undefined, derby: rec } : c;
    });
  }

  const next: WorldState = { ...w, clubs: clubsOut, results: [...w.results, ...results], day: w.day + 1, cup, fitness, morale };

  const rows = results.map((r, slot) => {
    const row = fixtureRow(id, w.season, w.day, slot, r);
    const snap = snapshots?.get(r.seed);
    if (snap) row.inputSnapshot = snap;   // persist only for watchable fixtures (§7)
    if (opts?.kickoffAt != null) row.kickoffAt = opts.kickoffAt;       // broadcast window: seal the
    if (opts?.broadcastSecs != null) row.broadcastSecs = opts.broadcastSecs;  // result until it plays out
    return row;
  });
  await store.appendFixtures(id, rows);
  await store.recordTick({ worldId: id, season: w.season, day: w.day, kind: 'matchday', fixtures: results.length });
  await store.saveWorld(id, next);
  return { kind: 'matchday', skipped: false, season: w.season, day: w.day, fixtures: results.length, fullSimmed, seasonComplete: next.day >= total };
}

async function rollover(store: WorldStore, id: string, w: WorldState, opts?: TickOptions): Promise<TickReport> {
  if (await store.tickDone(id, w.season, w.day, 'rollover')) {
    return { kind: 'rollover', skipped: true, season: w.season, day: w.day, fixtures: 0 };
  }
  // with a navmesh available, the Premier playoffs are ENGINE-SIMMED over the live
  // pool with each series' real map veto — the champion is the engine's verdict and
  // every game's snapshot is captured (watchable). Headless callers stay on the
  // quick-resolve default (byte-identical rollover).
  const po = opts?.navOf ? playoffGameResolver(w, opts.navOf) : undefined;
  const roll = advanceWorld(w, po ? {
    playoffResolve: po.resolve, playoffPool: MAP_POOL,
    playoffAffinity: (ci, m) => mapAffinity(w.clubs[ci].id, m),
  } : {});
  const { world: next, champion, moves } = roll;   // playoffs · settle · develop · patch · promote/relegate
  await store.recordTick({ worldId: id, season: w.season, day: w.day, kind: 'rollover', fixtures: 0 });
  await store.saveWorld(id, next);
  return { kind: 'rollover', skipped: false, season: w.season, day: w.day, fixtures: 0, champion: w.clubs[champion].tag, promoted: moves.length, bracket: roll.bracket, playoffSnapshots: po?.snapshots };
}

/** Drive one full season to its rollover (a convenience over `runTick` for the
 *  scheduler/tests): tick through every match-day, then the season boundary. */
export async function runSeason(store: WorldStore, id: string, opts?: TickOptions): Promise<TickReport[]> {
  const out: TickReport[] = [];
  for (;;) {
    const r = await runTick(store, id, opts);
    out.push(r);
    if (r.kind === 'rollover') return out;
    if (r.skipped) return out;   // already fully resolved up to here — stop rather than spin
  }
}
