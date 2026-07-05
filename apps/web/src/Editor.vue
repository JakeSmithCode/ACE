<script setup lang="ts">
// Tactics Editor — grounded in YOUR club, one PLAYBOOK PER MAP. Team 0 is your
// squad: its dials write to the store (myTactics, map-agnostic) and its authored
// plays write to the PER-MAP playbook (myPlays[map]) — with the 8-map rotation,
// the fixture map's plays are what your club actually fields, so you author a
// setup for every pool map you care about. Team 1 is your next opponent, edited
// locally for testing. Re-sims live in the browser on the selected map.
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue';
import type { MapId, MatchInput, MatchTimeline, Tactics, Team, Play, Vec2 } from '@ace/shared';
import { simulateMatch, PATCH } from '@ace/engine';
import { ANCHORS, type Navmesh } from '@ace/maps';
import { Viewer } from './viewer';
import PlayEditor from './PlayEditor.vue';
import { useWorld, MAP, MAP_POOL } from './world';

const FORKS = 50;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const w = useWorld();
// the selected map drives everything: anchors (spawn + the sites it fields),
// navmesh, minimap, and WHICH playbook slot you're authoring into.
const mapSel = ref<MapId>(MAP);
const A0 = computed(() => ANCHORS[mapSel.value]!);
const ATK_SPAWN = computed(() => A0.value.atkSpawn);
const SITES = computed(() => A0.value.sites);
function pickMap(m: MapId) { mapSel.value = m; authoring.value = null; bump.n++; schedule(); }

// captured on mount (the editor remounts when you switch to this tab)
const teams: [Team, Team] = [w.myTeam.value, w.clubs.value[w.nextOpponent.value].team];
const oppTactics = reactive<Tactics>(clone(w.clubs.value[w.nextOpponent.value].tactics));
const tac = (i: number): Tactics => (i === 0 ? w.myTactics.value : oppTactics);

// ── generic starters, derived from the selected map's anchors (positions are
// snapped to the nearest walkable cell, so they're sane on any pool map) ──────
const walkableAt = (nav: Navmesh, p: Vec2) => {
  const c = Math.floor(p[0] / nav.cell), r = Math.floor(p[1] / nav.cell);
  return c >= 0 && c < nav.cols && r >= 0 && r < nav.rows && nav.walk[r * nav.cols + c] === 1;
};
function snapW(p: Vec2): Vec2 {
  const nav = w.getNav(mapSel.value);
  const cl = (v: number) => Math.max(8, Math.min(992, Math.round(v)));
  const q: Vec2 = [cl(p[0]), cl(p[1])];
  if (!nav || walkableAt(nav, q)) return q;
  for (let R = 8; R <= 120; R += 8) for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const c: Vec2 = [cl(q[0] + Math.cos(a) * R), cl(q[1] + Math.sin(a) * R)];
    if (walkableAt(nav, c)) return c;
  }
  return q;
}
function starterDefense(t: Team): Play {
  const A = A0.value;
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  const off = (b: Vec2, dx: number, dy: number): Vec2 => snapW([b[0] + dx, b[1] + dy]);
  // the classic shape: a mid bait, two A bodies that collapse deeper when he
  // falls (the kill point), an A anchor, a B watcher — then you tune.
  return { plans: [
    { player: p3, pos: snapW([A.mid[0], A.mid[1]]) },
    { player: p0, pos: off(A.sites.A, 40, 55), rotate: { pos: off(A.sites.A, 15, -40), trigger: { kind: 'death', player: p3 } } },
    { player: p1, pos: off(A.sites.A, -45, 40), rotate: { pos: off(A.sites.A, -20, -40), trigger: { kind: 'death', player: p3 } } },
    { player: p2, pos: snapW([A.sites.A[0], A.sites.A[1]]) },
    { player: p4, pos: snapW([A.sites.B[0], A.sites.B[1]]) },
  ] };
}
function starterAttack(t: Team): Play {
  const A = A0.value;
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  const pA = A.sites.A;
  const L = Math.hypot(pA[0] - A.atkSpawn[0], pA[1] - A.atkSpawn[1]) || 1;
  const d: Vec2 = [(pA[0] - A.atkSpawn[0]) / L, (pA[1] - A.atkSpawn[1]) / L];   // push axis
  const px = -d[1], py = d[0];                                                  // entry fan
  const at = (back: number, side: number): Vec2 => snapW([pA[0] - d[0] * back + px * side, pA[1] - d[1] * back + py * side]);
  return { site: 'A', plans: [
    { player: p0, pos: at(20, -45) }, { player: p1, pos: at(10, 10) }, { player: p2, pos: at(30, 60) },
    { player: p3, pos: at(95, -20) },
    { player: p4, pos: snapW([(pA[0] + A.mid[0]) / 2, (pA[1] + A.mid[1]) / 2]) },
  ], lineups: [ { player: p2, kind: 'smoke', at: snapW([pA[0] + d[0] * 70, pA[1] + d[1] * 70]), t: 0.25 } ] };
}
const starterFor = (t: Team, side: Side): Play => (side === 'attack' ? starterAttack(t) : starterDefense(t));
// a play slot: defense, the primary attack execute, or the ALT execute (play2 —
// two executes on different sites make the engine ROLL the site per round).
// YOUR club's plays live in the PER-MAP playbook; the opponent's live locally.
type Slot = 'attack' | 'attack2' | 'defense';
const slotOf = (side: Side, alt: boolean): Slot => side === 'attack' ? (alt ? 'attack2' : 'attack') : 'defense';
const playOf = (i: number, side: Side, alt = false): Play | undefined => {
  if (i === 0) return w.myPlays.value[mapSel.value]?.[slotOf(side, alt)];
  return side === 'attack' ? (alt ? oppTactics.attack.play2 : oppTactics.attack.play) : oppTactics.defense.play;
};
function setPlayVal(i: number, side: Side, alt: boolean, p: Play | undefined) {
  if (i === 0) { w.setMapPlay(mapSel.value, slotOf(side, alt), p); return; }
  if (side === 'attack') { if (alt) oppTactics.attack.play2 = p; else oppTactics.attack.play = p; }
  else oppTactics.defense.play = p;
}
// the alt starter TRANSPLANTS the primary execute to the next site (translate by
// the site delta, flip the site) — a rough starting template the owner then tunes
function altStarter(i: number): Play {
  const p1 = playOf(i, 'attack')!;
  const sites = SITES.value;
  const list = (['A', 'B', 'C'] as const).filter(s => sites[s]);
  const s1 = (p1.site ?? 'A') as typeof list[number];
  const s2 = list[(list.indexOf(s1) + 1) % list.length];
  const d = [sites[s2]![0] - sites[s1]![0], sites[s2]![1] - sites[s1]![1]];
  const cl = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  const sh = (pt: [number, number]): [number, number] => [cl(pt[0] + d[0]), cl(pt[1] + d[1])];
  const c: Play = clone(p1);
  c.site = s2;
  for (const pl of c.plans) {
    pl.pos = sh(pl.pos);
    if (pl.face) pl.face = sh(pl.face);
    if (pl.route) pl.route = pl.route.map(sh);
    let st = pl.rotate;
    while (st) { st.pos = sh(st.pos); if (st.route) st.route = st.route.map(sh); st = st.then; }
  }
  for (const ln of c.lineups ?? []) { ln.at = sh(ln.at); if (ln.at2) ln.at2 = sh(ln.at2); }
  return c;
}

type Side = 'attack' | 'defense';
const host = ref<HTMLElement | null>(null);
const busy = ref(false);
const score = ref<[number, number]>([0, 0]);
// the authored setup's MEASURED strength: your True Odds aggregated over the
// re-simmed match's rounds (attacker winPct when you attack, 1−winPct when you
// defend) — ~50 counterfactual re-runs per round, so the number moves honestly
// as you drag holds around. This is the x-ray thesis as an authoring instrument.
const odds = ref<{ atk: number | null; def: number | null }>({ atk: null, def: null });
// the same odds SPLIT BY SITE — "DEF 48%" can hide a strong A and a folding B;
// the per-site read is what tells you WHICH half of the setup to fix
const siteOdds = ref<{ site: string; atk: number | null; def: number | null }[]>([]);
const seed = ref(42);
// re-render the dials when the underlying tactics objects change (e.g. play edits)
const bump = reactive({ n: 0 });
const authoring = ref<{ team: number; side: Side; alt?: boolean } | null>(null);
const isOpen = (i: number, side: Side, alt = false) =>
  authoring.value?.team === i && authoring.value?.side === side && !!authoring.value?.alt === alt;

// --- the OPPONENT-GHOST overlay: where the enemy ACTUALLY set up, aggregated
// from the re-simmed rounds you're authoring against — the engine's real
// placements (their read stack, their execute fan), never a hand-mirrored guess.
// Attack authoring shows the enemy DEFENSE's setup spots (round `spawns` — the
// holds they take before contact); defense authoring shows the enemy ATTACK's
// arrival points (each move's leg-0 path end — the execute fan spot). Nearby
// occurrences cluster into one stronger ghost, so a stack reads as a stack.
const lastTl = shallowRef<MatchTimeline | null>(null);
const ghosts = ref<{ pos: [number, number]; n: number }[]>([]);
function refreshGhosts() {
  const tl = lastTl.value, a = authoring.value;
  if (!tl || !a) { ghosts.value = []; return; }
  const enemy = new Set(tl.teams[1 - a.team].players.map(p => p.handle));
  const pts: [number, number][] = [];
  for (const r of tl.rounds) {
    if ((r.attacker === a.team) !== (a.side === 'attack')) continue;
    if (a.side === 'attack') { for (const h of enemy) { const s = r.spawns[h]; if (s) pts.push([s[0], s[1]]); } }
    else for (const e of r.events) if (e.kind === 'move' && enemy.has(e.agent)) { const p = e.path[e.path.length - 1]; pts.push([p[0], p[1]]); }
  }
  const G = 34;   // cluster grid (image units) — repeated setups merge into one ghost
  const cells = new Map<string, { x: number; y: number; n: number }>();
  for (const p of pts) {
    const k = `${Math.round(p[0] / G)}:${Math.round(p[1] / G)}`;
    const c = cells.get(k);
    if (c) { c.x += p[0]; c.y += p[1]; c.n++; } else cells.set(k, { x: p[0], y: p[1], n: 1 });
  }
  ghosts.value = [...cells.values()].map(c => ({ pos: [c.x / c.n, c.y / c.n] as [number, number], n: c.n }))
    .sort((q, z) => z.n - q.n).slice(0, 30);
}

function toggleAuthor(i: number, side: Side) {
  if (isOpen(i, side)) { authoring.value = null; return; }
  if (!playOf(i, side)) { setPlayVal(i, side, false, starterFor(teams[i], side)); schedule(); }
  authoring.value = { team: i, side };
  refreshGhosts();
}
function toggleAuthorAlt(i: number) {
  if (isOpen(i, 'attack', true)) { authoring.value = null; return; }
  if (!playOf(i, 'attack', true)) { setPlayVal(i, 'attack', true, altStarter(i)); schedule(); }
  authoring.value = { team: i, side: 'attack', alt: true };
  refreshGhosts();
}
function clearPlay(i: number, side: Side, alt = false) {
  setPlayVal(i, side, alt, undefined);
  if (isOpen(i, side, alt)) authoring.value = null;
  schedule();
}
function onPlay(i: number, side: Side, alt: boolean, play: Play) { setPlayVal(i, side, alt, play); bump.n++; schedule(); }
// both executes on ONE site can't mix — the engine forces the primary's site then
const sameSiteWarn = (i: number) =>
  !!(playOf(i, 'attack')?.site && playOf(i, 'attack', true)?.site && playOf(i, 'attack')!.site === playOf(i, 'attack', true)!.site);

let viewer: Viewer | null = null;
let pending = 0;
// team 0's engine tactics = the map-agnostic dials + the SELECTED MAP's playbook
// (exactly what buildInput fields for a real fixture on this map)
function tacticsFor(i: number): Tactics {
  const t = clone(tac(i));
  if (i === 0) {
    const pb = w.myPlays.value[mapSel.value];
    t.attack.play = pb?.attack ? clone(pb.attack) : undefined;
    t.attack.play2 = pb?.attack2 ? clone(pb.attack2) : undefined;
    t.defense.play = pb?.defense ? clone(pb.defense) : undefined;
  }
  return t;
}
function resim() {
  const nav = w.getNav(mapSel.value);
  if (!nav || !host.value) return;
  busy.value = true;
  requestAnimationFrame(() => {
    const input: MatchInput = {
      seed: seed.value, map: mapSel.value, teams, patch: PATCH,
      tactics: [tacticsFor(0), tacticsFor(1)],
      comp: [clone(w.myComp.value), {}],
    };
    const tl = simulateMatch(input, nav, FORKS);
    score.value = tl.finalScore;
    lastTl.value = tl;
    refreshGhosts();
    let aSum = 0, aN = 0, dSum = 0, dN = 0;
    const per: Record<string, { a: number; an: number; d: number; dn: number }> = {};
    for (const r of tl.rounds) {
      if (r.winPct == null) continue;
      const b = (per[r.site] ??= { a: 0, an: 0, d: 0, dn: 0 });
      if (r.attacker === 0) { aSum += r.winPct; aN++; b.a += r.winPct; b.an++; }
      else { dSum += 1 - r.winPct; dN++; b.d += 1 - r.winPct; b.dn++; }
    }
    odds.value = { atk: aN ? aSum / aN : null, def: dN ? dSum / dN : null };
    siteOdds.value = Object.keys(per).sort().map(k => ({
      site: k, atk: per[k].an ? per[k].a / per[k].an : null, def: per[k].dn ? per[k].d / per[k].dn : null,
    }));
    viewer?.destroy();
    // the preview mutes broadcast audio by default (a re-sim per edit would chirp
    // constantly); the 🔊 toggle still turns it on for a proper watch-through
    viewer = new Viewer(host.value!, tl, `/${mapSel.value}.png`, nav as any, { sfx: false });
    busy.value = false;
  });
}
function schedule() { clearTimeout(pending); pending = window.setTimeout(resim, 120); }

// tactical presets (a playbook) — save the current setup, load one back, all on team 0
const presetName = ref('');
function savePreset() { w.saveTacticPreset(presetName.value); presetName.value = ''; }
function loadPreset(i: number) { w.loadTacticPreset(i); bump.n++; schedule(); }
function delPreset(i: number) { w.deleteTacticPreset(i); }

onMounted(async () => { await w.ensureNav(); resim(); });
onUnmounted(() => { viewer?.destroy(); clearTimeout(pending); });
</script>

<template>
  <div class="ace-editor">
    <div class="ed-seed">
      <label>SEED</label>
      <input type="number" v-model.number="seed" @change="schedule" />
      <button @click="seed = Math.floor(Math.random() * 100000); schedule()">⟲ random</button>
      <div class="ed-score">{{ score[0] }} – {{ score[1] }}<span class="ed-busy" v-if="busy">simulating…</span></div>
      <div class="ed-odds" v-if="odds.atk != null || odds.def != null"
           title="your True Odds under this exact setup, averaged over the match's rounds (50× counterfactual re-runs each) — edit a hold and watch it move">
        <span class="ed-odd atk" v-if="odds.atk != null">ATK {{ Math.round(odds.atk * 100) }}%</span>
        <span class="ed-odd def" v-if="odds.def != null">DEF {{ Math.round(odds.def * 100) }}%</span>
        <span class="ed-sodd" v-for="so in siteOdds" :key="so.site"
              :title="`your True Odds on ${so.site}-site rounds — which half of the setup needs work`">
          {{ so.site }}<i v-if="so.atk != null" class="a">⚔{{ Math.round(so.atk * 100) }}</i><i v-if="so.def != null" class="d">🛡{{ Math.round(so.def * 100) }}</i>
        </span>
      </div>
    </div>
    <div class="ed-maps">
      <label>MAP</label>
      <button v-for="m in MAP_POOL" :key="m" class="ed-map" :class="{ on: mapSel === m, has: !!w.myPlays.value[m] }"
              :title="w.myPlays.value[m] ? `you have authored plays on ${m}` : `no plays authored on ${m} yet — your dials still apply there`"
              @click="pickMap(m)">{{ m }}<i v-if="w.myPlays.value[m]" class="ed-mapdot">●</i></button>
      <span class="ed-maphint">plays are authored PER MAP — when a fixture lands on a map, your club fields THAT map's playbook</span>
    </div>
    <div class="ed-presets">
      <label>PLAYBOOK</label>
      <span v-for="(pr, i) in w.tacticPresets.value" :key="i" class="ed-preset">
        <button class="ed-preload" @click="loadPreset(i)" :title="`load &quot;${pr.name}&quot; onto your club`">{{ pr.name }}</button>
        <button class="ed-predel" @click="delPreset(i)" title="delete">✕</button>
      </span>
      <span v-if="!w.tacticPresets.value.length" class="ed-prehint">save your tactical setups to swap them in a click</span>
      <input class="ed-prename" v-model="presetName" placeholder="name…" maxlength="18" @keyup.enter="savePreset" />
      <button class="ed-presave" @click="savePreset">＋ save current</button>
    </div>
    <div class="ed-teams" :data-bump="bump.n">
      <div v-for="i in [0, 1]" :key="i" class="ed-team" :class="i === 0 ? 'att' : 'def'">
        <div class="ed-tag">{{ teams[i].tag }} · {{ teams[i].name }}<i v-if="i === 0" class="ed-mine">YOUR CLUB</i><i v-else class="ed-opp">NEXT OPPONENT</i></div>
        <div class="ed-grid">
          <label>Site bias <span>{{ tac(i).attack.siteBias.toFixed(2) }}</span></label>
          <input type="range" min="-1" max="1" step="0.05" v-model.number="tac(i).attack.siteBias" @input="schedule" />
          <label>Tempo <span>{{ tac(i).attack.tempo.toFixed(2) }}</span></label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="tac(i).attack.tempo" @input="schedule" />
          <label>Read <span>{{ tac(i).defense.read.toFixed(2) }}</span></label>
          <input type="range" min="-1" max="1" step="0.05" v-model.number="tac(i).defense.read" @input="schedule" />
          <label>Aggression <span>{{ tac(i).defense.aggression.toFixed(2) }}</span></label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="tac(i).defense.aggression" @input="schedule" />
          <label>Entry</label>
          <select v-model="tac(i).attack.entry" @change="schedule">
            <option v-for="p in teams[i].players" :key="p.id" :value="p.id">{{ p.handle }}</option>
          </select>
          <label>Lurk</label>
          <select v-model="tac(i).attack.lurk" @change="schedule">
            <option :value="undefined">— none —</option>
            <option v-for="p in teams[i].players" :key="p.id" :value="p.id">{{ p.handle }}</option>
          </select>
          <label>Plays</label>
          <div class="ed-play">
            <button class="ed-author" :class="{ on: isOpen(i, 'attack'), set: playOf(i, 'attack') }" @click="toggleAuthor(i, 'attack')">✎ attack</button>
            <button v-if="playOf(i, 'attack')" class="ed-author edalt" :class="{ on: isOpen(i, 'attack', true), set: playOf(i, 'attack', true) }"
                    @click="toggleAuthorAlt(i)"
                    title="a SECOND execute on the other site — with two authored executes the engine rolls the site each round (your site bias) and runs the matching play, so your attack isn't a tell">⑂ alt</button>
            <button class="ed-author" :class="{ on: isOpen(i, 'defense'), set: playOf(i, 'defense') }" @click="toggleAuthor(i, 'defense')">✎ defense</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="authoring" class="ed-canvas">
      <div class="ed-canvas-head">
        <span class="ed-tag" :class="authoring.team === 0 ? 'att' : 'def'">{{ teams[authoring.team].tag }}</span>
        {{ authoring.side }}{{ authoring.alt ? ' (alt exec)' : '' }} play on <b class="ed-mapname">{{ mapSel }}</b> — drag to place · <b>{{ teams[authoring.team].name }}</b> {{ authoring.side === 'attack' ? 'attacking' : 'defending' }}
        <span v-if="authoring.side === 'attack' && sameSiteWarn(authoring.team)" class="ed-samesite"
              title="the per-round site roll needs the two executes on different sites — pick another site for one of them">⚠ both executes target the same site — the roll needs two</span>
        <button class="ed-clear" @click="clearPlay(authoring.team, authoring.side, authoring.alt)">clear play</button>
        <button class="ed-close" @click="authoring = null">done</button>
      </div>
      <PlayEditor
        :key="`${mapSel}-${authoring.team}-${authoring.side}-${authoring.alt ? 'alt' : 'main'}`"
        :team="teams[authoring.team]"
        :map-url="`/${mapSel}.png`"
        :side="authoring.team === 0 ? 'att' : 'def'"
        :mode="authoring.side"
        :play="playOf(authoring.team, authoring.side, authoring.alt)!"
        :atk-spawn="ATK_SPAWN"
        :sites="SITES"
        :nav="w.getNav(mapSel)!"
        :ghosts="ghosts"
        @update="(p) => onPlay(authoring!.team, authoring!.side, !!authoring!.alt, p)"
      />
    </div>
  </div>

  <div ref="host" class="ace-host"></div>
</template>
