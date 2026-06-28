// The world's best players — a cross-club prestige board (DESIGN §9, the legacy/
// social layer). Who are the strongest individuals in the world, regardless of which
// club they're on? A Radiant talent stuck on a Gold club is the gem to scout — solo
// rank is a different axis from the club's division. Pure + deterministic; the engine
// never sees it.
import { overall, soloRank } from './develop.js';
import type { WorldState } from './state.js';

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
