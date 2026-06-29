<script setup lang="ts">
// The international circuit — the Masters/Champions where regions clash (DESIGN §9).
// Four regional shards each resolve a season; their best qualify into a single-elim
// bracket the server computes (earlier rounds quick-resolved, the GRAND FINAL
// full-simmed by the engine so it's watchable). The browser re-sims the final's
// snapshot in the same broadcast viewer. The marquee that shows the world's depth.
import { onMounted, onUnmounted, ref } from 'vue';
import { simulateMatch } from '@ace/engine';
import { Viewer } from './viewer';
import { AceServer, type CircuitView, type IntlSide } from './serverApi';

const DEFAULT = new URL(location.href).searchParams.get('server') || 'http://127.0.0.1:8787';
const url = ref(DEFAULT);
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const errMsg = ref('');
const cv = ref<CircuitView | null>(null);
let server: AceServer | null = null;

const REGION_HUE: Record<string, number> = { AMER: 8, EMEA: 200, PACIFIC: 150, CHINA: 45 };
const rhue = (r: string) => REGION_HUE[r] ?? 280;
const isChamp = (s: IntlSide) => cv.value && s.region === cv.value.bracket.champion.region && s.tag === cv.value.bracket.champion.tag;
const won = (m: { winner: IntlSide }, s: IntlSide) => m.winner.region === s.region && m.winner.tag === s.tag;
const roundName = (i: number, total: number) => {
  const fromEnd = total - 1 - i;
  return fromEnd === 0 ? 'Grand Final' : fromEnd === 1 ? 'Semifinals' : fromEnd === 2 ? 'Quarterfinals' : `Round ${i + 1}`;
};

async function load() {
  status.value = 'loading'; errMsg.value = '';
  server = new AceServer(url.value);
  try { cv.value = await server.circuit(); status.value = 'ready'; }
  catch (e) { status.value = 'error'; errMsg.value = (e as Error).message; }
}

// --- watch the grand final (full-simmed, re-rendered from its snapshot) ------
const host = ref<HTMLElement | null>(null);
const watching = ref(false);
const navs: Record<string, any> = {};
let viewer: Viewer | null = null;
async function watchFinal() {
  if (!cv.value) return;
  const f = cv.value.final;
  if (!navs[f.map]) navs[f.map] = await fetch(`/${f.map}.navmesh.json`).then(r => r.json());
  const out = simulateMatch(f.snapshot, navs[f.map], 50);
  watching.value = true;
  requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${f.map}.png`, navs[f.map]); });
}
function closeWatch() { watching.value = false; viewer?.destroy(); viewer = null; }

onMounted(load);
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="cir">
    <div class="lv-bar">
      <div class="lv-title">
        <span class="lv-dot" :class="status === 'ready' ? 'live' : status === 'error' ? 'error' : 'connecting'"></span>
        <b>INTERNATIONAL</b>
        <span class="lv-world">Masters · regions clash for the world title</span>
      </div>
      <div class="lv-conn">
        <input v-model="url" class="lv-url" spellcheck="false" @keyup.enter="load" />
        <button class="lv-go" @click="load">{{ status === 'ready' ? 'refresh' : 'load' }}</button>
      </div>
    </div>

    <div v-if="status === 'error'" class="lv-err">Couldn't reach <b>{{ url }}</b> — {{ errMsg }}.
      <div class="lv-hint">Start one with <code>pnpm run server:serve</code>, then load.</div></div>
    <div v-else-if="status === 'loading'" class="lv-err lv-wait">Resolving the regional shards + the Masters bracket…</div>

    <template v-if="status === 'ready' && cv">
      <!-- the global champion -->
      <div class="cir-champ" :style="{ '--ch': `hsl(${rhue(cv.bracket.champion.region)} 70% 55%)` }">
        <span class="cir-trophy">🏆</span>
        <div class="cir-champmeta">
          <span class="cir-champk">World Champion · Masters</span>
          <b class="cir-champname">{{ cv.bracket.champion.name }}</b>
          <span class="cir-champreg">{{ cv.bracket.champion.region }} · {{ cv.bracket.champion.tag }}</span>
        </div>
        <button class="cir-watch" @click="watchFinal">▷ watch the grand final</button>
      </div>

      <!-- regional shards -->
      <div class="cir-regions">
        <div v-for="r in cv.regions" :key="r.region" class="cir-region" :style="{ '--rg': `hsl(${rhue(r.region)} 65% 52%)` }">
          <div class="cir-regh">{{ r.region }}</div>
          <div class="cir-regch">🏆 {{ r.champion }}</div>
          <div class="cir-regtop"><span v-for="(t, i) in r.top" :key="t" :class="{ q: i < 2 }">{{ t }}</span></div>
          <div class="cir-reglbl">top 2 qualify</div>
        </div>
      </div>

      <!-- the Masters bracket -->
      <div class="cir-brackwrap">
        <div class="cir-brackh">Masters bracket · {{ cv.bracket.field.length }} teams · single elimination</div>
        <div class="cir-brack">
          <div v-for="(round, ri) in cv.bracket.rounds" :key="ri" class="cir-col">
            <div class="cir-colh">{{ roundName(ri, cv.bracket.rounds.length) }}</div>
            <div v-for="(m, mi) in round" :key="mi" class="cir-match" :class="{ fin: ri === cv.bracket.rounds.length - 1 }">
              <div class="cir-side" :class="{ win: won(m, m.a), champ: ri === cv.bracket.rounds.length - 1 && isChamp(m.a) }" :style="{ '--s': `hsl(${rhue(m.a.region)} 65% 52%)` }">
                <i class="cir-reg">{{ m.a.region.slice(0, 3) }}</i><b>{{ m.a.tag }}</b>
                <span v-if="ri === cv.bracket.rounds.length - 1" class="cir-sc">{{ cv.final.score[0] }}</span>
              </div>
              <div class="cir-side" :class="{ win: won(m, m.b), champ: ri === cv.bracket.rounds.length - 1 && isChamp(m.b) }" :style="{ '--s': `hsl(${rhue(m.b.region)} 65% 52%)` }">
                <i class="cir-reg">{{ m.b.region.slice(0, 3) }}</i><b>{{ m.b.tag }}</b>
                <span v-if="ri === cv.bracket.rounds.length - 1" class="cir-sc">{{ cv.final.score[1] }}</span>
              </div>
              <div v-if="ri === cv.bracket.rounds.length - 1" class="cir-finmap">{{ cv.final.map }} · engine-simmed</div>
            </div>
          </div>
        </div>
      </div>

      <!-- the watched grand final -->
      <div v-if="watching" class="lv-watchwrap">
        <div class="lv-watchhead">
          <b>{{ cv.final.a.tag }}</b> {{ cv.final.score[0] }} – {{ cv.final.score[1] }} <b>{{ cv.final.b.tag }}</b>
          · <span class="hq-rmap">{{ cv.final.map }}</span> · the grand final, re-simmed from the server snapshot
          <button class="ed-close" @click="closeWatch">close</button>
        </div>
        <div ref="host" class="ace-host"></div>
      </div>
    </template>
  </div>
</template>
