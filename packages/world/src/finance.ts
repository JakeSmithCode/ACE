// Club finances — the economic pressure between seasons. Deterministic and pure;
// wages scale steeply with ability (a superstar squad is expensive to keep), and
// income rewards results, so a good season funds the next and a bad one bleeds
// you toward selling. Numbers are in $ (thousands read naturally in the UI).
import type { Player, Team, PatchState } from '@ace/shared';
import { overall } from './develop.js';

/** A player's seasonal wage — convex in ability, so the last few overall points
 *  cost the most (stars are dear). Veterans on a decline still cost their level.
 *  **Market-linked**: with a `patch`, a player who mains a buffed agent commands a
 *  higher wage (the meta moves wages, not just transfer fees — a demand the sharp
 *  owner anticipates). Omit `patch` → the meta-neutral base (CLIs byte-identical). */
export function playerWage(p: Player, patch?: PatchState): number {
  const base = Math.pow(overall(p), 2.2) * 0.2;
  if (!patch) return Math.round(base);
  const main = [...p.agents].sort((a, b) => b.level - a.level)[0]?.agent;
  const tier = main ? (patch.agentTier[main] ?? 1) : 1;
  return Math.round(base * (0.7 + tier * 0.3));        // tier ~0.85..1.15 → ~0.96..1.05×
}
export const squadWages = (team: Team, patch?: PatchState): number => team.players.reduce((s, p) => s + playerWage(p, patch), 0);

// --- contracts: a wage locked for a term (the lasting cost of a signing) --------
export const CONTRACT_YEARS = 3;   // default length of a fresh deal

/** What you actually PAY a player this season — his contracted wage if he's under
 *  one (locked at signing, even as he ages and his market rate drifts), else the
 *  live market rate. This is the bill the season settle uses. */
export const contractWage = (p: Player, patch?: PatchState): number => p.contract?.wage ?? playerWage(p, patch);

/** The wage a player DEMANDS to (re-)sign — the current market rate. So renewing an
 *  improved youngster costs a raise, and a declined veteran re-signs cheaper. */
export const demandWage = (p: Player, patch?: PatchState): number => playerWage(p, patch);

/** A fresh deal at the current market wage for `years` seasons. */
export const newContract = (p: Player, patch?: PatchState, years = CONTRACT_YEARS): { wage: number; years: number } =>
  ({ wage: playerWage(p, patch), years });

/** Term negotiation (the CS-manager salary-negotiation staple): a SHORT deal costs a
 *  premium (the player wants security), a LONG one earns a yearly discount but locks the
 *  wage across his trajectory — a bargain if he blooms, a burden if he fades. 3y is the
 *  neutral market deal (×1.0, exactly `newContract`), so existing flows are byte-identical. */
export const TERM_MUL: Record<number, number> = { 1: 1.12, 2: 1.05, 3: 1.0, 4: 0.94, 5: 0.9 };
export const negotiatedContract = (p: Player, years: number, patch?: PatchState): { wage: number; years: number } => {
  const y = Math.max(1, Math.min(5, Math.round(years)));
  return { wage: Math.round(playerWage(p, patch) * (TERM_MUL[y] ?? 1)), years: y };
};

/** Income for finishing the season at `rank` (1 = champion) in an `n`-club league:
 *  a base sponsor cheque plus placement prize money. */
export function seasonIncome(rank: number, n: number): { sponsor: number; prize: number } {
  const placement = (n - rank) / (n - 1);             // 1 champion .. 0 last
  return { sponsor: Math.round(9000 + placement * 7000), prize: Math.round(1500 + placement * 17000) };
}

/** Where a club's bank starts — bigger clubs are richer (and pay more). */
export const startingBalance = (strength: number): number => Math.round(14000 + strength * 26000);

/** Bonus prize for a playoff finish, on top of the placement prize — the reward
 *  for winning when it matters (a title is worth chasing). */
export function playoffPrize(finish: 'champion' | 'runner-up' | 'semifinal' | 'none'): number {
  return finish === 'champion' ? 14000 : finish === 'runner-up' ? 7000 : finish === 'semifinal' ? 3500 : 0;
}

export interface SeasonLedger { season: number; sponsor: number; prize: number; playoff?: number; wages: number; upkeep?: number; net: number }

/** Settle a club's books for a finished season: income (by final rank) minus the
 *  squad wage bill. Returns the ledger; the caller adds `net` to the balance. */
export function settleSeason(team: Team, rank: number, n: number, season: number): SeasonLedger {
  const { sponsor, prize } = seasonIncome(rank, n);
  const wages = squadWages(team);
  return { season, sponsor, prize, wages, net: sponsor + prize - wages };
}
