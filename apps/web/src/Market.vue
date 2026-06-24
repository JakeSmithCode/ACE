<script setup lang="ts">
// Transfer market — what gives your balance a purpose. Browse free agents,
// compare against your same-role player, and sign one in (a swap: you pay the
// net fee, the player you replace is released to the pool). Filter by role.
import { computed, ref } from 'vue';
import type { Player, Role } from '@ace/shared';
import { overall, potentialOverall, playerValue } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const fmt = (n: number) => (n < 0 ? '−$' : '$') + (Math.abs(n) / 1000).toFixed(1) + 'k';
const money = (n: number) => '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';   // magnitude only
const stars = (p: Player) => Math.max(1, Math.min(5, Math.round((potentialOverall(p) - 44) / 9)));
const roles: (Role | 'all')[] = ['all', 'duelist', 'initiator', 'controller', 'sentinel'];
const filter = ref<Role | 'all'>('all');
const listed = computed(() => {
  const r = filter.value;
  return [...w.market.value]
    .filter(p => r === 'all' || p.role === r)
    .sort((a, b) => playerValue(b) - playerValue(a));
});
const fee = (p: Player) => w.netFee(p);
function sign(p: Player) { if (w.canAfford(p)) w.signPlayer(p); }
</script>

<template>
  <div class="hq-panel mk">
    <h3>
      <span class="b"></span>Transfer market
      <span class="mk-bal">balance <b :class="{ neg: w.balance.value < 0 }">{{ fmt(w.balance.value) }}</b></span>
    </h3>
    <div class="mk-filters">
      <button v-for="r in roles" :key="r" :class="{ on: filter === r }" @click="filter = r">{{ r }}</button>
    </div>
    <div class="mk-row mk-head">
      <span class="c">Free agent</span><span>Age</span><span>OVR</span><span>Potential</span><span>Value</span><span class="vs">Your {{ filter === 'all' ? 'player' : filter }}</span><span class="fe">Fee</span><span></span>
    </div>
    <div v-for="p in listed" :key="p.id" class="mk-row">
      <span class="c"><span class="rs-role" :class="p.role">{{ p.role.slice(0,3).toUpperCase() }}</span><b>{{ p.handle }}</b></span>
      <span>{{ p.age }}</span>
      <span class="ovr">{{ overall(p) }}</span>
      <span class="rs-stars"><i v-for="n in 5" :key="n" :class="{ on: n <= stars(p) }">★</i></span>
      <span>{{ money(playerValue(p)) }}</span>
      <span class="vs">{{ w.myPlayerOf(p.role)?.handle }} <i>{{ overall(w.myPlayerOf(p.role)!) }}</i></span>
      <span class="fe" :class="fee(p) > 0 ? 'neg' : 'pos'">{{ fee(p) > 0 ? '−' : '+' }}{{ money(fee(p)) }}</span>
      <button class="mk-sign" :disabled="!w.canAfford(p)" @click="sign(p)">
        {{ overall(p) > overall(w.myPlayerOf(p.role)!) ? 'sign ▲' : 'sign' }}
      </button>
    </div>
    <div class="hq-compnote">Signing swaps the player into your squad and releases your current one. The fee is the difference in value — sell an ageing star to fund a young prospect.</div>
  </div>
</template>
