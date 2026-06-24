// The always-open transfer market. With every squad locked at five (one per
// role), a transfer is a SWAP + cash: you take a player, your same-role player
// goes the other way, and the richer side pays the value difference. So the
// market is a web of trade deals that's always live — no windows, no roster
// gaps. Pure/deterministic helpers here; the web store orchestrates the moves
// (and the Phase-2 server worker will run the same resolution on real bids).
import type { Club, } from './clubs.js';
import { overall } from './develop.js';
import { playerValue } from './market.js';

/** Each eligible AI club lists its most expendable player (lowest value —
 *  surplus/ageing) for sale, so the board always has real players from real
 *  teams. `eligible` scopes which clubs list (on a deep ladder, the store passes
 *  only clubs near your tier); `cap` keeps the board browsable (the priciest
 *  listings win the slots). */
export function aiListings(clubs: Club[], myClub: number, eligible?: Set<number>, cap = 30): { club: number; playerId: string }[] {
  const out: { club: number; playerId: string; v: number }[] = [];
  clubs.forEach((c, i) => {
    if (i === myClub || (eligible && !eligible.has(i))) return;
    const p = [...c.team.players].sort((a, b) => playerValue(a) - playerValue(b))[0];
    out.push({ club: i, playerId: p.id, v: playerValue(p) });
  });
  return out.sort((a, b) => b.v - a.v).slice(0, cap).map(({ club, playerId }) => ({ club, playerId }));
}

/** Would AI club `i` buy `player` to replace its same-role player? Only if it's
 *  a clear upgrade and it can afford the full price. */
export function aiWantsToBuy(clubs: Club[], balances: number[], i: number, player: { role: string; }): boolean {
  const mine = clubs[i].team.players.find(p => p.role === player.role);
  if (!mine) return false;
  if (overall(player as any) <= overall(mine) + 2) return false;   // must be a real upgrade
  return playerValue(player as any) <= balances[i];               // full cash price
}
