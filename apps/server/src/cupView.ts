// The domestic cup, server-side (the PvP world's great equalizer). Resolves the WHOLE
// ACE Cup from the current world — an open draw each round, every club entered — with the
// real engine on the WATCHABLE ties (a Premier or human-owned club's game; its snapshot is
// cached by id so the client re-sims to watch) and the cheap `quickResult` on the rest. So
// a Gold-tier minnow knocking a Premier giant out of the cup is the engine's verdict, and
// any tie a spectator cares about is watchable. Mirrors `worldCupView.ts`; cached per season.
import { createCup, drawCup, cupByes, cupRoundName, CUP_DAYS, quickResult, fixtureMap, type WorldState } from '@ace/world';
import type { MatchInput, MapId } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { fullSimResolver } from './sim.js';

interface ClubRef { idx: number; tag: string; name: string; tier: number }
interface CupTieView { id: string; home: ClubRef; away: ClubRef; score: [number, number]; map: MapId; winner: number; watchable: boolean }
export interface CupView {
  season: number;
  rounds: { round: number; name: string; ties: CupTieView[]; byes: ClubRef[] }[];
  champion: ClubRef | null;
  upsets: { w: ClubRef; l: ClubRef }[];   // the cup's biggest giant-killings (by division gap)
}

/** Resolve the season's cup and return the view + the watchable ties' snapshots (by id). */
export function buildCupView(w: WorldState, navOf: (m: MapId) => Navmesh, opts: { full: (division: number) => boolean }): { view: CupView; games: Map<string, MatchInput> } {
  const sim = fullSimResolver(w, navOf, 0);              // full-sim resolver (captures input snapshots by seed)
  const games = new Map<string, MatchInput>();
  const ref = (i: number): ClubRef => ({ idx: i, tag: w.clubs[i].tag, name: w.clubs[i].name, tier: w.clubs[i].tier });
  const watchable = (h: number, a: number) => opts.full(w.clubs[h].tier) || opts.full(w.clubs[a].tier) || !!w.clubs[h].owner || !!w.clubs[a].owner;

  let c = createCup(w.clubs.map((_, i) => i), w.season);
  const rounds: CupView['rounds'] = [];
  const upsets: CupView['upsets'] = [];
  while (c.champion == null && c.nextRound < CUP_DAYS.length) {
    const round = c.nextRound, entering = c.alive.length;
    const byeCount = round === 0 ? cupByes(entering) : 0;
    const drawSeed = (w.seed ^ (w.season * 0x9e3779b1) ^ ((round + 1) * 0x2545f491)) >>> 0;
    const { pairs, byes } = drawCup(c.alive, byeCount, i => w.clubs[i].strength, drawSeed);
    const ties: CupTieView[] = pairs.map(([home, away], slot) => {
      const seed = (drawSeed ^ ((slot + 1) * 0x27d4eb2f)) >>> 0;
      const id = `c:${round}:${slot}`;
      const watch = watchable(home, away);
      const result = watch ? sim.resolve({ home, away }, seed, 0)
                           : quickResult(home, away, w.clubs[home].strength, w.clubs[away].strength, seed);
      if (watch) { const snap = sim.snapshots.get(seed); if (snap) games.set(id, snap); }
      const loser = result.winner === home ? away : home;
      if (w.clubs[result.winner].tier > w.clubs[loser].tier) upsets.push({ w: ref(result.winner), l: ref(loser) });   // lower division beat a higher one
      return { id, home: ref(home), away: ref(away), score: result.score, map: fixtureMap(seed), winner: result.winner, watchable: watch };
    });
    const alive = [...byes, ...ties.map(t => t.winner)];
    rounds.push({ round, name: cupRoundName(entering), ties, byes: byes.map(ref) });
    c = { ...c, alive, nextRound: round + 1, champion: alive.length === 1 ? alive[0] : null };
  }
  upsets.sort((a, b) => (b.w.tier - b.l.tier) - (a.w.tier - a.l.tier) || a.w.idx - b.w.idx);
  return { view: { season: w.season, rounds, champion: c.champion != null ? ref(c.champion) : null, upsets: upsets.slice(0, 10) }, games };
}
