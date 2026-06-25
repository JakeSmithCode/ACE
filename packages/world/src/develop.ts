// The development tick — how a squad changes between seasons. Pure and
// deterministic (one Rng, fixed order), like everything in @ace/world, so the
// single-player off-season and the future server worker compute the same growth.
//
// The esports aging curve (DESIGN §4.4): teens grow fast toward their potential;
// the early-20s are the peak; mechanical skill (aim/movement/entry) fades first
// and fastest in the mid-20s, while cerebral skill (gameSense/utility/clutch)
// develops later and lingers — the veteran-IQ effect. Bounded and *fair*: a bust
// is a draw you took, never the dice mugging you (DESIGN §2/§18).
import { Rng } from '@ace/engine';
import type { Player, Attributes, Team } from '@ace/shared';
import type { Club } from './clubs.js';

const ATTRS: (keyof Attributes)[] = ['aim', 'movement', 'gameSense', 'utility', 'clutch', 'entry'];
const MECH = new Set<keyof Attributes>(['aim', 'movement', 'entry']);
// ability is continuous (fractional) so a season of small daily steps accumulates
// instead of rounding to nothing each match-day; the UI rounds for display.
const clamp = (v: number) => Math.max(25, Math.min(99, v));

/** Fraction of the gap-to-potential a player closes in one season — steep when
 *  young, near-flat once developed. */
function learnRate(age: number): number {
  if (age <= 17) return 0.32;
  if (age <= 19) return 0.24;
  if (age <= 21) return 0.15;
  if (age <= 23) return 0.08;
  return 0.03;
}
/** Points lost per season past peak; mechanical attributes start earlier and
 *  decline faster, and the slide accelerates with age. */
function declineRate(age: number, mech: boolean): number {
  const start = mech ? 25 : 27;
  if (age < start) return 0;
  return (mech ? 1.3 : 0.8) * (1 + (age - start) * 0.4);
}

export const overall = (p: { attr: Attributes }): number =>
  Math.round(ATTRS.reduce((s, k) => s + p.attr[k], 0) / ATTRS.length);
export const potentialOverall = (p: Player): number =>
  Math.round(ATTRS.reduce((s, k) => s + (p.potential?.[k] ?? p.attr[k]), 0) / ATTRS.length);
export const squadRating = (team: Team): number =>
  Math.round(team.players.reduce((s, p) => s + overall(p), 0) / team.players.length);

// A player's SOLO-QUEUE rank — their raw individual skill on the VALORANT ladder,
// a different axis from their club's division (a Radiant player can be stuck on a
// Gold club: the gem to scout). Derived from current `overall`, 8-point bands.
const RANK_BANDS: { min: number; tier: string }[] = [
  { min: 96, tier: 'Radiant' }, { min: 88, tier: 'Immortal' }, { min: 80, tier: 'Ascendant' },
  { min: 72, tier: 'Diamond' }, { min: 64, tier: 'Platinum' }, { min: 56, tier: 'Gold' },
  { min: 48, tier: 'Silver' }, { min: 40, tier: 'Bronze' }, { min: 0, tier: 'Iron' },
];
/** A solo-queue rank from an overall rating: `{ tier, sub, label }` — Radiant has
 *  no sub-division, the rest split their 8-point band into 3 (e.g. "Immortal 2"). */
export function soloRank(ovr: number): { tier: string; sub: number; label: string } {
  const band = RANK_BANDS.find(b => ovr >= b.min)!;
  if (band.tier === 'Radiant') return { tier: 'Radiant', sub: 0, label: 'Radiant' };
  const sub = Math.max(1, Math.min(3, Math.floor((ovr - band.min) / 8 * 3) + 1));
  return { tier: band.tier, sub, label: `${band.tier} ${sub}` };
}
export const rankOfPlayer = (p: { attr: Attributes }) => soloRank(overall(p));

/** A player's career phase, from the aging curve — for legible UI, not mechanics. */
export function phaseOf(p: Player): 'rising' | 'peak' | 'declining' {
  if (p.age <= 21 && potentialOverall(p) - overall(p) >= 2) return 'rising';
  if (p.age >= 26) return 'declining';
  return 'peak';
}

// development is now CONTINUOUS: this fraction of the annual curve is realized
// DURING the season (reps, match by match); the rest is the off-season bootcamp.
// A full-time starter still realizes ~one annual step a year (pace preserved) —
// but a benched player gets far less (and rusts), so playing time is a real lever.
export const SEASON_SHARE = 0.6;

/** One development step: grow toward potential + decline past peak, for `frac` of
 *  the annual curve, scaled by reps (`repMul`). Shared by the in-season and
 *  off-season ticks so they can never drift. */
function curveStep(p: Player, frac: number, repMul: number, rng: Rng): Attributes {
  const lr = learnRate(p.age);
  const attr = { ...p.attr };
  for (const k of ATTRS) {
    const ceil = p.potential?.[k] ?? attr[k];
    const grow = Math.max(0, ceil - attr[k]) * lr * frac * repMul * rng.range(0.55, 1.25);
    const dec = declineRate(p.age, MECH.has(k)) * frac * rng.range(0.6, 1.25);
    attr[k] = clamp(attr[k] + grow - dec);
  }
  return attr;
}

const CEIL_SPREAD = 14;      // points of ceiling a fully-plastic player's cloud spans
const CEIL_NARROW = 0.985;   // plasticity shrink per development slice (~×0.76 a season in-season)

/** Resolve a slice of a young player's **potential cloud** (DESIGN §4): reps drift
 *  the ceiling up (played) or down (benched/idle), with a shared luck draw so the
 *  prospect booms or busts coherently, then narrow the remaining plasticity toward
 *  0 — where the ceiling locks. Bounded (plasticity shrinks geometrically, so the
 *  cumulative drift converges): a bust is a bet you took, never a mugging (§2/§18).
 *  Old players (`potVar ≈ 0`) are untouched — the gamble lives in youth. */
function resolveCeiling(p: Player, played: boolean, rng: Rng): Player {
  const v = p.potVar ?? 0;
  if (v < 0.02 || !p.potential) return p.potVar ? { ...p, potVar: 0 } : p;
  const bias = played ? 0.5 : -0.7;                 // playing realizes upside; idling busts
  const luck = rng.range(-0.6, 0.6);                // this slice's overall fortune (shared across attrs)
  const potential = { ...p.potential };
  for (const k of ATTRS) {
    const drift = v * CEIL_SPREAD * (bias + luck + rng.range(-0.3, 0.3)) * 0.06;
    potential[k] = Math.max(p.attr[k], Math.min(99, potential[k] + drift));
  }
  return { ...p, potential, potVar: v * CEIL_NARROW };
}

/** In-season micro-development for one match-day. A starter gets reps → grows
 *  toward potential and ages a touch; a benched player grows far less AND loses
 *  mechanical sharpness (bench rust) — so who you play shapes who develops. The
 *  ceiling cloud also resolves a slice (reps drift it, then narrow). Age is
 *  unchanged in-season (the curve bracket only shifts at the off-season). */
export function developInSeason(p: Player, played: boolean, games: number, rng: Rng): Player {
  const g = resolveCeiling(p, played, rng);
  const attr = curveStep(g, SEASON_SHARE / Math.max(1, games), played ? 1 : 0.3, rng);
  if (!played) for (const k of ATTRS) if (MECH.has(k)) attr[k] = clamp(attr[k] - rng.range(0.1, 0.28));  // bench rust
  return { ...g, attr };
}

/** Off-season step: age +1 and the bootcamp share of the annual curve (full reps,
 *  rest + camp), plus a bootcamp slice of ceiling resolution. `frac` defaults to
 *  the WHOLE annual step. */
export function developPlayer(p: Player, rng: Rng, frac = 1): Player {
  const g = resolveCeiling(p, true, rng);   // bootcamp reps resolve a ceiling slice
  return { ...g, age: g.age + 1, attr: curveStep(g, frac, 1, rng) };
}

export const developSquad = (team: Team, rng: Rng): Team =>
  ({ ...team, players: team.players.map(p => developPlayer(p, rng)) });

/** Run the off-season across the whole league. Fixed club/player order keeps it
 *  deterministic; club strength is refreshed from the developed squad rating so
 *  the table reflects who grew and who aged out. */
export function developLeague(clubs: Club[], rng: Rng): Club[] {
  return clubs.map(c => {
    const team = developSquad(c.team, rng);
    return { ...c, team, strength: Math.max(0.3, Math.min(0.95, squadRating(team) / 100)) };
  });
}
