// Playoffs — the season climax. The round-robin seeds a top-4 single-elimination
// bracket (1v4, 2v3 semifinals → final), each tie a best-of-three series, and the
// winner is crowned champion. Pure and deterministic like the rest of @ace/world:
// the actual match resolution is *injected* (the web store passes a resolver that
// overlays your comp + tactics), and every game's seed is a stable hash, so a
// bracket is reproducible and each game can be re-simmed to watch.
import type { Standing, MatchResult } from './season.js';

const NEED = 2;   // best-of-three: first to two games

/** A best-of-three tie between two seeds. `hi` is the higher seed (listed home). */
export interface Series {
  round: number; slot: number; label: string;
  hi: number; lo: number;                 // higher-seed club, lower-seed club
  home: number; away: number;             // = hi, lo (so the viewer/watch reads them)
  games: MatchResult[];                   // each is re-simmable from its seed
  wins: [number, number];                 // [hi games won, lo games won]
  winner: number | null;
}

export interface Bracket {
  qualified: number[];                    // top-4 club indices, seeded 1..4
  rounds: Series[][];                     // [[SF1, SF2], [Final]]
  champion: number | null;
}

/** A club's finish in the bracket (drives the playoff prize + a title). */
export type PlayoffFinish = 'champion' | 'runner-up' | 'semifinal' | 'none';

/** Stable per-game seed — mixes season seed, season, round, slot, and game index
 *  so every playoff game is independently reproducible (re-sim to watch). */
export function playoffGameSeed(seasonSeed: number, season: number, round: number, slot: number, game: number): number {
  let h = (seasonSeed ^ (season * 0x6d2b79f5) ^ 0x5f356495) >>> 0;
  for (const v of [round + 1, slot + 1, game + 1]) {
    h = Math.imul(h ^ v, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

/** Resolve a fixture into a result — injected so the caller controls how a match
 *  is simulated (the store overlays your comp/tactics for your own ties). */
type GameResolver = (home: number, away: number, seed: number) => MatchResult;

function resolveSeries(
  hi: number, lo: number, round: number, slot: number, label: string,
  seasonSeed: number, season: number, resolve: GameResolver,
): Series {
  const games: MatchResult[] = [];
  let hw = 0, lw = 0, g = 0;
  while (hw < NEED && lw < NEED) {
    const res = resolve(hi, lo, playoffGameSeed(seasonSeed, season, round, slot, g));
    games.push(res);
    if (res.winner === hi) hw++; else lw++;
    g++;
  }
  return { round, slot, label, hi, lo, home: hi, away: lo, games, wins: [hw, lw], winner: hw > lw ? hi : lo };
}

/** Build and resolve the whole bracket from the final standings. */
export function runPlayoffs(standings: Standing[], seasonSeed: number, season: number, resolve: GameResolver): Bracket {
  const q = standings.slice(0, 4).map(s => s.club);                 // seeds 1..4 by table
  const sf1 = resolveSeries(q[0], q[3], 0, 0, 'Semifinal', seasonSeed, season, resolve);
  const sf2 = resolveSeries(q[1], q[2], 0, 1, 'Semifinal', seasonSeed, season, resolve);
  // the higher original seed of the two finalists is listed home in the final
  const seedOf = (c: number) => q.indexOf(c);
  const [fhi, flo] = seedOf(sf1.winner!) < seedOf(sf2.winner!) ? [sf1.winner!, sf2.winner!] : [sf2.winner!, sf1.winner!];
  const final = resolveSeries(fhi, flo, 1, 0, 'Final', seasonSeed, season, resolve);
  return { qualified: q, rounds: [[sf1, sf2], [final]], champion: final.winner };
}

/** Where a club finished in the bracket. */
export function finishOf(b: Bracket, club: number): PlayoffFinish {
  if (b.champion === club) return 'champion';
  const final = b.rounds[1]?.[0];
  if (final && (final.hi === club || final.lo === club)) return 'runner-up';
  if (b.qualified.includes(club)) return 'semifinal';
  return 'none';
}
