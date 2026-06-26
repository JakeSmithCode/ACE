// Server-side navmesh loading (cached). The engine is pure — the navmesh is
// injected — so the worker loads it from disk the same way the CLIs do, via the
// node-only `loadNavmesh` (imported by relative path so nothing browser-bound
// pulls it in). One nav per map, cached for the life of the worker.
import type { MapId } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { loadNavmesh } from '../../../packages/maps/src/load.js';

const cache = new Map<MapId, Navmesh>();

export function navOf(map: MapId): Navmesh {
  let n = cache.get(map);
  if (!n) { n = loadNavmesh(map); cache.set(map, n); }
  return n;
}
