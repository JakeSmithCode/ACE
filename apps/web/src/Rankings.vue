<script setup lang="ts">
// World rankings — the whole league at a glance, across every division. POWER ranks
// clubs by current squad rating (who's best right now); HQ ranks by development
// infrastructure (who's built to last). Read together: a top-power / low-HQ club is
// a dynasty about to fade; a rising-HQ club is a future threat. Your club is pinned
// so you always see where you stand in the world.
import { computed, ref } from 'vue';
import { clubPhase } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const mode = ref<'power' | 'hq'>('power');
const DIV_NAMES = w.DIV_NAMES, INFRA_MAX = w.INFRA_MAX;
const tag = (i: number) => w.clubs.value[i].team.tag;
const name = (i: number) => w.clubs.value[i].team.name;
const hue = (i: number) => (tag(i).charCodeAt(0) * 47 + tag(i).charCodeAt(1) * 13) % 360;
const phase = (i: number) => clubPhase(w.clubs.value[i].team);
const PHASE_LABEL: Record<string, string> = { rebuilding: 'REBUILD', rising: 'RISING', prime: 'PRIME', aging: 'AGING' };

const board = computed(() => (mode.value === 'power' ? w.powerRanking.value : w.hqRanking.value));
const myRank = computed(() => w.rankInList(board.value, w.myClub.value));
// top 25 + your club pinned below if it's outside the cut
const rows = computed(() => {
  const top = board.value.slice(0, 25).map((r, idx) => ({ ...r, rank: idx + 1 }));
  if (myRank.value > 25) top.push({ ...board.value[myRank.value - 1], rank: myRank.value });
  return top;
});
</script>

<template>
  <div class="hq-panel rk">
    <h3><span class="b"></span>World Rankings
      <span class="rs-sub">all {{ w.N }} clubs · you are #{{ myRank }} by {{ mode === 'power' ? 'power' : 'HQ' }}</span>
      <span class="rk-toggle">
        <button :class="{ on: mode === 'power' }" @click="mode = 'power'">Power</button>
        <button :class="{ on: mode === 'hq' }" @click="mode = 'hq'">HQ</button>
      </span>
    </h3>
    <div class="rk-row rk-head">
      <span class="r">#</span><span class="c">Club</span><span class="d">Division</span>
      <span class="ph">Stage</span><span class="pw">OVR</span><span class="hq">HQ</span>
    </div>
    <template v-for="(r, i) in rows" :key="r.club">
      <div v-if="i > 0 && r.rank > rows[i - 1].rank + 1" class="rk-gap">···</div>
      <div class="rk-row" :class="{ me: r.club === w.myClub.value }">
        <span class="r">{{ r.rank }}</span>
        <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(r.club)} 65% 55%)` }"></i>{{ tag(r.club) }} · {{ name(r.club) }}</span>
        <span class="d">{{ DIV_NAMES[w.division.value[r.club]] }}</span>
        <span class="ph"><i class="hq-phase" :class="phase(r.club)">{{ PHASE_LABEL[phase(r.club)] }}</i></span>
        <span class="pw"><b>{{ r.rating }}</b></span>
        <span class="hq"><i class="hq-inf"><i v-for="n in INFRA_MAX" :key="n" :class="{ on: n <= r.hq }"></i></i></span>
      </div>
    </template>
    <div class="hq-compnote">Two lenses on the world: <b>Power</b> is who's strongest today, <b>HQ</b> is who's built to keep developing talent. A high-power, low-HQ club is a dynasty about to fade; a climbing-HQ club is a long-term threat. Spot an <b>aging</b> club near the top and raid its veterans in the Market while they rebuild.</div>
  </div>
</template>
