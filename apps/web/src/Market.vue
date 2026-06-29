<script setup lang="ts">
// The always-open transfer market. Free agents AND players other clubs have put
// up for sale, all live, every match-day. Potential is a SCOUTED read (fogged
// stars, never the true ceiling) and price tracks the live META — a player who
// mains a buffed agent is dearer, a nerfed one cheaper. Filter by role.
import { computed, ref } from 'vue';
import type { Player, Role } from '@ace/shared';
import { overall, scoutedStars, scoutedRange, soloRank, personOf, displayAge } from '@ace/world';
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

// --- bidding: a contested player clears above his asking price ---------------
const tagOf = (i: number) => w.clubs.value[i].team.tag;
const bidId = ref<string | null>(null);   // the player you're bidding on
const bidAmtK = ref(0);                    // your current offer, in $k
const bidMsg = ref('');
const bidWarn = ref(false);
const toK = (n: number) => Math.round(n / 100) / 10;   // dollars → $k (1 dp)
function openBid(e: MarketEntry) {
  bidId.value = e.player.id;
  bidAmtK.value = toK(w.askingOf(e));
  bidWarn.value = false;
  bidMsg.value = w.isContested(e) ? 'Contested — rival clubs are in for this player.' : 'No other bidders — sign at asking.';
}
function submitBid(e: MarketEntry) {
  const res = w.bidFor(e, Math.round(bidAmtK.value * 1000));
  bidWarn.value = true;
  if (res.won) { bidId.value = null; bidMsg.value = ''; }
  else if (res.broke) bidMsg.value = 'Not enough in the bank for that bid.';
  else if (res.below) bidMsg.value = `Below the asking price — bid at least ${money(res.leadBid!)}.`;
  else if (res.leader != null) {
    bidMsg.value = `Outbid by ${tagOf(res.leader)} at ${money(res.leadBid!)} — raise above it to win.`;
    bidAmtK.value = Math.ceil((res.leadBid! + Math.max(500, res.leadBid! * 0.05)) / 100) / 10;
  }
}
function cancelBid() { bidId.value = null; bidMsg.value = ''; }
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
    <template v-for="e in listed" :key="e.player.id">
      <div class="mk-row" :class="{ bidding: bidId === e.player.id }">
        <span class="c">
          <span class="rs-role" :class="e.player.role">{{ e.player.role.slice(0,3).toUpperCase() }}</span>
          <b>{{ e.player.handle }}</b>
          <i class="rs-rank mk-rank" :class="'rk-' + rank(e.player).tier.toLowerCase()"><i class="rs-rankdot"></i>{{ rank(e.player).label }}</i>
          <i v-if="metaClass(e.player)" class="mk-meta" :class="metaClass(e.player)">{{ mainAgent(e.player) }} {{ metaClass(e.player) === 'buff' ? '▲' : '▼' }}</i>
          <i v-if="w.isContested(e)" class="mk-fire" title="contested — rival clubs are bidding">🔥</i>
        </span>
        <span class="src" :class="{ club: e.from !== -1 }">{{ sourceOf(e) }}</span>
        <span :title="`${personOf(e.player.id).name} · 🎂 ${personOf(e.player.id).birthday.day}/${personOf(e.player.id).birthday.month}`">{{ displayAge(e.player.age, personOf(e.player.id).birthday, w.today.value) }}</span>
        <span class="ovr">{{ overall(e.player) }}</span>
        <span class="mk-pot"><span class="rs-stars"><i v-for="n in 5" :key="n" :class="{ on: n <= scoutedStars(e.player, false) }">★</i></span><i class="mk-ceil">{{ ceil(e.player) }}</i></span>
        <span class="fe" :class="metaClass(e.player)">{{ money(w.value(e.player)) }}</span>
        <span class="vs">{{ w.myPlayerOf(e.player.role)?.handle }} <i>{{ overall(w.myPlayerOf(e.player.role)!) }}</i></span>
        <button class="mk-sign" :disabled="w.balance.value < w.askingOf(e)" @click="openBid(e)">
          {{ overall(e.player) > overall(w.myPlayerOf(e.player.role)!) ? 'bid ▲' : 'bid' }}
        </button>
      </div>
      <div v-if="bidId === e.player.id" class="mk-bid">
        <span class="mk-bidlbl">Your offer</span>
        <span class="mk-bidinput">$<input type="number" v-model.number="bidAmtK" step="0.5" min="0" @keyup.enter="submitBid(e)" />k</span>
        <button class="mk-bidgo" @click="submitBid(e)">offer</button>
        <button class="mk-bidx" @click="cancelBid">cancel</button>
        <span v-if="bidMsg" class="mk-bidmsg" :class="{ warn: bidWarn }">{{ bidMsg }}</span>
      </div>
    </template>
    <div class="hq-compnote">The market never closes — bid any match-day. A <b class="mk-fire">🔥</b> player is <b>contested</b>: rival clubs are bidding, and you'll have to clear their offer to sign him (a hungry rising club pays a premium). Potential is a <b>scouted</b> star read (fogged); price tracks the <b>live meta</b>. A signing <b>adds</b> the player (no one is dropped); the seller banks your winning bid. Trim depth in <b>Squad &amp; Comp</b>.</div>
  </div>
</template>
