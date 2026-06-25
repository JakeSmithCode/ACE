<script setup lang="ts">
// The HQ — upgrade rooms (a money sink) to compound YOUR squad's development.
// Bootcamp speeds growth, Recovery slows decline, the Analyst Room realizes more
// ceiling and cuts bench rust. Out-invest your environment, out-develop everyone.
import { FACILITIES, FACILITY_MAX } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const money = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
</script>

<template>
  <div class="hq-panel fc">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · HQ Facilities
      <span class="rs-sub">balance {{ money(w.balance.value) }} · spend to compound development</span></h3>
    <div v-for="f in FACILITIES" :key="f.id" class="fc-room">
      <div class="fc-info">
        <div class="fc-name">{{ f.name }} <span class="fc-tier">Lv {{ w.facilities.value[f.id] }}</span></div>
        <div class="fc-blurb">{{ f.blurb }}</div>
        <div class="fc-pips">
          <i v-for="n in FACILITY_MAX" :key="n" class="fc-pip" :class="{ on: n <= w.facilities.value[f.id] }"></i>
          <span class="fc-eff" :class="{ none: w.facilities.value[f.id] === 0 }">{{ w.facilities.value[f.id] === 0 ? 'no bonus yet' : f.effect(w.facilities.value[f.id]) }}</span>
        </div>
      </div>
      <button class="fc-up" :disabled="!w.canUpgradeFacility(f.id)" @click="w.upgradeFacility(f.id)">
        <template v-if="w.facilities.value[f.id] >= FACILITY_MAX">maxed</template>
        <template v-else>upgrade<i>{{ money(w.facCost(f.id)) }}</i></template>
      </button>
    </div>
    <div class="hq-compnote">Your HQ boosts only <b>your</b> squad — the AI clubs don't have it. A maxed room is a multi-season investment competing with the transfer market, but it makes every prospect you develop pay off bigger.</div>
  </div>
</template>
