// The Academy at the WorldState level — the homegrown youth pipeline over PvP
// (DESIGN §8, the system only ACE can do well). Pure transforms the server runs on an
// owner's academy: build the wing, take an annual intake of teenage prospects (a wide
// ceiling cloud — the foggiest gambles in the game), develop them on the reps path
// each season, and graduate the hits into the senior roster at NO transfer fee. The
// money (upgrade cost, upkeep) hits the club balance; the prospects are the owner's
// own state. Reuses the exact pure functions the single-player store uses, so a
// graduate is the same kind of object as any homegrown player. The match engine never
// sees any of it — seed 42 is byte-identical.
import { Rng } from '@ace/engine';
import type { Player } from '@ace/shared';
import { type Academy, academyIntake, academyCost, academyUpkeep, intakeSize, academyWageBill, ACADEMY_MAX } from './academy.js';
import { developInSeason, developPlayer, overall, SEASON_SHARE } from './develop.js';
import { scoutedRange } from './scouting.js';
import { newContract } from './finance.js';
import type { WorldState } from './state.js';

const clubIndex = (w: WorldState, clubId: string) => {
  const i = w.clubs.findIndex(c => c.id === clubId);
  if (i < 0) throw new Error(`no such club ${clubId}`);
  return i;
};

/** A prospect for the wire — the gamble made legible. Owned (your academy) → tighter
 *  bands, but a teen's residual plasticity is wide: a raw 14-year-old is the foggiest
 *  read in the game. `room` is the OVR of upside left (ceiling-top − current). */
export interface ProspectView { id: string; handle: string; role: string; age: number; overall: number; ceiling: [number, number]; room: number; scoutLevel: number }
export interface AcademyView { level: number; max: number; cost: number | null; canUpgrade: boolean; upkeep: number; intakeNext: number; wageBill: number; prospects: ProspectView[] }

/** The academy view for an owner — the wing's level + cost, and every prospect with
 *  his scouted ceiling band. `scoutOf(handle)` supplies the owner's report level. */
export function academyView(a: Academy, balance: number, scoutOf: (handle: string) => number): AcademyView {
  const cost = a.level < ACADEMY_MAX ? academyCost(a.level) : null;
  return {
    level: a.level, max: ACADEMY_MAX, cost, canUpgrade: cost != null && balance >= cost,
    upkeep: academyUpkeep(a.level), intakeNext: intakeSize(a.level), wageBill: academyWageBill(a.prospects),
    prospects: a.prospects.map(p => {
      const ovr = Math.round(overall(p)), ceiling = scoutedRange(p, true, scoutOf(p.handle));
      return { id: p.id, handle: p.handle, role: p.role, age: p.age, overall: ovr, ceiling, room: Math.max(0, ceiling[1] - ovr), scoutLevel: scoutOf(p.handle) };
    }),
  };
}

/** Upgrade the wing one level — charges the club balance (steeper than a facility:
 *  the academy is the deepest investment). Throws if maxed or short on cash. */
export function upgradeAcademy(w: WorldState, clubId: string, a: Academy): { world: WorldState; academy: Academy } {
  if (a.level >= ACADEMY_MAX) throw new Error('academy already maxed');
  const i = clubIndex(w, clubId), cost = academyCost(a.level);
  if (cost > w.clubs[i].balance) throw new Error('insufficient funds');
  const world = { ...w, clubs: w.clubs.map((c, j) => (j === i ? { ...c, balance: c.balance - cost } : c)) };
  return { world, academy: { ...a, level: a.level + 1 } };
}

/** Take this season's intake once (level > 0, not already taken) — a deterministic
 *  class drawn on its OWN rng (never perturbs the world stream), handles disjoint
 *  from `exclude` (the engine assumes unique handles in a match). */
export function takeIntake(seasonSeed: number, season: number, a: Academy, exclude: Set<string>): Academy {
  if (a.level === 0 || a.lastIntake >= season) return a;
  const fresh = academyIntake(seasonSeed, season, a.level, exclude);
  return { ...a, prospects: [...a.prospects, ...fresh], lastIntake: season };
}

/** Graduate a prospect into the senior roster — NO transfer fee, ungelled (tenure 0),
 *  on a fresh first deal (his wage tracks his current ability). A hit is worth many
 *  times what you "paid". Returns the new world (roster grew) + academy (prospect gone). */
export function graduateProspect(w: WorldState, clubId: string, a: Academy, patch: WorldState['patch'], ref: string): { world: WorldState; academy: Academy } {
  const p = a.prospects.find(x => x.id === ref || x.handle === ref);
  if (!p) throw new Error('not in your academy');
  const i = clubIndex(w, clubId);
  const grad: Player = { ...p, tenure: 0, contract: newContract(p, patch) };
  const world = { ...w, clubs: w.clubs.map((c, j) => (j === i ? { ...c, roster: [...c.roster, grad] } : c)) };
  return { world, academy: { ...a, prospects: a.prospects.filter(x => x !== p) } };
}

/** Cut a prospect you've given up on. */
export function cutProspect(a: Academy, ref: string): Academy {
  return { ...a, prospects: a.prospects.filter(x => x.id !== ref && x.handle !== ref) };
}

/** A full season of prospect development on rollover — the in-season reps share
 *  (`developInSeason` 'academy': grow, ceiling up, no rust) then the bootcamp share
 *  + age (`developPlayer`), matching the single-player annual pace. Drawn on a
 *  per-(season) rng SEPARATE from the senior stream, so the world stays byte-identical.
 *  Also charges the club the academy upkeep (coaches + the youth circuit). */
export function developAcademy(w: WorldState, clubId: string, a: Academy, season: number, accountSalt: number): { world: WorldState; academy: Academy } {
  const i = clubIndex(w, clubId);
  let world = w;
  let prospects = a.prospects;
  if (prospects.length) {
    const rng = new Rng((((w.seed ^ 0xACE5) >>> 0) ^ (season * 0x9e3779b9) ^ accountSalt) >>> 0);
    prospects = prospects.map(p => developInSeason(p, 'academy', 1, rng));        // in-season reps (SEASON_SHARE)
    prospects = prospects.map(p => developPlayer(p, rng, 1 - SEASON_SHARE));      // bootcamp share + age +1
  }
  const upkeep = academyUpkeep(a.level);
  if (upkeep) world = { ...world, clubs: world.clubs.map((c, j) => (j === i ? { ...c, balance: c.balance - upkeep } : c)) };
  return { world, academy: { ...a, prospects } };
}
