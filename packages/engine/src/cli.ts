import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MatchInput, MapId } from '@ace/shared';
import { simulateMatch } from './sim.js';
import { NOCTURNE, MERIDIAN, PATCH, NCT_TACTICS, MRD_TACTICS } from './sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const seed = parseInt(flag('seed', '42'), 10);
const map = flag('map', 'ascent') as MapId;

const input: MatchInput = { seed, map, teams: [NOCTURNE, MERIDIAN], patch: PATCH, tactics: [NCT_TACTICS, MRD_TACTICS] };
const tl = simulateMatch(input);

for (const o of [resolve(process.cwd(), 'timeline.json'), resolve(here, '../../../apps/web/public/timeline.json')]) {
  try { writeFileSync(o, JSON.stringify(tl)); console.log('wrote', o); } catch (e) { /* web app may be absent */ }
}

const kills = tl.rounds.reduce((a, r) => a + r.events.filter(e => e.kind === 'kill').length, 0);
const methods = tl.rounds.reduce<Record<string, number>>((m, r) => ((m[r.method] = (m[r.method] || 0) + 1), m), {});
console.log(`\n  ${tl.teams[0].tag} ${tl.finalScore[0]} : ${tl.finalScore[1]} ${tl.teams[1].tag}`);
console.log(`  ${map} · seed ${seed} · ${tl.rounds.length} rounds · ${kills} kills · endings`, methods);
