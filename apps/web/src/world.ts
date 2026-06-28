// The shared single-player world — one reactive store both the HQ/Season screen
// and the Tactics Editor read from. A whole career is a function of one seed
// (@ace/world), resolved client-side by the same engine the server worker will
// run. Your club gets two manager overlays the AI clubs don't: an authored comp
// and authored tactics, both injected into your fixtures.
import { computed, ref, shallowRef, watch } from 'vue';
import type { Attributes, Comp, MapId, MatchInput, PatchState, Player, Role, Tactics, Team } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch, PATCH, Rng } from '@ace/engine';
import {
  makeLeague, standings, developLeague, developPlayer, developInSeason, SEASON_SHARE, makePlayer, HANDLES,
  shouldRetire, clubPhase, clubAgeChar,
  startingBalance, freeAgents, playerValue, squadRating, overall, aiListings, aiWantsToBuy, topRivalBid, aiRating, SCOUT_MAX,
  ROLE_AGENTS, fullPatch, patchMeta, runPlayoffs, finishOf, playoffPrize,
  membersOf, divisionSchedule, promoteRelegate,
  buildMatchInput, quickResult as quickResultPure, resolveWorldDay, settleClub, squadWageBill, mapAffinity, MAP_POOL, fixtureMap,
  contractWage, demandWage, newContract, CONTRACT_YEARS,
  defaultFacilities, facilityBoost, facilityCost, facilityUpkeep, FACILITY_MAX,
  clubInfra, infraBoost, INFRA_MAX, NO_BOOST,
  defaultAcademy, academyIntake, academyCost, academyUpkeep, academyWageBill, intakeSize, ACADEMY_MAX,
  staffMarket, staffEffect, withStaffBoost, staffWageBill, STAFF_ROLES,
  sponsorOffers, sponsorGoalMet, sponsorGoalText, type SponsorOffer, type ActiveSponsor,
  type MetaChange, type Club, type MatchResult, type Matchday, type SeasonLedger, type Bracket, type DivMove, type Standing,
  type Facilities, type FacilityId, type Academy, type StaffHires, type StaffRole, type StaffMember,
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
// the competitive pool + per-fixture map picker now live in @ace/world (one source
// of truth for the store and the server tick); re-exported here for the web app.
export { MAP_POOL, fixtureMap };
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
// every player on YOUR roster is under a contract (a wage locked for a term). Seed
// the starting squad with staggered terms so renewals don't all land in one season.
function seedContracts(roster: Player[]): Player[] {
  return roster.map((p, i) => ({ ...p, contract: p.contract ?? newContract(p, undefined, 2 + (i % 3)) }));
}
const myRoster = ref<Player[]>(seedContracts([...clubs.value[myClub.value].team.players]));  // your FULL squad (≥5; the matchday five is derived)
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
const staff = ref<StaffHires>({});                        // your hired backroom staff (coach/analyst/psych)
// last off-season's retirements (league-wide; `mine` flags your own) — for the banner
const retirements = ref<{ handle: string; age: number; role: string; overall: number; club: number; mine: boolean }[]>([]);
// your players who walked free last off-season (contract expired, not renewed)
const contractDepartures = ref<{ handle: string; role: string; overall: number }[]>([]);
// AI players released to free agency last off-season (the wave hitting your board)
const marketWave = ref<{ handle: string; overall: number; role: string }[]>([]);

// scouting reports you've commissioned (player id → level 0..SCOUT_MAX). A paid
// investment that clears the fog on a player's potential — and lifts a revealed
// gem's value, so you can flip a prospect you don't need.
const scouted = ref<Map<string, number>>(new Map());
const scoutLevelOf = (id: string) => scouted.value.get(id) ?? 0;
// training focus: a chosen skill the manager directs a player's reps at (faster in that
// skill, slightly slower elsewhere — a tradeoff). Keyed by player id; absent = balanced.
const focuses = ref<Map<string, keyof Attributes>>(new Map());
const focusOf = (id: string): keyof Attributes | undefined => focuses.value.get(id);
function setFocus(id: string, attr: keyof Attributes | null) {
  const m = new Map(focuses.value);
  if (attr) m.set(id, attr); else m.delete(id);
  focuses.value = m;
}

// ── Fitness: fatigue + injuries (depth finally matters on match night) ───────────────
// A starter accumulates FATIGUE playing every match-day; a rested/benched player recovers.
// High fatigue dulls match performance AND raises injury risk — so you rotate depth in to
// keep your stars fresh. An INJURY sidelines a player for a few match-days (he can't be
// fielded, so a reserve covers); with no cover he plays through HURT at a heavy penalty.
// Pure store state, seeded — the match engine never sees it, so seed 42 is byte-identical.
const fatigue = ref<Map<string, number>>(new Map());     // 0..100 per player id
const injuries = ref<Map<string, number>>(new Map());    // match-days remaining out (>0 = injured)
const lastInjury = ref<{ handle: string; days: number } | null>(null);   // for a banner
const FAT_GAIN = 26, FAT_RECOVER = 12, FAT_MAX = 100;    // played +gain, everyone −recover each day
const FAT_PEN = 0.10;                                    // attr loss at full fatigue (×0.90)
const INJ_BASE = 0.012, INJ_FAT = 0.05;                  // injury chance = base + fatigue·fat
const HURT_PEN = 0.20;                                   // playing through an injury (no cover)
const fatigueOf = (id: string) => fatigue.value.get(id) ?? 0;
const injuryOf = (id: string) => injuries.value.get(id) ?? 0;
const isInjured = (id: string) => injuryOf(id) > 0;
const isTired = (id: string) => fatigueOf(id) >= 60;
/** Match-night attr multiplier for one of YOUR players — fatigue dulls, a forced-to-play
 *  injury hits harder. 1.0 = fresh. Applied in buildInput (engine sees plain attrs). */
function fitnessFactor(id: string, fielded: Player[]): number {
  const fat = 1 - FAT_PEN * (fatigueOf(id) / FAT_MAX);
  const hurt = isInjured(id) && fielded.some(p => p.id === id) ? 1 - HURT_PEN : 1;   // only if he had to play
  return fat * hurt;
}

// ── Morale + team talks (the human-management layer) ─────────────────────────────────
// Each player carries a MOOD (0..100) that drifts from playing time, results, fatigue and
// the psychologist's touch; high morale lifts match performance a little, low morale drags.
// Before each match the manager gives a TEAM TALK — `calm` / `rally` / `demand` — and the
// RIGHT tone for the situation (are you favourite or underdog, is the room up or flat?)
// gives a one-match edge + a morale bump; the wrong one backfires. Read the room. All
// store-only and engine-invisible (scaled attrs in buildInput), so seed 42 is byte-identical.
const morale = ref<Map<string, number>>(new Map());
const MORALE_BASE = 65, MORALE_PEN = 0.08;               // mood centre + match swing at the extremes
const moraleOf = (id: string) => morale.value.get(id) ?? MORALE_BASE;
const moraleFactor = (id: string) => 1 + ((moraleOf(id) - 60) / 100) * MORALE_PEN;   // ~±3% across the band
const squadMorale = () => {
  const five = clubs.value[myClub.value]?.team.players ?? [];
  return five.length ? Math.round(five.reduce((s, p) => s + moraleOf(p.id), 0) / five.length) : MORALE_BASE;
};

type Talk = 'calm' | 'rally' | 'demand';
const teamTalk = ref<Talk | null>(null);                 // the manager's chosen tone for the next match (one-shot)
const TALK_META: Record<Talk, { label: string; icon: string }> = {
  calm: { label: 'Stay calm', icon: '○' }, rally: { label: 'Rally them', icon: '▲' }, demand: { label: 'Demand more', icon: '✦' },
};
/** Read the room: how well a tone fits the situation (favourite vs underdog by strength,
 *  and the squad's current mood). Returns a one-match attr edge + a morale nudge. */
function talkFit(tone: Talk): { fit: 'great' | 'ok' | 'poor'; edge: number; mood: number } {
  const mine = clubs.value[myClub.value]?.strength ?? 0.5;
  const opp = clubs.value[nextOpponent.value]?.strength ?? 0.5;
  const fav = mine - opp;                  // + = you're the favourite
  const m = squadMorale();
  let score = 0;                           // −1 poor .. +1 great, by tone × context
  if (tone === 'calm') score = (fav > 0.03 ? 0.6 : -0.3) + (m >= 65 ? 0.4 : -0.4);       // keep a confident favourite loose
  if (tone === 'rally') score = (fav < 0.03 ? 0.6 : 0.1) + (m >= 40 && m < 80 ? 0.3 : -0.2);  // lift an underdog / a flat room
  if (tone === 'demand') score = (m >= 60 ? 0.5 : -0.6) + (fav > -0.02 ? 0.3 : -0.3);    // push a good room; piling on a low one backfires
  const fit = score >= 0.6 ? 'great' : score <= -0.2 ? 'poor' : 'ok';
  const edge = fit === 'great' ? 0.03 : fit === 'poor' ? -0.025 : 0.005;
  const mood = fit === 'great' ? 5 : fit === 'poor' ? -5 : 1;
  return { fit, edge, mood };
}
const talkPreview = computed(() => teamTalk.value ? talkFit(teamTalk.value) : null);
const talkFactor = () => (teamTalk.value ? 1 + talkFit(teamTalk.value).edge : 1);   // team-wide one-match edge
function setTalk(t: Talk | null) { teamTalk.value = teamTalk.value === t ? null : t; }

// ── Rivalries / derbies (the league feels alive) ─────────────────────────────────────
// Your RIVAL is the club nearest your strength in your starting division — your closest
// competitor, fixed for the career (the derby spans the leagues even if one of you moves).
// A derby carries extra MORALE stakes (a win lifts the room more, a loss stings harder)
// and a head-to-head record builds over the seasons. Pure store state, engine-invisible.
const rivalId = ref<number | null>(null);
const derbyRecord = ref<{ w: number; l: number }>({ w: 0, l: 0 });
const lastDerby = ref<{ won: boolean; opp: string } | null>(null);     // for a banner
/** The nearest-strength club in your division — your natural rival (chosen once, persisted). */
function pickRival(): number | null {
  const d = division.value[myClub.value], me = clubs.value[myClub.value].strength;
  const peers = clubs.value.map((c, i) => ({ i, s: c.strength })).filter(m => m.i !== myClub.value && division.value[m.i] === d);
  if (!peers.length) return null;
  peers.sort((a, b) => Math.abs(a.s - me) - Math.abs(b.s - me) || a.i - b.i);
  return peers[0].i;
}
const ensureRival = () => { if (rivalId.value == null) rivalId.value = pickRival(); };
const isRival = (i: number) => rivalId.value != null && i === rivalId.value;

// ── End-of-season awards (legacy — celebrate the development model) ───────────────────
// Computed at the season rollover for YOUR division: an MVP (best player), a Young Player
// (best U22), and YOUR most-improved (biggest OVR gain vs the season-start baseline — the
// payoff for developing a prospect). Stored as a history for the legacy feed. Engine-blind.
type Award = { handle: string; tag: string; overall: number; role: string; mine: boolean; note?: string };
type SeasonAwards = { season: number; division: string; mvp: Award; young: Award; improved: Award | null };
const lastAwards = ref<SeasonAwards | null>(null);
const awardsHistory = ref<SeasonAwards[]>([]);
function seasonAwards(): SeasonAwards | null {
  const d = division.value[myClub.value];
  const pool: { p: Player; ci: number }[] = [];
  clubs.value.forEach((c, ci) => { if (division.value[ci] === d) c.team.players.forEach(p => pool.push({ p, ci })); });
  if (!pool.length) return null;
  const mk = (x: { p: Player; ci: number }, note?: string): Award =>
    ({ handle: x.p.handle, tag: clubs.value[x.ci].team.tag, overall: overall(x.p), role: x.p.role, mine: x.ci === myClub.value, note });
  const byOvr = [...pool].sort((a, b) => overall(b.p) - overall(a.p) || (a.p.id < b.p.id ? -1 : 1));
  const mvp = mk(byOvr[0]);
  const youngs = pool.filter(x => x.p.age <= 21).sort((a, b) => overall(b.p) - overall(a.p) || (a.p.id < b.p.id ? -1 : 1));
  const young = mk(youngs[0] ?? byOvr[0]);
  // your most-improved: biggest rounded OVR gain vs the season-start snapshot
  let best: { p: Player; gain: number } | null = null;
  for (const p of myRoster.value) {
    const base = prevById.value.get(p.id);
    if (!base) continue;
    const gain = overall(p) - overall(base);
    if (gain > 0 && (!best || gain > best.gain)) best = { p, gain };
  }
  const improved = best ? { handle: best.p.handle, tag: clubs.value[myClub.value].team.tag, overall: overall(best.p), role: best.p.role, mine: true, note: `+${best.gain} OVR` } : null;
  return { season: season.value, division: DIV_NAMES[d], mvp, young, improved };
}
/** Post-match: heal existing injuries a day, fatigue the five who played + recover the
 *  rest, and roll new injuries (risk scales with the fatigue they played at). Seeded so
 *  a replayed match-day is identical; never touches the world/engine stream. */
function updateFitness(fielded: Set<string>, rng: Rng) {
  const fat = new Map(fatigue.value);
  const inj = new Map(injuries.value);
  for (const [id, n] of [...inj]) { if (n - 1 > 0) inj.set(id, n - 1); else inj.delete(id); }   // heal a match-day
  let worst: { handle: string; days: number; ovr: number } | null = null;
  for (const p of myRoster.value) {
    const played = fielded.has(p.id);
    const cur = fat.get(p.id) ?? 0;
    if (played) {
      // injury risk is read at the fatigue he PLAYED at (pre-increment); one draw per starter.
      // a sports psychologist cuts both the injury rate and how hard the day fatigues.
      if (!inj.has(p.id) && rng.chance((INJ_BASE + INJ_FAT * (cur / FAT_MAX)) * staffEff.value.injuryMul)) {
        const days = rng.int(2, 4);
        inj.set(p.id, days); fat.set(p.id, 20);           // sidelined; rests while out
        const o = overall(p);
        if (!worst || o > worst.ovr) worst = { handle: p.handle, days, ovr: o };
      } else {
        fat.set(p.id, Math.min(FAT_MAX, cur + FAT_GAIN * staffEff.value.fatigueMul));
      }
    } else {
      fat.set(p.id, Math.max(0, cur - FAT_RECOVER));      // bench/rest recovers
    }
  }
  fatigue.value = fat; injuries.value = inj;
  lastInjury.value = worst ? { handle: worst.handle, days: worst.days } : null;
}
/** Post-match mood drift: the result lifts/drops the whole squad, minutes reward starters
 *  and frustrate the benched, an injury stings, the psychologist lifts everyone — then the
 *  one-shot team-talk nudge is folded in and the talk is cleared. No rng (pure drift). */
function updateMorale(fielded: Set<string>, won: boolean | null, derby = false) {
  const talkMood = teamTalk.value ? talkFit(teamTalk.value).mood : 0;
  const psych = staffEff.value.morale;
  const derbySwing = derby ? (won ? 5 : won === false ? -5 : 0) : 0;   // a derby win/loss hits harder
  const next = new Map(morale.value);
  for (const p of myRoster.value) {
    let m = next.get(p.id) ?? MORALE_BASE;
    m += won === true ? 6 : won === false ? -5 : 0;              // the result moves the room
    m += derbySwing;                                            // a derby is worth more either way
    m += fielded.has(p.id) ? 1.5 : -2.5;                         // minutes: starters happy, reserves restless
    if (isInjured(p.id)) m -= 3;                                 // being hurt stings
    m += psych + talkMood + (MORALE_BASE - m) * 0.06;            // psych lift + team talk + slow mean-reversion
    next.set(p.id, Math.max(0, Math.min(100, m)));
  }
  morale.value = next;
  teamTalk.value = null;                                         // the talk was a one-shot for this match
}

// contract helpers for the UI: what you PAY a player (locked wage), what he'd
// DEMAND to re-sign (current market), and his deal's years left
const wageOf = (p: Player) => contractWage(p, patch.value);
const renewCost = (p: Player) => demandWage(p, patch.value);
const yearsLeft = (p: Player) => p.contract?.years ?? 0;
const isExpiring = (p: Player) => yearsLeft(p) <= 1;   // final year — renew or lose him free
const myWageBill = computed(() => squadWageBill(myRoster.value, patch.value));

const balance = computed(() => balances.value[myClub.value]);
// value reflects the live meta AND your scouting — a gem you've scouted is worth
// (and sells for) what you've revealed; an unscouted/rival player stays fogged
const value = (p: Player) => playerValue(p, patch.value, scoutLevelOf(p.id));
// scout the next level on a player you own (roster or academy) — cost rises per level
// base 1.5k / 3k / 4.5k per level, less a performance analyst's discount (cheaper reports)
const scoutCost = (id: string) => Math.round((1500 + scoutLevelOf(id) * 1500) * (1 - staffEff.value.scoutDiscount));
const canScout = (id: string) => scoutLevelOf(id) < SCOUT_MAX && balance.value >= scoutCost(id);
function scoutPlayer(id: string) {
  if (!canScout(id)) return;
  const cost = scoutCost(id);
  balances.value = balances.value.map((b, i) => i === myClub.value ? b - cost : b);
  scouted.value = new Map(scouted.value).set(id, scoutLevelOf(id) + 1);
}

// team chemistry (mirrors the engine's CHEM_CAP): a player gels with shared play;
// a fresh signing (tenure 0) is 0%, fully gelled at CHEM_CAP seasons. Team cohesion
// is the mean over the fielded five — a small duel edge a settled core has earned.
const CHEM_CAP_UI = 1.5;
const chemOf = (p: Player) => Math.min(1, Math.max(0, (p.tenure ?? 0) / CHEM_CAP_UI));
const teamCohesion = () => {
  const five = clubs.value[myClub.value].team.players;
  return five.reduce((s, p) => s + chemOf(p), 0) / five.length;
};

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

// --- backroom staff: hire a coach / analyst / psychologist from a seasonal shortlist.
// Each boosts a distinct system (dev / scouting+fitness) and draws a recurring wage —
// a personnel bet that competes with transfers and facility upkeep on the books.
const staffEff = computed(() => staffEffect(staff.value));
const staffMkt = computed(() => staffMarket(seasonSeed.value, season.value));
const staffWages = computed(() => staffWageBill(staff.value));
// your full development boost = the HQ rooms × a coach's growth + an analyst's ceiling
const myDevBoost = computed(() => withStaffBoost(facilityBoost(facilities.value), staffEff.value));
const hiredStaff = (role: StaffRole) => staff.value[role] ?? null;
function hireStaff(m: StaffMember) {        // hiring is a contract: no fee, but a season wage
  staff.value = { ...staff.value, [m.role]: m };
}
function fireStaff(role: StaffRole) {
  const s = { ...staff.value }; delete s[role]; staff.value = s;
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
  // a graduate signs his first senior deal (cheap — his wage tracks his current ability)
  const grad = { ...retag(p, clubs.value[myClub.value].team.id, false), contract: newContract(p, patch.value, CONTRACT_YEARS) };
  myRoster.value = [...myRoster.value, grad];
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
    // injured players sit out like a benched one; if depth can't cover, the fallback
    // below pulls them back (they play through hurt — fitnessFactor penalises it).
    const playable = inRole.filter(p => !forcedBench.value.has(p.id) && !isInjured(p.id));
    const forced = playable.filter(p => forcedStart.value.has(p.id)).sort((a, b) => overall(b) - overall(a));
    const auto = playable.filter(p => !forcedStart.value.has(p.id)).sort((a, b) => overall(b) - overall(a));
    const picked = [...forced, ...auto].slice(0, need);
    if (picked.length < need) {   // too few healthy — never field fewer than five (injured play through)
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

// ── The board's season objective (a manager-game staple, made fair for ACE) ──────────
// At season start the board sets an expectation from your PRE-SEASON strength rank
// within your division: a title-favourite is told to win promotion, a mid club to make
// the top half, an underdog to survive. Meeting it pays a board bonus; it's never a
// punishment beyond the standing itself (DESIGN §18 — pressure, not a mugging). Snapshotted
// so it stays a fixed target even as rosters drift through the season.
type Objective = { kind: 'promote' | 'tophalf' | 'survive'; label: string; needRank: number; bonus: number; seed: number };
function computeObjective(): Objective {
  const d = division.value[myClub.value];
  const members = clubs.value.map((c, i) => ({ i, s: c.strength })).filter(m => division.value[m.i] === d).sort((a, b) => b.s - a.s);
  const seed = members.findIndex(m => m.i === myClub.value) + 1;   // 1 = strongest in the tier
  if (seed <= PROMO) return { kind: 'promote', label: 'Win promotion', needRank: PROMO, bonus: 9000, seed };
  if (seed <= DIV_SIZE / 2) return { kind: 'tophalf', label: 'Finish top half', needRank: DIV_SIZE / 2, bonus: 4500, seed };
  return { kind: 'survive', label: 'Avoid relegation', needRank: DIV_SIZE - PROMO, bonus: 2500, seed };
}
const objective = ref<Objective>(computeObjective());
// the just-finished season's verdict (for the off-season banner; null until a season rolls).
const objectiveOutcome = ref<{ met: boolean; label: string; bonus: number; finish: number } | null>(null);
// live progress: your current division rank vs the target (met = on/ahead of pace).
const objectiveRank = computed(() => rankOf(myClub.value));
const objectiveMet = computed(() => objectiveRank.value > 0 && objectiveRank.value <= objective.value.needRank);

// ── Manager job security (the objective arc becomes a survival narrative) ─────────────
// The board's confidence in you (0..100) moves each season with how you met the brief:
// smash it and they back you, bomb it and the pressure mounts. Sustained failure → sacked
// (a forgiving curve, not a mugging — it takes a few disasters from the neutral start).
const boardConfidence = ref(60);
const sacked = ref(false);
type ConfStatus = { key: 'secure' | 'stable' | 'shaky' | 'brink'; label: string };
const confidenceStatus = computed<ConfStatus>(() => {
  const c = boardConfidence.value;
  if (c >= 75) return { key: 'secure', label: 'the board backs you fully' };
  if (c >= 45) return { key: 'stable', label: 'the board is satisfied' };
  if (c >= 20) return { key: 'shaky', label: 'under pressure — results needed' };
  return { key: 'brink', label: 'on the brink — your job is at risk' };
});

// ── Sponsorships (a commercial layer with its own objectives) ────────────────────────
// Pick one of three multi-season deals — a base cheque + a performance bonus on a goal.
// Paid out each season settle (base always, bonus if the goal was met).
const sponsor = ref<ActiveSponsor | null>(null);
const lastSponsorPay = ref<{ name: string; base: number; bonus: number; met: boolean } | null>(null);
const sponsorOffersList = computed<SponsorOffer[]>(() =>
  sponsor.value ? [] : sponsorOffers(seasonSeed.value, season.value, clubs.value[myClub.value].strength, myClub.value));
const goalTextOf = (o: { goal: SponsorOffer['goal']; goalN: number }) => sponsorGoalText(o);
function signSponsor(o: SponsorOffer) { if (!sponsor.value) sponsor.value = { ...o, yearsLeft: o.years }; }

const nextFixture = computed(() => done.value ? null
  : mySchedule.value[dayIdx.value].find(f => f.home === myClub.value || f.away === myClub.value) ?? null);
const nextOpponent = computed(() => {
  const fx = nextFixture.value ?? mySchedule.value[0].find(f => f.home === myClub.value || f.away === myClub.value)!;
  return fx.home === myClub.value ? fx.away : fx.home;
});
// is your next match a derby (vs your rival)?
const nextIsDerby = computed(() => nextFixture.value != null && isRival(nextOpponent.value));
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
  // your fielded five carry their match-night fitness (fatigue dulls, an injury played
  // through hits harder); the engine just sees the scaled attrs — pure store concern.
  const talk = talkFactor();   // a team-wide one-match edge from the team talk (1 = neutral)
  const fit = (i: number, team: Team): Team => {
    if (i !== myClub.value) return team;
    return { ...team, players: team.players.map(p => {
      const f = fitnessFactor(p.id, team.players) * moraleFactor(p.id) * talk;   // fitness × mood × team talk
      if (f === 1) return p;
      const attr = { ...p.attr };
      for (const k of Object.keys(attr) as (keyof Attributes)[]) attr[k] = Math.max(1, Math.min(99, Math.round(attr[k] * f)));
      return { ...p, attr };
    }) };
  };
  return buildMatchInput({
    seed, map, patch: patch.value,
    home: fit(fx.home, withAffinity(clubs.value[fx.home].team, map)), away: fit(fx.away, withAffinity(clubs.value[fx.away].team, map)),
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
  const boost = myDevBoost.value;   // your HQ rooms × the head coach's growth + analyst's ceiling
  // develop + gel: a player on the roster builds chemistry (~+1 tenure/season,
  // spread across match-days) so a new signing gels into the five over time
  myRoster.value = myRoster.value.map(p => {
    const d = developInSeason(p, fiveIds.has(p.id), total.value, dr, boost, focusOf(p.id));
    return { ...d, tenure: (d.tenure ?? 0) + 1 / total.value };
  });
  // your academy prospects develop on the reps path (academy circuit: grow, no rust)
  // — a separate rng so it never perturbs the senior-roster stream
  if (academy.value.prospects.length) {
    const ar = new Rng((seasonSeed.value ^ (season.value * 0x85ebca6b) ^ (dayIdx.value * 0x27d4eb2f) ^ 0xACAD) >>> 0);
    academy.value = { ...academy.value, prospects: academy.value.prospects.map(p => developInSeason(p, 'academy', total.value, ar, boost)) };
  }
  // fitness: fatigue the five who played, recover the rest, roll injuries (own seeded rng)
  const fr = new Rng((seasonSeed.value ^ (season.value * 0xC2B2AE35) ^ (dayIdx.value * 0x9e3779b9) ^ 0xF17) >>> 0);
  updateFitness(fiveIds, fr);
  // morale: the result + minutes + team talk move the room (the talk is one-shot); a derby
  // (vs your rival) carries extra stakes and adds to the head-to-head record.
  const myRes = fresh.find(r => r.home === myClub.value || r.away === myClub.value);
  const myWon = myRes ? myRes.winner === myClub.value : null;
  const oppIdx = myRes ? (myRes.home === myClub.value ? myRes.away : myRes.home) : -1;
  const derby = myRes != null && isRival(oppIdx);
  if (derby) {
    derbyRecord.value = myWon ? { ...derbyRecord.value, w: derbyRecord.value.w + 1 } : { ...derbyRecord.value, l: derbyRecord.value.l + 1 };
    lastDerby.value = { won: !!myWon, opp: clubs.value[oppIdx].team.tag };
  } else lastDerby.value = null;
  updateMorale(fiveIds, myWon, derby);
  dayIdx.value++;
  syncLineup();        // re-derive your five + strength from the developed roster (injured now excluded)
  resolveListings();   // the market is always live — your listed players may sell each match-day
  resolveAiMarket();   // ...and AI clubs sign players on their own — gems get snapped up
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
  const myUpkeep = facilityUpkeep(facilities.value) + academyUpkeep(academy.value.level) + staffWages.value;   // rooms + academy + backroom staff
  ledger.value = { season: season.value, ...settle(myClub.value, myWages + myUpkeep), wages: myWages, upkeep: myUpkeep };
  // did you meet the board's objective? a bonus if so (never a fine — pressure, not a mugging).
  const objFinish = rankIn(myClub.value);
  const objMet = objFinish > 0 && objFinish <= objective.value.needRank;
  const objBonus = objMet ? objective.value.bonus : 0;
  objectiveOutcome.value = { met: objMet, label: objective.value.label, bonus: objBonus, finish: objFinish };
  // board confidence: how you met the brief moves it — exceed it and they back you, miss it
  // and pressure mounts. reqGap > 0 = you beat the required finish; < 0 = you fell short.
  const reqGap = objective.value.needRank - objFinish;
  const confDelta = objMet ? 8 + Math.min(12, reqGap * 3) : -10 + Math.max(-15, reqGap * 3);
  boardConfidence.value = Math.max(0, Math.min(100, boardConfidence.value + confDelta));
  if (boardConfidence.value <= 0) sacked.value = true;   // the board has seen enough
  // end-of-season awards for your division (uses the season's division + the start baseline,
  // both still live here — promoteRelegate + the new snapRosters baseline come after)
  const aw = seasonAwards();
  lastAwards.value = aw;
  if (aw) awardsHistory.value = [aw, ...awardsHistory.value].slice(0, 30);
  // sponsorship payout: the base cheque always, the bonus if its goal was met this season
  let sponsorPay = 0;
  if (sponsor.value) {
    const wins = myResults.value.filter(r => r.winner === myClub.value).length;
    const met = sponsorGoalMet(sponsor.value.goal, sponsor.value.goalN, { objMet, finish: objFinish, divSize: DIV_SIZE, promo: PROMO, wins });
    sponsorPay = sponsor.value.base + (met ? sponsor.value.bonus : 0);
    lastSponsorPay.value = { name: sponsor.value.name, base: sponsor.value.base, bonus: met ? sponsor.value.bonus : 0, met };
    const yl = sponsor.value.yearsLeft - 1;
    sponsor.value = yl > 0 ? { ...sponsor.value, yearsLeft: yl } : null;   // deal runs out → new offers next season
  } else lastSponsorPay.value = null;
  balances.value = balances.value.map((b, i) =>
    i === myClub.value ? b + ledger.value!.net + objBonus + sponsorPay : b + settle(i, squadWageBill(clubs.value[i].team.players, patch.value)).net);
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
  // AI squads gel +1 tenure a season (your five gelled in-season; their slot is
  // overwritten by syncLineup from myRoster anyway). Reloads reset to 0 below.
  clubs.value = clubs.value.map((c, i) => i === myClub.value ? c
    : { ...c, team: { ...c.team, players: c.team.players.map(p => ({ ...p, tenure: (p.tenure ?? 0) + 1 })) } });
  const myBoost = myDevBoost.value;   // HQ rooms × coach growth + analyst ceiling
  myRoster.value = myRoster.value.map(p => developPlayer(p, rng, 1 - SEASON_SHARE, myBoost, focusOf(p.id)));  // bootcamp share + HQ boost
  // prospects age + get the bootcamp slice too (separate rng, order-independent)
  if (academy.value.prospects.length) {
    const ar = new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9) ^ 0xACAD) >>> 0);
    academy.value = { ...academy.value, prospects: academy.value.prospects.map(p => developPlayer(p, ar, 1 - SEASON_SHARE, myBoost)) };
  }
  processRetirements(rng);   // veterans hang it up (post-aging); clubs reload
  manageAiClubArcs(rng);     // aging AI clubs proactively rebuild — shed a vet for youth
  processContracts(rng);     // your expiring-and-unrenewed players walk free
  // the meta shifts each off-season — a new patch buffs/nerfs agents, moving values
  const m = patchMeta(patch.value, new Rng((seasonSeed.value ^ (season.value * 0x27d4eb2f)) >>> 0));
  patch.value = m.patch; metaChanges.value = m.changes;
  syncLineup();
  season.value++;
  objective.value = computeObjective();   // the board sets a fresh target for the new season + division
  fatigue.value = new Map(); injuries.value = new Map(); lastInjury.value = null; morale.value = new Map(); teamTalk.value = null;   // the off-season heals everyone
  runIntake();                     // the new season's academy class arrives
  results.value = []; dayIdx.value = 0;
  playoffs.value = null;           // a fresh bracket awaits next season's end
  const freed = resolveAiFreeAgency(rng);   // AI free-agency wave — strained clubs leak talent
  refreshMarket(freed);            // regenerate the board, folding the wave in
}
function refreshMarket(extra: Player[] = []) {
  const exclude = new Set([...leagueHandles(), ...extra.map(p => p.handle)]);
  freeAgentPool.value = [...extra, ...freeAgents(marketSeed(), exclude)];
  listings.value = aiListings(clubs.value, myClub.value, marketEligible());
  myListed.value = new Set();
}
// AI contracts expire too: each off-season a financially STRAINED club can't meet
// its earners' demands and its priciest player (a real star) walks to free agency;
// a healthy club occasionally lets a fringe player's deal run out. Both land on the
// board — the wave. The club backfills, so it stays at five. Deterministic, bounded
// (≤1 per club). This is what puts proven players (and the odd star) on your market.
function resolveAiFreeAgency(rng: Rng): Player[] {
  const freed: Player[] = [];
  clubs.value = clubs.value.map((c, ci) => {
    if (ci === myClub.value) return c;
    const strained = balances.value[ci] < 5000;            // bleeding — can't keep its earners
    if (!rng.chance(strained ? 0.5 : 0.07)) return c;
    const players = c.team.players;
    const leaving = strained
      ? [...players].sort((a, b) => playerValue(b, patch.value) - playerValue(a, patch.value))[0]   // the star walks
      : [...players].sort((a, b) => playerValue(a, patch.value) - playerValue(b, patch.value))[0];  // a fringe deal lapses
    freed.push(release(leaving));
    const fill = retag(backfillFor(leaving.role as Role), c.team.id, leaving.igl);
    const team = { ...c.team, players: players.map(p => p.id === leaving.id ? fill : p) };
    return { ...c, team, strength: clampStr(squadRating(team) / 100) };
  });
  marketWave.value = [...freed].sort((a, b) => overall(b) - overall(a)).map(p => ({ handle: p.handle, overall: overall(p), role: p.role }));
  return freed;
}
function selectClub(i: number) {
  myClub.value = i;
  myComp.value = {};
  myTactics.value = clone(clubs.value[i].tactics);
  myRoster.value = seedContracts([...clubs.value[i].team.players]);
  prevById.value = snapRosters();   // new club → new baseline
  ledger.value = null;
  listings.value = aiListings(clubs.value, i, marketEligible());
  myListed.value = new Set();
  forcedStart.value = new Set(); forcedBench.value = new Set();
  playoffs.value = null; facilities.value = defaultFacilities(); academy.value = defaultAcademy(); staff.value = {}; retirements.value = []; contractDepartures.value = []; marketWave.value = []; scouted.value = new Map();
  syncLineup();
  objective.value = computeObjective(); objectiveOutcome.value = null;
  fatigue.value = new Map(); injuries.value = new Map(); lastInjury.value = null; morale.value = new Map(); teamTalk.value = null;
  rivalId.value = null; derbyRecord.value = { w: 0, l: 0 }; lastDerby.value = null; ensureRival(); lastAwards.value = null; awardsHistory.value = []; boardConfidence.value = 60; sacked.value = false; sponsor.value = null; lastSponsorPay.value = null;
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
  myRoster.value = seedContracts([...clubs.value[myClub.value].team.players]);
  prevById.value = snapRosters();   // fresh season-1 baseline
  balances.value = clubs.value.map(c => startingBalance(c.strength));
  ledger.value = null;
  patch.value = fullPatch(PATCH, ALL_AGENTS); metaChanges.value = [];
  forcedStart.value = new Set(); forcedBench.value = new Set();
  playoffs.value = null; titles.value = clubs.value.map(() => 0);
  staff.value = {}; facilities.value = defaultFacilities(); academy.value = defaultAcademy(); retirements.value = []; contractDepartures.value = []; marketWave.value = []; scouted.value = new Map();
  objective.value = computeObjective(); objectiveOutcome.value = null;
  fatigue.value = new Map(); injuries.value = new Map(); lastInjury.value = null; morale.value = new Map(); teamTalk.value = null;
  rivalId.value = null; derbyRecord.value = { w: 0, l: 0 }; lastDerby.value = null; ensureRival(); lastAwards.value = null; awardsHistory.value = []; boardConfidence.value = 60; sacked.value = false; sponsor.value = null; lastSponsorPay.value = null;
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
const retag = (p: Player, clubId: string, igl?: boolean): Player => ({ ...p, id: `${clubId}-${p.handle.toLowerCase()}`, igl, tenure: 0 });   // a signing hasn't gelled yet
const release = (p: Player): Player => ({ ...p, id: `fa-${p.handle.toLowerCase()}`, igl: false, contract: undefined });   // a free agent carries no deal
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
  const stayed: Player[] = [];
  for (const p of myRoster.value) {
    if (shouldRetire(p, rng)) events.push({ handle: p.handle, age: p.age, role: p.role, overall: overall(p), club: myClub.value, mine: true });
    else stayed.push(p);
  }
  if (stayed.length !== myRoster.value.length) myRoster.value = fillRoles(stayed, rng);
  retirements.value = events;
}

// ensure your roster covers every comp role (after departures — retirement / contract
// expiry): graduate your best academy prospect of the short role (no fee), else call
// up a generated youth. Anyone promoted in signs a fresh first contract.
function fillRoles(roster: Player[], rng: Rng): Player[] {
  const myId = clubs.value[myClub.value].team.id;
  const used = new Set<string>([...allHandles(), ...roster.map(p => p.handle)]);
  const freshHandle = () => { const h = HANDLES.find(x => !used.has(x)) ?? `Sub${moveSeq++}`; used.add(h); return h; };
  let out = roster;
  for (const role of Object.keys(ROLE_NEED) as Role[]) {
    while (out.filter(p => p.role === role).length < ROLE_NEED[role]) {
      const prospect = academy.value.prospects.filter(p => p.role === role).sort((a, b) => overall(b) - overall(a))[0];
      if (prospect) {
        academy.value = { ...academy.value, prospects: academy.value.prospects.filter(x => x.id !== prospect.id) };
        out = [...out, { ...retag(prospect, myId, false), contract: newContract(prospect, patch.value) }];
      } else {
        const youth = makePlayer(rng, role, freshHandle(), myId, 0.4, rng.int(17, 19));
        out = [...out, { ...youth, igl: false, contract: newContract(youth, patch.value) }];
      }
    }
  }
  return out;
}

// contracts tick down each off-season; a player whose deal hits 0 and wasn't renewed
// walks to free agency for nothing (the "use it or lose it" pressure). Roster holes
// are covered by `fillRoles`, and the departures surface in a banner.
function processContracts(rng: Rng) {
  const ticked = myRoster.value.map(p => p.contract ? { ...p, contract: { ...p.contract, years: p.contract.years - 1 } } : p);
  const expired = ticked.filter(p => p.contract && p.contract.years <= 0);
  if (!expired.length) { myRoster.value = ticked; contractDepartures.value = []; return; }
  freeAgentPool.value = [...expired.map(p => release(p)), ...freeAgentPool.value];
  myRoster.value = fillRoles(ticked.filter(p => !(p.contract && p.contract.years <= 0)), rng);
  contractDepartures.value = expired.map(p => ({ handle: p.handle, role: p.role, overall: overall(p) }));
}
/** Re-sign one of your players to a fresh deal at his CURRENT market wage — a raise
 *  for an improved youngster, a cut for a faded vet; either way you keep him. */
function renewPlayer(id: string) {
  myRoster.value = myRoster.value.map(p => p.id === id ? { ...p, contract: newContract(p, patch.value, CONTRACT_YEARS) } : p);
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
  // a signing comes on a fresh deal — his wage is now LOCKED for the term (the
  // lasting cost: you pay it even if he declines, until it expires or you sell him)
  const signed = { ...retag(e.player, clubs.value[myClub.value].team.id, false), contract: newContract(e.player, patch.value, CONTRACT_YEARS) };
  myRoster.value = [...myRoster.value, signed];
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
    const price = value(mine);   // your scouted (de-risked) value — the report transfers with the sale
    const buyer = clubs.value.findIndex((_, i) => i !== myClub.value && balances.value[i] >= price && aiWantsToBuy(clubs.value, balances.value, i, mine));
    if (buyer < 0) continue;
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

// The LIVING MARKET — the board moves even when you're not in it. Each match-day a
// couple of motivated AI clubs (rising/rebuilding, with cash) sign the best upgrade
// they can find from free agency OR another club's listed players. A signing is a
// SWAP (AI squads are five): the buyer's weaker same-role player goes the other way
// (to free agency, or the seller restocks), so the pool churns — the gems get
// snapped up. This is the urgency: spot a free agent and bid before a rival takes
// him. Deterministic (no rng beyond the existing restock), bounded per day.
const AI_SIGNINGS_PER_DAY = 2;
function executeAiSigning(buyer: number, t: MarketEntry, price: number) {
  const bteam = clubs.value[buyer].team;
  const slot = bteam.players.findIndex(p => p.role === t.player.role);
  const dropped = bteam.players[slot];
  clubs.value = clubs.value.map((c, i) => i === buyer ? withPlayer(c, slot, retag(t.player, bteam.id, dropped.igl)) : c);
  balances.value = balances.value.map((b, i) => i === buyer ? b - price : b);
  if (t.from === -1) {                       // from free agency: dropped player replaces the signed FA in the pool
    freeAgentPool.value = [release(dropped), ...freeAgentPool.value.filter(p => p.id !== t.player.id)];
  } else {                                   // club-to-club: seller banks the fee + restocks; dropped → free agency
    balances.value = balances.value.map((b, i) => i === t.from ? b + price : b);
    sellerRestock(t.from, t.player.id);
    listings.value = listings.value.filter(l => !(l.club === t.from && l.playerId === t.player.id));
    freeAgentPool.value = [release(dropped), ...freeAgentPool.value];
  }
}
function resolveAiMarket() {
  if (!navReady) return;
  const targets: MarketEntry[] = [
    ...freeAgentPool.value.map(p => ({ player: p, from: -1 })),
    ...listings.value.map(l => { const p = clubs.value[l.club]?.team.players.find(q => q.id === l.playerId); return p ? { player: p, from: l.club } : null; }).filter((e): e is MarketEntry => !!e),
  ];
  // motivated buyers: rising/rebuilding AI clubs, richest first (deterministic, no rng)
  const buyers = clubs.value.map((_, i) => i)
    .filter(i => i !== myClub.value && ['rising', 'rebuilding'].includes(clubPhase(clubs.value[i].team)))
    .sort((a, b) => balances.value[b] - balances.value[a]);
  let moves = 0;
  for (const buyer of buyers) {
    if (moves >= AI_SIGNINGS_PER_DAY) break;
    const bank = balances.value[buyer];
    const phase = clubPhase(clubs.value[buyer].team);
    // the buyer judges targets by its stage-weighted rating — so a rebuilding club
    // will sign a high-ceiling PROSPECT, not just a current-ability upgrade
    let best: { t: MarketEntry; gain: number; price: number } | null = null;
    for (const t of targets) {
      if (t.from === buyer) continue;
      const mine = clubs.value[buyer].team.players.find(p => p.role === t.player.role);
      if (!mine || overall(t.player) < overall(mine) - 8) continue;    // not too raw to field
      const gain = aiRating(t.player, phase) - aiRating(mine, phase);
      if (gain <= 1) continue;                                         // a real rating upgrade
      const price = playerValue(t.player, patch.value);               // consensus price (no private scouting)
      if (price > bank * 0.55) continue;                              // prudent — keep a reserve
      if (!best || gain > best.gain) best = { t, gain, price };
    }
    if (!best) continue;
    executeAiSigning(buyer, best.t, best.price);
    targets.splice(targets.indexOf(best.t), 1);   // don't double-sign this tick
    moves++;
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
    retirements: retirements.value, contractDepartures: contractDepartures.value, marketWave: marketWave.value, scouted: [...scouted.value.entries()],
    prevById: [...prevById.value.entries()], objectiveOutcome: objectiveOutcome.value,
    focuses: [...focuses.value.entries()],
    fatigue: [...fatigue.value.entries()], injuries: [...injuries.value.entries()], staff: staff.value,
    morale: [...morale.value.entries()], rivalId: rivalId.value, derbyRecord: derbyRecord.value,
    lastAwards: lastAwards.value, awardsHistory: awardsHistory.value,
    boardConfidence: boardConfidence.value, sacked: sacked.value,
    sponsor: sponsor.value, lastSponsorPay: lastSponsorPay.value,
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
  contractDepartures.value = o.contractDepartures ?? []; marketWave.value = o.marketWave ?? [];
  scouted.value = new Map(o.scouted ?? []);
  prevById.value = new Map(o.prevById);
  objectiveOutcome.value = (o as { objectiveOutcome?: typeof objectiveOutcome.value }).objectiveOutcome ?? null;
  focuses.value = new Map((o as { focuses?: [string, keyof Attributes][] }).focuses ?? []);
  fatigue.value = new Map((o as { fatigue?: [string, number][] }).fatigue ?? []);
  injuries.value = new Map((o as { injuries?: [string, number][] }).injuries ?? []);
  staff.value = (o as { staff?: StaffHires }).staff ?? {};
  morale.value = new Map((o as { morale?: [string, number][] }).morale ?? []);
  rivalId.value = (o as { rivalId?: number | null }).rivalId ?? null;
  derbyRecord.value = (o as { derbyRecord?: { w: number; l: number } }).derbyRecord ?? { w: 0, l: 0 };
  lastAwards.value = (o as { lastAwards?: SeasonAwards | null }).lastAwards ?? null;
  awardsHistory.value = (o as { awardsHistory?: SeasonAwards[] }).awardsHistory ?? [];
  boardConfidence.value = (o as { boardConfidence?: number }).boardConfidence ?? 60;
  sacked.value = (o as { sacked?: boolean }).sacked ?? false;
  sponsor.value = (o as { sponsor?: ActiveSponsor | null }).sponsor ?? null;
  lastSponsorPay.value = (o as { lastSponsorPay?: typeof lastSponsorPay.value }).lastSponsorPay ?? null;
  objective.value = computeObjective();   // derived from restored strength/division
}
function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } hasSave.value = false; }

// restore an existing career BEFORE wiring the autosave watcher, so hydration
// doesn't re-trigger a save of identical data.
const _saved = loadSave();
if (_saved) { hydrate(_saved); hasSave.value = true; }
ensureRival();   // pick your rival if a fresh start / a pre-rivalry save didn't carry one

// autosave: the store reassigns these refs immutably on every change, so a
// shallow watch catches them all. Debounced so a fast "sim to end" (many
// match-days) collapses into one write.
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  [seasonSeed, clubs, division, lastMoves, results, dayIdx, myClub, season, balances, ledger, titles, myComp, myTactics,
    myRoster, freeAgentPool, listings, myListed, patch, metaChanges, playoffs, forcedStart, forcedBench, prevById, facilities, academy, staff, retirements, contractDepartures, marketWave, scouted, focuses, fatigue, injuries, morale, teamTalk, rivalId, derbyRecord, lastAwards, awardsHistory, boardConfidence, sacked, sponsor, lastSponsorPay],
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
    objective, objectiveMet, objectiveRank, objectiveOutcome,
    buildInput, simFixture, resolveDay, simSeason, enterPlayoffs, advanceSeason, selectClub, newWorld, ensureNav, getNav,
    myPlayerOf, value, canAfford, isStarter, isListed, canSell, acquire, sellPlayer, toggleList,
    bidFor, isContested, askingOf, chemOf, teamCohesion,
    scoutLevelOf, scoutCost, canScout, scoutPlayer, SCOUT_MAX, focusOf, setFocus,
    fatigueOf, injuryOf, isInjured, isTired, lastInjury,
    staff, staffMkt, staffEff, staffWages, hiredStaff, hireStaff, fireStaff, STAFF_ROLES,
    moraleOf, squadMorale, teamTalk, setTalk, talkPreview, talkFit, TALK_META,
    rivalId, derbyRecord, isRival, nextIsDerby, lastDerby, lastAwards, awardsHistory,
    boardConfidence, sacked, confidenceStatus,
    sponsor, sponsorOffersList, lastSponsorPay, goalTextOf, signSponsor,
    wageOf, renewCost, yearsLeft, isExpiring, renewPlayer, myWageBill, contractDepartures, marketWave,
    canBench, isBenched, isStarterPinned, startReserve, benchStarter,
  };
}
