// The shared resolution core — pure functions the single-player store calls today
// and the Phase-2 server tick worker will call unchanged (see docs/PHASE2.md §2).
// No Vue, no I/O: the engine + navmesh + any "your club" overlay are injected by
// the caller, so this is exactly the boundary both runtimes share.
import type { MatchInput, MapId, PatchState, Team, Tactics, Comp, Player } from '@ace/shared';
import { Rng } from '@ace/engine';
import { seasonIncome, playerWage, contractWage } from './finance.js';
import { fixtureSeed, type MatchResult } from './season.js';
import type { Fixture, Matchday } from './schedule.js';

/** The curated, side-balanced map pool a fixture is played on (the 6 unbalanced
 *  maps stay out of rotation until tuned). Canonical here so the single-player
 *  store and the server tick assign the same map to the same fixture. */
export const MAP_POOL: MapId[] = ['ascent', 'breeze', 'haven', 'lotus', 'split'];
/** Deterministic per-fixture map from its seed — a result is reproducible (re-sim
 *  to watch) because the map is a pure function of the same seed. */
export const fixtureMap = (seed: number): MapId => MAP_POOL[(seed >>> 0) % MAP_POOL.length];

/** Build a fixture's engine input from two clubs' teams, tactics, and comps. The
 *  store overlays YOUR comp/tactics before calling; the server passes each club's
 *  stored plan. */
export function buildMatchInput(opts: {
  seed: number; map: MapId; patch: PatchState;
  home: Team; away: Team;
  tactics: [Tactics, Tactics]; comp: [Comp, Comp];
}): MatchInput {
  return { seed: opts.seed, map: opts.map, patch: opts.patch, teams: [opts.home, opts.away], tactics: opts.tactics, comp: opts.comp };
}

/** A quick (no-engine) result from club strengths — for dormant divisions that
 *  neither the single-player loop nor the server full-sims. Deterministic from
 *  the fixture seed; the scoreline is plausible, never watched. */
export function quickResult(home: number, away: number, homeStrength: number, awayStrength: number, seed: number): MatchResult {
  const rng = new Rng(seed >>> 0);
  const homeWins = rng.next() < 1 / (1 + Math.exp(-(homeStrength - awayStrength) * 6));
  const gap = Math.abs(homeStrength - awayStrength);
  const loser = Math.max(3, Math.min(11, Math.round(11 - gap * 14 + rng.range(-2, 3))));
  return homeWins
    ? { home, away, score: [13, loser], winner: home, seed }
    : { home, away, score: [loser, 13], winner: away, seed };
}

/** Resolve a whole match-day across every division. The per-fixture seed
 *  convention (`day, slot + division·1000`) lives here so the store and server
 *  agree; `full(d)` decides which divisions get the engine, and `sim`/`quick`
 *  are injected (the caller owns the navmesh + any overlay). */
export function resolveWorldDay(opts: {
  schedules: Matchday[][]; day: number; seasonSeed: number;
  full: (division: number) => boolean;
  sim: (fx: Fixture, seed: number) => MatchResult;
  quick: (fx: Fixture, seed: number) => MatchResult;
}): MatchResult[] {
  const out: MatchResult[] = [];
  opts.schedules.forEach((sched, d) => {
    sched[opts.day].forEach((fx, slot) => {
      const seed = fixtureSeed(opts.seasonSeed, opts.day, slot + d * 1000);
      out.push((opts.full(d) ? opts.sim : opts.quick)(fx, seed));
    });
  });
  return out;
}

/** Income scales down each tier — the Premier is where the money is, Iron barely
 *  pays. Pure so the store and server settle identically. */
export const divMult = (tier: number): number => Math.max(0.18, 1 - tier * 0.075);

export interface ClubLedger { sponsor: number; prize: number; playoff: number; wages: number; net: number }

/** A club's season settlement: tier-scaled income by its division rank, minus the
 *  squad wage bill, plus any playoff prize. The wage bill is passed in (the store
 *  bills your whole roster, the server each club's squad). */
export function settleClub(opts: { rank: number; divSize: number; tier: number; wages: number; playoff: number }): ClubLedger {
  const { sponsor, prize } = seasonIncome(opts.rank, opts.divSize);
  const s = Math.round(sponsor * divMult(opts.tier)), p = Math.round(prize * divMult(opts.tier));
  return { sponsor: s, prize: p, playoff: opts.playoff, wages: opts.wages, net: s + p + opts.playoff - opts.wages };
}

/** A squad's total wage bill (the store bills your whole roster; the server each
 *  club's squad). With a `patch`, wages are market-linked (buffed-agent mains cost
 *  more); omit it for the meta-neutral bill. */
export const squadWageBill = (players: Player[], patch?: Parameters<typeof playerWage>[1]): number =>
  players.reduce((s, p) => s + contractWage(p, patch), 0);   // contracted wage (locked) if any, else market
