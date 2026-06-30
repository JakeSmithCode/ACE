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

// The tournament STRUCTURE — the draw + fixtures + ranking + seeding. The RESULTS are the
// engine's: the server full-sims every game (so your authored plan drives the whole run and
// every game is watchable). @ace/world stays pure (no engine); these are the deterministic
// brackets the server resolves.
export interface WCFixture { a: NationSquad; b: NationSquad; seed: number }
export interface WCGroupDraw { name: string; teams: NationSquad[]; fixtures: WCFixture[] }
export interface WorldCupDraw { field: NationSquad[]; groups: WCGroupDraw[]; bracketSeeds: NationSquad[] }
export interface GroupRow { squad: NationSquad; w: number; l: number; rf: number; ra: number; pts: number }

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
/** A seeded Fisher–Yates shuffle — deterministic from `seed`. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const rng = new Rng(seed >>> 0), a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Rank a group's table: points → round-diff → rounds-for → squad strength (deterministic). */
export function rankGroup(rows: GroupRow[]): GroupRow[] {
  return [...rows].sort((x, y) => y.pts - x.pts || (y.rf - y.ra) - (x.rf - x.ra) || y.rf - x.rf || y.squad.strength - x.squad.strength);
}

/** The knockout entry order from group winners + runners-up — cross-bracketed FIFA-style so a
 *  group's two qualifiers can only meet again in the FINAL (1A v 2B, 1C v 2D, 1B v 2A, …). */
export function knockoutSeeding(winners: NationSquad[], runners: NationSquad[]): NationSquad[] {
  const G = winners.length;
  if (G === 4) return [winners[0], runners[1], winners[2], runners[3], winners[1], runners[0], winners[3], runners[2]];
  return [winners[0], runners[1], winners[1], runners[0]];   // 2 groups → 4 teams
}

/** The World Cup DRAW: the top nations qualify and are drawn into groups of four (four pots by
 *  seed band, each shuffled, one team per group — balanced but not pre-ordained), each group's
 *  round-robin fixtures stamped with stable seeds. Falls back to a straight seeded bracket
 *  (`bracketSeeds`, no groups) when too few nations qualify. Pure + deterministic. */
export function worldCupDraw(squads: NationSquad[], seed: number): WorldCupDraw {
  const G = squads.length >= 16 ? 4 : squads.length >= 8 ? 2 : 0;   // groups of four we can fill
  if (G === 0) {
    const N = 1 << Math.floor(Math.log2(Math.max(2, squads.length)));
    const field = squads.slice(0, N);
    return { field, groups: [], bracketSeeds: bracketOrder(N).map(s => field[s - 1]) };
  }
  const field = squads.slice(0, G * 4);
  const pots = [0, 1, 2, 3].map(p => shuffle(field.slice(p * G, p * G + G), fixtureSeed(seed, 90 + p, 0)));
  const groups: WCGroupDraw[] = [];
  for (let g = 0; g < G; g++) {
    const teams = pots.map(pot => pot[g]);
    const fixtures: WCFixture[] = [];
    let mi = 0;
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++)
      fixtures.push({ a: teams[i], b: teams[j], seed: fixtureSeed(seed, 100 + g, mi++) });
    groups.push({ name: String.fromCharCode(65 + g), teams, fixtures });
  }
  return { field, groups, bracketSeeds: [] };
}
