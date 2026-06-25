// The shared single-player world — one reactive store both the HQ/Season screen
// and the Tactics Editor read from. A whole career is a function of one seed
// (@ace/world), resolved client-side by the same engine the server worker will
// run. Your club gets two manager overlays the AI clubs don't: an authored comp
// and authored tactics, both injected into your fixtures.
import { computed, ref, shallowRef, watch } from 'vue';
import type { Attributes, Comp, MapId, MatchInput, PatchState, Player, Role, Tactics } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch, PATCH, Rng } from '@ace/engine';
import {
  makeLeague, standings, developLeague, developPlayer, developInSeason, SEASON_SHARE, makePlayer, HANDLES,
  shouldRetire, clubPhase, clubAgeChar,
  startingBalance, freeAgents, playerValue, squadRating, overall, aiListings, aiWantsToBuy, topRivalBid,
  ROLE_AGENTS, fullPatch, patchMeta, runPlayoffs, finishOf, playoffPrize,
  membersOf, divisionSchedule, promoteRelegate,
  buildMatchInput, quickResult as quickResultPure, resolveWorldDay, settleClub, squadWageBill, mapAffinity,
  defaultFacilities, facilityBoost, facilityCost, facilityUpkeep, FACILITY_MAX,
  clubInfra, infraBoost, INFRA_MAX, NO_BOOST,
  defaultAcademy, academyIntake, academyCost, academyUpkeep, academyWageBill, intakeSize, ACADEMY_MAX,
  type MetaChange, type Club, type MatchResult, type Matchday, type SeasonLedger, type Bracket, type DivMove, type Standing,
  type Facilities, type FacilityId, type Academy,
} from '@ace/world';

const ALL_AGENTS = Object.values(ROLE_AGENTS).flat();

// the full rank pyramid: DIVS tiers of DIV_SIZE clubs — the pro leagues at the
// top, the solo-queue rank ladder below. N is the TOTAL world size. Only YOUR
// tier is resolved by the full engine; the rest are quick-resolved by strength
// (cheap + deterministic), so a 110-club world still sims a season in a blink.
export const DIV_NAMES = ['Premier', 'Challengers', 'Radiant', 'Immortal', 'Ascendant', 'Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Iron'];
export const DIV_SIZE = 10;
export const DIVS = DIV_NAMES.length;   // 11
export const PROMO = 2;                 // clubs promoted/relegated between tiers each season
export const N = DIV_SIZE * DIVS;       // total clubs in the world (110)
export const START_TIER = 7;            // you begin mid-table in Gold — a long climb to the Premier
export const MAP: MapId = 'ascent';                 // the editor's map (your authored plays live here)
// the competitive pool — the maps that play balanced today (`pnpm balance`).
// Fixtures rotate over these; the other 6 are out of rotation until tuned.
export const MAP_POOL: MapId[] = ['ascent', 'breeze', 'haven', 'lotus', 'split'];
export const fixtureMap = (seed: number): MapId => MAP_POOL[(seed >>> 0) % MAP_POOL.length];
const RESOLVE_FORKS = 0;            // standings only need the final score (fork-independent)
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const clampStr = (s: number) => Math.max(0.3, Math.min(0.95, s));

// the comp shape — how many of each role the matchday five needs
const ROLE_NEED: Record<string, number> = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 };

/** A buyable slot on the always-open market: a player + where they come from
 *  (`from === -1` a free agent, else the club index selling them). */
export interface MarketEntry { player: Player; from: number }

// the initial split: makeLeague descends in strength, so the strongest DIV_SIZE
// clubs seed the Premier, the next the Challengers, on down to Iron at the foot.
const initialDivision = () => Array.from({ length: N }, (_, i) => Math.min(DIVS - 1, Math.floor(i / DIV_SIZE)));
const divSchedules = (division: number[]): Matchday[][] =>
  Array.from({ length: DIVS }, (_, d) => divisionSchedule(membersOf(division, d)));

const seasonSeed = ref(7);
const clubs = shallowRef<Club[]>(makeLeague(seasonSeed.value, N));
const division = ref<number[]>(initialDivision());   // club index → tier (0 = Premier)
const schedules = shallowRef<Matchday[][]>(divSchedules(division.value));  // one schedule per division
const lastMoves = ref<DivMove[]>([]);                // last off-season's promotions/relegations
const results = ref<MatchResult[]>([]);
const dayIdx = ref(0);
const myClub = ref(START_TIER * DIV_SIZE + 5);   // start mid-table in Gold — a club to climb
const season = ref(1);
const prevById = ref<Map<string, { age: number; attr: Attributes }>>(new Map());  // season-start snapshot, for roster deltas (set below)
const myComp = ref<Comp>({});                          // your authored comp (overlay)
const myTactics = ref<Tactics>(clone(clubs.value[myClub.value].tactics));  // your authored tactics (overlay)
const myRoster = ref<Player[]>([...clubs.value[myClub.value].team.players]);  // your FULL squad (≥5; the matchday five is derived)
// a development baseline — deltas on the roster screen show change since the
// start of the season (in-season progress) + the off-season jump
function snapRosters() {
  return new Map<string, { age: number; attr: Attributes }>([
    ...clubs.value.flatMap(c => c.team.players.map(p => [p.id, { age: p.age, attr: { ...p.attr } }] as const)),
    ...myRoster.value.map(p => [p.id, { age: p.age, attr: { ...p.attr } }] as const),
  ]);
}
prevById.value = snapRosters();   // season-1 baseline (hydrate overrides if a save loads)
const balances = ref<number[]>(clubs.value.map(c => startingBalance(c.strength)));  // every club's bank
const ledger = ref<SeasonLedger | null>(null);
const leagueHandles = () => new Set(clubs.value.flatMap(c => c.team.players.map(p => p.handle)));
const marketSeed = () => (seasonSeed.value ^ (season.value * 0x85ebca6b)) >>> 0;
// on a deep ladder, the transfer board only lists clubs within a tier of you —
// realistic reach, and a browsable board (you can't sign a Premier star in Iron)
const marketEligible = () => {
  const d = division.value[myClub.value];
  return new Set(clubs.value.map((_, i) => i).filter(i => Math.abs(division.value[i] - d) <= 1));
};
const freeAgentPool = shallowRef<Player[]>(freeAgents(marketSeed(), leagueHandles()));  // unowned, mutable
const listings = shallowRef<{ club: number; playerId: string }[]>(aiListings(clubs.value, myClub.value, marketEligible()));  // AI players for sale
const myListed = ref<Set<string>>(new Set());          // your player ids put up for sale
const patch = ref<PatchState>(fullPatch(PATCH, ALL_AGENTS));   // the live agent meta
const metaChanges = ref<MetaChange[]>([]);             // last off-season's patch notes
const playoffs = shallowRef<Bracket | null>(null);    // this season's bracket (null until the regular season ends)
const titles = ref<number[]>(clubs.value.map(() => 0));  // career championships per club
const forcedStart = ref<Set<string>>(new Set());       // manual lineup: pinned to the XI
const forcedBench = ref<Set<string>>(new Set());       // manual lineup: pinned to reserves
const facilities = ref<Facilities>(defaultFacilities());  // your HQ rooms (boost YOUR roster's development)
const academy = ref<Academy>(defaultAcademy());           // your youth pipeline (homegrown prospects)
// last off-season's retirements (league-wide; `mine` flags your own) — for the banner
const retirements = ref<{ handle: string; age: number; role: string; overall: number; club: number; mine: boolean }[]>([]);

const balance = computed(() => balances.value[myClub.value]);
// value reflects the live meta — buffed-agent mains are worth more
const value = (p: Player) => playerValue(p, patch.value);

// --- facilities (the HQ): upgrade rooms to compound your squad's development ---
const facBoost = computed(() => facilityBoost(facilities.value));
const facCost = (id: FacilityId) => facilityCost(facilities.value[id]);
const canUpgradeFacility = (id: FacilityId) => facilities.value[id] < FACILITY_MAX && balance.value >= facCost(id);
function upgradeFacility(id: FacilityId) {
  if (!canUpgradeFacility(id)) return;
  const cost = facCost(id);
  balances.value = balances.value.map((b, i) => i === myClub.value ? b - cost : b);
  facilities.value = { ...facilities.value, [id]: facilities.value[id] + 1 };
}

// --- the academy (the youth pipeline): build the wing, take an annual intake of
// teenage prospects, develop them on a reps path, graduate the hits into your squad
const acadCost = () => academyCost(academy.value.level);
const canUpgradeAcademy = () => academy.value.level < ACADEMY_MAX && balance.value >= acadCost();
const acadIntakeSize = () => intakeSize(academy.value.level);
// every handle already in the world — a new intake must be disjoint (unique handles)
const allHandles = () => new Set<string>([
  ...clubs.value.flatMap(c => c.team.players.map(p => p.handle)),
  ...freeAgentPool.value.map(p => p.handle), ...myRoster.value.map(p => p.handle),
  ...academy.value.prospects.map(p => p.handle),
]);
/** Take this season's intake once (level > 0, not already taken) — a deterministic
 *  class of prospects appended to the academy. Auto-run each new season + on the
 *  first upgrade, so a fresh academy delivers immediately. */
function runIntake() {
  if (academy.value.level === 0 || academy.value.lastIntake >= season.value) return;
  const fresh = academyIntake(seasonSeed.value, season.value, academy.value.level, allHandles());
  academy.value = { ...academy.value, prospects: [...academy.value.prospects, ...fresh], lastIntake: season.value };
}
function upgradeAcademy() {
  if (!canUpgradeAcademy()) return;
  const cost = acadCost();
  balances.value = balances.value.map((b, i) => i === myClub.value ? b - cost : b);
  academy.value = { ...academy.value, level: academy.value.level + 1 };
  runIntake();   // a fresh wing delivers its first class right away
}
/** Graduate a prospect into your senior roster — no fee, retagged to your club.
 *  The matchday five re-derives (he competes for a slot like any signing). */
function promoteProspect(id: string) {
  const p = academy.value.prospects.find(x => x.id === id);
  if (!p) return;
  academy.value = { ...academy.value, prospects: academy.value.prospects.filter(x => x.id !== id) };
  myRoster.value = [...myRoster.value, retag(p, clubs.value[myClub.value].team.id, false)];
  syncLineup();
}
/** Cut a prospect from the academy (a youth you've given up on). */
function releaseProspect(id: string) {
  academy.value = { ...academy.value, prospects: academy.value.prospects.filter(x => x.id !== id) };
}
// a club's development infrastructure (0..INFRA_MAX), for the standings — your own
// real HQ investment for your club, the strength-derived rating for the AI orgs.
// A high rating flags a rival that out-develops + reloads talent: a long-term threat.
const infraLevel = (i: number): number => i === myClub.value
  ? Math.round((facilities.value.bootcamp + facilities.value.recovery + facilities.value.analyst + academy.value.level) / 4)
  : clubInfra(clubs.value[i].strength);

// global rankings (cross-division, the whole world) — POWER by current squad
// rating, HQ by development infrastructure. A finer metric breaks ties (strength
// under HQ) so the boards are a true order, not a pile of ties.
const powerOf = (i: number) => squadRating(clubs.value[i].team);
const powerRanking = computed(() => clubs.value
  .map((_, i) => ({ club: i, rating: powerOf(i), hq: infraLevel(i) }))
  .sort((a, b) => b.rating - a.rating || b.hq - a.hq));
const hqRanking = computed(() => clubs.value
  .map((c, i) => ({ club: i, rating: powerOf(i), hq: infraLevel(i), strength: c.strength }))
  .sort((a, b) => b.hq - a.hq || b.strength - a.strength));
const rankInList = (list: { club: number }[], i: number) => list.findIndex(r => r.club === i) + 1;

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

const navs: Partial<Record<MapId, Navmesh>> = {};   // one navmesh per pool map (lazy-loaded)
let navReady = false;
const navOf = (m: MapId): Navmesh | null => navs[m] ?? null;

const myDivision = computed(() => division.value[myClub.value]);
const mySchedule = computed(() => schedules.value[myDivision.value]);
// a division's table: only that tier's games, only that tier's clubs.
const tableOf = (d: number): Standing[] =>
  standings(N, results.value.filter(r => division.value[r.home] === d)).filter(s => division.value[s.club] === d);
const table = computed(() => tableOf(myDivision.value));   // your tier's table (drives playoffs, rank, standing)
const total = computed(() => schedules.value[0].length);
const done = computed(() => dayIdx.value >= total.value);
const myTeam = computed(() => clubs.value[myClub.value].team);
// rank is WITHIN a club's own division
const rankOf = (i: number) => tableOf(division.value[i]).findIndex(s => s.club === i) + 1;
const myStanding = computed(() => table.value.find(s => s.club === myClub.value));
const myResults = computed(() => results.value.filter(r => r.home === myClub.value || r.away === myClub.value));
const nextFixture = computed(() => done.value ? null
  : mySchedule.value[dayIdx.value].find(f => f.home === myClub.value || f.away === myClub.value) ?? null);
const nextOpponent = computed(() => {
  const fx = nextFixture.value ?? mySchedule.value[0].find(f => f.home === myClub.value || f.away === myClub.value)!;
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

// a club plays a touch better on its comfort maps (mapAffinity), worse on its
// weak ones — bump the fielded five's attrs by the map's affinity. This is what
// makes the playoff map veto strategic.
const AFFINITY_ATTRS = ['aim', 'movement', 'gameSense', 'utility', 'clutch', 'entry'] as const;
function withAffinity(team: Club['team'], m: MapId): Club['team'] {
  const d = mapAffinity(team.id, m);
  return { ...team, players: team.players.map(p => {
    const attr = { ...p.attr };
    for (const k of AFFINITY_ATTRS) attr[k] = Math.max(1, Math.min(99, attr[k] + d));
    return { ...p, attr };
  }) };
}
// build a fixture's MatchInput on its map (seed-derived, or an explicit veto map),
// overlaying YOUR comp + tactics + each club's map affinity. Your authored PLAYS
// are Ascent-coordinates, so on any other pool map they're dropped — your dials
// (map-agnostic) still apply.
function buildInput(fx: { home: number; away: number }, seed: number, map: MapId = fixtureMap(seed)): MatchInput {
  const tac = (i: number): Tactics => {
    if (i !== myClub.value) return clubs.value[i].tactics;
    const t = clone(myTactics.value);
    if (map !== MAP) { t.attack.play = undefined; t.defense.play = undefined; }
    return t;
  };
  const cmp = (i: number): Comp => i === myClub.value ? clone(myComp.value) : {};
  return buildMatchInput({
    seed, map, patch: patch.value,
    home: withAffinity(clubs.value[fx.home].team, map), away: withAffinity(clubs.value[fx.away].team, map),
    tactics: [tac(fx.home), tac(fx.away)], comp: [cmp(fx.home), cmp(fx.away)],
  });
}
function simFixture(fx: { home: number; away: number }, seed: number, map: MapId = fixtureMap(seed)): MatchResult {
  const [hs, as] = simulateMatch(buildInput(fx, seed, map), navOf(map)!, RESOLVE_FORKS).finalScore;
  return { home: fx.home, away: fx.away, score: [hs, as], winner: hs > as ? fx.home : fx.away, seed };
}
// distant tiers are quick-resolved from club strength (shared `quickResult`) —
// deterministic, plausible, never watched; your own tier always full-sims
const quickFixture = (fx: { home: number; away: number }, seed: number): MatchResult =>
  quickResultPure(fx.home, fx.away, clubs.value[fx.home].strength, clubs.value[fx.away].strength, seed);
function resolveDay() {
  if (done.value || !navReady) return;
  // the whole world advances each match-day (shared `resolveWorldDay`): your tier
  // full-sims (watchable), every other tier is quick-resolved by strength
  const fresh = resolveWorldDay({
    schedules: schedules.value, day: dayIdx.value, seasonSeed: seasonSeed.value,
    full: d => d === myDivision.value, sim: simFixture, quick: quickFixture,
  });
  results.value = [...results.value, ...fresh];
  // in-season development of YOUR squad: the five who played grow (reps), the
  // reserves grow less and rust — so playing a prospect develops him
  const fiveIds = new Set(clubs.value[myClub.value].team.players.map(p => p.id));
  const dr = new Rng((seasonSeed.value ^ (season.value * 0x2545f491) ^ (dayIdx.value * 0x9e3779b9)) >>> 0);
  const boost = facilityBoost(facilities.value);   // your HQ accelerates your squad's development
  myRoster.value = myRoster.value.map(p => developInSeason(p, fiveIds.has(p.id), total.value, dr, boost));
  // your academy prospects develop on the reps path (academy circuit: grow, no rust)
  // — a separate rng so it never perturbs the senior-roster stream
  if (academy.value.prospects.length) {
    const ar = new Rng((seasonSeed.value ^ (season.value * 0x85ebca6b) ^ (dayIdx.value * 0x27d4eb2f) ^ 0xACAD) >>> 0);
    academy.value = { ...academy.value, prospects: academy.value.prospects.map(p => developInSeason(p, 'academy', total.value, ar, boost)) };
  }
  dayIdx.value++;
  syncLineup();        // re-derive your five + strength from the developed roster
  resolveListings();   // the market is always live — your listed players may sell each match-day
}
function simSeason() { while (!done.value) resolveDay(); }

// the season climax: once the regular season is done, the top four seed a
// best-of-three single-elim bracket (1v4, 2v3 → final). Resolved with the SAME
// sim as fixtures (buildInput overlays your comp/tactics for your ties), so each
// game is re-simmable to watch. The champion banks a title.
function enterPlayoffs() {
  if (!done.value || playoffs.value || !navReady) return;
  const affinityOf = (c: number, m: MapId) => mapAffinity(clubs.value[c].team.id, m);
  const bracket = runPlayoffs(table.value, seasonSeed.value, season.value, MAP_POOL, affinityOf, (home, away, seed, map) => simFixture({ home, away }, seed, map));
  if (bracket.champion != null) titles.value = titles.value.map((t, i) => i === bracket.champion ? t + 1 : t);
  playoffs.value = bracket;
}

// the off-season: settle EVERY club's books by final rank in its OWN division
// (the top tier pays more), apply promotion/relegation, then develop every squad
// and refresh the board. Your authored tactics/comp carry over (ids are stable).
function advanceSeason() {
  if (!done.value) return;
  const bracket = playoffs.value;
  const tables = Array.from({ length: DIVS }, (_, d) => tableOf(d));   // final regular-season tables (pre-swap)
  const rankIn = (i: number) => tables[division.value[i]].findIndex(s => s.club === i) + 1;
  const poPrize = (i: number) => bracket ? playoffPrize(finishOf(bracket, i)) : 0;
  // settle every club by its division rank (shared `settleClub`); YOUR wage bill
  // is over the whole roster (depth), an AI club's over its five
  const settle = (i: number, wages: number) => settleClub({ rank: rankIn(i), divSize: DIV_SIZE, tier: division.value[i], wages, playoff: poPrize(i) });
  // wages are market-linked (meta) for every club; YOUR bill also carries the cheap
  // academy prospects + the recurring HQ/academy UPKEEP (a built HQ costs to run)
  const myWages = squadWageBill(myRoster.value, patch.value) + academyWageBill(academy.value.prospects);
  const myUpkeep = facilityUpkeep(facilities.value) + academyUpkeep(academy.value.level);
  ledger.value = { season: season.value, ...settle(myClub.value, myWages + myUpkeep), wages: myWages, upkeep: myUpkeep };
  balances.value = balances.value.map((b, i) =>
    i === myClub.value ? b + ledger.value!.net : b + settle(i, squadWageBill(clubs.value[i].team.players, patch.value)).net);
  // promotion/relegation: bottom PROMO of each tier swap with the top PROMO below
  const pr = promoteRelegate(division.value, tables, PROMO);
  division.value = pr.division; lastMoves.value = pr.moves;
  schedules.value = divSchedules(division.value);
  // snapshot (whole roster) for deltas, then develop the league + your reserves
  prevById.value = snapRosters();
  const rng = new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9)) >>> 0);
  // AI clubs develop with their INFRASTRUCTURE boost — bigger orgs grow + retain
  // talent better, so dynasties form (your club is handled separately below, so it
  // gets NO_BOOST here and is overwritten by syncLineup from the developed myRoster)
  clubs.value = developLeague(clubs.value, rng, i => i === myClub.value ? NO_BOOST : infraBoost(clubInfra(clubs.value[i].strength)));
  const myBoost = facilityBoost(facilities.value);
  myRoster.value = myRoster.value.map(p => developPlayer(p, rng, 1 - SEASON_SHARE, myBoost));  // bootcamp share + HQ boost
  // prospects age + get the bootcamp slice too (separate rng, order-independent)
  if (academy.value.prospects.length) {
    const ar = new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9) ^ 0xACAD) >>> 0);
    academy.value = { ...academy.value, prospects: academy.value.prospects.map(p => developPlayer(p, ar, 1 - SEASON_SHARE, myBoost)) };
  }
  processRetirements(rng);   // veterans hang it up (post-aging); clubs reload
  manageAiClubArcs(rng);     // aging AI clubs proactively rebuild — shed a vet for youth
  // the meta shifts each off-season — a new patch buffs/nerfs agents, moving values
  const m = patchMeta(patch.value, new Rng((seasonSeed.value ^ (season.value * 0x27d4eb2f)) >>> 0));
  patch.value = m.patch; metaChanges.value = m.changes;
  syncLineup();
  season.value++;
  runIntake();                     // the new season's academy class arrives
  results.value = []; dayIdx.value = 0;
  playoffs.value = null;           // a fresh bracket awaits next season's end
  refreshMarket();
}
function refreshMarket() {
  freeAgentPool.value = freeAgents(marketSeed(), leagueHandles());
  listings.value = aiListings(clubs.value, myClub.value, marketEligible());
  myListed.value = new Set();
}
function selectClub(i: number) {
  myClub.value = i;
  myComp.value = {};
  myTactics.value = clone(clubs.value[i].tactics);
  myRoster.value = [...clubs.value[i].team.players];
  prevById.value = snapRosters();   // new club → new baseline
  ledger.value = null;
  listings.value = aiListings(clubs.value, i, marketEligible());
  myListed.value = new Set();
  forcedStart.value = new Set(); forcedBench.value = new Set();
  playoffs.value = null; facilities.value = defaultFacilities(); academy.value = defaultAcademy(); retirements.value = [];
  syncLineup();
}
function newWorld(s = Math.floor(Math.random() * 100000)) {
  seasonSeed.value = s;
  clubs.value = makeLeague(s, N);
  division.value = initialDivision();
  schedules.value = divSchedules(division.value);
  lastMoves.value = [];
  results.value = []; dayIdx.value = 0; season.value = 1;
  myComp.value = {};
  myTactics.value = clone(clubs.value[myClub.value].tactics);
  myRoster.value = [...clubs.value[myClub.value].team.players];
  prevById.value = snapRosters();   // fresh season-1 baseline
  balances.value = clubs.value.map(c => startingBalance(c.strength));
  ledger.value = null;
  patch.value = fullPatch(PATCH, ALL_AGENTS); metaChanges.value = [];
  forcedStart.value = new Set(); forcedBench.value = new Set();
  playoffs.value = null; titles.value = clubs.value.map(() => 0);
  facilities.value = defaultFacilities(); academy.value = defaultAcademy(); retirements.value = [];
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

// retirement (DESIGN §4.4) — esports careers are short, so each off-season aging
// veterans hang it up across the whole league, and clubs reload the slot. A well-run
// AI club graduates a HOMEGROWN youth (infra-scaled, develops up under that same
// infrastructure, so a strong academy churns vets → prospects → stars); a weak one
// scrapes a journeyman. YOUR retirees leave your roster too (closing the age-curve
// loop, so your academy pipeline is load-bearing) — you're notified, and if it drops
// a role below the valid five, your best prospect is auto-graduated to cover.
function processRetirements(rng: Rng) {
  const used = new Set<string>(allHandles());
  const freshHandle = () => { const h = HANDLES.find(x => !used.has(x)) ?? `Sub${moveSeq++}`; used.add(h); return h; };
  const events: { handle: string; age: number; role: string; overall: number; club: number; mine: boolean }[] = [];
  // AI clubs: a retiree's slot is refilled — homegrown youth for a well-run org,
  // else a journeyman scaled to the club's level
  clubs.value = clubs.value.map((c, ci) => {
    if (ci === myClub.value) return c;   // your club handled below
    const infra = clubInfra(c.strength);
    const char = clubAgeChar(c.team.id);   // the club's age philosophy biases who it reloads
    let changed = false;
    const players = c.team.players.map(p => {
      if (!shouldRetire(p, rng)) return p;
      events.push({ handle: p.handle, age: p.age, role: p.role, overall: overall(p), club: ci, mine: false });
      changed = true;
      const homegrown = infra >= 2 && rng.chance(0.35 + infra * 0.1);
      // a veteran-character club reloads older, a youth one younger — so the league's
      // age mix stays spread and retirements don't synchronize into a wave
      const age = Math.max(16, (homegrown ? rng.int(17, 19) : rng.int(21, 26)) + char);
      const str = homegrown ? Math.max(0.35, Math.min(0.7, 0.32 + infra * 0.06)) : 0.4 + infra * 0.04;
      return { ...makePlayer(rng, p.role as Role, freshHandle(), c.team.id, str, age), igl: p.igl };
    });
    if (!changed) return c;
    const team = { ...c.team, players };
    return { ...c, team, strength: clampStr(squadRating(team) / 100) };
  });
  // your club: retirees leave the roster (academy prospects are teens — exempt)
  const myId = clubs.value[myClub.value].team.id;
  const stayed: Player[] = [];
  for (const p of myRoster.value) {
    if (shouldRetire(p, rng)) events.push({ handle: p.handle, age: p.age, role: p.role, overall: overall(p), club: myClub.value, mine: true });
    else stayed.push(p);
  }
  if (stayed.length !== myRoster.value.length) {
    let roster = stayed;
    for (const role of Object.keys(ROLE_NEED) as Role[]) {
      while (roster.filter(p => p.role === role).length < ROLE_NEED[role]) {
        // prefer graduating your best academy prospect of the role (no fee), else a youth call-up
        const prospect = academy.value.prospects.filter(p => p.role === role).sort((a, b) => overall(b) - overall(a))[0];
        if (prospect) {
          academy.value = { ...academy.value, prospects: academy.value.prospects.filter(x => x.id !== prospect.id) };
          roster = [...roster, retag(prospect, myId, false)];
        } else {
          roster = [...roster, { ...makePlayer(rng, role, freshHandle(), myId, 0.4, rng.int(17, 19)), igl: false }];
        }
      }
    }
    myRoster.value = roster;
  }
  retirements.value = events;
}

// proactive rebuilds (DESIGN §17) — an AI club's lifecycle stage (clubPhase) is
// emergent from its roster. An AGING club doesn't wait for the retirement cliff: a
// well-run one sheds its oldest for a homegrown youth a year early (a managed
// transition — a dynasty that RELOADS), so the collapse-all-at-once is smoothed and
// the league keeps a spread of teams at different stages. A neglected aging club
// (low infra) does this rarely, so it ages out and rebuilds the hard way. Your club
// is skipped — you read your rivals' stages and manage your own arc.
function manageAiClubArcs(rng: Rng) {
  const used = new Set<string>(allHandles());
  const freshHandle = () => { const h = HANDLES.find(x => !used.has(x)) ?? `Sub${moveSeq++}`; used.add(h); return h; };
  clubs.value = clubs.value.map((c, ci) => {
    if (ci === myClub.value || clubPhase(c.team) !== 'aging') return c;
    const infra = clubInfra(c.strength);
    if (!rng.chance(0.2 + infra * 0.1)) return c;            // better orgs rebuild more reliably
    const old = [...c.team.players].sort((a, b) => b.age - a.age)[0];
    if (old.age < 29) return c;                              // only shed a genuine veteran
    const homegrown = infra >= 3;                            // a strong academy reloads with its own youth
    const age = Math.max(16, (homegrown ? rng.int(17, 19) : rng.int(19, 22)) + clubAgeChar(c.team.id));
    const str = homegrown ? Math.max(0.4, Math.min(0.72, 0.34 + infra * 0.06)) : 0.42 + infra * 0.04;
    const youth = { ...makePlayer(rng, old.role as Role, freshHandle(), c.team.id, str, age), igl: old.igl };
    const players = c.team.players.map(p => (p.id === old.id ? youth : p));
    const team = { ...c.team, players };
    return { ...c, team, strength: clampStr(squadRating(team) / 100) };
  });
}

/** Sign a market player at an explicit `price` — they JOIN your roster (no forced
 *  drop). A free agent leaves the unowned pool; a club sale pays the seller (your
 *  winning bid, not the formula value), who restocks. The matchday five re-derives. */
function acquireAt(e: MarketEntry, price: number) {
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

// the asking price (seller's reserve = formula value) and the strongest rival bid
// for a market player — the price you must beat to sign him
const askingOf = (e: MarketEntry) => value(e.player);
const rivalBid = (e: MarketEntry) => topRivalBid(clubs.value, balances.value, new Set([myClub.value, e.from]), e.player, patch.value);
/** Is a player contested? (a rival is willing to pay at or above asking) */
const isContested = (e: MarketEntry) => rivalBid(e).bid >= askingOf(e);

export interface BidOutcome { won: boolean; below?: boolean; broke?: boolean; leader?: number; leadBid?: number; paid?: number }
/** Place a bid on a market player. You win — and sign at your bid — only if it
 *  clears the seller's asking price AND beats every rival's ceiling. Otherwise it
 *  tells you who's leading and at what, so you can raise or walk (the bidding war). */
function bidFor(e: MarketEntry, amount: number): BidOutcome {
  const asking = askingOf(e);
  if (amount < asking) return { won: false, below: true, leadBid: asking };
  if (amount > balance.value) return { won: false, broke: true };
  const rival = rivalBid(e);
  if (rival.club >= 0 && rival.bid >= amount) return { won: false, leader: rival.club, leadBid: rival.bid };
  acquireAt(e, amount);
  return { won: true, paid: amount };
}
/** Buy at asking (back-compat / the uncontested path). */
function acquire(e: MarketEntry) { bidFor(e, askingOf(e)); }

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
async function ensureNav() {
  await Promise.all(MAP_POOL.map(async m => { if (!navs[m]) navs[m] = await fetch(`/${m}.navmesh.json`).then(r => r.json()); }));
  navReady = true;
}
const getNav = () => navs[MAP] ?? null;   // the editor's map (Ascent)

// --- career persistence (localStorage) ---------------------------------------
// A whole career lives in the refs above; here we snapshot the mutated state to
// localStorage and restore it on load, so a refresh resumes exactly where you
// left off. The schedules are pure (divisionSchedule over each tier) so they're
// regenerated from the division map, not stored. Sets/Maps round-trip via arrays.
// A version+club-count guard ignores a stale/incompatible save (then start fresh).
const SAVE_KEY = 'ace.career.v2';
const hasSave = ref(false);

function snapshot() {
  return {
    v: 2, n: N,
    seasonSeed: seasonSeed.value, season: season.value, myClub: myClub.value, dayIdx: dayIdx.value,
    clubs: clubs.value, division: division.value, lastMoves: lastMoves.value,
    results: results.value, balances: balances.value, ledger: ledger.value,
    titles: titles.value, myComp: myComp.value, myTactics: myTactics.value, myRoster: myRoster.value,
    freeAgentPool: freeAgentPool.value, listings: listings.value, myListed: [...myListed.value],
    patch: patch.value, metaChanges: metaChanges.value, playoffs: playoffs.value,
    forcedStart: [...forcedStart.value], forcedBench: [...forcedBench.value], facilities: facilities.value, academy: academy.value,
    retirements: retirements.value,
    prevById: [...prevById.value.entries()],
  };
}
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot())); hasSave.value = true; } catch { /* quota / private mode — run unsaved */ }
}
function loadSave(): ReturnType<typeof snapshot> | null {
  try { const s = localStorage.getItem(SAVE_KEY); if (!s) return null; const o = JSON.parse(s); return o?.v === 2 && o?.n === N ? o : null; } catch { return null; }
}
function hydrate(o: ReturnType<typeof snapshot>) {
  seasonSeed.value = o.seasonSeed; season.value = o.season; myClub.value = o.myClub; dayIdx.value = o.dayIdx;
  clubs.value = o.clubs; division.value = o.division; lastMoves.value = o.lastMoves;
  schedules.value = divSchedules(division.value); results.value = o.results;
  balances.value = o.balances; ledger.value = o.ledger; titles.value = o.titles;
  myComp.value = o.myComp; myTactics.value = o.myTactics; myRoster.value = o.myRoster;
  freeAgentPool.value = o.freeAgentPool; listings.value = o.listings; myListed.value = new Set(o.myListed);
  patch.value = o.patch; metaChanges.value = o.metaChanges; playoffs.value = o.playoffs;
  forcedStart.value = new Set(o.forcedStart); forcedBench.value = new Set(o.forcedBench);
  facilities.value = o.facilities ?? defaultFacilities();   // default for pre-facilities saves
  academy.value = o.academy ?? defaultAcademy();            // default for pre-academy saves
  retirements.value = o.retirements ?? [];
  prevById.value = new Map(o.prevById);
}
function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } hasSave.value = false; }

// restore an existing career BEFORE wiring the autosave watcher, so hydration
// doesn't re-trigger a save of identical data.
const _saved = loadSave();
if (_saved) { hydrate(_saved); hasSave.value = true; }

// autosave: the store reassigns these refs immutably on every change, so a
// shallow watch catches them all. Debounced so a fast "sim to end" (many
// match-days) collapses into one write.
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  [seasonSeed, clubs, division, lastMoves, results, dayIdx, myClub, season, balances, ledger, titles, myComp, myTactics,
    myRoster, freeAgentPool, listings, myListed, patch, metaChanges, playoffs, forcedStart, forcedBench, prevById, facilities, academy, retirements],
  () => { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(save, 200); },
);

export function useWorld() {
  return {
    N, DIV_SIZE, DIVS, PROMO, DIV_NAMES, MAP, MAP_POOL, fixtureMap, navOf, seasonSeed, clubs, schedules, results, dayIdx, myClub, season, prevById,
    myComp, myTactics, myRoster, balance, balances, ledger, market, myListed, patch, metaChanges,
    playoffs, titles, hasSave, clearSave, division, myDivision, lastMoves, tableOf,
    facilities, facBoost, facCost, canUpgradeFacility, upgradeFacility,
    academy, acadCost, canUpgradeAcademy, upgradeAcademy, acadIntakeSize, promoteProspect, releaseProspect,
    infraLevel, INFRA_MAX, retirements, powerOf, powerRanking, hqRanking, rankInList,
    table, total, done, myTeam, rankOf, myStanding, myResults, nextFixture, nextOpponent,
    buildInput, simFixture, resolveDay, simSeason, enterPlayoffs, advanceSeason, selectClub, newWorld, ensureNav, getNav,
    myPlayerOf, value, canAfford, isStarter, isListed, canSell, acquire, sellPlayer, toggleList,
    bidFor, isContested, askingOf,
    canBench, isBenched, isStarterPinned, startReserve, benchStarter,
  };
}
