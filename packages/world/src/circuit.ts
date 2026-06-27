// Regional shards + the international circuit (docs/PHASE2.md §3 "regional shards",
// DESIGN §9). A shard is ONE region's pyramid — a self-contained `WorldState` with
// its own seed and clock — so shards resolve independently and partition server
// load (each is its own `world` row, ticked by its own job). The circuit is the set
// of shards plus the **international events** that connect their tops: each season
// the best clubs of every region meet in a single-elim bracket (Masters/Champions),
// so a region can prove itself against the world. Pure + deterministic from one
// circuit seed; the engine never sees any of this, so seed 42 is untouched.
import { Rng } from '@ace/engine';
import { fixtureSeed } from './season.js';
import { createWorld, divisionTable, type WorldState } from './state.js';

/** The real circuit's regional shards (DESIGN §9). A circuit can run any subset. */
export const REGIONS = ['AMER', 'EMEA', 'PACIFIC', 'CHINA'] as const;

/** A per-region shard seed — independent shards, all reproducible from one circuit
 *  seed (so a whole multi-region circuit is a function of a single number). */
export function shardSeed(seed: number, region: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < region.length; i++) {
    h = Math.imul(h ^ region.charCodeAt(i), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

/** Generate a circuit: one independent pyramid (`WorldState`) per region. Each is a
 *  full shard the server persists + ticks on its own; here they're plain values. */
export function createCircuit(seed: number, opts: { regions?: readonly string[]; tiers?: number; size?: number; promo?: number; layout?: number[] } = {}): WorldState[] {
  const regions = opts.regions ?? REGIONS;
  return regions.map(r => createWorld(shardSeed(seed, r), { region: r, tiers: opts.tiers, size: opts.size, promo: opts.promo, layout: opts.layout }));
}

/** A club that qualified for an international event, identified across shards by
 *  `(region, club)` (a club index is only unique within its own shard). */
export interface IntlEntry { region: string; club: number; seedRank: number; strength: number; tag: string }
export interface IntlMatch { round: number; a: IntlEntry; b: IntlEntry; winner: IntlEntry; seed: number }
export interface IntlResult {
  seed: number;
  field: IntlEntry[];        // everyone who qualified, in overall seed order
  matches: IntlMatch[];      // every game played, round by round
  champion: IntlEntry;
  placement: IntlEntry[];    // finish order (champion first)
}

/** The classic single-elim seed arrangement for a bracket of `n` (1 plays n, 2 plays
 *  n-1, …) so the top seeds are spread across the draw and only meet late. */
function bracketOrder(n: number): number[] {
  let order = [1, 2];
  while (order.length < n) {
    const len = order.length * 2;
    const next: number[] = [];
    for (const s of order) { next.push(s); next.push(len + 1 - s); }
    order = next;
  }
  return order;
}

/** A single match by strength (the same logistic as `quickResult`, cross-shard). */
function play(a: IntlEntry, b: IntlEntry, seed: number): IntlEntry {
  return new Rng(seed >>> 0).next() < 1 / (1 + Math.exp(-(a.strength - b.strength) * 6)) ? a : b;
}

/** Run an international event: the top `slots` of each shard's Premier qualify, are
 *  seeded overall (region winners first, ties by strength), and play a single-elim
 *  bracket. The field is trimmed to the largest power of two so the draw is clean.
 *  Pure + deterministic — every game seed is a stable hash of the event seed. */
export function internationalEvent(worlds: WorldState[], opts: { seed: number; slots?: number }): IntlResult {
  const slots = opts.slots ?? 2;
  const field: IntlEntry[] = [];
  for (const w of worlds) {
    divisionTable(w, 0, 0).slice(0, slots).forEach((s, rank) =>
      field.push({ region: w.region, club: s.club, seedRank: rank, strength: w.clubs[s.club].strength, tag: w.clubs[s.club].tag }));
  }
  // overall seeding: each region's #1s first (then #2s …), ties broken by strength
  field.sort((a, b) => a.seedRank - b.seedRank || b.strength - a.strength || a.region.localeCompare(b.region));
  const N = 1 << Math.floor(Math.log2(Math.max(2, field.length)));
  const seeded = bracketOrder(N).map(s => field[s - 1]);   // draw positions, top seeds spread

  const matches: IntlMatch[] = [];
  const eliminatedRound = new Map<IntlEntry, number>();
  let alive = seeded, round = 0;
  while (alive.length > 1) {
    const next: IntlEntry[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i], b = alive[i + 1];
      const seed = fixtureSeed(opts.seed, round, i);
      const winner = play(a, b, seed);
      matches.push({ round, a, b, winner, seed });
      eliminatedRound.set(winner === a ? b : a, round);
      next.push(winner);
    }
    alive = next; round++;
  }
  const champion = alive[0];
  eliminatedRound.set(champion, round);   // survived every round
  const placement = [...field.slice(0, N)].sort((a, b) =>
    (eliminatedRound.get(b) ?? -1) - (eliminatedRound.get(a) ?? -1) || b.strength - a.strength);
  return { seed: opts.seed, field, matches, champion, placement };
}

/** A region medal tally over a run of international events — who owns the circuit. */
export function regionTitles(results: IntlResult[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of results) t[r.champion.region] = (t[r.champion.region] ?? 0) + 1;
  return t;
}
