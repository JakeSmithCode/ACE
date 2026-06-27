// WorldState — the whole persistent world as ONE value object the server holds
// and ticks (docs/PHASE2.md). Pure and headless: `createWorld` generates it from
// a seed, `simulateSeason` resolves a season, `advanceWorld` rolls the off-season
// (playoffs → settle → develop → patch → promote/relegate). The single-player
// store will consolidate onto this shape; the server persists it to rows and runs
// the exact same functions on the tick. No Vue, no I/O.
import type { Player, Tactics, Comp, Team, PatchState } from '@ace/shared';
import { Rng, PATCH } from '@ace/engine';
import { makeLeague, ROLE_AGENTS } from './clubs.js';
import { divisionSchedule, funnelPromoteRelegate, snakeGroup, type DivMove } from './divisions.js';
import type { Fixture, Matchday } from './schedule.js';
import { standings, fixtureSeed, type MatchResult } from './season.js';
import { runPlayoffs, finishOf } from './playoffs.js';
import { quickResult, settleClub, squadWageBill } from './resolve.js';
import { developPlayer, developInSeason, SEASON_SHARE, overall, squadRating } from './develop.js';
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
}

export interface WorldState {
  seed: number; region: string;
  tiers: number; size: number; promo: number;
  layout: number[];         // groups per tier (the pyramid: 1 at the top, wider below)
  season: number; day: number;
  patch: PatchState;
  clubs: WorldClub[];
  results: MatchResult[];   // the current season's fixtures
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
  const tiers = opts.tiers ?? 11, size = opts.size ?? 10, promo = opts.promo ?? 2;
  const layout = opts.layout ?? new Array<number>(tiers).fill(1);
  const n = layout.reduce((a, b) => a + b, 0) * size;
  const { tierOf, groupOf } = assignDivisions(layout, size, n);
  const clubs = makeLeague(seed, n).map((c, i): WorldClub => ({
    id: c.team.id, name: c.team.name, tag: c.team.tag,
    tier: tierOf[i], group: groupOf[i],
    roster: c.team.players, tactics: c.tactics, comp: {},
    strength: c.strength, balance: startingBalance(c.strength), titles: 0, owner: null,
  }));
  return { seed, region: opts.region ?? 'AMER', tiers: layout.length, size, promo, layout, season: 1, day: 0, patch: fullPatch(PATCH, ALL_AGENTS), clubs, results: [] };
}

/** A lookup of each `(tier, group)` division's final table (best-first), built once
 *  from the season's results. A division's fixtures are intra-division, so filtering
 *  results by the home club's `(tier, group)` selects exactly that table's games. */
function divTables(w: WorldState): (tier: number, group: number) => ReturnType<typeof standings> {
  const map = new Map<number, ReturnType<typeof standings>>();
  for (const d of worldDivisions(w)) {
    const res = w.results.filter(r => w.clubs[r.home].tier === d.tier && w.clubs[r.home].group === d.group);
    map.set(divSeedOffset(d.tier, d.group), standings(w.clubs.length, res).filter(s => w.clubs[s.club].tier === d.tier && w.clubs[s.club].group === d.group));
  }
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
    const five = new Set(startingFive(c.roster).map(p => p.id));
    const roster = c.roster.map(p => developInSeason(p, five.has(p.id), total, devRng));
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
  for (let day = 0; day < total; day++) {
    const r = resolveSeasonDay(cur, day, devRng, { schedules });
    results.push(...r.results);
    cur = { ...cur, clubs: r.clubs };
  }
  return { ...cur, results, day: total };
}

export interface Rollover { world: WorldState; champion: number; moves: DivMove[]; notes: MetaChange[] }

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
  let clubs = w.clubs.map((c, i): WorldClub => {
    const led = settleClub({ rank: rankIn(i), divSize: w.size, tier: c.tier, wages: squadWageBill(c.roster), playoff: poPrize(i) });
    const roster = c.roster.map(p => developPlayer(p, devRng, 1 - SEASON_SHARE));  // bootcamp share — the rest grew in-season
    return { ...c, roster, strength: clampStr(squadRating(clubTeam({ ...c, roster })) / 100), balance: c.balance + led.net, titles: c.titles + (i === champion ? 1 : 0) };
  });
  const meta = patchMeta(w.patch, new Rng((w.seed ^ (w.season * 0x27d4eb2f)) >>> 0));
  // the funnel: promote/relegate across all boundaries + regroup each tier (reduces
  // to plain promote/relegate when every tier is one group — the flat world)
  const fr = funnelPromoteRelegate({
    tiers: clubs.map(c => c.tier), groups: clubs.map(c => c.group), layout: w.layout, k: w.promo,
    tableOf, strengthOf: i => w.clubs[i].strength,
  });
  clubs = clubs.map((c, i) => ({ ...c, tier: fr.tiers[i], group: fr.groups[i] }));
  return { world: { ...w, clubs, patch: meta.patch, season: w.season + 1, day: 0, results: [] }, champion, moves: fr.moves, notes: meta.changes };
}
