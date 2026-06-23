// Node-only navmesh loader (reads the committed JSON the build step emits).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MapId } from '@ace/shared';
import type { Navmesh } from './navmesh.js';

const here = dirname(fileURLToPath(import.meta.url));
export function loadNavmesh(map: MapId): Navmesh {
  const p = resolve(here, '../data', `${map}.navmesh.json`);
  return JSON.parse(readFileSync(p, 'utf8')) as Navmesh;
}
