// The full-sim resolver for WATCHABLE divisions (docs/PHASE2.md §6/§8): build the
// fixture's engine input from each club's fielded five + tactics + comp, run the
// real `simulateMatch` (forks:0 — the canonical finalScore is fork-independent),
// and capture the input_snapshot so the client can re-sim the exact match to watch
// (§7). Dormant divisions stay on the cheap `quickResult`; this is what makes a
// human's matches actually watchable through the server path.
import type { MatchInput } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch } from '@ace/engine';
import { buildMatchInput, clubTeam, fixtureMap, aiMatchupTactics, type WorldState, type WorldClub, type Fixture, type MatchResult } from '@ace/world';

/** The tactics a club brings to a fixture: a HUMAN owner's authored plan as-is; an AI club
 *  scouts its opponent and reads toward where that opponent's roster prefers to hit
 *  (`aiMatchupTactics`). A human's plan is sacred — only AI clubs get the matchup read. */
function matchTactics(self: WorldClub, opp: WorldClub) {
  return self.owner ? self.tactics : aiMatchupTactics(clubTeam(self), clubTeam(opp));
}

export interface SimResolver {
  /** Resolve a fixture with the engine; signature matches `resolveSeasonDay`'s `resolve`. */
  resolve: (fx: Fixture, seed: number, division: number) => MatchResult;
  /** The input_snapshot per resolved fixture (keyed by its seed) — persisted for
   *  watchable fixtures so the client can reproduce the timeline byte-for-byte. */
  snapshots: Map<number, MatchInput>;
}

/** Build a full-sim resolver bound to the world's current state (rosters develop
 *  across the season, so the snapshot must capture the teams *at resolution time*). */
export function fullSimResolver(w: WorldState, navOf: (map: MatchInput['map']) => Navmesh, forks = 0): SimResolver {
  const snapshots = new Map<number, MatchInput>();
  const resolve = (fx: Fixture, seed: number): MatchResult => {
    const home = w.clubs[fx.home], away = w.clubs[fx.away];
    const map = fixtureMap(seed);
    const input = buildMatchInput({
      seed, map, patch: w.patch,
      home: clubTeam(home), away: clubTeam(away),
      tactics: [matchTactics(home, away), matchTactics(away, home)], comp: [home.comp, away.comp],
    });
    snapshots.set(seed, input);
    const [h, a] = simulateMatch(input, navOf(map), forks).finalScore;
    return { home: fx.home, away: fx.away, score: [h, a], winner: h > a ? fx.home : fx.away, seed };
  };
  return { resolve, snapshots };
}
