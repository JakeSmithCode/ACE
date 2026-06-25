// The always-open transfer market. With every squad locked at five (one per
// role), a transfer is a SWAP + cash: you take a player, your same-role player
// goes the other way, and the richer side pays the value difference. So the
// market is a web of trade deals that's always live — no windows, no roster
// gaps. Pure/deterministic helpers here; the web store orchestrates the moves
// (and the Phase-2 server worker will run the same resolution on real bids).
import type { Club, } from './clubs.js';
import { overall, clubPhase } from './develop.js';
import type { Player } from '@ace/shared';
import { playerValue } from './market.js';

/** Each eligible AI club lists a player, shaped by its **lifecycle stage**: an
 *  AGING club cashes out its oldest VETERAN (a proven player, age-discounted —
 *  a rebuild raid for you), while a prime/rising club just trims its most
 *  expendable fringe. So the board reflects who's reloading and who's holding.
 *  `eligible` scopes which clubs list; `cap` keeps it browsable (priciest win). */
export function aiListings(clubs: Club[], myClub: number, eligible?: Set<number>, cap = 30): { club: number; playerId: string }[] {
  const out: { club: number; playerId: string; v: number }[] = [];
  clubs.forEach((c, i) => {
    if (i === myClub || (eligible && !eligible.has(i))) return;
    const p = clubPhase(c.team) === 'aging'
      ? [...c.team.players].sort((a, b) => b.age - a.age || overall(b) - overall(a))[0]   // sell the vet
      : [...c.team.players].sort((a, b) => playerValue(a) - playerValue(b))[0];           // trim the fringe
    out.push({ club: i, playerId: p.id, v: playerValue(p) });
  });
  return out.sort((a, b) => b.v - a.v).slice(0, cap).map(({ club, playerId }) => ({ club, playerId }));
}

/** The strongest rival bid for a market player — price discovery. Every AI club
 *  that wants him (`aiWantsToBuy`: role-upgrade + phase + can-afford) values him at
 *  `playerValue` scaled by **eagerness** (a rising/rebuilding club hungry to climb
 *  pays a premium), capped at a prudent fraction of its bank. The top such cap is
 *  the price you must beat. `{ club: -1, bid: 0 }` = nobody else is in, you sign at
 *  asking. Pure/deterministic — the same resolution the Phase-2 server runs on real
 *  bids (AI just fills the other seats here). */
export function topRivalBid(clubs: Club[], balances: number[], exclude: Set<number>, player: Player, patch?: Parameters<typeof playerValue>[1]): { club: number; bid: number } {
  let best = { club: -1, bid: 0 };
  const base = playerValue(player, patch);
  clubs.forEach((c, i) => {
    if (exclude.has(i) || !aiWantsToBuy(clubs, balances, i, player)) return;
    const phase = clubPhase(c.team);
    const eager = phase === 'rising' || phase === 'rebuilding' ? 1.25 : 1.05;   // the hungry pay up
    const cap = Math.min(Math.round(balances[i] * 0.6), Math.round(base * eager));   // a prudent ceiling
    if (cap > best.bid) best = { club: i, bid: cap };
  });
  return best;
}

/** Would AI club `i` buy `player` to replace its same-role player? It must be an
 *  upgrade it can afford — but a **rising/rebuilding** club is hungrier (it'll take
 *  a marginal upgrade to climb), while a **prime** club only wants a clear one and
 *  an **aging** one (mid-rebuild) sits out. */
export function aiWantsToBuy(clubs: Club[], balances: number[], i: number, player: Player): boolean {
  const mine = clubs[i].team.players.find(p => p.role === player.role);
  if (!mine) return false;
  const phase = clubPhase(clubs[i].team);
  if (phase === 'aging') return false;                              // rebuilding via youth, not the market
  const margin = phase === 'rising' || phase === 'rebuilding' ? 0 : 2;   // the hungry buy marginal upgrades
  if (overall(player) <= overall(mine) + margin) return false;
  return playerValue(player) <= balances[i];                       // full cash price
}
