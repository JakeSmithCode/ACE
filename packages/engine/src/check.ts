// `pnpm sim:check` — the determinism golden test (docs/PHASE2.md §15). Determinism
// is the load-bearing property of this whole codebase: a stored result is history,
// and re-sim-to-watch must reproduce it byte-for-byte forever. This guards two
// things and exits non-zero on either drift, so CI catches a determinism regression
// the moment it lands (rather than discovering it when replays silently diverge):
//   1. run-to-run — two sims of the canonical input are byte-identical, and
//   2. golden    — that output still matches the committed timeline artifact.
// If this fails after an intentional engine change, re-run `pnpm sim -- --seed 42`,
// review the diff, and commit the regenerated sample on purpose.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MatchInput } from '@ace/shared';
import { loadNavmesh } from '../../maps/src/load.js';
import { simulateMatch } from './sim.js';
import { NOCTURNE, MERIDIAN, PATCH, NCT_TACTICS, MRD_TACTICS } from './sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const input: MatchInput = { seed: 42, map: 'ascent', teams: [NOCTURNE, MERIDIAN], patch: PATCH, tactics: [NCT_TACTICS, MRD_TACTICS] };
const nav = loadNavmesh('ascent');

const a = JSON.stringify(simulateMatch(input, nav));
const b = JSON.stringify(simulateMatch(input, nav));
const runStable = a === b;

const goldenPath = resolve(here, '../../../apps/web/public/timeline.json');
let matchesGolden = false, goldenErr = '';
try { matchesGolden = a === readFileSync(goldenPath, 'utf8'); }
catch (e) { goldenErr = (e as Error).message; }

const score = JSON.parse(a).finalScore as [number, number];
console.log(`\n  determinism golden-check · seed 42 · ascent · ${score[0]}–${score[1]}`);
console.log(`    run-to-run byte-identical  : ${runStable ? 'OK ✓' : 'DRIFT ✗'}`);
console.log(`    matches committed timeline : ${matchesGolden ? 'OK ✓' : (goldenErr ? `MISSING (${goldenErr})` : 'DRIFT ✗')}`);

if (!runStable || !matchesGolden) {
  console.error('\n  ✗ DETERMINISM DRIFT — the engine no longer reproduces the committed timeline.\n' +
    '    If this change was intentional, run `pnpm sim -- --seed 42`, review the diff,\n' +
    '    and commit the regenerated apps/web/public/timeline.json on purpose.\n');
  process.exit(1);
}
console.log('\n  ✓ deterministic and reproducible.\n');
