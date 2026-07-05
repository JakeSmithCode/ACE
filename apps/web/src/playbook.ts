// Shared playbook authoring helpers — used by the single-player Tactics Editor
// AND the Match Center's PvP playbook panel. Starters are DERIVED from a map's
// anchors (never hardcoded coordinates), with every point snapped to the nearest
// walkable cell, so they're sane templates on any pool map.
import type { Play, Team, Vec2 } from '@ace/shared';
import type { MapAnchors, Navmesh } from '@ace/maps';

const walkableAt = (nav: Navmesh, p: Vec2): boolean => {
  const c = Math.floor(p[0] / nav.cell), r = Math.floor(p[1] / nav.cell);
  return c >= 0 && c < nav.cols && r >= 0 && r < nav.rows && nav.walk[r * nav.cols + c] === 1;
};

/** Snap a point to the nearest walkable cell (spiral probe) — a starter position
 *  must never sit in a wall. */
export function snapWalkable(nav: Navmesh | null, p: Vec2): Vec2 {
  const cl = (v: number) => Math.max(8, Math.min(992, Math.round(v)));
  const q: Vec2 = [cl(p[0]), cl(p[1])];
  if (!nav || walkableAt(nav, q)) return q;
  for (let R = 8; R <= 120; R += 8) for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const c: Vec2 = [cl(q[0] + Math.cos(a) * R), cl(q[1] + Math.sin(a) * R)];
    if (walkableAt(nav, c)) return c;
  }
  return q;
}

/** The defense starter: the classic shape — a mid bait, two A bodies that
 *  collapse deeper when he falls (the kill point), an A anchor, a B watcher. */
export function starterDefense(team: Team, A: MapAnchors, nav: Navmesh | null): Play {
  const [p0, p1, p2, p3, p4] = team.players.map(p => p.id);
  const snap = (p: Vec2) => snapWalkable(nav, p);
  const off = (b: Vec2, dx: number, dy: number): Vec2 => snap([b[0] + dx, b[1] + dy]);
  return { plans: [
    { player: p3, pos: snap([A.mid[0], A.mid[1]]) },
    { player: p0, pos: off(A.sites.A, 40, 55), rotate: { pos: off(A.sites.A, 15, -40), trigger: { kind: 'death', player: p3 } } },
    { player: p1, pos: off(A.sites.A, -45, 40), rotate: { pos: off(A.sites.A, -20, -40), trigger: { kind: 'death', player: p3 } } },
    { player: p2, pos: snap([A.sites.A[0], A.sites.A[1]]) },
    { player: p4, pos: snap([A.sites.B[0], A.sites.B[1]]) },
  ] };
}

/** The attack starter: a fan across the spawn→site push axis (three entries at
 *  spread angles, one support back, one connector body) + a site smoke. */
export function starterAttack(team: Team, A: MapAnchors, nav: Navmesh | null): Play {
  const [p0, p1, p2, p3, p4] = team.players.map(p => p.id);
  const snap = (p: Vec2) => snapWalkable(nav, p);
  const pA = A.sites.A;
  const L = Math.hypot(pA[0] - A.atkSpawn[0], pA[1] - A.atkSpawn[1]) || 1;
  const d: Vec2 = [(pA[0] - A.atkSpawn[0]) / L, (pA[1] - A.atkSpawn[1]) / L];
  const px = -d[1], py = d[0];
  const at = (back: number, side: number): Vec2 => snap([pA[0] - d[0] * back + px * side, pA[1] - d[1] * back + py * side]);
  return { site: 'A', plans: [
    { player: p0, pos: at(20, -45) }, { player: p1, pos: at(10, 10) }, { player: p2, pos: at(30, 60) },
    { player: p3, pos: at(95, -20) },
    { player: p4, pos: snap([(pA[0] + A.mid[0]) / 2, (pA[1] + A.mid[1]) / 2]) },
  ], lineups: [ { player: p2, kind: 'smoke', at: snap([pA[0] + d[0] * 70, pA[1] + d[1] * 70]), t: 0.25 } ] };
}

/** Transplant a primary execute to the map's next site (translate everything by
 *  the site delta, flip the site) — the ⑂ alt starting template. */
export function altExecFrom(primary: Play, A: MapAnchors): Play {
  const sites = A.sites;
  const list = (['A', 'B', 'C'] as const).filter(s => sites[s]);
  const s1 = (primary.site ?? 'A') as typeof list[number];
  const s2 = list[(list.indexOf(s1) + 1) % list.length];
  const dd = [sites[s2]![0] - sites[s1]![0], sites[s2]![1] - sites[s1]![1]];
  const cl = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  const sh = (pt: Vec2): Vec2 => [cl(pt[0] + dd[0]), cl(pt[1] + dd[1])];
  const c: Play = JSON.parse(JSON.stringify(primary));
  c.site = s2;
  for (const pl of c.plans) {
    pl.pos = sh(pl.pos);
    if (pl.face) pl.face = sh(pl.face);
    if (pl.route) pl.route = pl.route.map(sh);
    let st = pl.rotate;
    while (st) { st.pos = sh(st.pos); if (st.route) st.route = st.route.map(sh); st = st.then; }
  }
  for (const ln of c.lineups ?? []) { ln.at = sh(ln.at); if (ln.at2) ln.at2 = sh(ln.at2); }
  return c;
}
