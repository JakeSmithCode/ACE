import type { RoundEconomy } from '@ace/shared';

const FULL = 3900;        // a full rifle buy + utility
const FORCE_FLOOR = 2000; // enough to put together a meaningful half-buy
const NEAR_FULL = 3300;   // close enough to a full that you just commit
export type Buy = 'full' | 'force' | 'eco' | 'pistol';

/** Buy decision for a non-pistol round, reading our bank, the enemy's, and our
 *  loss streak. The key realism is *saving*: when a real buy is out of reach and
 *  we're not desperate, bank the credits instead of half-buying into rifles. */
export function decideBuy(creds: number, opp: number, lossStreak: number): Buy {
  if (creds >= FULL) return 'full';
  if (creds >= FORCE_FLOOR) {
    if (creds >= NEAR_FULL) return 'force';   // basically a full — just commit
    if (lossStreak >= 2) return 'force';      // can't afford to keep saving, must contest
    if (opp < FORCE_FLOOR) return 'force';    // enemy is on an eco — punish it
    return 'eco';                             // save toward a real buy next round
  }
  return 'eco';
}

// what each buy actually spends — the drain that makes the economy bite. A team
// on a long buy-and-lose streak bleeds toward an eco; saving banks the credits.
const COST: Record<Buy, number> = { full: 3900, force: 2300, eco: 400, pistol: 0 };

/** Credit economy after a round: spend the buy, then earn. Loss bonus escalates
 *  1900/2400/2900; planting pays the attackers 300 even in a lost round; each
 *  kill pays 200. Clamped to [0, 9000]. */
export function nextCreds(creds: number, buy: Buy, won: boolean, kills: number, lossBonus: number, planted: boolean): number {
  let c = creds - COST[buy] + kills * 200;
  c += won ? 3000 : (1900 + Math.min(2, lossBonus) * 500);
  if (planted) c += 300;
  return Math.max(0, Math.min(9000, c));
}

export function buildEconomy(buy: Record<'0' | '1', Buy>, creds: Record<'0' | '1', number>): RoundEconomy {
  return { buy, creds };
}
