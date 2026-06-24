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
const clamp = (v: number) => Math.max(25, Math.min(99, Math.round(v)));

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

/** A player's career phase, from the aging curve — for legible UI, not mechanics. */
export function phaseOf(p: Player): 'rising' | 'peak' | 'declining' {
  if (p.age <= 21 && potentialOverall(p) - overall(p) >= 2) return 'rising';
  if (p.age >= 26) return 'declining';
  return 'peak';
}

/** Develop one player by a season: age +1, grow toward potential, decline past
 *  peak. Returns a new Player (current ability only changes; potential is fixed). */
export function developPlayer(p: Player, rng: Rng): Player {
  const lr = learnRate(p.age);
  const attr = { ...p.attr };
  for (const k of ATTRS) {
    const ceil = p.potential?.[k] ?? attr[k];
    const grow = Math.max(0, ceil - attr[k]) * lr * rng.range(0.55, 1.25);
    const dec = declineRate(p.age, MECH.has(k)) * rng.range(0.6, 1.25);
    attr[k] = clamp(attr[k] + grow - dec);
  }
  return { ...p, age: p.age + 1, attr };
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
