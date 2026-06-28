// Sponsorships — a commercial layer with its own objectives (DESIGN §8). Each off-season a
// club is offered a few multi-season deals; you pick ONE, weighing a guaranteed base cheque
// against a performance bonus tied to a goal (hit your board objective, finish top half, win
// promotion, or rack up N wins). A big-bonus deal on a hard goal is a gamble; a base-heavy
// one is safe income. Bigger/stronger clubs attract bigger sponsors. Pure + deterministic
// (a seeded offer board, own rng), engine-invisible — the match never sees a sponsor.
import { Rng } from '@ace/engine';

export type SponsorGoal = 'objective' | 'tophalf' | 'promote' | 'winN';
export interface SponsorOffer {
  id: string; name: string; base: number; bonus: number; goal: SponsorGoal; goalN: number; years: number;
}
export interface ActiveSponsor extends SponsorOffer { yearsLeft: number }

const BRANDS = ['Volt', 'Apex', 'Nexus', 'Hyper', 'Titan', 'Pulse', 'Surge', 'Vortex', 'Quantum', 'Razor', 'Forge', 'Echo', 'Strike', 'Orbit', 'Flux', 'Onyx', 'Cobra', 'Helix', 'Drift', 'Nova'];
const SUFFIX = ['Energy', 'Tech', 'Gaming', 'Labs', 'Mobile', 'Cola', 'Esports', 'Wear', 'Bank', 'Gear'];

const GOAL_TEXT: Record<SponsorGoal, (n: number) => string> = {
  objective: () => 'hit the board objective',
  tophalf: () => 'finish in the top half',
  promote: () => 'win promotion',
  winN: (n) => `win ${n}+ matches`,
};
export const sponsorGoalText = (o: { goal: SponsorGoal; goalN: number }) => GOAL_TEXT[o.goal](o.goalN);

/** Three offers this off-season — a safe (base-heavy), a balanced, and an aggressive
 *  (bonus-heavy on a harder goal). Scaled by club strength (bigger clubs draw bigger
 *  sponsors). Deterministic per (seed, season, club), drawn on its own rng. */
export function sponsorOffers(seed: number, season: number, strength: number, clubIdx: number): SponsorOffer[] {
  const rng = new Rng((seed ^ (season * 0x9e3779b9) ^ (clubIdx * 0x85ebca6b) ^ 0x590) >>> 0);
  const mult = 0.7 + strength * 1.6;                 // ~0.7 (weak) .. ~2.3 (elite)
  const brand = () => `${BRANDS[rng.int(0, BRANDS.length - 1)]} ${SUFFIX[rng.int(0, SUFFIX.length - 1)]}`;
  const k = (v: number) => Math.round(v * mult / 100) * 100;
  const profiles: { base: number; bonus: number; goal: SponsorGoal; goalN: number; years: number }[] = [
    { base: 5200, bonus: 1500, goal: 'winN', goalN: 9, years: 3 },     // safe — base-heavy, an easy goal
    { base: 3800, bonus: 3600, goal: 'tophalf', goalN: 0, years: 2 },  // balanced
    { base: 2400, bonus: 6200, goal: 'promote', goalN: 0, years: 2 },  // aggressive — big bonus, hard goal
  ];
  return profiles.map((p, i) => ({
    id: `spon-${season}-${clubIdx}-${i}`, name: brand(),
    base: k(p.base), bonus: k(p.bonus), goal: p.goal, goalN: p.goalN, years: p.years,
  }));
}

/** Was the sponsor's performance goal met this season? */
export function sponsorGoalMet(goal: SponsorGoal, goalN: number, ctx: { objMet: boolean; finish: number; divSize: number; promo: number; wins: number }): boolean {
  switch (goal) {
    case 'objective': return ctx.objMet;
    case 'tophalf': return ctx.finish > 0 && ctx.finish <= Math.floor(ctx.divSize / 2);
    case 'promote': return ctx.finish > 0 && ctx.finish <= ctx.promo;
    case 'winN': return ctx.wins >= goalN;
  }
}
