// The shared single-player world — one reactive store both the HQ/Season screen
// and the Tactics Editor read from. A whole career is a function of one seed
// (@ace/world), resolved client-side by the same engine the server worker will
// run. Your club gets two manager overlays the AI clubs don't: an authored comp
// and authored tactics, both injected into your fixtures.
import { computed, ref, shallowRef } from 'vue';
import type { Attributes, Comp, MapId, MatchInput, PatchState, Player, Role, Tactics } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch, PATCH, Rng } from '@ace/engine';
import {
  makeLeague, doubleRoundRobin, standings, fixtureSeed, developLeague, developPlayer, makePlayer, HANDLES,
  startingBalance, settleSeason, freeAgents, playerValue, squadRating, overall, aiListings, aiWantsToBuy,
  seasonIncome, playerWage, ROLE_AGENTS, fullPatch, patchMeta, type MetaChange,
  type Club, type MatchResult, type Matchday, type SeasonLedger,
} from '@ace/world';

const ALL_AGENTS = Object.values(ROLE_AGENTS).flat();

export const N = 8;
export const MAP: MapId = 'ascent';
const RESOLVE_FORKS = 3;            // standings only need the final score
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const clampStr = (s: number) => Math.max(0.3, Math.min(0.95, s));

// the comp shape — how many of each role the matchday five needs
const ROLE_NEED: Record<string, number> = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 };

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
const myRoster = ref<Player[]>([...clubs.value[myClub.value].team.players]);  // your FULL squad (≥5; the matchday five is derived)
const balances = ref<number[]>(clubs.value.map(c => startingBalance(c.strength)));  // every club's bank
const ledger = ref<SeasonLedger | null>(null);
const leagueHandles = () => new Set(clubs.value.flatMap(c => c.team.players.map(p => p.handle)));
const marketSeed = () => (seasonSeed.value ^ (season.value * 0x85ebca6b)) >>> 0;
const freeAgentPool = shallowRef<Player[]>(freeAgents(marketSeed(), leagueHandles()));  // unowned, mutable
const listings = shallowRef<{ club: number; playerId: string }[]>(aiListings(clubs.value, myClub.value));  // AI players for sale
const myListed = ref<Set<string>>(new Set());          // your player ids put up for sale
const patch = ref<PatchState>(fullPatch(PATCH, ALL_AGENTS));   // the live agent meta
const metaChanges = ref<MetaChange[]>([]);             // last off-season's patch notes
const forcedStart = ref<Set<string>>(new Set());       // manual lineup: pinned to the XI
const forcedBench = ref<Set<string>>(new Set());       // manual lineup: pinned to reserves

const balance = computed(() => balances.value[myClub.value]);
// value reflects the live meta — buffed-agent mains are worth more
const value = (p: Player) => playerValue(p, patch.value);

// the matchday five is always the best player per comp slot from your roster;
// the rest are reserves (depth). One IGL — the starting sentinel.
function startingFive(roster: Player[]): Player[] {
  const five: Player[] = [];
  (['duelist', 'initiator', 'controller', 'sentinel'] as const).forEach(role => {
    const need = ROLE_NEED[role];
    const inRole = roster.filter(p => p.role === role);
    const playable = inRole.filter(p => !forcedBench.value.has(p.id));
    const forced = playable.filter(p => forcedStart.value.has(p.id)).sort((a, b) => overall(b) - overall(a));
    const auto = playable.filter(p => !forcedStart.value.has(p.id)).sort((a, b) => overall(b) - overall(a));
    const picked = [...forced, ...auto].slice(0, need);
    if (picked.length < need) {   // benched too many — never field fewer than five
      const spare = inRole.filter(p => !picked.includes(p)).sort((a, b) => overall(b) - overall(a));
      picked.push(...spare.slice(0, need - picked.length));
    }
    five.push(...picked);
  });
  return five.map(p => ({ ...p, igl: p.role === 'sentinel' }));
}
// re-derive your club's fielded team from the roster (called after any roster change)
function syncLineup() {
  pruneForced();
  const team = { ...clubs.value[myClub.value].team, players: startingFive(myRoster.value) };
  clubs.value = clubs.value.map((c, i) => i === myClub.value ? { ...c, team, strength: clampStr(squadRating(team) / 100) } : c);
}
const isStarter = (id: string) => clubs.value[myClub.value].team.players.some(p => p.id === id);

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
    seed, map: MAP, patch: patch.value,
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
  // settle every club; YOUR wage bill is over the whole roster (depth costs money)
  const inc = seasonIncome(rankOf(myClub.value), N);
  const myWages = myRoster.value.reduce((s, p) => s + playerWage(p), 0);
  ledger.value = { season: season.value, sponsor: inc.sponsor, prize: inc.prize, wages: myWages, net: inc.sponsor + inc.prize - myWages };
  balances.value = balances.value.map((b, i) =>
    i === myClub.value ? b + ledger.value!.net : b + settleSeason(clubs.value[i].team, rankOf(i), N, season.value).net);
  // snapshot (whole roster) for deltas, then develop the league + your reserves
  prevById.value = new Map([
    ...clubs.value.flatMap(c => c.team.players.map(p => [p.id, { age: p.age, attr: { ...p.attr } }] as const)),
    ...myRoster.value.map(p => [p.id, { age: p.age, attr: { ...p.attr } }] as const),
  ]);
  const rng = new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9)) >>> 0);
  clubs.value = developLeague(clubs.value, rng);
  myRoster.value = myRoster.value.map(p => developPlayer(p, rng));
  // the meta shifts each off-season — a new patch buffs/nerfs agents, moving values
  const m = patchMeta(patch.value, new Rng((seasonSeed.value ^ (season.value * 0x27d4eb2f)) >>> 0));
  patch.value = m.patch; metaChanges.value = m.changes;
  syncLineup();
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
  myRoster.value = [...clubs.value[i].team.players];
  ledger.value = null;
  listings.value = aiListings(clubs.value, i);
  myListed.value = new Set();
  forcedStart.value = new Set(); forcedBench.value = new Set();
  syncLineup();
}
function newWorld(s = Math.floor(Math.random() * 100000)) {
  seasonSeed.value = s;
  clubs.value = makeLeague(s, N);
  schedule.value = doubleRoundRobin(N);
  results.value = []; dayIdx.value = 0; season.value = 1;
  prevById.value = new Map();
  myComp.value = {};
  myTactics.value = clone(clubs.value[myClub.value].tactics);
  myRoster.value = [...clubs.value[myClub.value].team.players];
  balances.value = clubs.value.map(c => startingBalance(c.strength));
  ledger.value = null;
  patch.value = fullPatch(PATCH, ALL_AGENTS); metaChanges.value = [];
  forcedStart.value = new Set(); forcedBench.value = new Set();
  refreshMarket();
}

// --- the always-open market: rosters carry depth, the matchday five is derived
const myRosterRole = (role: string) => myRoster.value.filter(p => p.role === role).sort((a, b) => overall(b) - overall(a));
const myPlayerOf = (role: string) => myRosterRole(role)[0];           // your best in the role (the upgrade hint)
const canAfford = (e: MarketEntry) => value(e.player) <= balance.value;
const isListed = (id: string) => myListed.value.has(id);
// you can sell unless it would leave the comp short of a role — the "valid five" floor
const canSell = (id: string) => {
  const p = myRoster.value.find(x => x.id === id);
  return !!p && myRoster.value.filter(x => x.id !== id && x.role === p.role).length >= ROLE_NEED[p.role];
};

const withPlayer = (c: Club, idx: number, p: Player): Club => {
  const team = { ...c.team, players: c.team.players.map((q, i) => i === idx ? p : q) };
  return { ...c, team, strength: clampStr(squadRating(team) / 100) };
};
const retag = (p: Player, clubId: string, igl?: boolean): Player => ({ ...p, id: `${clubId}-${p.handle.toLowerCase()}`, igl });
const release = (p: Player): Player => ({ ...p, id: `fa-${p.handle.toLowerCase()}`, igl: false });
const unlist = (id: string) => { if (myListed.value.has(id)) { const s = new Set(myListed.value); s.delete(id); myListed.value = s; } };

// a (non-you) club that lost a player restocks the slot from free agency — the
// best same-role free agent, or a deterministically generated journeyman if dry.
let moveSeq = 0;
function backfillFor(role: Role): Player {
  const same = freeAgentPool.value.filter(p => p.role === role).sort((a, b) => playerValue(b) - playerValue(a));
  if (same.length) { freeAgentPool.value = freeAgentPool.value.filter(p => p !== same[0]); return same[0]; }
  const used = new Set([...leagueHandles(), ...freeAgentPool.value.map(p => p.handle)]);
  const handle = HANDLES.find(h => !used.has(h)) ?? `Sub${moveSeq}`;
  return makePlayer(new Rng((seasonSeed.value ^ (++moveSeq * 0x9e3779b9)) >>> 0), role, handle, 'fa', 0.4);
}
function sellerRestock(clubIdx: number, playerId: string) {
  const team = clubs.value[clubIdx].team;
  const idx = team.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;
  const old = team.players[idx];
  const fill = retag(backfillFor(old.role as Role), team.id, old.igl);
  clubs.value = clubs.value.map((c, i) => i === clubIdx ? withPlayer(c, idx, fill) : c);
}

/** Buy a market player — they JOIN your roster (no forced drop) at the full
 *  price. A free agent leaves the unowned pool; a club sale pays the seller, who
 *  restocks that slot from free agency. The matchday five is re-derived. */
function acquire(e: MarketEntry) {
  if (!canAfford(e)) return;
  const price = value(e.player);
  myRoster.value = [...myRoster.value, retag(e.player, clubs.value[myClub.value].team.id, false)];
  balances.value = balances.value.map((b, i) => i === myClub.value ? b - price : b);
  if (e.from === -1) {
    freeAgentPool.value = freeAgentPool.value.filter(p => p.id !== e.player.id);
  } else {
    balances.value = balances.value.map((b, i) => i === e.from ? b + price : b);
    sellerRestock(e.from, e.player.id);
    listings.value = listings.value.filter(l => !(l.club === e.from && l.playerId === e.player.id));
  }
  syncLineup();
}

/** Sell one of your players for their value (released to free agency). Blocked
 *  when it would break a valid five. */
function sellPlayer(id: string) {
  const p = myRoster.value.find(x => x.id === id);
  if (!p || !canSell(id)) return;
  myRoster.value = myRoster.value.filter(x => x.id !== id);
  balances.value = balances.value.map((b, i) => i === myClub.value ? b + value(p) : b);
  freeAgentPool.value = [release(p), ...freeAgentPool.value];
  unlist(id);
  syncLineup();
}

// --- manual lineup override: start a reserve / bench a starter ---------------
const isStarterPinned = (id: string) => forcedStart.value.has(id);
const isBenched = (id: string) => forcedBench.value.has(id);
// you can bench a starter only if another same-role player can cover the slot
const canBench = (id: string) => {
  const p = myRoster.value.find(x => x.id === id);
  if (!p) return false;
  return myRoster.value.filter(x => x.id !== id && x.role === p.role && !forcedBench.value.has(x.id)).length >= ROLE_NEED[p.role];
};
function startReserve(id: string) {   // pin a reserve into the XI
  const s = new Set(forcedStart.value); s.add(id); forcedStart.value = s;
  if (forcedBench.value.has(id)) { const b = new Set(forcedBench.value); b.delete(id); forcedBench.value = b; }
  syncLineup();
}
function benchStarter(id: string) {   // pin a starter to the reserves
  if (!canBench(id)) return;
  const b = new Set(forcedBench.value); b.add(id); forcedBench.value = b;
  if (forcedStart.value.has(id)) { const s = new Set(forcedStart.value); s.delete(id); forcedStart.value = s; }
  syncLineup();
}
function pruneForced() {   // drop pins for players no longer on the roster
  const ids = new Set(myRoster.value.map(p => p.id));
  forcedStart.value = new Set([...forcedStart.value].filter(id => ids.has(id)));
  forcedBench.value = new Set([...forcedBench.value].filter(id => ids.has(id)));
}

/** Put a player up for sale (toggle). A listed player may be bought by a rival
 *  on any match-day (resolveListings). */
function toggleList(id: string) {
  const s = new Set(myListed.value); s.has(id) ? s.delete(id) : s.add(id); myListed.value = s;
}
/** Each match-day, a rival that would upgrade by signing one of your listed
 *  players (and can afford the full price) buys them for cash — provided the sale
 *  still leaves you a valid five. Their replaced starter goes to free agency. */
function resolveListings() {
  for (const pid of [...myListed.value]) {
    const mine = myRoster.value.find(p => p.id === pid);
    if (!mine) { unlist(pid); continue; }
    if (!canSell(pid)) continue;
    const buyer = clubs.value.findIndex((_, i) => i !== myClub.value && aiWantsToBuy(clubs.value, balances.value, i, mine));
    if (buyer < 0) continue;
    const price = value(mine);
    const bteam = clubs.value[buyer].team;
    const bIdx = bteam.players.findIndex(p => p.role === mine.role);
    const bOld = bteam.players[bIdx];
    clubs.value = clubs.value.map((c, i) => i === buyer ? withPlayer(c, bIdx, retag(mine, bteam.id, bOld.igl)) : c);
    freeAgentPool.value = [release(bOld), ...freeAgentPool.value];
    balances.value = balances.value.map((b, i) => i === buyer ? b - price : i === myClub.value ? b + price : b);
    myRoster.value = myRoster.value.filter(p => p.id !== pid);
    unlist(pid);
    syncLineup();
  }
}
async function ensureNav() { if (!nav) nav = await fetch(`/${MAP}.navmesh.json`).then(r => r.json()); }
const getNav = () => nav;

export function useWorld() {
  return {
    N, MAP, seasonSeed, clubs, schedule, results, dayIdx, myClub, season, prevById,
    myComp, myTactics, myRoster, balance, balances, ledger, market, myListed, patch, metaChanges,
    table, total, done, myTeam, rankOf, myStanding, myResults, nextFixture, nextOpponent,
    buildInput, simFixture, resolveDay, simSeason, advanceSeason, selectClub, newWorld, ensureNav, getNav,
    myPlayerOf, value, canAfford, isStarter, isListed, canSell, acquire, sellPlayer, toggleList,
    canBench, isBenched, isStarterPinned, startReserve, benchStarter,
  };
}
