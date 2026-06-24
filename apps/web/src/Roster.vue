<script setup lang="ts">
// The squad screen — your five players as the three-layer model surfaces it:
// current ability (known), potential (a fogged star rating), age + career phase.
// After an off-season tick it shows the per-attribute deltas, so you watch a
// prospect break out and a veteran fade across a career.
import type { Attributes, Player, Team } from '@ace/shared';
import { overall, potentialOverall, phaseOf } from '@ace/world';

const props = defineProps<{ team: Team; prevById: Map<string, { age: number; attr: Attributes }> }>();

const ATTRS: { k: keyof Attributes; label: string }[] = [
  { k: 'aim', label: 'AIM' }, { k: 'movement', label: 'MOV' }, { k: 'gameSense', label: 'GS' },
  { k: 'utility', label: 'UTL' }, { k: 'clutch', label: 'CLT' }, { k: 'entry', label: 'ENT' },
];
const stars = (p: Player) => Math.max(1, Math.min(5, Math.round((potentialOverall(p) - 44) / 9)));
const delta = (p: Player, k: keyof Attributes) => {
  const prev = props.prevById.get(p.id);
  return prev ? p.attr[k] - prev.attr[k] : 0;
};
const sorted = () => [...props.team.players].sort((a, b) => overall(b) - overall(a));
</script>

<template>
  <div class="hq-panel rs">
    <h3><span class="b"></span>{{ team.tag }} · Squad <span class="rs-sub">current ability · potential (scouted) · age</span></h3>
    <div v-for="p in sorted()" :key="p.id" class="rs-row" :class="phaseOf(p)">
      <div class="rs-id">
        <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
        <div class="rs-name">{{ p.handle }}<i v-if="p.igl" class="rs-igl">IGL</i></div>
        <div class="rs-meta">
          age {{ p.age }} · <span class="rs-phase" :class="phaseOf(p)">{{ phaseOf(p) }}</span>
        </div>
      </div>
      <div class="rs-ovr">
        <div class="rs-ovrn">{{ overall(p) }}</div>
        <div class="rs-ovrl">OVR</div>
      </div>
      <div class="rs-pot">
        <div class="rs-stars"><span v-for="n in 5" :key="n" :class="{ on: n <= stars(p) }">★</span></div>
        <div class="rs-ovrl">POTENTIAL</div>
      </div>
      <div class="rs-attrs">
        <div v-for="a in ATTRS" :key="a.k" class="rs-attr">
          <div class="rs-abar"><i :style="{ width: p.attr[a.k] + '%' }" :class="{ mech: a.k === 'aim' || a.k === 'movement' || a.k === 'entry' }"></i></div>
          <div class="rs-aval">
            <span class="rs-alabel">{{ a.label }}</span>
            <b>{{ p.attr[a.k] }}</b>
            <span v-if="delta(p, a.k)" class="rs-delta" :class="delta(p, a.k) > 0 ? 'up' : 'dn'">{{ delta(p, a.k) > 0 ? '▲' : '▼' }}{{ Math.abs(delta(p, a.k)) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
