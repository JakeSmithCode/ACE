<script setup lang="ts">
// The World Cup — national teams assembled from the league's talent by NATIONALITY.
// The best players of each country form a national five and clash in a single-elim
// bracket for the world title (the server full-sims the final, watchable). The payoff
// of the identity layer: "Team Korea" is real names you've scouted all season.
import { onMounted, onUnmounted, ref, reactive } from 'vue';
import { simulateMatch } from '@ace/engine';
import { Viewer } from './viewer';
import { AceServer, type WorldCupView, type WCSide, type ElectionsView, type NationElection } from './serverApi';

const DEFAULT = new URL(location.href).searchParams.get('server') || 'http://127.0.0.1:8787';
const url = ref(DEFAULT);
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const errMsg = ref('');
const wc = ref<WorldCupView | null>(null);
let server: AceServer | null = null;

// --- manager elections: a single sign-in (from the Match Center) carries here -------
const token = ref<string | null>(localStorage.getItem('ace.token'));
const elections = ref<ElectionsView | null>(null);
const elFor = (code: string): NationElection | undefined => elections.value?.nations.find(n => n.code === code);
const voteMsg = ref('');
async function loadElections() {
  if (!server) return;
  try {
    elections.value = await server.worldCupElections(token.value ?? undefined);
    for (const n of elections.value.nations) if (n.youManager) ensureDraft(n);
  } catch { /* offline */ }
}
async function runFor(code: string) {
  if (!server || !token.value) return;
  try { await server.runForNation(code, token.value); await reload(); voteMsg.value = `You're standing for ${code}.`; }
  catch (e) { voteMsg.value = (e as Error).message; }
}
async function vote(code: string, tag: string) {
  if (!server || !token.value) return;
  try { await server.voteNation(code, tag, token.value); await reload(); voteMsg.value = `Backed ${tag} for ${code}.`; }
  catch (e) { voteMsg.value = (e as Error).message; }
}
// the elected manager's tactics editor (one local draft per managed nation)
const draft = reactive<Record<string, { siteBias: number; tempo: number; read: number; aggression: number }>>({});
function ensureDraft(n: NationElection) {
  if (!draft[n.code] && n.tactics) draft[n.code] = { siteBias: n.tactics.attack.siteBias, tempo: n.tactics.attack.tempo, read: n.tactics.defense.read, aggression: n.tactics.defense.aggression };
}
async function saveTactics(n: NationElection) {
  if (!server || !token.value || !n.tactics) return;
  const d = draft[n.code];
  const tactics = { ...n.tactics, attack: { ...n.tactics.attack, siteBias: d.siteBias, tempo: d.tempo }, defense: { ...n.tactics.defense, read: d.read, aggression: d.aggression } };
  try { await server.setNationTactics(n.code, tactics, token.value); voteMsg.value = `${n.code} tactics saved — your plan drives the final.`; await reload(); }
  catch (e) { voteMsg.value = (e as Error).message; }
}

const roleAbbr = (r: string) => r.slice(0, 3).toUpperCase();
const isChamp = (s: WCSide) => wc.value != null && s.code === wc.value.bracket.champion.code;
const won = (m: { winner: WCSide }, s: WCSide) => m.winner.code === s.code;
const roundName = (i: number, total: number) => {
  const fromEnd = total - 1 - i;
  return fromEnd === 0 ? 'Grand Final' : fromEnd === 1 ? 'Semifinals' : fromEnd === 2 ? 'Quarterfinals' : `Round ${i + 1}`;
};

async function load() {
  status.value = 'loading'; errMsg.value = '';
  server = new AceServer(url.value);
  try { wc.value = await server.worldCup(); await loadElections(); status.value = 'ready'; }
  catch (e) { status.value = 'error'; errMsg.value = (e as Error).message; }
}
// refresh the cup + elections after an election change (the final re-sims under new tactics)
async function reload() {
  if (!server) return;
  try { wc.value = await server.worldCup(); await loadElections(); } catch { /* transient */ }
}

// --- watch the grand final (full-simmed, re-rendered from its snapshot) ------
const host = ref<HTMLElement | null>(null);
const watching = ref(false);
const navs: Record<string, any> = {};
let viewer: Viewer | null = null;
async function watchFinal() {
  if (!wc.value) return;
  const f = wc.value.final;
  if (!navs[f.map]) navs[f.map] = await fetch(`/${f.map}.navmesh.json`).then(r => r.json());
  const out = simulateMatch(f.snapshot, navs[f.map], 50);
  watching.value = true;
  requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${f.map}.png`, navs[f.map]); });
}
function closeWatch() { watching.value = false; viewer?.destroy(); viewer = null; }

onMounted(load);
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="cir">
    <div class="lv-bar">
      <div class="lv-title">
        <span class="lv-dot" :class="status === 'ready' ? 'live' : status === 'error' ? 'error' : 'connecting'"></span>
        <b>WORLD CUP</b>
        <span class="lv-world">national teams clash for the world title</span>
      </div>
      <div class="lv-conn">
        <input v-model="url" class="lv-url" spellcheck="false" @keyup.enter="load" />
        <button class="lv-go" @click="load">{{ status === 'ready' ? 'refresh' : 'load' }}</button>
      </div>
    </div>

    <div v-if="status === 'error'" class="lv-err">Couldn't reach <b>{{ url }}</b> — {{ errMsg }}.
      <div class="lv-hint">Start one with <code>pnpm run server:serve</code>, then load.</div></div>
    <div v-else-if="status === 'loading'" class="lv-err lv-wait">Assembling the national squads + the World Cup bracket…</div>

    <template v-if="status === 'ready' && wc">
      <!-- the world champion -->
      <div class="cir-champ wc-champ">
        <span class="cir-trophy">🏆</span>
        <div class="cir-champmeta">
          <span class="cir-champk">World Champions · Season {{ wc.season }}</span>
          <b class="cir-champname">{{ wc.bracket.champion.flag }} {{ wc.bracket.champion.country }}</b>
          <span class="cir-champreg">National Team · {{ wc.bracket.champion.code }}</span>
        </div>
        <button class="cir-watch" @click="watchFinal">▷ watch the grand final</button>
      </div>

      <!-- the qualified national squads (the payoff: real people by nation) -->
      <div class="wc-squadh">Qualified nations · best five of each country</div>
      <div class="wc-squads">
        <div v-for="(s, si) in wc.squads" :key="s.code" class="wc-squad" :class="{ champ: isChamp(s) }">
          <div class="wc-sqhead">
            <span class="wc-flag">{{ s.flag }}</span>
            <div class="wc-sqid"><b>{{ s.country }}</b><i>{{ s.code }} · seed {{ si + 1 }} · {{ s.pool }} eligible</i></div>
            <div class="wc-sqstr">{{ s.strength }}<span>OVR</span></div>
          </div>
          <div v-for="p in s.five" :key="p.handle" class="wc-player">
            <span class="rs-role" :class="p.role">{{ roleAbbr(p.role) }}</span>
            <div class="wc-pid"><b>{{ p.handle }}<i v-if="p.igl" class="rs-igl wc-igl">IGL</i></b><span class="wc-pname">{{ p.name }}</span></div>
            <span class="wc-pagent">{{ p.agent }}</span>
            <span class="wc-psolo" :class="'rk-' + p.soloTier.toLowerCase()">{{ p.solo }}</span>
            <span class="wc-povr">{{ p.overall }}</span>
          </div>

          <!-- the elected manager + the ballot (campaign for the armband) -->
          <div v-if="elFor(s.code)" class="wc-elect">
            <div class="wc-mgr">
              <span class="wc-mgrk">⚑ Manager</span>
              <b v-if="s.manager" class="wc-mgrtag" :class="{ mine: elFor(s.code)!.youManager }">{{ s.manager }}<i v-if="elFor(s.code)!.youManager"> · you</i></b>
              <span v-else class="wc-mgrnone">— vacant</span>
              <span v-if="elFor(s.code)!.hasTactics" class="wc-plan" title="the manager has authored a plan that drives the final">✎ plan set</span>
            </div>
            <!-- candidates + vote buttons -->
            <div v-if="elFor(s.code)!.candidates.length" class="wc-cands">
              <button v-for="c in elFor(s.code)!.candidates" :key="c.tag" class="wc-cand"
                :class="{ lead: c.tag === s.manager, voted: c.tag === elFor(s.code)!.yourVoteTag }"
                :disabled="!token" @click="vote(s.code, c.tag)" :title="token ? `back ${c.tag}` : 'sign in at the Match Center to vote'">
                {{ c.tag }} <i>{{ c.votes }}</i>
              </button>
            </div>
            <div class="wc-ballot">
              <button v-if="token && !elFor(s.code)!.youCandidate" class="wc-run" @click="runFor(s.code)">▸ run for manager</button>
              <span v-else-if="!token" class="wc-signin">sign in at the Match Center to run / vote</span>
              <span v-else class="wc-running">you're on the ballot</span>
            </div>
            <!-- the manager's tactics editor (drives the engine-simmed final) -->
            <div v-if="elFor(s.code)!.youManager && elFor(s.code)!.tactics && draft[s.code]" class="wc-tac">
              <div class="wc-tach">your plan · drives the final</div>
              <label class="wc-trow">A↔B bias<input type="range" min="0" max="1" step="0.05" v-model.number="draft[s.code].siteBias" /><i>{{ draft[s.code].siteBias.toFixed(2) }}</i></label>
              <label class="wc-trow">Tempo<input type="range" min="0" max="1" step="0.05" v-model.number="draft[s.code].tempo" /><i>{{ draft[s.code].tempo.toFixed(2) }}</i></label>
              <label class="wc-trow">Def read<input type="range" min="0" max="1" step="0.05" v-model.number="draft[s.code].read" /><i>{{ draft[s.code].read.toFixed(2) }}</i></label>
              <label class="wc-trow">Aggression<input type="range" min="0" max="1" step="0.05" v-model.number="draft[s.code].aggression" /><i>{{ draft[s.code].aggression.toFixed(2) }}</i></label>
              <button class="wc-save" @click="saveTactics(elFor(s.code)!)">save plan</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="voteMsg" class="wc-votemsg">{{ voteMsg }}</div>

      <!-- the bracket -->
      <div class="cir-brackwrap">
        <div class="cir-brackh">World Cup bracket · {{ wc.bracket.field.length }} nations · single elimination</div>
        <div class="cir-brack">
          <div v-for="(round, ri) in wc.bracket.rounds" :key="ri" class="cir-col">
            <div class="cir-colh">{{ roundName(ri, wc.bracket.rounds.length) }}</div>
            <div v-for="(m, mi) in round" :key="mi" class="cir-match" :class="{ fin: ri === wc.bracket.rounds.length - 1 }">
              <div class="cir-side" :class="{ win: won(m, m.a), champ: ri === wc.bracket.rounds.length - 1 && isChamp(m.a) }">
                <i class="wc-bflag">{{ m.a.flag }}</i><b>{{ m.a.code }}</b>
                <span v-if="ri === wc.bracket.rounds.length - 1" class="cir-sc">{{ wc.final.score[0] }}</span>
              </div>
              <div class="cir-side" :class="{ win: won(m, m.b), champ: ri === wc.bracket.rounds.length - 1 && isChamp(m.b) }">
                <i class="wc-bflag">{{ m.b.flag }}</i><b>{{ m.b.code }}</b>
                <span v-if="ri === wc.bracket.rounds.length - 1" class="cir-sc">{{ wc.final.score[1] }}</span>
              </div>
              <div v-if="ri === wc.bracket.rounds.length - 1" class="cir-finmap">{{ wc.final.map }} · engine-simmed</div>
            </div>
          </div>
        </div>
      </div>

      <!-- the watched grand final -->
      <div v-if="watching" class="lv-watchwrap">
        <div class="lv-watchhead">
          <b>{{ wc.final.a.flag }} {{ wc.final.a.code }}</b> {{ wc.final.score[0] }} – {{ wc.final.score[1] }} <b>{{ wc.final.b.code }} {{ wc.final.b.flag }}</b>
          · <span class="hq-rmap">{{ wc.final.map }}</span> · the grand final, re-simmed from the server snapshot
          <button class="ed-close" @click="closeWatch">close</button>
        </div>
        <div ref="host" class="ace-host"></div>
      </div>
    </template>
  </div>
</template>
