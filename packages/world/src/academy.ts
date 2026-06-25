// The Academy (DESIGN §8) — your homegrown youth pipeline, and the system only
// ACE can do well: it manufactures the foggiest gambles in the game. An upgradeable
// HQ wing that each season delivers an intake of teenage prospects into your
// reserves — age 14–18, raw (low current ability) but a WIDE ceiling cloud (high
// potVar): you're drafting blind, and the only way to resolve the cloud is to give
// the kid reps. They develop on the academy reps path (developInSeason 'academy':
// real growth, no rust, no senior minutes) and graduate into your roster when ready
// — at no transfer fee and a fraction of a senior wage, so a hit is worth many times
// what you "paid". Pure/deterministic; the match engine never sees any of it, so
// seed 42 is byte-identical.
import { Rng } from '@ace/engine';
import type { Player, Role } from '@ace/shared';
import { makePlayer, genHandles } from './clubs.js';
import { playerWage } from './finance.js';

export const ACADEMY_MAX = 5;
const ROLES: Role[] = ['duelist', 'duelist', 'initiator', 'controller', 'sentinel'];  // duelist-weighted, as comps are

/** The academy as stored state: its level, the prospects in residence, and the
 *  last season an intake was taken (so a class is delivered once per season). */
export interface Academy { level: number; prospects: Player[]; lastIntake: number }
export const defaultAcademy = (): Academy => ({ level: 0, prospects: [], lastIntake: 0 });

/** Cost to upgrade the academy from `level` to `level+1` — steeper than a facility
 *  room: the academy is the deepest investment (it manufactures talent). */
export const academyCost = (level: number): number => 9000 + level * 9000;

/** Recurring per-season upkeep of the academy wing — coaches, the youth circuit.
 *  ~$4k/season at max, on top of the cheap prospect wages. */
export const academyUpkeep = (level: number): number => level * 800;

// prospects per off-season by academy level (0 = locked). A bigger academy fields
// a larger class, so more shots at a gem.
const INTAKE = [0, 1, 1, 2, 2, 3];
export const intakeSize = (level: number): number => INTAKE[Math.max(0, Math.min(ACADEMY_MAX, level))];

/** Prospect strength centre — rises with academy level (a better academy scouts a
 *  higher floor, so fewer total busts), but the wide potVar cloud keeps every
 *  intake a gamble. Drawn, so a class still varies. */
const prospectStrength = (level: number, rng: Rng): number =>
  Math.max(0.1, Math.min(0.6, 0.16 + level * 0.05 + rng.range(-0.08, 0.12)));

/** The season's intake — `intakeSize(level)` teenage prospects generated
 *  deterministically from (seed, season, level), handles disjoint from `exclude`
 *  (the engine assumes unique handles in a match). Each is age 16–18, raw but a
 *  wide ceiling cloud — your gamble to develop (a 14-year-old is the foggiest read
 *  in the game: max plasticity, near-zero scouting confidence). Drawn on its own Rng, so it never
 *  perturbs the world stream (an unused academy leaves everything byte-identical). */
export function academyIntake(seed: number, season: number, level: number, exclude: Set<string>): Player[] {
  const n = intakeSize(level);
  if (n === 0) return [];
  const rng = new Rng((seed ^ (season * 0x6d2b79f5) ^ 0xACAD) >>> 0);
  return genHandles(rng, n, exclude).map(handle => {
    const role = ROLES[rng.int(0, ROLES.length - 1)];
    const age = rng.int(14, 18);
    return makePlayer(rng, role, handle, 'acad', prospectStrength(level, rng), age);
  });
}

// an academy contract is cheap — a fraction of a senior wage (depth still costs
// money, but the academy is the cheap way to build talent).
export const ACADEMY_WAGE = 0.35;
export const academyWage = (p: Player): number => Math.round(playerWage(p) * ACADEMY_WAGE);
export const academyWageBill = (prospects: Player[]): number => prospects.reduce((s, p) => s + academyWage(p), 0);
