// Live broadcast windows + result embargo (the "games at 8pm, no spoilers until
// it's over" rule). The engine resolves a match instantly, so the result EXISTS
// the moment the tick runs — but it must not be *revealed* until the live
// broadcast has actually played out. Each fixture carries a `kickoffAt` and a
// FIXED `broadcastSecs`; the result (and the input_snapshot) stay sealed until
// `revealAt`. During the window the server streams the match gated to the live
// position (everyone synced), so nobody — not even a client holding nothing —
// can see ahead. This file is the pure gate; the WS gateway/HTTP wrap it.
import type { MatchTimeline } from '@ace/shared';
import type { FixtureRow } from './store.js';

/** Default live-broadcast length. FIXED on purpose: a stomp and a thriller take
 *  the same slot, so the duration leaks nothing about the result. (~40 min, a
 *  real match slot; tune per cadence.) */
export const DEFAULT_BROADCAST_SECS = 2400;

export type FixtureStatus = 'scheduled' | 'live' | 'resolved';

export const kickoffOf = (r: FixtureRow): number => r.kickoffAt ?? 0;
export const broadcastOf = (r: FixtureRow): number => r.broadcastSecs ?? DEFAULT_BROADCAST_SECS;
export const revealAt = (r: FixtureRow): number => kickoffOf(r) + broadcastOf(r);

/** Where a fixture is at wall-clock `now`: not started, live (playing out), or
 *  resolved (broadcast finished → result public). */
export function fixtureStatus(r: FixtureRow, now: number): FixtureStatus {
  if (now < kickoffOf(r)) return 'scheduled';
  if (now < revealAt(r)) return 'live';
  return 'resolved';
}

/** Live progress 0..1 across the broadcast window (0 at kickoff, 1 at reveal). */
export function liveFrac(r: FixtureRow, now: number): number {
  return Math.max(0, Math.min(1, (now - kickoffOf(r)) / broadcastOf(r)));
}

/** Spoiler-safe gate of a (re-simmed) timeline to the live position: the running
 *  score from COMPLETED rounds only, and the round currently playing. The final
 *  score appears only once the broadcast has fully played out (`frac >= 1`) — so
 *  the live feed can never reveal the winner early. This is what the match-center
 *  streams. */
export interface LiveMatchState {
  round: number; roundT: number;        // the round currently on screen + its progress
  scoreA: number; scoreB: number;       // running score (decided rounds only)
  revealed: boolean;
  finalScore?: [number, number];        // present only when revealed
}
export function liveMatchState(tl: MatchTimeline, frac: number): LiveMatchState {
  const R = tl.rounds.length;
  const revealed = frac >= 1;
  const pos = Math.max(0, Math.min(1, frac)) * R;
  const round = Math.min(R - 1, Math.floor(pos));
  let a = 0, b = 0;
  for (let i = 0; i < round; i++) (tl.rounds[i].winner === 0 ? a++ : b++);
  return { round, roundT: revealed ? 1 : pos - round, scoreA: a, scoreB: b, revealed, finalScore: revealed ? tl.finalScore : undefined };
}

/** The public API view of a fixture at `now` — spoiler-safe by construction.
 *  Before reveal it carries NO score and NO snapshot (so a client can't re-sim
 *  ahead) — only the live position. After reveal, the final score + snapshot are
 *  public (the cheap client-side replay path). */
export interface FixtureView {
  worldId: string; season: number; day: number; slot: number;
  status: FixtureStatus; kickoffAt: number; revealAt: number; frac: number;
  score?: [number, number];                                   // resolved only
  snapshot?: FixtureRow['inputSnapshot'];                     // resolved only — release gated to reveal
}
export function publicView(r: FixtureRow, now: number): FixtureView {
  const status = fixtureStatus(r, now);
  const resolved = status === 'resolved';
  return {
    worldId: r.worldId, season: r.season, day: r.day, slot: r.slot,
    status, kickoffAt: kickoffOf(r), revealAt: revealAt(r), frac: liveFrac(r, now),
    score: resolved ? [r.homeScore, r.awayScore] : undefined,
    snapshot: resolved ? r.inputSnapshot : undefined,
  };
}
