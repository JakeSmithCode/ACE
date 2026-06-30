// Playoffs — the season climax. The round-robin seeds a top-4 single-elimination
// bracket (1v4, 2v3 semifinals → Bo3, final → Bo5), with a real **map veto**
// before each series (ban/pick from the pool, driven by club map-affinity). Pure
// and deterministic: the match resolution is *injected* (the store overlays your
// comp + tactics) and every game's seed is a stable hash, so a bracket is
// reproducible and each game can be re-simmed to watch.
import type { MapId } from '@ace/shared';
import type { Standing, MatchResult } from './season.js';

const SEMI_NEED = 2;   // semifinals: best-of-three (first to 2)
const FINAL_NEED = 3;  // final: best-of-five (first to 3)

/** One ban/pick in a series' map veto (for the UI to replay the negotiation). */
export interface VetoStep { team: 'hi' | 'lo'; action: 'ban' | 'pick' | 'decider'; map: MapId }

/** A best-of-N tie between two seeds. `hi` is the higher seed (vetoes/lists home). */
export interface Series {
  round: number; slot: number; label: string; need: number;
  hi: number; lo: number;                 // higher-seed club, lower-seed club
  home: number; away: number;             // = hi, lo
  maps: MapId[];                          // the veto-decided map order (one per potential game)
  veto: VetoStep[];                       // the ban/pick sequence
  games: MatchResult[];                   // each is re-simmable from its seed (on maps[i])
  wins: [number, number];                 // [hi games won, lo games won]
  winner: number | null;
}

export interface Bracket {
  qualified: number[];                    // top-4 club indices, seeded 1..4
  rounds: Series[][];                     // [[SF1, SF2], [Final]]
  champion: number | null;
}

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

/** The map veto for a series: each side bans its worst remaining map, then they
 *  alternate picking their best remaining, the last one the decider — so a Bo3
 *  on a 5-map pool is ban·ban·pick·pick·decider, a Bo5 is pick·pick·pick·pick·decider.
 *  `affinityOf(club, map)` makes it strategic (you steer toward your comfort maps). */
export function vetoMaps(hi: number, lo: number, pool: MapId[], need: number, affinityOf: (club: number, m: MapId) => number): { maps: MapId[]; veto: VetoStep[] } {
  const games = need * 2 - 1;                                  // Bo3 → 3, Bo5 → 5
  const bans = Math.max(0, pool.length - games);
  let rem = [...pool];
  const veto: VetoStep[] = [], maps: MapId[] = [];
  let turn: 'hi' | 'lo' = 'hi';                                // higher seed acts first
  const club = () => (turn === 'hi' ? hi : lo);
  const flip = () => { turn = turn === 'hi' ? 'lo' : 'hi'; };
  for (let i = 0; i < bans; i++) {
    const m = [...rem].sort((a, b) => affinityOf(club(), a) - affinityOf(club(), b))[0];   // ban your worst
    rem = rem.filter(x => x !== m); veto.push({ team: turn, action: 'ban', map: m }); flip();
  }
  while (rem.length > 1) {
    const m = [...rem].sort((a, b) => affinityOf(club(), b) - affinityOf(club(), a))[0];   // pick your best
    rem = rem.filter(x => x !== m); maps.push(m); veto.push({ team: turn, action: 'pick', map: m }); flip();
  }
  maps.push(rem[0]); veto.push({ team: 'hi', action: 'decider', map: rem[0] });
  return { maps, veto };
}

/** Resolve a fixture on a given map — injected so the caller controls how a match
 *  is simulated (the store overlays your comp/tactics + map affinity). */
type GameResolver = (home: number, away: number, seed: number, map: MapId) => MatchResult;

function resolveSeries(
  hi: number, lo: number, round: number, slot: number, label: string, need: number,
  seasonSeed: number, season: number, pool: MapId[], affinityOf: (c: number, m: MapId) => number, resolve: GameResolver,
): Series {
  const { maps, veto } = vetoMaps(hi, lo, pool, need, affinityOf);
  const games: MatchResult[] = [];
  let hw = 0, lw = 0, g = 0;
  while (hw < need && lw < need) {
    const res = resolve(hi, lo, playoffGameSeed(seasonSeed, season, round, slot, g), maps[g] ?? maps[maps.length - 1]);
    games.push(res);
    if (res.winner === hi) hw++; else lw++;
    g++;
  }
  return { round, slot, label, need, hi, lo, home: hi, away: lo, maps, veto, games, wins: [hw, lw], winner: hw > lw ? hi : lo };
}

/** Build and resolve the whole bracket: Bo3 semis (1v4, 2v3) → Bo5 final, each
 *  with a map veto over `pool`. */
export function runPlayoffs(standings: Standing[], seasonSeed: number, season: number, pool: MapId[], affinityOf: (c: number, m: MapId) => number, resolve: GameResolver): Bracket {
  const q = standings.slice(0, 4).map(s => s.club);
  const sf1 = resolveSeries(q[0], q[3], 0, 0, 'Semifinal', SEMI_NEED, seasonSeed, season, pool, affinityOf, resolve);
  const sf2 = resolveSeries(q[1], q[2], 0, 1, 'Semifinal', SEMI_NEED, seasonSeed, season, pool, affinityOf, resolve);
  const seedOf = (c: number) => q.indexOf(c);
  const [fhi, flo] = seedOf(sf1.winner!) < seedOf(sf2.winner!) ? [sf1.winner!, sf2.winner!] : [sf2.winner!, sf1.winner!];
  const final = resolveSeries(fhi, flo, 1, 0, 'Final', FINAL_NEED, seasonSeed, season, pool, affinityOf, resolve);
  return { qualified: q, rounds: [[sf1, sf2], [final]], champion: final.winner };
}

// ── Promotion / relegation playoff ──────────────────────────────────────────
export const PLAYOFF_SLOTS = 2;   // contested promotion-playoff spots per tier boundary

/** A promotion/relegation playoff at a tier boundary. The `slots` clubs just below the
 *  auto-promotion line in the LOWER tier challenge the `slots` clubs just above the
 *  auto-relegation line in the UPPER tier, for `slots` spots up top. Defenders (upper)
 *  are seeded above challengers (lower); the semis cross-seed best-vs-worst (the best
 *  defender draws the worst challenger). Each tie is a Bo3 with veto — the winner takes
 *  the upper-tier spot, the loser the lower. A showcase Bo5 final crowns the playoff
 *  (cosmetic: promotion is decided by the semis, not the final). */
export interface PromoPlayoff {
  boundary: number;              // upper tier index (the contest is boundary ↔ boundary+1)
  ties: Series[];                // the semifinal ties — one decides each contested spot
  final: Series | null;          // showcase final between the two winners (cosmetic)
  champion: number | null;       // playoff winner (the final's winner)
  up: number[];                  // clubs that END in the UPPER tier (the tie winners)
  down: number[];                // clubs that END in the LOWER tier (the tie losers)
}

/** Stable per-boundary seed for a promotion playoff — distinct from the main bracket's
 *  `playoffGameSeed` stream so the two never collide. */
export function promoPlayoffSeed(seasonSeed: number, season: number, boundary: number): number {
  let h = (seasonSeed ^ (season * 0x9e3779b1) ^ ((boundary + 1) * 0x2545f491)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/** Build + resolve the promotion playoff for one tier boundary (upper tier `boundary`,
 *  lower tier `boundary+1`). `k` is the auto promote/relegate count (the playoff contests
 *  the next `slots` on each side). Returns null when a division is too small to field it. */
export function runPromotionPlayoff(
  upper: Standing[], lower: Standing[], k: number, slots: number, boundary: number,
  seasonSeed: number, season: number, pool: MapId[], affinityOf: (c: number, m: MapId) => number, resolve: GameResolver,
): PromoPlayoff | null {
  if (upper.length < k + slots || lower.length < k + slots) return null;
  const defenders = upper.slice(upper.length - k - slots, upper.length - k).map(s => s.club);   // just above the drop zone, best-first
  const challengers = lower.slice(k, k + slots).map(s => s.club);                                // just below auto-promotion, best-first
  const pseed = promoPlayoffSeed(seasonSeed, season, boundary);
  const ties: Series[] = [], up: number[] = [], down: number[] = [];
  for (let i = 0; i < slots; i++) {
    const hi = defenders[i], lo = challengers[slots - 1 - i];     // cross-seed: best defender vs worst challenger
    const tie = resolveSeries(hi, lo, 0, i, 'Promotion Playoff', SEMI_NEED, pseed, season, pool, affinityOf, resolve);
    ties.push(tie);
    up.push(tie.winner!); down.push(tie.winner === hi ? lo : hi);
  }
  // showcase final between the two winners (the default slots=2 case) — promotion is
  // already settled, so this is for the playoff trophy + a watchable marquee game
  let final: Series | null = null, champion: number | null = null;
  if (up.length === 2) {
    const merit = [...defenders, ...challengers];
    const [fhi, flo] = [...up].sort((a, b) => merit.indexOf(a) - merit.indexOf(b));
    final = resolveSeries(fhi, flo, 1, 0, 'Promotion Final', FINAL_NEED, pseed, season, pool, affinityOf, resolve);
    champion = final.winner;
  }
  return { boundary, ties, final, champion, up, down };
}

/** Where a club finished in the bracket. */
export function finishOf(b: Bracket, club: number): PlayoffFinish {
  if (b.champion === club) return 'champion';
  const final = b.rounds[1]?.[0];
  if (final && (final.hi === club || final.lo === club)) return 'runner-up';
  if (b.qualified.includes(club)) return 'semifinal';
  return 'none';
}
