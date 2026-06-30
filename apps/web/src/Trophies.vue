<script setup lang="ts">
// The Trophy Room — your career's silverware cabinet. Aggregates the career ledger
// (one record per season: where you finished, titles lifted, promotions, briefs met)
// plus your players' individual awards into a legacy showcase. Pure store/UI state.
import { computed } from 'vue';
import { useWorld } from './world';

const w = useWorld();
const log = computed(() => w.careerLog.value);
const seasons = computed(() => log.value.length);
const titles = computed(() => log.value.filter(s => s.champion));
const promotions = computed(() => log.value.filter(s => s.promoted));
const cups = computed(() => log.value.filter(s => s.cup));
const briefs = computed(() => log.value.filter(s => s.objMet).length);
const relegations = computed(() => log.value.filter(s => s.relegated).length);
// best league finish + highest tier reached across the career (lower tier index = higher)
const bestFinish = computed(() => log.value.length ? Math.min(...log.value.map(s => s.finish)) : 0);
const peakTier = computed(() => log.value.length ? Math.min(...log.value.map(s => s.tier)) : w.myDivision.value);
// your players' individual honours (MVP / Young Gun / Most Improved) across the career
const myAwards = computed(() => {
  const out: { season: number; kind: string; handle: string; note?: string }[] = [];
  for (const a of w.awardsHistory.value) {
    if (a.mvp?.mine) out.push({ season: a.season, kind: 'MVP', handle: a.mvp.handle });
    if (a.young?.mine) out.push({ season: a.season, kind: 'Young Gun', handle: a.young.handle });
    if (a.improved?.mine) out.push({ season: a.season, kind: 'Most Improved', handle: a.improved.handle, note: a.improved.note });
  }
  return out;
});
const derby = computed(() => w.derbyRecord.value);
const rivalTag = computed(() => w.rivalId.value != null ? w.clubs.value[w.rivalId.value].team.tag : null);
const ord = (n: number) => `${n}${['st', 'nd', 'rd'][n - 1] || 'th'}`;
const empty = computed(() => !log.value.length);
</script>

<template>
  <div class="hq-panel tr">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · Trophy Room
      <span class="rs-sub">{{ seasons }} season{{ seasons === 1 ? '' : 's' }} managed · the cabinet</span></h3>

    <div v-if="empty" class="tr-empty">
      <div class="tr-emptyicon">🏆</div>
      <p>The cabinet is bare. Win your division's playoff for a <b>league title</b>, climb a tier for a <b>promotion</b>, or hit the board's brief — your silverware shows up here.</p>
    </div>

    <template v-else>
      <!-- the silverware cabinet -->
      <div class="tr-cabinet">
        <div class="tr-cab gold" :class="{ on: titles.length }">
          <div class="tr-cabicon">🏆</div>
          <div class="tr-cabn">{{ titles.length }}</div>
          <div class="tr-cabl">League title{{ titles.length === 1 ? '' : 's' }}</div>
        </div>
        <div class="tr-cab gold" :class="{ on: cups.length }">
          <div class="tr-cabicon">🏆</div>
          <div class="tr-cabn">{{ cups.length }}</div>
          <div class="tr-cabl">{{ w.cupName }}{{ cups.length === 1 ? '' : 's' }}</div>
        </div>
        <div class="tr-cab green" :class="{ on: promotions.length }">
          <div class="tr-cabicon">▲</div>
          <div class="tr-cabn">{{ promotions.length }}</div>
          <div class="tr-cabl">Promotion{{ promotions.length === 1 ? '' : 's' }}</div>
        </div>
        <div class="tr-cab blue" :class="{ on: briefs }">
          <div class="tr-cabicon">⌖</div>
          <div class="tr-cabn">{{ briefs }}</div>
          <div class="tr-cabl">Briefs met</div>
        </div>
        <div class="tr-cab" :class="{ on: myAwards.length }">
          <div class="tr-cabicon">🏅</div>
          <div class="tr-cabn">{{ myAwards.length }}</div>
          <div class="tr-cabl">Player awards</div>
        </div>
      </div>

      <!-- career records -->
      <div class="tr-records">
        <div class="tr-rec"><i>Best finish</i><b>{{ bestFinish ? ord(bestFinish) : '—' }}</b></div>
        <div class="tr-rec"><i>Peak division</i><b>{{ w.DIV_NAMES[peakTier] }}</b></div>
        <div class="tr-rec"><i>Now in</i><b>{{ w.DIV_NAMES[w.myDivision.value] }}</b></div>
        <div v-if="rivalTag" class="tr-rec"><i>Derby vs {{ rivalTag }}</i><b :class="derby.w >= derby.l ? 'pos' : 'neg'">{{ derby.w }}–{{ derby.l }}</b></div>
        <div v-if="relegations" class="tr-rec"><i>Relegations</i><b class="neg">{{ relegations }}</b></div>
      </div>

      <!-- player awards shelf -->
      <div v-if="myAwards.length" class="tr-shelf">
        <div class="tr-shelfh">🏅 Individual honours</div>
        <div class="tr-medals">
          <span v-for="(a, i) in myAwards" :key="i" class="tr-medal" :class="a.kind === 'MVP' ? 'mvp' : a.kind === 'Young Gun' ? 'young' : 'imp'">
            <b>{{ a.handle }}</b> <i>{{ a.kind }}</i> <em>S{{ a.season }}{{ a.note ? ` · ${a.note}` : '' }}</em>
          </span>
        </div>
      </div>

      <!-- career ledger: one row per season -->
      <div class="tr-ledger">
        <div class="tr-ledgerh">Career ledger</div>
        <div v-for="s in log" :key="s.season" class="tr-row" :class="{ champ: s.champion }">
          <span class="tr-season">S{{ s.season }}</span>
          <span class="tr-div">{{ s.divName }}</span>
          <span class="tr-finish">finished {{ ord(s.finish) }}</span>
          <span class="tr-badges">
            <i v-if="s.champion" class="tr-badge champ" title="playoff champion">🏆 Champions</i>
            <i v-if="s.cup" class="tr-badge champ" :title="`${w.cupName} winners`">🏆 {{ w.cupName }}</i>
            <i v-if="s.promoted" class="tr-badge promo" title="promoted">▲ Promoted</i>
            <i v-if="s.relegated" class="tr-badge releg" title="relegated">▼ Relegated</i>
            <i v-if="s.objMet" class="tr-badge brief" title="board objective met">✓ Brief</i>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
