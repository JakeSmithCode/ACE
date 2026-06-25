// Facilities — the team HQ, built room by room (DESIGN §8). Each room is a money
// sink that raises a development ceiling: out-invest your environment and you
// out-develop everyone. Pure: a facility set maps to the dev multipliers
// (`DevBoost`) the store threads into YOUR roster's development. AI clubs run the
// no-op default, so they're unchanged.
import type { DevBoost } from './develop.js';
import { NO_BOOST } from './develop.js';

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

/** Recurring per-season upkeep of a built HQ — staff, rent, kit. So facilities
 *  aren't a one-time buy but an ongoing commitment: over-build past what your
 *  income supports and the upkeep bleeds you. ~$9k/season at a fully-maxed HQ. */
export const facilityUpkeep = (f: Facilities): number => (f.bootcamp + f.recovery + f.analyst) * 600;

/** The combined development boost from a club's facilities (a no-op at all-zero). */
export function facilityBoost(f: Facilities): DevBoost {
  return {
    growth: 1 + f.bootcamp * 0.12,
    decline: Math.max(0.4, 1 - f.recovery * 0.09),
    ceiling: f.analyst * 0.12,
    rust: Math.max(0.3, 1 - f.analyst * 0.13),
  };
}

// --- AI club infrastructure: the rival side of the youth/HQ axis -------------
// You build your HQ room by room; an AI club's development infrastructure is a
// single level derived from how big/rich the org is. It compounds into dynasties:
// a strong club develops + retains talent better → stays strong → keeps investing.
export const INFRA_MAX = FACILITY_MAX;

/** An AI club's infrastructure level (0..INFRA_MAX) from its strength — bigger,
 *  better-run orgs field better facilities (and academies). A pure function (no
 *  stored state), so a club that climbs the pyramid naturally develops better. */
export const clubInfra = (strength: number): number =>
  Math.max(0, Math.min(INFRA_MAX, Math.round((strength - 0.4) / 0.5 * INFRA_MAX)));

/** The development boost an AI club gets from its infrastructure — one dial
 *  blending all three rooms, so well-resourced clubs grow and age better. Level 0
 *  is exactly `NO_BOOST`, so an unfunded club develops as before (byte-identical). */
export function infraBoost(level: number): DevBoost {
  if (level <= 0) return NO_BOOST;
  const f = level / INFRA_MAX;
  return { growth: 1 + f * 0.5, decline: 1 - f * 0.35, ceiling: f * 0.4, rust: 1 - f * 0.5 };
}
