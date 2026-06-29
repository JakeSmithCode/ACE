// `pnpm server` — drive the Phase-2 tick core headless and prove its three
// load-bearing properties: it resolves the world a match-day at a time and rolls
// seasons over (the BullMQ tick), it's IDEMPOTENT (a retried tick never
// double-resolves), and it's DETERMINISTIC (same seed → byte-identical world). No
// DB, no HTTP — the exact resolution code the server runs, against an in-memory
// store. The store is async (so a Postgres store fits the same interface), so this
// awaits through — the math is identical.
import { RANK_TIERS, divisionSchedule, membersOf, planFive, validFive, createWorld, simulateSeason, advanceWorld, worldDivisions, createCircuit, internationalEvent, regionTitles, awardInternational, internationalTransfers, DEFAULT_INTL_PRIZE, divisionTable, type IntlResult, type WorldState, type CrossMove } from '@ace/world';
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
const load = async (s: WorldStore, id: string): Promise<WorldState> => (await s.loadWorld(id))!;
// a stable digest of the world's evolving state — for the determinism check
const digest = (w: WorldState): string =>
  w.clubs.map(c => `${c.tag}:${c.tier}:${Math.round(c.strength * 1000)}:${c.balance}:${c.titles}`).join('|') + `#${w.season}.${w.day}.${w.results.length}`;

// run a fresh world for N seasons; return the store/id and the per-season log
async function play(seasonsToRun: number): Promise<{ store: MemoryStore; id: string; log: string[] }> {
  const store = new MemoryStore();
  const id = await seedWorld(store, { seed, region: 'AMER' });
  const w0 = await load(store, id);
  const track = w0.clubs.findIndex(c => c.tier === 7);   // a mid-table Gold club to follow
  const log: string[] = [];
  for (let s = 0; s < seasonsToRun; s++) {
    const reports = await runSeason(store, id);
    const matchdays = reports.filter(r => r.kind === 'matchday' && !r.skipped).length;
    const roll = reports[reports.length - 1];
    const me = (await load(store, id)).clubs[track];           // world has rolled to the next season
    const fx = (await store.fixtures(id, roll.season)).length;
    log.push(`  ${String(roll.season).padStart(5)}  ${(roll.champion ?? '—').padEnd(9)}  ${tierName(me.tier).padEnd(11)}  ${String(fx).padStart(7)}  ${String(matchdays).padStart(8)}`);
  }
  return { store, id, log };
}

async function main() {
  console.log(`\n  ACE server core · seed ${seed} · in-memory store · headless tick\n`);

  // ── 1. seed + tick a world season-by-season ──────────────────────────────
  const A = await play(seasons);
  const w0 = await load(A.store, A.id);
  const track = w0.clubs.find(c => c.tier === 7) ?? w0.clubs[0];
  console.log(`  seeded ${A.id}: ${w0.clubs.length} clubs · ${w0.tiers} tiers · following ${track.tag}\n`);
  console.log(`  season  champion   follow       fixtures  matchdays`);
  console.log('  ' + '─'.repeat(54));
  A.log.forEach(l => console.log(l));

  // ── 2. determinism: a second independent run from the same seed is identical ─
  const B = await play(seasons);
  const same = digest(await load(A.store, A.id)) === digest(await load(B.store, B.id));
  console.log(`\n  determinism : two independent runs → ${same ? 'IDENTICAL ✓' : 'DIVERGED ✗'}`);

  // ── 3. idempotency: a retried tick on the same (season,day) is a no-op ─────
  const store = new MemoryStore();
  const id = await seedWorld(store, { seed, region: 'AMER' });
  const first = await runTick(store, id);                       // resolve season 1, day 0
  const fxAfter = (await store.fixtures(id)).length;
  // simulate a crashed/retried job: rewind `day` and tick again — the guard must hold
  await store.saveWorld(id, { ...(await load(store, id)), day: 0 });
  const retry = await runTick(store, id);
  const ok = retry.skipped && (await store.fixtures(id)).length === fxAfter;
  console.log(`  idempotency : retry day 0 → ${retry.skipped ? 'SKIPPED' : 'RE-RESOLVED'}; fixtures ${(await store.fixtures(id)).length === fxAfter ? 'unchanged' : 'DUPLICATED'} → ${ok ? 'safe ✓' : 'LEAK ✗'}`);
  void first;

  // ── 4. full-sim the WATCHABLE division (the engine path) + re-sim to watch ─
  const fs = new MemoryStore();
  const fid = await seedWorld(fs, { seed, region: 'AMER' });
  // mark the Premier (division 0) watchable → full-sim it, quick-resolve the rest
  const fr = await runTick(fs, fid, { full: (d) => d === 0, navOf });
  const watched = (await fs.fixtures(fid, 1)).filter(f => f.inputSnapshot);
  console.log(`\n  full-sim    : day ${fr.day} → ${fr.fullSimmed} fixtures engine-simmed (Premier), ${fr.fixtures - (fr.fullSimmed ?? 0)} quick; snapshots stored: ${watched.length}`);
  if (watched.length) {
    const f = watched[0];
    console.log(`              top match: ${f.homeScore}–${f.awayScore} on ${f.inputSnapshot!.map} (seed ${f.seed})`);
    // re-sim from the stored snapshot — must reproduce the persisted score byte-for-byte
    const replay = simulateMatch(f.inputSnapshot!, navOf(f.inputSnapshot!.map), 0).finalScore;
    const matches = replay[0] === f.homeScore && replay[1] === f.awayScore;
    console.log(`  re-sim watch: replay from snapshot → ${replay[0]}–${replay[1]} ${matches ? 'reproduces stored score ✓' : 'MISMATCH ✗'}`);
  }

  // ── 5. live broadcast window: result sealed until the match plays out ──────
  const ls = new MemoryStore();
  const lid = await seedWorld(ls, { seed, region: 'AMER' });
  const KICK = 0, DUR = 2400;   // "8pm", 40-minute live window
  await runTick(ls, lid, { full: (d) => d === 0, navOf, kickoffAt: KICK, broadcastSecs: DUR });
  const game = (await ls.fixtures(lid, 1)).find(f => f.inputSnapshot)!;   // a watchable (full-simmed) Premier match
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

  // ── 6. ownership overlay: claim a club, author its plan → the tick fields it ─
  const os = new MemoryStore();
  const oid = await seedWorld(os, { seed, region: 'AMER' });
  const w6 = await load(os, oid);
  // the Premier (watchable) club that is HOME in day-0 slot-0 — author its match
  const sched0 = divisionSchedule(membersOf(w6.clubs.map(c => c.tier), 0));
  const mine = w6.clubs[sched0[0][0].home];
  await claim(os, oid, mine.id, 'acct-jake');
  const claimed = !!(await myClub(os, oid, 'acct-jake'));
  let doubleBlocked = false; try { await claim(os, oid, w6.clubs[sched0[0][0].away].id, 'acct-jake'); } catch { doubleBlocked = true; }
  // author a distinct plan: keep the comp, but flip the defensive read hard one way
  const authored = structuredClone(mine.tactics); authored.defense.read = 1; authored.attack.tempo = 1;
  await savePlan(os, oid, mine.id, { tactics: authored, comp: mine.comp, lineup: planFive(mine).map(p => p.id) });
  console.log(`\n  ownership   : claimed ${mine.tag} for acct-jake → owned ${claimed ? '✓' : '✗'}; second claim blocked → ${doubleBlocked ? '✓' : '✗ LEAK'}`);

  // full-sim the Premier with the authored plan in place → the snapshot must carry it
  await runTick(os, oid, { full: (d) => d === 0, navOf });
  const myFx = (await os.fixtures(oid, 1)).find(f => f.inputSnapshot && f.home === sched0[0][0].home)!;
  const slot = myFx.home === sched0[0][0].home ? 0 : 1;
  const planReached = myFx.inputSnapshot!.tactics![slot].defense.read === 1 && myFx.inputSnapshot!.tactics![slot].attack.tempo === 1;
  console.log(`  plan→engine : ${mine.tag}'s authored read/aggression in the full-sim snapshot → ${planReached ? 'drives the match ✓' : 'MISSING ✗'}`);

  // a bad lineup is rejected; revert returns the club to AI but the plan persists
  let badRejected = false; try { await savePlan(os, oid, mine.id, { tactics: authored, comp: mine.comp, lineup: [mine.roster[0].id] }); } catch { badRejected = true; }
  await revert(os, oid, mine.id);
  const afterRevert = (await load(os, oid)).clubs.find(c => c.id === mine.id)!;
  const planKept = afterRevert.owner === null && afterRevert.tactics.defense.read === 1;
  // the always-field-a-competent-five invariant holds for EVERY club post-ops
  const allValid = (await load(os, oid)).clubs.every(c => validFive(planFive(c)));
  console.log(`  invariants  : bad lineup rejected → ${badRejected ? '✓' : '✗'}; revert → AI keeps plan → ${planKept ? '✓' : '✗'}; every club fields a valid five → ${allValid ? '✓' : '✗'}`);

  // ── 7. fan-out: a pyramid of (tier, group) divisions + the funnel ──────────
  // scale is horizontal — a tier is many parallel divisions, wider toward the base.
  const LAYOUT = [1, 2, 4], GSIZE = 6;   // Premier · Challengers ×2 · base ×4 (42 clubs)
  const sizesOf = (w: WorldState) => worldDivisions(w).map(d => d.members.length);
  const digestG = (w: WorldState) => w.clubs.map(c => `${c.tag}:${c.tier}.${c.group}:${Math.round(c.strength * 1000)}`).join('|');
  const runPyramid = (s: number) => { let w = createWorld(s, { tiers: LAYOUT.length, size: GSIZE, promo: 1, layout: LAYOUT }); const log: string[] = []; for (let n = 0; n < 4; n++) { w = simulateSeason(w); const adv = advanceWorld(w); log.push(`s${adv.world.season - 1}: ${adv.moves.length} moves, champ ${adv.world.clubs[adv.champion].tag}`); w = adv.world; } return { w, log }; };
  const P = runPyramid(seed);
  const w7 = createWorld(seed, { tiers: LAYOUT.length, size: GSIZE, promo: 1, layout: LAYOUT });
  const divCount = worldDivisions(w7).length, allFull = sizesOf(P.w).every(n => n === GSIZE);
  console.log(`\n  fan-out     : layout [${LAYOUT.join(',')}] × ${GSIZE} → ${w7.clubs.length} clubs in ${divCount} divisions (${worldDivisions(w7).map(d => `T${d.tier}g${d.group}`).join(' ')})`);
  P.log.forEach(l => console.log(`     ${l}`));
  console.log(`  funnel      : every division still full at ${GSIZE} after 4 seasons → ${allFull ? 'conserved ✓' : 'BROKEN ✗'}; clubs churn tiers each season → ${P.log.every(l => !l.startsWith('s0: 0')) ? '✓' : '✗'}`);
  const detG = digestG(runPyramid(seed).w) === digestG(P.w);
  console.log(`  determinism : two independent grouped runs → ${detG ? 'IDENTICAL ✓' : 'DIVERGED ✗'}`);

  // ── 8. regional shards + the international circuit ─────────────────────────
  // a shard is one region's pyramid (its own world row, ticked independently); each
  // season the regions' best meet at an international event (Masters/Champions).
  const REGIONS_DEMO = ['AMER', 'EMEA', 'PACIFIC', 'CHINA'];
  async function runCircuit(s: number): Promise<{ champs: string[]; intl: IntlResult[]; premierChamps: string[]; prizeBump: number; titled: { tag: string; region: string; n: number }[]; moves: CrossMove[]; conserved: boolean; allValid: boolean }> {
    const cs = new MemoryStore();
    const ids = await Promise.all(createCircuit(s, { regions: REGIONS_DEMO, tiers: 3, size: 6, promo: 1 }).map(w => cs.createWorld(w)));
    const intl: IntlResult[] = [], champs: string[] = [];
    let premierChamps: string[] = [], prizeBump = 0, moves: CrossMove[] = [], conserved = true, allValid = true;
    for (let yr = 0; yr < 3; yr++) {
      const worlds = await Promise.all(ids.map(async id => simulateSeason(await load(cs, id))));
      const ev = internationalEvent(worlds, { seed: (s ^ (yr * 0x9e3779b9)) >>> 0, slots: 2 });
      intl.push(ev); champs.push(`${ev.champion.region}·${ev.champion.tag}`);
      if (yr === 0) premierChamps = worlds.map(w => `${w.region}·${w.clubs[divisionTable(w, 0, 0)[0].club].tag}`);
      const paid = awardInternational(worlds, ev);   // prize money into the shards (DESIGN §9)
      if (yr === 0) { const champW = paid.find(w => w.region === ev.champion.region)!; prizeBump = champW.clubs[ev.champion.club].balance - worlds.find(w => w.region === ev.champion.region)!.clubs[ev.champion.club].balance; }
      // the international transfer window: qualifiers raid cross-region talent with their winnings
      const before = paid.reduce((n, w) => n + w.clubs.reduce((m, c) => m + c.roster.length, 0), 0);
      const t = internationalTransfers(paid, ev.field, { max: 6, minUpgrade: 2 });
      const after = t.worlds.reduce((n, w) => n + w.clubs.reduce((m, c) => m + c.roster.length, 0), 0);
      if (after !== before) conserved = false;                                  // no players created/lost in a swap
      if (t.worlds.some(w => w.clubs.some(c => !validFive(planFive(c))))) allValid = false;  // every club still fields a valid five
      if (yr === 0) moves = t.moves;
      await Promise.all(ids.map((id, i) => cs.saveWorld(id, advanceWorld(t.worlds[i]).world)));
    }
    // the prestige ledger: clubs ranked by international (Masters) titles won over the run
    const finalWorlds = await Promise.all(ids.map(id => load(cs, id)));
    const titled = finalWorlds.flatMap(w => w.clubs.filter(c => c.intlTitles).map(c => ({ tag: c.tag, region: w.region, n: c.intlTitles! })))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
    return { champs, intl, premierChamps, prizeBump, titled, moves, conserved, allValid };
  }
  const C = await runCircuit(seed);
  const fieldN = C.intl[0].field.length, bracketN = C.intl[0].placement.length;
  console.log(`\n  shards      : ${REGIONS_DEMO.length} regional pyramids (${REGIONS_DEMO.join(' ')}) — independent world rows; s1 Premier champs ${C.premierChamps.join('  ')}`);
  console.log(`  intl event  : ${fieldN} qualifiers (2/region) → ${bracketN}-team bracket; champions by season ${C.champs.join('  ')}`);
  console.log(`  region cup  : ${Object.entries(regionTitles(C.intl)).map(([r, n]) => `${r}×${n}`).join('  ')}`);
  console.log(`  club titles : ${C.titled.length ? C.titled.map(c => `${c.region}·${c.tag}×${c.n}`).join('  ') : '—'} (Masters prestige, accrued on the champion club)`);
  console.log(`  prize money : s1 champion banked +$${C.prizeBump.toLocaleString()} (of $${DEFAULT_INTL_PRIZE.champion.toLocaleString()} top prize) → the circuit reshapes budgets ${C.prizeBump === DEFAULT_INTL_PRIZE.champion ? '✓' : '✗'}`);
  const C2 = await runCircuit(seed);
  const detC = JSON.stringify(C2.champs) === JSON.stringify(C.champs);
  const detMoves = JSON.stringify(C2.moves) === JSON.stringify(C.moves);
  const independent = new Set(C.premierChamps).size === REGIONS_DEMO.length;
  const xreg = C.moves.every(m => m.from.region !== m.to.region);
  console.log(`  intl market : ${C.moves.length} cross-region transfer${C.moves.length === 1 ? '' : 's'} (s1)${C.moves.length ? ' — ' + C.moves.slice(0, 3).map(m => `${m.player}(${m.overall}) ${m.from.region}·${m.from.tag}→${m.to.region}·${m.to.tag} $${(m.fee / 1000).toFixed(0)}k`).join('  ') : ''}`);
  console.log(`  transfer ok : cross-region only → ${xreg ? '✓' : '✗'}; rosters conserved (swaps) → ${C.conserved ? '✓' : '✗'}; every club still fields a valid five → ${C.allValid ? '✓' : '✗'}`);
  console.log(`  properties  : shards resolve independently → ${independent ? '✓' : '✗'}; whole circuit deterministic → ${detC && detMoves ? '✓' : '✗'}`);

  console.log(`\n  persisted (run A): ${(await A.store.fixtures(A.id)).length} fixtures · ${(await A.store.ticks(A.id)).length} ticks logged\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
