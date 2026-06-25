<script setup lang="ts">
// The always-open transfer market. Free agents AND players other clubs have put
// up for sale, all live, every match-day. Potential is a SCOUTED read (fogged
// stars, never the true ceiling) and price tracks the live META — a player who
// mains a buffed agent is dearer, a nerfed one cheaper. Filter by role.
import { computed, ref } from 'vue';
import type { Player, Role } from '@ace/shared';
import { overall, scoutedStars, scoutedRange, soloRank } from '@ace/world';
import { useWorld, type MarketEntry } from './world';

const w = useWorld();
const money = (n: number) => '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
const fmt = (n: number) => (n < 0 ? '−$' : '$') + (Math.abs(n) / 1000).toFixed(1) + 'k';
const roles: (Role | 'all')[] = ['all', 'duelist', 'initiator', 'controller', 'sentinel'];
const filter = ref<Role | 'all'>('all');
const listed = computed(() => {
  const r = filter.value;
  return [...w.market.value]
    .filter(e => r === 'all' || e.player.role === r)
    .sort((a, b) => w.value(b.player) - w.value(a.player));
});
const sourceOf = (e: MarketEntry) => e.from === -1 ? 'free agent' : w.clubs.value[e.from].team.tag;
const ceil = (p: Player) => { const [lo, hi] = scoutedRange(p, false); return lo === hi ? `${lo}` : `${lo}–${hi}`; };
const rank = (p: Player) => soloRank(overall(p));
// the player's main agent and how the live patch rates it (drives the meta tag)
const mainAgent = (p: Player) => [...p.agents].sort((a, b) => b.level - a.level)[0]?.agent ?? '';
const metaTier = (p: Player) => w.patch.value.agentTier[mainAgent(p)] ?? 1;
const metaClass = (p: Player) => { const t = metaTier(p); return t >= 1.05 ? 'buff' : t <= 0.95 ? 'nerf' : ''; };
// the off-season patch notes, biggest swing first
const notes = computed(() => [...w.metaChanges.value].sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)));
</script>

<template>
  <div class="hq-panel mk">
    <h3>
      <span class="b"></span>Transfer market <span class="mk-open">always open</span>
      <span class="mk-bal">balance <b :class="{ neg: w.balance.value < 0 }">{{ fmt(w.balance.value) }}</b></span>
    </h3>

    <div v-if="notes.length" class="mk-patch">
      <span class="mk-patch-h">PATCH {{ w.season.value }}.0</span>
      <span v-for="c in notes" :key="c.agent" class="mk-note" :class="c.to >= c.from ? 'buff' : 'nerf'">
        {{ c.agent }} <i>{{ c.to >= c.from ? '▲' : '▼' }}</i>
      </span>
    </div>

    <div class="mk-filters">
      <button v-for="r in roles" :key="r" :class="{ on: filter === r }" @click="filter = r">{{ r }}</button>
    </div>
    <div class="mk-row mk-head">
      <span class="c">Player</span><span class="src">From</span><span>Age</span><span>OVR</span><span>Potential</span><span class="fe">Price</span><span class="vs">Your best {{ filter === 'all' ? '' : filter }}</span><span></span>
    </div>
    <div v-for="e in listed" :key="e.player.id" class="mk-row">
      <span class="c">
        <span class="rs-role" :class="e.player.role">{{ e.player.role.slice(0,3).toUpperCase() }}</span>
        <b>{{ e.player.handle }}</b>
        <i class="rs-rank mk-rank" :class="'rk-' + rank(e.player).tier.toLowerCase()"><i class="rs-rankdot"></i>{{ rank(e.player).label }}</i>
        <i v-if="metaClass(e.player)" class="mk-meta" :class="metaClass(e.player)">{{ mainAgent(e.player) }} {{ metaClass(e.player) === 'buff' ? '▲' : '▼' }}</i>
      </span>
      <span class="src" :class="{ club: e.from !== -1 }">{{ sourceOf(e) }}</span>
      <span>{{ e.player.age }}</span>
      <span class="ovr">{{ overall(e.player) }}</span>
      <span class="mk-pot"><span class="rs-stars"><i v-for="n in 5" :key="n" :class="{ on: n <= scoutedStars(e.player, false) }">★</i></span><i class="mk-ceil">{{ ceil(e.player) }}</i></span>
      <span class="fe" :class="metaClass(e.player)">{{ money(w.value(e.player)) }}</span>
      <span class="vs">{{ w.myPlayerOf(e.player.role)?.handle }} <i>{{ overall(w.myPlayerOf(e.player.role)!) }}</i></span>
      <button class="mk-sign" :disabled="!w.canAfford(e)" @click="w.acquire(e)">
        {{ overall(e.player) > overall(w.myPlayerOf(e.player.role)!) ? 'buy ▲' : 'buy' }}
      </button>
    </div>
    <div class="hq-compnote">The market never closes — buy any match-day. Potential is a <b>scouted</b> star read (fogged, not the true ceiling) and price tracks the <b>live meta</b> (a buffed agent's mains cost more). A buy <b>adds</b> the player to your squad (no one is dropped); a club you buy from banks the fee and restocks. Trim depth in <b>Squad &amp; Comp</b>.</div>
  </div>
</template>
