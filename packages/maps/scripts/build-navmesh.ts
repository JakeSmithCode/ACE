/**
 * Build a navmesh from a map's official minimap (displayIcon) by treating the
 * PNG alpha channel as a walkability mask: opaque = floor, transparent = wall.
 *
 *   pnpm navmesh            # ascent
 *   tsx scripts/build-navmesh.ts <mapId>
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const map = process.argv[2] ?? 'ascent';
const CELL = 8;

const png = PNG.sync.read(readFileSync(resolve(here, '../assets', `${map}.png`)));
const { width, height, data } = png;
const cols = Math.floor(width / CELL);
const rows = Math.floor(height / CELL);
const walk: number[] = new Array(cols * rows).fill(0);
const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const x = Math.min(width - 1, c * CELL + (CELL >> 1));
    const y = Math.min(height - 1, r * CELL + (CELL >> 1));
    walk[r * cols + c] = alphaAt(x, y) > 128 ? 1 : 0;
  }
}

const nav = { width, height, cell: CELL, cols, rows, walk };
const json = JSON.stringify(nav);
const walkable = walk.reduce((a, b) => a + b, 0);
console.log(`[navmesh] ${map}: ${width}x${height} -> ${cols}x${rows} grid, ${walkable} walkable cells`);

// the engine reads it from packages/maps/data; the viewer fetches it from
// apps/web/public to draw vision cones against the same walls. Commit both so a
// cold clone works without running the pipeline.
const outDir = resolve(here, '../data');
mkdirSync(outDir, { recursive: true });
for (const out of [resolve(outDir, `${map}.navmesh.json`), resolve(here, '../../../apps/web/public', `${map}.navmesh.json`)]) {
  try { writeFileSync(out, json); console.log(`[navmesh] wrote ${out}`); } catch { /* web app may be absent */ }
}
