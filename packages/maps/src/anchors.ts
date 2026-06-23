import type { MapId, Vec2 } from '@ace/shared';

/** Per-map tactical anchors in minimap image space (0..1000).
 *  Derived from the official displayIcon; Ascent verified against the alpha mask. */
export interface MapAnchors {
  atkSpawn: Vec2;
  sites: { A: Vec2; B: Vec2 };
  mid: Vec2;
}

export const ANCHORS: Partial<Record<MapId, MapAnchors>> = {
  ascent: {
    atkSpawn: [485, 60],
    sites: { A: [310, 150], B: [270, 793] },
    mid: [500, 470],
  },
};
