// The world's best players — a cross-club prestige board (DESIGN §9, the legacy/
// social layer). Who are the strongest individuals in the world, regardless of which
// club they're on? A Radiant talent stuck on a Gold club is the gem to scout — solo
// rank is a different axis from the club's division. Pure + deterministic; the engine
// never sees it.
import { overall, soloRank, squadRating, clubPhase, type ClubPhase } from './develop.js';
import { clubInfra } from './facilities.js';
import { clubTeam, type WorldState } from './state.js';

export interface LeaderRow {
  rank: number; handle: string; role: string; age: number; overall: number;
  soloLabel: string; soloTier: string; club: string; clubTag: string; tier: number; owned: boolean;
}

/** The top `count` players in the world by overall — optionally filtered to one role.
 *  Ties broken by handle so the order is stable/deterministic. */
export function topPlayers(w: WorldState, count = 25, role?: string): LeaderRow[] {
  return w.clubs.flatMap(c => c.roster.map(p => ({ p, c })))
    .filter(({ p }) => !role || p.role === role)
    .map(({ p, c }) => ({ ovr: overall(p), p, c }))
    .sort((a, b) => b.ovr - a.ovr || a.p.handle.localeCompare(b.p.handle))
    .slice(0, count)
    .map((r, i) => {
      const sr = soloRank(r.ovr);
      return {
        rank: i + 1, handle: r.p.handle, role: r.p.role, age: r.p.age, overall: Math.round(r.ovr),
        soloLabel: sr.label, soloTier: sr.tier, club: r.c.name, clubTag: r.c.tag, tier: r.c.tier, owned: r.c.owner != null,
      };
    });
}

export interface ClubRankRow {
  rank: number; tag: string; name: string; tier: number; group: number;
  power: number; phase: ClubPhase; infra: number; titles: number; owned: boolean;
}

/** The world's strongest clubs by POWER (the fielded five's squad rating) — the
 *  "read the league" board. Each carries its lifecycle `phase` (rebuilding/rising/
 *  prime/aging — who's a fading dynasty vs a rising threat) and `infra` (build quality,
 *  the long-term-threat signal). A different read from the standings (which is this
 *  season's results); this is squad quality regardless of form. Pure + deterministic. */
export function topClubs(w: WorldState, count = 25): ClubRankRow[] {
  return w.clubs.map(c => { const team = clubTeam(c); return { c, power: squadRating(team), phase: clubPhase(team) }; })
    .sort((a, b) => b.power - a.power || a.c.tag.localeCompare(b.c.tag))
    .slice(0, count)
    .map((r, i) => ({
      rank: i + 1, tag: r.c.tag, name: r.c.name, tier: r.c.tier, group: r.c.group,
      power: Math.round(r.power), phase: r.phase, infra: clubInfra(r.c.strength), titles: r.c.titles, owned: r.c.owner != null,
    }));
}
