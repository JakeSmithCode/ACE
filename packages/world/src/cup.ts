// The domestic knockout cup — the league's great equalizer. EVERY club in the world is
// entered and the draw is OPEN each round, so a lower-division minnow that survives can be
// drawn against a Premier giant and knock it out (the FA-Cup magic). Pure + deterministic:
// the draw is a seeded shuffle on its OWN stream (it never perturbs the league/world rng),
// and match resolution is INJECTED — the store full-sims your tie (watchable, your tactics
// drive it) and quick-resolves the rest. Giant-killing emerges from the engine, not a script.
import { Rng } from '@ace/engine';
import type { MatchResult } from './season.js';

export const CUP_NAME = 'ACE Cup';
/** Match-days a cup round falls on (8 rounds spread across a 30-match-day season; the final
 *  near the run-in). A round resolves when the just-played league match-day hits its day. */
export const CUP_DAYS = [2, 5, 8, 12, 16, 20, 24, 28];
/** Prize banked for WINNING a round (advancing from it) — small early, a real cheque late;
 *  the last entry is the champion's purse. Indexed by round number. */
export const CUP_PRIZE = [600, 1000, 1800, 3000, 5500, 9000, 15000, 28000];

export interface CupTie { round: number; slot: number; home: number; away: number; seed: number; result: MatchResult | null; }
export interface CupRound { round: number; matchday: number; entering: number; ties: CupTie[]; byes: number[]; }
export interface CupState {
  season: number;
  rounds: CupRound[];        // rounds played so far
  alive: number[];           // clubs through to the NEXT round
  nextRound: number;         // 0..CUP_DAYS.length
  champion: number | null;
}

/** First-round byes: the strongest clubs sit out so the field reduces to a power of two
 *  after round one (and giants enter later, the round that lets minnows survive to meet
 *  them). `0` when the field is already a power of two. */
export function cupByes(n: number): number {
  let p = 1; while (p * 2 <= n) p *= 2;        // largest power of two ≤ n
  return p === n ? 0 : 2 * p - n;
}

/** Self-describing round name from the number of clubs contesting it. */
export function cupRoundName(entering: number): string {
  if (entering <= 2) return 'Final';
  if (entering <= 4) return 'Semi-finals';
  if (entering <= 8) return 'Quarter-finals';
  return `Round of ${entering}`;
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Draw a cup round. With `byeCount > 0` (round one) the strongest `byeCount` clubs sit out
 *  and the rest are paired by an OPEN shuffle; otherwise it's an open draw of all survivors
 *  (an odd field — never past round one — gives the strongest a safety bye). */
export function drawCup(alive: number[], byeCount: number, strengthOf: (c: number) => number, drawSeed: number): { pairs: [number, number][]; byes: number[] } {
  const rng = new Rng(drawSeed >>> 0);
  let byes: number[] = [], players = alive;
  if (byeCount > 0) {
    const ranked = [...alive].sort((a, b) => strengthOf(b) - strengthOf(a) || a - b);
    byes = ranked.slice(0, byeCount); players = ranked.slice(byeCount);
  } else if (alive.length % 2 === 1) {
    const ranked = [...alive].sort((a, b) => strengthOf(b) - strengthOf(a) || a - b);
    byes = [ranked[0]]; players = ranked.slice(1);
  }
  const shuffled = shuffle(players, rng);
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) pairs.push([shuffled[i], shuffled[i + 1]]);
  return { pairs, byes };
}

/** Open a fresh cup for a season — every club in `field` entered, none yet eliminated. */
export function createCup(field: number[], season: number): CupState {
  return { season, rounds: [], alive: [...field], nextRound: 0, champion: null };
}
