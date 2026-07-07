// The domestic cup, server-side — now a VIEW over the durable `WorldState.cup` (the tick
// resolves it day-by-day, full-simming the watchable ties and storing their input snapshots
// in the cup state itself, so it survives restarts via the Pg jsonb world). This shapes that
// persisted state into the client's CupView + the watchable ties' snapshots (by tie id), so
// `GET /cup` is a cheap read and `/cup/replay/:id` serves the stored snapshot. No engine here.
import { CUP_DAYS, cupRoundName, fixtureMap, type WorldState } from '@ace/world';
import type { MatchInput, MapId } from '@ace/shared';

interface ClubRef { idx: number; tag: string; name: string; tier: number }
interface CupTieView { id: string; home: ClubRef; away: ClubRef; score: [number, number]; map: MapId; winner: number; watchable: boolean }
export interface CupView {
  season: number;
  rounds: { round: number; name: string; ties: CupTieView[]; byes: ClubRef[] }[];
  champion: ClubRef | null;
  upsets: { w: ClubRef; l: ClubRef }[];   // the cup's biggest giant-killings (by division gap)
  /** THE DRAW: the next round, pre-drawn + public (pairings and maps) before it's played. */
  next?: { round: number; name: string; matchday: number; ties: { home: ClubRef; away: ClubRef; map: MapId }[] } | null;
}

/** Shape the persisted `WorldState.cup` into the client view + the watchable ties' snapshots. */
export function cupViewFromState(w: WorldState): { view: CupView; games: Map<string, MatchInput> } {
  const games = new Map<string, MatchInput>();
  const ref = (i: number): ClubRef => ({ idx: i, tag: w.clubs[i].tag, name: w.clubs[i].name, tier: w.clubs[i].tier });
  const c = w.cup;
  if (!c) return { view: { season: w.season, rounds: [], champion: null, upsets: [] }, games };

  const upsets: CupView['upsets'] = [];
  const rounds = c.rounds.map(rd => ({
    round: rd.round, name: cupRoundName(rd.entering),
    byes: rd.byes.map(ref),
    ties: rd.ties.map(t => {
      const id = `c:${t.round}:${t.slot}`;
      if (t.input) games.set(id, t.input);
      const winner = t.result!.winner, loser = winner === t.home ? t.away : t.home;
      if (w.clubs[winner].tier > w.clubs[loser].tier) upsets.push({ w: ref(winner), l: ref(loser) });   // lower division beat a higher one
      return { id, home: ref(t.home), away: ref(t.away), score: t.result!.score, map: fixtureMap(t.seed), winner, watchable: !!t.input };
    }),
  }));
  upsets.sort((a, b) => (b.w.tier - b.l.tier) - (a.w.tier - a.l.tier) || a.w.idx - b.w.idx);
  // THE DRAW: the pre-drawn next round — pairings AND maps are public before the
  // ties are played (both are pure functions of the stable per-round seed)
  const next = c.pending && c.champion == null ? {
    round: c.pending.round,
    name: cupRoundName(c.pending.pairs.length * 2 + c.pending.byes.length),
    matchday: CUP_DAYS[c.pending.round],
    ties: c.pending.pairs.map(([h, a], slot) => {
      const drawSeed = (w.seed ^ (w.season * 0x9e3779b1) ^ ((c.pending!.round + 1) * 0x2545f491)) >>> 0;
      return { home: ref(h), away: ref(a), map: fixtureMap((drawSeed ^ ((slot + 1) * 0x27d4eb2f)) >>> 0) };
    }),
  } : null;
  return { view: { season: w.season, rounds, champion: c.champion != null ? ref(c.champion) : null, upsets: upsets.slice(0, 10), next }, games };
}
