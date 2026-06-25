<script setup lang="ts">
// HQ + Season — the single-player management loop, reading the shared world
// store. Own a club, advance match-days, climb the table, develop the squad,
// pick your comp, watch your matches, and balance the books.
import { computed, onMounted, onUnmounted, ref, watch as vueWatch } from 'vue';
import type { Player } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { ROLE_AGENTS } from '@ace/world';
import { Viewer } from './viewer';
import Roster from './Roster.vue';
import Market from './Market.vue';
import { useWorld } from './world';

const w = useWorld();
const { clubs, myClub, season, myComp, balance, ledger,
  total, done, dayIdx, myStanding, myResults, nextFixture, playoffs, titles,
  myDivision, division, lastMoves } = w;
const N = w.N;
const DIV_NAMES = w.DIV_NAMES, DIVS = w.DIVS, PROMO = w.PROMO, DIV_SIZE = w.DIV_SIZE;

// playoff helpers
const seedNo = (c: number) => (playoffs.value ? playoffs.value.qualified.indexOf(c) + 1 : 0);
const titleCount = (i: number) => titles.value[i] ?? 0;

// --- divisions: which tier's table to show (defaults to yours, follows you) ---
const viewDiv = ref(myDivision.value);
vueWatch(myDivision, d => { viewDiv.value = d; });
const shownTable = computed(() => w.tableOf(viewDiv.value));
const divOf = (i: number) => division.value[i];
// a row's promotion/relegation status within the shown division
function zoneOf(rank: number): '' | 'promo' | 'releg' {
  if (viewDiv.value > 0 && rank <= PROMO) return 'promo';            // top of a lower tier → up
  if (viewDiv.value < DIVS - 1 && rank > DIV_SIZE - PROMO) return 'releg';  // bottom of a higher tier → down
  return '';
}
// on a deep ladder, only show off-season moves touching your tier (in or out) —
// the rest of the ladder churns, but these are the clubs you'll face
const nearMoves = computed(() => lastMoves.value.filter(m => m.from === myDivision.value || m.to === myDivision.value));

const hqTab = ref<'season' | 'squad' | 'market'>('season');

const club = (i: number) => clubs.value[i];
const tagOf = (i: number) => club(i).team.tag;
const nameOf = (i: number) => club(i).team.name;
const cname = (i: number) => `${tagOf(i)} · ${nameOf(i)}`;
const hue = (i: number) => (tagOf(i).charCodeAt(0) * 47 + tagOf(i).charCodeAt(1) * 13) % 360;
const oppOf = (r: { home: number; away: number }) => (r.home === myClub.value ? r.away : r.home);
const fmt = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
const mapOf = (seed: number) => w.fixtureMap(seed);   // each fixture's map (rotation over the pool)

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
const watchedMap = ref('ascent');
let viewer: Viewer | null = null;
// `mapOverride` forces the map (a playoff game runs on its veto map, not the
// seed-derived one); regular fixtures default to their own map.
function watch(r: NonNullable<typeof watching.value>, mapOverride?: string) {
  const map = (mapOverride ?? w.fixtureMap(r.seed)) as ReturnType<typeof w.fixtureMap>, nav = w.navOf(map); if (!nav) return;
  watching.value = r; watchedMap.value = map;
  // re-sim from the fixture seed at higher fork count for True Odds; buildInput
  // overlays YOUR comp + tactics + map affinity, so watching shows your plan.
  const out = simulateMatch(w.buildInput(r, r.seed, map), nav, 50);
  requestAnimationFrame(() => { viewer?.destroy(); if (watchHost.value) viewer = new Viewer(watchHost.value, out, `/${map}.png`, nav as any); });
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
        <b>{{ DIVS }} divisions · {{ N }} clubs</b>
        <span class="hq-day">Match-day {{ Math.min(dayIdx, total) }} / {{ total }}</span>
      </div>
      <div class="hq-tabs">
        <button :class="{ on: hqTab === 'season' }" @click="hqTab = 'season'">Season</button>
        <button :class="{ on: hqTab === 'squad' }" @click="hqTab = 'squad'">Squad &amp; Comp</button>
        <button :class="{ on: hqTab === 'market' }" @click="hqTab = 'market'">Market</button>
      </div>
      <div class="hq-actions">
        <button v-if="!done" class="hq-go" @click="w.resolveDay()">▶ Resolve match-day</button>
        <button v-else-if="!playoffs" class="hq-go po" @click="w.enterPlayoffs()">🏆 Enter playoffs</button>
        <button v-else class="hq-go" @click="advance">⟳ Advance to season {{ season + 1 }}</button>
        <button class="hq-alt" :disabled="done" @click="w.simSeason()">⏭ Sim to end</button>
        <button class="hq-alt" @click="newWorld">⟲ New world</button>
        <span class="hq-seed">seed {{ w.seasonSeed.value }}<i v-if="w.hasSave.value" class="hq-saved" title="your career autosaves to this browser">● saved</i></span>
      </div>
    </div>

    <!-- MARKET -->
    <Market v-if="hqTab === 'market'" />

    <!-- SQUAD & COMP -->
    <div v-else-if="hqTab === 'squad'" class="hq-squad">
      <Roster />
      <div class="hq-panel hq-comp">
        <h3><span class="b"></span>Comp <span class="rs-sub">field each starter's agent</span></h3>
        <div v-for="p in club(myClub).team.players" :key="p.id" class="hq-comprow">
          <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
          <span class="hq-cph">{{ p.handle }}</span>
          <select :value="pick(p)" @change="setComp(p, ($event.target as HTMLSelectElement).value)">
            <option v-for="ag in agentsFor(p)" :key="ag" :value="ag">{{ ag }}</option>
          </select>
          <span class="hq-mast" :class="{ off: masteryOf(p, pick(p)) < 50 }">
            {{ masteryOf(p, pick(p)) >= 50 ? 'mastery ' + masteryOf(p, pick(p)) : 'off-pool' }}
          </span>
        </div>
        <div class="hq-compnote">Your comp is fielded in your fixtures — only the starting five plays, so an off-pool pick (low mastery) hurts the duel + utility.</div>
      </div>
    </div>

    <!-- SEASON -->
    <template v-else>
    <!-- promotion/relegation summary — shown at the start of a fresh season -->
    <div v-if="lastMoves.length && !playoffs && dayIdx < total" class="hq-prbanner">
      <div v-if="lastMoves.some(m => m.club === myClub)" class="hq-prmine" :class="divOf(myClub) < (lastMoves.find(m => m.club === myClub)!.from) ? 'up' : 'down'">
        {{ divOf(myClub) < lastMoves.find(m => m.club === myClub)!.from ? `▲ Promoted to ${DIV_NAMES[divOf(myClub)]}!` : `▼ Relegated to ${DIV_NAMES[divOf(myClub)]}` }}
      </div>
      <div class="hq-prlist">
        <span class="hq-prh">{{ DIV_NAMES[myDivision] }} in &amp; out</span>
        <span v-for="m in nearMoves" :key="m.club" class="hq-prmove" :class="m.to < m.from ? 'up' : 'down'">
          {{ tagOf(m.club) }} {{ m.to < m.from ? '▲' : '▼' }}{{ m.to === myDivision ? ' in' : ' out' }}
        </span>
        <span v-if="!nearMoves.length" class="hq-prmove">no changes to your tier</span>
      </div>
    </div>
    <!-- playoff bracket (top 4, best of 3) — appears once the regular season ends -->
    <div v-if="playoffs" class="hq-panel hq-bracket">
      <h3><span class="b"></span>Playoffs <span class="rs-sub">top 4 · Bo3 semis · Bo5 final · map veto{{ playoffs.champion != null ? ` · champion ${tagOf(playoffs.champion)}` : '' }}</span></h3>
      <div class="po-cols">
        <div class="po-col">
          <div class="po-colh">Semifinals</div>
          <div v-for="s in playoffs.rounds[0]" :key="'sf'+s.slot" class="po-series">
            <div class="po-team" :class="{ win: s.winner === s.hi, me: s.hi === myClub, out: s.winner != null && s.winner !== s.hi }">
              <span class="po-seed">{{ seedNo(s.hi) }}</span><i class="hq-dot" :style="{ background: `hsl(${hue(s.hi)} 65% 55%)` }"></i>{{ tagOf(s.hi) }}<b>{{ s.wins[0] }}</b>
            </div>
            <div class="po-team" :class="{ win: s.winner === s.lo, me: s.lo === myClub, out: s.winner != null && s.winner !== s.lo }">
              <span class="po-seed">{{ seedNo(s.lo) }}</span><i class="hq-dot" :style="{ background: `hsl(${hue(s.lo)} 65% 55%)` }"></i>{{ tagOf(s.lo) }}<b>{{ s.wins[1] }}</b>
            </div>
            <div class="po-veto"><span class="po-need">Bo{{ s.need * 2 - 1 }}</span><span v-for="(v, vi) in s.veto" :key="vi" class="po-vstep" :class="v.action">{{ tagOf(v.team === 'hi' ? s.hi : s.lo) }}<i>{{ v.action === 'ban' ? '✕' : v.action === 'pick' ? '✓' : '◆' }}</i>{{ v.map }}</span></div>
            <div class="po-games"><button v-for="(g, gi) in s.games" :key="gi" class="po-game" @click="watch(g, s.maps[gi])" :title="`watch game ${gi + 1} · ${s.maps[gi]}`">G{{ gi + 1 }} <i>{{ s.maps[gi] }}</i></button></div>
          </div>
        </div>
        <div class="po-col">
          <div class="po-colh">Final</div>
          <div v-for="s in playoffs.rounds[1]" :key="'fn'+s.slot" class="po-series po-final">
            <div class="po-team" :class="{ win: s.winner === s.hi, me: s.hi === myClub, out: s.winner != null && s.winner !== s.hi }">
              <span class="po-seed">{{ seedNo(s.hi) }}</span><i class="hq-dot" :style="{ background: `hsl(${hue(s.hi)} 65% 55%)` }"></i>{{ tagOf(s.hi) }}<b>{{ s.wins[0] }}</b>
            </div>
            <div class="po-team" :class="{ win: s.winner === s.lo, me: s.lo === myClub, out: s.winner != null && s.winner !== s.lo }">
              <span class="po-seed">{{ seedNo(s.lo) }}</span><i class="hq-dot" :style="{ background: `hsl(${hue(s.lo)} 65% 55%)` }"></i>{{ tagOf(s.lo) }}<b>{{ s.wins[1] }}</b>
            </div>
            <div class="po-veto"><span class="po-need">Bo{{ s.need * 2 - 1 }}</span><span v-for="(v, vi) in s.veto" :key="vi" class="po-vstep" :class="v.action">{{ tagOf(v.team === 'hi' ? s.hi : s.lo) }}<i>{{ v.action === 'ban' ? '✕' : v.action === 'pick' ? '✓' : '◆' }}</i>{{ v.map }}</span></div>
            <div class="po-games"><button v-for="(g, gi) in s.games" :key="gi" class="po-game" @click="watch(g, s.maps[gi])" :title="`watch game ${gi + 1} · ${s.maps[gi]}`">G{{ gi + 1 }} <i>{{ s.maps[gi] }}</i></button></div>
          </div>
          <div v-if="playoffs.champion != null" class="po-champ" :class="{ me: playoffs.champion === myClub }">🏆 {{ cname(playoffs.champion) }} — champion</div>
        </div>
      </div>
      <div class="hq-compnote">The top four seed a single-elim bracket — <b>Bo3</b> semis, a <b>Bo5</b> final. Each series opens with a <b>map veto</b> (each club bans its weak maps and picks its comfort ones from the pool) — and clubs play a touch better on the maps they like. Click any <b>G</b> to watch that game on its map. Win it for the title; then <b>Advance</b> to settle the books.</div>
    </div>

    <div class="hq-grid">
      <!-- standings (per division, with a tier toggle) -->
      <div class="hq-panel hq-table">
        <h3><span class="b"></span>Standings
          <span class="hq-divsel">
            <button class="hq-divstep" :disabled="viewDiv === 0" @click="viewDiv--" title="higher tier">▲</button>
            <select v-model.number="viewDiv">
              <option v-for="(name, d) in DIV_NAMES" :key="d" :value="d">{{ name }}{{ d === myDivision ? ' — you' : '' }}</option>
            </select>
            <button class="hq-divstep" :disabled="viewDiv === DIVS - 1" @click="viewDiv++" title="lower tier">▼</button>
          </span>
        </h3>
        <div class="hq-trow hq-thead">
          <span class="r">#</span><span class="c">Club</span>
          <span>P</span><span>W</span><span>L</span><span>RF</span><span>RA</span><span>Δ</span><span class="pts">Pts</span>
        </div>
        <div v-for="(s, rank) in shownTable" :key="s.club" class="hq-trow" :class="[zoneOf(rank + 1), { me: s.club === myClub }]" @click="selectClub(s.club)">
          <span class="r">{{ rank + 1 }}</span>
          <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(s.club)} 65% 55%)` }"></i>{{ cname(s.club) }}</span>
          <span>{{ s.played }}</span><span>{{ s.won }}</span><span>{{ s.lost }}</span>
          <span>{{ s.rf }}</span><span>{{ s.ra }}</span>
          <span :class="s.diff >= 0 ? 'pos' : 'neg'">{{ s.diff >= 0 ? '+' : '' }}{{ s.diff }}</span>
          <span class="pts">{{ s.points }}</span>
        </div>
        <div class="hq-zonekey">
          <span v-if="viewDiv > 0"><i class="zk promo"></i>top {{ PROMO }} promote</span>
          <span v-if="viewDiv < DIVS - 1"><i class="zk releg"></i>bottom {{ PROMO }} relegate</span>
        </div>
      </div>

      <div class="hq-right">
        <!-- your club -->
        <div class="hq-panel hq-club">
          <h3><span class="b"></span>Your club</h3>
          <div class="hq-clubcard">
            <div class="hq-badge" :style="{ background: `hsl(${hue(myClub)} 60% 22%)`, borderColor: `hsl(${hue(myClub)} 65% 55%)` }">{{ tagOf(myClub) }}</div>
            <div class="hq-clubmeta">
              <div class="hq-clubname">{{ nameOf(myClub) }}<span v-if="titleCount(myClub)" class="hq-titles" :title="`${titleCount(myClub)} championship${titleCount(myClub) > 1 ? 's' : ''}`">{{ '🏆'.repeat(Math.min(5, titleCount(myClub))) }}<i v-if="titleCount(myClub) > 5">×{{ titleCount(myClub) }}</i></span></div>
              <div class="hq-clubsub">
                <span class="hq-tier" :class="{ top: myDivision === 0, semi: myDivision === 1 }">{{ DIV_NAMES[myDivision] }}</span>
                <span class="hq-pos">{{ w.rankOf(myClub) }}<sup>{{ ['st','nd','rd'][w.rankOf(myClub)-1] || 'th' }}</sup></span> of {{ DIV_SIZE }}
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
            <div v-if="ledger.playoff" class="hq-led"><span>Playoff bonus 🏆</span><b class="pos">+{{ fmt(ledger.playoff) }}</b></div>
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
            <span class="hq-rmap">{{ mapOf(r.seed) }}</span>
            <button class="hq-watch" @click="watch(r)">▷ watch</button>
          </div>
          <div v-if="!myResults.length && !nextFixture" class="hq-empty">season complete</div>
        </div>
      </div>
    </div>
    </template>

    <!-- the watched match -->
    <div v-if="watching" class="hq-watchwrap">
      <div class="hq-watchhead">
        <b>{{ tagOf(watching.home) }}</b> {{ watching.score[0] }} – {{ watching.score[1] }} <b>{{ tagOf(watching.away) }}</b>
        · <span class="hq-rmap">{{ watchedMap }}</span> · re-simmed from seed {{ watching.seed }}
        <button class="ed-close" @click="watching = null; viewer?.destroy(); viewer = null">close</button>
      </div>
      <div ref="watchHost" class="ace-host"></div>
    </div>
  </div>
</template>
