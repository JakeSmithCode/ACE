// `pnpm world` — run the WorldState engine headless across many seasons, the way
// the Phase-2 server tick worker will (no Vue, no DB, no navmesh: every division
// quick-resolved). Proves the full rank ladder churns deterministically — clubs
// climb and fall, champions emerge, the meta shifts — purely from a seed.
import { createWorld, simulateSeason, advanceWorld, RANK_TIERS, type WorldState } from './state.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const seed = parseInt(flag('seed', '7'), 10);
const seasons = parseInt(flag('seasons', '12'), 10);

let world: WorldState = createWorld(seed, { tiers: 11, size: 10, promo: 2, region: 'AMER' });
const tierName = (t: number) => RANK_TIERS[t] ?? `T${t}`;
// follow a mid-table Gold club across its career (the player's starting point)
const track = world.clubs.findIndex(c => c.tier === 7);
const startTag = world.clubs[track].tag;
const titleTally: Record<string, number> = {};

console.log(`\n  WORLD ${seed} · ${world.tiers} tiers × ${world.size} · ${world.clubs.length} clubs · headless\n`);
console.log(`  following ${startTag} (starts ${tierName(world.clubs[track].tier)})\n`);
console.log(`  season  champion (Premier)      ${startTag} tier        bal`);
console.log('  ' + '─'.repeat(58));

let peak = world.clubs[track].tier, low = world.clubs[track].tier;
for (let s = 0; s < seasons; s++) {
  world = simulateSeason(world);
  const { world: next, champion } = advanceWorld(world);
  const champ = world.clubs[champion];
  titleTally[champ.tag] = (titleTally[champ.tag] ?? 0) + 1;
  const me = world.clubs[track];
  peak = Math.min(peak, me.tier); low = Math.max(low, me.tier);
  const bal = (me.balance / 1000).toFixed(0) + 'k';
  console.log(`  ${String(world.season).padStart(4)}    ${(champ.tag + ' · ' + champ.name).padEnd(24)} ${tierName(me.tier).padEnd(12)} ${bal.padStart(8)}`);
  world = next;
}

const dynasties = Object.entries(titleTally).sort((a, b) => b[1] - a[1]).slice(0, 4);
console.log('\n  most Premier titles: ' + dynasties.map(([t, n]) => `${t}×${n}`).join('  '));
console.log(`  ${startTag} career: peaked ${tierName(peak)}, low ${tierName(low)}, now ${tierName(world.clubs[track].tier)}`);
// determinism: a second run must match
const w2 = (() => { let w = createWorld(seed, { tiers: 11, size: 10, promo: 2, region: 'AMER' }); for (let s = 0; s < seasons; s++) { w = simulateSeason(w); w = advanceWorld(w).world; } return w; })();
console.log(`  deterministic: ${JSON.stringify(world.clubs.map(c => [c.tier, c.titles])) === JSON.stringify(w2.clubs.map(c => [c.tier, c.titles]))}\n`);
