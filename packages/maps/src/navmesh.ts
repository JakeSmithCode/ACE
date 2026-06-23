import type { Vec2 } from '@ace/shared';

/** A walkability grid derived from a map's minimap alpha channel.
 *  walk[r*cols + c] === 1 means that cell is floor. */
export interface Navmesh {
  width: number;
  height: number;
  cell: number;
  cols: number;
  rows: number;
  walk: number[];
}

export function walkAt(nav: Navmesh, c: number, r: number): boolean {
  return c >= 0 && c < nav.cols && r >= 0 && r < nav.rows && nav.walk[r * nav.cols + c] === 1;
}
function cellOf(nav: Navmesh, x: number, y: number): [number, number] {
  return [Math.floor(x / nav.cell), Math.floor(y / nav.cell)];
}
function center(nav: Navmesh, c: number, r: number): Vec2 {
  return [c * nav.cell + (nav.cell >> 1), r * nav.cell + (nav.cell >> 1)];
}

export function nearestWalk(nav: Navmesh, c: number, r: number): [number, number] {
  if (walkAt(nav, c, r)) return [c, r];
  for (let rad = 1; rad < 60; rad++) {
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (walkAt(nav, c + dc, r + dr)) return [c + dc, r + dr];
      }
    }
  }
  return [c, r];
}

/** Min-heap keyed by priority, storing cell ids. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(p: number, v: number) {
    const a = this.a; a.push([p, v]); let i = a.length - 1;
    while (i > 0) { const par = (i - 1) >> 1; if (a[par][0] <= a[i][0]) break; [a[par], a[i]] = [a[i], a[par]]; i = par; }
  }
  pop(): number | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0][1]; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2; let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s;
      }
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const DIRS: [number, number][] = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

export function astar(nav: Navmesh, start: [number, number], goal: [number, number]): [number, number][] {
  const s = nearestWalk(nav, start[0], start[1]);
  const g = nearestWalk(nav, goal[0], goal[1]);
  const cols = nav.cols;
  const id = (c: number, r: number) => r * cols + c;
  const gid = id(g[0], g[1]);
  const h = (c: number, r: number) => { const dx = Math.abs(c - g[0]), dy = Math.abs(r - g[1]); return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy); };
  const open = new Heap();
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const closed = new Set<number>();
  const sid = id(s[0], s[1]); gScore.set(sid, 0); open.push(h(s[0], s[1]), sid);
  while (open.size) {
    const cur = open.pop()!;
    if (cur === gid) {
      const path: [number, number][] = []; let n: number | undefined = cur;
      while (n !== undefined) { path.push([n % cols, Math.floor(n / cols)]); n = came.get(n); }
      return path.reverse();
    }
    if (closed.has(cur)) continue; closed.add(cur);
    const cc = cur % cols, cr = Math.floor(cur / cols);
    for (let i = 0; i < 8; i++) {
      const nc = cc + DIRS[i][0], nr = cr + DIRS[i][1];
      if (!walkAt(nav, nc, nr)) continue;
      if (i >= 4 && (!walkAt(nav, cc + DIRS[i][0], cr) || !walkAt(nav, cc, cr + DIRS[i][1]))) continue; // no corner cut
      const step = i >= 4 ? SQRT2 : 1;
      const t = (gScore.get(cur) ?? Infinity) + step;
      const nid = id(nc, nr);
      if (t < (gScore.get(nid) ?? Infinity)) { gScore.set(nid, t); came.set(nid, cur); open.push(t + h(nc, nr), nid); }
    }
  }
  return [s, g];
}

/** Line of sight at grid resolution: every sampled cell along a..b must be floor. */
export function losClear(nav: Navmesh, a: Vec2, b: Vec2): boolean {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / (nav.cell * 0.6)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const [c, r] = cellOf(nav, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    if (!walkAt(nav, c, r)) return false;
  }
  return true;
}

/** Can a viewer at `from`, facing unit vector `dir`, see `to`?
 *  True when `to` is within `range`, inside the half-angle `halfFov` cone,
 *  and not occluded by a wall. This is the fog-of-war primitive: it composes
 *  range + a facing cone on top of the same alpha-mask LOS the navmesh uses,
 *  so "who sees whom" obeys the real geometry of the map. */
export function inView(
  nav: Navmesh, from: Vec2, dir: Vec2, to: Vec2, range: number, halfFov: number,
): boolean {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const d = Math.hypot(dx, dy);
  if (d > range) return false;
  if (d > 1e-6) {
    // dir is assumed unit-length; dot of the bearing against facing == cos(angle)
    const cos = (dx * dir[0] + dy * dir[1]) / d;
    if (cos < Math.cos(halfFov)) return false;
  }
  return losClear(nav, from, to);
}

function smooth(nav: Navmesh, pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [pts[0]]; let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !losClear(nav, pts[i], pts[j])) j--;
    out.push(pts[j]); i = j;
  }
  return out;
}

/** Full path between two image-space points, smoothed to follow corridors. */
export function pathfind(nav: Navmesh, start: Vec2, goal: Vec2): Vec2[] {
  const cells = astar(nav, cellOf(nav, start[0], start[1]), cellOf(nav, goal[0], goal[1]));
  const pts: Vec2[] = cells.map(([c, r]) => center(nav, c, r));
  if (pts.length) { pts[0] = start; pts[pts.length - 1] = goal; }
  return smooth(nav, pts);
}

/** Position a fraction (0..1) of the way along a polyline by arc length. */
export function posAlong(path: Vec2[], frac: number): Vec2 {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  const total = cum[cum.length - 1];
  if (total === 0) return path[0];
  const d = Math.max(0, Math.min(1, frac)) * total;
  for (let i = 1; i < path.length; i++) {
    if (d <= cum[i]) {
      const m = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * m, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * m];
    }
  }
  return path[path.length - 1];
}
