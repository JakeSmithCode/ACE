// `pnpm server` — drive the Phase-2 tick core headless and prove its three
// load-bearing properties: it resolves the world a match-day at a time and rolls
// seasons over (the BullMQ tick), it's IDEMPOTENT (a retried tick never
// double-resolves), and it's DETERMINISTIC (same seed → byte-identical world). No
// DB, no HTTP — the exact resolution code the server runs, against an in-memory
// store.
import { RANK_TIERS, divisionSchedule, membersOf, planFive, validFive, type WorldState } from '@ace/world';
import { simulateMatch } from '@ace/engine';
import { MemoryStore, type WorldStore } from './store.js';
import { seedWorld } from './seed.js';
import { runTick, runSeason } from './tick.js';
import { navOf } from './nav.js';
import { publicView, liveMatchState, fixtureStatus } from './live.js';
import { claim, revert, savePlan, myClub } from './owner.js';

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

// ── 5. live broadcast window: result sealed until the match plays out ────────
const ls = new MemoryStore();
const lid = seedWorld(ls, { seed, region: 'AMER' });
const KICK = 0, DUR = 2400;   // "8pm", 40-minute live window
runTick(ls, lid, { full: (d) => d === 0, navOf, kickoffAt: KICK, broadcastSecs: DUR });
const game = ls.fixtures(lid, 1).find(f => f.inputSnapshot)!;   // a watchable (full-simmed) Premier match
const tl = simulateMatch(game.inputSnapshot!, navOf(game.inputSnapshot!.map), 0);   // server re-sim (the live source)
const at = (now: number) => publicView(game, now);
const showLive = (now: number) => { const v = at(now); const m = liveMatchState(tl, v.frac); return `${fixtureStatus(game, now).padEnd(9)} frac ${v.frac.toFixed(2)}  public-score ${v.score ? v.score.join('–') : 'SEALED'}  live ${m.scoreA}–${m.scoreB} (rd ${m.round + 1})`; };
console.log(`\n  live window : a Premier match kicks off at t=${KICK}, ${DUR}s broadcast (${tl.rounds.length} rounds, true result ${tl.finalScore.join('–')})`);
console.log(`     t=0      ${showLive(0)}`);
console.log(`     t=600    ${showLive(600)}`);
console.log(`     t=1200   ${showLive(1200)}`);
console.log(`     t=2399   ${showLive(2399)}`);
console.log(`     t=2400   ${showLive(2400)}`);
const sealedEarly = !at(2399).score && !at(0).snapshot;   // no public score + no snapshot before reveal
const revealedLate = !!at(2400).score && !!at(2400).snapshot;
console.log(`  embargo     : result + snapshot hidden during the broadcast → ${sealedEarly ? 'sealed ✓' : 'LEAK ✗'}; public at reveal → ${revealedLate ? 'released ✓' : 'STUCK ✗'}`);

// ── 6. ownership overlay: claim a club, author its plan → the tick fields it ──
const os = new MemoryStore();
const oid = seedWorld(os, { seed, region: 'AMER' });
const w6 = load(os, oid);
// the Premier (watchable) club that is HOME in day-0 slot-0 — author its match
const sched0 = divisionSchedule(membersOf(w6.clubs.map(c => c.tier), 0));
const mine = w6.clubs[sched0[0][0].home];
claim(os, oid, mine.id, 'acct-jake');
const claimed = !!myClub(os, oid, 'acct-jake');
let doubleBlocked = false; try { claim(os, oid, w6.clubs[sched0[0][0].away].id, 'acct-jake'); } catch { doubleBlocked = true; }
// author a distinct plan: keep the comp, but flip the defensive read hard one way
const authored = structuredClone(mine.tactics); authored.defense.read = 1; authored.attack.tempo = 1;
savePlan(os, oid, mine.id, { tactics: authored, comp: mine.comp, lineup: planFive(mine).map(p => p.id) });
console.log(`\n  ownership   : claimed ${mine.tag} for acct-jake → owned ${claimed ? '✓' : '✗'}; second claim blocked → ${doubleBlocked ? '✓' : '✗ LEAK'}`);

// full-sim the Premier with the authored plan in place → the snapshot must carry it
runTick(os, oid, { full: (d) => d === 0, navOf });
const myFx = os.fixtures(oid, 1).find(f => f.inputSnapshot && f.home === sched0[0][0].home)!;
const slot = myFx.home === sched0[0][0].home ? 0 : 1;
const planReached = myFx.inputSnapshot!.tactics![slot].defense.read === 1 && myFx.inputSnapshot!.tactics![slot].attack.tempo === 1;
console.log(`  plan→engine : ${mine.tag}'s authored read/aggression in the full-sim snapshot → ${planReached ? 'drives the match ✓' : 'MISSING ✗'}`);

// a bad lineup is rejected; revert returns the club to AI but the plan persists
let badRejected = false; try { savePlan(os, oid, mine.id, { tactics: authored, comp: mine.comp, lineup: [mine.roster[0].id] }); } catch { badRejected = true; }
revert(os, oid, mine.id);
const afterRevert = load(os, oid).clubs.find(c => c.id === mine.id)!;
const planKept = afterRevert.owner === null && afterRevert.tactics.defense.read === 1;
// the always-field-a-competent-five invariant holds for EVERY club post-ops
const allValid = load(os, oid).clubs.every(c => validFive(planFive(c)));
console.log(`  invariants  : bad lineup rejected → ${badRejected ? '✓' : '✗'}; revert → AI keeps plan → ${planKept ? '✓' : '✗'}; every club fields a valid five → ${allValid ? '✓' : '✗'}`);

console.log(`\n  persisted (run A): ${A.store.fixtures(A.id).length} fixtures · ${A.store.ticks(A.id).length} ticks logged\n`);
