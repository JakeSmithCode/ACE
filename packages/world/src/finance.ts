// Club finances — the economic pressure between seasons. Deterministic and pure;
// wages scale steeply with ability (a superstar squad is expensive to keep), and
// income rewards results, so a good season funds the next and a bad one bleeds
// you toward selling. Numbers are in $ (thousands read naturally in the UI).
import type { Player, Team } from '@ace/shared';
import { overall } from './develop.js';

/** A player's seasonal wage — convex in ability, so the last few overall points
 *  cost the most (stars are dear). Veterans on a decline still cost their level. */
export const playerWage = (p: Player): number => Math.round(Math.pow(overall(p), 2.2) * 0.2);
export const squadWages = (team: Team): number => team.players.reduce((s, p) => s + playerWage(p), 0);

/** Income for finishing the season at `rank` (1 = champion) in an `n`-club league:
 *  a base sponsor cheque plus placement prize money. */
export function seasonIncome(rank: number, n: number): { sponsor: number; prize: number } {
  const placement = (n - rank) / (n - 1);             // 1 champion .. 0 last
  return { sponsor: Math.round(9000 + placement * 7000), prize: Math.round(1500 + placement * 17000) };
}

/** Where a club's bank starts — bigger clubs are richer (and pay more). */
export const startingBalance = (strength: number): number => Math.round(14000 + strength * 26000);

export interface SeasonLedger { season: number; sponsor: number; prize: number; wages: number; net: number }

/** Settle a club's books for a finished season: income (by final rank) minus the
 *  squad wage bill. Returns the ledger; the caller adds `net` to the balance. */
export function settleSeason(team: Team, rank: number, n: number, season: number): SeasonLedger {
  const { sponsor, prize } = seasonIncome(rank, n);
  const wages = squadWages(team);
  return { season, sponsor, prize, wages, net: sponsor + prize - wages };
}
