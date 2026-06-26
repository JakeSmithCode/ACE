// `pnpm server` — drive the Phase-2 tick core headless and prove its three
// load-bearing properties: it resolves the world a match-day at a time and rolls
// seasons over (the BullMQ tick), it's IDEMPOTENT (a retried tick never
// double-resolves), and it's DETERMINISTIC (same seed → byte-identical world). No
// DB, no HTTP — the exact resolution code the server runs, against an in-memory
// store.
import { RANK_TIERS, type WorldState } from '@ace/world';
import { simulateMatch } from '@ace/engine';
import { MemoryStore, type WorldStore } from './store.js';
import { seedWorld } from './seed.js';
import { runTick, runSeason } from './tick.js';
import { navOf } from './nav.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const seed = parseInt(flag('seed', '7'), 10);
const seasons = parseInt(flag('seasons', '6'), 10);

const tierName = (t: number) => RANK_TIERS[t] ?? `T${t}`;
const load = (s: WorldStore, id: string): WorldState => s.loadWorld(id)!;
// a stable digest of the world's evolving state — for the determinism check
const digest = (w: WorldState): string =>
  w.clubs.map(c => `${c.tag}:${c.tier}:${Math.round(c.strength * 1000)}:${c.balance}:${c.titles}`).join('|') + `#${w.season}.${w.day}.${w.results.length}`;

// run a fresh world for N seasons; return the store/id and the per-season log
function play(seasonsToRun: number): { store: MemoryStore; id: string; log: string[] } {
  const store = new MemoryStore();
  const id = seedWorld(store, { seed, region: 'AMER' });
  const w0 = load(store, id);
  const track = w0.clubs.findIndex(c => c.tier === 7);   // a mid-table Gold club to follow
  const log: string[] = [];
  for (let s = 0; s < seasonsToRun; s++) {
    const reports = runSeason(store, id);
    const matchdays = reports.filter(r => r.kind === 'matchday' && !r.skipped).length;
    const roll = reports[reports.length - 1];
    const me = load(store, id).clubs[track];           // world has rolled to the next season
    const fx = store.fixtures(id, roll.season).length;
    log.push(`  ${String(roll.season).padStart(5)}  ${(roll.champion ?? '—').padEnd(9)}  ${tierName(me.tier).padEnd(11)}  ${String(fx).padStart(7)}  ${String(matchdays).padStart(8)}`);
  }
  return { store, id, log };
}

console.log(`\n  ACE server core · seed ${seed} · in-memory store · headless tick\n`);

// ── 1. seed + tick a world season-by-season ────────────────────────────────
const A = play(seasons);
const w0 = load(A.store, A.id);
const track = w0.clubs.find(c => c.tier === 7) ?? w0.clubs[0];
console.log(`  seeded ${A.id}: ${w0.clubs.length} clubs · ${w0.tiers} tiers · following ${track.tag}\n`);
console.log(`  season  champion   follow       fixtures  matchdays`);
console.log('  ' + '─'.repeat(54));
A.log.forEach(l => console.log(l));

// ── 2. determinism: a second independent run from the same seed is identical ─
const B = play(seasons);
const same = digest(load(A.store, A.id)) === digest(load(B.store, B.id));
console.log(`\n  determinism : two independent runs → ${same ? 'IDENTICAL ✓' : 'DIVERGED ✗'}`);

// ── 3. idempotency: a retried tick on the same (season,day) is a no-op ───────
const store = new MemoryStore();
const id = seedWorld(store, { seed, region: 'AMER' });
const first = runTick(store, id);                       // resolve season 1, day 0
const fxAfter = store.fixtures(id).length;
// simulate a crashed/retried job: rewind `day` and tick again — the guard must hold
store.saveWorld(id, { ...load(store, id), day: 0 });
const retry = runTick(store, id);
const ok = retry.skipped && store.fixtures(id).length === fxAfter;
console.log(`  idempotency : retry day 0 → ${retry.skipped ? 'SKIPPED' : 'RE-RESOLVED'}; fixtures ${store.fixtures(id).length === fxAfter ? 'unchanged' : 'DUPLICATED'} → ${ok ? 'safe ✓' : 'LEAK ✗'}`);
void first;

// ── 4. full-sim the WATCHABLE division (the engine path) + re-sim to watch ───
const fs = new MemoryStore();
const fid = seedWorld(fs, { seed, region: 'AMER' });
// mark the Premier (division 0) watchable → full-sim it, quick-resolve the rest
const fr = runTick(fs, fid, { full: (d) => d === 0, navOf });
const watched = fs.fixtures(fid, 1).filter(f => f.inputSnapshot);
console.log(`\n  full-sim    : day ${fr.day} → ${fr.fullSimmed} fixtures engine-simmed (Premier), ${fr.fixtures - (fr.fullSimmed ?? 0)} quick; snapshots stored: ${watched.length}`);
if (watched.length) {
  const f = watched[0];
  console.log(`              top match: ${f.homeScore}–${f.awayScore} on ${f.inputSnapshot!.map} (seed ${f.seed})`);
  // re-sim from the stored snapshot — must reproduce the persisted score byte-for-byte
  const replay = simulateMatch(f.inputSnapshot!, navOf(f.inputSnapshot!.map), 0).finalScore;
  const matches = replay[0] === f.homeScore && replay[1] === f.awayScore;
  console.log(`  re-sim watch: replay from snapshot → ${replay[0]}–${replay[1]} ${matches ? 'reproduces stored score ✓' : 'MISMATCH ✗'}`);
}

console.log(`\n  persisted (run A): ${A.store.fixtures(A.id).length} fixtures · ${A.store.ticks(A.id).length} ticks logged\n`);
