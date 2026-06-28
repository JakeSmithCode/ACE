<script setup lang="ts">
// Backroom staff — hire a Head Coach / Performance Analyst / Sports Psychologist from a
// seasonal shortlist. Each boosts a DISTINCT system (development / scouting+upside /
// fitness+morale) and draws a recurring wage — a personnel bet competing with transfers
// and facility upkeep. The hired staff fold into the existing dev/scout/fitness levers.
import { STAFF_META, type StaffRole, type StaffMember } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
const money = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
const roles = w.STAFF_ROLES as StaffRole[];
const stars = (r: number) => '★'.repeat(r) + '☆'.repeat(5 - r);
const isHired = (m: StaffMember) => w.hiredStaff(m.role)?.id === m.id;
</script>

<template>
  <div class="hq-panel sf">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · Backroom Staff
      <span class="rs-sub">wage bill {{ money(w.staffWages.value) }}/season · each hire boosts a different system</span></h3>
    <div v-for="role in roles" :key="role" class="sf-role">
      <div class="sf-rolehead">
        <div class="sf-roletitle">{{ STAFF_META[role].title }}<span class="sf-roleblurb">{{ STAFF_META[role].blurb }}</span></div>
        <div v-if="w.hiredStaff(role)" class="sf-current">
          <span class="sf-curname">{{ w.hiredStaff(role)!.name }}</span>
          <span class="sf-curstars">{{ stars(w.hiredStaff(role)!.rating) }}</span>
          <span class="sf-curwage">{{ money(w.hiredStaff(role)!.wage) }}/yr</span>
          <button class="sf-fire" @click="w.fireStaff(role)" title="release this staff member">release</button>
        </div>
        <div v-else class="sf-vacant">vacant — no bonus</div>
      </div>
      <div class="sf-shortlist">
        <div v-for="m in w.staffMkt.value[role]" :key="m.id" class="sf-cand" :class="{ hired: isHired(m) }">
          <span class="sf-candname">{{ m.name }}</span>
          <span class="sf-candstars" :class="'r' + m.rating">{{ stars(m.rating) }}</span>
          <span class="sf-candwage">{{ money(m.wage) }}/yr</span>
          <button class="sf-hire" :disabled="isHired(m)" @click="w.hireStaff(m)">{{ isHired(m) ? '● hired' : 'hire' }}</button>
        </div>
      </div>
    </div>
    <div class="hq-compnote">Staff are a <b>personnel</b> layer over the HQ rooms — they <b>stack</b> with facilities. A <b>Head Coach</b> speeds development, a <b>Performance Analyst</b> cuts scouting cost and lifts the ceiling cloud, a <b>Sports Psychologist</b> slows fatigue and cuts injuries. A better hire costs more wage each season — a real call against transfers and facility upkeep.</div>
  </div>
</template>
