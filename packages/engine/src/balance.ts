// Map-balance x-ray. The engine is tuned to Ascent's scale; every other map's
// anchors are first-pass, so they complete but play unbalanced. This measures
// *how* unbalanced: it runs a roster-symmetric matchup (a team vs its own mirror,
// neutral DEFAULT_TACTICS) across a seed spread, so the only variable left is the
// map's geometry + the engine's structural attacker/defender asymmetry. A
// well-tuned map lands near Ascent's attacker share with a sane ending mix; a map
// far from that is mis-anchored. Pure measurement — changes nothing.
//
//   pnpm balance                  all maps, 80 seeds
//   pnpm balance -- --map bind --seeds 200
import type { MatchInput, MapId, Team } from '@ace/shared';
import { DEFAULT_TACTICS } from '@ace/shared';
import { loadNavmesh } from '../../maps/src/load.js';
import { simulateMatch } from './sim.js';
import { NOCTURNE, PATCH } from './sample.js';

const ALL: MapId[] = ['ascent', 'abyss', 'bind', 'breeze', 'fracture', 'haven', 'icebox', 'lotus', 'pearl', 'split', 'sunset'];

// a roster-symmetric opponent: the same five with disjoint ids/handles (the
// engine keys form/loadouts/kills by handle, so they must be globally unique).
function mirror(t: Team): Team {
  return {
    id: t.id + '-m', tag: 'MIR', name: t.name + ' Mirror',
    players: t.players.map(p => ({ ...p, id: 'm-' + p.id, handle: p.handle + '*' })),
  };
}

const arg = (n: string, d: string): string => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n: string): boolean => process.argv.includes('--' + n);
const seeds = parseInt(arg('seeds', '80'), 10);
const only = arg('map', '');
// --pool: measure only the curated rotation; --check: exit non-zero if any
// measured map flags — the CI gate that stops a tuning change from silently
// breaking the pool (import is script-level only; the engine lib stays pure).
const { MAP_POOL } = await import('../../world/src/resolve.js');
const maps = only ? [only as MapId] : has('pool') ? MAP_POOL : ALL;
const check = has('check');
let flagged = 0;

const home = NOCTURNE, away = mirror(NOCTURNE);

console.log(`\n  map-balance · ${seeds} seeds · roster-symmetric (mirror) · neutral tactics`);
console.log(`  ${'map'.padEnd(8)} ${'atk%'.padStart(6)} ${'plant%'.padStart(7)}   det/def/elim/time          flag`);
console.log('  ' + '─'.repeat(74));
for (const map of maps) {
  const nav = loadNavmesh(map);
  let atkRounds = 0, rounds = 0, plants = 0;
  const mix: Record<string, number> = {};
  for (let s = 1; s <= seeds; s++) {
    const input: MatchInput = { seed: s, map, teams: [home, away], patch: PATCH, tactics: [DEFAULT_TACTICS, DEFAULT_TACTICS] };
    const tl = simulateMatch(input, nav, 0);
    for (const r of tl.rounds) {
      rounds++;
      if (r.winner === r.attacker) atkRounds++;
      mix[r.method] = (mix[r.method] || 0) + 1;
      if (r.events.some(e => e.kind === 'plant')) plants++;
    }
  }
  const pct = (x: number) => (100 * x / rounds);
  const atk = pct(atkRounds);
  const f = (x: number) => x.toFixed(0).padStart(2);
  const mixStr = `${f(pct(mix.detonation || 0))}/${f(pct(mix.defuse || 0))}/${f(pct(mix.elimination || 0))}/${f(pct(mix.time || 0))}`;
  // flag maps whose attacker share strays from a healthy band, or that stall a lot
  const flag = atk >= 58 ? 'ATK-SIDED' : atk <= 42 ? 'DEF-SIDED' : pct(mix.time || 0) >= 12 ? 'STALLY' : 'ok';
  if (flag !== 'ok') flagged++;
  console.log(`  ${map.padEnd(8)} ${atk.toFixed(1).padStart(6)} ${pct(plants).toFixed(1).padStart(7)}   ${mixStr.padEnd(18)} ${flag}`);
}
console.log('');
if (check) {
  if (flagged) { console.error(`  ✗ ${flagged} measured map(s) flagged — the pool is not clean.`); process.exit(1); }
  console.log('  ✓ every measured map is in band.');
}
