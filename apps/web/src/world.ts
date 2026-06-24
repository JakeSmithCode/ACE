// The shared single-player world — one reactive store both the HQ/Season screen
// and the Tactics Editor read from. A whole career is a function of one seed
// (@ace/world), resolved client-side by the same engine the server worker will
// run. Your club gets two manager overlays the AI clubs don't: an authored comp
// and authored tactics, both injected into your fixtures.
import { computed, ref, shallowRef } from 'vue';
import type { Attributes, Comp, MapId, MatchInput, Player, Tactics } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch, PATCH, Rng } from '@ace/engine';
import {
  makeLeague, doubleRoundRobin, standings, fixtureSeed, developLeague,
  startingBalance, settleSeason, freeAgents, playerValue, squadRating,
  type Club, type MatchResult, type Matchday, type SeasonLedger,
} from '@ace/world';

export const N = 8;
export const MAP: MapId = 'ascent';
const RESOLVE_FORKS = 3;            // standings only need the final score
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

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
const balance = ref(startingBalance(clubs.value[myClub.value].strength));
const ledger = ref<SeasonLedger | null>(null);
const leagueHandles = () => new Set(clubs.value.flatMap(c => c.team.players.map(p => p.handle)));
const marketSeed = () => (seasonSeed.value ^ (season.value * 0x85ebca6b)) >>> 0;
const market = shallowRef<Player[]>(freeAgents(marketSeed(), leagueHandles()));

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
}
function simSeason() { while (!done.value) resolveDay(); }

// the off-season: settle your books by final rank, then develop every squad.
// Your authored tactics/comp carry over (player ids are stable through a tick).
function advanceSeason() {
  if (!done.value) return;
  ledger.value = settleSeason(myTeam.value, rankOf(myClub.value), N, season.value);
  balance.value += ledger.value.net;
  prevById.value = new Map(clubs.value.flatMap(c => c.team.players.map(p =>
    [p.id, { age: p.age, attr: { ...p.attr } }] as const)));
  clubs.value = developLeague(clubs.value, new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9)) >>> 0));
  season.value++;
  results.value = []; dayIdx.value = 0;
  market.value = freeAgents(marketSeed(), leagueHandles());
}
function selectClub(i: number) {
  myClub.value = i;
  myComp.value = {};
  myTactics.value = clone(clubs.value[i].tactics);
  balance.value = startingBalance(clubs.value[i].strength);
  ledger.value = null;
}
function newWorld(s = Math.floor(Math.random() * 100000)) {
  seasonSeed.value = s;
  clubs.value = makeLeague(s, N);
  schedule.value = doubleRoundRobin(N);
  results.value = []; dayIdx.value = 0; season.value = 1;
  prevById.value = new Map();
  myComp.value = {};
  myTactics.value = clone(clubs.value[myClub.value].tactics);
  balance.value = startingBalance(clubs.value[myClub.value].strength);
  ledger.value = null;
  market.value = freeAgents(marketSeed(), leagueHandles());
}

// --- transfer market: sign a free agent to replace your same-role player ----
const myPlayerOf = (role: string) => myTeam.value.players.find(p => p.role === role);
const netFee = (fa: Player) => playerValue(fa) - playerValue(myPlayerOf(fa.role)!);  // <0 = you bank cash
const canAfford = (fa: Player) => netFee(fa) <= balance.value;
function signPlayer(fa: Player) {
  const team = clubs.value[myClub.value].team;
  const idx = team.players.findIndex(p => p.role === fa.role);
  if (idx < 0 || !canAfford(fa)) return;
  const old = team.players[idx];
  const fee = playerValue(fa) - playerValue(old);   // capture BEFORE the swap (myPlayerOf changes)
  const signed: Player = { ...fa, id: `${team.id}-${fa.handle.toLowerCase()}`, igl: old.igl };
  const players = team.players.map((p, i) => i === idx ? signed : p);
  const newTeam = { ...team, players };
  clubs.value = clubs.value.map((c, i) => i === myClub.value
    ? { ...c, team: newTeam, strength: Math.max(0.3, Math.min(0.95, squadRating(newTeam) / 100)) } : c);
  balance.value -= fee;
  // keep tactical references coherent: the new player inherits the slot's role
  myTactics.value = JSON.parse(JSON.stringify(myTactics.value).split(old.id).join(signed.id));
  if (myComp.value[old.id]) { const c = { ...myComp.value }; delete c[old.id]; myComp.value = c; }
  // market: sign out the FA, list the replaced player as a free agent
  market.value = [{ ...old, id: `fa-${old.handle.toLowerCase()}` }, ...market.value.filter(p => p.id !== fa.id)];
}
async function ensureNav() { if (!nav) nav = await fetch(`/${MAP}.navmesh.json`).then(r => r.json()); }
const getNav = () => nav;

export function useWorld() {
  return {
    N, MAP, seasonSeed, clubs, schedule, results, dayIdx, myClub, season, prevById,
    myComp, myTactics, balance, ledger, market,
    table, total, done, myTeam, rankOf, myStanding, myResults, nextFixture, nextOpponent,
    buildInput, simFixture, resolveDay, simSeason, advanceSeason, selectClub, newWorld, ensureNav, getNav,
    myPlayerOf, netFee, canAfford, signPlayer,
  };
}
