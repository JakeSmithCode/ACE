<script setup lang="ts">
// The squad screen — your full roster (matchday five + reserves). Potential is
// shown as a SCOUTED estimate (fogged stars + a confidence that's higher for
// older players you own), never the true ceiling. Start a reserve / bench a
// starter to override the auto lineup; sell or list to manage depth.
import { ref, nextTick } from 'vue';
import type { Attributes, Player } from '@ace/shared';
import { overall, phaseOf, scoutedStars, scoutConfidence, scoutedRange, scoutedAttr, soloRank, traitOf, personOf, displayAge, fmtDayMonth, birthdayPassed } from '@ace/world';
import { useWorld } from './world';

const w = useWorld();
// rename a player's gamertag (in-game name)
const editing = ref<string | null>(null);
const draft = ref('');
const gamertag = (p: Player) => w.handleOf(p.id, p.handle);
async function startEdit(p: Player) { editing.value = p.id; draft.value = gamertag(p); await nextTick(); (document.getElementById('rs-edit-' + p.id) as HTMLInputElement)?.select(); }
function commitEdit(p: Player) { if (editing.value === p.id) { w.renamePlayer(p.id, draft.value); editing.value = null; } }
// player profile card (a full dossier on one of your players)
const profile = ref<Player | null>(null);
const awardsFor = (p: Player) => {
  const tag = gamertag(p), out: { kind: string; season: number; note?: string }[] = [];
  for (const a of w.awardsHistory.value) {
    if (a.mvp?.mine && a.mvp.handle === tag) out.push({ kind: 'Division MVP', season: a.season });
    if (a.young?.mine && a.young.handle === tag) out.push({ kind: 'Young Gun', season: a.season });
    if (a.improved?.mine && a.improved.handle === tag) out.push({ kind: 'Most Improved', season: a.season, note: a.improved.note });
  }
  return out;
};
const ATTRS: { k: keyof Attributes; label: string }[] = [
  { k: 'aim', label: 'AIM' }, { k: 'movement', label: 'MOV' }, { k: 'gameSense', label: 'GS' },
  { k: 'utility', label: 'UTL' }, { k: 'clutch', label: 'CLT' }, { k: 'entry', label: 'ENT' },
];
const money = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
const sl = (p: Player) => w.scoutLevelOf(p.id);   // your commissioned scouting on this player
const conf = (p: Player) => Math.round(scoutConfidence(p, true, sl(p)) * 100);
const ceiling = (p: Player) => { const [lo, hi] = scoutedRange(p, true, sl(p)); return lo === hi ? `${lo}` : `${lo}–${hi}`; };
const rank = (p: Player) => soloRank(overall(p));
const rnd = (n: number) => Math.round(n);
const chem = (p: Player) => Math.round(w.chemOf(p) * 100);   // 0..100% gelled with the squad
const isMech = (k: keyof Attributes) => k === 'aim' || k === 'movement' || k === 'entry';
const aceil = (p: Player, k: keyof Attributes) => scoutedAttr(p, k, true, sl(p));   // per-skill scouted ceiling (sharpens as you scout)
const aceilR = (p: Player, k: keyof Attributes) => Math.round(aceil(p, k));         // rounded for display (ability drifts fractionally)
// ability is fractional in-season; round both sides so a delta only shows once a
// rounded point has actually moved (avoids ▲0 flicker from sub-point growth)
const delta = (p: Player, k: keyof Attributes) => {
  const prev = w.prevById.value.get(p.id);
  return prev ? Math.round(p.attr[k]) - Math.round(prev.attr[k]) : 0;
};
const order = (p: Player) => (w.isStarter(p.id) ? 0 : 1);
const sorted = () => [...w.myRoster.value].sort((a, b) => order(a) - order(b) || overall(b) - overall(a));
// training focus: click a skill to direct this player's reps at it (faster there, a
// touch slower elsewhere — a tradeoff). Click the focused skill again to clear it.
const focusOf = (p: Player) => w.focusOf(p.id);
const toggleFocus = (p: Player, k: keyof Attributes) => w.setFocus(p.id, focusOf(p) === k ? null : k);
// morale mood chip: a player's match-day mood (minutes/results/team talks move it)
const moodClass = (p: Player) => { const m = w.moraleOf(p.id); return m >= 75 ? 'hi' : m >= 50 ? 'mid' : 'lo'; };
const moodIcon = (p: Player) => { const m = w.moraleOf(p.id); return m >= 75 ? '◔ high' : m >= 50 ? '◔ ok' : '◔ low'; };
// the person behind the handle — real name, date-derived age, birthday
const person = (p: Player) => personOf(p.id);
const ageOf = (p: Player) => displayAge(p.age, person(p).birthday, w.today.value);
const bday = (p: Player) => fmtDayMonth(person(p).birthday);
const hadBday = (p: Player) => birthdayPassed(person(p).birthday, w.today.value);
</script>

<template>
  <div class="hq-panel rs">
    <h3><span class="b"></span>{{ w.myTeam.value.tag }} · Squad
      <span class="rs-sub">{{ w.myRoster.value.length }} players · cohesion <b :class="{ lo: w.teamCohesion() < 0.6 }">{{ Math.round(w.teamCohesion() * 100) }}%</b> · wages <b>{{ money(w.myWageBill.value) }}</b>/yr</span></h3>
    <div v-for="p in sorted()" :key="p.id" class="rs-row" :class="[phaseOf(p), { reserve: !w.isStarter(p.id), listed: w.isListed(p.id) }]">
      <div class="rs-id">
        <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
        <div class="rs-name">
          <template v-if="editing === p.id">
            <input :id="'rs-edit-' + p.id" v-model="draft" class="rs-edit" maxlength="12" spellcheck="false"
              @keyup.enter="commitEdit(p)" @keyup.esc="editing = null" @blur="commitEdit(p)" />
          </template>
          <template v-else>{{ gamertag(p) }}<button class="rs-rename" title="rename in-game gamertag" @click="startEdit(p)">✎</button></template>
          <i v-if="w.isStarter(p.id)" class="rs-start">XI</i><i v-else class="rs-res">RES</i>
          <button v-if="w.isStarter(p.id)" class="rs-capt" :class="{ on: w.isCaptain(p.id) }" @click="w.setCaptain(p.id)"
            :title="w.isCaptain(p.id) ? 'captain — a strong leader steadies the room (click to revert to auto)' : 'name as captain (a leadership morale lever)'">C</button>
        </div>
        <div class="rs-realname clickable" @click="profile = p" :title="`open ${person(p).name}'s profile`">{{ person(p).nation.flag }} {{ person(p).name }} <i class="rs-cardlink">▸ card</i></div>
        <div class="rs-meta">age {{ ageOf(p) }} · <span class="rs-bday" :class="{ on: hadBday(p) }" :title="hadBday(p) ? `turned ${ageOf(p)} on ${bday(p)} this season` : `birthday ${bday(p)} — turns ${ageOf(p) + 1}`">🎂 {{ bday(p) }}</span> · <span class="rs-phase" :class="phaseOf(p)">{{ phaseOf(p) }}</span><span v-if="chem(p) < 100" class="rs-gel" :title="`gelling with the squad — ${chem(p)}% chemistry (a fresh signing hasn't clicked yet)`"> · gelling {{ chem(p) }}%</span></div>
        <div class="rs-tags">
          <span v-if="traitOf(p.id)" class="rs-trait" :class="'tr-' + traitOf(p.id)!.key" :title="traitOf(p.id)!.blurb">✦ {{ traitOf(p.id)!.label }}</span>
          <span v-if="w.isMentor(p)" class="rs-mentor" title="a senior leader — develops your young players faster">🎓 mentor</span>
          <span v-else-if="w.isMentee(p)" class="rs-mentee" title="being mentored by a senior leader — developing faster">↑ mentored</span>
        </div>
        <div class="rs-rank" :class="'rk-' + rank(p).tier.toLowerCase()"><i class="rs-rankdot"></i>{{ rank(p).label }}</div>
        <div class="rs-fit">
          <span v-if="w.isInjured(p.id)" class="rs-inj" :title="`injured — out for ${w.injuryOf(p.id)} more match-day(s); a reserve covers, or he plays through hurt`">⚕ OUT {{ w.injuryOf(p.id) }}d</span>
          <template v-else>
            <span class="rs-fatbar" :title="`match fatigue ${w.fatigueOf(p.id)}% — rotate him out to recover; high fatigue dulls performance and risks injury`"><i :class="{ hi: w.fatigueOf(p.id) >= 60 }" :style="{ width: w.fatigueOf(p.id) + '%' }"></i></span>
            <span class="rs-fatpct" :class="{ tired: w.isTired(p.id) }">{{ w.fatigueOf(p.id) }}%</span>
          </template>
          <span class="rs-mood" :class="moodClass(p)" :title="`morale ${Math.round(w.moraleOf(p.id))} — minutes, results and team talks move it; high morale lifts match form`">{{ moodIcon(p) }}</span>
        </div>
      </div>
      <div class="rs-ovr"><div class="rs-ovrn">{{ overall(p) }}</div><div class="rs-ovrl">OVR</div></div>
      <div class="rs-pot">
        <div class="rs-stars"><span v-for="n in 5" :key="n" :class="{ on: n <= scoutedStars(p, true, sl(p)) }">★</span></div>
        <div class="rs-ovrl">CEIL <b class="rs-ceil">{{ ceiling(p) }}</b> · <span class="rs-conf" :class="{ lo: conf(p) < 55 }">{{ conf(p) }}%</span></div>
        <button class="rs-scout" :disabled="!w.canScout(p.id)" @click="w.scoutPlayer(p.id)"
          :title="sl(p) >= w.SCOUT_MAX ? 'fully scouted' : `commission a scouting report — clears the fog and reveals sale value`">
          <i class="rs-scoutpips"><i v-for="n in w.SCOUT_MAX" :key="n" :class="{ on: n <= sl(p) }"></i></i>
          <template v-if="sl(p) >= w.SCOUT_MAX">scouted</template>
          <template v-else>scout <b>{{ money(w.scoutCost(p.id)) }}</b></template>
        </button>
      </div>
      <div class="rs-attrs">
        <div v-for="a in ATTRS" :key="a.k" class="rs-attr" :class="{ focused: focusOf(p) === a.k }"
          @click="toggleFocus(p, a.k)" :title="focusOf(p) === a.k ? 'training focus here — click to clear' : `train ${a.label}: faster growth here, slightly slower elsewhere`">
          <div class="rs-abar">
            <i class="ghost" :class="{ mech: isMech(a.k) }" :style="{ width: aceil(p, a.k) + '%' }"></i>
            <i :class="{ mech: isMech(a.k) }" :style="{ width: p.attr[a.k] + '%' }"></i>
            <span class="rs-tick" :style="{ left: aceil(p, a.k) + '%' }"></span>
          </div>
          <div class="rs-aval">
            <span class="rs-alabel">{{ a.label }}</span><b>{{ rnd(p.attr[a.k]) }}</b>
            <span v-if="focusOf(p) === a.k" class="rs-focus" title="training focus">◎</span>
            <span v-if="aceilR(p, a.k) > rnd(p.attr[a.k])" class="rs-acl" :title="`scouted ceiling — this skill can grow to ~${aceilR(p, a.k)} (fogged)`">↗{{ aceilR(p, a.k) }}</span>
            <span v-if="delta(p, a.k)" class="rs-delta" :class="delta(p, a.k) > 0 ? 'up' : 'dn'">{{ delta(p, a.k) > 0 ? '▲' : '▼' }}{{ Math.abs(delta(p, a.k)) }}</span>
          </div>
        </div>
      </div>
      <div class="rs-actions">
        <div class="rs-val">{{ money(w.value(p)) }}
          <i class="rs-deal" :class="{ expiring: w.isExpiring(p) }" :title="`under contract for ${w.yearsLeft(p)} more season(s) at ${money(w.wageOf(p))}/yr — wage locked until it expires`">{{ w.yearsLeft(p) }}y · {{ money(w.wageOf(p)) }}/y</i>
        </div>
        <button v-if="w.isExpiring(p)" class="rs-renew" @click="w.renewPlayer(p.id)" :title="`re-sign to a new deal at his current market wage`">renew · {{ money(w.renewCost(p)) }}/y</button>
        <button v-if="w.isStarter(p.id)" class="rs-lx" :disabled="!w.canBench(p.id)" @click="w.benchStarter(p.id)" title="move to the reserves">bench</button>
        <button v-else class="rs-lx start" @click="w.startReserve(p.id)" title="start in the XI">start ▲</button>
        <button class="hq-list" :class="{ on: w.isListed(p.id) }" @click="w.toggleList(p.id)">{{ w.isListed(p.id) ? '● listed' : 'list' }}</button>
        <button class="rs-sell" :disabled="!w.canSell(p.id)" @click="w.sellPlayer(p.id)">sell</button>
      </div>
    </div>
    <div class="hq-compnote"><b>Click a skill</b> to set a <b>training focus ◎</b> — that player's reps target it (faster growth there, a touch slower elsewhere): sharpen a prospect's spike or shore up a weakness. Every player is on a <b>contract</b> — a wage <b>locked</b> for its term (you pay it even as he ages), counting down each season. A player in his <b>final year</b> shows <b class="rs-deal expiring">renew</b>: re-sign him at his current market wage, or he walks <b>free</b> at season's end. Potential is a <b>scouted</b> read; <b>start</b>/<b>bench</b> to override; sell to offload a deal (the buyer takes the wage). Click a player's <b>name</b> for his full <b>profile card</b>.</div>

    <!-- player profile card -->
    <Teleport to="body">
      <div v-if="profile" class="pc-overlay" @click.self="profile = null">
        <div class="pc-card" :class="phaseOf(profile)">
          <button class="lv-clubx" @click="profile = null">✕</button>
          <div class="pc-head">
            <span class="rs-role" :class="profile.role">{{ profile.role.slice(0, 3).toUpperCase() }}</span>
            <div class="pc-headmeta">
              <b class="pc-tag">{{ gamertag(profile) }}<i v-if="w.isCaptain(profile.id)" class="pc-c">C</i><i v-if="profile.igl" class="rs-igl">IGL</i></b>
              <span class="pc-name">{{ person(profile).nation.flag }} {{ person(profile).name }} · {{ person(profile).nation.country }}</span>
            </div>
            <div class="pc-ovr"><b>{{ overall(profile) }}</b><span>OVR</span></div>
          </div>
          <div class="pc-bio">
            <span><i>Age</i> {{ ageOf(profile) }}</span>
            <span :class="{ gold: hadBday(profile) }"><i>Birthday</i> 🎂 {{ bday(profile) }}</span>
            <span><i>Phase</i> {{ phaseOf(profile) }}</span>
            <span :class="'rk-' + rank(profile).tier.toLowerCase()"><i>Solo rank</i> {{ rank(profile).label }}</span>
            <span><i>Contract</i> {{ w.yearsLeft(profile) }}y · {{ money(w.wageOf(profile)) }}/y</span>
            <span v-if="traitOf(profile.id)"><i>Trait</i> ✦ {{ traitOf(profile.id)!.label }}</span>
          </div>
          <div class="pc-section">Attributes <span class="pc-ceilkey">current ↗ scouted ceiling</span></div>
          <div class="pc-attrs">
            <div v-for="a in ATTRS" :key="a.k" class="pc-attr">
              <span class="pc-al">{{ a.label }}</span>
              <span class="pc-abar"><i :class="{ mech: isMech(a.k) }" :style="{ width: rnd(profile.attr[a.k]) + '%' }"></i><span class="pc-tick" :style="{ left: aceilR(profile, a.k) + '%' }"></span></span>
              <span class="pc-av"><b>{{ rnd(profile.attr[a.k]) }}</b><em v-if="aceilR(profile, a.k) > rnd(profile.attr[a.k])">↗{{ aceilR(profile, a.k) }}</em></span>
            </div>
          </div>
          <div class="pc-cols">
            <div class="pc-col">
              <div class="pc-section">Agent pool</div>
              <div v-for="ag in [...profile.agents].sort((x, y) => y.level - x.level)" :key="ag.agent" class="pc-agent"><span>{{ ag.agent }}</span><b>{{ ag.level }}</b></div>
            </div>
            <div class="pc-col">
              <div class="pc-section">Condition</div>
              <div class="pc-cond"><i>Fatigue</i><span :class="{ hi: w.fatigueOf(profile.id) >= 60 }">{{ w.fatigueOf(profile.id) }}%</span></div>
              <div class="pc-cond"><i>Morale</i><span :class="moodClass(profile)">{{ Math.round(w.moraleOf(profile.id)) }}</span></div>
              <div v-if="w.injuryOf(profile.id)" class="pc-cond"><i>Status</i><span class="lo">⚕ OUT {{ w.injuryOf(profile.id) }}d</span></div>
              <div v-if="w.isMentor(profile)" class="pc-cond"><i>Role</i><span>🎓 mentor</span></div>
              <div v-else-if="w.isMentee(profile)" class="pc-cond"><i>Role</i><span>↑ mentored</span></div>
            </div>
          </div>
          <div v-if="awardsFor(profile).length" class="pc-honours">
            <div class="pc-section">🏅 Honours</div>
            <span v-for="(aw, i) in awardsFor(profile)" :key="i" class="pc-medal">{{ aw.kind }} <em>S{{ aw.season }}{{ aw.note ? ` · ${aw.note}` : '' }}</em></span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
