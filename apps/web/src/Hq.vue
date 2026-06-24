<script setup lang="ts">
// HQ + Season — the single-player management loop. A whole league + season is a
// pure function of one seed (@ace/world), resolved client-side by the same
// engine the viewer uses. You own a club, advance match-days, climb the table,
// and watch any fixture back (re-simmed from its stable fixture seed).
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { Attributes, MapId, MatchInput } from '@ace/shared';
import type { Navmesh } from '@ace/maps';
import { simulateMatch, PATCH, Rng } from '@ace/engine';
import { makeLeague, doubleRoundRobin, standings, fixtureSeed, developLeague, type Club, type MatchResult, type Matchday } from '@ace/world';
import { Viewer } from './viewer';
import Roster from './Roster.vue';

const MAP: MapId = 'ascent';
const N = 8;
const WATCH_FORKS = 50;          // True Odds for a watched match
const RESOLVE_FORKS = 3;         // standings only need the final score — keep season resolution snappy

const seasonSeed = ref(7);
const clubs = shallowRef<Club[]>(makeLeague(seasonSeed.value, N));
const schedule = shallowRef<Matchday[]>(doubleRoundRobin(N));
const results = ref<MatchResult[]>([]);
const dayIdx = ref(0);                              // next match-day to resolve
const myClub = ref(4);                              // the club you own (mid-table by generation)
const busy = ref(false);
const season = ref(1);                             // career season number
const hqTab = ref<'season' | 'squad'>('season');
const prevById = ref<Map<string, { age: number; attr: Attributes }>>(new Map());  // pre-tick snapshot, for roster deltas

let nav: Navmesh | null = null;

const table = computed(() => standings(N, results.value));
const total = computed(() => schedule.value.length);
const done = computed(() => dayIdx.value >= total.value);
const rankOf = (club: number) => table.value.findIndex(s => s.club === club) + 1;
const myStanding = computed(() => table.value.find(s => s.club === myClub.value));
const club = (i: number) => clubs.value[i];
const tagOf = (i: number) => club(i).team.tag;
const nameOf = (i: number) => club(i).team.name;
const cname = (i: number) => `${tagOf(i)} · ${nameOf(i)}`;
// a deterministic accent per club, so badges read as distinct identities
const hue = (i: number) => (tagOf(i).charCodeAt(0) * 47 + tagOf(i).charCodeAt(1) * 13) % 360;

// my fixtures, newest-resolved + the next one to come
const myResults = computed(() => results.value.filter(r => r.home === myClub.value || r.away === myClub.value));
const nextFixture = computed(() => {
  if (done.value) return null;
  const fx = schedule.value[dayIdx.value].find(f => f.home === myClub.value || f.away === myClub.value);
  return fx ?? null;
});
const oppOf = (r: { home: number; away: number }) => (r.home === myClub.value ? r.away : r.home);

function simFixture(fx: { home: number; away: number }, seed: number): MatchResult {
  const h = club(fx.home), a = club(fx.away);
  const input: MatchInput = { seed, map: MAP, patch: PATCH, teams: [h.team, a.team], tactics: [h.tactics, a.tactics] };
  const [hs, as] = simulateMatch(input, nav!, RESOLVE_FORKS).finalScore;
  return { home: fx.home, away: fx.away, score: [hs, as], winner: hs > as ? fx.home : fx.away, seed };
}
function resolveDay() {
  if (done.value || !nav) return;
  const day = schedule.value[dayIdx.value];
  const fresh = day.map((fx, slot) => simFixture(fx, fixtureSeed(seasonSeed.value, dayIdx.value, slot)));
  results.value = [...results.value, ...fresh];
  dayIdx.value++;
}
function simSeason() { busy.value = true; requestAnimationFrame(() => { while (!done.value) resolveDay(); busy.value = false; }); }

// the off-season: every club's squad develops (youth grows, veterans fade), then
// a fresh season begins. Deterministic from (world seed, season).
function advanceSeason() {
  if (!done.value) return;
  prevById.value = new Map(clubs.value.flatMap(c => c.team.players.map(p =>
    [p.id, { age: p.age, attr: { ...p.attr } }] as const)));
  const rng = new Rng((seasonSeed.value ^ (season.value * 0x9e3779b9)) >>> 0);
  clubs.value = developLeague(clubs.value, rng);
  season.value++;
  results.value = []; dayIdx.value = 0;
  watching.value = null; viewer?.destroy(); viewer = null;
  kickoff();
}
function newWorld(s = Math.floor(Math.random() * 100000)) {
  seasonSeed.value = s;
  clubs.value = makeLeague(s, N);
  schedule.value = doubleRoundRobin(N);
  results.value = []; dayIdx.value = 0;
  season.value = 1; prevById.value = new Map();
  watching.value = null; viewer?.destroy(); viewer = null;
  kickoff();
}

// --- watch a fixture back -------------------------------------------------
const watchHost = ref<HTMLElement | null>(null);
const watching = ref<MatchResult | null>(null);
let viewer: Viewer | null = null;
function watch(r: MatchResult) {
  if (!nav) return;
  watching.value = r;
  const h = club(r.home), a = club(r.away);
  const input: MatchInput = { seed: r.seed, map: MAP, patch: PATCH, teams: [h.team, a.team], tactics: [h.tactics, a.tactics] };
  const tl = simulateMatch(input, nav, WATCH_FORKS);
  requestAnimationFrame(() => {
    viewer?.destroy();
    if (watchHost.value) viewer = new Viewer(watchHost.value, tl, `/${MAP}.png`, nav as any);
  });
}

function kickoff() { for (let i = 0; i < 3 && !done.value; i++) resolveDay(); }  // a few days in, so the table is alive
onMounted(async () => { nav = await fetch(`/${MAP}.navmesh.json`).then(r => r.json()); kickoff(); });
onUnmounted(() => { viewer?.destroy(); });
</script>

<template>
  <div class="hq">
    <!-- season control bar -->
    <div class="hq-bar">
      <div class="hq-season">
        <span class="hq-kicker">Season {{ season }}</span>
        <b>{{ N }}-club league</b>
        <span class="hq-day">Match-day {{ Math.min(dayIdx, total) }} / {{ total }}</span>
      </div>
      <div class="hq-tabs">
        <button :class="{ on: hqTab === 'season' }" @click="hqTab = 'season'">Season</button>
        <button :class="{ on: hqTab === 'squad' }" @click="hqTab = 'squad'">Squad</button>
      </div>
      <div class="hq-actions">
        <button v-if="!done" class="hq-go" @click="resolveDay">▶ Resolve match-day</button>
        <button v-else class="hq-go" @click="advanceSeason">⟳ Advance to season {{ season + 1 }}</button>
        <button class="hq-alt" :disabled="done" @click="simSeason">⏭ Sim to end</button>
        <button class="hq-alt" @click="newWorld()">⟲ New world</button>
        <span class="hq-seed">seed {{ seasonSeed }}</span>
      </div>
    </div>

    <div v-if="hqTab === 'squad'">
      <Roster :team="club(myClub).team" :prev-by-id="prevById" />
    </div>

    <div v-else class="hq-grid">
      <!-- standings -->
      <div class="hq-panel hq-table">
        <h3><span class="b"></span>Standings</h3>
        <div class="hq-trow hq-thead">
          <span class="r">#</span><span class="c">Club</span>
          <span>P</span><span>W</span><span>L</span><span>RF</span><span>RA</span><span>Δ</span><span class="pts">Pts</span>
        </div>
        <div v-for="(s, rank) in table" :key="s.club" class="hq-trow" :class="{ me: s.club === myClub }"
             @click="myClub = s.club">
          <span class="r">{{ rank + 1 }}</span>
          <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(s.club)} 65% 55%)` }"></i>{{ cname(s.club) }}</span>
          <span>{{ s.played }}</span><span>{{ s.won }}</span><span>{{ s.lost }}</span>
          <span>{{ s.rf }}</span><span>{{ s.ra }}</span>
          <span :class="s.diff >= 0 ? 'pos' : 'neg'">{{ s.diff >= 0 ? '+' : '' }}{{ s.diff }}</span>
          <span class="pts">{{ s.points }}</span>
        </div>
      </div>

      <!-- your club + fixtures -->
      <div class="hq-right">
        <div class="hq-panel hq-club">
          <h3><span class="b"></span>Your club</h3>
          <div class="hq-clubcard">
            <div class="hq-badge" :style="{ background: `hsl(${hue(myClub)} 60% 22%)`, borderColor: `hsl(${hue(myClub)} 65% 55%)` }">
              {{ tagOf(myClub) }}
            </div>
            <div class="hq-clubmeta">
              <div class="hq-clubname">{{ nameOf(myClub) }}</div>
              <div class="hq-clubsub">
                <span class="hq-pos">{{ rankOf(myClub) }}<sup>{{ ['st','nd','rd'][rankOf(myClub)-1] || 'th' }}</sup></span> of {{ N }}
                <span v-if="myStanding">· {{ myStanding.won }}W {{ myStanding.lost }}L · {{ myStanding.diff >= 0 ? '+' : '' }}{{ myStanding.diff }} diff</span>
              </div>
              <div class="hq-strbar"><i :style="{ width: (club(myClub).strength * 100) + '%' }"></i><span>strength {{ club(myClub).strength.toFixed(2) }}</span></div>
            </div>
          </div>
          <div class="hq-picker">own a different club:
            <select v-model.number="myClub"><option v-for="i in N" :key="i-1" :value="i-1">{{ cname(i-1) }}</option></select>
          </div>
        </div>

        <div class="hq-panel hq-fixtures">
          <h3><span class="b"></span>Your fixtures</h3>
          <div v-if="nextFixture" class="hq-next">
            <span class="hq-nextlbl">NEXT</span>
            <span class="hq-vs">{{ nextFixture.home === myClub ? 'vs' : '@' }} <b>{{ tagOf(oppOf(nextFixture)) }}</b> {{ nameOf(oppOf(nextFixture)) }}</span>
            <button class="hq-go sm" @click="resolveDay">play ▶</button>
          </div>
          <div v-for="(r, i) in [...myResults].reverse()" :key="i" class="hq-result" :class="{ win: r.winner === myClub }">
            <span class="hq-rw">{{ r.winner === myClub ? 'W' : 'L' }}</span>
            <span class="hq-rscore">{{ r.home === myClub ? r.score[0] : r.score[1] }}–{{ r.home === myClub ? r.score[1] : r.score[0] }}</span>
            <span class="hq-ropp">{{ r.home === myClub ? 'vs' : '@' }} {{ tagOf(oppOf(r)) }}</span>
            <button class="hq-watch" @click="watch(r)">▷ watch</button>
          </div>
          <div v-if="!myResults.length && !nextFixture" class="hq-empty">season complete</div>
        </div>
      </div>
    </div>

    <!-- the watched match -->
    <div v-if="watching" class="hq-watchwrap">
      <div class="hq-watchhead">
        <b>{{ tagOf(watching.home) }}</b> {{ watching.score[0] }} – {{ watching.score[1] }} <b>{{ tagOf(watching.away) }}</b>
        · re-simmed from fixture seed {{ watching.seed }}
        <button class="ed-close" @click="watching = null; viewer?.destroy(); viewer = null">close</button>
      </div>
      <div ref="watchHost" class="ace-host"></div>
    </div>
  </div>
</template>
