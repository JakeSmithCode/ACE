// Account ↔ club ownership against the store (docs/PHASE2.md §4/§5, build step 5).
// Thin persistence wrappers over the pure `@ace/world` transforms: load the world,
// apply the claim/revert/plan transform, save it back. The Pg version runs the
// exact same transforms inside a transaction (a row UPDATE of `club.owner_account_id`
// / `club.plan`). Auth — *which* account may call these — is the HTTP layer's job;
// here we enforce the world-level invariants (one owner per club, a valid plan).
import { claimClub, revertClub, setClubPlan, clubOf, planOf, type ClubPlan, type WorldClub } from '@ace/world';
import type { WorldStore } from './store.js';

const load = async (store: WorldStore, id: string) => {
  const w = await store.loadWorld(id);
  if (!w) throw new Error(`unknown world ${id}`);
  return w;
};

/** Claim a club for an account (signup takes over an AI club, §4). Persists the
 *  `owner` flip; returns the now-owned club. */
export async function claim(store: WorldStore, id: string, clubId: string, account: string): Promise<WorldClub> {
  const w = claimClub(await load(store, id), clubId, account);
  await store.saveWorld(id, w);
  return w.clubs.find(c => c.id === clubId)!;
}

/** Revert a club to AI (an owner churns, §4): `owner` → null, the plan persists so
 *  the AI keeps fielding the last saved five. The world stays structurally complete. */
export async function revert(store: WorldStore, id: string, clubId: string): Promise<void> {
  await store.saveWorld(id, revertClub(await load(store, id), clubId));
}

/** Save an owner's plan (lineup + comp + tactics). Validated by `setClubPlan` (a
 *  forced lineup must be a valid five), so the tick always grabs a competent plan. */
export async function savePlan(store: WorldStore, id: string, clubId: string, plan: ClubPlan): Promise<void> {
  await store.saveWorld(id, setClubPlan(await load(store, id), clubId, plan));
}

/** The club an account owns in this world (null if none) — what `GET /me` returns. */
export async function myClub(store: WorldStore, id: string, account: string): Promise<WorldClub | undefined> {
  return clubOf(await load(store, id), account);
}

/** A club's current plan — what the tick reads and `GET /me/plan` returns. */
export async function clubPlan(store: WorldStore, id: string, clubId: string): Promise<ClubPlan> {
  const w = await load(store, id);
  const c = w.clubs.find(x => x.id === clubId);
  if (!c) throw new Error(`no such club ${clubId}`);
  return planOf(c);
}
