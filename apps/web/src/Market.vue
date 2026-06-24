<script setup lang="ts">
// The always-open transfer market. Free agents AND players other clubs have put
// up for sale, all live, every match-day. Signing is a swap against your same-
// role player: you pay the value difference, and a club deal sends your player
// the other way. Filter by role.
import { computed, ref } from 'vue';
import type { Player, Role } from '@ace/shared';
import { overall, potentialOverall, playerValue } from '@ace/world';
import { useWorld, type MarketEntry } from './world';

const w = useWorld();
const money = (n: number) => '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
const fmt = (n: number) => (n < 0 ? '−$' : '$') + (Math.abs(n) / 1000).toFixed(1) + 'k';
const stars = (p: Player) => Math.max(1, Math.min(5, Math.round((potentialOverall(p) - 44) / 9)));
const roles: (Role | 'all')[] = ['all', 'duelist', 'initiator', 'controller', 'sentinel'];
const filter = ref<Role | 'all'>('all');
const listed = computed(() => {
  const r = filter.value;
  return [...w.market.value]
    .filter(e => r === 'all' || e.player.role === r)
    .sort((a, b) => playerValue(b.player) - playerValue(a.player));
});
const sourceOf = (e: MarketEntry) => e.from === -1 ? 'free agent' : w.clubs.value[e.from].team.tag;
</script>

<template>
  <div class="hq-panel mk">
    <h3>
      <span class="b"></span>Transfer market <span class="mk-open">always open</span>
      <span class="mk-bal">balance <b :class="{ neg: w.balance.value < 0 }">{{ fmt(w.balance.value) }}</b></span>
    </h3>
    <div class="mk-filters">
      <button v-for="r in roles" :key="r" :class="{ on: filter === r }" @click="filter = r">{{ r }}</button>
    </div>
    <div class="mk-row mk-head">
      <span class="c">Player</span><span class="src">From</span><span>Age</span><span>OVR</span><span>Potential</span><span>Value</span><span class="vs">Your {{ filter === 'all' ? 'player' : filter }}</span><span class="fe">Fee</span><span></span>
    </div>
    <div v-for="e in listed" :key="e.player.id" class="mk-row">
      <span class="c"><span class="rs-role" :class="e.player.role">{{ e.player.role.slice(0,3).toUpperCase() }}</span><b>{{ e.player.handle }}</b></span>
      <span class="src" :class="{ club: e.from !== -1 }">{{ sourceOf(e) }}</span>
      <span>{{ e.player.age }}</span>
      <span class="ovr">{{ overall(e.player) }}</span>
      <span class="rs-stars"><i v-for="n in 5" :key="n" :class="{ on: n <= stars(e.player) }">★</i></span>
      <span>{{ money(playerValue(e.player)) }}</span>
      <span class="vs">{{ w.myPlayerOf(e.player.role)?.handle }} <i>{{ overall(w.myPlayerOf(e.player.role)!) }}</i></span>
      <span class="fe" :class="w.netFee(e) > 0 ? 'neg' : 'pos'">{{ w.netFee(e) > 0 ? '−' : '+' }}{{ money(w.netFee(e)) }}</span>
      <button class="mk-sign" :disabled="!w.canAfford(e)" @click="w.acquire(e)">
        {{ overall(e.player) > overall(w.myPlayerOf(e.player.role)!) ? 'sign ▲' : 'sign' }}
      </button>
    </div>
    <div class="hq-compnote">The market never closes — buy any match-day. A signing is a cash buy: your same-role player is released to free agency, and a club you buy from banks the fee and restocks from the market. List your own players in <b>Squad &amp; Comp</b>; a rival who'd upgrade may buy one between match-days.</div>
  </div>
</template>
