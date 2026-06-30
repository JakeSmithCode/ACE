// The World Cup — national teams assembled from the league's talent by NATIONALITY
// (DESIGN §9, building on the identity layer). Every player has a real country; this
// gathers the best of each nation into a national five and runs a single-elim bracket
// for the world title — VALORANT-meets-international-football. Pure + deterministic:
// a function of the world state + a seed, the engine never sees it. The server full-sims
// the final (watchable) exactly like the international circuit.
import type { Player, Team } from '@ace/shared';
import { Rng } from '@ace/engine';
import { overall } from './develop.js';
import { personOf } from './identity.js';
import { fixtureSeed } from './season.js';
import type { WorldState } from './state.js';

const ROLE_NEED = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 } as const;

export interface NationSquad {
  country: string; flag: string; code: string;
  five: Player[];        // 2 duelist + 1 init/ctrl/sentinel, IGL = the sentinel
  strength: number;      // mean overall of the five — seeds the bracket
  pool: number;          // how many players of this nationality exist (depth)
}

/** The full eligible pool of every nation, keyed by country CODE — everyone of that
 *  nationality across the world (the manager's selection pool). */
export function nationPools(w: WorldState): Map<string, Player[]> {
  const byCode = new Map<string, Player[]>();
  for (const c of w.clubs) for (const p of c.roster) {
    const code = personOf(p.id).nation.code;
    let arr = byCode.get(code);
    if (!arr) { arr = []; byCode.set(code, arr); }
    arr.push(p);
  }
  return byCode;
}

const withIgl = (five: Player[]): Player[] => five.map(p => ({ ...p, igl: p.role === 'sentinel' }));
export const fiveStrength = (five: Player[]): number => five.reduce((s, p) => s + overall(p), 0) / Math.max(1, five.length);

/** A nation's best VALID five from its pool (2 duelist + 1 each, best by overall),
 *  or null if a role can't be filled (the nation can't field a team). */
export function bestFive(pool: Player[]): Player[] | null {
  const five: Player[] = [];
  for (const role of ['duelist', 'initiator', 'controller', 'sentinel'] as const) {
    const inRole = pool.filter(p => p.role === role).sort((a, b) => overall(b) - overall(a) || a.id.localeCompare(b.id));
    if (inRole.length < ROLE_NEED[role]) return null;
    five.push(...inRole.slice(0, ROLE_NEED[role]));
  }
  return withIgl(five);
}

/** A manager-chosen five from a pool by player id — returns it only if the picks form a
 *  VALID comp drawn from the pool (2 duelist + 1 init/ctrl/sentinel), else null (so a
 *  stale/invalid selection safely falls back to the best five). */
export function pickFive(pool: Player[], ids: string[]): Player[] | null {
  const chosen = ids.map(id => pool.find(p => p.id === id)).filter((p): p is Player => !!p);
  if (chosen.length !== 5) return null;
  for (const role of ['duelist', 'initiator', 'controller', 'sentinel'] as const) {
    if (chosen.filter(p => p.role === role).length !== ROLE_NEED[role]) return null;
  }
  return withIgl(chosen);
}

/** Assemble each nation's best VALID five from every player of that nationality across
 *  the whole world. A nation that can't field a full comp (a role with nobody) doesn't
 *  enter — like a country that can't qualify. Sorted strongest-first, ties by code so
 *  it's deterministic. */
export function nationalSquads(w: WorldState): NationSquad[] {
  const squads: NationSquad[] = [];
  for (const players of nationPools(w).values()) {
    const five = bestFive(players);
    if (!five) continue;
    const nat = personOf(players[0].id).nation;
    squads.push({ country: nat.country, flag: nat.flag, code: nat.code, five, strength: fiveStrength(five), pool: players.length });
  }
  return squads.sort((a, b) => b.strength - a.strength || a.code.localeCompare(b.code));
}

/** A national squad as an engine team (its five, tagged by country code). */
export const nationalTeam = (s: NationSquad): Team => ({ id: `NT-${s.code}`, tag: s.code, name: s.country, players: s.five });

export interface WorldCupMatch { round: number; a: NationSquad; b: NationSquad; winner: NationSquad; seed: number }
export interface GroupRow { squad: NationSquad; w: number; l: number; rf: number; ra: number; pts: number }
export interface WorldCupGroup {
  name: string;                                                  // 'A'..'D'
  rows: GroupRow[];                                              // standings, ranked (top 2 advance)
  matches: { a: NationSquad; b: NationSquad; sa: number; sb: number; seed: number }[];
}
export interface WorldCupResult {
  seed: number;
  field: NationSquad[];          // the qualified nations
  groups: WorldCupGroup[];       // the group stage (empty on a tiny field)
  matches: WorldCupMatch[];      // the knockout, round by round
  champion: NationSquad;
  placement: NationSquad[];      // knockout finish order (champion first)
}

/** Classic single-elim seeding (1 plays n, 2 plays n-1, …) so the top seeds spread. */
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

/** Win probability for `a` over `b` from their squad-OVR gap — calibrated so a few OVR is
 *  a real edge but upsets still happen (a ~5-OVR gap ≈ 70%), unlike a club's 0..1 strength. */
const winProb = (a: NationSquad, b: NationSquad) => 1 / (1 + Math.exp(-(a.strength - b.strength) * 0.18));
/** A knockout game → the winner (deterministic from the seed). */
function play(a: NationSquad, b: NationSquad, seed: number): NationSquad {
  return new Rng(seed >>> 0).next() < winProb(a, b) ? a : b;
}
/** A group game → a plausible 13–N scoreline (so the table has real tiebreakers). */
function groupGame(a: NationSquad, b: NationSquad, seed: number): { aWin: boolean; sa: number; sb: number } {
  const rng = new Rng(seed >>> 0);
  const aWin = rng.next() < winProb(a, b);
  const loser = Math.max(3, Math.min(11, Math.round(11 - Math.abs(a.strength - b.strength) * 0.45 + rng.range(-2, 3))));
  return aWin ? { aWin, sa: 13, sb: loser } : { aWin, sa: loser, sb: 13 };
}
/** A seeded Fisher–Yates shuffle — deterministic from `seed`. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const rng = new Rng(seed >>> 0), a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Resolve a seeded knockout bracket from a fixed `alive` order. */
function resolveKnockout(field: NationSquad[], start: NationSquad[], seed: number, groups: WorldCupGroup[]): WorldCupResult {
  const matches: WorldCupMatch[] = [];
  const eliminatedRound = new Map<NationSquad, number>();
  let alive = start, round = 0;
  while (alive.length > 1) {
    const next: NationSquad[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i], b = alive[i + 1];
      const s = fixtureSeed(seed, round, i);
      const winner = play(a, b, s);
      matches.push({ round, a, b, winner, seed: s });
      eliminatedRound.set(winner === a ? b : a, round);
      next.push(winner);
    }
    alive = next; round++;
  }
  const champion = alive[0];
  eliminatedRound.set(champion, round);
  const placement = [...start].sort((a, b) => (eliminatedRound.get(b) ?? -1) - (eliminatedRound.get(a) ?? -1) || b.strength - a.strength);
  return { seed, field, groups, matches, champion, placement };
}

/** Run the World Cup: the top nations qualify, are DRAWN into groups of four (four pots by
 *  seed band, each shuffled, one per group — a balanced but not pre-ordained draw), play a
 *  round-robin, and the top two of each group advance to a single-elim knockout, cross-
 *  bracketed so a group's two qualifiers can only meet again in the FINAL (FIFA-style).
 *  Falls back to a straight seeded bracket if too few nations qualify for groups. Every game
 *  seed is a stable hash → reproducible; the server overrides the final with a real engine
 *  sim (the watchable verdict). */
export function worldCup(squads: NationSquad[], opts: { seed: number }): WorldCupResult {
  const G = squads.length >= 16 ? 4 : squads.length >= 8 ? 2 : 0;   // groups of four we can fill
  if (G === 0) {   // tiny field → a straight seeded single-elim
    const N = 1 << Math.floor(Math.log2(Math.max(2, squads.length)));
    const field = squads.slice(0, N);
    return resolveKnockout(field, bracketOrder(N).map(s => field[s - 1]), opts.seed, []);
  }
  const field = squads.slice(0, G * 4);
  // the draw: four pots by seed band, each shuffled, one team per pot into each group
  const pots = [0, 1, 2, 3].map(p => shuffle(field.slice(p * G, p * G + G), fixtureSeed(opts.seed, 90 + p, 0)));
  const groups: WorldCupGroup[] = [];
  for (let g = 0; g < G; g++) {
    const teams = pots.map(pot => pot[g]);
    const rows: GroupRow[] = teams.map(squad => ({ squad, w: 0, l: 0, rf: 0, ra: 0, pts: 0 }));
    const rowOf = (s: NationSquad) => rows.find(r => r.squad === s)!;
    const matches: WorldCupGroup['matches'] = [];
    let mi = 0;
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i], b = teams[j], seed = fixtureSeed(opts.seed, 100 + g, mi++);
      const r = groupGame(a, b, seed);
      matches.push({ a, b, sa: r.sa, sb: r.sb, seed });
      const ra = rowOf(a), rb = rowOf(b);
      ra.rf += r.sa; ra.ra += r.sb; rb.rf += r.sb; rb.ra += r.sa;
      if (r.aWin) { ra.w++; ra.pts += 3; rb.l++; } else { rb.w++; rb.pts += 3; ra.l++; }
    }
    rows.sort((x, y) => y.pts - x.pts || (y.rf - y.ra) - (x.rf - x.ra) || y.rf - x.rf || y.squad.strength - x.squad.strength);
    groups.push({ name: String.fromCharCode(65 + g), rows, matches });
  }
  // the knockout draw: group winners + runners-up, cross-bracketed (FIFA-style)
  const W = groups.map(gr => gr.rows[0].squad), R = groups.map(gr => gr.rows[1].squad);
  const alive: NationSquad[] = G === 4
    ? [W[0], R[1], W[2], R[3], W[1], R[0], W[3], R[2]]
    : [W[0], R[1], W[1], R[0]];
  return resolveKnockout(field, alive, opts.seed, groups);
}
