import type { MapId, Vec2, SiteId } from '@ace/shared';

/** Per-map tactical anchors in minimap image space (0..1000).
 *  Derived from the official displayIcon; site centers from the asset pack,
 *  spawn/mid eyeballed against the contact sheet. The engine snaps any point to
 *  the nearest walkable cell, so these need only be roughly right.
 *  `sites.C` is opt-in: present only on genuinely three-site maps (Haven, Lotus). */
export interface MapAnchors {
  atkSpawn: Vec2;
  sites: { A: Vec2; B: Vec2; C?: Vec2 };
  mid: Vec2;
}

// Haven and Lotus are genuinely three-site — they now field all three (A/B/C).
// Abyss is 2-site (the 3rd detected point was a spawn artifact, dropped).
// `mid` sits between spawn and the sites — the chokepoint where the defense first
// contests the push. (Ascent's is hand-tuned; the rest are spawn↔sites midpoints.)
export const ANCHORS: Partial<Record<MapId, MapAnchors>> = {
  ascent:   { atkSpawn: [485, 60],  sites: { A: [310, 150], B: [270, 793] }, mid: [500, 470] },
  abyss:    { atkSpawn: [840, 480], sites: { A: [408, 104], B: [392, 864] }, mid: [620, 482] },
  bind:     { atkSpawn: [595, 870], sites: { A: [288, 264], B: [720, 320] }, mid: [549, 581] },
  breeze:   { atkSpawn: [470, 870], sites: { A: [144, 288], B: [864, 456] }, mid: [487, 621] },
  fracture: { atkSpawn: [500, 120], sites: { A: [872, 504], B: [96, 520] },  mid: [492, 316] },
  haven:    { atkSpawn: [850, 520], sites: { A: [368, 136], B: [344, 470], C: [360, 832] }, mid: [607, 502] },
  icebox:   { atkSpawn: [850, 540], sites: { A: [608, 208], B: [720, 800] }, mid: [757, 522] },
  lotus:    { atkSpawn: [500, 850], sites: { A: [864, 320], B: [488, 372], C: [112, 464] }, mid: [494, 621] },
  pearl:    { atkSpawn: [533, 860], sites: { A: [848, 312], B: [176, 400] }, mid: [522, 608] },
  split:    { atkSpawn: [130, 520], sites: { A: [320, 88],  B: [320, 816] }, mid: [225, 486] },
  sunset:   { atkSpawn: [520, 860], sites: { A: [816, 368], B: [136, 432] }, mid: [498, 630] },
};

/** The site ids a map fields, in order (`['A','B']` or `['A','B','C']`). */
export function siteIds(a: MapAnchors): SiteId[] {
  return (['A', 'B', 'C'] as const).filter(s => a.sites[s]);
}

/** A site's anchor point (the id is always one the map fields). */
export const sitePt = (a: MapAnchors, s: SiteId): Vec2 => a.sites[s]!;
