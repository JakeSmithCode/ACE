<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import type { MatchInput, Tactics, Team } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import type { Play } from '@ace/shared';
import { simulateMatch, NOCTURNE, MERIDIAN, PATCH, NCT_TACTICS, MRD_TACTICS } from '@ace/engine';
import { Viewer } from './viewer';

const MAP = 'ascent';
const FORKS = 50;                 // fewer than the CLI's 120 — snappier live re-sim
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

// a sample authored DEFENSE play for a team: one player baits mid, two rotate to
// A when he dies (a "kill point"). The seed of the cs-manager-style play editor.
function killPointPlay(t: Team): Play {
  const [p0, p1, p2, p3, p4] = t.players.map(p => p.id);
  const bait = p3;
  return { plans: [
    { player: p3, pos: [500, 470] },                                         // bait @ mid
    { player: p0, pos: [300, 420], rotate: { pos: [320, 160], onDeathOf: bait } },  // rotate A on his death
    { player: p1, pos: [330, 430], rotate: { pos: [296, 165], onDeathOf: bait } },
    { player: p2, pos: [310, 150] },                                         // A anchor
    { player: p4, pos: [270, 793] },                                         // B anchor
  ] };
}

const host = ref<HTMLElement | null>(null);
const busy = ref(false);
const score = ref<[number, number]>([0, 0]);
const teams: [Team, Team] = [NOCTURNE, MERIDIAN];
const seed = ref(42);
const tactics = reactive<[Tactics, Tactics]>([clone(NCT_TACTICS), clone(MRD_TACTICS)]);
const kp = reactive([false, false]);   // per-team: run the sample kill-point defense play
function toggleKp(i: number) {
  tactics[i].defense.play = kp[i] ? killPointPlay(teams[i]) : undefined;
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
            <label>Kill-point play</label>
            <label class="ed-check"><input type="checkbox" v-model="kp[i]" @change="toggleKp(i)" /> bait mid · rotate A on death</label>
          </div>
        </div>
      </div>
    </div>

    <div ref="host" class="ace-host"></div>
  </div>
</template>
