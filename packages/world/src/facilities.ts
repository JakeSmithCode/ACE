// Facilities — the team HQ, built room by room (DESIGN §8). Each room is a money
// sink that raises a development ceiling: out-invest your environment and you
// out-develop everyone. Pure: a facility set maps to the dev multipliers
// (`DevBoost`) the store threads into YOUR roster's development. AI clubs run the
// no-op default, so they're unchanged.
import type { DevBoost } from './develop.js';

export type FacilityId = 'bootcamp' | 'recovery' | 'analyst';
export type Facilities = Record<FacilityId, number>;   // level 0..FACILITY_MAX
export const FACILITY_MAX = 5;

export interface FacilityDef { id: FacilityId; name: string; blurb: string; effect: (lvl: number) => string }
export const FACILITIES: FacilityDef[] = [
  { id: 'bootcamp', name: 'Bootcamp', blurb: 'Practice space — your players grow toward their potential faster.', effect: l => `+${Math.round(l * 12)}% development speed` },
  { id: 'recovery', name: 'Recovery Center', blurb: 'Sports science — slows the age decline of your veterans.', effect: l => `−${Math.round(l * 9)}% decline` },
  { id: 'analyst', name: 'Analyst Room', blurb: 'VOD review — prospects realize more of their ceiling; reserves rust less.', effect: l => `ceiling ↑ · −${Math.round(l * 13)}% bench rust` },
];

export const defaultFacilities = (): Facilities => ({ bootcamp: 0, recovery: 0, analyst: 0 });

/** Cost to upgrade a room from `level` to `level+1` — steepens, so maxing the HQ
 *  (~$100k) is a real multi-season investment competing with the transfer market. */
export const facilityCost = (level: number): number => 6000 + level * 7000;   // 6/13/20/27/34k

/** The combined development boost from a club's facilities (a no-op at all-zero). */
export function facilityBoost(f: Facilities): DevBoost {
  return {
    growth: 1 + f.bootcamp * 0.12,
    decline: Math.max(0.4, 1 - f.recovery * 0.09),
    ceiling: f.analyst * 0.12,
    rust: Math.max(0.3, 1 - f.analyst * 0.13),
  };
}
