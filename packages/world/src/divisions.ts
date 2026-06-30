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

/** The club indices in a single `(tier, group)` division (the fan-out unit at
 *  scale — docs/PHASE2.md §3). A tier with one group reduces to `membersOf`. */
export const membersOfDiv = (tiers: number[], groups: number[], tier: number, group: number): number[] =>
  tiers.map((t, i) => [t, i] as const).filter(([t, i]) => t === tier && groups[i] === group).map(([, i]) => i);

/** Snake (serpentine) seeding: spread a strength-ordered list across `g` groups so
 *  each group gets a balanced cut (0,1,2,2,1,0,0,1,…). `g <= 1` → everything in
 *  group 0 (the flat world). Deterministic — the funnel + generation both use it. */
export const snakeGroup = (j: number, g: number): number => {
  if (g <= 1) return 0;
  const cycle = j % (2 * g);
  return cycle < g ? cycle : 2 * g - 1 - cycle;
};

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
 *  a season-end summary).
 *
 *  Optionally, a **promotion playoff** contests more spots: `playoff(boundary, upper,
 *  lower)` (injected so the caller resolves the actual matches) returns the clubs that
 *  end `up` (in the upper tier) and `down` (in the lower) at that boundary — additional
 *  swaps layered on top of the auto k. Each boundary's playoff is net-zero for tier
 *  populations, so sizes stay conserved. Omitting `playoff` is byte-identical to the
 *  plain swap (the world/season CLIs are unchanged). */
export function promoteRelegate(
  division: number[], tables: Standing[][], k: number,
  playoff?: (boundary: number, upper: Standing[], lower: Standing[]) => { up: number[]; down: number[] } | null,
): { division: number[]; moves: DivMove[] } {
  const next = [...division];
  const moves: DivMove[] = [];
  for (let d = 0; d < tables.length - 1; d++) {
    const promoted = tables[d + 1].slice(0, k).map(s => s.club);    // top k below → up
    const relegated = tables[d].slice(-k).map(s => s.club);         // bottom k here → down
    for (const c of promoted) { next[c] = d; moves.push({ club: c, from: d + 1, to: d }); }
    for (const c of relegated) { next[c] = d + 1; moves.push({ club: c, from: d, to: d + 1 }); }
    // contested spots: a promotion playoff can move additional clubs across this boundary.
    // A challenger (originally in d+1) that wins goes up; a defender (originally in d) that
    // loses goes down — emit a move only when the club's tier actually changes.
    const pp = playoff?.(d, tables[d], tables[d + 1]);
    if (pp) {
      for (const c of pp.up) if (division[c] === d + 1) { next[c] = d; moves.push({ club: c, from: d + 1, to: d }); }
      for (const c of pp.down) if (division[c] === d) { next[c] = d + 1; moves.push({ club: c, from: d, to: d + 1 }); }
    }
  }
  return { division: next, moves };
}

/** The funnel (docs/PHASE2.md §3): promotion/relegation across a *pyramid* where a
 *  tier is many parallel `(tier, group)` divisions, fewer the higher you go. Per
 *  boundary t↔t+1: the bottom `k` of **each** group in tier t relegate (`k·G_t`
 *  clubs); exactly that many promote up from the wider tier below — the best
 *  performers across its groups (group winners first, ties by strength) — so each
 *  tier's population is **conserved** and the promotion rate per lower group is the
 *  funnel (fewer go up than the groups would send, because the tier above is
 *  narrower). Then every tier is **regrouped** — its members snake-seeded across its
 *  groups by strength — so groups stay full and balanced. Reduces EXACTLY to
 *  `promoteRelegate` when every tier has one group (the flat world is byte-identical).
 *  `tableOf(tier, group)` is that division's final standings; pure + deterministic. */
export function funnelPromoteRelegate(opts: {
  tiers: number[]; groups: number[]; layout: number[]; k: number;
  tableOf: (tier: number, group: number) => Standing[];
  strengthOf: (club: number) => number;
}): { tiers: number[]; groups: number[]; moves: DivMove[] } {
  const { tiers, groups, layout, k, tableOf, strengthOf } = opts;
  const nextTier = [...tiers];
  const nextGroup = [...groups];
  const moves: DivMove[] = [];
  for (let t = 0; t < layout.length - 1; t++) {
    const relegated: number[] = [];
    for (let g = 0; g < layout[t]; g++) relegated.push(...tableOf(t, g).slice(-k).map(s => s.club));
    // the promotion pool below, ordered by finishing position then strength → group
    // winners first; take exactly as many as relegated to conserve tier t's size
    const pool: { club: number; pos: number }[] = [];
    for (let g = 0; g < layout[t + 1]; g++) tableOf(t + 1, g).forEach((s, pos) => pool.push({ club: s.club, pos }));
    pool.sort((a, b) => a.pos - b.pos || strengthOf(b.club) - strengthOf(a.club) || a.club - b.club);
    const promoted = pool.slice(0, relegated.length).map(x => x.club);
    for (const c of promoted) { nextTier[c] = t; moves.push({ club: c, from: t + 1, to: t }); }
    for (const c of relegated) { nextTier[c] = t + 1; moves.push({ club: c, from: t, to: t + 1 }); }
  }
  // regroup each tier: snake-seed its members across its groups by strength
  for (let t = 0; t < layout.length; t++) {
    const members = nextTier.map((tt, i) => [tt, i] as const).filter(([tt]) => tt === t).map(([, i]) => i)
      .sort((a, b) => strengthOf(b) - strengthOf(a) || a - b);
    members.forEach((club, j) => { nextGroup[club] = snakeGroup(j, layout[t]); });
  }
  return { tiers: nextTier, groups: nextGroup, moves };
}
