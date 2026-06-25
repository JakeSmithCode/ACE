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

// A club's lifecycle stage — emergent, NOT assigned. It falls out of the roster
// (mean age + how much growth is left in it), so a club moves through the stages as
// its core develops and ages: a young project rises to its prime, peaks, ages, and
// either reloads or collapses into a rebuild. The store reads this to give aging AI
// clubs a proactive rebuild, and the standings show it so you can read the league.
export type ClubPhase = 'rebuilding' | 'rising' | 'prime' | 'aging';
export const clubMeanAge = (team: Team): number =>
  team.players.reduce((s, p) => s + p.age, 0) / team.players.length;
/** A squad's remaining growth — mean(potential − current) over the roster. */
export const clubRoomToGrow = (team: Team): number =>
  Math.round(team.players.reduce((s, p) => s + (potentialOverall(p) - overall(p)), 0) / team.players.length);
export function clubPhase(team: Team): ClubPhase {
  const age = clubMeanAge(team);
  const room = clubRoomToGrow(team);
  // age is the clearest lifecycle signal (it spreads naturally across the league);
  // strength/room split the young teams (climbing vs already-good) and the mid teams
  // (still developing vs settled at their peak).
  // age is the smooth, stable lifecycle signal — three age bands give the core
  // stages; a young squad with a long way to its ceiling is carved out as a rebuild.
  // (Persistent per-club `clubAgeChar` keeps the league's ages spread, so these
  // bands hold a healthy mix season over season instead of pulsing as one.)
  if (age >= 26) return 'aging';                            // old core — decline/retirement looming
  if (age <= 24.5) return room >= 9 ? 'rebuilding' : 'rising';  // young: deep project vs ascending
  return 'prime';                                           // the mature middle — peak years
}

// development is now CONTINUOUS: this fraction of the annual curve is realized
// DURING the season (reps, match by match); the rest is the off-season bootcamp.
// A full-time starter still realizes ~one annual step a year (pace preserved) —
// but a benched player gets far less (and rusts), so playing time is a real lever.
export const SEASON_SHARE = 0.6;

/** Facility-derived development multipliers (the HQ's edge). Default is a no-op,
 *  so AI clubs / the CLI develop exactly as before — only your boosted roster
 *  differs. `growth` speeds growth-to-potential, `decline` slows the fade,
 *  `ceiling` biases the potential cloud up, `rust` cuts bench rust. */
export interface DevBoost { growth: number; decline: number; ceiling: number; rust: number }
export const NO_BOOST: DevBoost = { growth: 1, decline: 1, ceiling: 0, rust: 1 };

/** One development step: grow toward potential + decline past peak, for `frac` of
 *  the annual curve, scaled by reps (`repMul`) and facility boosts. Shared by the
 *  in-season and off-season ticks so they can never drift. */
function curveStep(p: Player, frac: number, repMul: number, rng: Rng, boost: DevBoost): Attributes {
  const lr = learnRate(p.age);
  const attr = { ...p.attr };
  for (const k of ATTRS) {
    const ceil = p.potential?.[k] ?? attr[k];
    const grow = Math.max(0, ceil - attr[k]) * lr * frac * repMul * boost.growth * rng.range(0.55, 1.25);
    const dec = declineRate(p.age, MECH.has(k)) * frac * boost.decline * rng.range(0.6, 1.25);
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
function resolveCeiling(p: Player, played: boolean, rng: Rng, ceilBias: number): Player {
  const v = p.potVar ?? 0;
  if (v < 0.02 || !p.potential) return p.potVar ? { ...p, potVar: 0 } : p;
  const bias = (played ? 0.5 : -0.7) + ceilBias;    // playing realizes upside; idling busts; analyst room helps
  const luck = rng.range(-0.6, 0.6);                // this slice's overall fortune (shared across attrs)
  const potential = { ...p.potential };
  for (const k of ATTRS) {
    const drift = v * CEIL_SPREAD * (bias + luck + rng.range(-0.3, 0.3)) * 0.06;
    potential[k] = Math.max(p.attr[k], Math.min(99, potential[k] + drift));
  }
  return { ...p, potential, potVar: v * CEIL_NARROW };
}

/** How a player spent the match-day, which shapes their development:
 *  - `starter`: full reps in real competition → grows most, ceiling drifts up.
 *  - `academy`: reps in the academy circuit → grows well, ceiling drifts up, no
 *    rust (they're playing), but a touch slower than top-flight minutes.
 *  - `bench`: a senior who didn't play → little growth, ceiling drifts down, and
 *    mechanical sharpness rusts. A `boolean` maps to starter (true) / bench (false)
 *    so existing callers are byte-identical. */
export type DevContext = 'starter' | 'academy' | 'bench';
const REP_MUL: Record<DevContext, number> = { starter: 1, academy: 0.75, bench: 0.3 };

/** In-season micro-development for one match-day. Who you play shapes who develops:
 *  a starter and an academy prospect both get reps (grow, ceiling up); a benched
 *  senior grows far less AND rusts. The ceiling cloud resolves a slice (reps drift
 *  it, then narrow). Age is unchanged in-season (the bracket only shifts off-season). */
export function developInSeason(p: Player, ctx: DevContext | boolean, games: number, rng: Rng, boost: DevBoost = NO_BOOST): Player {
  const context: DevContext = ctx === true ? 'starter' : ctx === false ? 'bench' : ctx;
  const played = context !== 'bench';   // starter & academy both get reps and a ceiling-up bias
  const g = resolveCeiling(p, played, rng, boost.ceiling);
  const attr = curveStep(g, SEASON_SHARE / Math.max(1, games), REP_MUL[context], rng, boost);
  if (context === 'bench') for (const k of ATTRS) if (MECH.has(k)) attr[k] = clamp(attr[k] - rng.range(0.1, 0.28) * boost.rust);  // bench rust
  return { ...g, attr };
}

/** Off-season step: age +1 and the bootcamp share of the annual curve (full reps,
 *  rest + camp), plus a bootcamp slice of ceiling resolution. `frac` defaults to
 *  the WHOLE annual step. */
export function developPlayer(p: Player, rng: Rng, frac = 1, boost: DevBoost = NO_BOOST): Player {
  const g = resolveCeiling(p, true, rng, boost.ceiling);   // bootcamp reps resolve a ceiling slice
  return { ...g, age: g.age + 1, attr: curveStep(g, frac, 1, rng, boost) };
}

export const developSquad = (team: Team, rng: Rng): Team =>
  ({ ...team, players: team.players.map(p => developPlayer(p, rng)) });

// --- retirement: esports careers are short ----------------------------------
/** Hard cap — nobody plays past this age. */
export const RETIRE_HARD_AGE = 38;
/** A player's chance of retiring this off-season — zero until the late 20s, then
 *  it climbs each year; a faded veteran (low overall) hangs it up sooner. Bounded
 *  and *fair* (DESIGN §2/§18): the age you retire is a curve, not a cliff. */
export function retireChance(p: Player): number {
  if (p.age < 28) return 0;
  const age = (p.age - 28) * 0.07;            // 0 at 28 → ~0.7 at 38
  const faded = overall(p) < 58 ? 0.06 : 0;   // a washed vet walks sooner
  return Math.min(0.95, age + faded);
}
/** Whether a player retires this off-season — one rng draw, so callers keep a
 *  uniform draw count (the hard cap forces it without skipping the draw). */
export function shouldRetire(p: Player, rng: Rng): boolean {
  return rng.chance(p.age >= RETIRE_HARD_AGE ? 1 : retireChance(p));
}

/** Run the off-season across the whole league. Fixed club/player order keeps it
 *  deterministic; club strength is refreshed from the developed squad rating so
 *  the table reflects who grew and who aged out. `boostOf` supplies a per-club
 *  development boost (an AI club's infrastructure); omitted → `NO_BOOST` for every
 *  club, which is byte-identical to the old behaviour (boost scales post-draw
 *  values only, never the rng draws). */
export function developLeague(clubs: Club[], rng: Rng, boostOf?: (i: number) => DevBoost): Club[] {
  return clubs.map((c, i) => {
    const boost = boostOf ? boostOf(i) : NO_BOOST;
    const team = { ...c.team, players: c.team.players.map(p => developPlayer(p, rng, 1, boost)) };
    return { ...c, team, strength: Math.max(0.3, Math.min(0.95, squadRating(team) / 100)) };
  });
}
