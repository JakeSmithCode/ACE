<script setup lang="ts">
// The Match Center — the async-PvP client. The world resolves on the @ace/server
// tick, not in this browser; here we watch it. During a match's broadcast window the
// running score streams in live (SSE) with the result SEALED (the embargo — no
// spoilers until it's over); once revealed we pull the snapshot and re-sim it in the
// viewer (the engine runs client-side, so watching costs the server nothing). This is
// the seam between the deep persistence backend and the broadcast-grade viewer.
import { onMounted, onUnmounted, ref, computed } from 'vue';
import type { MapId, Tactics } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { RANK_TIERS } from '@ace/world';
import { Viewer } from './viewer';
import { AceServer, type WorldSummary, type StandingRow, type LiveFixture, type ClubPage, type MarketEntry, type SquadPlayer } from './serverApi';

const DEFAULT = new URL(location.href).searchParams.get('server') || 'http://127.0.0.1:8787';
const url = ref(DEFAULT);
const server = ref<AceServer | null>(null);
const status = ref<'idle' | 'connecting' | 'live' | 'error'>('idle');
const errMsg = ref('');
const world = ref<WorldSummary | null>(null);
const table = ref<StandingRow[]>([]);
const fixtures = ref<LiveFixture[]>([]);
let stopStream: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const season = computed(() => world.value?.season ?? 1);
const DAY = ref(0);   // the match-day currently on air (the server's broadcast cursor)
const advancing = ref(false);
const navs: Record<string, any> = {};
async function ensureNav(map: MapId) {
  if (!navs[map]) navs[map] = await fetch(`/${map}.navmesh.json`).then(r => r.json());
  return navs[map];
}

// --- identity: register / log in → claim a Premier club (the async-PvP loop) ---
const token = ref<string | null>(null);
const myClub = ref<ClubPage | null>(null);
const authOpen = ref(false);
const authMode = ref<'register' | 'login'>('register');
const email = ref(''); const password = ref(''); const authErr = ref(''); const busy = ref(false);
const claimTag = ref('');
const authed = computed(() => !!token.value);
const tierName = (t: number) => RANK_TIERS[t] ?? `T${t}`;
const mine = (tag: string) => myClub.value?.tag === tag;

async function doAuth() {
  if (!server.value) return; busy.value = true; authErr.value = '';
  try {
    const s = authMode.value === 'register' ? await server.value.register(email.value, password.value) : await server.value.login(email.value, password.value);
    token.value = s.accessToken; authOpen.value = false; password.value = '';
    await refreshMe();
  } catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
async function refreshMe() { if (server.value && token.value) { myClub.value = await server.value.me(token.value).catch(() => null); syncTac(); } }
async function doClaim() {
  if (!server.value || !token.value || !claimTag.value) return; busy.value = true; authErr.value = '';
  try { myClub.value = await server.value.claim(claimTag.value, token.value); await refreshMe(); }  // refresh → /me carries the plan
  catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
function signOut() { token.value = null; myClub.value = null; authErr.value = ''; planOpen.value = false; }

// --- author your club's tactics (PATCH /me/plan → drives your next tick) ------
const planOpen = ref(false);
const tac = ref<Tactics | null>(null);
const planSaved = ref(false);
function syncTac() { const t = myClub.value?.plan?.tactics; tac.value = t ? JSON.parse(JSON.stringify(t)) as Tactics : null; }
async function savePlan() {
  if (!server.value || !token.value || !tac.value) return; busy.value = true; authErr.value = '';
  try { await server.value.setPlan(tac.value, token.value); planSaved.value = true; setTimeout(() => (planSaved.value = false), 2200); await refreshMe(); }
  catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
const readLabel = (v: number) => v <= -0.34 ? 'stack B' : v >= 0.34 ? 'stack A' : 'spread';
const pct = (v: number) => Math.round(v * 100) + '%';

// --- the transfer market — bid on free agents (a real bidding war) ------------
const marketOpen = ref(false);
const board = ref<MarketEntry[]>([]);
const bidAmt = ref<Record<string, number>>({});
const bidMsg = ref<Record<string, string>>({});
const marketBusy = ref(false);
const kfmt = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
async function loadBoard() {
  if (!server.value) return;
  try { board.value = (await server.value.market()).board; bidAmt.value = Object.fromEntries(board.value.map(e => [e.handle, e.value])); }
  catch (e) { authErr.value = (e as Error).message; }
}
async function toggleMarket() { marketOpen.value = !marketOpen.value; if (marketOpen.value && !board.value.length) await loadBoard(); }
async function bid(e: MarketEntry) {
  if (!server.value || !token.value) return; marketBusy.value = true;
  const msg = (m: string) => (bidMsg.value = { ...bidMsg.value, [e.handle]: m });
  msg('');
  try {
    const r = await server.value.bid(e.handle, bidAmt.value[e.handle] ?? e.value, token.value);
    if (r.ok) { msg(`✓ signed for ${kfmt(r.paid!)}`); await loadBoard(); await refreshMe(); }
    else if (r.reason === 'outbid') msg(`outbid by ${r.leader} (${kfmt(r.leadBid!)}) — raise`);
    else if (r.reason === 'below asking price') msg(`below asking (${kfmt(r.leadBid!)})`);
    else msg(r.reason ?? 'rejected');
  } catch (err) { msg((err as Error).message); } finally { marketBusy.value = false; }
}
const sellMsg = ref<Record<string, string>>({});
async function sell(sp: SquadPlayer) {
  if (!server.value || !token.value) return; marketBusy.value = true;
  const msg = (m: string) => (sellMsg.value = { ...sellMsg.value, [sp.id]: m });
  msg('');
  try {
    const r = await server.value.sell(sp.id, token.value);
    if (r.ok) { msg(`✓ sold to ${r.buyer} for ${kfmt(r.fee!)}`); await refreshMe(); }
    else msg(r.reason ?? 'rejected');
  } catch (e) { msg((e as Error).message); } finally { marketBusy.value = false; }
}

const hue = (tag: string) => (tag.charCodeAt(0) * 47 + (tag.charCodeAt(1) || 0) * 13) % 360;
// the score to display: the running (completed-round) tally while live, but the TRUE
// final once revealed (the live running-score excludes the in-progress decider round)
const score = (f: LiveFixture): [number, number] => (f.status === 'resolved' && f.final ? f.final : f.running);
const anyLive = computed(() => fixtures.value.some(f => f.status === 'live'));
const allDone = computed(() => fixtures.value.length > 0 && fixtures.value.every(f => f.status === 'resolved'));

async function connect() {
  status.value = 'connecting'; errMsg.value = '';
  const s = new AceServer(url.value);
  try {
    world.value = await s.world();
    DAY.value = world.value.broadcastDay ?? 0;
    table.value = (await s.standings(world.value.season, 0, 0)).table;
    server.value = s; status.value = 'live';
    await refreshMe();
    await loadHonors();
    openStream();
    // a shared deep-link (?watch=season/day/slot) → auto-open that replay
    const wp = new URL(location.href).searchParams.get('watch');
    if (wp) { const [ws, wd, wsl] = wp.split('/').map(Number); if (![ws, wd, wsl].some(isNaN)) void watchAt(ws, wd, wsl); }
    // standings only move at reveal — refresh them every few seconds while watching
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshTable, 4000);
  } catch (e) { status.value = 'error'; errMsg.value = (e as Error).message; }
}
function openStream() {
  if (!server.value || !world.value) return;
  stopStream?.();
  fixtures.value = [];
  stopStream = server.value.liveStream(world.value.season, DAY.value, fs => { fixtures.value = [...fs].sort((a, b) => a.slot - b.slot); }, refreshTable);
}
// advance the season a match-day — your authored tactics drive your next fixtures.
// at the season boundary it rolls over (playoffs → champion → new season).
const champBanner = ref<{ season: number; champion: string } | null>(null);
const wireNote = ref('');
async function advance() {
  if (!server.value || !token.value) return;
  advancing.value = true;
  try {
    const r = await server.value.advance(token.value);
    if (r.done) return;
    DAY.value = r.broadcastDay;
    if (world.value) world.value = await server.value.world();
    openStream(); await refreshTable(); await refreshMe();
    if (board.value.length) await loadBoard();   // the board churns (AI signed some) — refresh it
    if (r.rivalSignings) { wireNote.value = `${r.rivalSignings} free agent${r.rivalSignings > 1 ? 's' : ''} signed by rival clubs`; setTimeout(() => (wireNote.value = ''), 4000); }
    if (r.rollover && r.season && r.champion) { champBanner.value = { season: r.season - 1, champion: r.champion }; loadBoard(); await loadHonors(); }
  } catch (e) { errMsg.value = (e as Error).message; } finally { advancing.value = false; }
}
async function refreshTable() { if (server.value && world.value) try { table.value = (await server.value.standings(world.value.season, 0, 0)).table; } catch { /* transient */ } }
// the Hall of Fame — the world's champions (the legacy engine)
const hof = ref<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[] }>({ honors: [], allTime: [] });
async function loadHonors() { if (server.value) try { hof.value = await server.value.honors(); } catch { /* transient */ } }

// --- watch a revealed fixture back in the viewer (live or via a shared link) ---
interface Watched { home: { tag: string; name: string }; away: { tag: string; name: string }; final: [number, number] | null; map: string | null; season: number; day: number; slot: number }
const host = ref<HTMLElement | null>(null);
const watching = ref<Watched | null>(null);
const loadingWatch = ref(false);
const shareCopied = ref(false);
let viewer: Viewer | null = null;
function watch(fx: LiveFixture) { return watchAt(season.value, DAY.value, fx.slot); }
/** Render any resolved fixture's replay by (season, day, slot) — the live `watch`
 *  and a shared deep-link both route through here. */
async function watchAt(s: number, d: number, slot: number) {
  if (!server.value) return;
  loadingWatch.value = true;
  try {
    const fx = await server.value.fixture(s, d, slot);
    if (fx.status !== 'resolved') { errMsg.value = 'that match is still live — no spoilers'; return; }
    const rep = await server.value.replay(s, d, slot);
    if (!rep?.snapshot) return;
    const map = rep.snapshot.map;
    const nav = await ensureNav(map);
    const out = simulateMatch(rep.snapshot, nav, 50);
    watching.value = { home: fx.home, away: fx.away, final: fx.score ?? null, map, season: s, day: d, slot };
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav); });
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}
function closeWatch() { watching.value = null; viewer?.destroy(); viewer = null; }
/** A shareable deep-link to the watched replay — opening it auto-connects + plays. */
function shareWatch() {
  if (!watching.value) return;
  const u = `${location.origin}${location.pathname}?server=${encodeURIComponent(url.value)}&watch=${watching.value.season}/${watching.value.day}/${watching.value.slot}`;
  navigator.clipboard?.writeText(u).then(() => { shareCopied.value = true; setTimeout(() => (shareCopied.value = false), 2200); }).catch(() => { /* clipboard blocked */ });
}

// --- the public club page (click any club tag to browse its squad) ----------
const clubModal = ref<ClubPage | null>(null);
const clubBusy = ref(false);
async function openClub(slug: string) {
  if (!server.value) return; clubBusy.value = true;
  try { clubModal.value = await server.value.club(slug); }
  catch (e) { errMsg.value = (e as Error).message; } finally { clubBusy.value = false; }
}
const roleAbbr = (r: string) => r.slice(0, 3).toUpperCase();

onMounted(connect);
onUnmounted(() => { stopStream?.(); if (pollTimer) clearInterval(pollTimer); viewer?.destroy(); });
</script>

<template>
  <div class="mc">
    <!-- connection bar -->
    <div class="lv-bar">
      <div class="lv-title">
        <span class="lv-dot" :class="status"></span>
        <b>MATCH CENTER</b>
        <span v-if="world" class="lv-world">{{ world.region }} · Season {{ world.season }} · Day {{ world.day }} · {{ world.divisions }} divisions · {{ world.clubs }} clubs</span>
        <span v-else class="lv-world">async-PvP · server-resolved</span>
      </div>
      <div class="lv-conn">
        <input v-model="url" class="lv-url" spellcheck="false" @keyup.enter="connect" />
        <button class="lv-go" @click="connect">{{ status === 'live' ? 'reconnect' : 'connect' }}</button>
      </div>
    </div>

    <div v-if="status === 'error'" class="lv-err">
      Couldn't reach <b>{{ url }}</b> — {{ errMsg }}.
      <div class="lv-hint">Start one with <code>pnpm run server:serve</code> (defaults to <code>:8787</code>), then connect.</div>
    </div>
    <div v-else-if="status === 'connecting'" class="lv-err lv-wait">Connecting to {{ url }}…</div>

    <template v-if="status === 'live' && world">
      <!-- identity: sign in → claim a Premier club → your matches are marked -->
      <div class="lv-ident">
        <template v-if="myClub">
          <span class="lv-mine">★ YOUR CLUB</span>
          <i class="lv-badge id" :style="{ background: `hsl(${hue(myClub.tag)} 60% 24%)`, borderColor: `hsl(${hue(myClub.tag)} 65% 55%)` }">{{ myClub.tag }}</i>
          <b class="lv-myname">{{ myClub.name }}</b>
          <span class="lv-tier">{{ tierName(myClub.tier) }} · {{ myClub.rating }} OVR</span>
          <span class="lv-five">{{ myClub.five.map(p => p.handle).join(' · ') }}</span>
          <button class="lv-planbtn" :class="{ on: planOpen }" @click="planOpen = !planOpen">✎ tactics</button>
          <button class="lv-planbtn mkt" :class="{ on: marketOpen }" @click="toggleMarket">⇄ market</button>
          <span v-if="myClub.balance != null" class="lv-bank">bank {{ kfmt(myClub.balance) }}</span>
          <button class="lv-signout" @click="signOut">sign out</button>
        </template>
        <template v-else-if="authed">
          <span class="lv-signedin">● signed in</span>
          <span class="lv-claimlbl">claim a Premier club</span>
          <select v-model="claimTag" class="lv-claimsel"><option value="">choose…</option><option v-for="s in table" :key="s.club" :value="s.club">{{ s.club }}</option></select>
          <button class="lv-go sm" :disabled="!claimTag || busy" @click="doClaim">claim</button>
          <button class="lv-signout" @click="signOut">sign out</button>
          <span v-if="authErr" class="lv-autherr">{{ authErr }}</span>
        </template>
        <template v-else>
          <button class="lv-signin" @click="authOpen = !authOpen">⬡ Sign in to claim a club</button>
          <div v-if="authOpen" class="lv-authpanel">
            <div class="lv-authtabs">
              <button :class="{ on: authMode === 'register' }" @click="authMode = 'register'">Register</button>
              <button :class="{ on: authMode === 'login' }" @click="authMode = 'login'">Log in</button>
            </div>
            <input v-model="email" placeholder="email" class="lv-authin" spellcheck="false" />
            <input v-model="password" type="password" placeholder="password (8+ chars)" class="lv-authin" @keyup.enter="doAuth" />
            <button class="lv-go sm" :disabled="busy" @click="doAuth">{{ authMode === 'register' ? 'Create account' : 'Log in' }}</button>
            <span v-if="authErr" class="lv-autherr">{{ authErr }}</span>
          </div>
        </template>
      </div>

      <!-- author your tactics — saved to the server, drives your matches on the next tick -->
      <div v-if="myClub && planOpen && tac" class="lv-planpanel">
        <div class="lv-plangrid">
          <div class="lv-plancol">
            <span class="lv-planh att">◢ Attack</span>
            <label class="lv-dial"><span>Site bias <i>{{ tac.attack.siteBias <= -0.34 ? 'B' : tac.attack.siteBias >= 0.34 ? 'A' : 'balanced' }}</i></span>
              <input type="range" min="-1" max="1" step="0.1" v-model.number="tac.attack.siteBias" /></label>
            <label class="lv-dial"><span>Tempo <i>{{ tac.attack.tempo <= 0.4 ? 'slow' : tac.attack.tempo >= 0.66 ? 'fast' : 'mid' }} · {{ pct(tac.attack.tempo) }}</i></span>
              <input type="range" min="0" max="1" step="0.05" v-model.number="tac.attack.tempo" /></label>
          </div>
          <div class="lv-plancol">
            <span class="lv-planh def">◣ Defense</span>
            <label class="lv-dial"><span>Read <i>{{ readLabel(tac.defense.read) }}</i></span>
              <input type="range" min="-1" max="1" step="0.1" v-model.number="tac.defense.read" /></label>
            <label class="lv-dial"><span>Aggression <i>{{ tac.defense.aggression <= 0.34 ? 'passive' : tac.defense.aggression >= 0.66 ? 'aggressive' : 'measured' }} · {{ pct(tac.defense.aggression) }}</i></span>
              <input type="range" min="0" max="1" step="0.05" v-model.number="tac.defense.aggression" /></label>
          </div>
          <div class="lv-plansave">
            <button class="lv-go" :disabled="busy" @click="savePlan">Save plan</button>
            <span v-if="planSaved" class="lv-savedok">✓ saved — drives your next match</span>
            <span class="lv-plannote">authored tactics resolve on the server tick (the read-vs-site mind-game is real)</span>
          </div>
        </div>
      </div>

      <!-- the transfer market — bid on free agents (a real bidding war vs the AI clubs) -->
      <div v-if="myClub && marketOpen" class="lv-mktpanel">
        <div class="lv-mkth">
          <span class="lv-kicker">Free agents</span>
          <span class="lv-mktsub">a bid must clear the asking price <b>and</b> beat the top rival club — a 🔥 contested player goes above value</span>
          <span v-if="wireNote" class="lv-wire">⇄ {{ wireNote }}</span>
        </div>
        <div class="lv-mktboard">
          <div v-for="e in board" :key="e.handle" class="lv-mktrow">
            <span class="rs-role" :class="e.role">{{ e.role.slice(0, 3).toUpperCase() }}</span>
            <b class="lv-mkthandle">{{ e.handle }}</b>
            <span class="lv-mktage">age {{ e.age }}</span>
            <span class="lv-mktovr">{{ e.overall }} <i>OVR</i></span>
            <span class="lv-mktval">{{ kfmt(e.value) }}<i v-if="e.contested" class="lv-hot" title="contested by AI clubs">🔥</i></span>
            <input type="number" class="lv-mktbid" v-model.number="bidAmt[e.handle]" step="500" min="0" />
            <button class="lv-go sm" :disabled="marketBusy" @click="bid(e)">bid</button>
            <span class="lv-mktmsg" :class="{ ok: (bidMsg[e.handle] || '').startsWith('✓') }">{{ bidMsg[e.handle] }}</span>
          </div>
          <div v-if="!board.length" class="lv-empty">loading the board…</div>
        </div>
        <div v-if="myClub.squad && myClub.squad.length" class="lv-squad">
          <div class="lv-mkth"><span class="lv-kicker">Your squad</span><span class="lv-mktsub">sell to the richest club that wants him — blocked if it would break your valid five</span></div>
          <div class="lv-mktboard">
            <div v-for="sp in myClub.squad" :key="sp.id" class="lv-mktrow squad">
              <span class="rs-role" :class="sp.role">{{ sp.role.slice(0, 3).toUpperCase() }}</span>
              <b class="lv-mkthandle">{{ sp.handle }}<i v-if="sp.starter" class="lv-starter">XI</i></b>
              <span class="lv-mktovr">{{ sp.overall }} <i>OVR</i></span>
              <span class="lv-mktval">{{ kfmt(sp.value) }}</span>
              <button class="lv-sellbtn" :disabled="marketBusy" @click="sell(sp)">sell</button>
              <span class="lv-mktmsg" :class="{ ok: (sellMsg[sp.id] || '').startsWith('✓') }">{{ sellMsg[sp.id] }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- season rolled over → the champion + a fresh season -->
      <div v-if="champBanner" class="lv-champ">
        <span class="lv-trophy">🏆</span>
        <span class="lv-champtxt"><b>{{ champBanner.champion }}</b> won Season {{ champBanner.season }} — <i>Season {{ champBanner.season + 1 }} begins</i></span>
        <button class="lv-champx" @click="champBanner = null">✕</button>
      </div>

      <!-- the day's live matches -->
      <div class="lv-stage">
        <div class="lv-stageh">
          <span class="lv-kicker">Premier · Match-day {{ DAY + 1 }}<template v-if="world"> / {{ world.lastDay + 1 }}</template></span>
          <span class="lv-livetag" :class="{ on: anyLive }">{{ anyLive ? '● LIVE' : allDone ? 'FINAL' : '—' }}</span>
          <span class="lv-embargo" v-if="anyLive">results sealed until each broadcast ends — no spoilers</span>
          <button v-if="myClub && allDone && world && DAY < world.lastDay" class="lv-advance" :disabled="advancing" @click="advance">▶ advance match-day</button>
          <span v-else-if="myClub && allDone && world && DAY >= world.lastDay" class="lv-seasondone">season complete · playoffs next</span>
        </div>
        <div class="lv-cards">
          <div v-for="f in fixtures" :key="f.slot" class="lv-card" :class="[f.status, { mine: mine(f.home.tag) || mine(f.away.tag) }]">
            <div class="lv-team">
              <i class="lv-badge clickable" :style="{ background: `hsl(${hue(f.home.tag)} 60% 24%)`, borderColor: `hsl(${hue(f.home.tag)} 65% 55%)` }" @click="openClub(f.home.tag)">{{ f.home.tag }}</i>
              <span class="lv-tname">{{ f.home.name }}</span>
            </div>
            <div class="lv-mid">
              <div class="lv-score" :class="{ sealed: f.status !== 'resolved' }">
                <b>{{ score(f)[0] }}</b><span class="lv-sep">:</span><b>{{ score(f)[1] }}</b>
              </div>
              <div v-if="f.status === 'live'" class="lv-prog"><i :style="{ width: (f.frac * 100) + '%' }"></i></div>
              <div class="lv-state">
                <span v-if="f.status === 'live'" class="lv-rd">LIVE · RD {{ f.round }}/{{ f.rounds }}</span>
                <span v-else-if="f.status === 'resolved'" class="lv-final">FINAL{{ f.map ? ' · ' + f.map : '' }}</span>
                <span v-else class="lv-sched">SCHEDULED</span>
              </div>
            </div>
            <div class="lv-team away">
              <i class="lv-badge clickable" :style="{ background: `hsl(${hue(f.away.tag)} 60% 24%)`, borderColor: `hsl(${hue(f.away.tag)} 65% 55%)` }" @click="openClub(f.away.tag)">{{ f.away.tag }}</i>
              <span class="lv-tname">{{ f.away.name }}</span>
            </div>
            <button v-if="f.status === 'resolved'" class="lv-watch" :disabled="loadingWatch" @click="watch(f)">▷ watch</button>
            <div v-else class="lv-locked" title="sealed until the broadcast finishes">🔒</div>
          </div>
          <div v-if="!fixtures.length" class="lv-empty">waiting for the match-day to go live…</div>
        </div>
      </div>

      <!-- the watched match -->
      <div v-if="watching" class="lv-watchwrap">
        <div class="lv-watchhead">
          <b>{{ watching.home.tag }}</b> {{ watching.final?.[0] }} – {{ watching.final?.[1] }} <b>{{ watching.away.tag }}</b>
          · <span class="hq-rmap">{{ watching.map }}</span> · re-simmed from the server snapshot
          <button class="lv-share" @click="shareWatch">{{ shareCopied ? '✓ link copied' : '⤴ share' }}</button>
          <button class="ed-close" @click="closeWatch">close</button>
        </div>
        <div ref="host" class="ace-host"></div>
      </div>

      <div class="lv-bottom">
        <!-- Premier standings (embargo-aware: only resolved games count) -->
        <div class="lv-table">
          <div class="lv-tableh"><span class="lv-kicker">Premier standings</span><span class="lv-note">moves only when a broadcast ends</span></div>
          <div class="lv-trow lv-thead"><span class="r">#</span><span class="c">Club</span><span>P</span><span>W</span><span>L</span><span>Δ</span><span class="pts">Pts</span></div>
          <div v-for="(s, rank) in table" :key="s.club" class="lv-trow" :class="{ mine: mine(s.club) }">
            <span class="r">{{ rank + 1 }}</span>
            <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(s.club)} 65% 55%)` }"></i><span class="lv-cname clickable" @click="openClub(s.club)">{{ s.club }}</span><i v-if="mine(s.club)" class="lv-youtag">YOU</i></span>
            <span>{{ s.played }}</span><span>{{ s.won }}</span><span>{{ s.lost }}</span>
            <span :class="s.diff >= 0 ? 'pos' : 'neg'">{{ s.diff >= 0 ? '+' : '' }}{{ s.diff }}</span>
            <span class="pts">{{ s.points }}</span>
          </div>
        </div>

        <!-- the Hall of Fame — the world's champions (the legacy engine) -->
        <div class="lv-hof">
          <div class="lv-tableh"><span class="lv-kicker">🏆 Hall of Fame</span><span class="lv-note">the world remembers</span></div>
          <template v-if="hof.allTime.length || hof.honors.length">
            <div class="lv-hofsec">All-time titles</div>
            <div v-for="(c, i) in hof.allTime.slice(0, 6)" :key="c.tag" class="lv-hofrow">
              <span class="lv-hofrank">{{ i + 1 }}</span>
              <i class="hq-dot" :style="{ background: `hsl(${hue(c.tag)} 65% 55%)` }"></i>
              <b class="lv-cname clickable" @click="openClub(c.tag)">{{ c.tag }}</b>
              <span class="lv-hofname">{{ c.name }}</span>
              <span class="lv-hoftitles">{{ '🏆'.repeat(Math.min(5, c.titles)) }}<i v-if="c.titles > 5">×{{ c.titles }}</i></span>
            </div>
            <div v-if="hof.honors.length" class="lv-hofsec">Champions by season</div>
            <div v-for="h in hof.honors.slice(0, 6)" :key="h.season" class="lv-hofseason">
              <span class="lv-hofsno">S{{ h.season }}</span><span>🏆</span><b class="lv-cname clickable" @click="openClub(h.champion)">{{ h.champion }}</b>
            </div>
          </template>
          <div v-else class="lv-hofempty">No champions crowned yet.<br />Advance a full season to make history.</div>
        </div>
      </div>
    </template>

    <!-- the public club page (read-only) -->
    <div v-if="clubModal" class="lv-clubmodal" @click.self="clubModal = null">
      <div class="lv-clubcard">
        <button class="lv-clubx" @click="clubModal = null">✕</button>
        <div class="lv-clubhead">
          <i class="lv-badge id" :style="{ background: `hsl(${hue(clubModal.tag)} 60% 24%)`, borderColor: `hsl(${hue(clubModal.tag)} 65% 55%)` }">{{ clubModal.tag }}</i>
          <div class="lv-clubmeta">
            <b class="lv-clubname">{{ clubModal.name }}</b>
            <span class="lv-clubsub">Tier {{ clubModal.tier + 1 }} · {{ clubModal.rating }} OVR · {{ clubModal.owned ? 'human-owned' : 'AI-run' }}<template v-if="clubModal.titles"> · {{ '🏆'.repeat(Math.min(5, clubModal.titles)) }}</template></span>
          </div>
        </div>
        <div class="lv-clubfive">
          <div v-for="p in clubModal.five" :key="p.handle" class="lv-fiverow">
            <span class="rs-role" :class="p.role">{{ roleAbbr(p.role) }}</span>
            <b>{{ p.handle }}</b>
            <i v-if="p.igl" class="lv-igltag">IGL</i>
            <span class="lv-fiveovr">{{ p.overall }} <i>OVR</i></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
