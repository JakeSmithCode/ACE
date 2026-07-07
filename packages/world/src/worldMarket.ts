// The transfer market at the WorldState level — the PvP economy (DESIGN §6, the
// always-open market). Pure transforms the server runs on real bids (and the
// single-player store mirrors): a free-agent board deterministic per world, and a
// bid resolution that's a real **bidding war** — you clear the asking price AND beat
// the strongest rival AI ceiling, or you're outbid. Reuses the same `playerValue` /
// `topRivalBid` / `aiWantsToBuy` price-discovery the store uses, bridged from
// WorldClub → the engine's Club shape via `clubTeam`. The match engine never sees
// any of this, so seed 42 is untouched.
import type { Player } from '@ace/shared';
import { freeAgents, playerValue } from './market.js';
import { topRivalBid, aiWantsToBuy } from './transfers.js';
import { overall, isMentor, isMentee } from './develop.js';
import { scoutedRange, scoutedAttrs, type AttrScout } from './scouting.js';
import { clubTeam, startingFive, planFive, validFive, type WorldState, type WorldClub } from './state.js';
import { fatigueOf, injuryOf } from './fitness.js';
import { moodOf, captainOf } from './morale.js';
import { negotiatedContract, contractWage, demandWage } from './finance.js';

/** The free-agent board for a world — deterministic per (seed, season), with handles
 *  disjoint from every rostered player (the engine assumes unique handles). The
 *  `signed` set (players already taken this session) is filtered out. */
export function marketBoard(w: WorldState, signed: Set<string> = new Set(), count = 16): Player[] {
  const exclude = new Set<string>(signed);
  for (const c of w.clubs) for (const p of c.roster) exclude.add(p.handle);
  return freeAgents(((w.seed ^ 0x5f356495) >>> 0) ^ (w.season * 0x9e3779b9), exclude, count + signed.size)
    .filter(p => !signed.has(p.handle)).slice(0, count);
}

/** The engine-`Club` view of every world club (the fielded five + tactics + strength)
 *  — what the AI price-discovery functions operate on. */
const asClubs = (w: WorldState) => w.clubs.map(c => ({ team: clubTeam(c), tactics: c.tactics, strength: c.strength }));

/** Is a free agent contested — does any AI club want to sign him? (the 🔥 flag). */
export function isContested(w: WorldState, player: Player): boolean {
  const clubs = asClubs(w), balances = w.clubs.map(c => c.balance);
  return clubs.some((_, i) => aiWantsToBuy(clubs, balances, i, player));
}

export interface BidResult { ok: boolean; reason?: string; leader?: string; leadBid?: number; paid?: number }

/** Resolve a human's bid on a free agent (the war): you sign at your offer only if it
 *  clears the asking price AND beats the strongest rival AI ceiling (`topRivalBid`).
 *  Else it returns the leading club + its bid so the client can raise or walk. The
 *  exact resolution the server runs; single-player fills the other seats with AI. */
export function resolveWorldBid(w: WorldState, clubIdx: number, player: Player, amount: number): BidResult {
  const asking = playerValue(player, w.patch);
  if (amount < asking) return { ok: false, reason: 'below asking price', leadBid: asking };
  if (amount > w.clubs[clubIdx].balance) return { ok: false, reason: 'insufficient funds', leadBid: amount };
  const rival = topRivalBid(asClubs(w), w.clubs.map(c => c.balance), new Set([clubIdx]), player, w.patch);
  if (rival.club >= 0 && rival.bid >= amount) return { ok: false, reason: 'outbid', leader: w.clubs[rival.club].tag, leadBid: rival.bid };
  return { ok: true, paid: amount };
}

/** Apply a signing: ADD the player to the club's roster (no drop — depth is real and
 *  never reaches the engine) at the agreed price, retagged to the club and ungelled
 *  (tenure 0 — a fresh signing drags cohesion until it builds). Pure. */
export function applySigning(w: WorldState, clubId: string, player: Player, cost: number): WorldState {
  const i = w.clubs.findIndex(c => c.id === clubId);
  if (i < 0) throw new Error(`no such club ${clubId}`);
  const c = w.clubs[i];
  const signed: Player = { ...player, tenure: 0 };   // ungelled — a fresh signing drags cohesion until it builds
  const club: WorldClub = { ...c, roster: [...c.roster, signed], balance: c.balance - cost };
  return { ...w, clubs: w.clubs.map((x, j) => (j === i ? club : x)) };
}

/** A compact board entry for the wire — what the market UI renders. `ceiling` is the
 *  **scouted potential band** (the gamble, DESIGN §4.1): the market-consensus fogged
 *  ceiling — wide for a young/unresolved prospect (high upside, murky), tight for a
 *  settled veteran. The price already reflects the consensus, so the band is exactly
 *  the bet you're taking on top of it. */
export interface MarketEntry { handle: string; role: string; age: number; overall: number; value: number; contested: boolean; ceiling: [number, number]; scoutLevel: number; attrs: AttrScout[] }
export function marketEntry(w: WorldState, p: Player, scoutLevel = 0): MarketEntry {
  // `value` is the market CONSENSUS (fogged at level 0 — the asking price you must
  // clear). A paid report tightens only the `ceiling` band + per-skill `attrs` for
  // YOUR eyes, never the price — so scouting is private information: learn the
  // consensus is mispricing a gem, then sign him at the unchanged asking.
  return { handle: p.handle, role: p.role, age: p.age, overall: Math.round(overall(p)), value: playerValue(p, w.patch), contested: isContested(w, p), ceiling: scoutedRange(p, false, scoutLevel), scoutLevel, attrs: scoutedAttrs(p, false, scoutLevel) };
}

/** What a scouting report costs at the current level — 1.5k / 3k / 4.5k (matches the
 *  single-player store). Each level buys confidence and tightens the ceiling band. */
export const scoutCost = (level: number) => 1500 + level * 1500;

/** Charge a club's balance for a scouting report (pure). The knowledge itself is the
 *  owner's private session state — only the money is world state. */
export function chargeScout(w: WorldState, clubId: string, cost: number): WorldState {
  const i = w.clubs.findIndex(c => c.id === clubId);
  if (i < 0) throw new Error(`no such club ${clubId}`);
  return { ...w, clubs: w.clubs.map((c, j) => (j === i ? { ...c, balance: c.balance - cost } : c)) };
}

/** The richest AI club (not the seller) that genuinely wants `player` as an upgrade
 *  and can afford the market fee — the buyer for a sale. `{ club: -1 }` = nobody's in. */
export function findBuyer(w: WorldState, sellerIdx: number, player: Player): { club: number; fee: number } {
  const clubs = asClubs(w), balances = w.clubs.map(c => c.balance);
  const fee = playerValue(player, w.patch);
  let best = { club: -1, fee };
  clubs.forEach((_, i) => {
    if (i === sellerIdx || !aiWantsToBuy(clubs, balances, i, player) || fee > balances[i]) return;
    if (best.club < 0 || balances[i] > balances[best.club]) best = { club: i, fee };   // the richest willing buyer
  });
  return best;
}

export interface SaleResult { ok: boolean; reason?: string; fee?: number; buyer?: string; buyerIdx?: number }

/** Resolve a human's sale of a rostered player: blocked if it would break the seller's
 *  valid five, else matched to the richest AI buyer who wants him (the fee is market
 *  value). Returns the deal to confirm; `applySale` commits it. */
export function resolveSale(w: WorldState, sellerClubId: string, ref: string): SaleResult {
  const si = w.clubs.findIndex(c => c.id === sellerClubId);
  if (si < 0) return { ok: false, reason: 'no such club' };
  const player = w.clubs[si].roster.find(p => p.id === ref || p.handle === ref);
  if (!player) return { ok: false, reason: 'not on your roster' };
  if (!validFive(startingFive(w.clubs[si].roster.filter(p => p !== player)))) return { ok: false, reason: 'would break your valid five' };
  const buyer = findBuyer(w, si, player);
  if (buyer.club < 0) return { ok: false, reason: 'no club wants him right now' };
  return { ok: true, fee: buyer.fee, buyer: w.clubs[buyer.club].tag, buyerIdx: buyer.club };
}

/** Validate a DIRECT transfer between two named clubs (the human-to-human deal):
 *  the player must be on the seller's roster, the seller must keep a valid five
 *  without him, and the buyer must be able to pay. The offer/accept flow around it
 *  is the server's; `applySale` is the commit (buyer inherits the contract, tenure
 *  resets — the same object move every other transfer path uses). */
export function resolveDirect(w: WorldState, sellerClubId: string, buyerClubId: string, ref: string, fee: number):
    { ok: boolean; reason?: string; sellerIdx?: number; buyerIdx?: number; handle?: string } {
  const si = w.clubs.findIndex(c => c.id === sellerClubId);
  const bi = w.clubs.findIndex(c => c.id === buyerClubId);
  if (si < 0 || bi < 0) return { ok: false, reason: 'no such club' };
  const player = w.clubs[si].roster.find(p => p.id === ref || p.handle === ref);
  if (!player) return { ok: false, reason: 'no longer on that roster' };
  if (!validFive(startingFive(w.clubs[si].roster.filter(p => p !== player)))) return { ok: false, reason: 'the sale would break the seller\'s valid five' };
  if (w.clubs[bi].balance < fee) return { ok: false, reason: 'the buyer can no longer afford the fee' };
  return { ok: true, sellerIdx: si, buyerIdx: bi, handle: player.handle };
}

/** Commit a sale: the player moves to the buyer (ungelled), the fee moves to the
 *  seller. A real transfer between two clubs — the exact resolution the server runs. */
export function applySale(w: WorldState, sellerClubId: string, ref: string, buyerIdx: number, fee: number): WorldState {
  const si = w.clubs.findIndex(c => c.id === sellerClubId);
  const player = w.clubs[si].roster.find(p => p.id === ref || p.handle === ref)!;
  const moved: Player = { ...player, tenure: 0 };
  return { ...w, clubs: w.clubs.map((c, j) =>
    j === si ? { ...c, roster: c.roster.filter(p => p !== player), balance: c.balance + fee } :
    j === buyerIdx ? { ...c, roster: [...c.roster, moved], balance: c.balance - fee } : c) };
}

/** The living market: each advance, a few motivated AI clubs sign the best free agent
 *  they want — so the board churns and the gems get snapped up (the urgency that makes
 *  the economy bite: spot a player and bid before a rival takes him). Bounded + pure;
 *  recomputes balances per signing so it's correct. Returns the new world + who signed. */
export function resolveAiMarket(w: WorldState, available: Player[], max = 2): { world: WorldState; signings: { club: string; handle: string; fee: number }[] } {
  let nw = w;
  let pool = [...available];
  const signings: { club: string; handle: string; fee: number }[] = [];
  for (let i = 0; i < w.clubs.length && signings.length < max; i++) {
    if (nw.clubs[i].owner) continue;                         // humans bid for themselves
    const clubs = asClubs(nw), balances = nw.clubs.map(c => c.balance);
    const want = pool.filter(p => aiWantsToBuy(clubs, balances, i, p)).sort((a, b) => playerValue(b, nw.patch) - playerValue(a, nw.patch))[0];
    if (!want) continue;
    const fee = playerValue(want, nw.patch);
    nw = applySigning(nw, nw.clubs[i].id, want, fee);
    signings.push({ club: nw.clubs[i].tag, handle: want.handle, fee });
    pool = pool.filter(p => p.handle !== want.handle);
  }
  return { world: nw, signings };
}

/** The owner's full squad for the wire (so the UI can list reserves to sell). `age`
 *  + the owned-confidence `ceiling` band make development legible: a young player
 *  whose ceiling sits well above his OVR has room to grow (play him / hold him), a
 *  veteran sitting on his ceiling is done improving (flip him). `room` is that gap
 *  (ceiling-top − OVR), the at-a-glance "upside left" read. Owned → tighter bands
 *  (your staff watch them daily) but the residual is real plasticity. */
export interface SquadPlayer { id: string; handle: string; role: string; age: number; overall: number; value: number; starter: boolean; igl: boolean; fatigue: number; injury: number; wage: number; contractYears: number; renew: number; ceiling: [number, number]; room: number; attrs: AttrScout[]; agents: { agent: string; level: number }[]; focus: string | null; mentor: boolean; mentee: boolean; mood: number; captain: boolean; loan?: { tag: string; tier: number } | null; renewTerms?: { years: number; wage: number }[]; accolades?: string[] }
export function squadView(w: WorldState, c: WorldClub): SquadPlayer[] {
  const five = new Set(planFive(c).map(p => p.id));   // the five actually FIELDED (honours a saved lineup), so XI matches who plays + develops
  const hasM = c.roster.some(isMentor);   // a vet leader on the roster mentors the kids (faster growth)
  const cap = c.owner ? captainOf(planFive(c), c.captain) : null;   // the effective armband (explicit pick or best leader)
  return c.roster.map(p => {
    const ovr = Math.round(overall(p)), ceiling = scoutedRange(p, true, 0);
    const agents = [...p.agents].sort((a, b) => b.level - a.level).slice(0, 5).map(a => ({ agent: a.agent, level: a.level }));
    const ln = c.loans?.find(l => l.playerId === p.id);
    // term-negotiation preview (only where a renew is live — the final contract year)
    const renewTerms = p.contract && p.contract.years <= 1
      ? [1, 2, 3, 4, 5].map(y => { const d = negotiatedContract(p, y, w.patch); return { years: y, wage: d.wage }; }) : undefined;
    return { id: p.id, handle: p.handle, role: p.role, age: p.age, overall: ovr, value: playerValue(p, w.patch), starter: five.has(p.id), igl: !!p.igl, fatigue: Math.round(fatigueOf(w.fitness, p.id)), injury: injuryOf(w.fitness, p.id), wage: Math.round(contractWage(p, w.patch)), contractYears: p.contract?.years ?? 0, renew: Math.round(demandWage(p, w.patch)), ceiling, room: Math.max(0, ceiling[1] - ovr), attrs: scoutedAttrs(p, true, 0), agents, focus: c.focuses?.[p.id] ?? null, mentor: isMentor(p), mentee: isMentee(p, hasM), mood: Math.round(moodOf(w.morale, p.id)), captain: cap?.id === p.id, loan: ln ? { tag: ln.hostTag, tier: ln.hostTier } : null, renewTerms, accolades: p.accolades };
  }).sort((a, b) => Number(b.starter) - Number(a.starter) || b.overall - a.overall);
}
