// Regional shards + the international circuit (docs/PHASE2.md §3 "regional shards",
// DESIGN §9). A shard is ONE region's pyramid — a self-contained `WorldState` with
// its own seed and clock — so shards resolve independently and partition server
// load (each is its own `world` row, ticked by its own job). The circuit is the set
// of shards plus the **international events** that connect their tops: each season
// the best clubs of every region meet in a single-elim bracket (Masters/Champions),
// so a region can prove itself against the world. Pure + deterministic from one
// circuit seed; the engine never sees any of this, so seed 42 is untouched.
import { Rng } from '@ace/engine';
import type { Player, PatchState } from '@ace/shared';
import { fixtureSeed } from './season.js';
import { createWorld, divisionTable, startingFive, type WorldState, type WorldClub } from './state.js';
import { overall, squadRating } from './develop.js';
import { playerValue } from './market.js';

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

/** International prize money by finish (DESIGN §9 — the event has to *matter*). The
 *  pool dwarfs a domestic season so a deep international run reshapes a club's
 *  transfer budget, and a strong region pulls money into its shard. */
export interface IntlPrize { champion: number; finalist: number; semifinal: number; appearance: number }
export const DEFAULT_INTL_PRIZE: IntlPrize = { champion: 250_000, finalist: 120_000, semifinal: 60_000, appearance: 25_000 };

/** Pay out an event into the shards: each qualifier's club banks a prize by its
 *  bracket finish (champion > finalist > semifinalist > appearance). Pure — returns
 *  new shard states (balances bumped), so it's opt-in and the no-circuit CLIs +
 *  seed 42 are untouched. The server applies this at the off-season seam. */
// ── The international transfer window (cross-region transfers, DESIGN §9) ──────────────
// After the Masters, the qualifiers — flush with prize money and proven on the world stage
// — raid the best AFFORDABLE upgrade from ANOTHER region. It's a SWAP (same role, so every
// roster stays a valid five): the buyer's weakest same-role starter goes the other way, and
// the fee (the value difference) is paid buyer→seller. Pure + deterministic; a moved player's
// id is re-tagged to the new club and his handle is kept unique within the destination shard
// (the engine assumes unique handles per match). Cross-region only — talent flows to money.
export interface CrossMove {
  player: string; role: string; overall: number; fee: number;
  from: { region: string; tag: string }; to: { region: string; tag: string };
}
const clampStrength = (s: number) => Math.max(0.3, Math.min(0.95, s));
const restrength = (c: WorldClub): number => clampStrength(squadRating({ id: c.id, tag: c.tag, name: c.name, players: startingFive(c.roster) }) / 100);
/** Re-tag a player onto a destination club + shard: new id, handle kept unique in that
 *  shard (suffix on collision), tenure reset (a fresh signing hasn't gelled). */
function retagCross(p: Player, dest: WorldClub, destWorld: WorldState, excludeId: string): Player {
  const taken = new Set(destWorld.clubs.flatMap(c => c.roster).filter(x => x.id !== excludeId).map(x => x.handle));
  let handle = p.handle;
  while (taken.has(handle)) handle += '·';
  return { ...p, id: `${dest.id}-${handle.toLowerCase()}`, handle, tenure: 0 };
}
export function internationalTransfers(
  worlds: WorldState[], qualifiers: IntlEntry[], opts: { patch?: PatchState; max?: number; minUpgrade?: number } = {},
): { worlds: WorldState[]; moves: CrossMove[] } {
  const max = opts.max ?? 6, minUpgrade = opts.minUpgrade ?? 2;
  // a mutable working copy of every shard's clubs (rosters copied so we can swap players)
  const shards = worlds.map(w => ({ ...w, clubs: w.clubs.map(c => ({ ...c, roster: [...c.roster] })) }));
  const regionIdx = new Map(shards.map((w, i) => [w.region, i]));
  const moves: CrossMove[] = [];
  // buyers = the qualifier clubs, richest first (they earned the prize money to spend)
  const buyers = qualifiers
    .map(q => ({ wi: regionIdx.get(q.region)!, ci: q.club }))
    .filter(b => b.wi != null)
    .sort((a, b) => shards[b.wi].clubs[b.ci].balance - shards[a.wi].clubs[a.ci].balance);
  const locked = new Set<string>();   // a player moves at most once per window (no same-window re-flips)
  for (const { wi, ci } of buyers) {
    if (moves.length >= max) break;
    const buyer = shards[wi].clubs[ci];
    const five = startingFive(buyer.roster);
    let best: { tWi: number; tCi: number; target: Player; weak: Player; gain: number; fee: number } | null = null;
    for (let wj = 0; wj < shards.length; wj++) {
      if (wj === wi) continue;   // cross-region only
      for (let cj = 0; cj < shards[wj].clubs.length; cj++) {
        for (const target of startingFive(shards[wj].clubs[cj].roster)) {
          if (locked.has(target.id)) continue;
          const sameRole = five.filter(p => p.role === target.role && !locked.has(p.id));
          if (!sameRole.length) continue;
          const weak = sameRole.reduce((a, b) => (overall(a) <= overall(b) ? a : b));
          const gain = overall(target) - overall(weak);
          if (gain < minUpgrade) continue;
          const fee = Math.max(0, Math.round(playerValue(target, opts.patch) - playerValue(weak, opts.patch)));
          if (fee > buyer.balance) continue;
          // deterministic pick: biggest upgrade, then cheapest, then stable id order
          if (!best || gain > best.gain || (gain === best.gain && (fee < best.fee || (fee === best.fee && target.id < best.target.id)))) {
            best = { tWi: wj, tCi: cj, target, weak, gain, fee };
          }
        }
      }
    }
    if (!best) continue;
    const seller = shards[best.tWi].clubs[best.tCi];
    const incoming = retagCross(best.target, buyer, shards[wi], best.weak.id);          // target → buyer's shard
    const outgoing = retagCross(best.weak, seller, shards[best.tWi], best.target.id);    // weak → seller's shard
    buyer.roster = buyer.roster.map(p => (p.id === best!.weak.id ? incoming : p));
    seller.roster = seller.roster.map(p => (p.id === best!.target.id ? outgoing : p));
    locked.add(incoming.id); locked.add(outgoing.id);   // both swapped players are now settled for the window
    buyer.balance -= best.fee; seller.balance += best.fee;
    buyer.strength = restrength(buyer); seller.strength = restrength(seller);
    moves.push({ player: best.target.handle, role: best.target.role, overall: overall(best.target), fee: best.fee,
      from: { region: shards[best.tWi].region, tag: seller.tag }, to: { region: shards[wi].region, tag: buyer.tag } });
  }
  return { worlds: shards, moves };
}

export function awardInternational(worlds: WorldState[], result: IntlResult, prize: IntlPrize = DEFAULT_INTL_PRIZE): WorldState[] {
  const payout = new Map<string, number>();   // `${region}|${club}` → prize
  result.placement.forEach((e, rank) => {
    payout.set(`${e.region}|${e.club}`, rank === 0 ? prize.champion : rank === 1 ? prize.finalist : rank < 4 ? prize.semifinal : prize.appearance);
  });
  const champKey = `${result.champion.region}|${result.champion.club}`;   // the Masters winner earns a title (prestige)
  return worlds.map(w => {
    if (![...payout.keys()].some(k => k.startsWith(`${w.region}|`))) return w;
    return { ...w, clubs: w.clubs.map((c, i) => {
      const k = `${w.region}|${i}`, add = payout.get(k) ?? 0, title = k === champKey ? 1 : 0;
      return add || title ? { ...c, balance: c.balance + add, ...(title ? { intlTitles: (c.intlTitles ?? 0) + 1 } : {}) } : c;
    }) };
  });
}
