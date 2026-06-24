<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import type { MatchInput, Tactics, Team } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import type { Play } from '@ace/shared';
import { simulateMatch, NOCTURNE, MERIDIAN, PATCH, NCT_TACTICS, MRD_TACTICS } from '@ace/engine';
import { Viewer } from './viewer';
import PlayEditor from './PlayEditor.vue';

const MAP = 'ascent';
const ATK_SPAWN: [number, number] = [485, 60];   // Ascent attacker spawn — the default angle defenders watch
const FORKS = 50;                 // fewer than the CLI's 120 — snappier live re-sim
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

// a starter DEFENSE play: one player baits mid, two rotate to A when he dies
// (a "kill point"). The author then drags.
function starterDefense(t: Team): Play {
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  const bait = p3;
  return { plans: [
    { player: p3, pos: [500, 470] },                                         // bait @ mid
    { player: p0, pos: [340, 300], rotate: { pos: [320, 160], trigger: { kind: 'death', player: bait } } },  // rotate A on his death
    { player: p1, pos: [300, 300], rotate: { pos: [296, 165], trigger: { kind: 'death', player: bait } } },
    { player: p2, pos: [310, 150] },                                         // A anchor
    { player: p4, pos: [270, 793] },                                         // B anchor
  ] };
}
// a starter ATTACK execute: four hit A, one lurks mid, with an entry smoke.
function starterAttack(t: Team): Play {
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  return { site: 'A', plans: [
    { player: p0, pos: [310, 170] },                                         // entry onto A
    { player: p1, pos: [345, 210] },
    { player: p2, pos: [305, 256] },
    { player: p3, pos: [420, 330] },                                         // trailer / flex
    { player: p4, pos: [500, 470] },                                         // lurk mid
  ], lineups: [ { player: p2, kind: 'smoke', at: [300, 120], t: 0.25 } ] };  // smoke deep A
}
const starterFor = (t: Team, side: Side): Play => (side === 'attack' ? starterAttack(t) : starterDefense(t));
const playRef = (i: number, side: Side) => side === 'attack' ? tactics[i].attack : tactics[i].defense;

type Side = 'attack' | 'defense';
const host = ref<HTMLElement | null>(null);
const busy = ref(false);
const score = ref<[number, number]>([0, 0]);
const teams: [Team, Team] = [NOCTURNE, MERIDIAN];
const seed = ref(42);
const tactics = reactive<[Tactics, Tactics]>([clone(NCT_TACTICS), clone(MRD_TACTICS)]);
const authoring = ref<{ team: number; side: Side } | null>(null);   // which play is open in the editor
const isOpen = (i: number, side: Side) => authoring.value?.team === i && authoring.value?.side === side;

// open/close the editor for a team's attack OR defense play; seed a starter the first time
function toggleAuthor(i: number, side: Side) {
  if (isOpen(i, side)) { authoring.value = null; return; }
  if (!playRef(i, side).play) playRef(i, side).play = starterFor(teams[i], side);
  authoring.value = { team: i, side };
}
function clearPlay(i: number, side: Side) {
  playRef(i, side).play = undefined;
  if (isOpen(i, side)) authoring.value = null;
  schedule();
}
function onPlay(i: number, side: Side, play: Play) {
  playRef(i, side).play = play;
  schedule();
}

let viewer: Viewer | null = null;
let nav: Navmesh | null = null;
let pending = 0;

function resim() {
  if (!nav || !host.value) return;
  busy.value = true;
  // let the "simulating" state paint before the synchronous sim blocks the thread
  requestAnimationFrame(() => {
    const input: MatchInput = {
      seed: seed.value, map: MAP, teams, patch: PATCH,
      tactics: [clone(tactics[0]), clone(tactics[1])],
    };
    const tl = simulateMatch(input, nav!, FORKS);
    score.value = tl.finalScore;
    viewer?.destroy();
    viewer = new Viewer(host.value!, tl, `/${MAP}.png`, nav as any);
    busy.value = false;
  });
}
// debounce rapid control changes into one re-sim
function schedule() { clearTimeout(pending); pending = window.setTimeout(resim, 120); }

onMounted(async () => {
  nav = await fetch(`/${MAP}.navmesh.json`).then(r => r.json());
  resim();
});
onUnmounted(() => { viewer?.destroy(); clearTimeout(pending); });
</script>

<template>
  <div class="ace-shell">
    <header class="ace-top">
      <div class="logo"><span class="dot"></span>ACE</div>
      <div class="crumb">Tactics Editor · <b>@ace/engine</b> running live in your browser</div>
      <div class="crumb-r" v-if="busy">simulating…</div>
    </header>

    <div class="ace-editor">
      <div class="ed-seed">
        <label>SEED</label>
        <input type="number" v-model.number="seed" @change="schedule" />
        <button @click="seed = Math.floor(Math.random() * 100000); schedule()">⟲ random</button>
        <div class="ed-score">{{ score[0] }} – {{ score[1] }}</div>
      </div>
      <div class="ed-teams">
        <div v-for="i in [0, 1]" :key="i" class="ed-team" :class="i === 0 ? 'att' : 'def'">
          <div class="ed-tag">{{ teams[i].tag }} · {{ teams[i].name }}</div>
          <div class="ed-grid">
            <label>Site bias <span>{{ tactics[i].attack.siteBias.toFixed(2) }}</span></label>
            <input type="range" min="-1" max="1" step="0.05" v-model.number="tactics[i].attack.siteBias" @input="schedule" />
            <label>Tempo <span>{{ tactics[i].attack.tempo.toFixed(2) }}</span></label>
            <input type="range" min="0" max="1" step="0.05" v-model.number="tactics[i].attack.tempo" @input="schedule" />
            <label>Read <span>{{ tactics[i].defense.read.toFixed(2) }}</span></label>
            <input type="range" min="-1" max="1" step="0.05" v-model.number="tactics[i].defense.read" @input="schedule" />
            <label>Aggression <span>{{ tactics[i].defense.aggression.toFixed(2) }}</span></label>
            <input type="range" min="0" max="1" step="0.05" v-model.number="tactics[i].defense.aggression" @input="schedule" />
            <label>Entry</label>
            <select v-model="tactics[i].attack.entry" @change="schedule">
              <option v-for="p in teams[i].players" :key="p.id" :value="p.id">{{ p.handle }}</option>
            </select>
            <label>Lurk</label>
            <select v-model="tactics[i].attack.lurk" @change="schedule">
              <option :value="undefined">— none —</option>
              <option v-for="p in teams[i].players" :key="p.id" :value="p.id">{{ p.handle }}</option>
            </select>
            <label>Plays</label>
            <div class="ed-play">
              <button class="ed-author" :class="{ on: isOpen(i, 'attack'), set: tactics[i].attack.play }" @click="toggleAuthor(i, 'attack')">✎ attack</button>
              <button class="ed-author" :class="{ on: isOpen(i, 'defense'), set: tactics[i].defense.play }" @click="toggleAuthor(i, 'defense')">✎ defense</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="authoring" class="ed-canvas">
        <div class="ed-canvas-head">
          <span class="ed-tag" :class="authoring.team === 0 ? 'att' : 'def'">{{ teams[authoring.team].tag }}</span>
          {{ authoring.side }} play — drag to place · <b>{{ teams[authoring.team].name }}</b> {{ authoring.side === 'attack' ? 'attacking' : 'defending' }}
          <button class="ed-clear" @click="clearPlay(authoring.team, authoring.side)">clear play</button>
          <button class="ed-close" @click="authoring = null">done</button>
        </div>
        <PlayEditor
          :key="`${authoring.team}-${authoring.side}`"
          :team="teams[authoring.team]"
          :map-url="`/${MAP}.png`"
          :side="authoring.team === 0 ? 'att' : 'def'"
          :mode="authoring.side"
          :play="playRef(authoring.team, authoring.side).play!"
          :atk-spawn="ATK_SPAWN"
          :nav="nav!"
          @update="(p) => onPlay(authoring!.team, authoring!.side, p)"
        />
      </div>
    </div>

    <div ref="host" class="ace-host"></div>
  </div>
</template>
