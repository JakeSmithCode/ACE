<script setup lang="ts">
// HQ + Season — the single-player management loop, reading the shared world
// store. Own a club, advance match-days, climb the table, develop the squad,
// pick your comp, watch your matches, and balance the books.
import { onMounted, onUnmounted, ref } from 'vue';
import type { Player } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { ROLE_AGENTS } from '@ace/world';
import { Viewer } from './viewer';
import Roster from './Roster.vue';
import Market from './Market.vue';
import { useWorld, MAP } from './world';

const w = useWorld();
const { clubs, myClub, season, prevById, myComp, balance, ledger,
  table, total, done, dayIdx, myStanding, myResults, nextFixture } = w;
const N = w.N;

const hqTab = ref<'season' | 'squad' | 'market'>('season');

const club = (i: number) => clubs.value[i];
const tagOf = (i: number) => club(i).team.tag;
const nameOf = (i: number) => club(i).team.name;
const cname = (i: number) => `${tagOf(i)} · ${nameOf(i)}`;
const hue = (i: number) => (tagOf(i).charCodeAt(0) * 47 + tagOf(i).charCodeAt(1) * 13) % 360;
const oppOf = (r: { home: number; away: number }) => (r.home === myClub.value ? r.away : r.home);
const fmt = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';

// --- comp builder ---------------------------------------------------------
const topAgent = (p: Player) => [...p.agents].sort((a, b) => b.level - a.level)[0].agent;
const pick = (p: Player) => myComp.value[p.id] ?? topAgent(p);
const masteryOf = (p: Player, agent: string) => p.agents.find(a => a.agent === agent)?.level ?? 45; // off-pool = rough
const agentsFor = (p: Player) => Array.from(new Set([...p.agents.map(a => a.agent), ...ROLE_AGENTS[p.role]]));
function setComp(p: Player, agent: string) {
  myComp.value = agent === topAgent(p) ? omit(myComp.value, p.id) : { ...myComp.value, [p.id]: agent };
}
const omit = (o: Record<string, string>, k: string) => { const c = { ...o }; delete c[k]; return c; };

// --- watch a fixture back -------------------------------------------------
const watchHost = ref<HTMLElement | null>(null);
const watching = ref<typeof w.myResults.value[number] | null>(null);
let viewer: Viewer | null = null;
function watch(r: NonNullable<typeof watching.value>) {
  const nav = w.getNav(); if (!nav) return;
  watching.value = r;
  // re-sim from the fixture seed at higher fork count for True Odds; buildInput
  // overlays YOUR comp + tactics, so watching your own fixture shows your plan.
  const out = simulateMatch(w.buildInput(r, r.seed), nav, 50);
  requestAnimationFrame(() => { viewer?.destroy(); if (watchHost.value) viewer = new Viewer(watchHost.value, out, `/${MAP}.png`, nav as any); });
}

function kickoff() { for (let i = 0; i < 3 && !done.value; i++) w.resolveDay(); }
function advance() { watching.value = null; viewer?.destroy(); viewer = null; w.advanceSeason(); kickoff(); }
function newWorld() { watching.value = null; viewer?.destroy(); viewer = null; w.newWorld(); kickoff(); }
function selectClub(i: number) { watching.value = null; viewer?.destroy(); viewer = null; w.selectClub(i); }

onMounted(async () => { await w.ensureNav(); if (!w.results.value.length) kickoff(); });
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
        <button :class="{ on: hqTab === 'squad' }" @click="hqTab = 'squad'">Squad &amp; Comp</button>
        <button :class="{ on: hqTab === 'market' }" @click="hqTab = 'market'">Market</button>
      </div>
      <div class="hq-actions">
        <button v-if="!done" class="hq-go" @click="w.resolveDay()">▶ Resolve match-day</button>
        <button v-else class="hq-go" @click="advance">⟳ Advance to season {{ season + 1 }}</button>
        <button class="hq-alt" :disabled="done" @click="w.simSeason()">⏭ Sim to end</button>
        <button class="hq-alt" @click="newWorld">⟲ New world</button>
        <span class="hq-seed">seed {{ w.seasonSeed.value }}</span>
      </div>
    </div>

    <!-- MARKET -->
    <Market v-if="hqTab === 'market'" />

    <!-- SQUAD & COMP -->
    <div v-else-if="hqTab === 'squad'" class="hq-grid">
      <Roster :team="club(myClub).team" :prev-by-id="prevById" />
      <div class="hq-panel hq-comp">
        <h3><span class="b"></span>Comp <span class="rs-sub">field each player's agent</span></h3>
        <div v-for="p in club(myClub).team.players" :key="p.id" class="hq-comprow" :class="{ listed: w.isListed(p.id) }">
          <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
          <span class="hq-cph">{{ p.handle }}</span>
          <select :value="pick(p)" @change="setComp(p, ($event.target as HTMLSelectElement).value)">
            <option v-for="ag in agentsFor(p)" :key="ag" :value="ag">{{ ag }}</option>
          </select>
          <span class="hq-mast" :class="{ off: masteryOf(p, pick(p)) < 50 }">
            {{ masteryOf(p, pick(p)) >= 50 ? 'mastery ' + masteryOf(p, pick(p)) : 'off-pool' }}
          </span>
          <button class="hq-list" :class="{ on: w.isListed(p.id) }" @click="w.toggleList(p.id)">{{ w.isListed(p.id) ? '● listed' : 'list' }}</button>
        </div>
        <div class="hq-compnote">Your comp is fielded in your fixtures (off-pool plays rough). <b>List</b> a player to sell — a rival who'd upgrade may buy them between match-days for cash, and you restock the slot from free agency.</div>
      </div>
    </div>

    <!-- SEASON -->
    <div v-else class="hq-grid">
      <!-- standings -->
      <div class="hq-panel hq-table">
        <h3><span class="b"></span>Standings</h3>
        <div class="hq-trow hq-thead">
          <span class="r">#</span><span class="c">Club</span>
          <span>P</span><span>W</span><span>L</span><span>RF</span><span>RA</span><span>Δ</span><span class="pts">Pts</span>
        </div>
        <div v-for="(s, rank) in table" :key="s.club" class="hq-trow" :class="{ me: s.club === myClub }" @click="selectClub(s.club)">
          <span class="r">{{ rank + 1 }}</span>
          <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(s.club)} 65% 55%)` }"></i>{{ cname(s.club) }}</span>
          <span>{{ s.played }}</span><span>{{ s.won }}</span><span>{{ s.lost }}</span>
          <span>{{ s.rf }}</span><span>{{ s.ra }}</span>
          <span :class="s.diff >= 0 ? 'pos' : 'neg'">{{ s.diff >= 0 ? '+' : '' }}{{ s.diff }}</span>
          <span class="pts">{{ s.points }}</span>
        </div>
      </div>

      <div class="hq-right">
        <!-- your club -->
        <div class="hq-panel hq-club">
          <h3><span class="b"></span>Your club</h3>
          <div class="hq-clubcard">
            <div class="hq-badge" :style="{ background: `hsl(${hue(myClub)} 60% 22%)`, borderColor: `hsl(${hue(myClub)} 65% 55%)` }">{{ tagOf(myClub) }}</div>
            <div class="hq-clubmeta">
              <div class="hq-clubname">{{ nameOf(myClub) }}</div>
              <div class="hq-clubsub">
                <span class="hq-pos">{{ w.rankOf(myClub) }}<sup>{{ ['st','nd','rd'][w.rankOf(myClub)-1] || 'th' }}</sup></span> of {{ N }}
                <span v-if="myStanding">· {{ myStanding.won }}W {{ myStanding.lost }}L · {{ myStanding.diff >= 0 ? '+' : '' }}{{ myStanding.diff }} diff</span>
              </div>
              <div class="hq-strbar"><i :style="{ width: (club(myClub).strength * 100) + '%' }"></i><span>strength {{ club(myClub).strength.toFixed(2) }}</span></div>
            </div>
          </div>
        </div>

        <!-- finances -->
        <div class="hq-panel hq-fin">
          <h3><span class="b"></span>Finances</h3>
          <div class="hq-balance"><span>Balance</span><b :class="{ neg: balance < 0 }">{{ fmt(balance) }}</b></div>
          <div v-if="ledger" class="hq-ledger">
            <div class="hq-led"><span>Sponsor (s{{ ledger.season }})</span><b class="pos">+{{ fmt(ledger.sponsor) }}</b></div>
            <div class="hq-led"><span>Prize money</span><b class="pos">+{{ fmt(ledger.prize) }}</b></div>
            <div class="hq-led"><span>Squad wages</span><b class="neg">−{{ fmt(ledger.wages) }}</b></div>
            <div class="hq-led net"><span>Net last season</span><b :class="ledger.net >= 0 ? 'pos' : 'neg'">{{ ledger.net >= 0 ? '+' : '−' }}{{ fmt(Math.abs(ledger.net)) }}</b></div>
          </div>
          <div v-else class="hq-compnote">Finish the season to settle the books — better finishes pay more; the wage bill is owed regardless.</div>
        </div>

        <!-- fixtures -->
        <div class="hq-panel hq-fixtures">
          <h3><span class="b"></span>Your fixtures</h3>
          <div v-if="nextFixture" class="hq-next">
            <span class="hq-nextlbl">NEXT</span>
            <span class="hq-vs">{{ nextFixture.home === myClub ? 'vs' : '@' }} <b>{{ tagOf(oppOf(nextFixture)) }}</b> {{ nameOf(oppOf(nextFixture)) }}</span>
            <button class="hq-go sm" @click="w.resolveDay()">play ▶</button>
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
