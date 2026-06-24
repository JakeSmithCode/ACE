<script setup lang="ts">
// Tactics Editor — now grounded in YOUR club. Team 0 is your squad and its dials
// + authored plays write straight back to the world store (myTactics), so what
// you tune here is what your club runs in its real fixtures. Team 1 is your next
// opponent, editable locally for testing (those edits don't persist). Re-sims
// live in the browser, your comp included.
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import type { MatchInput, Tactics, Team, Play } from '@ace/shared';
import { simulateMatch, PATCH } from '@ace/engine';
import { Viewer } from './viewer';
import PlayEditor from './PlayEditor.vue';
import { useWorld, MAP } from './world';

const ATK_SPAWN: [number, number] = [485, 60];
const SITES: { A: [number, number]; B: [number, number] } = { A: [310, 150], B: [270, 793] };
const FORKS = 50;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const w = useWorld();
// captured on mount (the editor remounts when you switch to this tab)
const teams: [Team, Team] = [w.myTeam.value, w.clubs.value[w.nextOpponent.value].team];
const oppTactics = reactive<Tactics>(clone(w.clubs.value[w.nextOpponent.value].tactics));
const tac = (i: number): Tactics => (i === 0 ? w.myTactics.value : oppTactics);

function starterDefense(t: Team): Play {
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  const bait = p3;
  return { plans: [
    { player: p3, pos: [500, 470] },
    { player: p0, pos: [340, 300], rotate: { pos: [320, 160], trigger: { kind: 'death', player: bait } } },
    { player: p1, pos: [300, 300], rotate: { pos: [296, 165], trigger: { kind: 'death', player: bait } } },
    { player: p2, pos: [310, 150] },
    { player: p4, pos: [270, 793] },
  ] };
}
function starterAttack(t: Team): Play {
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  return { site: 'A', plans: [
    { player: p0, pos: [310, 170] }, { player: p1, pos: [345, 210] }, { player: p2, pos: [305, 256] },
    { player: p3, pos: [420, 330] }, { player: p4, pos: [500, 470] },
  ], lineups: [ { player: p2, kind: 'smoke', at: [300, 120], t: 0.25 } ] };
}
const starterFor = (t: Team, side: Side): Play => (side === 'attack' ? starterAttack(t) : starterDefense(t));
const playRef = (i: number, side: Side) => side === 'attack' ? tac(i).attack : tac(i).defense;

type Side = 'attack' | 'defense';
const host = ref<HTMLElement | null>(null);
const busy = ref(false);
const score = ref<[number, number]>([0, 0]);
const seed = ref(42);
// re-render the dials when the underlying tactics objects change (e.g. play edits)
const bump = reactive({ n: 0 });
const authoring = ref<{ team: number; side: Side } | null>(null);
const isOpen = (i: number, side: Side) => authoring.value?.team === i && authoring.value?.side === side;

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
function onPlay(i: number, side: Side, play: Play) { playRef(i, side).play = play; bump.n++; schedule(); }

let viewer: Viewer | null = null;
let pending = 0;
function resim() {
  const nav = w.getNav();
  if (!nav || !host.value) return;
  busy.value = true;
  requestAnimationFrame(() => {
    const input: MatchInput = {
      seed: seed.value, map: MAP, teams, patch: PATCH,
      tactics: [clone(tac(0)), clone(tac(1))],
      comp: [clone(w.myComp.value), {}],
    };
    const tl = simulateMatch(input, nav, FORKS);
    score.value = tl.finalScore;
    viewer?.destroy();
    viewer = new Viewer(host.value!, tl, `/${MAP}.png`, nav as any);
    busy.value = false;
  });
}
function schedule() { clearTimeout(pending); pending = window.setTimeout(resim, 120); }

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
            <button class="ed-author" :class="{ on: isOpen(i, 'attack'), set: tac(i).attack.play }" @click="toggleAuthor(i, 'attack')">✎ attack</button>
            <button class="ed-author" :class="{ on: isOpen(i, 'defense'), set: tac(i).defense.play }" @click="toggleAuthor(i, 'defense')">✎ defense</button>
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
        :sites="SITES"
        :nav="w.getNav()!"
        @update="(p) => onPlay(authoring!.team, authoring!.side, p)"
      />
    </div>
  </div>

  <div ref="host" class="ace-host"></div>
</template>
