// Season resolution & standings — pure over (clubs, schedule, patch, nav, seed).
// The same `simulateMatch` the viewer uses resolves every fixture; a fixture's
// seed is a stable hash of (season, match-day, slot), so a result is reproducible
// and the web app can re-sim it to *watch* without storing a timeline.
import type { MatchInput, PatchState, MapId } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import type { Navmesh } from '@ace/maps';
import type { Club } from './clubs.js';
import type { Fixture, Matchday } from './schedule.js';

/** Stable 32-bit fixture seed — mixes the season seed with the match-day and
 *  slot so every fixture in a season is independently reproducible. */
export function fixtureSeed(seasonSeed: number, day: number, slot: number): number {
  let h = (seasonSeed ^ 0x9e3779b9) >>> 0;
  for (const v of [day + 1, slot + 1]) {
    h = Math.imul(h ^ v, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

export interface MatchResult {
  home: number; away: number;          // club indices
  score: [number, number];             // [home rounds, away rounds]
  winner: number;                      // club index that won
  seed: number;                        // the fixture seed (re-sim to watch)
}

/** Resolve one fixture between two clubs into a result. */
export function resolveFixture(
  clubs: Club[], fx: Fixture, patch: PatchState, nav: Navmesh, map: MapId, seed: number,
): MatchResult {
  const home = clubs[fx.home], away = clubs[fx.away];
  const input: MatchInput = {
    seed, map, patch,
    teams: [home.team, away.team],
    tactics: [home.tactics, away.tactics],
  };
  const [h, a] = simulateMatch(input, nav).finalScore;
  return { home: fx.home, away: fx.away, score: [h, a], winner: h > a ? fx.home : fx.away, seed };
}

/** Resolve a whole match-day. */
export function resolveMatchday(
  clubs: Club[], day: Matchday, dayIdx: number, patch: PatchState, nav: Navmesh, map: MapId, seasonSeed: number,
): MatchResult[] {
  return day.map((fx, slot) => resolveFixture(clubs, fx, patch, nav, map, fixtureSeed(seasonSeed, dayIdx, slot)));
}

export interface Standing {
  club: number; played: number; won: number; lost: number;
  rf: number; ra: number;                // rounds for / against
  diff: number; points: number;          // diff = rf-ra; points = 3·won (league points)
}

/** Build the table from a flat list of results, sorted the football way:
 *  points, then round difference, then rounds won. */
export function standings(clubCount: number, results: MatchResult[]): Standing[] {
  const t: Standing[] = Array.from({ length: clubCount }, (_, club) => ({
    club, played: 0, won: 0, lost: 0, rf: 0, ra: 0, diff: 0, points: 0,
  }));
  for (const r of results) {
    const H = t[r.home], A = t[r.away];
    H.played++; A.played++;
    H.rf += r.score[0]; H.ra += r.score[1];
    A.rf += r.score[1]; A.ra += r.score[0];
    if (r.winner === r.home) { H.won++; A.lost++; } else { A.won++; H.lost++; }
  }
  for (const s of t) { s.diff = s.rf - s.ra; s.points = s.won * 3; }
  return t.sort((x, y) => y.points - x.points || y.diff - x.diff || y.rf - x.rf || x.club - y.club);
}
