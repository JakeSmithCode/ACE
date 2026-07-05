// Player contracts for the PvP world — the lasting cost of a signing (DESIGN §18). A deal
// LOCKS a wage for a term; it ticks down each off-season, and a player who reaches 0 unrenewed
// WALKS FREE (leaves the roster; the club backfills to stay valid). Pure + deterministic —
// the server runs these owner-scoped (a human's squad), so AI clubs + no-owner worlds are
// byte-identical (they float at the market wage, no lifecycle). Mirrors the single-player store.
import type { Player, PatchState } from '@ace/shared';
import { newContract, negotiatedContract, CONTRACT_YEARS } from './finance.js';
import { freeAgents } from './market.js';

const ROLE_NEED = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 } as const;

/** Give each un-contracted roster player a staggered deal (2..4 yrs) at the current market
 *  wage — so a freshly-claimed squad inherits a real contract situation that expires over
 *  time. Idempotent: a player who already has a deal keeps it. */
export function seedContracts(roster: Player[], patch?: PatchState): Player[] {
  return roster.map((p, i) => p.contract ? p : { ...p, contract: newContract(p, patch, 2 + (i % 3)) });
}

/** Re-sign one player to a fresh deal at his CURRENT market wage (a raise for an improved
 *  youngster, a cut for a faded vet — either way you keep him and re-lock it). `years` is
 *  the NEGOTIATED term: short pays a premium, long earns a discount but locks the wage
 *  (`negotiatedContract`); omitted → the neutral `CONTRACT_YEARS` market deal, byte-identical. */
export function renewContract(roster: Player[], id: string, patch?: PatchState, years?: number): Player[] {
  const deal = (p: Player) => years == null ? newContract(p, patch, CONTRACT_YEARS) : negotiatedContract(p, years, patch);
  return roster.map(p => p.id === id ? { ...p, contract: deal(p) } : p);
}

/** Off-season: tick every deal down a year; a player who hits 0 unrenewed WALKS FREE (leaves
 *  the roster). Any role dropped below the comp floor is backfilled from free agency (fresh
 *  deals), so the squad stays valid. Pure + deterministic (the FA pool is seeded, handles
 *  disjoint from `exclude`). Returns the new roster + who left + who was signed to cover. */
export function processContracts(roster: Player[], patch: PatchState | undefined, faSeed: number, exclude: Set<string>): { roster: Player[]; departed: Player[]; signed: Player[] } {
  const ticked = roster.map(p => p.contract ? { ...p, contract: { ...p.contract, years: p.contract.years - 1 } } : p);
  const departed = ticked.filter(p => p.contract && p.contract.years <= 0);
  if (!departed.length) return { roster: ticked, departed: [], signed: [] };
  let kept = ticked.filter(p => !(p.contract && p.contract.years <= 0));
  const pool = freeAgents(faSeed, exclude, 48);
  const signed: Player[] = [];
  const taken = new Set<string>();
  for (const role of Object.keys(ROLE_NEED) as (keyof typeof ROLE_NEED)[]) {
    while (kept.filter(p => p.role === role).length < ROLE_NEED[role]) {
      const fa = pool.find(p => p.role === role && !taken.has(p.handle));
      if (!fa) break;
      taken.add(fa.handle);
      const signee = { ...fa, contract: newContract(fa, patch, CONTRACT_YEARS) };
      kept = [...kept, signee]; signed.push(signee);
    }
  }
  return { roster: kept, departed, signed };
}
