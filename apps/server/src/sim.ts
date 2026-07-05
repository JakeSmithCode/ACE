// The full-sim resolver for WATCHABLE divisions (docs/PHASE2.md §6/§8): build the
// fixture's engine input from each club's fielded five + tactics + comp, run the
// real `simulateMatch` (forks:0 — the canonical finalScore is fork-independent),
// and capture the input_snapshot so the client can re-sim the exact match to watch
// (§7). Dormant divisions stay on the cheap `quickResult`; this is what makes a
// human's matches actually watchable through the server path.
import type { MatchInput, MapId, Team, Comp } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch } from '@ace/engine';
import { buildMatchInput, clubTeam, fixtureMap, aiMatchupTactics, aiComp, aiBestFive, planFive, fitTeam, moraleTeam, squadMood, type WorldState, type WorldClub, type Fixture, type MatchResult, type Fitness, type Morale } from '@ace/world';

/** What a club brings to a fixture — the manager's three levers (tactics, comp, lineup):
 *  a HUMAN owner's authored plan is sacred (their saved five + comp + tactics, used as-is);
 *  an AI club plays its IDENTITY — `aiBestFive` fields its strongest five for the live patch
 *  (a buffed-agent specialist promoted off the bench), `aiComp` reads the meta to pick each
 *  agent, and `aiMatchupTactics` reads toward where the opponent likes to hit. */
function clubPlan(self: WorldClub, opp: WorldClub, patch: WorldState['patch'], map: MapId, fitness?: Fitness, morale?: Morale): { team: Team; comp: Comp; tactics: WorldClub['tactics'] } {
  // a HUMAN owner's authored plan, with match-night FITNESS + MORALE applied: the fielded five
  // honours injuries (a reserve covers, or he plays hurt) and fatigue dulls his attributes;
  // then mood + the pre-match team talk lift/drag the room. No fitness/morale state → fresh
  // team (byte-identical). Both are engine-blind — the engine just sees the scaled attrs.
  if (self.owner) {
    const { team, fielded } = fitTeam(self, planFive(self), fitness);
    const derby = self.rival === opp.id;   // the derby: Big-Game players rise for it
    const adj = moraleTeam(team, morale, { talk: self.teamTalk, favEdge: self.strength - opp.strength, mood: squadMood(morale, fielded.map(p => p.id)), derby });
    // the PER-MAP PLAYBOOK: the fixture map's authored slots ride into the club's
    // tactics at resolution time (plays are map-space — only this map's apply).
    // No playbook → the tactics object passes through untouched (byte-identical).
    const pb = self.plays?.[map];
    const tactics = pb ? {
      ...self.tactics,
      attack: { ...self.tactics.attack, play: pb.attack, play2: pb.attack2 },
      defense: { ...self.tactics.defense, play: pb.defense },
    } : self.tactics;
    return { team: adj, comp: self.comp, tactics };
  }
  const team = { id: self.id, tag: self.tag, name: self.name, players: aiBestFive(self.roster, patch) };
  return { team, comp: aiComp(team, patch), tactics: aiMatchupTactics(team, clubTeam(opp)) };
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
    const h = clubPlan(home, away, w.patch, map, w.fitness, w.morale), a = clubPlan(away, home, w.patch, map, w.fitness, w.morale);
    const input = buildMatchInput({
      seed, map, patch: w.patch,
      home: h.team, away: a.team,
      tactics: [h.tactics, a.tactics], comp: [h.comp, a.comp],
    });
    snapshots.set(seed, input);
    const [hs, as] = simulateMatch(input, navOf(map), forks).finalScore;
    return { home: fx.home, away: fx.away, score: [hs, as], winner: hs > as ? fx.home : fx.away, seed };
  };
  return { resolve, snapshots };
}
