// WorldState — the whole persistent world as ONE value object the server holds
// and ticks (docs/PHASE2.md). Pure and headless: `createWorld` generates it from
// a seed, `simulateSeason` resolves a season, `advanceWorld` rolls the off-season
// (playoffs → settle → develop → patch → promote/relegate). The single-player
// store will consolidate onto this shape; the server persists it to rows and runs
// the exact same functions on the tick. No Vue, no I/O.
import type { Player, Tactics, Comp, Team, PatchState, Attributes, MapId, Play } from '@ace/shared';
import { Rng, PATCH } from '@ace/engine';
import { makeLeague, ROLE_AGENTS } from './clubs.js';
import { divisionSchedule, funnelPromoteRelegate, promoteRelegate, snakeGroup, type DivMove } from './divisions.js';
import type { Fixture, Matchday } from './schedule.js';
import { standings, fixtureSeed, type MatchResult } from './season.js';
import { runPlayoffs, runPromotionPlayoff, PLAYOFF_SLOTS, finishOf } from './playoffs.js';
import { createCup, cupRoundDue, resolveCupRound, type CupState } from './cup.js';
import type { Fitness } from './fitness.js';
import type { Morale, Talk } from './morale.js';
import { CAMP_CHEM, type Camp } from './camps.js';
import { quickResult, settleClub, squadWageBill } from './resolve.js';
import { developPlayer, developInSeason, SEASON_SHARE, overall, squadRating, NO_BOOST, isMentor, mentorBoost } from './develop.js';
import { facilityBoost, facilityUpkeep, type Facilities } from './facilities.js';
import { staffEffect, withStaffBoost, staffWageBill, type StaffHires } from './staff.js';
import { sponsorGoalMet, type ActiveSponsor } from './sponsor.js';
import { computeObjective, confDelta, CONF_START, type Objective, type BoardOutcome } from './objectives.js';
import type { DevBoost } from './develop.js';
import { startingBalance, playoffPrize } from './finance.js';
import { fullPatch, patchMeta, type MetaChange } from './meta.js';

/** The rank pyramid's tier names, top → bottom (the pro leagues, then the
 *  solo-queue ladder). The world's single source of truth for tier labels. */
export const RANK_TIERS = ['Premier', 'Challengers', 'Radiant', 'Immortal', 'Ascendant', 'Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Iron'];

const ALL_AGENTS = Object.values(ROLE_AGENTS).flat();
const clampStr = (s: number) => Math.max(0.3, Math.min(0.95, s));
const ROLE_NEED = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 } as const;

/** A club in the world: a full roster (depth), a plan, money, a tier/group slot.
 *  `owner` is the human overlay (null = AI) — the server sets it on claim.
 *  The **plan** the tick grabs is `(tactics, comp, lineup)`: an AI/ghosting club
 *  runs its generated tactics + comp and the derived best five; a human owner may
 *  override `lineup` (an explicit chosen five). `lineup` is additive/optional —
 *  undefined derives the best five (`startingFive`), so every existing world is
 *  byte-identical. */
export interface WorldClub {
  id: string; name: string; tag: string;
  tier: number; group: number;
  roster: Player[]; tactics: Tactics; comp: Comp;
  strength: number; balance: number; titles: number;
  owner: string | null;
  lineup?: string[];   // an owner's explicit five (player ids); undefined → best five
  intlTitles?: number; // international (Masters) titles won — prestige, additive/opt-in
  cupTitles?: number;  // domestic ACE Cup wins — additive/opt-in (crowned at the rollover)
  facilities?: Facilities;   // an owner's HQ rooms (the dev money-sink); undefined → no boost (AI/abstract)
  staff?: StaffHires;        // an owner's backroom staff (coach/analyst/psych); undefined → no effect
  sponsor?: ActiveSponsor;   // an owner's signed sponsorship (a season income stream + a goal)
  boardObjective?: Objective;    // the board's season brief (from pre-season strength rank)
  boardConfidence?: number;      // the board's confidence in the owner (0..100; starts CONF_START)
  boardOutcome?: BoardOutcome;   // last season's verdict (for the off-season banner)
  focuses?: Record<string, keyof Attributes>;   // an owner's per-player training focus (id → skill); undefined → balanced
  teamTalk?: Talk;      // the owner's chosen pre-match tone (one-shot; consumed + cleared after the match)
  captain?: string;     // the owner's named captain (player id); undefined → the best natural leader in the five
  rival?: string;       // the owner's derby rival (club id — nearest strength at claim; spans leagues if either moves)
  derby?: { w: number; l: number };   // head-to-head record vs the rival (builds over the career)
  camp?: Camp;          // the owner's pre-season training camp (fitness/chemistry/sharpness); reset each rollover
  /** An owner's PER-MAP playbook: authored plays keyed by the pool map they were
   *  drawn on (coordinates are map-space). The tick overlays the FIXTURE map's
   *  slots into the club's tactics at resolution time — so an authored bind
   *  setup fields exactly when the rotation lands on bind. Additive/optional:
   *  undefined = no plays = byte-identical worlds. */
  plays?: Partial<Record<MapId, ClubPlaybook>>;
}

/** One map's authored plays: the primary execute, the optional ALT execute (two
 *  executes on different sites make the engine roll the site per round), and the
 *  defensive setup. */
export interface ClubPlaybook { attack?: Play; attack2?: Play; defense?: Play }

/** A club's strength rank within its own (tier, group) division — 1 = strongest. Used to set
 *  the board objective (a favourite gets a harder brief). */
export function strengthRankIn(clubs: WorldClub[], i: number): number {
  const c = clubs[i];
  const peers = clubs.map((x, j) => ({ j, s: x.strength })).filter(m => clubs[m.j].tier === c.tier && clubs[m.j].group === c.group).sort((a, b) => b.s - a.s);
  return peers.findIndex(m => m.j === i) + 1;
}

/** The nearest-strength club in a club's own division — its natural derby rival (picked once at
 *  claim, then fixed for the career, so the derby spans the leagues even if either side moves).
 *  Deterministic (ties broken by index). Returns the rival club id, or null if it stands alone. */
export function pickRival(clubs: WorldClub[], i: number): string | null {
  const me = clubs[i];
  const peers = clubs.map((c, j) => ({ j, s: c.strength })).filter(m => m.j !== i && clubs[m.j].tier === me.tier && clubs[m.j].group === me.group);
  if (!peers.length) return null;
  peers.sort((a, b) => Math.abs(a.s - me.strength) - Math.abs(b.s - me.strength) || a.j - b.j);
  return clubs[peers[0].j].id;
}

/** An owned club's combined development boost: HQ rooms × backroom staff. Undefined for both
 *  → NO_BOOST, so AI clubs + no-owner worlds are byte-identical. */
export function clubDevBoost(c: WorldClub): DevBoost {
  const base = c.facilities ? facilityBoost(c.facilities) : NO_BOOST;
  return c.staff ? withStaffBoost(base, staffEffect(c.staff)) : base;
}

/** Whether a club runs the owner-only development levers (training focus + mentoring). AI
 *  clubs and no-owner worlds don't — so their development is byte-identical. */
const hasDevLevers = (c: WorldClub): boolean => !!c.owner && (!!c.focuses || c.roster.some(isMentor));

/** Develop a club's whole roster one in-season match-day. For an OWNED club, the owner's
 *  training focus (per-player skill bias) and mentoring (a vet leader speeds the kids) fold
 *  into each player's boost; AI clubs use the plain boost, so a no-owner world is byte-identical. */
function developClubDay(c: WorldClub, five: Set<string>, total: number, rng: Rng): Player[] {
  const boost = clubDevBoost(c);
  if (!hasDevLevers(c)) return c.roster.map(p => developInSeason(p, five.has(p.id), total, rng, boost));
  const hasM = c.roster.some(isMentor);
  return c.roster.map(p => developInSeason(p, five.has(p.id), total, rng, mentorBoost(boost, p, hasM), c.focuses?.[p.id]));
}

/** Develop a club's roster the off-season bootcamp share (age +1). Owner levers as above. */
function developClubOff(c: WorldClub, rng: Rng, frac: number): Player[] {
  const boost = clubDevBoost(c);
  if (!hasDevLevers(c)) return c.roster.map(p => developPlayer(p, rng, frac, boost));
  const hasM = c.roster.some(isMentor);
  return c.roster.map(p => developPlayer(p, rng, frac, mentorBoost(boost, p, hasM), c.focuses?.[p.id]));
}

export interface WorldState {
  seed: number; region: string;
  tiers: number; size: number; promo: number;
  layout: number[];         // groups per tier (the pyramid: 1 at the top, wider below)
  season: number; day: number;
  patch: PatchState;
  clubs: WorldClub[];
  results: MatchResult[];   // the current season's fixtures
  cup?: CupState;           // the season's domestic cup (ticks day-by-day; opt-in/additive)
  fitness?: Fitness;        // fatigue + injuries for HUMAN-OWNED clubs' players (opt-in/additive)
  morale?: Morale;          // per-player mood for HUMAN-OWNED clubs (opt-in/additive; no owners → absent)
}

/** Every `(tier, group)` division and its member club indices, tier-major. A flat
 *  world (every tier one group) yields one division per tier — the order the
 *  pre-fan-out code iterated, so it stays byte-identical. */
export interface WorldDivision { tier: number; group: number; members: number[] }
export function worldDivisions(w: WorldState): WorldDivision[] {
  const out: WorldDivision[] = [];
  for (let t = 0; t < w.tiers; t++)
    for (let g = 0; g < w.layout[t]; g++)
      out.push({ tier: t, group: g, members: w.clubs.map((c, i) => [c, i] as const).filter(([c]) => c.tier === t && c.group === g).map(([, i]) => i) });
  return out;
}

/** Per-fixture seed offset for a division. Spaced so tiers (×1000) and groups
 *  (×1e6) never collide with a within-day slot, and **group 0 reduces to the old
 *  `tier·1000`** — so a flat world's fixture seeds are unchanged. */
const divSeedOffset = (tier: number, group: number): number => tier * 1000 + group * 1_000_000;

/** Assign `n` strength-descending clubs to `(tier, group)` slots per a layout: tier
 *  t holds `size·layout[t]` clubs top-down, snake-seeded across its groups by
 *  strength. A flat layout (all 1s) gives `tier = floor(i/size)`, group 0 — exactly
 *  the pre-fan-out assignment, so generated worlds are byte-identical. */
function assignDivisions(layout: number[], size: number, n: number): { tierOf: number[]; groupOf: number[] } {
  const T = layout.length;
  const cap = layout.map(g => g * size);
  const tierOf: number[] = [];
  let t = 0, used = 0;
  for (let i = 0; i < n; i++) {
    while (t < T - 1 && i >= used + cap[t]) { used += cap[t]; t++; }
    tierOf.push(t);
  }
  const groupOf = new Array<number>(n).fill(0);
  for (let tt = 0; tt < T; tt++) {
    let j = 0;
    for (let i = 0; i < n; i++) if (tierOf[i] === tt) { groupOf[i] = snakeGroup(j, layout[tt]); j++; }
  }
  return { tierOf, groupOf };
}

/** The best five from a roster (2 duelists + 1 each, IGL = the sentinel) — what
 *  the engine actually fields. Depth never reaches the contract. */
export function startingFive(roster: Player[]): Player[] {
  const five: Player[] = [];
  (['duelist', 'initiator', 'controller', 'sentinel'] as const).forEach(role => {
    const inRole = roster.filter(p => p.role === role).sort((a, b) => overall(b) - overall(a));
    five.push(...inRole.slice(0, ROLE_NEED[role]));
  });
  return five.map(p => ({ ...p, igl: p.role === 'sentinel' }));
}

/** Does this exact five satisfy the comp floor (2 duelist + 1 init/ctrl/sentinel)?
 *  The engine assumes a valid composition; a forced lineup that doesn't is ignored. */
export function validFive(five: Player[]): boolean {
  if (five.length !== 5) return false;
  return (['duelist', 'initiator', 'controller', 'sentinel'] as const)
    .every(role => five.filter(p => p.role === role).length === ROLE_NEED[role]);
}

/** The five a club actually fields: an owner's explicit `lineup` when it's a valid
 *  five drawn from the roster, otherwise the derived best five. So a saved lineup
 *  can never break the always-field-a-competent-five rule — a stale/invalid one
 *  simply falls back (defense in depth alongside the `setClubPlan` validation). */
export function planFive(c: WorldClub): Player[] {
  if (c.lineup && c.lineup.length === 5) {
    const chosen = c.lineup.map(id => c.roster.find(p => p.id === id)).filter((p): p is Player => !!p);
    if (validFive(chosen)) return chosen.map(p => ({ ...p, igl: p.role === 'sentinel' }));
  }
  return startingFive(c.roster);
}
export const clubTeam = (c: WorldClub): Team => ({ id: c.id, tag: c.tag, name: c.name, players: planFive(c) });

/** Generate a fresh world from a seed: a strength-descending field split into the
 *  rank pyramid. `tiers` tiers of `size` (Premier at the top, the ladder below) by
 *  default — pass `layout` (groups per tier, e.g. `[1,2,4]`) for the at-scale
 *  fan-out where a tier is many parallel divisions, wider toward the base
 *  (docs/PHASE2.md §3). The flat default (every tier one group) is byte-identical
 *  to before fan-out. */
export function createWorld(seed: number, opts: { tiers?: number; size?: number; promo?: number; region?: string; layout?: number[] } = {}): WorldState {
  const tiers = opts.tiers ?? 11, size = opts.size ?? 16, promo = opts.promo ?? 2;
  const layout = opts.layout ?? new Array<number>(tiers).fill(1);
  const n = layout.reduce((a, b) => a + b, 0) * size;
  const { tierOf, groupOf } = assignDivisions(layout, size, n);
  const clubs = makeLeague(seed, n).map((c, i): WorldClub => ({
    id: c.team.id, name: c.team.name, tag: c.team.tag,
    tier: tierOf[i], group: groupOf[i],
    roster: c.team.players, tactics: c.tactics, comp: {},
    strength: c.strength, balance: startingBalance(c.strength), titles: 0, owner: null,
  }));
  return { seed, region: opts.region ?? 'AMER', tiers: layout.length, size, promo, layout, season: 1, day: 0, patch: fullPatch(PATCH, ALL_AGENTS), clubs, results: [], cup: createCup(clubs.map((_, i) => i), 1) };
}

/** One `(tier, group)` division's final table (best-first) from the season's
 *  results. A division's fixtures are intra-division, so filtering results by the
 *  home club's `(tier, group)` selects exactly that table's games. The Premier table
 *  is `divisionTable(w, 0, 0)` — what seeds the playoff bracket + the international
 *  circuit. */
export function divisionTable(w: WorldState, tier: number, group: number): ReturnType<typeof standings> {
  const res = w.results.filter(r => w.clubs[r.home].tier === tier && w.clubs[r.home].group === group);
  return standings(w.clubs.length, res).filter(s => w.clubs[s.club].tier === tier && w.clubs[s.club].group === group);
}

/** A lookup of every division's final table, built once for the off-season roll. */
function divTables(w: WorldState): (tier: number, group: number) => ReturnType<typeof standings> {
  const map = new Map<number, ReturnType<typeof standings>>();
  for (const d of worldDivisions(w)) map.set(divSeedOffset(d.tier, d.group), divisionTable(w, d.tier, d.group));
  return (tier, group) => map.get(divSeedOffset(tier, group)) ?? [];
}

/** Resolve ONE match-day across every division + apply that day's in-season
 *  development (the five who played grow on reps; reserves rust). This is the
 *  shared per-day step — the single seam the two runtimes share: `simulateSeason`
 *  loops it with a single season-long `devRng` (headless), and the day-granular
 *  runtimes (the single-player store, the Phase-2 server tick) call it once per
 *  tick with their own rng, persisting between. How each fixture is scored is
 *  injectable (`resolve`) — quick-resolve by default, the server full-sims the
 *  watched divisions. Pure (docs/PHASE2.md §2/§6). */
export function resolveSeasonDay(w: WorldState, day: number, devRng: Rng, opts: {
  schedules?: Matchday[][];
  resolve?: (fx: Fixture, seed: number, division: number) => MatchResult;
} = {}): { results: MatchResult[]; clubs: WorldClub[] } {
  const divs = worldDivisions(w);
  const schedules = opts.schedules ?? divs.map(d => divisionSchedule(d.members));
  const seasonSeed = (w.seed ^ (w.season * 0x85ebca6b)) >>> 0;
  const total = schedules[0].length;
  const results: MatchResult[] = [];
  divs.forEach((d, di) => schedules[di][day].forEach((fx, slot) => {
    const seed = fixtureSeed(seasonSeed, day, slot + divSeedOffset(d.tier, d.group));
    results.push(opts.resolve ? opts.resolve(fx, seed, d.tier) : quickResult(fx.home, fx.away, w.clubs[fx.home].strength, w.clubs[fx.away].strength, seed));
  }));
  const clubs = w.clubs.map(c => {
    // develop on the five a club actually FIELDS (`planFive` honours an owner's explicit
    // lineup), so playing time is a real lever: start a graduated prospect and he gets
    // reps and grows; leave him benched and he rusts. For a generated club with no
    // lineup, `planFive` === `startingFive`, so the world/season CLIs are byte-identical.
    const five = new Set(planFive(c).map(p => p.id));
    // an owner's HQ × staff speeds growth, and (owned only) training focus + mentoring bias
    // it further; AI clubs take the plain boost, so a no-owner world is byte-identical.
    const roster = developClubDay(c, five, total, devRng);
    return { ...c, roster, strength: clampStr(squadRating(clubTeam({ ...c, roster })) / 100) };
  });
  return { results, clubs };
}

/** Resolve the whole season headless: every division quick-resolved by strength
 *  (the server full-sims watched tiers instead; the math is the same). Loops the
 *  shared `resolveSeasonDay` with one season-long rng, so its stream is unchanged. */
export function simulateSeason(w: WorldState): WorldState {
  const schedules = worldDivisions(w).map(d => divisionSchedule(d.members));
  const devRng = new Rng((w.seed ^ (w.season * 0x2545f491)) >>> 0);
  const total = schedules[0].length;
  const results: MatchResult[] = [];
  let cur: WorldState = w;
  let cup = w.cup ?? createCup(w.clubs.map((_, i) => i), w.season);
  for (let day = 0; day < total; day++) {
    const r = resolveSeasonDay(cur, day, devRng, { schedules });
    results.push(...r.results);
    cur = { ...cur, clubs: r.clubs };
    // the cup ticks with the league — headless quick-resolve (no engine, no snapshots)
    if (cupRoundDue(cup, day)) cup = resolveCupRound(cup, i => cur.clubs[i].strength, w.seed, w.season,
      (h, a, seed) => ({ result: quickResult(h, a, cur.clubs[h].strength, cur.clubs[a].strength, seed) }));
  }
  return { ...cur, results, day: total, cup };
}

export interface Rollover { world: WorldState; champion: number; moves: DivMove[]; notes: MetaChange[]; cupChampion: number | null }

/** Roll the off-season: top-tier playoffs (a champion + a title), settle every
 *  club's books by division rank, develop every squad, shift the meta, then
 *  promote/relegate across all boundaries. Returns the new world + the events. */
export function advanceWorld(w: WorldState): Rollover {
  const tableOf = divTables(w);
  const rankIn = (i: number) => { const c = w.clubs[i]; return tableOf(c.tier, c.group).findIndex(s => s.club === i) + 1; };
  // the Premier (tier 0, always one group) crowns a champion via the playoff
  // bracket (quick-resolved, so the map veto is trivial — strength is map-agnostic)
  const premier = tableOf(0, 0);
  const bracket = runPlayoffs(premier, w.seed, w.season, ['ascent'], () => 0, (h, a, seed) => quickResult(h, a, w.clubs[h].strength, w.clubs[a].strength, seed));
  const champion = bracket.champion ?? premier[0].club;
  const poPrize = (i: number) => w.clubs[i].tier === 0 ? playoffPrize(finishOf(bracket, i)) : 0;
  const devRng = new Rng((w.seed ^ (w.season * 0x9e3779b9)) >>> 0);
  const cupChampion = w.cup?.champion ?? null;   // the finishing season's ACE Cup winners (crowned here)
  let clubs = w.clubs.map((c, i): WorldClub => {
    const overhead = (c.facilities ? facilityUpkeep(c.facilities) : 0) + (c.staff ? staffWageBill(c.staff) : 0);   // HQ upkeep + staff wages (a ledger line)
    const led = settleClub({ rank: rankIn(i), divSize: w.size, tier: c.tier, wages: squadWageBill(c.roster) + overhead, playoff: poPrize(i) });
    let roster = developClubOff(c, devRng, 1 - SEASON_SHARE);  // bootcamp share — the rest grew in-season (owner focus + mentoring folded in)
    // team chemistry gels a season for an OWNED club — a fresh signing (tenure 0) settles,
    // the core deepens (a chemistry camp gels faster). Grown +1/season (the engine's teamChem
    // clamps the effect at CHEM_CAP). Owner-scoped, so AI clubs + a no-owner world are byte-identical.
    if (c.owner) { const gel = c.camp === 'chemistry' ? CAMP_CHEM : 1; roster = roster.map(p => ({ ...p, tenure: (p.tenure ?? 0) + gel })); }
    // board objective (owner-scoped): did you meet the brief? a bonus + a confidence move.
    let boardConfidence = c.boardConfidence, boardOutcome = c.boardOutcome, objMet = false, objBonus = 0;
    if (c.owner && c.boardObjective) {
      const finish = rankIn(i);
      objMet = finish > 0 && finish <= c.boardObjective.needRank;
      objBonus = objMet ? c.boardObjective.bonus : 0;
      boardOutcome = { met: objMet, label: c.boardObjective.label, bonus: objBonus, finish };
      boardConfidence = Math.max(0, Math.min(100, (c.boardConfidence ?? CONF_START) + confDelta(objMet, c.boardObjective.needRank, finish)));
    }
    // sponsorship: the base cheque always, the bonus if its goal was met this season (the
    // 'objective' goal reads the board brief above); then the deal ticks down + clears.
    let sponsor = c.sponsor, sponsorPay = 0;
    if (sponsor) {
      const wins = w.results.filter(r => r.winner === i).length;
      const met = sponsorGoalMet(sponsor.goal, sponsor.goalN, { objMet, finish: rankIn(i), divSize: w.size, promo: w.promo, wins });
      sponsorPay = sponsor.base + (met ? sponsor.bonus : 0);
      const yl = sponsor.yearsLeft - 1;
      sponsor = yl > 0 ? { ...sponsor, yearsLeft: yl } : undefined;
    }
    return { ...c, sponsor, roster, camp: undefined, strength: clampStr(squadRating(clubTeam({ ...c, roster })) / 100), balance: c.balance + led.net + sponsorPay + objBonus, titles: c.titles + (i === champion ? 1 : 0), cupTitles: (c.cupTitles ?? 0) + (i === cupChampion ? 1 : 0), boardConfidence, boardOutcome };
  });
  const meta = patchMeta(w.patch, new Rng((w.seed ^ (w.season * 0x27d4eb2f)) >>> 0));
  // promote/relegate. A FLAT world (every tier one group — the single-player + PvP
  // shape) also runs a promotion PLAYOFF per boundary: the clubs just below the auto
  // line challenge those just above the drop zone for the contested spots (quick-resolved
  // here — strength is map-agnostic, like the Premier bracket above). A GROUPED pyramid
  // (the circuit/fan-out) keeps the straight funnel, which the flat case reduces to.
  let moves: DivMove[];
  if (w.layout.every(g => g === 1)) {
    const division = w.clubs.map(c => c.tier);
    const tablesByTier = Array.from({ length: w.layout.length }, (_, t) => tableOf(t, 0));
    const pr = promoteRelegate(division, tablesByTier, w.promo, (boundary, upper, lower) => {
      const pp = runPromotionPlayoff(upper, lower, w.promo, PLAYOFF_SLOTS, boundary, w.seed, w.season, ['ascent'], () => 0,
        (h, a, seed) => quickResult(h, a, w.clubs[h].strength, w.clubs[a].strength, seed));
      return pp ? { up: pp.up, down: pp.down } : null;
    });
    clubs = clubs.map((c, i) => ({ ...c, tier: pr.division[i], group: 0 }));
    moves = pr.moves;
  } else {
    const fr = funnelPromoteRelegate({
      tiers: clubs.map(c => c.tier), groups: clubs.map(c => c.group), layout: w.layout, k: w.promo,
      tableOf, strengthOf: i => w.clubs[i].strength,
    });
    clubs = clubs.map((c, i) => ({ ...c, tier: fr.tiers[i], group: fr.groups[i] }));
    moves = fr.moves;
  }
  // the board sets a fresh brief for owned clubs from their NEW division + strength rank
  clubs = clubs.map((c, i) => c.owner ? { ...c, boardObjective: computeObjective(strengthRankIn(clubs, i), c.tier, w.size, w.promo) } : c);
  // open a fresh cup for the new season (every club re-entered; club indices are stable)
  const cup = createCup(clubs.map((_, i) => i), w.season + 1);
  // the off-season heals everyone — fitness resets for the new campaign
  return { world: { ...w, clubs, patch: meta.patch, season: w.season + 1, day: 0, results: [], cup, fitness: undefined }, champion, moves, notes: meta.changes, cupChampion };
}
