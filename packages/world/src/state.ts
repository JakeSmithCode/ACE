// WorldState — the whole persistent world as ONE value object the server holds
// and ticks (docs/PHASE2.md). Pure and headless: `createWorld` generates it from
// a seed, `simulateSeason` resolves a season, `advanceWorld` rolls the off-season
// (playoffs → settle → develop → patch → promote/relegate). The single-player
// store will consolidate onto this shape; the server persists it to rows and runs
// the exact same functions on the tick. No Vue, no I/O.
import type { Player, Tactics, Comp, Team, PatchState } from '@ace/shared';
import { Rng, PATCH } from '@ace/engine';
import { makeLeague, ROLE_AGENTS } from './clubs.js';
import { membersOf, divisionSchedule, promoteRelegate, type DivMove } from './divisions.js';
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
 *  `owner` is the human overlay (null = AI) — unused headless, the server sets it. */
export interface WorldClub {
  id: string; name: string; tag: string;
  tier: number; group: number;
  roster: Player[]; tactics: Tactics; comp: Comp;
  strength: number; balance: number; titles: number;
  owner: string | null;
}

export interface WorldState {
  seed: number; region: string;
  tiers: number; size: number; promo: number;
  season: number; day: number;
  patch: PatchState;
  clubs: WorldClub[];
  results: MatchResult[];   // the current season's fixtures
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
export const clubTeam = (c: WorldClub): Team => ({ id: c.id, tag: c.tag, name: c.name, players: startingFive(c.roster) });

/** Generate a fresh world from a seed: a strength-descending field split into
 *  `tiers` tiers of `size` (Premier at the top, the rank ladder below). */
export function createWorld(seed: number, opts: { tiers?: number; size?: number; promo?: number; region?: string } = {}): WorldState {
  const tiers = opts.tiers ?? 11, size = opts.size ?? 10, promo = opts.promo ?? 2;
  const clubs = makeLeague(seed, tiers * size).map((c, i): WorldClub => ({
    id: c.team.id, name: c.team.name, tag: c.team.tag,
    tier: Math.min(tiers - 1, Math.floor(i / size)), group: 0,
    roster: c.team.players, tactics: c.tactics, comp: {},
    strength: c.strength, balance: startingBalance(c.strength), titles: 0, owner: null,
  }));
  return { seed, region: opts.region ?? 'AMER', tiers, size, promo, season: 1, day: 0, patch: fullPatch(PATCH, ALL_AGENTS), clubs, results: [] };
}

const divisionOf = (w: WorldState) => w.clubs.map(c => c.tier);
const tablesOf = (w: WorldState) => {
  const div = divisionOf(w);
  return Array.from({ length: w.tiers }, (_, t) => standings(w.clubs.length, w.results.filter(r => div[r.home] === t)).filter(s => div[s.club] === t));
};

/** Resolve the whole season headless: every division quick-resolved by strength
 *  (the server full-sims watched tiers instead; the math is the same). */
export function simulateSeason(w: WorldState): WorldState {
  const div = divisionOf(w);
  const schedules = Array.from({ length: w.tiers }, (_, t) => divisionSchedule(membersOf(div, t)));
  const seasonSeed = (w.seed ^ (w.season * 0x85ebca6b)) >>> 0;
  const devRng = new Rng((w.seed ^ (w.season * 0x2545f491)) >>> 0);
  const results: MatchResult[] = [];
  const total = schedules[0].length;
  let clubs = w.clubs;
  for (let day = 0; day < total; day++) {
    schedules.forEach((sched, t) => sched[day].forEach((fx, slot) =>
      results.push(quickResult(fx.home, fx.away, clubs[fx.home].strength, clubs[fx.away].strength, fixtureSeed(seasonSeed, day, slot + t * 1000)))));
    // in-season development: the five who played grow (reps), reserves rust
    clubs = clubs.map(c => {
      const five = new Set(startingFive(c.roster).map(p => p.id));
      const roster = c.roster.map(p => developInSeason(p, five.has(p.id), total, devRng));
      return { ...c, roster, strength: clampStr(squadRating(clubTeam({ ...c, roster })) / 100) };
    });
  }
  return { ...w, clubs, results, day: total };
}

export interface Rollover { world: WorldState; champion: number; moves: DivMove[]; notes: MetaChange[] }

/** Roll the off-season: top-tier playoffs (a champion + a title), settle every
 *  club's books by division rank, develop every squad, shift the meta, then
 *  promote/relegate across all boundaries. Returns the new world + the events. */
export function advanceWorld(w: WorldState): Rollover {
  const tables = tablesOf(w);
  const div = divisionOf(w);
  const rankIn = (i: number) => tables[div[i]].findIndex(s => s.club === i) + 1;
  // the Premier crowns a champion via a best-of-three bracket (quick-resolved)
  const bracket = runPlayoffs(tables[0], w.seed, w.season, (h, a, seed) => quickResult(h, a, w.clubs[h].strength, w.clubs[a].strength, seed));
  const champion = bracket.champion ?? tables[0][0].club;
  const poPrize = (i: number) => div[i] === 0 ? playoffPrize(finishOf(bracket, i)) : 0;
  const devRng = new Rng((w.seed ^ (w.season * 0x9e3779b9)) >>> 0);
  let clubs = w.clubs.map((c, i): WorldClub => {
    const led = settleClub({ rank: rankIn(i), divSize: w.size, tier: c.tier, wages: squadWageBill(c.roster), playoff: poPrize(i) });
    const roster = c.roster.map(p => developPlayer(p, devRng, 1 - SEASON_SHARE));  // bootcamp share — the rest grew in-season
    return { ...c, roster, strength: clampStr(squadRating(clubTeam({ ...c, roster })) / 100), balance: c.balance + led.net, titles: c.titles + (i === champion ? 1 : 0) };
  });
  const meta = patchMeta(w.patch, new Rng((w.seed ^ (w.season * 0x27d4eb2f)) >>> 0));
  const pr = promoteRelegate(div, tables, w.promo);
  clubs = clubs.map((c, i) => ({ ...c, tier: pr.division[i] }));
  return { world: { ...w, clubs, patch: meta.patch, season: w.season + 1, day: 0, results: [] }, champion, moves: pr.moves, notes: meta.changes };
}
