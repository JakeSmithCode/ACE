<script setup lang="ts">
// The squad screen — your full roster (the matchday five + reserves). Shows the
// three-layer model (current ability, fogged potential, age + phase) with the
// off-season deltas, plus depth management: list a player for sale or sell them
// outright (you can't sell below a valid five).
import type { Attributes, Player } from '@ace/shared';
import { overall, potentialOverall, phaseOf, playerValue } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const ATTRS: { k: keyof Attributes; label: string }[] = [
  { k: 'aim', label: 'AIM' }, { k: 'movement', label: 'MOV' }, { k: 'gameSense', label: 'GS' },
  { k: 'utility', label: 'UTL' }, { k: 'clutch', label: 'CLT' }, { k: 'entry', label: 'ENT' },
];
const money = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
const stars = (p: Player) => Math.max(1, Math.min(5, Math.round((potentialOverall(p) - 44) / 9)));
const delta = (p: Player, k: keyof Attributes) => {
  const prev = w.prevById.value.get(p.id);
  return prev ? p.attr[k] - prev.attr[k] : 0;
};
// starters first (by role order), then reserves, each by overall
const order = (p: Player) => (w.isStarter(p.id) ? 0 : 1);
const sorted = () => [...w.myRoster.value].sort((a, b) => order(a) - order(b) || overall(b) - overall(a));
</script>

<template>
  <div class="hq-panel rs">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · Squad
      <span class="rs-sub">{{ w.myRoster.value.length }} players · best five start · reserves are depth</span></h3>
    <div v-for="p in sorted()" :key="p.id" class="rs-row" :class="[phaseOf(p), { reserve: !w.isStarter(p.id), listed: w.isListed(p.id) }]">
      <div class="rs-id">
        <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
        <div class="rs-name">{{ p.handle }}
          <i v-if="w.isStarter(p.id)" class="rs-start">XI</i><i v-else class="rs-res">RES</i>
        </div>
        <div class="rs-meta">age {{ p.age }} · <span class="rs-phase" :class="phaseOf(p)">{{ phaseOf(p) }}</span></div>
      </div>
      <div class="rs-ovr"><div class="rs-ovrn">{{ overall(p) }}</div><div class="rs-ovrl">OVR</div></div>
      <div class="rs-pot"><div class="rs-stars"><span v-for="n in 5" :key="n" :class="{ on: n <= stars(p) }">★</span></div><div class="rs-ovrl">POTENTIAL</div></div>
      <div class="rs-attrs">
        <div v-for="a in ATTRS" :key="a.k" class="rs-attr">
          <div class="rs-abar"><i :style="{ width: p.attr[a.k] + '%' }" :class="{ mech: a.k === 'aim' || a.k === 'movement' || a.k === 'entry' }"></i></div>
          <div class="rs-aval">
            <span class="rs-alabel">{{ a.label }}</span><b>{{ p.attr[a.k] }}</b>
            <span v-if="delta(p, a.k)" class="rs-delta" :class="delta(p, a.k) > 0 ? 'up' : 'dn'">{{ delta(p, a.k) > 0 ? '▲' : '▼' }}{{ Math.abs(delta(p, a.k)) }}</span>
          </div>
        </div>
      </div>
      <div class="rs-actions">
        <div class="rs-val">{{ money(playerValue(p)) }}</div>
        <button class="hq-list" :class="{ on: w.isListed(p.id) }" @click="w.toggleList(p.id)">{{ w.isListed(p.id) ? '● listed' : 'list' }}</button>
        <button class="rs-sell" :disabled="!w.canSell(p.id)" @click="w.sellPlayer(p.id)" :title="w.canSell(p.id) ? 'sell for ' + money(playerValue(p)) : 'need cover at this role'">sell</button>
      </div>
    </div>
    <div class="hq-compnote">Buy in the <b>Market</b> to add depth — the best five at each role start automatically. Sell a player for their value (you can't drop below a valid five), or <b>list</b> them so a rival might buy between match-days.</div>
  </div>
</template>
