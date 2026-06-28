// Backroom STAFF — a personnel layer over the HQ rooms (DESIGN §8). Where facilities are
// bricks you upgrade, staff are PEOPLE you hire from a shortlist, each on a recurring wage,
// and each boosts a DISTINCT system so the three are real, different bets:
//   • Head Coach        → development pace (your squad grows toward potential faster)
//   • Performance Analyst → scouting (cheaper reports) + the ceiling cloud biased up
//   • Sports Psychologist → fitness (slower fatigue, fewer injuries) + squad morale
// Pure + deterministic (a seeded shortlist, no rng beyond generation); it folds into the
// existing DevBoost / scouting / fitness levers, so the match engine never sees it and the
// world/season CLIs (which hire nobody) stay byte-identical.
import { Rng } from '@ace/engine';
import type { DevBoost } from './develop.js';
import { NO_BOOST } from './develop.js';

export type StaffRole = 'coach' | 'analyst' | 'psych';
export interface StaffMember { id: string; name: string; role: StaffRole; rating: number; wage: number }
export type StaffHires = Partial<Record<StaffRole, StaffMember>>;

export const STAFF_ROLES: StaffRole[] = ['coach', 'analyst', 'psych'];
export const STAFF_META: Record<StaffRole, { title: string; blurb: string }> = {
  coach:   { title: 'Head Coach', blurb: 'faster development toward potential' },
  analyst: { title: 'Performance Analyst', blurb: 'cheaper scouting + ceiling upside' },
  psych:   { title: 'Sports Psychologist', blurb: 'slower fatigue, fewer injuries, morale' },
};

const FIRST = ['Marek', 'Tomas', 'Aleksandr', 'Dae-hyun', 'Lucas', 'Mateus', 'Niko', 'Erik', 'Hiroshi', 'Owen', 'Diego', 'Felix', 'Sven', 'Kai', 'Ravi', 'Anders', 'Pablo', 'Yuki', 'Liam', 'Bohdan'];
const LAST = ['Novak', 'Berg', 'Costa', 'Park', 'Vasquez', 'Lindqvist', 'Mori', 'Kovac', 'Schmidt', 'Reyes', 'Volkov', 'Tan', 'Halls', 'Adeyemi', 'Rossi', 'Dubois', 'Nilsen', 'Walsh', 'Ferreira', 'Singh'];

/** A staff member's wage scales with their rating (1..5 ⭐) — a 5⭐ coach is a real line on
 *  the books, competing with transfers + facility upkeep. */
export const staffWage = (rating: number) => 2000 + rating * 2600;

/** The hireable shortlist this season — a few candidates per role, ratings spread, drawn on
 *  its OWN seed so it never perturbs the world stream. Deterministic per (seed, season). */
export function staffMarket(seed: number, season: number): Record<StaffRole, StaffMember[]> {
  const rng = new Rng((seed ^ (season * 0x5bd1e995) ^ 0x57aff) >>> 0);
  const out = {} as Record<StaffRole, StaffMember[]>;
  for (const role of STAFF_ROLES) {
    const list: StaffMember[] = [];
    for (let i = 0; i < 3; i++) {
      const rating = Math.max(1, Math.min(5, Math.round(rng.range(1.5, 5.4))));
      const name = `${FIRST[rng.int(0, FIRST.length - 1)]} ${LAST[rng.int(0, LAST.length - 1)]}`;
      list.push({ id: `staff-${role}-${season}-${i}`, name, role, rating, wage: staffWage(rating) });
    }
    out[role] = list.sort((a, b) => b.rating - a.rating);
  }
  return out;
}

/** The effects of the hired staff, folded into the systems they touch. All neutral when a
 *  slot is empty, so an un-staffed club behaves exactly as before. */
export interface StaffEffect {
  growth: number;     // ×DevBoost.growth (coach)
  ceiling: number;    // +DevBoost.ceiling (analyst)
  scoutDiscount: number;  // 0..~0.5 fraction off scout cost (analyst)
  fatigueMul: number; // ×fatigue gain (psych, <1 = slower)
  injuryMul: number;  // ×injury chance (psych, <1 = fewer)
  morale: number;     // +morale drift per match-day (psych)
}
export const NO_STAFF: StaffEffect = { growth: 1, ceiling: 0, scoutDiscount: 0, fatigueMul: 1, injuryMul: 1, morale: 0 };

export function staffEffect(hires: StaffHires): StaffEffect {
  const c = hires.coach?.rating ?? 0, a = hires.analyst?.rating ?? 0, p = hires.psych?.rating ?? 0;
  return {
    growth: 1 + c * 0.05,            // 5⭐ coach → +25% growth
    ceiling: a * 0.4,                // 5⭐ analyst → +2.0 ceiling bias
    scoutDiscount: a * 0.09,         // 5⭐ analyst → ~45% off scout reports
    fatigueMul: 1 - p * 0.06,        // 5⭐ psych → −30% fatigue gain
    injuryMul: 1 - p * 0.10,         // 5⭐ psych → −50% injury chance
    morale: p * 0.6,                 // 5⭐ psych → +3 morale/match-day
  };
}

/** Merge a coach's growth + an analyst's ceiling into an existing DevBoost (the facility
 *  boost), so staff and facilities STACK. */
export function withStaffBoost(boost: DevBoost, eff: StaffEffect): DevBoost {
  return { growth: boost.growth * eff.growth, decline: boost.decline, ceiling: boost.ceiling + eff.ceiling, rust: boost.rust };
}

/** Total staff wage bill for the season. */
export const staffWageBill = (hires: StaffHires): number =>
  STAFF_ROLES.reduce((s, r) => s + (hires[r]?.wage ?? 0), 0);

export { NO_BOOST };
