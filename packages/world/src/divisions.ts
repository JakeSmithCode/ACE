// Two-tier league structure — clubs split into divisions, each running its own
// double round-robin season, with promotion/relegation swapping the bottom of a
// higher tier for the top of the one below at season's end. Pure and
// deterministic; the store orchestrates the actual match sims.
import type { Matchday } from './schedule.js';
import { doubleRoundRobin } from './schedule.js';
import type { Standing } from './season.js';

/** The club indices that belong to division `d` (in club-index order). */
export const membersOf = (division: number[], d: number): number[] =>
  division.map((dv, i) => [dv, i] as const).filter(([dv]) => dv === d).map(([, i]) => i);

/** A division's double round-robin over its member club indices: the circle
 *  method runs over 0..m-1, then each slot is mapped to the real club index. */
export function divisionSchedule(members: number[]): Matchday[] {
  return doubleRoundRobin(members.length).map(day =>
    day.map(f => ({ home: members[f.home], away: members[f.away] })));
}

export interface DivMove { club: number; from: number; to: number }

/** Apply promotion/relegation: the bottom `k` of each higher division swap with
 *  the top `k` of the division below. `tables[d]` is division d's final
 *  standings (best-first). Returns the new division map and the moves made (for
 *  a season-end summary). */
export function promoteRelegate(division: number[], tables: Standing[][], k: number): { division: number[]; moves: DivMove[] } {
  const next = [...division];
  const moves: DivMove[] = [];
  for (let d = 0; d < tables.length - 1; d++) {
    const promoted = tables[d + 1].slice(0, k).map(s => s.club);    // top k below → up
    const relegated = tables[d].slice(-k).map(s => s.club);         // bottom k here → down
    for (const c of promoted) { next[c] = d; moves.push({ club: c, from: d + 1, to: d }); }
    for (const c of relegated) { next[c] = d + 1; moves.push({ club: c, from: d, to: d + 1 }); }
  }
  return { division: next, moves };
}
