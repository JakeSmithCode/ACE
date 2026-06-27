// Ownership overlay — humans are a sparse, shifting layer on an always-full world
// (docs/PHASE2.md §4). The deterministic generator fills every slot with an AI
// club; a real owner is just `club.owner` flipping from null to an account id.
// Claiming/reverting moves nothing structural, so the world stays complete and the
// tick never blocks on an absent owner. These are PURE `WorldState` transforms
// (the server wraps them with load → transform → save + auth); the store could
// call them too. The engine never sees any of this — seed 42 is byte-identical.
import type { Tactics, Comp } from '@ace/shared';
import { type WorldState, type WorldClub, validFive } from './state.js';

/** A club's **plan** — the saved lineup + comp + tactics the tick grabs (§4). An
 *  AI/ghosting club always has one (its generated tactics + comp, best five); a
 *  human owner authors theirs. `lineup` is optional (undefined → best five). */
export interface ClubPlan { tactics: Tactics; comp: Comp; lineup?: string[] }

const indexOf = (w: WorldState, clubId: string): number => {
  const i = w.clubs.findIndex(c => c.id === clubId);
  if (i < 0) throw new Error(`no such club ${clubId}`);
  return i;
};
const replace = (w: WorldState, i: number, c: WorldClub): WorldState =>
  ({ ...w, clubs: w.clubs.map((x, j) => (j === i ? c : x)) });

/** The plan a club currently runs — what the tick reads. Always defined (an AI
 *  club's is its generated tactics + comp with the derived best five). */
export const planOf = (c: WorldClub): ClubPlan => ({ tactics: c.tactics, comp: c.comp, lineup: c.lineup });

export const isOwned = (c: WorldClub): boolean => c.owner != null;
export const ownedClubs = (w: WorldState): WorldClub[] => w.clubs.filter(isOwned);
export const clubOf = (w: WorldState, account: string): WorldClub | undefined => w.clubs.find(c => c.owner === account);

/** Claim a club for an account: `owner` flips null → account. Idempotent for the
 *  same account; throws if another account already holds it (one owner per club)
 *  or if the account already owns a different club (one club per account, §4). */
export function claimClub(w: WorldState, clubId: string, account: string): WorldState {
  const i = indexOf(w, clubId);
  const c = w.clubs[i];
  if (c.owner === account) return w;                                  // already yours — no-op
  if (c.owner != null) throw new Error(`club ${clubId} already claimed`);
  const existing = clubOf(w, account);
  if (existing) throw new Error(`account ${account} already owns ${existing.id}`);
  return replace(w, i, { ...c, owner: account });
}

/** Revert a club to AI (an owner churns): `owner` → null. The plan PERSISTS — the
 *  AI runs whatever lineup/comp/tactics were last saved, so the club keeps fielding
 *  a competent five with no structural change. */
export function revertClub(w: WorldState, clubId: string): WorldState {
  const i = indexOf(w, clubId);
  return replace(w, i, { ...w.clubs[i], owner: null });
}

/** Save an owner's plan (server-validated before persistence). A forced `lineup`
 *  must be a valid five drawn from the roster, else it's rejected — keeping the
 *  always-valid-five guarantee at the write boundary (and `planFive` falls back
 *  too, so even a bypassed bad lineup never breaks the tick). */
export function setClubPlan(w: WorldState, clubId: string, plan: ClubPlan): WorldState {
  const i = indexOf(w, clubId);
  const c = w.clubs[i];
  if (plan.lineup) {
    if (plan.lineup.length !== 5) throw new Error('a lineup must be exactly five players');
    const chosen = plan.lineup.map(id => c.roster.find(p => p.id === id));
    if (chosen.some(p => !p)) throw new Error('lineup references a player not on the roster');
    if (!validFive(chosen as NonNullable<(typeof chosen)[number]>[])) throw new Error('lineup must field 2 duelists + 1 initiator/controller/sentinel');
  }
  return replace(w, i, { ...c, tactics: plan.tactics, comp: plan.comp, lineup: plan.lineup });
}
