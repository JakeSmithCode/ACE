// The shared single-player world — one reactive store both the HQ/Season screen
// and the Tactics Editor read from. A whole career is a function of one seed
// (@ace/world), resolved client-side by the same engine the server worker will
// run. Your club gets two manager overlays the AI clubs don't: an authored comp
// and authored tactics, both injected into your fixtures.
import { computed, ref, shallowRef } from 'vue';
import type { Attributes, Comp, MapId, MatchInput, Player, Role, Tactics } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch, PATCH, Rng } from '@ace/engine';
import {
  makeLeague, doubleRoundRobin, standings, fixtureSeed, developLeague, makePlayer, HANDLES,
  startingBalance, settleSeason, freeAgents, playerValue, squadRating, aiListings, aiWantsToBuy,
  type Club, type MatchResult, type Matchday, type SeasonLedger,
} from '@ace/world';

export const N = 8;
export const MAP: MapId = 'ascent';
const RESOLVE_FORKS = 3;            // standings only need the final score
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const clampStr = (s: number) => Math.max(0.3, Math.min(0.95, s));

/** A buyable slot on the always-open market: a player + where they come from
 *  (`from === -1` a free agent, else the club index selling them). */
export interface MarketEntry { player: Player; from: number }

const seasonSeed = ref(7);
const clubs = shallowRef<Club[]>(makeLeague(seasonSeed.value, N));
const schedule = shallowRef<Matchday[]>(doubleRoundRobin(N));
const results = ref<MatchResult[]>([]);
const dayIdx = ref(0);
const myClub = ref(4);
const season = ref(1);
const prevById = ref<Map<string, { age: number; attr: Attributes }>>(new Map());  // pre-tick snapshot, for roster deltas
const myComp = ref<Comp>({});                          // your authored comp (overlay)
const myTactics = ref<Tactics>(clone(clubs.value[myClub.value].tactics));  // your authored tactics (overlay)
const balances = ref<number[]>(clubs.value.map(c => startingBalance(c.strength)));  // every club's bank
const ledger = ref<SeasonLedger | null>(null);
const leagueHandles = () => new Set(clubs.value.flatMap(c => c.team.players.map(p => p.handle)));
const marketSeed = () => (seasonSeed.value ^ (season.value * 0x85ebca6b)) >>> 0;
const freeAgentPool = shallowRef<Player[]>(freeAgents(marketSeed(), leagueHandles()));  // unowned, mutable
const listings = shallowRef<{ club: number; playerId: string }[]>(aiListings(clubs.value, myClub.value));  // AI players for sale
const myListed = ref<Set<string>>(new Set());          // your player ids put up for sale

const balance = computed(() => balances.value[myClub.value]);

let nav: Navmesh | null = null;

const table = computed(() => standings(N, results.value));
const total = computed(() => schedule.value.length);
const done = computed(() => dayIdx.value >= total.value);
const myTeam = computed(() => clubs.value[myClub.value].team);
const rankOf = (i: number) => table.value.findIndex(s => s.club === i) + 1;
const myStanding = computed(() => table.value.find(s => s.club === myClub.value));
const myResults = computed(() => results.value.filter(r => r.home === myClub.value || r.away === myClub.value));
const nextFixture = computed(() => done.value ? null
  : schedule.value[dayIdx.value].find(f => f.home === myClub.value || f.away === myClub.value) ?? null);
const nextOpponent = computed(() => {
  const fx = nextFixture.value ?? schedule.value[0].find(f => f.home === myClub.value || f.away === myClub.value)!;
  return fx.home === myClub.value ? fx.away : fx.home;
});
// the always-open board: free agents + every AI club's listed player (resolved
// live so it reflects development; stale listings are filtered out)
const market = computed<MarketEntry[]>(() => [
  ...freeAgentPool.value.map(p => ({ player: p, from: -1 })),
  ...listings.value
    .map(l => ({ player: clubs.value[l.club].team.players.find(p => p.id === l.playerId), from: l.club }))
    .filter((e): e is MarketEntry => !!e.player),
]);

// build a fixture's MatchInput, overlaying YOUR comp + tactics when you play
function buildInput(fx: { home: number; away: number }, seed: number): MatchInput {
  const tac = (i: number) => i === myClub.value ? clone(myTactics.value) : clubs.value[i].tactics;
  const cmp = (i: number) => i === myClub.value ? clone(myComp.value) : {};
  return {
    seed, map: MAP, patch: PATCH,
    teams: [clubs.value[fx.home].team, clubs.value[fx.away].team],
    tactics: [tac(fx.home), tac(fx.away)],
    comp: [cmp(fx.home), cmp(fx.away)],
  };
}
function simFixture(fx: { home: number; away: number }, seed: number): MatchResult {
  const [hs, as] = simulateMatch(buildInput(fx, seed), nav!, RESOLVE_FORKS).finalScore;
  return { home: fx.home, away: fx.away, score: [hs, as], winner: hs > as ? fx.home : fx.away, seed };
}
function resolveDay() {
  if (done.value || !nav) return;
  const fresh = schedule.value[dayIdx.value].map((fx, slot) => simFixture(fx, fixtureSeed(seasonSeed.value, dayIdx.value, slot)));
  results.value = [...results.value, ...fresh];
  dayIdx.value++;
  resolveListings();   // the market is always live — your listed players may sell each match-day
}
function simSeason() { while (!done.value) resolveDay(); }

// the off-season: settle EVERY club's books by final rank, then develop every
// squad, then refresh the board. Your authored tactics/comp carry over (player
// ids are stable through a tick).
function advanceSeason() {
  if (!done.value) return;
  balances.value = balances.value.map((b, i) => b + settleSeason(clubs.value[i].team, rankOf(i), N, season.value).net);
  ledger.value = settleSeason(myTeam.value, rankOf(myClub.value), N, season.value);
  prevById.value = new Map(clubs.value.flatMap(c => c.team.players.map(p =>
    [p.id, { age: p.age, attr: { ...p.attr } }] as const)));
  clubs.value = developLeague(clubs.value, new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9)) >>> 0));
  season.value++;
  results.value = []; dayIdx.value = 0;
  refreshMarket();
}
function refreshMarket() {
  freeAgentPool.value = freeAgents(marketSeed(), leagueHandles());
  listings.value = aiListings(clubs.value, myClub.value);
  myListed.value = new Set();
}
function selectClub(i: number) {
  myClub.value = i;
  myComp.value = {};
  myTactics.value = clone(clubs.value[i].tactics);
  ledger.value = null;
  listings.value = aiListings(clubs.value, i);
  myListed.value = new Set();
}
function newWorld(s = Math.floor(Math.random() * 100000)) {
  seasonSeed.value = s;
  clubs.value = makeLeague(s, N);
  schedule.value = doubleRoundRobin(N);
  results.value = []; dayIdx.value = 0; season.value = 1;
  prevById.value = new Map();
  myComp.value = {};
  myTactics.value = clone(clubs.value[myClub.value].tactics);
  balances.value = clubs.value.map(c => startingBalance(c.strength));
  ledger.value = null;
  refreshMarket();
}

// --- the always-open market --------------------------------------------------
const myPlayerOf = (role: string) => myTeam.value.players.find(p => p.role === role);
const netFee = (e: MarketEntry) => playerValue(e.player) - playerValue(myPlayerOf(e.player.role)!);  // <0 = you bank cash
const canAfford = (e: MarketEntry) => netFee(e) <= balance.value;
const isListed = (id: string) => myListed.value.has(id);

const withPlayer = (c: Club, idx: number, p: Player): Club => {
  const team = { ...c.team, players: c.team.players.map((q, i) => i === idx ? p : q) };
  return { ...c, team, strength: clampStr(squadRating(team) / 100) };
};
const remap = (oldId: string, newId: string) => {
  myTactics.value = JSON.parse(JSON.stringify(myTactics.value).split(oldId).join(newId));
  if (myComp.value[oldId]) { const c = { ...myComp.value }; delete c[oldId]; myComp.value = c; }
};
const retag = (p: Player, clubId: string, igl?: boolean): Player => ({ ...p, id: `${clubId}-${p.handle.toLowerCase()}`, igl });
const release = (p: Player): Player => ({ ...p, id: `fa-${p.handle.toLowerCase()}`, igl: false });

// a club that lost a player restocks from free agency — the best same-role free
// agent (or, if the pool is dry there, a generated journeyman). Pure deterministic
// generation (no Math.random), keyed by a move counter.
let moveSeq = 0;
function backfillFor(role: Role): Player {
  const same = freeAgentPool.value.filter(p => p.role === role).sort((a, b) => playerValue(b) - playerValue(a));
  if (same.length) { freeAgentPool.value = freeAgentPool.value.filter(p => p !== same[0]); return same[0]; }
  const used = new Set([...leagueHandles(), ...freeAgentPool.value.map(p => p.handle)]);
  const handle = HANDLES.find(h => !used.has(h)) ?? `Sub${moveSeq}`;
  return makePlayer(new Rng((seasonSeed.value ^ (++moveSeq * 0x9e3779b9)) >>> 0), role, handle, 'fa', 0.4);
}

/** A transfer is a cash purchase, not a player-for-player swap: `buyer` pays for
 *  `sellerPlayerId`; the buyer's same-role player is released to free agency; and
 *  the seller takes the cash and restocks that slot from free agency. The whole
 *  market — your buy, your sale, AI moves — reduces to this one move. */
function trade(buyerIdx: number, sellerIdx: number, sellerPlayerId: string) {
  const buyer = clubs.value[buyerIdx], seller = clubs.value[sellerIdx];
  const sIdx = seller.team.players.findIndex(p => p.id === sellerPlayerId);
  if (sIdx < 0) return;
  const incoming = seller.team.players[sIdx];
  const bIdx = buyer.team.players.findIndex(p => p.role === incoming.role);
  const buyerOld = buyer.team.players[bIdx];
  const fee = playerValue(incoming) - playerValue(buyerOld);
  const toBuyer = retag(incoming, buyer.team.id, buyerOld.igl);
  const toSeller = retag(backfillFor(incoming.role as Role), seller.team.id, incoming.igl);  // seller restocks from FA
  clubs.value = clubs.value.map((c, i) => i === buyerIdx ? withPlayer(c, bIdx, toBuyer)
    : i === sellerIdx ? withPlayer(c, sIdx, toSeller) : c);
  balances.value = balances.value.map((b, i) => i === buyerIdx ? b - fee : i === sellerIdx ? b + fee : b);
  freeAgentPool.value = [release(buyerOld), ...freeAgentPool.value];   // your dropped player → free agency, not the seller
  if (buyerIdx === myClub.value) remap(buyerOld.id, toBuyer.id);
  if (sellerIdx === myClub.value) remap(incoming.id, toSeller.id);
  listings.value = listings.value.filter(l => l.playerId !== sellerPlayerId);
  if (myListed.value.has(sellerPlayerId)) { const s = new Set(myListed.value); s.delete(sellerPlayerId); myListed.value = s; }
}

/** You acquire a market entry — a free agent (swap through the unowned pool) or
 *  an AI club's listed player (a direct trade). */
function acquire(e: MarketEntry) {
  if (!canAfford(e)) return;
  if (e.from >= 0) { trade(myClub.value, e.from, e.player.id); return; }
  // free agent: your same-role player is released to the pool, the FA joins you
  const team = clubs.value[myClub.value].team;
  const idx = team.players.findIndex(p => p.role === e.player.role);
  const old = team.players[idx];
  const fee = playerValue(e.player) - playerValue(old);
  const signed = retag(e.player, team.id, old.igl);
  clubs.value = clubs.value.map((c, i) => i === myClub.value ? withPlayer(c, idx, signed) : c);
  balances.value = balances.value.map((b, i) => i === myClub.value ? b - fee : b);
  remap(old.id, signed.id);
  freeAgentPool.value = [release(old), ...freeAgentPool.value.filter(p => p.id !== e.player.id)];
}

/** Put one of your players up for sale (toggle). A listed player may be bought
 *  by an AI club on any match-day (resolveListings). */
function toggleList(id: string) {
  const s = new Set(myListed.value);
  s.has(id) ? s.delete(id) : s.add(id);
  myListed.value = s;
}
/** The market is always live: each match-day, an AI club that would upgrade by
 *  signing one of your listed players (and can afford it) buys them — you get
 *  their same-role player plus the cash difference. */
function resolveListings() {
  for (const pid of [...myListed.value]) {
    const mine = myTeam.value.players.find(p => p.id === pid);
    if (!mine) { const s = new Set(myListed.value); s.delete(pid); myListed.value = s; continue; }
    const buyer = clubs.value.findIndex((_, i) => i !== myClub.value && aiWantsToBuy(clubs.value, balances.value, i, mine));
    if (buyer >= 0) trade(buyer, myClub.value, pid);
  }
}
async function ensureNav() { if (!nav) nav = await fetch(`/${MAP}.navmesh.json`).then(r => r.json()); }
const getNav = () => nav;

export function useWorld() {
  return {
    N, MAP, seasonSeed, clubs, schedule, results, dayIdx, myClub, season, prevById,
    myComp, myTactics, balance, balances, ledger, market, myListed,
    table, total, done, myTeam, rankOf, myStanding, myResults, nextFixture, nextOpponent,
    buildInput, simFixture, resolveDay, simSeason, advanceSeason, selectClub, newWorld, ensureNav, getNav,
    myPlayerOf, netFee, canAfford, isListed, acquire, toggleList,
  };
}
