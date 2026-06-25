<script setup lang="ts">
// The squad screen — your full roster (matchday five + reserves). Potential is
// shown as a SCOUTED estimate (fogged stars + a confidence that's higher for
// older players you own), never the true ceiling. Start a reserve / bench a
// starter to override the auto lineup; sell or list to manage depth.
import type { Attributes, Player } from '@ace/shared';
import { overall, phaseOf, scoutedStars, scoutConfidence, scoutedRange } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const ATTRS: { k: keyof Attributes; label: string }[] = [
  { k: 'aim', label: 'AIM' }, { k: 'movement', label: 'MOV' }, { k: 'gameSense', label: 'GS' },
  { k: 'utility', label: 'UTL' }, { k: 'clutch', label: 'CLT' }, { k: 'entry', label: 'ENT' },
];
const money = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
const conf = (p: Player) => Math.round(scoutConfidence(p, true) * 100);
const ceiling = (p: Player) => { const [lo, hi] = scoutedRange(p, true); return lo === hi ? `${lo}` : `${lo}–${hi}`; };
const rnd = (n: number) => Math.round(n);
// ability is fractional in-season; round both sides so a delta only shows once a
// rounded point has actually moved (avoids ▲0 flicker from sub-point growth)
const delta = (p: Player, k: keyof Attributes) => {
  const prev = w.prevById.value.get(p.id);
  return prev ? Math.round(p.attr[k]) - Math.round(prev.attr[k]) : 0;
};
const order = (p: Player) => (w.isStarter(p.id) ? 0 : 1);
const sorted = () => [...w.myRoster.value].sort((a, b) => order(a) - order(b) || overall(b) - overall(a));
</script>

<template>
  <div class="hq-panel rs">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · Squad
      <span class="rs-sub">{{ w.myRoster.value.length }} players · best five start · potential is scouted (fogged)</span></h3>
    <div v-for="p in sorted()" :key="p.id" class="rs-row" :class="[phaseOf(p), { reserve: !w.isStarter(p.id), listed: w.isListed(p.id) }]">
      <div class="rs-id">
        <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
        <div class="rs-name">{{ p.handle }}
          <i v-if="w.isStarter(p.id)" class="rs-start">XI</i><i v-else class="rs-res">RES</i>
        </div>
        <div class="rs-meta">age {{ p.age }} · <span class="rs-phase" :class="phaseOf(p)">{{ phaseOf(p) }}</span></div>
      </div>
      <div class="rs-ovr"><div class="rs-ovrn">{{ overall(p) }}</div><div class="rs-ovrl">OVR</div></div>
      <div class="rs-pot">
        <div class="rs-stars"><span v-for="n in 5" :key="n" :class="{ on: n <= scoutedStars(p, true) }">★</span></div>
        <div class="rs-ovrl">CEIL <b class="rs-ceil">{{ ceiling(p) }}</b> · <span class="rs-conf" :class="{ lo: conf(p) < 55 }">{{ conf(p) }}%</span></div>
      </div>
      <div class="rs-attrs">
        <div v-for="a in ATTRS" :key="a.k" class="rs-attr">
          <div class="rs-abar"><i :style="{ width: p.attr[a.k] + '%' }" :class="{ mech: a.k === 'aim' || a.k === 'movement' || a.k === 'entry' }"></i></div>
          <div class="rs-aval">
            <span class="rs-alabel">{{ a.label }}</span><b>{{ rnd(p.attr[a.k]) }}</b>
            <span v-if="delta(p, a.k)" class="rs-delta" :class="delta(p, a.k) > 0 ? 'up' : 'dn'">{{ delta(p, a.k) > 0 ? '▲' : '▼' }}{{ Math.abs(delta(p, a.k)) }}</span>
          </div>
        </div>
      </div>
      <div class="rs-actions">
        <div class="rs-val">{{ money(w.value(p)) }}</div>
        <button v-if="w.isStarter(p.id)" class="rs-lx" :disabled="!w.canBench(p.id)" @click="w.benchStarter(p.id)" title="move to the reserves">bench</button>
        <button v-else class="rs-lx start" @click="w.startReserve(p.id)" title="start in the XI">start ▲</button>
        <button class="hq-list" :class="{ on: w.isListed(p.id) }" @click="w.toggleList(p.id)">{{ w.isListed(p.id) ? '● listed' : 'list' }}</button>
        <button class="rs-sell" :disabled="!w.canSell(p.id)" @click="w.sellPlayer(p.id)">sell</button>
      </div>
    </div>
    <div class="hq-compnote">Potential is a <b>scouted</b> read — confidence rises as a player ages and stays in your squad, so a young signing is a bet. Buy in the <b>Market</b> to add depth (best five start automatically); <b>start</b>/<b>bench</b> to override; sell or list to trim (never below a valid five).</div>
  </div>
</template>
