<script setup lang="ts">
// The Match Center — the async-PvP client. The world resolves on the @ace/server
// tick, not in this browser; here we watch it. During a match's broadcast window the
// running score streams in live (SSE) with the result SEALED (the embargo — no
// spoilers until it's over); once revealed we pull the snapshot and re-sim it in the
// viewer (the engine runs client-side, so watching costs the server nothing). This is
// the seam between the deep persistence backend and the broadcast-grade viewer.
import { onMounted, onUnmounted, ref, computed } from 'vue';
import type { MapId } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { Viewer } from './viewer';
import { AceServer, type WorldSummary, type StandingRow, type LiveFixture } from './serverApi';

const DEFAULT = new URL(location.href).searchParams.get('server') || 'http://127.0.0.1:8787';
const url = ref(DEFAULT);
const server = ref<AceServer | null>(null);
const status = ref<'idle' | 'connecting' | 'live' | 'error'>('idle');
const errMsg = ref('');
const world = ref<WorldSummary | null>(null);
const table = ref<StandingRow[]>([]);
const fixtures = ref<LiveFixture[]>([]);
let stopStream: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const season = computed(() => world.value?.season ?? 1);
const DAY = 0;   // the server demo broadcasts day 0
const navs: Record<string, any> = {};
async function ensureNav(map: MapId) {
  if (!navs[map]) navs[map] = await fetch(`/${map}.navmesh.json`).then(r => r.json());
  return navs[map];
}

const hue = (tag: string) => (tag.charCodeAt(0) * 47 + (tag.charCodeAt(1) || 0) * 13) % 360;
// the score to display: the running (completed-round) tally while live, but the TRUE
// final once revealed (the live running-score excludes the in-progress decider round)
const score = (f: LiveFixture): [number, number] => (f.status === 'resolved' && f.final ? f.final : f.running);
const anyLive = computed(() => fixtures.value.some(f => f.status === 'live'));
const allDone = computed(() => fixtures.value.length > 0 && fixtures.value.every(f => f.status === 'resolved'));

async function connect() {
  status.value = 'connecting'; errMsg.value = '';
  const s = new AceServer(url.value);
  try {
    world.value = await s.world();
    table.value = (await s.standings(world.value.season, 0, 0)).table;
    server.value = s; status.value = 'live';
    stopStream?.();
    stopStream = s.liveStream(world.value.season, DAY, fs => { fixtures.value = [...fs].sort((a, b) => a.slot - b.slot); }, refreshTable);
    // standings only move at reveal — refresh them every few seconds while watching
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshTable, 4000);
  } catch (e) { status.value = 'error'; errMsg.value = (e as Error).message; }
}
async function refreshTable() { if (server.value && world.value) try { table.value = (await server.value.standings(world.value.season, 0, 0)).table; } catch { /* transient */ } }

// --- watch a revealed fixture back in the viewer ---------------------------
const host = ref<HTMLElement | null>(null);
const watching = ref<LiveFixture | null>(null);
const loadingWatch = ref(false);
let viewer: Viewer | null = null;
async function watch(fx: LiveFixture) {
  if (!server.value || fx.status !== 'resolved') return;
  loadingWatch.value = true;
  try {
    const rep = await server.value.replay(season.value, DAY, fx.slot);
    if (!rep?.snapshot) return;
    const map = rep.snapshot.map;
    const nav = await ensureNav(map);
    const out = simulateMatch(rep.snapshot, nav, 50);
    watching.value = fx;
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav); });
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}
function closeWatch() { watching.value = null; viewer?.destroy(); viewer = null; }

onMounted(connect);
onUnmounted(() => { stopStream?.(); if (pollTimer) clearInterval(pollTimer); viewer?.destroy(); });
</script>

<template>
  <div class="mc">
    <!-- connection bar -->
    <div class="lv-bar">
      <div class="lv-title">
        <span class="lv-dot" :class="status"></span>
        <b>MATCH CENTER</b>
        <span v-if="world" class="lv-world">{{ world.region }} · Season {{ world.season }} · Day {{ world.day }} · {{ world.divisions }} divisions · {{ world.clubs }} clubs</span>
        <span v-else class="lv-world">async-PvP · server-resolved</span>
      </div>
      <div class="lv-conn">
        <input v-model="url" class="lv-url" spellcheck="false" @keyup.enter="connect" />
        <button class="lv-go" @click="connect">{{ status === 'live' ? 'reconnect' : 'connect' }}</button>
      </div>
    </div>

    <div v-if="status === 'error'" class="lv-err">
      Couldn't reach <b>{{ url }}</b> — {{ errMsg }}.
      <div class="lv-hint">Start one with <code>pnpm run server:serve</code> (defaults to <code>:8787</code>), then connect.</div>
    </div>
    <div v-else-if="status === 'connecting'" class="lv-err lv-wait">Connecting to {{ url }}…</div>

    <template v-if="status === 'live' && world">
      <!-- the day's live matches -->
      <div class="lv-stage">
        <div class="lv-stageh">
          <span class="lv-kicker">Premier · Match-day {{ DAY + 1 }}</span>
          <span class="lv-livetag" :class="{ on: anyLive }">{{ anyLive ? '● LIVE' : allDone ? 'FINAL' : '—' }}</span>
          <span class="lv-embargo" v-if="anyLive">results sealed until each broadcast ends — no spoilers</span>
        </div>
        <div class="lv-cards">
          <div v-for="f in fixtures" :key="f.slot" class="lv-card" :class="f.status">
            <div class="lv-team">
              <i class="lv-badge" :style="{ background: `hsl(${hue(f.home.tag)} 60% 24%)`, borderColor: `hsl(${hue(f.home.tag)} 65% 55%)` }">{{ f.home.tag }}</i>
              <span class="lv-tname">{{ f.home.name }}</span>
            </div>
            <div class="lv-mid">
              <div class="lv-score" :class="{ sealed: f.status !== 'resolved' }">
                <b>{{ score(f)[0] }}</b><span class="lv-sep">:</span><b>{{ score(f)[1] }}</b>
              </div>
              <div v-if="f.status === 'live'" class="lv-prog"><i :style="{ width: (f.frac * 100) + '%' }"></i></div>
              <div class="lv-state">
                <span v-if="f.status === 'live'" class="lv-rd">LIVE · RD {{ f.round }}/{{ f.rounds }}</span>
                <span v-else-if="f.status === 'resolved'" class="lv-final">FINAL{{ f.map ? ' · ' + f.map : '' }}</span>
                <span v-else class="lv-sched">SCHEDULED</span>
              </div>
            </div>
            <div class="lv-team away">
              <i class="lv-badge" :style="{ background: `hsl(${hue(f.away.tag)} 60% 24%)`, borderColor: `hsl(${hue(f.away.tag)} 65% 55%)` }">{{ f.away.tag }}</i>
              <span class="lv-tname">{{ f.away.name }}</span>
            </div>
            <button v-if="f.status === 'resolved'" class="lv-watch" :disabled="loadingWatch" @click="watch(f)">▷ watch</button>
            <div v-else class="lv-locked" title="sealed until the broadcast finishes">🔒</div>
          </div>
          <div v-if="!fixtures.length" class="lv-empty">waiting for the match-day to go live…</div>
        </div>
      </div>

      <!-- the watched match -->
      <div v-if="watching" class="lv-watchwrap">
        <div class="lv-watchhead">
          <b>{{ watching.home.tag }}</b> {{ watching.final?.[0] }} – {{ watching.final?.[1] }} <b>{{ watching.away.tag }}</b>
          · <span class="hq-rmap">{{ watching.map }}</span> · re-simmed from the server snapshot
          <button class="ed-close" @click="closeWatch">close</button>
        </div>
        <div ref="host" class="ace-host"></div>
      </div>

      <!-- Premier standings (embargo-aware: only resolved games count) -->
      <div class="lv-table">
        <div class="lv-tableh"><span class="lv-kicker">Premier standings</span><span class="lv-note">moves only when a broadcast ends</span></div>
        <div class="lv-trow lv-thead"><span class="r">#</span><span class="c">Club</span><span>P</span><span>W</span><span>L</span><span>Δ</span><span class="pts">Pts</span></div>
        <div v-for="(s, rank) in table" :key="s.club" class="lv-trow">
          <span class="r">{{ rank + 1 }}</span>
          <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(s.club)} 65% 55%)` }"></i><span class="lv-cname">{{ s.club }}</span></span>
          <span>{{ s.played }}</span><span>{{ s.won }}</span><span>{{ s.lost }}</span>
          <span :class="s.diff >= 0 ? 'pos' : 'neg'">{{ s.diff >= 0 ? '+' : '' }}{{ s.diff }}</span>
          <span class="pts">{{ s.points }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
