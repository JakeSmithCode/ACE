import type { RoundEconomy } from '@ace/shared';

const FULL = 3900, FORCE = 2000;
export type Buy = 'full' | 'force' | 'eco' | 'pistol';

export function decideBuy(creds: number, pistol: boolean): Buy {
  if (pistol) return 'pistol';
  if (creds >= FULL) return 'full';
  if (creds >= FORCE) return 'force';
  return 'eco';
}

/** Very simplified credit economy. Enough to drive buy decisions. */
export function nextCreds(creds: number, won: boolean, kills: number, lossBonus: number): number {
  let c = creds + kills * 200;
  c += won ? 3000 : (1900 + lossBonus * 500);
  return Math.min(9000, c);
}

export function buildEconomy(buy: Record<'0' | '1', Buy>, creds: Record<'0' | '1', number>): RoundEconomy {
  return { buy, creds };
}
