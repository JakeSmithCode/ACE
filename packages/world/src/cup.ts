// The domestic knockout cup — the league's great equalizer. EVERY club in the world is
// entered and the draw is OPEN each round, so a lower-division minnow that survives can be
// drawn against a Premier giant and knock it out (the FA-Cup magic). Pure + deterministic:
// the draw is a seeded shuffle on its OWN stream (it never perturbs the league/world rng),
// and match resolution is INJECTED — the store full-sims your tie (watchable, your tactics
// drive it) and quick-resolves the rest. Giant-killing emerges from the engine, not a script.
import { Rng } from '@ace/engine';
import type { MatchInput } from '@ace/shared';
import type { MatchResult } from './season.js';

export const CUP_NAME = 'ACE Cup';
/** Match-days a cup round falls on (8 rounds spread across a 30-match-day season; the final
 *  near the run-in). A round resolves when the just-played league match-day hits its day. */
export const CUP_DAYS = [2, 5, 8, 12, 16, 20, 24, 28];
/** Prize banked for WINNING a round (advancing from it) — small early, a real cheque late;
 *  the last entry is the champion's purse. Indexed by round number. */
export const CUP_PRIZE = [600, 1000, 1800, 3000, 5500, 9000, 15000, 28000];

export interface CupTie {
  round: number; slot: number; home: number; away: number; seed: number; result: MatchResult | null;
  input?: MatchInput;   // the engine input snapshot, captured for WATCHABLE ties so the client re-sims to watch
}
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

/** Resolve one tie → its result, plus the engine input snapshot for WATCHABLE ties (so the
 *  client can re-sim it byte-for-byte). Injected, so the engine stays out of `@ace/world`. */
export type CupResolver = (home: number, away: number, seed: number) => { result: MatchResult; input?: MatchInput };

/** Is the cup's next round scheduled for this match-day? (used to tick it with the league) */
export function cupRoundDue(c: CupState | undefined, day: number): boolean {
  return !!c && c.champion == null && c.nextRound < CUP_DAYS.length && day === CUP_DAYS[c.nextRound];
}

/** Draw + resolve the cup's next round, returning the advanced state. The draw is the same
 *  seeded open draw the view builder uses, so a tick-resolved cup and an on-demand one agree;
 *  the per-round/per-tie seeds are stable functions of (worldSeed, season, round, slot). */
export function resolveCupRound(c: CupState, strengthOf: (i: number) => number, worldSeed: number, season: number, resolve: CupResolver): CupState {
  const round = c.nextRound, entering = c.alive.length;
  const byeCount = round === 0 ? cupByes(entering) : 0;
  const drawSeed = (worldSeed ^ (season * 0x9e3779b1) ^ ((round + 1) * 0x2545f491)) >>> 0;
  const { pairs, byes } = drawCup(c.alive, byeCount, strengthOf, drawSeed);
  const ties: CupTie[] = pairs.map(([home, away], slot) => {
    const seed = (drawSeed ^ ((slot + 1) * 0x27d4eb2f)) >>> 0;
    const { result, input } = resolve(home, away, seed);
    return { round, slot, home, away, seed, result, input };
  });
  const alive = [...byes, ...ties.map(t => t.result!.winner)];
  const champion = alive.length === 1 ? alive[0] : null;
  return { ...c, rounds: [...c.rounds, { round, matchday: CUP_DAYS[round], entering, ties, byes }], alive, nextRound: round + 1, champion };
}
