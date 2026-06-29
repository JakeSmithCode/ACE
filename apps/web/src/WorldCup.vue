<script setup lang="ts">
// The World Cup — national teams assembled from the league's talent by NATIONALITY.
// The best players of each country form a national five and clash in a single-elim
// bracket for the world title (the server full-sims the final, watchable). The payoff
// of the identity layer: "Team Korea" is real names you've scouted all season.
import { onMounted, onUnmounted, ref } from 'vue';
import { simulateMatch } from '@ace/engine';
import { Viewer } from './viewer';
import { AceServer, type WorldCupView, type WCSide } from './serverApi';

const DEFAULT = new URL(location.href).searchParams.get('server') || 'http://127.0.0.1:8787';
const url = ref(DEFAULT);
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const errMsg = ref('');
const wc = ref<WorldCupView | null>(null);
let server: AceServer | null = null;

const roleAbbr = (r: string) => r.slice(0, 3).toUpperCase();
const isChamp = (s: WCSide) => wc.value != null && s.code === wc.value.bracket.champion.code;
const won = (m: { winner: WCSide }, s: WCSide) => m.winner.code === s.code;
const roundName = (i: number, total: number) => {
  const fromEnd = total - 1 - i;
  return fromEnd === 0 ? 'Grand Final' : fromEnd === 1 ? 'Semifinals' : fromEnd === 2 ? 'Quarterfinals' : `Round ${i + 1}`;
};

async function load() {
  status.value = 'loading'; errMsg.value = '';
  server = new AceServer(url.value);
  try { wc.value = await server.worldCup(); status.value = 'ready'; }
  catch (e) { status.value = 'error'; errMsg.value = (e as Error).message; }
}

// --- watch the grand final (full-simmed, re-rendered from its snapshot) ------
const host = ref<HTMLElement | null>(null);
const watching = ref(false);
const navs: Record<string, any> = {};
let viewer: Viewer | null = null;
async function watchFinal() {
  if (!wc.value) return;
  const f = wc.value.final;
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
        <b>WORLD CUP</b>
        <span class="lv-world">national teams clash for the world title</span>
      </div>
      <div class="lv-conn">
        <input v-model="url" class="lv-url" spellcheck="false" @keyup.enter="load" />
        <button class="lv-go" @click="load">{{ status === 'ready' ? 'refresh' : 'load' }}</button>
      </div>
    </div>

    <div v-if="status === 'error'" class="lv-err">Couldn't reach <b>{{ url }}</b> — {{ errMsg }}.
      <div class="lv-hint">Start one with <code>pnpm run server:serve</code>, then load.</div></div>
    <div v-else-if="status === 'loading'" class="lv-err lv-wait">Assembling the national squads + the World Cup bracket…</div>

    <template v-if="status === 'ready' && wc">
      <!-- the world champion -->
      <div class="cir-champ wc-champ">
        <span class="cir-trophy">🏆</span>
        <div class="cir-champmeta">
          <span class="cir-champk">World Champions · Season {{ wc.season }}</span>
          <b class="cir-champname">{{ wc.bracket.champion.flag }} {{ wc.bracket.champion.country }}</b>
          <span class="cir-champreg">National Team · {{ wc.bracket.champion.code }}</span>
        </div>
        <button class="cir-watch" @click="watchFinal">▷ watch the grand final</button>
      </div>

      <!-- the qualified national squads (the payoff: real people by nation) -->
      <div class="wc-squadh">Qualified nations · best five of each country</div>
      <div class="wc-squads">
        <div v-for="(s, si) in wc.squads" :key="s.code" class="wc-squad" :class="{ champ: isChamp(s) }">
          <div class="wc-sqhead">
            <span class="wc-flag">{{ s.flag }}</span>
            <div class="wc-sqid"><b>{{ s.country }}</b><i>{{ s.code }} · seed {{ si + 1 }} · {{ s.pool }} eligible</i></div>
            <div class="wc-sqstr">{{ s.strength }}<span>OVR</span></div>
          </div>
          <div v-for="p in s.five" :key="p.handle" class="wc-player">
            <span class="rs-role" :class="p.role">{{ roleAbbr(p.role) }}</span>
            <div class="wc-pid"><b>{{ p.handle }}<i v-if="p.igl" class="rs-igl wc-igl">IGL</i></b><span class="wc-pname">{{ p.name }}</span></div>
            <span class="wc-pagent">{{ p.agent }}</span>
            <span class="wc-psolo" :class="'rk-' + p.soloTier.toLowerCase()">{{ p.solo }}</span>
            <span class="wc-povr">{{ p.overall }}</span>
          </div>
        </div>
      </div>

      <!-- the bracket -->
      <div class="cir-brackwrap">
        <div class="cir-brackh">World Cup bracket · {{ wc.bracket.field.length }} nations · single elimination</div>
        <div class="cir-brack">
          <div v-for="(round, ri) in wc.bracket.rounds" :key="ri" class="cir-col">
            <div class="cir-colh">{{ roundName(ri, wc.bracket.rounds.length) }}</div>
            <div v-for="(m, mi) in round" :key="mi" class="cir-match" :class="{ fin: ri === wc.bracket.rounds.length - 1 }">
              <div class="cir-side" :class="{ win: won(m, m.a), champ: ri === wc.bracket.rounds.length - 1 && isChamp(m.a) }">
                <i class="wc-bflag">{{ m.a.flag }}</i><b>{{ m.a.code }}</b>
                <span v-if="ri === wc.bracket.rounds.length - 1" class="cir-sc">{{ wc.final.score[0] }}</span>
              </div>
              <div class="cir-side" :class="{ win: won(m, m.b), champ: ri === wc.bracket.rounds.length - 1 && isChamp(m.b) }">
                <i class="wc-bflag">{{ m.b.flag }}</i><b>{{ m.b.code }}</b>
                <span v-if="ri === wc.bracket.rounds.length - 1" class="cir-sc">{{ wc.final.score[1] }}</span>
              </div>
              <div v-if="ri === wc.bracket.rounds.length - 1" class="cir-finmap">{{ wc.final.map }} · engine-simmed</div>
            </div>
          </div>
        </div>
      </div>

      <!-- the watched grand final -->
      <div v-if="watching" class="lv-watchwrap">
        <div class="lv-watchhead">
          <b>{{ wc.final.a.flag }} {{ wc.final.a.code }}</b> {{ wc.final.score[0] }} – {{ wc.final.score[1] }} <b>{{ wc.final.b.code }} {{ wc.final.b.flag }}</b>
          · <span class="hq-rmap">{{ wc.final.map }}</span> · the grand final, re-simmed from the server snapshot
          <button class="ed-close" @click="closeWatch">close</button>
        </div>
        <div ref="host" class="ace-host"></div>
      </div>
    </template>
  </div>
</template>
