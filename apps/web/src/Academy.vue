<script setup lang="ts">
// The Academy — your homegrown youth pipeline. Build the wing (a money sink), take
// an annual intake of teenage prospects, develop them on the reps path (they grow
// without taking senior minutes), and graduate the hits into your roster — no fee.
// Prospects are the foggiest reads in the game: a wide ceiling band you only resolve
// by giving the kid reps. Some bust; the one that hits is worth ten times his wage.
import type { Player } from '@ace/shared';
import { ACADEMY_MAX, overall, soloRank, scoutedStars, scoutedRange, phaseOf, personOf, displayAge } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const money = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
const rank = (p: Player) => soloRank(overall(p));
const sl = (p: Player) => w.scoutLevelOf(p.id);
const ceiling = (p: Player) => { const [lo, hi] = scoutedRange(p, true, sl(p)); return lo === hi ? `${lo}` : `${lo}–${hi}`; };
// best in a role you already field — the bar a prospect must clear to start
const prospects = () => [...w.academy.value.prospects].sort((a, b) => overall(b) - overall(a));
</script>

<template>
  <div class="hq-panel fc ac">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · Academy
      <span class="rs-sub">balance {{ money(w.balance.value) }} · homegrown talent, no transfer fee</span></h3>

    <!-- the wing itself: an upgradeable facility that delivers a youth class a season -->
    <div class="fc-room">
      <div class="fc-info">
        <div class="fc-name">Youth Academy <span class="fc-tier">Lv {{ w.academy.value.level }}</span></div>
        <div class="fc-blurb">Scout and sign teenage prospects into your reserves — raw, cheap, and a gamble on potential.</div>
        <div class="fc-pips">
          <i v-for="n in ACADEMY_MAX" :key="n" class="fc-pip" :class="{ on: n <= w.academy.value.level }"></i>
          <span class="fc-eff" :class="{ none: w.academy.value.level === 0 }">{{ w.academy.value.level === 0 ? 'locked — no intake' : `${w.acadIntakeSize()} prospect${w.acadIntakeSize() > 1 ? 's' : ''} / season · higher talent floor` }}</span>
        </div>
      </div>
      <button class="fc-up" :disabled="!w.canUpgradeAcademy()" @click="w.upgradeAcademy()">
        <template v-if="w.academy.value.level >= ACADEMY_MAX">maxed</template>
        <template v-else>{{ w.academy.value.level === 0 ? 'build' : 'upgrade' }}<i>{{ money(w.acadCost()) }}</i></template>
      </button>
    </div>

    <!-- the prospects in residence -->
    <div v-if="prospects().length" class="ac-board">
      <div v-for="p in prospects()" :key="p.id" class="ac-row" :class="phaseOf(p)">
        <div class="rs-id">
          <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
          <div class="rs-name">{{ p.handle }} <i class="ac-age">age {{ displayAge(p.age, personOf(p.id).birthday, w.today.value) }}</i></div>
          <div class="rs-realname">{{ personOf(p.id).name }} · {{ personOf(p.id).nation.flag }}</div>
          <div class="rs-rank" :class="'rk-' + rank(p).tier.toLowerCase()"><i class="rs-rankdot"></i>{{ rank(p).label }}</div>
        </div>
        <div class="rs-ovr"><div class="rs-ovrn">{{ overall(p) }}</div><div class="rs-ovrl">OVR</div></div>
        <div class="rs-pot">
          <div class="rs-stars"><span v-for="n in 5" :key="n" :class="{ on: n <= scoutedStars(p, true, sl(p)) }">★</span></div>
          <div class="rs-ovrl">CEIL <b class="rs-ceil">{{ ceiling(p) }}</b></div>
          <button class="rs-scout" :disabled="!w.canScout(p.id)" @click="w.scoutPlayer(p.id)"
            :title="sl(p) >= w.SCOUT_MAX ? 'fully scouted' : 'commission a scouting report — clears the fog on this prospect'">
            <i class="rs-scoutpips"><i v-for="n in w.SCOUT_MAX" :key="n" :class="{ on: n <= sl(p) }"></i></i>
            <template v-if="sl(p) >= w.SCOUT_MAX">scouted</template>
            <template v-else>scout <b>{{ money(w.scoutCost(p.id)) }}</b></template>
          </button>
        </div>
        <div class="ac-actions">
          <button class="rs-lx start" @click="w.promoteProspect(p.id)" title="graduate into your senior roster">promote ▲</button>
          <button class="rs-sell" @click="w.releaseProspect(p.id)" title="cut from the academy">cut</button>
        </div>
      </div>
    </div>
    <div v-else class="ac-empty">{{ w.academy.value.level === 0 ? 'Build the academy to start scouting youth — a class arrives each season.' : 'No prospects in residence. Your next intake arrives at the start of the season.' }}</div>

    <div class="hq-compnote">Prospects develop on the <b>academy circuit</b> — they grow and never rust, but don't take senior minutes. <b>Promote</b> a kid into your roster (no fee) when he's ready to compete for the starting five; <b>cut</b> the busts. The ceiling is a <b>scouted band</b> — the only way to resolve it is to develop him.</div>
  </div>
</template>
