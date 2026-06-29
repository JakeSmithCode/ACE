import type { RoundEconomy } from '@ace/shared';

const FULL = 3900;        // a full rifle buy + utility
const FORCE_FLOOR = 2000; // enough to put together a meaningful half-buy
const NEAR_FULL = 3300;   // close enough to a full that you just commit
export type Buy = 'full' | 'force' | 'eco' | 'pistol';

/** Buy decision for a non-pistol round — an IN-GAME call made by the in-game leader,
 *  reading our bank, the enemy's, and our loss streak. The key realism is *saving*:
 *  when a real buy is out of reach and we're not desperate, bank the credits instead
 *  of half-buying into rifles. `iql` is the IGL's economic acumen (−1..+1, 0 = neutral):
 *  a WEAK caller wastes the save by half-buying into a marginal force (bleeding the
 *  bank) — a roster gap you fix by fielding a better leader, never a mugging.
 *  `iql = 0` (no leader / neutral) reduces EXACTLY to the original logic. */
export function decideBuy(creds: number, opp: number, lossStreak: number, iql = 0): Buy {
  if (creds >= FULL) return 'full';
  if (creds >= FORCE_FLOOR) {
    if (creds >= NEAR_FULL) return 'force';   // basically a full — just commit
    if (lossStreak >= 2) return 'force';      // can't afford to keep saving, must contest
    if (opp < FORCE_FLOOR) return 'force';    // enemy is on an eco — punish it
    if (iql < -0.33) return 'force';          // a weak caller half-buys when he should save — bleeds the bank
    return 'eco';                             // a disciplined save toward a real buy next round
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
