<script setup lang="ts">
// The Match Center — the async-PvP client. The world resolves on the @ace/server
// tick, not in this browser; here we watch it. During a match's broadcast window the
// running score streams in live (SSE) with the result SEALED (the embargo — no
// spoilers until it's over); once revealed we pull the snapshot and re-sim it in the
// viewer (the engine runs client-side, so watching costs the server nothing). This is
// the seam between the deep persistence backend and the broadcast-grade viewer.
import { onMounted, onUnmounted, ref, computed, nextTick, shallowRef, watch as vueWatch } from 'vue';
import type { MapId, Play, Tactics, Team } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { RANK_TIERS, MAP_POOL, PLAYOFF_SLOTS, personOf, soloRank, traitOf, fmtDayMonth, FACILITIES, facilityCost, FACILITY_MAX, STAFF_ROLES, STAFF_META } from '@ace/world';
import { ANCHORS, siteIds, type Navmesh } from '@ace/maps';
import { Viewer } from './viewer';
import PlayEditor from './PlayEditor.vue';
import { starterAttack, starterDefense, altExecFrom } from './playbook';
import { AceServer, type WorldSummary, type StandingRow, type LiveFixture, type ClubPage, type MarketEntry, type SquadPlayer, type LeaderRow, type ClubRankRow, type NewsItem, type StatRow, type CupView, type CupTieView, type FriendlyRow, type ScheduleRow, type PlayoffView , TransferOffer, type Notif } from './serverApi';
const SCOUT_MAX = 3;

const DEFAULT = new URL(location.href).searchParams.get('server') || 'http://127.0.0.1:8787';
const url = ref(DEFAULT);
const server = ref<AceServer | null>(null);
const status = ref<'idle' | 'connecting' | 'live' | 'error'>('idle');
const errMsg = ref('');
const world = ref<WorldSummary | null>(null);
const table = ref<StandingRow[]>([]);
const fixtures = ref<LiveFixture[]>([]);
// the day's FEATURED match: the fixture with the highest combined squad power
// (the broadcast pin — big games should read as big at a glance)
const featuredSlot = computed<number | null>(() => {
  if (!powerClubs.value.length || fixtures.value.length < 2) return null;
  const pw = new Map(powerClubs.value.map(c => [c.tag, c.power]));
  let best: { slot: number; sum: number } | null = null;
  for (const f of fixtures.value) {
    const a = pw.get(f.home.tag), b = pw.get(f.away.tag);
    if (a == null || b == null) continue;
    if (!best || a + b > best.sum) best = { slot: f.slot, sum: a + b };
  }
  return best?.slot ?? null;
});
let stopStream: (() => void) | null = null;
let stopEvents: (() => void) | null = null;
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
const oauthProviders = ref<{ id: string; label: string }[]>([]);
// account recovery: forgot → (mailed or dev-surfaced) token → reset
const forgotMode = ref(false);
const resetToken = ref('');
const resetNote = ref('');
async function doForgot() {
  if (!server.value) return; busy.value = true; authErr.value = '';
  try {
    const r = await server.value.forgot(email.value);
    resetNote.value = r.devResetToken ? 'dev token filled below — set a new password' : 'if that email exists, a reset link is on its way';
    if (r.devResetToken) resetToken.value = r.devResetToken;
  } catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
async function doReset() {
  if (!server.value) return; busy.value = true; authErr.value = '';
  try {
    const r = await server.value.resetPassword(resetToken.value, password.value);
    if (r.reset) { resetNote.value = '✓ password reset — log in with it'; forgotMode.value = false; resetToken.value = ''; authMode.value = 'login'; }
    else authErr.value = r.error ?? 'reset failed';
  } catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
function oauthGo(pid: string) {
  if (!server.value) return;
  const back = new URL(location.href); back.searchParams.delete('oauthCode');
  location.href = server.value.oauthStart(pid, back.toString());
}
const email = ref(''); const password = ref(''); const authErr = ref(''); const busy = ref(false);
const claimTag = ref('');
const authed = computed(() => !!token.value);
// mirror the access token to localStorage so a single sign-in carries to other views
// (the World Cup election panel reuses it). Cleared on sign-out.
vueWatch(token, (t: string | null) => { if (t) localStorage.setItem('ace.token', t); else localStorage.removeItem('ace.token'); });
const tierName = (t: number) => RANK_TIERS[t] ?? `T${t}`;
const mine = (tag: string) => myClub.value?.tag === tag;
// a derby: your club's fixture where the opponent is your rival (extra morale stakes)
const isDerby = (f: { home: { tag: string }; away: { tag: string } }) => {
  const rt = myClub.value?.rival?.tag; if (!rt) return false;
  return (mine(f.home.tag) && f.away.tag === rt) || (mine(f.away.tag) && f.home.tag === rt);
};

const verifyNote = ref('');
async function doAuth() {
  if (!server.value) return; busy.value = true; authErr.value = ''; verifyNote.value = '';
  try {
    if (authMode.value === 'register') {
      const s = await server.value.register(email.value, password.value);
      token.value = s.accessToken;
      // a real account must verify its email before it can claim a club. In production
      // the user clicks a link we email; this demo surfaces the token and completes it
      // inline (an honest stand-in — same server gate, no mail server).
      await server.value.verifyEmail(s.verifyToken);
      verifyNote.value = '✓ email verified';
      setTimeout(() => (verifyNote.value = ''), 3000);
    } else {
      const s = await server.value.login(email.value, password.value);
      token.value = s.accessToken;
    }
    authOpen.value = false; password.value = '';
    await refreshMe();
    openEvents();   // re-key the event stream with the signed-in token (targeted notif/mail)
  } catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
async function refreshMe() { if (server.value && token.value) { myClub.value = await server.value.me(token.value).catch(() => null); syncTac(); await loadNotifs(); await loadMail(); await loadUpcoming(); await loadTransfers(); } }
// VIP supporter tier (never pay-to-win): dev servers activate instantly; a
// Stripe-configured server returns the hosted checkout and the webhook flips it.
const vipBusy = ref(false);
const vipDate = (t?: number | null) => t ? new Date(t * 1000).toLocaleDateString() : '';
async function goVip() {
  if (!server.value || !token.value) return;
  vipBusy.value = true;
  try {
    const r = await server.value.checkoutVip(token.value);
    if (r.url) window.open(r.url, '_blank');
    else await refreshMe();   // dev checkout — VIP is live immediately
  } catch (e) { errMsg.value = (e as Error).message; } finally { vipBusy.value = false; }
}
async function doClaim() {
  if (!server.value || !token.value || !claimTag.value) return; busy.value = true; authErr.value = '';
  try { myClub.value = await server.value.claim(claimTag.value, token.value); await refreshMe(); }  // refresh → /me carries the plan
  catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
function signOut() { token.value = null; myClub.value = null; authErr.value = ''; planOpen.value = false; openEvents(); }

// --- author your club's tactics (PATCH /me/plan → drives your next tick) ------
const planOpen = ref(false);
const tac = ref<Tactics | null>(null);
const planSaved = ref(false);
function syncTac() { const t = myClub.value?.plan?.tactics; tac.value = t ? JSON.parse(JSON.stringify(t)) as Tactics : null; }
// ── the PER-MAP PLAYBOOK (PvP): author real plays per pool map; the server
// sanitizes at the write boundary and the tick fields the FIXTURE map's slots.
// Same PlayEditor + anchor-derived starters as the single-player editor.
type PbSlot = 'attack' | 'attack2' | 'defense';
const pbMap = ref<MapId>('ascent');
const pbSlot = ref<PbSlot | null>(null);
const pbNav = shallowRef<Navmesh | null>(null);
const pbSaved = ref(false);
const pbBook = computed(() => (myClub.value?.plays ?? {}) as Partial<Record<string, { attack?: Play; attack2?: Play; defense?: Play }>>);
const pbPlay = computed<Play | null>(() => (pbSlot.value ? pbBook.value[pbMap.value]?.[pbSlot.value] ?? null : null));
const pbTeam = computed<Team | null>(() => {
  const five = myClub.value?.planFive;
  if (!five?.length || !myClub.value) return null;
  // PlayEditor only reads players' id/handle/attr.utility — a plan-five shaped Team is enough
  return { id: 'me', tag: myClub.value.tag, name: myClub.value.name,
    players: five.map(p => ({ id: p.id, handle: p.handle, role: p.role, attr: { utility: p.utility } })) } as unknown as Team;
});
function pbPick(m: MapId) { pbMap.value = m; pbSlot.value = null; void ensureNav(m).then(n => (pbNav.value = n)); }
async function pbOpen(slot: PbSlot) {
  pbNav.value = await ensureNav(pbMap.value);
  if (pbSlot.value === slot) { pbSlot.value = null; return; }
  if (!pbBook.value[pbMap.value]?.[slot] && pbTeam.value) {
    const A = ANCHORS[pbMap.value]!;
    const primary = pbBook.value[pbMap.value]?.attack;
    const play = slot === 'defense' ? starterDefense(pbTeam.value, A, pbNav.value)
      : slot === 'attack2' && primary ? altExecFrom(primary, A)
      : starterAttack(pbTeam.value, A, pbNav.value);
    await pbSave(play, slot);
  }
  pbSlot.value = slot;
}
let pbTimer: ReturnType<typeof setTimeout> | null = null;
function pbUpdate(play: Play) {
  if (!pbSlot.value) return;
  const slot = pbSlot.value;
  if (myClub.value) {   // optimistic — dragging feels live; the save is debounced
    const plays = { ...(myClub.value.plays ?? {}) } as Record<string, Record<string, unknown>>;
    plays[pbMap.value] = { ...(plays[pbMap.value] ?? {}), [slot]: play };
    myClub.value = { ...myClub.value, plays };
  }
  if (pbTimer) clearTimeout(pbTimer);
  pbTimer = setTimeout(() => void pbSave(play, slot), 400);
}
async function pbSave(play: Play | null, slot: PbSlot) {
  if (!server.value || !token.value) return;
  try {
    const r = await server.value.setPlay(token.value, pbMap.value, slot, play);
    if (r.ok && myClub.value) {
      myClub.value = { ...myClub.value, plays: r.plays as ClubPage['plays'] };
      pbSaved.value = true; setTimeout(() => (pbSaved.value = false), 1800);
    }
  } catch (e) { errMsg.value = (e as Error).message; }
}
async function pbClear() { if (!pbSlot.value) return; await pbSave(null, pbSlot.value); pbSlot.value = null; }
// UPCOMING fixtures + their (seed-derived) maps — the published rotation you
// prepare the playbook against: "day 7 vs SHS on BIND — no plays yet".
const upcoming = ref<{ day: number; opp: string; map: string; home: boolean }[]>([]);
// quick-nav: smooth-jump to a section, opening its accordion first where needed
function jump(id: string) {
  if (id === 'sec-playoffs' && !playoffsOpen.value) { playoffsOpen.value = true; void loadPlayoffs(); }
  if (id === 'sec-offers' && !transfersOpen.value) { transfersOpen.value = true; void loadTransfers(); }
  if (id === 'sec-friendlies' && !friendliesOpen.value) { friendliesOpen.value = true; void loadFriendlies(); }
  // double-tap: async panels above the target can grow after the first scroll
  // fires (anchor drift on a long page) — re-align once things settle
  const go = () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  requestAnimationFrame(go);
  setTimeout(go, 450);
}
async function loadUpcoming() {
  if (!server.value || !myClub.value) { upcoming.value = []; return; }
  try {
    const sc = await server.value.schedule(myClub.value.tier, (myClub.value as { group?: number }).group ?? 0);
    const mineTag = myClub.value.tag;
    upcoming.value = sc.matchdays.flat()
      .filter((r: ScheduleRow) => (r.home === mineTag || r.away === mineTag) && r.status === 'scheduled' && r.day > DAY.value)
      .sort((a, b) => a.day - b.day).slice(0, 5)
      .map(r => ({ day: r.day, opp: r.home === mineTag ? r.away : r.home, map: r.map, home: r.home === mineTag }));
  } catch { /* transient */ }
}
// ── FRIENDLIES: challenge any club to an instant, engine-resolved match ──────
const challengeBusy = ref(false);
const challengeResult = ref<{ id: number; map: string; score: [number, number]; home: { tag: string }; away: { tag: string }; human: boolean } | null>(null);
async function doChallenge(tag: string) {
  if (!server.value || !token.value) return;
  challengeBusy.value = true; challengeResult.value = null;
  try {
    const r = await server.value.challenge(token.value, tag);
    if (r.ok) { challengeResult.value = r; await loadFriendlies(); }
    else errMsg.value = r.error ?? 'challenge failed';
  } catch (e) { errMsg.value = (e as Error).message; } finally { challengeBusy.value = false; }
}
// ── TOASTS: pushed events surface ON SCREEN the moment they land (the bell
// badge still accumulates; a toast is the live nudge). Click → the right panel.
interface Toast { id: number; icon: string; text: string; kind: string }
const toasts = ref<Toast[]>([]);
let toastSeq = 0;
function pushToast(icon: string, text: string, kind = 'info') {
  const t: Toast = { id: ++toastSeq, icon, text, kind };
  toasts.value = [...toasts.value, t].slice(-4);   // stack caps at 4
  setTimeout(() => (toasts.value = toasts.value.filter(x => x.id !== t.id)), 6500);
}
function toastGo(t: Toast) {
  notifGo({ text: t.text });
  toasts.value = toasts.value.filter(x => x.id !== t.id);
}

// who's online — live event-stream connections mapped to club tags
const presence = ref<{ online: number; tags: string[] }>({ online: 0, tags: [] });
async function loadPresence() { if (server.value) try { presence.value = await server.value.presence(); } catch { /* transient */ } }
let presenceTimer: ReturnType<typeof setInterval> | null = null;
// a notification points somewhere — clicking it opens the right surface
function notifGo(n: { text: string; link?: Notif['link'] }) {
  // a typed deep-link wins: a result notification plays the replay, a club link
  // opens the club page — the notification IS the shortcut to the moment
  if (n.link?.kind === 'replay') { void watchAt(n.link.season, n.link.day, n.link.slot); notifOpen.value = false; return; }
  if (n.link?.kind === 'club') { void openClub(n.link.tag); notifOpen.value = false; return; }
  if (n.text.includes('Playoffs')) { playoffsOpen.value = true; void loadPlayoffs(); }
  else if (n.text.startsWith('⇄') || n.text.startsWith('✓')) { transfersOpen.value = true; void loadTransfers(); }
  else if (n.text.startsWith('⚔')) { friendliesOpen.value = true; void loadFriendlies(); }
  notifOpen.value = false;
}
// the Premier playoffs — the season climax, engine-simmed + watchable
const playoffsOpen = ref(false);
const playoffViews = ref<PlayoffView[]>([]);
async function loadPlayoffs() { if (server.value) try { playoffViews.value = (await server.value.playoffs()).history; } catch { /* transient */ } }
async function togglePlayoffs() { playoffsOpen.value = !playoffsOpen.value; if (playoffsOpen.value) await loadPlayoffs(); }
async function watchPlayoff(pseason: number, seed: number, hi: string, lo: string, score: [number, number], map: string) {
  if (!server.value) return;
  loadingWatch.value = true;
  try {
    const rep = await server.value.playoffReplay(pseason, seed);
    const nav = await ensureNav(rep.snapshot.map);
    const out = simulateMatch(rep.snapshot, nav, 50);
    watching.value = { home: { tag: hi, name: hi }, away: { tag: lo, name: lo }, final: score, map, season: pseason, day: -1, slot: -1, cup: true };
    followed.value = null;
    computeBox(out);
    const pov = mine(hi) ? 0 as const : mine(lo) ? 1 as const : undefined;
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${rep.snapshot.map}.png`, nav, { pov }); });
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}
// ── HUMAN-TO-HUMAN TRANSFERS: bid for a player on another owner's roster ────
const offerFor = ref<{ handle: string; amount: string } | null>(null);   // inline bid form on the club modal
const offerBusy = ref(false);
const offerMsg = ref('');
const transfersIn = ref<TransferOffer[]>([]);
const transfersOut = ref<TransferOffer[]>([]);
const transfersOpen = ref(false);
const pendingIn = computed(() => transfersIn.value.filter(o => o.status === 'pending').length);
async function loadTransfers() { if (server.value && token.value) try { const r = await server.value.transfers(token.value); transfersIn.value = r.incoming; transfersOut.value = r.outgoing; } catch { /* transient */ } }
async function toggleTransfers() { transfersOpen.value = !transfersOpen.value; if (transfersOpen.value) await loadTransfers(); }
async function sendOffer(tag: string) {
  if (!server.value || !token.value || !offerFor.value) return;
  const amount = Math.round(Number(offerFor.value.amount));
  if (!Number.isFinite(amount) || amount <= 0) { offerMsg.value = 'enter a real amount'; return; }
  offerBusy.value = true; offerMsg.value = '';
  try {
    const r = await server.value.offerTransfer(token.value, tag, offerFor.value.handle, amount);
    if (r.ok) { offerMsg.value = `✓ offer sent — ${offerFor.value.handle} for $${amount.toLocaleString()}; the owner decides`; offerFor.value = null; await loadTransfers(); }
    else offerMsg.value = r.error ?? 'offer failed';
  } catch (e) { offerMsg.value = (e as Error).message; } finally { offerBusy.value = false; }
}
async function answerOffer(o: TransferOffer, accept: boolean) {
  if (!server.value || !token.value) return;
  try {
    const r = await server.value.respondTransfer(token.value, o.id, accept);
    if (!r.ok && r.reason) errMsg.value = r.reason;
    await loadTransfers(); await refreshMe();
  } catch (e) { errMsg.value = (e as Error).message; }
}
async function doLoan(sp: SquadPlayer) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try {
    const r = await server.value.loanOut(token.value, sp.id);
    sellMsg.value = { ...sellMsg.value, [sp.id]: r.ok ? `✓ loaned to ${r.loan!.tag} (tier ${r.loan!.tier + 1}) — starter reps all season` : (r.reason ?? 'loan failed') };
    if (r.ok) await refreshMe();
  } catch (e) { sellMsg.value = { ...sellMsg.value, [sp.id]: (e as Error).message }; } finally { marketBusy.value = false; }
}
async function doRecall(sp: SquadPlayer) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try { const r = await server.value.recallLoan(token.value, sp.id); if (r.ok) await refreshMe(); }
  catch { /* transient */ } finally { marketBusy.value = false; }
}
async function pullOffer(o: TransferOffer) {
  if (!server.value || !token.value) return;
  try { await server.value.withdrawTransfer(token.value, o.id); await loadTransfers(); } catch { /* transient */ }
}
const friendliesOpen = ref(false);
const friendlyRows = ref<FriendlyRow[]>([]);
const friendlyH2h = ref<Record<string, { w: number; l: number }>>({});
async function loadFriendlies() { if (server.value && token.value) try { const r = await server.value.friendlies(token.value); friendlyRows.value = r.friendlies; friendlyH2h.value = r.h2h ?? {}; } catch { /* transient */ } }
async function toggleFriendlies() { friendliesOpen.value = !friendliesOpen.value; if (friendliesOpen.value) await loadFriendlies(); }
async function watchFriendly(fid: number) {
  if (!server.value) return;
  loadingWatch.value = true;
  try {
    const rep = await server.value.friendlyReplay(fid);
    const map = rep.snapshot.map;
    const nav = await ensureNav(map);
    const out = simulateMatch(rep.snapshot, nav, 50);
    watching.value = { home: rep.home, away: rep.away, final: rep.score, map, season: season.value, day: -1, slot: -1, cup: true };
    followed.value = null;
    computeBox(out);
    const pov = mine(rep.home.tag) ? 0 as const : mine(rep.away.tag) ? 1 as const : undefined;
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav, { pov }); });
    clubModal.value = null;
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}
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
// the instant buy-read: how does this free agent compare to YOUR weakest
// same-role starter? Positive = an upgrade to the fielded five right now.
const vsMine = (e: MarketEntry): { d: number; vs: string } | null => {
  const starters = (myClub.value?.squad ?? []).filter(p => p.starter && p.role === e.role && !p.loan);
  if (!starters.length) return null;
  const weakest = starters.reduce((a, b) => a.overall <= b.overall ? a : b);
  return { d: e.overall - weakest.overall, vs: weakest.handle };
};
const bidAmt = ref<Record<string, number>>({});
const bidMsg = ref<Record<string, string>>({});
const marketBusy = ref(false);
const kfmt = (n: number) => '$' + (n / 1000).toFixed(1) + 'k';
async function loadBoard() {
  if (!server.value) return;
  try { board.value = (await server.value.market()).board; bidAmt.value = Object.fromEntries(board.value.map(e => [e.handle, e.value])); }
  catch (e) { authErr.value = (e as Error).message; }
}
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
// commission a paid scouting report — tightens this prospect's ceiling band for your
// eyes (private knowledge; the asking price stays consensus-fogged). The edge: pay to
// learn the consensus is mispricing a gem, then bid at the unchanged asking.
async function scout(e: MarketEntry) {
  if (!server.value || !token.value) return; marketBusy.value = true;
  const m = (s: string) => (bidMsg.value = { ...bidMsg.value, [e.handle]: s });
  m('');
  try {
    const r = await server.value.scout(e.handle, token.value);
    if (r.ok) {
      // patch the row in place so the band tightens without a full reload (keeps the bid input)
      board.value = board.value.map(x => x.handle === e.handle ? { ...x, ceiling: r.ceiling, scoutLevel: r.level } : x);
      m(`✓ scouted — ceil ${r.ceiling[0]}–${r.ceiling[1]} (−${kfmt(r.cost!)})`);
      await refreshMe();
    } else m(r.reason === 'insufficient funds' ? `need ${kfmt(r.cost!)} to scout` : (r.reason ?? 'rejected'));
  } catch (err) { m((err as Error).message); } finally { marketBusy.value = false; }
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

// --- the lineup lever — field who you want (start a prospect to develop him) ---------
// The fielded five drives BOTH what's played and who develops (reps vs rust), so
// starting a graduated prospect is how you grow him. Compute the new valid five
// client-side (swap within role — keeps the comp valid), then save it as the lineup.
async function saveLineup(ids: string[]) {
  if (!server.value || !token.value) return; marketBusy.value = true;
  try { await server.value.setLineup(ids, token.value); await refreshMe(); }
  catch (e) { acadMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}
/** Can this benched player be started? (there's a same-role starter to drop.) */
function canStart(sp: SquadPlayer): boolean {
  const sq = myClub.value?.squad ?? [];
  return !sp.starter && sq.some(p => p.starter && p.role === sp.role);
}
/** Can this starter be benched? (a same-role reserve can cover the slot.) */
function canBench(sp: SquadPlayer): boolean {
  const sq = myClub.value?.squad ?? [];
  return sp.starter && sq.some(p => !p.starter && p.role === sp.role);
}
function startReserve(sp: SquadPlayer) {
  const sq = myClub.value?.squad ?? [];
  const drop = sq.filter(p => p.starter && p.role === sp.role).sort((a, b) => a.overall - b.overall)[0]; // weakest same-role starter
  if (!drop) return;
  const five = sq.filter(p => p.starter && p.id !== drop.id).map(p => p.id);
  five.push(sp.id);
  saveLineup(five);
}
function benchStarter(sp: SquadPlayer) {
  const sq = myClub.value?.squad ?? [];
  const sub = sq.filter(p => !p.starter && p.role === sp.role).sort((a, b) => b.overall - a.overall)[0]; // best same-role reserve
  if (!sub) return;
  const five = sq.filter(p => p.starter && p.id !== sp.id).map(p => p.id);
  five.push(sub.id);
  saveLineup(five);
}

// --- HQ / facilities: the dev money-sink (upgrade rooms to grow your squad faster) --
const hqOpen = ref(false);
const hqBusy = ref(false);
const hqMsg = ref('');
const FAC_ROOMS = FACILITIES;
const facLevel = (id: string) => (myClub.value?.facilities as Record<string, number> | undefined)?.[id] ?? 0;
async function upgradeFacility(room: string) {
  if (!server.value || !token.value) return;
  hqBusy.value = true; hqMsg.value = '';
  try {
    const r = await server.value.upgradeFacility(room, token.value);
    if (r.ok) { await refreshMe(); hqMsg.value = `✓ upgraded — boost applies from the next match-day`; }
    else hqMsg.value = r.reason === 'insufficient funds' ? `need ${kfmt(r.cost || 0)} to upgrade` : (r.reason ?? 'rejected');
  } catch (e) { hqMsg.value = (e as Error).message; } finally { hqBusy.value = false; }
}

// --- backroom staff: coach (dev), analyst (ceiling + scout), psych (fitness) --------
const staffOpen = ref(false);
const staffBusy = ref(false);
const staffMsg = ref('');
const STAFF_ROLE_LIST = STAFF_ROLES;
const staffMeta = STAFF_META as Record<string, { title: string; blurb: string }>;
const staffHired = (role: string) => myClub.value?.staff?.[role];
const staffShortlist = (role: string) => myClub.value?.staffMarket?.[role] ?? [];
async function hireStaff(role: string, memberId: string) {
  if (!server.value || !token.value) return;
  staffBusy.value = true; staffMsg.value = '';
  try { const r = await server.value.staffAction({ role, id: memberId }, token.value); if (r.ok) { await refreshMe(); staffMsg.value = '✓ hired — effect applies from the next match-day'; } }
  catch (e) { staffMsg.value = (e as Error).message; } finally { staffBusy.value = false; }
}
async function releaseStaff(role: string) {
  if (!server.value || !token.value) return;
  staffBusy.value = true;
  try { const r = await server.value.staffAction({ role, release: true }, token.value); if (r.ok) await refreshMe(); }
  catch (e) { staffMsg.value = (e as Error).message; } finally { staffBusy.value = false; }
}

// --- sponsorship: a multi-season commercial deal (base cheque + a goal bonus) --------
const sponsorOpen = ref(false);
const sponsorBusy = ref(false);
const sponsorMsg = ref('');
async function signSponsor(index: number) {
  if (!server.value || !token.value) return;
  sponsorBusy.value = true; sponsorMsg.value = '';
  try { const r = await server.value.signSponsor(index, token.value); if (r.ok) { await refreshMe(); sponsorMsg.value = '✓ deal signed'; } else sponsorMsg.value = r.reason ?? 'rejected'; }
  catch (e) { sponsorMsg.value = (e as Error).message; } finally { sponsorBusy.value = false; }
}

// --- the trophy room: your personal career cabinet (titles, promotions, briefs met) --
const trophiesOpen = ref(false);
// aggregate the career log into the silverware cabinet + records.
const trophies = computed(() => {
  // derive the cabinet from the CAREER LOG — only what you won while owning the club (not the
  // club's all-time honours, which may include an AI era before you claimed it).
  const log = myClub.value?.career ?? [];
  const finishes = log.filter(e => e.finish > 0).map(e => e.finish);
  return {
    league: log.filter(e => e.champion).length,
    cup: log.filter(e => e.cupWon).length,
    intl: log.filter(e => e.intlWon).length,
    promotions: log.filter(e => e.promoted).length,
    briefs: log.filter(e => e.briefMet).length,
    seasons: log.length,
    bestFinish: finishes.length ? Math.min(...finishes) : 0,
    topTier: log.length ? Math.min(...log.map(e => e.tier)) : (myClub.value?.tier ?? 0),
    log: [...log].sort((a, b) => b.season - a.season),
  };
});

// --- the board: the season brief + confidence (a survival narrative) ----------------
const boardOpen = ref(false);
const onTrack = () => myClub.value?.objective ? (myClub.value.objectiveRank || 99) <= myClub.value.objective.needRank : false;

// --- squad page enrichments: players are PEOPLE, and a roster-at-a-glance ----------
const ROLE_ORDER = ['duelist', 'initiator', 'controller', 'sentinel'] as const;
const ROLE_SHORT: Record<string, string> = { duelist: 'DUE', initiator: 'INI', controller: 'CON', sentinel: 'SEN' };
const ROLE_NEED: Record<string, number> = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 };
const person = (id: string) => personOf(id);                 // real name + nationality + birthday (pure)
const solo = (ovr: number) => soloRank(ovr);                 // solo-queue rank (a different axis from the club's tier)
const trait = (id: string) => traitOf(id);                   // personality trait (pure hash)
const bday = (id: string) => fmtDayMonth(personOf(id).birthday);
// roster at a glance: depth per role, plus averages + total value (read squad balance fast)
const squadSummary = computed(() => {
  const sq = myClub.value?.squad ?? []; if (!sq.length) return null;
  const avgOvr = Math.round(sq.reduce((s, p) => s + p.overall, 0) / sq.length);
  const avgAge = Math.round(sq.reduce((s, p) => s + p.age, 0) / sq.length);
  const value = sq.reduce((s, p) => s + p.value, 0);
  const out = sq.filter(p => p.injury > 0).length, tired = sq.filter(p => p.injury === 0 && p.fatigue >= 70).length;
  const wages = sq.reduce((s, p) => s + p.wage, 0), expiring = sq.filter(p => p.contractYears > 0 && p.contractYears <= 1).length;
  const depth = ROLE_ORDER.map(role => {
    const ps = sq.filter(p => p.role === role);
    return { role, short: ROLE_SHORT[role], total: ps.length, starters: ps.filter(p => p.starter).length, need: ROLE_NEED[role], thin: ps.length <= ROLE_NEED[role] };
  });
  return { count: sq.length, avgOvr, avgAge, value, depth, out, tired, wages, expiring };
});
// the player profile card (a full dossier on one of your squad)
const playerCard = ref<SquadPlayer | null>(null);
// re-sign a player to a fresh deal (re-locks his wage so he can't walk free)
const renewYears = ref<Record<string, number>>({});   // per-player negotiated term (default 3y market)
async function renew(sp: SquadPlayer) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try { const r = await server.value.renew(sp.id, token.value, renewYears.value[sp.id] ?? 3); if (r.ok) await refreshMe(); }
  catch (e) { errMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}
const renewWageFor = (sp: SquadPlayer) => sp.renewTerms?.find(t => t.years === (renewYears.value[sp.id] ?? 3))?.wage ?? sp.renew;
// training focus — direct a player's reps at one skill (click the attr to toggle; a tradeoff:
// that skill grows faster, the rest a touch slower). Clicking the focused skill clears it.
async function setFocus(sp: SquadPlayer, attr: string) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try { const r = await server.value.setFocus(sp.id, sp.focus === attr ? null : attr, token.value); if (r.ok) await refreshMe(); }
  catch (e) { errMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}
// team talk — set the pre-match tone (calm/rally/demand); the read grades it against the matchup.
// Clicking the chosen tone clears it. It lands next match then is consumed by the tick.
const TALK_TONES = [
  { key: 'calm', icon: '○', label: 'Stay calm' },
  { key: 'rally', icon: '▲', label: 'Rally them' },
  { key: 'demand', icon: '✦', label: 'Demand more' },
] as const;
async function setTalk(tone: string) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try { const r = await server.value.setTalk(myClub.value?.teamTalk === tone ? null : tone, token.value); void r; await refreshMe(); }
  catch (e) { errMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}
// captaincy — name the armband (a leader steadies + lifts the room). Click the current captain to auto.
async function setCaptain(sp: SquadPlayer) {
  if (!server.value || !token.value || !sp.starter) return;
  marketBusy.value = true;
  try { const r = await server.value.setCaptain(sp.captain ? null : sp.id, token.value); if (r.ok) await refreshMe(); }
  catch (e) { errMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}
function moodLabel(m: number): string { return m >= 78 ? 'buzzing' : m >= 62 ? 'good' : m >= 45 ? 'flat' : 'low'; }
// pre-season training camp — a once-per-season prep choice (locked once the campaign's underway).
const CAMPS = [
  { key: 'fitness', icon: '⛰', label: 'Fitness camp', blurb: 'slower fatigue all season — your stars stay fresh' },
  { key: 'chemistry', icon: '⬡', label: 'Team building', blurb: 'the squad gels faster — chemistry builds quicker' },
  { key: 'sharpness', icon: '◎', label: 'Scrim block', blurb: 'sharper out the gate — higher morale all season' },
] as const;
async function setCamp(camp: string) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try { const r = await server.value.setCamp(myClub.value?.camp === camp ? null : camp, token.value); if (r.ok) await refreshMe(); else errMsg.value = r.error ?? ''; }
  catch (e) { errMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}

// --- the academy — your homegrown youth pipeline (build → intake → develop → graduate)
const academyOpen = ref(false);
const acadBusy = ref(false);
const acadMsg = ref('');
const academy = computed(() => myClub.value?.academy ?? null);

// club-management panels are an ACCORDION — opening one closes the rest (no messy stacking).
// One coordinator drives all seven toggles; it also lazy-loads the market board on first open.
const PANEL_REFS: Record<string, { value: boolean }> = { tactics: planOpen, market: marketOpen, academy: academyOpen, hq: hqOpen, staff: staffOpen, sponsor: sponsorOpen, board: boardOpen, trophies: trophiesOpen };
async function showPanel(which: string) {
  const target = PANEL_REFS[which]; const wasOpen = target.value;
  for (const r of Object.values(PANEL_REFS)) r.value = false;
  target.value = !wasOpen;
  if (which === 'market' && marketOpen.value && !board.value.length) void loadBoard();
  if (target.value) { await nextTick(); document.querySelector('.lv-planpanel, .lv-mktpanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}
// Escape closes whatever's open (accordion panels + the bell/mail/chat dropdowns) — the
// expected "get me out of here" gesture, so a manager never has to hunt for the ✕.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (![...Object.values(PANEL_REFS), notifOpen, mailOpen, chatOpen].some(r => r.value)) return;
  for (const r of Object.values(PANEL_REFS)) r.value = false;
  notifOpen.value = false; mailOpen.value = false;
  if (chatOpen.value) toggleChat();   // routes through the stream cleanup
}
async function upgradeAcademy() {
  if (!server.value || !token.value) return; acadBusy.value = true; acadMsg.value = '';
  try {
    const r = await server.value.upgradeAcademy(token.value);
    acadMsg.value = r.error ? r.error : `✓ youth wing → level ${r.level}`;
    await refreshMe();
  } catch (e) { acadMsg.value = (e as Error).message; } finally { acadBusy.value = false; }
}
async function promoteProspect(p: { id: string; handle: string }) {
  if (!server.value || !token.value) return; acadBusy.value = true; acadMsg.value = '';
  try {
    const r = await server.value.promoteProspect(p.id, token.value);
    acadMsg.value = r.ok ? `✓ ${p.handle} graduated to the senior squad` : (r.error ?? 'rejected');
    await refreshMe();
  } catch (e) { acadMsg.value = (e as Error).message; } finally { acadBusy.value = false; }
}
async function cutProspect(p: { id: string; handle: string }) {
  if (!server.value || !token.value) return; acadBusy.value = true; acadMsg.value = '';
  try { await server.value.cutProspect(p.id, token.value); acadMsg.value = `cut ${p.handle}`; await refreshMe(); }
  catch (e) { acadMsg.value = (e as Error).message; } finally { acadBusy.value = false; }
}
async function scoutProspect(p: { id: string; handle: string }) {
  if (!server.value || !token.value) return; acadBusy.value = true; acadMsg.value = '';
  try {
    const r = await server.value.scoutProspect(p.id, token.value);
    acadMsg.value = r.ok ? `✓ ${p.handle} scouted — ceil ${r.ceiling[0]}–${r.ceiling[1]} (−${kfmt(r.cost!)})`
      : (r.reason === 'insufficient funds' ? `need ${kfmt(r.cost!)} to scout` : (r.reason ?? 'rejected'));
    await refreshMe();
  } catch (e) { acadMsg.value = (e as Error).message; } finally { acadBusy.value = false; }
}

// --- per-skill scouting detail — the spiky-prospect read (role-fit is a real call) ---
const expanded = ref<Set<string>>(new Set());
function toggleExpand(key: string) {
  const s = new Set(expanded.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  expanded.value = s;
}
const ATTR_LABEL: Record<string, string> = { aim: 'AIM', movement: 'MOV', entry: 'ENT', gameSense: 'GME', utility: 'UTL', clutch: 'CLT' };

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
    server.value = s; status.value = 'live';
    const saved = localStorage.getItem('ace.token');   // stay signed in across refresh
    if (saved && !token.value) token.value = saved;
    // social sign-in return leg: the callback bounced back with a one-time code —
    // swap it for OUR session over POST (tokens never ride a URL), then clean it
    const ocode = new URL(location.href).searchParams.get('oauthCode');
    if (ocode) {
      try { token.value = (await s.oauthComplete(ocode)).accessToken; } catch { authErr.value = 'sign-in expired — try again'; }
      const clean = new URL(location.href); clean.searchParams.delete('oauthCode');
      history.replaceState(null, '', clean.toString());
    }
    try { oauthProviders.value = (await s.authProviders()).providers; } catch { /* older server */ }
    await refreshMe();
    await refreshTable();   // after refreshMe, so the table follows YOUR division if you're not Premier
    await loadHonors();
    await loadNews();
    void loadPower();   // feeds the FEATURED-match pin (memoized server-side)
    openStream();
    // a shared deep-link (?watch=season/day/slot) → auto-open that replay
    const wp = new URL(location.href).searchParams.get('watch');
    if (wp) { const [ws, wd, wsl] = wp.split('/').map(Number); if (![ws, wd, wsl].some(isNaN)) void watchAt(ws, wd, wsl); }
    // the live-sync spine: one /events stream pushes every change (day/reveal/
    // market/notif/mail/season) — no per-client polling loops
    openEvents();
    await loadPresence();
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(loadPresence, 30000);
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
// the world clock is SERVER-OWNED: when manual advance is off (the product), the
// UI shows a countdown to the scheduled tick instead of a button. Offset-corrected
// against the server's own `now` so a skewed client clock can't lie.
const clockTick = ref(0);
setInterval(() => clockTick.value++, 1000);
const nextTickIn = computed(() => {
  void clockTick.value;
  if (!world.value?.nextTickAt) return null;
  const offset = world.value.now - connectedAtLocal;   // server now vs our clock at fetch
  const left = Math.round(world.value.nextTickAt - offset - Date.now() / 1000);
  return left > 0 ? left : 0;
});
let connectedAtLocal = Date.now() / 1000;
vueWatch(world, w => { if (w) connectedAtLocal = Date.now() / 1000; });
const mmss = (s2: number) => `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
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
    await loadNews();
    if (statsOpen.value) await loadStats();
    if (r.rollover) cupView.value = null;            // a new season → a fresh cup
    if (cupOpen.value) await loadCup();
  } catch (e) { errMsg.value = (e as Error).message; } finally { advancing.value = false; }
}
// ── the live-sync layer: server events drive every refresh ──────────────────
// The /events stream is the source of truth for "something changed". Each event
// refreshes exactly the affected slices; `resync` (or a reconnect that lands on
// a moved world) falls back to a FULL refetch — so this client can lag by a
// round-trip but can never be silently stale. A slow 60s failsafe poll remains
// as belt-and-braces (vs the old 4s × 3-endpoint poll per client).
async function fullRefresh() {
  if (!server.value) return;
  try {
    world.value = await server.value.world();
    DAY.value = world.value.broadcastDay ?? 0;
    openStream();
    await refreshMe(); await refreshTable(); await loadNews(); await loadHonors();
    if (board.value.length || marketOpen.value) await loadBoard();
    if (statsOpen.value) await loadStats();
    if (cupOpen.value) await loadCup();
  } catch { /* transient — the failsafe or the next event catches us up */ }
}
function openEvents() {
  if (!server.value) return;
  stopEvents?.();
  stopEvents = server.value.events(token.value, async (ev, data) => {
    if (ev === 'hello') {   // (re)connected: if the world moved while we were away, catch up fully
      if (world.value && (data.day as number) !== DAY.value) await fullRefresh();
      return;
    }
    if (ev === 'season') {
      if (data.champion) champBanner.value = { season: (data.season as number) - 1, champion: data.champion as string };
      cupView.value = null;   // a new season → a fresh cup
      if (playoffsOpen.value) await loadPlayoffs();   // the climax just resolved
      await fullRefresh();
      return;
    }
    if (ev === 'day') {
      // instant: the event carries the new cursor — flip the header + live-score
      // stream NOW (cheap, shared hub), then spread the heavy refetch over a few
      // seconds so a thousand clients don't stampede the API in the same instant
      DAY.value = data.day as number;
      if (world.value) world.value = { ...world.value, season: data.season as number, broadcastDay: data.day as number };
      openStream();
      pushToast('📡', `Match-day ${(data.day as number) + 1} is LIVE — broadcasts rolling`, 'day');
      await new Promise(r => setTimeout(r, Math.random() * 2500));
      await fullRefresh();
      return;
    }
    if (ev === 'reveal') { await refreshTable(); if (statsOpen.value) await loadStats(); return; }
    if (ev === 'news') { await loadNews(); return; }
    if (ev === 'market') { await refreshMe(); if (board.value.length || marketOpen.value) await loadBoard(); return; }
    if (ev === 'notif') { pushToast('🔔', String((data as { text?: string }).text ?? 'notification'), 'notif'); await loadNotifs(); return; }
    if (ev === 'mail') { pushToast('✉', `mail from ${String((data as { from?: string }).from ?? 'an owner')}: ${String((data as { subject?: string }).subject ?? '')}`, 'mail'); await loadMail(); return; }
  }, fullRefresh);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { refreshTable(); if (!notifOpen.value) loadNotifs(); if (!mailOpen.value) loadMail(); }, 60000);
}

// the standings follow YOUR division by default — but the whole pyramid is
// browsable: tier chips swap the table to any division (scout the league above,
// watch the relegation scrap below). `viewTier` null = my division / Premier.
const viewTier = ref<number | null>(null);
const tableTier = computed(() => viewTier.value ?? myClub.value?.tier ?? 0);
const tableGroup = computed(() => tableTier.value === (myClub.value?.tier ?? -1) ? ((myClub.value as { group?: number } | null)?.group ?? 0) : 0);
function pickTier(t: number) { viewTier.value = t === (myClub.value?.tier ?? 0) ? null : t; void refreshTable(); }
// STAKES striping — what each table position is playing for (the pyramid's cut
// lines, mirrored from the rollover rules): Premier top 4 → the title playoffs;
// lower tiers' top `promo` auto-promote and the next PLAYOFF_SLOTS enter the
// promotion playoff; every non-bottom tier's bottom `promo` auto-relegate with
// the band above them at risk (challenged by the lower tier's playoff).
function zoneOf(rank: number): string {
  const n = table.value.length; if (!world.value || !n) return '';
  const k = world.value.promo ?? 2, t = tableTier.value, bottom = (world.value.tiers ?? 1) - 1;
  const down = t < bottom ? (rank >= n - k ? 'down' : rank >= n - k - PLAYOFF_SLOTS ? 'risk' : '') : '';
  if (t === 0) return rank < 4 ? 'po' : down;
  return rank < k ? 'up' : rank < k + PLAYOFF_SLOTS ? 'pop' : down;
}
const zoneLegend = computed(() => {
  const seen = new Set(table.value.map((_, i) => zoneOf(i)).filter(Boolean));
  const L: Record<string, string> = { po: 'title playoffs', up: 'promoted', pop: 'promotion playoff', risk: 'at risk', down: 'relegated' };
  return ['po', 'up', 'pop', 'risk', 'down'].filter(z => seen.has(z)).map(z => ({ z, label: L[z] }));
});
async function refreshTable() { if (server.value && world.value) try { table.value = (await server.value.standings(world.value.season, tableTier.value, tableGroup.value)).table; } catch { /* transient */ } }
// the Hall of Fame — the world's champions (the legacy engine)
const hof = ref<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[]; awards?: { season: number; mvp: { handle: string; club: string; kills: number } | null; youngGun: { handle: string; club: string; kills: number; age: number } | null }[]; legends?: { handle: string; club: string; kills: number; seasons: number; mvps: number }[] }>({ honors: [], allTime: [] });
async function loadHonors() { if (server.value) try { hof.value = await server.value.honors(); } catch { /* transient */ } }

// the world news feed — a live ticker of transfers + champions (the world feels alive)
const newsFeed = ref<NewsItem[]>([]);
const newsIcon: Record<string, string> = { transfer: '⇄', champion: '🏆', season: '◇', award: '★' };
async function loadNews() { if (server.value) try { newsFeed.value = (await server.value.news()).news; } catch { /* transient */ } }

// notifications — the world targeted to YOU (your fixtures/results/season events)
const notifList = ref<import('./serverApi').Notif[]>([]);
const notifUnread = ref(0);
const notifOpen = ref(false);
const notifIcon: Record<string, string> = { fixture: '⚔', result: '▣', season: '◇', award: '★', system: 'ⓘ' };
async function loadNotifs() {
  if (!server.value || !token.value) return;
  try { const r = await server.value.notifications(token.value); notifList.value = r.items; notifUnread.value = r.unread; } catch { /* transient */ }
}
async function toggleNotifs() {
  notifOpen.value = !notifOpen.value;
  if (notifOpen.value && server.value && token.value && notifUnread.value) {
    try { await server.value.markNotifsRead(token.value); notifUnread.value = 0; notifList.value = notifList.value.map(n => ({ ...n, read: true })); } catch { /* transient */ }
  }
}

// owner-to-owner mail (human-to-human)
const mailList = ref<import('./serverApi').MailMsg[]>([]);
const mailUnread = ref(0);
const mailOpen = ref(false);
const mailRecips = ref<{ tag: string; name: string }[]>([]);
const mailTo = ref(''); const mailSubject = ref(''); const mailBody = ref(''); const mailMsg = ref('');
async function loadMail() {
  if (!server.value || !token.value) return;
  try { const r = await server.value.mail(token.value); mailList.value = r.items; mailUnread.value = r.unread; } catch { /* transient */ }
}
const openThread = ref<number | null>(null);
const replyText = ref('');
async function toggleMail() {
  mailOpen.value = !mailOpen.value;
  if (mailOpen.value && server.value && token.value) {
    try { mailRecips.value = (await server.value.mailRecipients(token.value)).recipients; } catch { /* transient */ }
  } else { openThread.value = null; }
}
// group the flat message list into conversation threads (newest activity first)
const mailThreads = computed(() => {
  const by = new Map<number, typeof mailList.value>();
  for (const m of mailList.value) { const t = by.get(m.threadId) ?? []; t.push(m); by.set(m.threadId, t); }
  return [...by.values()].map(msgs => {
    const sorted = [...msgs].sort((a, b) => a.at - b.at);
    const last = sorted[sorted.length - 1];
    return { threadId: last.threadId, other: last.mine ? last.toTag : last.fromTag, subject: sorted[0].subject, last, messages: sorted, unread: msgs.filter(m => !m.read && !m.mine).length };
  }).sort((a, b) => b.last.at - a.last.at);
});
async function openMailThread(threadId: number) {
  openThread.value = openThread.value === threadId ? null : threadId;
  if (openThread.value != null && server.value && token.value) {
    try { await server.value.markMailRead(token.value, { threadId }); mailList.value = mailList.value.map(m => m.threadId === threadId ? { ...m, read: true } : m); mailUnread.value = mailList.value.filter(m => !m.read && !m.mine).length; } catch { /* transient */ }
  }
}
async function sendMail() {
  if (!server.value || !token.value || !mailTo.value || !mailBody.value.trim()) return;
  mailMsg.value = '';
  try {
    const r = await server.value.sendMail(token.value, mailTo.value, mailSubject.value, mailBody.value);
    if (r.ok) { mailMsg.value = `✓ sent to ${mailTo.value}`; mailSubject.value = ''; mailBody.value = ''; await loadMail(); }
    else mailMsg.value = r.error ?? 'failed';
  } catch (e) { mailMsg.value = (e as Error).message; }
}
async function doReply(threadId: number) {
  if (!server.value || !token.value || !replyText.value.trim()) return;
  const last = mailList.value.filter(m => m.threadId === threadId).sort((a, b) => b.at - a.at)[0];
  if (!last) return;
  const txt = replyText.value; replyText.value = '';
  try { const r = await server.value.replyMail(token.value, last.id, txt); if (r.ok) await loadMail(); else replyText.value = txt; } catch { replyText.value = txt; }
}

// live chat (real-time SSE) — rooms ('global' + your division) + presence (who's online)
const chatMsgs = ref<import('./serverApi').ChatMsg[]>([]);
const chatOpen = ref(false);
const chatInput = ref('');
const chatRoom = ref('global');
const chatOnline = ref<string[]>([]);
let chatStop: (() => void) | null = null;
const myDivRoom = computed(() => (myClub.value ? `div:${myClub.value.tier}:${(myClub.value as { group?: number }).group ?? 0}` : ''));
function subscribeChat() {
  if (!server.value) return;
  chatStop?.(); chatMsgs.value = []; chatOnline.value = [];
  chatStop = server.value.chatStream(
    chatRoom.value, token.value,
    msgs => (chatMsgs.value = msgs),
    m => (chatMsgs.value = [...chatMsgs.value, m].slice(-120)),
    tags => (chatOnline.value = tags),
  );
}
function toggleChat() {
  chatOpen.value = !chatOpen.value;
  if (chatOpen.value) subscribeChat();
  else { chatStop?.(); chatStop = null; }
}
function switchRoom(room: string) { if (room === chatRoom.value) return; chatRoom.value = room; if (chatOpen.value) subscribeChat(); }
async function sendChat() {
  if (!server.value || !token.value || !chatInput.value.trim()) return;
  const t = chatInput.value; chatInput.value = '';
  try { await server.value.sendChat(token.value, chatRoom.value, t); } catch { chatInput.value = t; }
}

// the world's best players — a cross-club prestige board (who's the best, and where)
const leaders = ref<LeaderRow[]>([]);
const leaderRole = ref<string>('');
const leadersOpen = ref(false);
const ROLE_TABS = [{ k: '', l: 'All' }, { k: 'duelist', l: 'Duelist' }, { k: 'initiator', l: 'Initiator' }, { k: 'controller', l: 'Controller' }, { k: 'sentinel', l: 'Sentinel' }];
async function loadLeaders() { if (server.value) try { leaders.value = (await server.value.leaderboard(leaderRole.value || undefined)).players; } catch { /* transient */ } }
async function setLeaderRole(r: string) { leaderRole.value = r; await loadLeaders(); }
async function toggleLeaders() { leadersOpen.value = !leadersOpen.value; if (leadersOpen.value && !leaders.value.length) await loadLeaders(); }

// club power rankings — squad strength + lifecycle stage (read the league: who's a
// fading dynasty, who's a rising threat — a different axis from this season's standings)
const powerClubs = ref<ClubRankRow[]>([]);
const powerOpen = ref(false);
const PHASE_LABEL: Record<string, string> = { rebuilding: 'rebuild', rising: 'rising', prime: 'prime', aging: 'aging' };
async function loadPower() { if (server.value) try { powerClubs.value = (await server.value.powerRankings()).clubs; } catch { /* transient */ } }
async function togglePower() { powerOpen.value = !powerOpen.value; if (powerOpen.value && !powerClubs.value.length) await loadPower(); }

// the domestic ACE Cup — every club entered, open draw, full-simmed on the watchable ties
// (Premier / owned). The whole world is in it, so a minnow can knock out a giant.
const cupView = ref<CupView | null>(null);
const cupOpen = ref(false);
async function loadCup() { if (server.value) try { cupView.value = await server.value.cup(); } catch { /* transient */ } }
async function toggleCup() { cupOpen.value = !cupOpen.value; if (cupOpen.value && !cupView.value) await loadCup(); }
const cupLateRounds = computed(() => (cupView.value?.rounds ?? []).filter(r => r.ties.length <= 8));   // QF onward
// YOUR club's latest cup tie (any round) — surfaced + watchable, so you can follow your own run
const myCupRun = computed(() => {
  const tag = myClub.value?.tag; if (!tag || !cupView.value) return null;
  for (let r = cupView.value.rounds.length - 1; r >= 0; r--) {
    const t = cupView.value.rounds[r].ties.find(x => x.home.tag === tag || x.away.tag === tag);
    if (t) return { tie: t, round: cupView.value.rounds[r].name, won: t.winner === (t.home.tag === tag ? t.home.idx : t.away.idx) };
  }
  return null;
});
async function watchCupTie(t: CupTieView) {
  if (!server.value || !t.watchable) return;
  loadingWatch.value = true;
  try {
    const rep = await server.value.cupReplay(t.id);
    if (!rep?.snapshot) return;
    const map = rep.snapshot.map;
    const nav = await ensureNav(map);
    const out = simulateMatch(rep.snapshot, nav, 50);
    watching.value = { home: { tag: t.home.tag, name: t.home.name }, away: { tag: t.away.tag, name: t.away.name }, final: t.score, map, season: cupView.value?.season ?? 0, day: -1, slot: -1, cup: true };
    followed.value = null;
    computeBox(out);
    const pov = mine(t.home.tag) ? 0 as const : mine(t.away.tag) ? 1 as const : undefined;
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav, { pov }); });
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}

// season stat leaders — top fraggers from the watched (Premier) matches that have played
const statRows = ref<StatRow[]>([]);
const statsOpen = ref(false);
const statScope = ref<'season' | 'career'>('season');
async function loadStats() {
  if (!server.value) return;
  try {
    statRows.value = statScope.value === 'career'
      ? (await server.value.careerStats()).players
      : (await server.value.stats()).players;
  } catch { /* transient */ }
}
async function setStatScope(sc: 'season' | 'career') { statScope.value = sc; await loadStats(); }
async function toggleStats() { statsOpen.value = !statsOpen.value; if (statsOpen.value) await loadStats(); }

// --- watch a revealed fixture back in the viewer (live or via a shared link) ---
interface Watched { home: { tag: string; name: string }; away: { tag: string; name: string }; final: [number, number] | null; map: string | null; season: number; day: number; slot: number; live?: boolean; cup?: boolean }
const host = ref<HTMLElement | null>(null);
const watching = ref<Watched | null>(null);
const loadingWatch = ref(false);

// the post-match box score — derived client-side from the re-simmed timeline's kill
// events (the engine keys kills by player handle). Each player's K/D, first bloods,
// and a Player of the Match (most kills, K−D tiebreak). The watch view is the product.
interface BoxRow { handle: string; name?: string; flag?: string; role: string; agent?: string; igl?: boolean; kills: number; deaths: number; fb: number; hsPct: number; mvp: boolean }
const boxScore = ref<{ teams: [BoxRow[], BoxRow[]]; mvp: string } | null>(null);
// the match's TURNING POINT — the round the eventual winner stole against the worst
// pre-round True Odds (the engine's own 50× counterfactual measure, already on every
// round). Only a genuine steal (< 47%) earns the card; the replay button jumps the
// viewer straight to that round.
interface Turning { idx: number; round: number; odds: number; site: string; before: [number, number]; after: [number, number]; team: string; closer?: { killer: string; hs?: boolean } }
const turning = ref<Turning | null>(null);
// box-score row → follow-cam: the handle the director is locked onto (click again to release)
const followed = ref<string | null>(null);
function followRow(h: string) {
  followed.value = followed.value === h ? null : h;
  viewer?.follow(followed.value);
  if (followed.value) host.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function replayTurning() {
  if (!turning.value || !viewer) return;
  viewer.goToRound(turning.value.idx);
  host.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function computeTurning(tl: import('@ace/shared').MatchTimeline) {
  const mw: 0 | 1 = tl.finalScore[0] >= tl.finalScore[1] ? 0 : 1;
  const run: [number, number] = [0, 0];
  let best: Turning | null = null;
  tl.rounds.forEach((r, i) => {
    const before: [number, number] = [run[0], run[1]];
    run[r.winner]++;
    if (r.winner !== mw || r.winPct == null) return;
    const odds = r.attacker === r.winner ? r.winPct : 1 - r.winPct;
    if (best && odds >= best.odds) return;
    const ks = r.events.filter((e): e is Extract<typeof e, { kind: 'kill' }> => e.kind === 'kill').sort((a, b) => a.t - b.t);
    const last = ks[ks.length - 1];
    best = { idx: i, round: r.n, odds, site: r.site, before, after: [run[0], run[1]], team: tl.teams[mw].tag, closer: last ? { killer: last.killer, hs: last.hs } : undefined };
  });
  turning.value = best && (best as Turning).odds < 0.47 ? best : null;
}
function computeBox(tl: import('@ace/shared').MatchTimeline) {
  computeTurning(tl);
  const kills: Record<string, number> = {}, deaths: Record<string, number> = {}, fb: Record<string, number> = {}, hs: Record<string, number> = {};
  for (const r of tl.rounds) {
    const ks = r.events.filter((e): e is Extract<typeof e, { kind: 'kill' }> => e.kind === 'kill').sort((a, b) => a.t - b.t);
    ks.forEach((e, i) => { kills[e.killer] = (kills[e.killer] || 0) + 1; deaths[e.victim] = (deaths[e.victim] || 0) + 1; if (i === 0) fb[e.killer] = (fb[e.killer] || 0) + 1; if (e.hs) hs[e.killer] = (hs[e.killer] || 0) + 1; });
  }
  const rowsOf = (t: number): BoxRow[] => tl.teams[t].players.map(p => { const person = personOf(p.id); const k = kills[p.handle] || 0; return { handle: p.handle, name: person.name, flag: person.nation.flag, role: p.role, agent: p.agent, igl: p.igl, kills: k, deaths: deaths[p.handle] || 0, fb: fb[p.handle] || 0, hsPct: k ? Math.round((hs[p.handle] || 0) / k * 100) : 0, mvp: false }; })
    .sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths));
  const all = [...rowsOf(0), ...rowsOf(1)];
  const mvp = all.slice().sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths))[0];
  if (mvp) mvp.mvp = true;
  boxScore.value = { teams: [rowsOf(0).map(r => ({ ...r, mvp: r.handle === mvp?.handle })), rowsOf(1).map(r => ({ ...r, mvp: r.handle === mvp?.handle }))], mvp: mvp?.handle ?? '' };
}
// the post-match DEBRIEF — did YOUR reads play out? Your matches only (pov set).
// Mirrors the engine's read→site mapping (readIndex) against each round's ACTUAL
// site: your defensive stack vs where their attack went, and your attack picks vs
// THEIR stacked site — the pre-match dossier's counter-tip, graded after the fact.
// Pure presentation over the timeline + the replay snapshot's tactics (which are
// the REAL tactics the tick resolved — an AI's matchup read included).
interface DebriefSide { site: string; hit: number; hitWon: number; off: number; offWon: number }
const debrief = ref<{ def: DebriefSide | null; atk: DebriefSide | null } | null>(null);
function readSiteOf(read: number, sites: string[]): string {
  if (sites.length <= 2) return read >= 0 ? sites[0] : sites[1] ?? sites[0];
  return sites[Math.max(0, Math.min(sites.length - 1, Math.round((1 - read) / 2 * (sites.length - 1))))];
}
function computeDebrief(tl: import('@ace/shared').MatchTimeline, snap: import('@ace/shared').MatchInput | null, pov?: 0 | 1) {
  debrief.value = null;
  if (pov == null || !snap?.tactics) return;
  const opp = (1 - pov) as 0 | 1;
  const sites = siteIds((ANCHORS[tl.map as MapId] ?? ANCHORS.ascent)!).map(String);
  const myRead = readSiteOf(snap.tactics[pov].defense.read, sites);
  const theirRead = readSiteOf(snap.tactics[opp].defense.read, sites);
  const def: DebriefSide = { site: myRead, hit: 0, hitWon: 0, off: 0, offWon: 0 };
  const atk: DebriefSide = { site: theirRead, hit: 0, hitWon: 0, off: 0, offWon: 0 };
  for (const r of tl.rounds) {
    const won = r.winner === pov;
    const s = r.attacker === opp ? def : atk;                      // our defense vs our attack round
    const target = r.attacker === opp ? myRead : theirRead;        // the stacked site that mattered
    if (r.site === target) { s.hit++; if (won) s.hitWon++; } else { s.off++; if (won) s.offWon++; }
  }
  debrief.value = { def: def.hit + def.off ? def : null, atk: atk.hit + atk.off ? atk : null };
}
// one-line coaching verdicts, computed from the tallies (never a mugging — a tip)
const defTip = computed(() => {
  const d = debrief.value?.def; if (!d) return '';
  const n = d.hit + d.off;
  if (d.hit >= n / 2 && d.hit && d.hitWon / d.hit >= 0.5) return '✓ read right — and the stack held';
  if (d.hit >= n / 2 && d.hit) return 'read right, but the site still fell — a shape problem, not a read problem';
  return `they went the other way ${d.off}/${n} — consider flipping the read`;
});
const atkTip = computed(() => {
  const a = debrief.value?.atk; if (!a) return '';
  const offPct = a.off ? a.offWon / a.off : 0, hitPct = a.hit ? a.hitWon / a.hit : 0;
  if (a.hit >= a.off && hitPct >= 0.5) return '✓ you ran through their stack anyway — the firepower beat the read';
  if (a.off > a.hit && offPct >= hitPct) return '✓ you attacked around their stack';
  if (a.hit >= a.off) return 'you kept hitting their stacked site and it cost you — flip your site bias';
  return 'you avoided their stack, but the hits into it went better — the stack was soft';
});
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
    followed.value = null;
    computeBox(out);
    const pov = mine(fx.home.tag) ? 0 as const : mine(fx.away.tag) ? 1 as const : undefined;
    computeDebrief(out, rep.snapshot, pov);
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav, { pov }); });
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}
// --- watch a match LIVE, in the viewer, synced to the broadcast (no spoilers) ---
// The server ships the timeline gated to COMPLETED rounds only; we poll, and feed each
// freshly-broadcast round into the viewer (which holds at the "live tail" until more
// arrive). On reveal the full timeline + final drop in and the box score appears.
let livePoll: ReturnType<typeof setInterval> | null = null;
function stopLivePoll() { if (livePoll) { clearInterval(livePoll); livePoll = null; } }
async function watchLive(fx: LiveFixture) {
  if (!server.value) return;
  loadingWatch.value = true;
  try {
    const lt = await server.value.liveTimeline(season.value, DAY.value, fx.slot);
    if (!lt.timeline || lt.completed < 1) { errMsg.value = 'round 1 is still being decided — try again in a moment'; return; }
    const map = lt.timeline.map;
    const nav = await ensureNav(map);
    const tl = lt.timeline;
    watching.value = { home: fx.home, away: fx.away, final: lt.resolved ? tl.finalScore : null, map, season: season.value, day: DAY.value, slot: fx.slot, live: !lt.resolved };
    boxScore.value = null; turning.value = null; followed.value = null; debrief.value = null;
    const pov = mine(fx.home.tag) ? 0 as const : mine(fx.away.tag) ? 1 as const : undefined;
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, tl, `/${map}.png`, nav, { live: !lt.resolved, pov }); });
    if (lt.resolved) { computeBox(tl); void debriefFromReplay(tl, fx.slot, pov); }
    else startLivePoll(fx.slot);
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}
function startLivePoll(slot: number) {
  stopLivePoll();
  livePoll = setInterval(async () => {
    if (!server.value || !viewer) { stopLivePoll(); return; }
    try {
      const lt = await server.value.liveTimeline(season.value, DAY.value, slot);
      if (!lt.timeline) return;
      viewer.setTimeline(lt.timeline, { live: !lt.resolved });
      if (lt.resolved) {
        stopLivePoll();
        computeBox(lt.timeline);
        if (watching.value) {
          watching.value = { ...watching.value, live: false, final: lt.timeline.finalScore };
          const pov = mine(watching.value.home.tag) ? 0 as const : mine(watching.value.away.tag) ? 1 as const : undefined;
          void debriefFromReplay(lt.timeline, slot, pov);
        }
      }
    } catch { /* transient — keep polling */ }
  }, 2500);
}
/** The live path has no snapshot in hand — once resolved, pull the replay input
 *  (now public) just for its tactics and grade the debrief off it. */
async function debriefFromReplay(tl: import('@ace/shared').MatchTimeline, slot: number, pov?: 0 | 1) {
  if (pov == null || !server.value) return;
  try {
    const rep = await server.value.replay(season.value, DAY.value, slot);
    if (rep?.snapshot) computeDebrief(tl, rep.snapshot, pov);
  } catch { /* embargo edge — the replay card just doesn't show */ }
}
function closeWatch() { stopLivePoll(); watching.value = null; boxScore.value = null; turning.value = null; followed.value = null; debrief.value = null; viewer?.destroy(); viewer = null; }
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
  offerFor.value = null; offerMsg.value = '';
  try { clubModal.value = await server.value.club(slug, token.value ?? undefined); if (token.value && !Object.keys(friendlyH2h.value).length) void loadFriendlies(); }
  catch (e) { errMsg.value = (e as Error).message; } finally { clubBusy.value = false; }
}
const roleAbbr = (r: string) => r.slice(0, 3).toUpperCase();
// club-profile readouts: a star tier from squad power, and the world-rank percentile
const kfans = (n = 0) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const clubStars = (power = 0) => Math.max(1, Math.min(5, Math.round((power - 55) / 7)));   // ~55→1★ .. ~90→5★
// ── PRE-MATCH PREVIEW: the tale of the tape for your NEXT fixture ──────────
const preview = ref<{ me: ClubPage; them: ClubPage; map: string; home: boolean; day: number; label?: string } | null>(null);
const previewBusy = ref(false);
async function openPreview() {
  if (!upcoming.value.length) return;
  const u = upcoming.value[0];
  await openPreviewVs(u.opp, u.map, u.home, u.day);
}
async function openPreviewVs(opp: string, map: string, home: boolean, day: number, label?: string) {
  if (!server.value || !myClub.value) return;
  previewBusy.value = true;
  try {
    const [me, them] = await Promise.all([
      server.value.club(myClub.value.tag, token.value ?? undefined),
      server.value.club(opp, token.value ?? undefined),
    ]);
    preview.value = { me, them, map, home, day, label };
  } catch (e) { errMsg.value = (e as Error).message; } finally { previewBusy.value = false; }
}
const formPills = (c: ClubPage) => (c.form ?? []).slice(0, 5);
const clubPct = (rank?: number | null, total?: number) => (rank && total ? Math.max(1, Math.round((rank / total) * 100)) : null);
const ord = (n: number) => { const s = n % 100; return n + (s > 3 && s < 21 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th')); };

onMounted(() => { connect(); window.addEventListener('keydown', onKey); });
onUnmounted(() => { stopStream?.(); stopEvents?.(); chatStop?.(); if (presenceTimer) clearInterval(presenceTimer); if (pollTimer) clearInterval(pollTimer); stopLivePoll(); viewer?.destroy(); window.removeEventListener('keydown', onKey); });
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
          <span v-if="myClub.rival" class="lv-rival" :title="`your derby rival — ${myClub.rival.name}. Head-to-head ${myClub.derbyRecord?.w ?? 0}–${myClub.derbyRecord?.l ?? 0}`">⚔ {{ myClub.rival.tag }} <i>{{ myClub.derbyRecord?.w ?? 0 }}–{{ myClub.derbyRecord?.l ?? 0 }}</i></span>
          <span class="lv-five">{{ myClub.five.map(p => p.handle).join(' · ') }}</span>
          <span class="lv-btngroup">
            <button class="lv-planbtn" :class="{ on: planOpen }" @click="showPanel('tactics')">✎ tactics</button>
            <button class="lv-planbtn mkt" :class="{ on: marketOpen }" @click="showPanel('market')">⇄ market</button>
          </span>
          <span class="lv-btnsep" title="club management"></span>
          <span class="lv-btngroup club">
            <button class="lv-planbtn acad" :class="{ on: academyOpen }" @click="showPanel('academy')">⬡ academy</button>
            <button class="lv-planbtn hq" :class="{ on: hqOpen }" @click="showPanel('hq')">⌂ HQ</button>
            <button class="lv-planbtn staff" :class="{ on: staffOpen }" @click="showPanel('staff')">♦ staff</button>
            <button class="lv-planbtn spon" :class="{ on: sponsorOpen }" @click="showPanel('sponsor')">◈ sponsor</button>
            <button class="lv-planbtn board" :class="{ on: boardOpen }" @click="showPanel('board')">⚑ board</button>
            <button class="lv-planbtn trophies" :class="{ on: trophiesOpen }" @click="showPanel('trophies')">🏆 trophies</button>
          </span>
          <span v-if="myClub.balance != null" class="lv-bank">bank {{ kfmt(myClub.balance) }}</span>
          <span v-if="myClub.fans" class="lv-fans" title="your following — wins grow it (derby wins travel further), losses cost a little, and star accolades keep the pull. It prices your sponsor offers.">◉ {{ kfans(myClub.fans) }} fans</span>
          <span v-if="myClub.vip" class="lv-vip" :title="`VIP supporter — half-price scout reports + the club badge. Renews ${vipDate(myClub.vipUntil)}`">★ VIP</span>
          <button v-else class="lv-vipbtn" :disabled="vipBusy" @click="goVip"
                  title="become a VIP supporter — half-price scout reports, a club badge. Convenience only, never pay-to-win: the sim is identical for everyone">☆ go VIP</button>
          <div class="lv-bellwrap">
            <button class="lv-bell" :class="{ on: notifOpen }" @click="toggleNotifs" title="notifications">🔔<span v-if="notifUnread" class="lv-bellbadge">{{ notifUnread > 9 ? '9+' : notifUnread }}</span></button>
          </div>
          <div class="lv-bellwrap">
            <button class="lv-bell" :class="{ on: mailOpen }" @click="toggleMail" title="mail">✉<span v-if="mailUnread" class="lv-bellbadge">{{ mailUnread > 9 ? '9+' : mailUnread }}</span></button>
          </div>
          <div class="lv-bellwrap">
            <button class="lv-bell" :class="{ on: chatOpen }" @click="toggleChat" title="league chat">💬</button>
          </div>
          <Teleport to="body">
            <div v-if="chatOpen" class="lv-notifpanel lv-chatpanel">
              <div class="lv-notifhead"><span class="lv-kicker">Live chat <i class="lv-chatlive">● live</i></span><button class="lv-notifx" @click="toggleChat">✕</button></div>
              <div class="lv-chatrooms">
                <button :class="{ on: chatRoom === 'global' }" @click="switchRoom('global')">🌐 Global</button>
                <button v-if="myDivRoom" :class="{ on: chatRoom === myDivRoom }" @click="switchRoom(myDivRoom)">⬡ {{ tierName(myClub!.tier) }}</button>
                <span class="lv-chatonline" :title="chatOnline.join(', ')"><i class="lv-onlinedot"></i>{{ chatOnline.length }} online</span>
              </div>
              <div class="lv-chatlog">
                <div v-for="m in chatMsgs" :key="m.id" class="lv-chatmsg" :class="{ me: myClub && m.fromTag === myClub.tag }">
                  <span class="lv-chatfrom" :style="{ color: `hsl(${hue(m.fromTag)} 60% 62%)` }">{{ m.fromTag }}</span>
                  <span class="lv-chattext">{{ m.text }}</span>
                </div>
                <div v-if="!chatMsgs.length" class="lv-empty">no messages yet — say hello 👋</div>
              </div>
              <div class="lv-chatsend">
                <input v-model="chatInput" class="lv-mailin" :placeholder="chatRoom === 'global' ? 'message the league…' : 'message your division…'" maxlength="300" @keyup.enter="sendChat" />
                <button class="lv-go sm" :disabled="!chatInput.trim()" @click="sendChat">send</button>
              </div>
            </div>
          </Teleport>
          <Teleport to="body">
            <div v-if="mailOpen" class="lv-notifpanel lv-mailpanel">
              <div class="lv-notifhead"><span class="lv-kicker">Mail</span><button class="lv-notifx" @click="mailOpen = false">✕</button></div>
              <div class="lv-mailcompose">
                <select v-model="mailTo" class="lv-mailsel">
                  <option value="">to… (another owner)</option>
                  <option v-for="r in mailRecips" :key="r.tag" :value="r.tag">{{ r.tag }} · {{ r.name }}</option>
                </select>
                <input v-model="mailSubject" class="lv-mailin" placeholder="subject" maxlength="80" />
                <textarea v-model="mailBody" class="lv-mailbody" placeholder="message…" maxlength="1000" rows="2"></textarea>
                <div class="lv-mailsendrow">
                  <button class="lv-go sm" :disabled="!mailTo || !mailBody.trim()" @click="sendMail">send</button>
                  <span v-if="mailMsg" class="lv-mailmsg" :class="{ ok: mailMsg.startsWith('✓') }">{{ mailMsg }}</span>
                  <span v-if="!mailRecips.length" class="lv-mailhint">no other owners online — invite a friend to claim a club</span>
                </div>
              </div>
              <div class="lv-notiflist">
                <div v-for="t in mailThreads" :key="t.threadId" class="lv-mailthread">
                  <div class="lv-mailrow" :class="{ unread: t.unread > 0 }" @click="openMailThread(t.threadId)">
                    <div class="lv-mailmeta">
                      <b>{{ t.other }}</b>
                      <span class="lv-mailsubj">{{ t.subject }}</span>
                      <span v-if="t.unread" class="lv-threadbadge">{{ t.unread }}</span>
                      <span class="lv-notifage">{{ t.messages.length }} msg</span>
                    </div>
                    <div class="lv-mailtext lv-mailpreview"><i v-if="t.last.mine" class="lv-mailyou">You:</i> {{ t.last.body }}</div>
                  </div>
                  <div v-if="openThread === t.threadId" class="lv-threadview">
                    <div v-for="m in t.messages" :key="m.id" class="lv-threadmsg" :class="{ mine: m.mine }">
                      <span class="lv-threadfrom">{{ m.mine ? 'You' : m.fromTag }}</span>
                      <span class="lv-threadbody">{{ m.body }}</span>
                    </div>
                    <div class="lv-threadreply">
                      <input v-model="replyText" class="lv-mailin" placeholder="reply…" maxlength="1000" @keyup.enter="doReply(t.threadId)" />
                      <button class="lv-go sm" :disabled="!replyText.trim()" @click="doReply(t.threadId)">reply</button>
                    </div>
                  </div>
                </div>
                <div v-if="!mailThreads.length" class="lv-empty">your inbox is empty</div>
              </div>
            </div>
          </Teleport>
          <Teleport to="body">
            <div v-if="notifOpen" class="lv-notifpanel">
              <div class="lv-notifhead"><span class="lv-kicker">Notifications</span><button class="lv-notifx" @click="notifOpen = false">✕</button></div>
              <div class="lv-notiflist">
                <div v-for="n in notifList" :key="n.id" class="lv-notifrow clickable" :class="[n.kind, { unread: !n.read }]"
                     title="open the related panel" @click="notifGo(n)">
                  <i class="lv-notifico">{{ notifIcon[n.kind] }}</i>
                  <span class="lv-notiftext">{{ n.text }}</span>
                  <span class="lv-notifage">S{{ n.season }}</span>
                </div>
                <div v-if="!notifList.length" class="lv-empty">no notifications yet</div>
              </div>
            </div>
          </Teleport>
          <span v-if="presence.online" class="lv-presence" :title="`managers online now: ${presence.tags.join(', ') || presence.online}`">● {{ presence.online }} online</span>
          <button class="lv-signout" @click="signOut">sign out</button>
        </template>
        <template v-else-if="authed">
          <span class="lv-signedin">● signed in</span>
          <span v-if="verifyNote" class="lv-verifynote">{{ verifyNote }}</span>
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
            <button v-if="!forgotMode" class="lv-go sm" :disabled="busy" @click="doAuth">{{ authMode === 'register' ? 'Create account' : 'Log in' }}</button>
            <template v-if="authMode === 'login'">
              <button class="lv-forgot" @click="forgotMode = !forgotMode">{{ forgotMode ? '← back to log in' : 'forgot password?' }}</button>
              <template v-if="forgotMode">
                <button class="lv-go sm" :disabled="busy || !email" @click="doForgot">Send reset token</button>
                <input v-model="resetToken" placeholder="reset token" class="lv-authin" spellcheck="false" />
                <button class="lv-go sm" :disabled="busy || !resetToken || !password" title="uses the password field above as the NEW password" @click="doReset">Set new password</button>
              </template>
            </template>
            <span v-if="resetNote" class="lv-verifynote">{{ resetNote }}</span>
            <button v-for="p in oauthProviders" :key="p.id" class="lv-oauth" :title="`sign in with ${p.label} — the provider proves who you are; your club and career live here`" @click="oauthGo(p.id)">
              ⬡ Continue with {{ p.label }}
            </button>
            <span v-if="authErr" class="lv-autherr">{{ authErr }}</span>
          </div>
        </template>
      </div>

      <!-- getting started — the guided path for a fresh visitor (connected, no club yet).
           Each step lights as it's done; the whole card disappears once you're rolling. -->
      <div v-if="!myClub" class="lv-onboard">
        <div class="lv-obhead">◢ WELCOME TO ACE <span>an always-on VALORANT world — every match resolves on the server, you run a club inside it</span></div>
        <div class="lv-obsteps">
          <div class="lv-obstep" :class="{ done: authed, next: !authed }">
            <i>{{ authed ? '✓' : '1' }}</i><b>Create an account</b>
            <span>register above — your club, plans and career persist on the server</span>
          </div>
          <div class="lv-obstep" :class="{ next: authed }">
            <i>2</i><b>Claim a club</b>
            <span>pick a Premier club from the dropdown (or click any tag in the standings) — it's yours: roster, bank, board and all</span>
          </div>
          <div class="lv-obstep">
            <i>3</i><b>Author your plan</b>
            <span>✎ tactics sets your site read + tempo; the ▦ playbook lets you draw real set-pieces per map — the engine resolves exactly what you author</span>
          </div>
          <div class="lv-obstep">
            <i>4</i><b>Advance &amp; watch</b>
            <span>▶ advance ticks the next match-day live (scores sealed until the broadcast ends) — then ▷ watch replays YOUR match on the 2D broadcast, byte-exact</span>
          </div>
        </div>
        <div class="lv-obfoot">meanwhile the world is fully alive without you — scout the standings, club pages and leaderboards below</div>
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
        <!-- pre-match team talk: pick a tone; the read grades it against the matchup + the room -->
        <div class="lv-talk">
          <div class="lv-talkhd">
            <span class="lv-planh">◈ Team talk</span>
            <span class="lv-talkctx">
              <i class="lv-talkfav" :class="myClub.favourite">{{ myClub.favourite === 'fav' ? 'favourite' : myClub.favourite === 'dog' ? 'underdog' : 'even matchup' }}</i>
              · room <i class="lv-talkmood" :class="{ hi: (myClub.squadMood||65) >= 62, lo: (myClub.squadMood||65) < 45 }">{{ moodLabel(myClub.squadMood || 65) }} {{ myClub.squadMood || 65 }}%</i>
            </span>
          </div>
          <div class="lv-talkrow">
            <button v-for="t in TALK_TONES" :key="t.key" class="lv-talkbtn" :class="[myClub.talkReads?.[t.key]?.fit, { on: myClub.teamTalk === t.key }]" :disabled="marketBusy" @click="setTalk(t.key)">
              <b>{{ t.icon }} {{ t.label }}</b>
              <i class="lv-talkread" :class="myClub.talkReads?.[t.key]?.fit">{{ myClub.talkReads?.[t.key]?.fit === 'great' ? '✓ reads the room' : myClub.talkReads?.[t.key]?.fit === 'poor' ? '✗ wrong tone' : 'neutral' }}</i>
            </button>
          </div>
          <span class="lv-plannote">the right tone gives a one-match edge + lifts the room; the wrong one backfires. It lands next match, then clears.</span>
        </div>
        <!-- pre-season training camp: a once-a-season prep choice, locked once the campaign's underway -->
        <div class="lv-camp">
          <div class="lv-talkhd">
            <span class="lv-planh">⛰ Pre-season camp</span>
            <span class="lv-talkctx">cohesion <i class="lv-talkmood" :class="{ hi: (myClub.cohesion||0) >= 66, lo: (myClub.cohesion||0) < 40 }">{{ myClub.cohesion ?? 0 }}%</i>
              <template v-if="!myClub.campOpen"> · <i>window closed for this season</i></template>
            </span>
          </div>
          <div class="lv-talkrow">
            <button v-for="cp in CAMPS" :key="cp.key" class="lv-talkbtn camp" :class="{ on: myClub.camp === cp.key }" :disabled="marketBusy || (!myClub.campOpen && myClub.camp !== cp.key)" :title="cp.blurb" @click="setCamp(cp.key)">
              <b>{{ cp.icon }} {{ cp.label }}</b>
              <i class="lv-talkread">{{ cp.blurb }}</i>
            </button>
          </div>
          <span class="lv-plannote">one focus for the whole campaign — it plugs into fitness, chemistry, or the room. Reset each season.</span>
        </div>
        <!-- the PER-MAP PLAYBOOK: author real plays per pool map; the tick fields
             the fixture map's book, so what you draw here runs in your matches -->
        <div class="lv-pbook">
          <div class="lv-talkhd">
            <span class="lv-planh">▦ Playbook</span>
            <span class="lv-talkctx">authored plays PER MAP — when a fixture lands on a map, your club fields that map's setups</span>
            <span v-if="pbSaved" class="lv-savedok">✓ saved</span>
          </div>
          <div class="lv-pbmaps">
            <button v-for="m in MAP_POOL" :key="m" class="ed-map" :class="{ on: pbMap === m, has: !!pbBook[m] }"
                    :title="pbBook[m] ? `you have authored plays on ${m}` : `no plays on ${m} yet`" @click="pbPick(m)">{{ m }}<i v-if="pbBook[m]" class="ed-mapdot">●</i></button>
          </div>
          <!-- the published rotation: your NEXT fixtures + their maps — prep where you'll play -->
          <div v-if="upcoming.length" class="lv-upcoming">
            <span class="lv-upclabel">UPCOMING</span>
            <button v-for="u in upcoming" :key="u.day" class="lv-upc" :class="{ ready: !!pbBook[u.map] }"
                    :title="pbBook[u.map] ? 'playbook ready for this map' : 'no plays authored on this map yet — click to author'"
                    @click="pbPick(u.map as MapId)">
              d{{ u.day + 1 }} {{ u.home ? 'vs' : '@' }} {{ u.opp }} · <b>{{ u.map }}</b> {{ pbBook[u.map] ? '✓' : '⚠' }}
            </button>
          </div>
          <div class="lv-pbslots">
            <button class="ed-author" :class="{ on: pbSlot === 'attack', set: pbBook[pbMap]?.attack }" @click="pbOpen('attack')">✎ attack</button>
            <button v-if="pbBook[pbMap]?.attack" class="ed-author edalt" :class="{ on: pbSlot === 'attack2', set: pbBook[pbMap]?.attack2 }"
                    title="a SECOND execute on the other site — the engine rolls the site each round and runs the matching play, so your attack isn't a tell" @click="pbOpen('attack2')">⑂ alt</button>
            <button class="ed-author" :class="{ on: pbSlot === 'defense', set: pbBook[pbMap]?.defense }" @click="pbOpen('defense')">✎ defense</button>
            <button v-if="pbSlot && pbPlay" class="ed-clear" @click="pbClear">clear this play</button>
            <span class="lv-plannote">drag to place · saves live · rehearse setups against a full sim in the Tactics Editor tab</span>
          </div>
          <div v-if="pbSlot && pbPlay && pbTeam && pbNav" class="lv-pbcanvas">
            <PlayEditor
              :key="`pvp-${pbMap}-${pbSlot}`"
              :team="pbTeam" :map-url="`/${pbMap}.png`" side="att"
              :mode="pbSlot === 'defense' ? 'defense' : 'attack'"
              :play="pbPlay" :atk-spawn="ANCHORS[pbMap]!.atkSpawn" :sites="ANCHORS[pbMap]!.sites"
              :nav="pbNav" @update="pbUpdate" />
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
          <template v-for="e in board" :key="e.handle">
          <div class="lv-mktrow">
            <span class="rs-role" :class="e.role">{{ e.role.slice(0, 3).toUpperCase() }}</span>
            <b class="lv-mkthandle clk" :class="{ open: expanded.has('m:'+e.handle) }" title="per-skill scouting" @click="toggleExpand('m:'+e.handle)">{{ e.handle }}<i class="lv-disc">▾</i></b>
            <span class="lv-mktage">age {{ e.age }}</span>
            <span class="lv-mktovr">{{ e.overall }} <i>OVR</i>
              <span v-if="vsMine(e)" class="lv-vschip" :class="vsMine(e)!.d > 0 ? 'up' : vsMine(e)!.d < 0 ? 'down' : ''"
                    :title="`vs ${vsMine(e)!.vs}, your weakest starting ${e.role}: ${vsMine(e)!.d > 0 ? `+${vsMine(e)!.d} OVR — an immediate upgrade to your fielded five` : vsMine(e)!.d < 0 ? `${vsMine(e)!.d} OVR — below your current starter (depth / a development bet)` : 'level with your starter'}`">
                {{ vsMine(e)!.d > 0 ? '▲+' + vsMine(e)!.d : vsMine(e)!.d < 0 ? '▽' + Math.abs(vsMine(e)!.d) : '=' }}</span>
            </span>
            <span class="lv-ceilcell">
              <span class="lv-mktceil" :class="{ wide: e.ceiling[1] - e.ceiling[0] >= 8 }" :title="`scouted potential ceiling — wider band = more upside but more risk. Scout to tighten it (private knowledge).`">↗ {{ e.ceiling[0] }}–{{ e.ceiling[1] }}</span>
              <span class="lv-scoutpips" :title="`scouting reports: ${e.scoutLevel}/${SCOUT_MAX}`"><i v-for="n in SCOUT_MAX" :key="n" :class="{ on: n <= e.scoutLevel }">•</i></span>
              <button v-if="e.scoutLevel < SCOUT_MAX" class="lv-scoutbtn" :disabled="marketBusy" title="commission a scouting report (clears the fog on his ceiling)" @click="scout(e)">scout</button>
            </span>
            <span class="lv-mktval">{{ kfmt(e.value) }}<i v-if="e.contested" class="lv-hot" title="contested by AI clubs">🔥</i></span>
            <input type="number" class="lv-mktbid" v-model.number="bidAmt[e.handle]" step="500" min="0" />
            <button class="lv-go sm" :disabled="marketBusy" @click="bid(e)">bid</button>
            <span class="lv-mktmsg" :class="{ ok: (bidMsg[e.handle] || '').startsWith('✓') }">{{ bidMsg[e.handle] }}</span>
          </div>
          <div v-if="expanded.has('m:'+e.handle)" class="lv-attrs">
            <div v-for="a in e.attrs" :key="a.key" class="lv-attr" :class="{ mech: a.mech }">
              <span class="lv-attrk">{{ ATTR_LABEL[a.key] }}</span>
              <span class="lv-attrbar"><i class="fill" :style="{ width: a.cur + '%' }"></i><i v-if="a.ceil > a.cur" class="gap" :style="{ left: a.cur + '%', width: (a.ceil - a.cur) + '%' }"></i><i class="tick" :style="{ left: a.ceil + '%' }"></i></span>
              <span class="lv-attrv">{{ a.cur }}<em v-if="a.ceil > a.cur">↗{{ a.ceil }}</em></span>
            </div>
          </div>
          </template>
          <div v-if="!board.length" class="lv-empty">loading the board…</div>
        </div>
        <div v-if="myClub.squad && myClub.squad.length" class="lv-squad">
          <div class="lv-mkth"><span class="lv-kicker">Your squad</span><span class="lv-mktsub">click a name for the full profile · start a reserve to develop him · sell (blocked if it breaks your valid five)</span></div>
          <!-- roster at a glance: averages + a role depth chart (thin roles flagged) -->
          <div v-if="squadSummary" class="lv-sqsum">
            <span class="lv-sqstat"><b>{{ squadSummary.count }}</b> players</span>
            <span class="lv-sqstat"><b>{{ squadSummary.avgOvr }}</b> avg OVR</span>
            <span class="lv-sqstat"><b>{{ squadSummary.avgAge }}</b> avg age</span>
            <span class="lv-sqstat"><b>{{ kfmt(squadSummary.value) }}</b> squad value</span>
            <span class="lv-sqstat"><b>{{ kfmt(squadSummary.wages) }}</b> wage bill/yr</span>
            <span class="lv-sqstat" title="team cohesion — a settled core out-duels an equal-talent brand-new roster; a fresh signing gels over a season"><b :class="{ 'lv-cohi': (myClub.cohesion||0) >= 66, 'lv-colo': (myClub.cohesion||0) < 40 }">{{ myClub.cohesion ?? 0 }}%</b> cohesion</span>
            <span v-if="squadSummary.expiring" class="lv-sqalert exp" title="contracts in their final year — renew them or they walk free at season's end">📄 {{ squadSummary.expiring }} expiring</span>
            <span v-if="squadSummary.out" class="lv-sqalert inj" title="players injured — a reserve covers each, or they play hurt">⚕ {{ squadSummary.out }} out</span>
            <span v-if="squadSummary.tired" class="lv-sqalert tired" title="players redlining on fatigue — rotate them out before they break down">◔ {{ squadSummary.tired }} tired</span>
            <span class="lv-sqdepth">
              <span v-for="d in squadSummary.depth" :key="d.role" class="lv-sqrole" :class="['rl-'+d.role, { thin: d.thin }]" :title="`${d.role}: ${d.starters} starting, ${d.total - d.starters} in reserve${d.thin ? ' — no cover, a gap to fill' : ''}`">
                {{ d.short }} <b>{{ d.total }}</b><i v-if="d.thin">⚠</i>
              </span>
            </span>
          </div>
          <div class="lv-mktboard">
            <template v-for="sp in myClub.squad" :key="sp.id">
            <div class="lv-mktrow squad">
              <span class="rs-role" :class="sp.role">{{ sp.role.slice(0, 3).toUpperCase() }}</span>
              <div class="lv-sqid">
                <span class="lv-sqnamerow">
                  <b class="lv-mkthandle clk" title="open profile card" @click="playerCard = sp">{{ sp.handle }}<i v-if="sp.starter" class="lv-starter">XI</i><i v-if="sp.igl" class="lv-iglb">IGL</i></b>
                  <button v-if="sp.starter" class="lv-capb" :class="{ on: sp.captain }" :disabled="marketBusy" :title="sp.captain ? 'club captain — click to clear (auto-picks the best leader)' : 'name him captain (a leader steadies + lifts the room)'" @click="setCaptain(sp)">C</button>
                </span>
                <span class="lv-sqperson">{{ person(sp.id).nation.flag }} {{ person(sp.id).name }}
                  <i class="lv-sqsolo" :class="'rk-'+solo(sp.overall).tier.toLowerCase()">{{ solo(sp.overall).label }}</i>
                  <i v-if="trait(sp.id)" class="lv-sqtrait rs-trait" :class="'tr-'+trait(sp.id)!.key" :title="trait(sp.id)!.blurb">✦ {{ trait(sp.id)!.label }}</i>
                  <i v-if="sp.mentor" class="lv-sqment mentor" title="a veteran leader — he develops your young players faster (mentoring)">🎓 mentor</i>
                  <i v-else-if="sp.mentee" class="lv-sqment mentee" title="a young player being mentored by a senior leader — he grows faster">↑ mentored</i>
                  <i v-if="sp.focus" class="lv-sqfocus" :title="`training focus: ${ATTR_LABEL[sp.focus] || sp.focus} grows faster (the rest a touch slower)`">◎ {{ ATTR_LABEL[sp.focus] || sp.focus }}</i>
                  <i v-for="a in sp.accolades ?? []" :key="a" class="lv-acc" :title="a.startsWith('MVP') ? 'season MVP — carries a transfer-value premium' : 'season Young Gun (best U22)'">★ {{ a }}</i>
                  <i v-if="sp.loan" class="lv-sqment mentee" :title="`out on loan at ${sp.loan.tag} (tier ${sp.loan.tier + 1}) — starter minutes all season, back at the rollover. He can't be fielded here until recalled.`">⇆ on loan @ {{ sp.loan.tag }}</i>
                  <i v-if="sp.injury" class="lv-sqinj" :title="`injured — out ${sp.injury} more match-day(s); a reserve covers, or he plays hurt`">⚕ OUT {{ sp.injury }}d</i>
                  <i v-else-if="sp.fatigue >= 40" class="lv-sqfat" :class="{ tired: sp.fatigue >= 70 }" :title="`match fatigue ${sp.fatigue}% — rotate him out to recover; high fatigue dulls his game and risks injury`">◔ {{ sp.fatigue }}%</i>
                  <i class="lv-sqmood" :class="{ hi: sp.mood >= 72, lo: sp.mood < 48 }" :title="`morale ${sp.mood}% — high lifts his match game a touch, low drags it`">{{ sp.mood >= 72 ? '☺' : sp.mood < 48 ? '☹' : '·' }} {{ sp.mood }}%</i>
                </span>
              </div>
              <span class="lv-mktage">age {{ sp.age }}</span>
              <span class="lv-mktovr">{{ sp.overall }} <i>OVR</i></span>
              <span class="lv-roomcell" :title="`scouted ceiling ${sp.ceiling[0]}–${sp.ceiling[1]} · ${sp.room} OVR of upside left`">
                <span class="lv-mktceil">↗ {{ sp.ceiling[1] }}</span>
                <span class="lv-room" :class="{ grow: sp.room >= 5, done: sp.room === 0 }">{{ sp.room >= 5 ? `▲ +${sp.room}` : sp.room > 0 ? `+${sp.room}` : 'peaked' }}</span>
              </span>
              <span class="lv-mktval">{{ kfmt(sp.value) }}
                <i v-if="sp.contractYears" class="lv-sqdeal" :class="{ exp: sp.contractYears <= 1 }" :title="`under contract for ${sp.contractYears} more season(s) at ${kfmt(sp.wage)}/yr — wage locked until it expires`">{{ sp.contractYears }}y · {{ kfmt(sp.wage) }}/y</i>
              </span>
              <span class="lv-squadacts">
                <button class="lv-scoutbtn ghost" title="per-skill breakdown" @click="toggleExpand('s:'+sp.id)">{{ expanded.has('s:'+sp.id) ? '▾' : '▸' }}</button>
                <template v-if="sp.contractYears > 0 && sp.contractYears <= 1">
                  <select v-if="sp.renewTerms" class="lv-renewsel" :value="renewYears[sp.id] ?? 3" title="negotiate the TERM: a short deal costs a premium (he wants security), a long one earns a discount but locks the wage across his trajectory" @change="renewYears = { ...renewYears, [sp.id]: +($event.target as HTMLSelectElement).value }">
                    <option v-for="t in sp.renewTerms" :key="t.years" :value="t.years">{{ t.years }}y · {{ kfmt(t.wage) }}/y</option>
                  </select>
                  <button class="lv-scoutbtn renew" :disabled="marketBusy" :title="`re-sign for ${renewYears[sp.id] ?? 3} year(s) at ${kfmt(renewWageFor(sp))}/yr — or he walks free at season's end`" @click="renew(sp)">renew</button>
                </template>
                <button v-if="sp.loan" class="lv-scoutbtn" :disabled="marketBusy" title="recall him from the loan — back in your fielding pool (and back to bench reps unless you start him)" @click="doRecall(sp)">⇆ recall</button>
                <template v-else>
                  <button v-if="canStart(sp)" class="lv-scoutbtn start" :disabled="marketBusy" title="field him — starters get reps and develop" @click="startReserve(sp)">▶ start</button>
                  <button v-else-if="canBench(sp)" class="lv-scoutbtn" :disabled="marketBusy" title="bench him (a benched player rusts)" @click="benchStarter(sp)">bench</button>
                  <button v-if="!sp.starter" class="lv-scoutbtn" :disabled="marketBusy" title="loan him to a lower-division club for the season — STARTER reps there (a benched player rusts; a loaned one grows), back at the rollover" @click="doLoan(sp)">⇆ loan</button>
                  <button class="lv-sellbtn" :disabled="marketBusy" @click="sell(sp)">sell</button>
                </template>
              </span>
              <span class="lv-mktmsg" :class="{ ok: (sellMsg[sp.id] || '').startsWith('✓') }">{{ sellMsg[sp.id] }}</span>
            </div>
            <div v-if="expanded.has('s:'+sp.id)" class="lv-attrs">
              <div class="lv-focushint">◎ click a skill to focus his training on it — it grows faster, the rest a touch slower</div>
              <div v-for="a in sp.attrs" :key="a.key" class="lv-attr foc" :class="{ mech: a.mech, on: sp.focus === a.key }" :title="sp.focus === a.key ? 'focused — click to clear' : `focus training on ${ATTR_LABEL[a.key]}`" @click="setFocus(sp, a.key)">
                <span class="lv-attrk"><i v-if="sp.focus === a.key" class="lv-focdot">◎</i>{{ ATTR_LABEL[a.key] }}</span>
                <span class="lv-attrbar"><i class="fill" :style="{ width: a.cur + '%' }"></i><i v-if="a.ceil > a.cur" class="gap" :style="{ left: a.cur + '%', width: (a.ceil - a.cur) + '%' }"></i><i class="tick" :style="{ left: a.ceil + '%' }"></i></span>
                <span class="lv-attrv">{{ a.cur }}<em v-if="a.ceil > a.cur">↗{{ a.ceil }}</em></span>
              </div>
            </div>
            </template>
          </div>
        </div>
      </div>

      <!-- the HQ — the development money-sink (upgrade rooms → your squad grows faster) -->
      <div v-if="myClub && hqOpen" class="lv-mktpanel hq">
        <div class="lv-mkth">
          <span class="lv-kicker">HQ · Facilities</span>
          <span class="lv-mktsub">a compounding investment — build rooms to develop your squad faster, slow the age decline, and lift the ceiling. Upkeep {{ kfmt(myClub.facilityUpkeep || 0) }}/season.</span>
        </div>
        <div class="lv-hqrooms">
          <div v-for="f in FAC_ROOMS" :key="f.id" class="lv-hqroom">
            <div class="lv-hqhd"><b>{{ f.name }}</b><span class="lv-hqpips"><i v-for="n in FACILITY_MAX" :key="n" :class="{ on: n <= facLevel(f.id) }">▮</i></span></div>
            <div class="lv-hqblurb">{{ f.blurb }}</div>
            <div class="lv-hqeffect">{{ f.effect(facLevel(f.id)) }}</div>
            <button v-if="facLevel(f.id) < FACILITY_MAX" class="lv-go sm" :disabled="hqBusy || (myClub.balance || 0) < facilityCost(facLevel(f.id))" @click="upgradeFacility(f.id)">
              {{ facLevel(f.id) === 0 ? 'build' : 'expand' }} · {{ kfmt(facilityCost(facLevel(f.id))) }}
            </button>
            <span v-else class="lv-acadmax">✦ maxed</span>
          </div>
        </div>
        <span v-if="hqMsg" class="lv-wire" :class="{ ok: hqMsg.startsWith('✓') }">{{ hqMsg }}</span>
      </div>

      <!-- the board — the season brief + the board's confidence in you (a survival arc) -->
      <div v-if="myClub && boardOpen" class="lv-mktpanel board">
        <div class="lv-mkth">
          <span class="lv-kicker">The board</span>
          <span class="lv-mktsub">your brief for the season — meet it for a bonus; the board's confidence in you moves with how you do.</span>
        </div>
        <div v-if="myClub.objective" class="lv-boardbrief">
          <div class="lv-briefmain"><b>{{ myClub.objective.label }}</b><span class="lv-briefbonus">{{ kfmt(myClub.objective.bonus) }} bonus if met</span></div>
          <div class="lv-briefnow" :class="{ ok: onTrack() }">currently <b>{{ ord(myClub.objectiveRank || 0) }}</b> · target top {{ myClub.objective.needRank }} · <b>{{ onTrack() ? '✓ on track' : '✗ off pace' }}</b></div>
        </div>
        <div class="lv-boardconf">
          <div class="lv-confbar"><i :class="'cf-'+(myClub.boardStatus?.key || 'stable')" :style="{ width: (myClub.boardConfidence || 60)+'%' }"></i></div>
          <div class="lv-confstatus" :class="'cf-'+(myClub.boardStatus?.key || 'stable')">{{ myClub.boardConfidence }}% confidence — {{ myClub.boardStatus?.label }}</div>
        </div>
        <div v-if="myClub.boardOutcome" class="lv-boardlast" :class="{ met: myClub.boardOutcome.met }">
          Last season: {{ myClub.boardOutcome.met ? '✓ brief met' : '✗ brief missed' }} — finished {{ ord(myClub.boardOutcome.finish) }}<template v-if="myClub.boardOutcome.met"> (+{{ kfmt(myClub.boardOutcome.bonus) }})</template>
        </div>
      </div>

      <!-- trophy room — your personal career cabinet (silverware + a season-by-season ledger) -->
      <div v-if="myClub && trophiesOpen" class="lv-mktpanel trophies">
        <div class="lv-mkth">
          <span class="lv-kicker">Trophy room</span>
          <span class="lv-mktsub">your career with {{ myClub.name }} — the silverware you've won and every season you've managed.</span>
        </div>
        <div class="lv-cabinet">
          <div class="lv-trophy" :class="{ lit: trophies.league > 0 }"><b>{{ trophies.league }}</b><span>🏆 League titles</span></div>
          <div class="lv-trophy" :class="{ lit: trophies.cup > 0 }"><b>{{ trophies.cup }}</b><span>🏆 ACE Cups</span></div>
          <div class="lv-trophy" :class="{ lit: trophies.intl > 0 }"><b>{{ trophies.intl }}</b><span>🌍 Masters</span></div>
          <div class="lv-trophy" :class="{ lit: trophies.promotions > 0 }"><b>{{ trophies.promotions }}</b><span>▲ Promotions</span></div>
          <div class="lv-trophy" :class="{ lit: trophies.briefs > 0 }"><b>{{ trophies.briefs }}</b><span>✓ Briefs met</span></div>
        </div>
        <div class="lv-careerrecords">
          <span class="lv-crstat"><i>Seasons</i> {{ trophies.seasons }}</span>
          <span class="lv-crstat"><i>Best finish</i> {{ trophies.bestFinish ? ord(trophies.bestFinish) : '—' }}</span>
          <span class="lv-crstat"><i>Peak division</i> {{ tierName(trophies.topTier) }}</span>
        </div>
        <div v-if="trophies.log.length" class="lv-ledger">
          <div class="lv-ledgerhd"><span>SEASON</span><span>DIVISION</span><span>FINISH</span><span>HONOURS</span></div>
          <div v-for="e in trophies.log" :key="e.season" class="lv-ledgerrow">
            <span class="lv-lseason">S{{ e.season }}</span>
            <span class="lv-ldiv">{{ e.divName }}</span>
            <span class="lv-lfin" :class="{ gold: e.finish === 1 }">{{ e.finish ? ord(e.finish) : '—' }}</span>
            <span class="lv-lhon">
              <i v-if="e.champion" class="lv-hb champ" title="league champion">🏆 champion</i>
              <i v-if="e.cupWon" class="lv-hb cup" title="ACE Cup winners">🏆 cup</i>
              <i v-if="e.intlWon" class="lv-hb champ" title="Masters winners">🌍 Masters</i>
              <i v-if="e.promoted" class="lv-hb up" title="promoted">▲ promoted</i>
              <i v-if="e.relegated" class="lv-hb down" title="relegated">▼ relegated</i>
              <i v-if="e.briefMet" class="lv-hb brief" title="board brief met">✓ brief</i>
              <i v-if="!e.champion && !e.cupWon && !e.intlWon && !e.promoted && !e.relegated && !e.briefMet" class="lv-hb none">—</i>
            </span>
          </div>
        </div>
        <div v-else class="lv-empty">no seasons finished yet — advance a full season to start your cabinet.</div>
      </div>

      <!-- sponsorship — a multi-season commercial deal (base cheque every season + a goal bonus) -->
      <div v-if="myClub && sponsorOpen" class="lv-mktpanel spon">
        <div class="lv-mkth">
          <span class="lv-kicker">Sponsorship</span>
          <span class="lv-mktsub">a multi-season commercial deal — a base cheque every season, plus a bonus if you hit its goal. Paid at the season settle.</span>
        </div>
        <div v-if="myClub.sponsor" class="lv-sponactive">
          <div class="lv-sponname"><b>{{ myClub.sponsor.name }}</b><span class="lv-sponyears">{{ myClub.sponsor.yearsLeft }}y left</span></div>
          <div class="lv-spondetail"><span><b>{{ kfmt(myClub.sponsor.base) }}</b>/season</span><span class="lv-sponbonus">+ <b>{{ kfmt(myClub.sponsor.bonus) }}</b> if you {{ myClub.sponsor.goalText }}</span></div>
        </div>
        <div v-else class="lv-sponoffers">
          <div v-for="(o, i) in (myClub.sponsorOffers || [])" :key="i" class="lv-sponoffer">
            <div class="lv-sponname"><b>{{ o.name }}</b><span class="lv-sponyears">{{ o.years }}y deal</span></div>
            <div class="lv-spondetail"><span><b>{{ kfmt(o.base) }}</b>/s base</span><span class="lv-sponbonus">+ <b>{{ kfmt(o.bonus) }}</b> if you {{ o.goalText }}</span></div>
            <button class="lv-go sm" :disabled="sponsorBusy" @click="signSponsor(i)">sign</button>
          </div>
        </div>
        <span v-if="sponsorMsg" class="lv-wire" :class="{ ok: sponsorMsg.startsWith('✓') }">{{ sponsorMsg }}</span>
      </div>

      <!-- backroom staff — coach (development) · analyst (ceiling + cheaper scouting) · psych (fitness) -->
      <div v-if="myClub && staffOpen" class="lv-mktpanel staff">
        <div class="lv-mkth">
          <span class="lv-kicker">Backroom staff</span>
          <span class="lv-mktsub">specialists on a recurring wage — a coach speeds development, an analyst lifts the ceiling + cheapens scouting, a psych keeps the squad fresh. Wages {{ kfmt(myClub.staffWageBill || 0) }}/season.</span>
        </div>
        <div class="lv-staffroles">
          <div v-for="role in STAFF_ROLE_LIST" :key="role" class="lv-staffrole">
            <div class="lv-staffhd"><b>{{ staffMeta[role].title }}</b><span class="lv-staffblurb">{{ staffMeta[role].blurb }}</span></div>
            <div v-if="staffHired(role)" class="lv-staffhired">
              <span class="lv-staffstars">{{ '★'.repeat(staffHired(role)!.rating) }}<i>{{ '★'.repeat(5 - staffHired(role)!.rating) }}</i></span>
              <b>{{ staffHired(role)!.name }}</b>
              <span class="lv-staffwage">{{ kfmt(staffHired(role)!.wage) }}/s</span>
              <button class="lv-sellbtn" :disabled="staffBusy" @click="releaseStaff(role)">release</button>
            </div>
            <div v-else class="lv-staffshort">
              <div v-for="m in staffShortlist(role)" :key="m.id" class="lv-staffcand">
                <span class="lv-staffstars">{{ '★'.repeat(m.rating) }}<i>{{ '★'.repeat(5 - m.rating) }}</i></span>
                <b>{{ m.name }}</b><span class="lv-staffwage">{{ kfmt(m.wage) }}/s</span>
                <button class="lv-go sm" :disabled="staffBusy" @click="hireStaff(role, m.id)">hire</button>
              </div>
            </div>
          </div>
        </div>
        <span v-if="staffMsg" class="lv-wire" :class="{ ok: staffMsg.startsWith('✓') }">{{ staffMsg }}</span>
      </div>

      <!-- the academy — your homegrown youth pipeline (build → intake → develop → graduate) -->
      <div v-if="myClub && academyOpen && academy" class="lv-mktpanel acad">
        <div class="lv-mkth">
          <span class="lv-kicker">Academy · level {{ academy.level }}<span class="lv-acadpips"><i v-for="n in academy.max" :key="n" :class="{ on: n <= academy.level }">▮</i></span></span>
          <span class="lv-mktsub">homegrown prospects — raw but a wide ceiling cloud. Develop them across seasons, then graduate the hits <b>for free</b>.</span>
          <button v-if="academy.cost != null" class="lv-go sm" :disabled="acadBusy || !academy.canUpgrade" :title="academy.canUpgrade ? '' : 'not enough in the bank'" @click="upgradeAcademy">
            {{ academy.level === 0 ? 'build wing' : 'expand' }} · {{ kfmt(academy.cost) }}
          </button>
          <span v-else class="lv-acadmax">✦ fully built</span>
        </div>
        <div class="lv-acadmeta">
          <span>next intake: <b>{{ academy.intakeNext }}</b> prospect{{ academy.intakeNext === 1 ? '' : 's' }}/season</span>
          <span v-if="academy.upkeep">upkeep <b>{{ kfmt(academy.upkeep) }}</b>/season</span>
          <span v-if="academy.wageBill">wages <b>{{ kfmt(academy.wageBill) }}</b>/season</span>
          <span v-if="acadMsg" class="lv-wire" :class="{ ok: acadMsg.startsWith('✓') }">{{ acadMsg }}</span>
        </div>
        <div class="lv-mktboard">
          <template v-for="p in academy.prospects" :key="p.id">
          <div class="lv-mktrow prospect">
            <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
            <b class="lv-mkthandle clk" :class="{ open: expanded.has('a:'+p.id) }" title="per-skill scouting" @click="toggleExpand('a:'+p.id)">{{ p.handle }}<i class="lv-prospect">YTH</i><i class="lv-disc">▾</i></b>
            <span class="lv-mktage">age {{ p.age }}</span>
            <span class="lv-mktovr">{{ p.overall }} <i>OVR</i></span>
            <span class="lv-roomcell" :title="`scouted ceiling ${p.ceiling[0]}–${p.ceiling[1]} · ${p.room} OVR of upside`">
              <span class="lv-mktceil" :class="{ wide: p.ceiling[1] - p.ceiling[0] >= 8 }">↗ {{ p.ceiling[0] }}–{{ p.ceiling[1] }}</span>
              <span class="lv-room" :class="{ grow: p.room >= 8 }">+{{ p.room }}</span>
              <span class="lv-scoutpips"><i v-for="n in 3" :key="n" :class="{ on: n <= p.scoutLevel }">•</i></span>
            </span>
            <span class="lv-acadacts">
              <button v-if="p.scoutLevel < 3" class="lv-scoutbtn" :disabled="acadBusy" @click="scoutProspect(p)">scout</button>
              <button class="lv-go sm" :disabled="acadBusy" title="graduate to the senior squad — no fee" @click="promoteProspect(p)">promote</button>
              <button class="lv-sellbtn cut" :disabled="acadBusy" @click="cutProspect(p)">cut</button>
            </span>
          </div>
          <div v-if="expanded.has('a:'+p.id)" class="lv-attrs">
            <div v-for="a in p.attrs" :key="a.key" class="lv-attr" :class="{ mech: a.mech }">
              <span class="lv-attrk">{{ ATTR_LABEL[a.key] }}</span>
              <span class="lv-attrbar"><i class="fill" :style="{ width: a.cur + '%' }"></i><i v-if="a.ceil > a.cur" class="gap" :style="{ left: a.cur + '%', width: (a.ceil - a.cur) + '%' }"></i><i class="tick" :style="{ left: a.ceil + '%' }"></i></span>
              <span class="lv-attrv">{{ a.cur }}<em v-if="a.ceil > a.cur">↗{{ a.ceil }}</em></span>
            </div>
          </div>
          </template>
          <div v-if="!academy.prospects.length" class="lv-empty">{{ academy.level === 0 ? 'build the wing to start taking intakes' : 'next intake arrives when the season rolls over' }}</div>
        </div>
      </div>

      <!-- season rolled over → the champion + a fresh season -->
      <div v-if="champBanner" class="lv-champ">
        <span class="lv-trophy">🏆</span>
        <span class="lv-champtxt"><b>{{ champBanner.champion }}</b> won Season {{ champBanner.season }} — <i>Season {{ champBanner.season + 1 }} begins</i></span>
        <button class="lv-champx" @click="champBanner = null">✕</button>
      </div>

      <!-- the world news ticker — transfers + champions (the world feels alive) -->
      <div v-if="newsFeed.length" class="lv-newsbar">
        <span class="lv-newslabel">📰 World news</span>
        <div class="lv-newsscroll">
          <span v-for="(n, i) in newsFeed.slice(0, 14)" :key="i" class="lv-newsitem" :class="[n.kind, { clickable: !!n.tag }]" :title="n.tag ? `open ${n.tag}'s club page` : undefined" @click="n.tag && openClub(n.tag)">
            <i class="lv-newsico">{{ newsIcon[n.kind] }}</i>{{ n.text }}<em class="lv-newsage">S{{ n.season }}</em>
          </span>
        </div>
      </div>

      <!-- quick-nav: the Match Center is a long page — one sticky bar jumps anywhere -->
      <div v-if="world" class="lv-quicknav">
        <button @click="jump('sec-live')">▶ live</button>
        <button @click="jump('sec-table')">standings</button>
        <button @click="jump('sec-leaders')">players</button>
        <button @click="jump('sec-stats')">stats</button>
        <button @click="jump('sec-playoffs')">🏆 playoffs</button>
        <template v-if="myClub">
          <button @click="jump('sec-offers')">⇄ offers</button>
          <button @click="jump('sec-friendlies')">⚔ friendlies</button>
        </template>
      </div>

      <!-- NEXT MATCH — the owner's focal point: who, where, and whether you're ready -->
      <div v-if="myClub && upcoming.length" class="lv-nextmatch">
        <span class="lv-nmlabel">NEXT MATCH</span>
        <span class="lv-nmcore clickable" title="open the pre-match preview — the tale of the tape" @click="openPreview">md {{ upcoming[0].day + 1 }} · {{ upcoming[0].home ? 'vs' : '@' }} <b class="lv-nmopp">{{ upcoming[0].opp }}</b> on <b class="lv-nmmap">{{ upcoming[0].map }}</b> <i class="lv-nmgo">{{ previewBusy ? '…' : '⊞ preview' }}</i></span>
        <span class="lv-nmready" :class="pbBook[upcoming[0].map] ? 'ok' : 'warn'"
              :title="pbBook[upcoming[0].map] ? 'you have authored plays on this map — they field in this fixture' : 'no plays authored on this map — your side runs on dials alone. Click to author.'"
              @click="pbPick(upcoming[0].map as MapId)">▦ {{ pbBook[upcoming[0].map] ? 'playbook ready' : 'no plays on this map' }}</span>
        <span class="lv-nmtalk" :class="myClub.teamTalk ? 'ok' : 'warn'"
              :title="myClub.teamTalk ? `team talk set: ${myClub.teamTalk}` : 'no team talk set — the right tone gives a one-match edge'"
              @click="showPanel('tactics')">◆ {{ myClub.teamTalk ? 'talk: ' + myClub.teamTalk : 'set a team talk' }}</span>
        <span v-if="myClub.rival && upcoming[0].opp === myClub.rival.tag" class="lv-rival">⚔ DERBY</span>
      </div>

      <!-- the day's live matches -->
      <div id="sec-live" class="lv-stage">
        <div class="lv-stageh">
          <span class="lv-kicker">{{ tableTier > 0 ? `Premier + ${tierName(tableTier)}` : 'Premier' }} · Match-day {{ DAY + 1 }}<template v-if="world"> / {{ world.lastDay + 1 }}</template></span>
          <span class="lv-livetag" :class="{ on: anyLive }">{{ anyLive ? '● LIVE' : allDone ? 'FINAL' : '—' }}</span>
          <span class="lv-embargo" v-if="anyLive">results sealed until each broadcast ends — no spoilers</span>
          <button v-if="myClub && allDone && world && DAY < world.lastDay && !myClub.teamTalk" class="lv-talknudge" title="you haven't set a team talk for the next match — the right tone gives an edge" @click="showPanel('tactics')">◆ set a team talk</button>
          <button v-if="myClub && allDone && world && world.manualAdvance && DAY < world.lastDay" class="lv-advance" :disabled="advancing" title="DEV world — production clocks are server-owned" @click="advance">▶ advance match-day</button>
          <span v-else-if="world && !world.manualAdvance && nextTickIn != null" class="lv-nexttick" :title="`the world clock is server-owned — a match-day resolves every ${Math.round((world.autoAdvanceSecs ?? 0) / 60)} min on the scheduled tick, for everyone at once`">⏱ next match-day in <b>{{ mmss(nextTickIn) }}</b></span>
          <span v-else-if="myClub && allDone && world && DAY >= world.lastDay" class="lv-seasondone">season complete · playoffs next</span>
        </div>
        <div class="lv-cards">
          <div v-for="f in fixtures" :key="f.slot" class="lv-card" :class="[f.status, { mine: mine(f.home.tag) || mine(f.away.tag), derby: isDerby(f), featured: f.slot === featuredSlot }]">
            <span v-if="isDerby(f)" class="lv-derbytag" title="a derby vs your rival — extra stakes; a win lifts the room, a loss stings">⚔ DERBY</span>
            <span v-else-if="f.slot === featuredSlot" class="lv-feattag" title="the day's biggest game — highest combined squad power">★ FEATURED</span>
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
            <button v-else-if="f.status === 'live' && f.round >= 2" class="lv-watch live" :disabled="loadingWatch" @click="watchLive(f)" title="watch live in the viewer — synced to the broadcast, no spoilers">▷ watch live</button>
            <div v-else class="lv-locked" title="sealed until the broadcast finishes">🔒</div>
          </div>
          <div v-if="!fixtures.length" class="lv-empty">waiting for the match-day to go live…</div>
        </div>
      </div>

      <!-- the watched match -->
      <div v-if="watching" class="lv-watchwrap">
        <div class="lv-watchhead">
          <b>{{ watching.home.tag }}</b>
          <span v-if="watching.live" class="lv-livetag">● LIVE</span>
          <template v-else> {{ watching.final?.[0] }} – {{ watching.final?.[1] }} </template>
          <b>{{ watching.away.tag }}</b>
          · <span class="hq-rmap">{{ watching.map }}</span> · {{ watching.live ? 'live — synced to the broadcast, no spoilers ahead' : 're-simmed from the server snapshot' }}
          <button v-if="!watching.live && !watching.cup" class="lv-share" @click="shareWatch">{{ shareCopied ? '✓ link copied' : '⤴ share' }}</button>
          <button class="ed-close" @click="closeWatch">close</button>
        </div>
        <div ref="host" class="ace-host"></div>
        <!-- the TURNING POINT — the round the winner stole against the worst True Odds -->
        <div v-if="turning && boxScore" class="lv-turn">
          <span class="lv-turnlab">⚡ TURNING POINT</span>
          <span class="lv-turnbody">
            <b>{{ turning.team }}</b> stole round {{ turning.round }} on {{ turning.site }} from
            <b class="lv-turnodds">{{ Math.round(turning.odds * 100) }}%</b> True Odds —
            {{ turning.before[0] }}–{{ turning.before[1] }} became {{ turning.after[0] }}–{{ turning.after[1] }}<template v-if="turning.closer"> · {{ turning.closer.killer }} closed it<i v-if="turning.closer.hs" class="lv-hshot" title="headshot">⊙</i></template>
          </span>
          <button class="lv-turnbtn" @click="replayTurning" title="jump the viewer to this round">▶ replay it</button>
        </div>
        <!-- the DEBRIEF — your reads, graded against what actually happened (your matches only) -->
        <div v-if="debrief && boxScore && (debrief.def || debrief.atk)" class="lv-debrief">
          <span class="lv-turnlab lv-deblab">📋 DEBRIEF</span>
          <div class="lv-debrows">
            <div v-if="debrief.def" class="lv-debrow">
              <b class="lv-debside">DEF</b>
              <span>you stacked <b>{{ debrief.def.site }}</b> — they hit it {{ debrief.def.hit }}/{{ debrief.def.hit + debrief.def.off }}
                <template v-if="debrief.def.hit">(won {{ debrief.def.hitWon }} read-right)</template><template v-if="debrief.def.off"> · won {{ debrief.def.offWon }}/{{ debrief.def.off }} read-wrong</template></span>
              <i class="lv-debtip" :class="{ good: defTip.startsWith('✓') }">{{ defTip }}</i>
            </div>
            <div v-if="debrief.atk" class="lv-debrow">
              <b class="lv-debside">ATK</b>
              <span>they stacked <b>{{ debrief.atk.site }}</b> — you hit into it {{ debrief.atk.hit }}×
                <template v-if="debrief.atk.hit">(won {{ debrief.atk.hitWon }})</template> · went elsewhere {{ debrief.atk.off }}×
                <template v-if="debrief.atk.off">(won {{ debrief.atk.offWon }})</template></span>
              <i class="lv-debtip" :class="{ good: atkTip.startsWith('✓') }">{{ atkTip }}</i>
            </div>
          </div>
        </div>
        <!-- post-match box score + Player of the Match (derived from the timeline) -->
        <div v-if="boxScore" class="lv-box">
          <div v-for="(team, ti) in boxScore.teams" :key="ti" class="lv-boxteam">
            <div class="lv-boxhead">
              <i class="hq-dot" :style="{ background: `hsl(${hue(ti === 0 ? watching.home.tag : watching.away.tag)} 65% 55%)` }"></i>
              <b>{{ ti === 0 ? watching.home.name : watching.away.name }}</b>
              <span class="lv-boxsc">{{ watching.final?.[ti] }}</span>
            </div>
            <div class="lv-boxrow lv-boxthead"><span>Player</span><span>K</span><span>D</span><span>+/−</span><span>FB</span><span title="headshot kill rate">HS%</span></div>
            <div v-for="p in team" :key="p.handle" class="lv-boxrow clickable" :class="{ mvp: p.mvp, followed: p.handle === followed }"
                 :title="p.handle === followed ? 'release the follow cam' : `follow ${p.handle} with the director camera`" @click="followRow(p.handle)">
              <span class="lv-boxp"><span class="rs-role" :class="p.role">{{ p.role.slice(0,3).toUpperCase() }}</span><b>{{ p.handle }}</b><span v-if="p.flag" class="lv-boxflag" :title="p.name">{{ p.flag }}</span><i v-if="p.igl" class="lv-igl">IGL</i><i v-if="p.mvp" class="lv-mvp">★ MVP</i></span>
              <span>{{ p.kills }}</span><span>{{ p.deaths }}</span>
              <span :class="p.kills - p.deaths >= 0 ? 'pos' : 'neg'">{{ p.kills - p.deaths >= 0 ? '+' : '' }}{{ p.kills - p.deaths }}</span>
              <span>{{ p.fb }}</span>
              <span :class="{ 'lv-hshot': p.hsPct >= 40 }">{{ p.kills ? p.hsPct + '%' : '—' }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="lv-bottom">
        <!-- Premier standings (embargo-aware: only resolved games count) -->
        <div id="sec-table" class="lv-table">
          <div class="lv-tableh"><span class="lv-kicker">{{ tierName(tableTier) }} standings</span><span class="lv-note">moves only when a broadcast ends</span></div>
          <div class="lv-tierchips">
            <button v-for="(tn, ti) in RANK_TIERS.slice(0, world?.tiers ?? RANK_TIERS.length)" :key="ti" class="lv-tierchip"
                    :class="{ on: tableTier === ti, mine: ti === (myClub?.tier ?? -1) }"
                    :title="ti === (myClub?.tier ?? -1) ? `${tn} — your division` : `browse the ${tn} table`"
                    @click="pickTier(ti)">{{ tn }}</button>
          </div>
          <div class="lv-trow lv-thead"><span class="r">#</span><span class="c">Club</span><span>P</span><span>W</span><span>L</span><span>Δ</span><span class="pts">Pts</span></div>
          <div v-for="(s, rank) in table" :key="s.club" class="lv-trow" :class="[{ mine: mine(s.club) }, zoneOf(rank) ? 'zone-' + zoneOf(rank) : '']">
            <span class="r">{{ rank + 1 }}</span>
            <span class="c"><i class="hq-dot" :style="{ background: `hsl(${hue(s.club)} 65% 55%)` }"></i><span class="lv-cname clickable" @click="openClub(s.club)">{{ s.club }}</span><i v-if="mine(s.club)" class="lv-youtag">YOU</i></span>
            <span>{{ s.played }}</span><span>{{ s.won }}</span><span>{{ s.lost }}</span>
            <span :class="s.diff >= 0 ? 'pos' : 'neg'">{{ s.diff >= 0 ? '+' : '' }}{{ s.diff }}</span>
            <span class="pts">{{ s.points }}</span>
          </div>
          <div v-if="zoneLegend.length" class="lv-zonelegend">
            <span v-for="z in zoneLegend" :key="z.z" class="lv-zonekey"><i :class="'zone-' + z.z"></i>{{ z.label }}</span>
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
            <template v-if="hof.legends?.length">
              <div class="lv-hofsec">🏛 Inducted — careers complete</div>
              <div v-for="l in hof.legends" :key="'lg' + l.handle" class="lv-hofseason">
                <span title="retired — enshrined for an exceptional career">🎙</span>
                <b>{{ l.handle }}</b>
                <span class="lv-hofname">{{ l.kills.toLocaleString() }} career kills · {{ l.seasons }} season(s)<template v-if="l.mvps"> · {{ l.mvps }}× MVP</template> · last of <i class="clickable" @click="openClub(l.club)">{{ l.club }}</i></span>
              </div>
            </template>
            <template v-if="hof.awards?.length">
              <div class="lv-hofsec">Individual honours</div>
              <div v-for="a in hof.awards.slice(0, 5)" :key="'aw' + a.season" class="lv-hofseason">
                <span class="lv-hofsno">S{{ a.season }}</span>
                <span v-if="a.mvp" :title="`${a.mvp.kills} kills across the season`">★ MVP <b>{{ a.mvp.handle }}</b> <i class="lv-hofname clickable" @click="openClub(a.mvp.club)">{{ a.mvp.club }}</i></span>
                <span v-if="a.youngGun && a.youngGun.handle !== a.mvp?.handle" :title="`the best under-22 — ${a.youngGun.kills} kills at ${a.youngGun.age}`">☄ Young Gun <b>{{ a.youngGun.handle }}</b> <i class="lv-hofname clickable" @click="openClub(a.youngGun.club)">{{ a.youngGun.club }}</i></span>
              </div>
            </template>
          </template>
          <div v-else class="lv-hofempty">No champions crowned yet.<br />Advance a full season to make history.</div>
        </div>
      </div>

      <!-- the world's best players — a cross-club prestige board (solo rank ≠ division) -->
      <div id="sec-leaders" class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="toggleLeaders">★ World top players <i class="lv-disc" :class="{ open: leadersOpen }">▾</i></button>
          <span class="lv-note">individual skill — a Radiant on a small club is a gem to scout</span>
        </div>
        <template v-if="leadersOpen">
          <div class="lv-roletabs">
            <button v-for="t in ROLE_TABS" :key="t.k" :class="{ on: leaderRole === t.k }" @click="setLeaderRole(t.k)">{{ t.l }}</button>
          </div>
          <div class="lv-ldboard">
            <div v-for="p in leaders" :key="p.handle" class="lv-ldrow">
              <span class="lv-ldrank" :class="{ top: p.rank <= 3 }">{{ p.rank }}</span>
              <span class="rs-role" :class="p.role">{{ p.role.slice(0, 3).toUpperCase() }}</span>
              <b class="lv-ldhandle">{{ p.handle }}<i v-if="p.name" class="lv-ldperson" :title="p.name">{{ p.flag }} {{ p.name }}</i></b>
              <span class="lv-ldovr">{{ p.overall }} <i>OVR</i></span>
              <span class="lv-ldsolo" :class="'rk-' + p.soloTier.toLowerCase()">{{ p.soloLabel }}</span>
              <span class="lv-ldclub"><i class="hq-dot" :style="{ background: `hsl(${hue(p.clubTag)} 65% 55%)` }"></i><span class="lv-cname clickable" @click="openClub(p.clubTag)">{{ p.clubTag }}</span> · {{ tierName(p.tier) }}<i v-if="p.owned" class="lv-youtag sm">OWNED</i></span>
            </div>
            <div v-if="!leaders.length" class="lv-empty">loading…</div>
          </div>
        </template>
      </div>

      <!-- club power rankings — squad strength + lifecycle (read the league) -->
      <div class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="togglePower">🏛 Club power rankings <i class="lv-disc" :class="{ open: powerOpen }">▾</i></button>
          <span class="lv-note">squad strength + lifecycle stage — a fading dynasty vs a rising threat</span>
        </div>
        <template v-if="powerOpen">
          <div class="lv-ldboard">
            <div v-for="c in powerClubs" :key="c.tag" class="lv-pwrow" :class="{ mine: mine(c.tag) }">
              <span class="lv-ldrank" :class="{ top: c.rank <= 3 }">{{ c.rank }}</span>
              <i class="hq-dot" :style="{ background: `hsl(${hue(c.tag)} 65% 55%)` }"></i>
              <b class="lv-cname clickable" @click="openClub(c.tag)">{{ c.tag }}</b>
              <span class="lv-pwname">{{ c.name }}<i v-if="mine(c.tag)" class="lv-youtag sm">YOU</i></span>
              <span class="lv-pwtier">{{ tierName(c.tier) }}</span>
              <span class="lv-phase" :class="'ph-' + c.phase">{{ PHASE_LABEL[c.phase] }}</span>
              <span class="lv-pwinfra" :title="`infrastructure ${c.infra}/5`"><i v-for="n in 5" :key="n" :class="{ on: n <= c.infra }">▰</i></span>
              <span class="lv-pwtitles">{{ c.titles ? '🏆'.repeat(Math.min(3, c.titles)) + (c.titles > 3 ? `×${c.titles}` : '') : '' }}</span>
              <span class="lv-pwpower">{{ c.power }} <i>PWR</i></span>
            </div>
            <div v-if="!powerClubs.length" class="lv-empty">loading…</div>
          </div>
        </template>
      </div>

      <!-- season stat leaders — top fraggers from the matches that have played -->
      <div id="sec-stats" class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="toggleStats">🎯 Stat leaders <i class="lv-disc" :class="{ open: statsOpen }">▾</i></button>
          <template v-if="statsOpen">
            <button class="lv-tierchip" :class="{ on: statScope === 'season' }" @click="setStatScope('season')">this season</button>
            <button class="lv-tierchip" :class="{ on: statScope === 'career' }" title="all-time — folded into the ledger at every rollover, plus the live season" @click="setStatScope('career')">all-time</button>
          </template>
          <span class="lv-note">{{ statScope === 'career' ? 'career numbers across every season (the legends board)' : 'top fraggers from Premier matches played so far this season' }}</span>
        </div>
        <template v-if="statsOpen">
          <div class="lv-ldboard">
            <div class="lv-strow lv-sthead"><span class="lv-ldrank">#</span><span></span><span>Player</span><span>K</span><span>D</span><span>K/D</span><span>FB</span><span title="headshot kill rate">HS%</span><span title="1vX clutches converted">CL</span><span>MVP</span><span>GP</span></div>
            <div v-for="s in statRows" :key="s.handle" class="lv-strow">
              <span class="lv-ldrank" :class="{ top: s.rank <= 3 }">{{ s.rank }}</span>
              <span class="rs-role" :class="s.role">{{ s.role.slice(0,3).toUpperCase() }}</span>
              <b class="lv-sthandle">{{ s.handle }} <i class="lv-stclub" @click="openClub(s.club)">{{ s.club }}</i><i v-if="(s as any).retired" class="lv-retired" title="retired — the career is complete">🎙 retired</i></b>
              <span class="lv-stk">{{ s.kills }}</span><span>{{ s.deaths }}</span>
              <span :class="s.kd >= 1 ? 'pos' : 'neg'">{{ s.kd.toFixed(2) }}</span>
              <span>{{ s.fb }}</span><span :class="{ 'lv-hshot': (s.hsPct || 0) >= 40 }">{{ s.hsPct ?? 0 }}%</span><span class="lv-stcl">{{ s.clutch || '' }}</span><span class="lv-stmvp">{{ s.mvp || '' }}</span><span>{{ s.matches }}</span>
            </div>
            <div v-if="!statRows.length" class="lv-empty">no matches resolved yet — advance a match-day</div>
          </div>
        </template>
      </div>

      <!-- the Premier playoffs — the season climax, engine-simmed + watchable -->
      <div id="sec-playoffs" class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="togglePlayoffs">🏆 Playoffs <i class="lv-disc" :class="{ open: playoffsOpen }">▾</i></button>
          <span class="lv-note">top-4 bracket at each season's end — Bo3 semis, Bo5 final, real map veto, every game watchable</span>
        </div>
        <template v-if="playoffsOpen">
          <div v-for="pv in playoffViews" :key="pv.season" class="lv-pobracket">
            <div class="lv-pohead">Season {{ pv.season }} — <b class="lv-pochamp">🏆 {{ pv.champion }}</b> <i class="lv-poq">({{ pv.qualified.join(' · ') }})</i></div>
            <div class="lv-porounds">
              <div v-for="(rd, ri) in pv.rounds" :key="ri" class="lv-poround">
                <div v-for="sr in rd" :key="sr.hi + sr.lo" class="lv-poseries">
                  <div class="lv-posr"><b :class="{ win: sr.winner === sr.hi }">{{ sr.hi }}</b> {{ sr.wins[0] }}–{{ sr.wins[1] }} <b :class="{ win: sr.winner === sr.lo }">{{ sr.lo }}</b> <i class="lv-polabel">{{ sr.label }} · Bo{{ sr.need * 2 - 1 }}</i></div>
                  <div class="lv-poveto"><span v-for="(v, vi) in sr.veto" :key="vi" class="lv-povstep" :class="v.action">{{ v.team }} {{ v.action }} {{ v.map }}</span></div>
                  <div class="lv-pogames">
                    <button v-for="(g, gi) in sr.games" :key="gi" class="lv-pogame" :disabled="loadingWatch"
                            :title="`game ${gi + 1} on ${g.map} — ▷ watch`" @click="watchPlayoff(pv.season, g.seed, sr.hi, sr.lo, g.score, g.map)">
                      g{{ gi + 1 }} · {{ g.map }} · {{ g.score[0] }}–{{ g.score[1] }} ▷
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!playoffViews.length" class="lv-empty">no playoffs yet — they run at each season's end (advance to the rollover)</div>
        </template>
      </div>

      <!-- the offer desk — human-to-human transfer bids on YOUR players + your bids out -->
      <div id="sec-offers" v-if="myClub" class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="toggleTransfers">⇄ Offer desk <i v-if="pendingIn" class="lv-baddge" style="background:#e8b03c;color:#141414;border-radius:8px;padding:0 6px;font-weight:700">{{ pendingIn }}</i> <i class="lv-disc" :class="{ open: transfersOpen }">▾</i></button>
          <span class="lv-note">owner-to-owner deals — bid for a player on any human club's page; the seller decides</span>
        </div>
        <template v-if="transfersOpen">
          <div v-for="o in transfersIn" :key="'in' + o.id" class="lv-frow">
            <span class="lv-fscore"><b>{{ o.fromTag }}</b> bids <b class="pos">${{ o.amount.toLocaleString() }}</b> for your <b>{{ o.handle }}</b></span>
            <template v-if="o.status === 'pending'">
              <button class="lv-watch" @click="answerOffer(o, true)" title="sell — the fee lands in your bank, the player joins them ungelled">✓ accept</button>
              <button class="lv-watch" style="opacity:.7" @click="answerOffer(o, false)">✕ decline</button>
            </template>
            <i v-else class="lv-note">{{ o.status }}</i>
          </div>
          <div v-for="o in transfersOut" :key="'out' + o.id" class="lv-frow">
            <span class="lv-fscore">your bid: <b class="pos">${{ o.amount.toLocaleString() }}</b> for <b>{{ o.handle }}</b> ({{ o.toTag }})</span>
            <button v-if="o.status === 'pending'" class="lv-watch" style="opacity:.7" @click="pullOffer(o)">withdraw</button>
            <i v-else class="lv-note" :class="{ pos: o.status === 'accepted' }">{{ o.status === 'accepted' ? '✓ signed' : o.status }}</i>
          </div>
          <div v-if="!transfersIn.length && !transfersOut.length" class="lv-empty">no offers yet — open a human-owned club's page and bid on one of their five</div>
        </template>
      </div>

      <!-- friendlies — your on-demand human-vs-human matches (and AI scrims) -->
      <div id="sec-friendlies" v-if="myClub" class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="toggleFriendlies">⚔ Friendlies <i class="lv-disc" :class="{ open: friendliesOpen }">▾</i></button>
          <span class="lv-note">challenge any club from its page — instant, engine-resolved, watchable; standings untouched</span>
        </div>
        <template v-if="friendliesOpen">
          <div class="lv-ldboard">
            <div v-for="f in friendlyRows" :key="f.id" class="lv-frow">
              <span class="lv-fscore"><b :class="{ win: f.score[0] > f.score[1] && mine(f.home.tag) || f.score[1] > f.score[0] && mine(f.away.tag) }">{{ f.home.tag }} {{ f.score[0] }}–{{ f.score[1] }} {{ f.away.tag }}</b></span>
              <span class="hq-rmap">{{ f.map }}</span>
              <span class="lv-fmeta">s{{ f.season }} · day {{ f.day + 1 }}</span>
              <button class="lv-watch" :disabled="loadingWatch" @click="watchFriendly(f.id)">▷ watch</button>
              <button class="lv-challenge" :disabled="challengeBusy" title="run it back (one friendly per pair per match-day)"
                      @click="doChallenge(mine(f.home.tag) ? f.away.tag : f.home.tag)">⚔ rematch</button>
            </div>
            <div v-if="challengeResult && friendliesOpen" class="lv-chresult">
              ⚔ <b>{{ challengeResult.home.tag }}</b> {{ challengeResult.score[0] }}–{{ challengeResult.score[1] }} <b>{{ challengeResult.away.tag }}</b>
              on <i class="hq-rmap">{{ challengeResult.map }}</i>
              <button class="lv-watch" :disabled="loadingWatch" @click="watchFriendly(challengeResult.id)">▷ watch it</button>
            </div>
            <div v-if="Object.keys(friendlyH2h).length" class="lv-fh2h">
              <span class="lv-upclabel">H2H</span>
              <span v-for="(r, tag) in friendlyH2h" :key="tag" class="lv-fh2hchip" :class="r.w >= r.l ? 'up' : 'down'">{{ tag }} {{ r.w }}–{{ r.l }}</span>
            </div>
            <div v-if="!friendlyRows.length" class="lv-empty">no friendlies yet — open any club's page and hit ⚔ challenge</div>
          </div>
        </template>
      </div>

      <!-- the ACE Cup — every club in the world, open draw; a minnow can knock out a giant -->
      <div class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="toggleCup">🏆 ACE Cup <i class="lv-disc" :class="{ open: cupOpen }">▾</i></button>
          <span class="lv-note">every club in the world · open draw · giant-killing welcome</span>
        </div>
        <template v-if="cupOpen">
          <div v-if="!cupView" class="lv-empty">loading…</div>
          <template v-else>
            <div v-if="cupView.champion" class="lv-cupchamp" :class="{ mine: mine(cupView.champion.tag) }">🏆 {{ cupView.champion.tag }} · {{ cupView.champion.name }} <i>{{ tierName(cupView.champion.tier) }}</i> — ACE Cup winners</div>
            <!-- THE DRAW: the next round's pairings + maps, public before the ties are played -->
            <template v-if="cupView.next">
              <div class="lv-cuproundh draw">🎱 THE DRAW — {{ cupView.next.name }} · match-day {{ cupView.next.matchday + 1 }}</div>
              <div v-for="(t, ti) in cupView.next.ties" :key="'nx' + ti" class="lv-cuptie" :class="{ mine: mine(t.home.tag) || mine(t.away.tag) }">
                <span class="lv-cupside"><i class="hq-dot" :style="{ background: `hsl(${hue(t.home.tag)} 65% 55%)` }"></i><b class="clickable" @click="openClub(t.home.tag)">{{ t.home.tag }}</b> <em>{{ tierName(t.home.tier) }}</em></span>
                <b class="lv-cupscore vs">vs</b>
                <span class="lv-cupside rt"><em>{{ tierName(t.away.tier) }}</em> <b class="clickable" @click="openClub(t.away.tag)">{{ t.away.tag }}</b><i class="hq-dot" :style="{ background: `hsl(${hue(t.away.tag)} 65% 55%)` }"></i></span>
                <i class="hq-rmap">{{ t.map }}</i>
                <button v-if="myClub && (mine(t.home.tag) || mine(t.away.tag))" class="lv-watch sm" :disabled="previewBusy"
                        title="the pre-match preview — the tale of the tape for your cup tie"
                        @click="openPreviewVs(mine(t.home.tag) ? t.away.tag : t.home.tag, t.map, mine(t.home.tag), cupView.next.matchday, `🏆 CUP · ${cupView.next.name.toUpperCase()}`)">⊞</button>
              </div>
            </template>
            <!-- your own run (any round) — watchable -->
            <div v-if="myCupRun" class="lv-cuptie myrun" :class="{ win: myCupRun.won }">
              <span class="lv-cuprunh">Your run · {{ myCupRun.round }}</span>
              <span class="lv-cupside" :class="{ win: myCupRun.tie.winner === myCupRun.tie.home.idx }"><i class="hq-dot" :style="{ background: `hsl(${hue(myCupRun.tie.home.tag)} 65% 55%)` }"></i><b>{{ myCupRun.tie.home.tag }}</b> <em>{{ tierName(myCupRun.tie.home.tier) }}</em></span>
              <b class="lv-cupscore">{{ myCupRun.tie.score[0] }}–{{ myCupRun.tie.score[1] }}</b>
              <span class="lv-cupside rt" :class="{ win: myCupRun.tie.winner === myCupRun.tie.away.idx }"><em>{{ tierName(myCupRun.tie.away.tier) }}</em> <b>{{ myCupRun.tie.away.tag }}</b><i class="hq-dot" :style="{ background: `hsl(${hue(myCupRun.tie.away.tag)} 65% 55%)` }"></i></span>
              <button v-if="myCupRun.tie.watchable" class="lv-watch sm" :disabled="loadingWatch" @click="watchCupTie(myCupRun.tie)" title="watch your tie">▷</button>
              <span v-else class="lv-cupq">·</span>
            </div>
            <div v-if="cupView.upsets.length" class="lv-cupupsets">
              <span class="lv-cupuh">⚡ Giant-killings</span>
              <span v-for="(u, i) in cupView.upsets" :key="i" class="lv-cupupset"><b class="clickable" @click="openClub(u.w.tag)">{{ u.w.tag }}</b> <em>{{ tierName(u.w.tier) }}</em> ▸ {{ u.l.tag }} <em>{{ tierName(u.l.tier) }}</em></span>
            </div>
            <div v-for="rd in cupLateRounds" :key="rd.round" class="lv-cupround">
              <div class="lv-cuproundh">{{ rd.name }}</div>
              <div v-for="t in rd.ties" :key="t.id" class="lv-cuptie" :class="{ mine: mine(t.home.tag) || mine(t.away.tag) }">
                <span class="lv-cupside" :class="{ win: t.winner === t.home.idx }"><i class="hq-dot" :style="{ background: `hsl(${hue(t.home.tag)} 65% 55%)` }"></i><b class="clickable" @click="openClub(t.home.tag)">{{ t.home.tag }}</b> <em>{{ tierName(t.home.tier) }}</em></span>
                <b class="lv-cupscore">{{ t.score[0] }}–{{ t.score[1] }}</b>
                <span class="lv-cupside rt" :class="{ win: t.winner === t.away.idx }"><em>{{ tierName(t.away.tier) }}</em> <b class="clickable" @click="openClub(t.away.tag)">{{ t.away.tag }}</b><i class="hq-dot" :style="{ background: `hsl(${hue(t.away.tag)} 65% 55%)` }"></i></span>
                <button v-if="t.watchable" class="lv-watch sm" :disabled="loadingWatch" @click="watchCupTie(t)" title="watch this tie">▷</button>
                <span v-else class="lv-cupq" title="quick-resolved — not a watched tie">·</span>
              </div>
            </div>
          </template>
        </template>
      </div>
    </template>

    <!-- the public club page (read-only) -->
    <Teleport to="body">
      <div class="lv-toasts">
        <div v-for="t in toasts" :key="t.id" class="lv-toast" :class="t.kind" @click="toastGo(t)">
          <i>{{ t.icon }}</i><span>{{ t.text }}</span>
        </div>
      </div>
    </Teleport>

    <!-- PRE-MATCH PREVIEW: the tale of the tape (you vs your next opponent) -->
    <div v-if="preview" class="lv-clubmodal" @click.self="preview = null">
      <div class="lv-clubcard">
        <button class="lv-clubx" @click="preview = null">✕</button>
        <div class="lv-pvhead">
          <span class="lv-kicker">{{ preview.label ?? `MATCH-DAY ${preview.day + 1} PREVIEW` }}</span>
          <b class="lv-nmmap">{{ preview.map }}</b>
          <span v-if="myClub?.rival && preview.them.tag === myClub.rival.tag" class="lv-rival">⚔ DERBY</span>
        </div>
        <div class="lv-pvgrid">
          <div v-for="(c, side) in [preview.home ? preview.me : preview.them, preview.home ? preview.them : preview.me]" :key="c.tag" class="lv-pvcol" :class="{ mine: c.tag === preview.me.tag }">
            <div class="lv-crest sm" :style="{ background: `linear-gradient(150deg, hsl(${hue(c.tag)} 55% 26%), hsl(${hue(c.tag)} 50% 16%))`, borderColor: `hsl(${hue(c.tag)} 66% 56%)` }"><span class="lv-cresttag">{{ c.tag }}</span></div>
            <b class="lv-pvname clickable" @click="openClub(c.tag); preview = null">{{ c.name }}</b>
            <span class="lv-pvmeta">{{ c.power ?? c.rating }} OVR · #{{ c.powerRank ?? '—' }} world<template v-if="c.standing"> · {{ ord(c.standing) }} in {{ c.division }}</template></span>
            <span class="lv-formpills">
              <i v-for="(g, i) in formPills(c)" :key="i" :class="g.r === 'W' ? 'w' : 'l'" :title="`${g.us}–${g.them} vs ${g.opp}`">{{ g.r }}</i>
              <em v-if="!formPills(c).length" class="lv-note">no games yet</em>
            </span>
            <span class="lv-pvhome">{{ side === 0 ? 'HOME' : 'AWAY' }}</span>
          </div>
        </div>
        <div class="lv-pvready">
          <span class="lv-nmready" :class="pbBook[preview.map] ? 'ok' : 'warn'" @click="pbPick(preview.map as MapId); preview = null">▦ {{ pbBook[preview.map] ? 'your playbook is ready for this map' : 'no plays on this map — author before kickoff' }}</span>
          <span class="lv-nmtalk" :class="myClub?.teamTalk ? 'ok' : 'warn'" @click="showPanel('tactics'); preview = null">◆ {{ myClub?.teamTalk ? 'talk set: ' + myClub.teamTalk : 'set a team talk' }}</span>
          <span v-if="preview.them.owned && preview.them.playbookMaps?.includes(preview.map)" class="lv-nmready warn" title="this HUMAN owner has authored plays on this map — expect set pieces">⚠ they have plays on {{ preview.map }}</span>
        </div>
        <div v-if="preview.them.dossier" class="lv-dossier">
          <div class="lv-doshead">⌖ THEIR TENDENCIES</div>
          <div class="lv-dosrow"><i>ATTACK</i><span>{{ preview.them.dossier.attack }}<em v-if="preview.them.dossier.lurk"> · runs a lurk</em></span></div>
          <div class="lv-dosrow"><i>DEFENSE</i><span>{{ preview.them.dossier.defense }}</span></div>
          <div v-for="(k, ki) in (preview.them.dossier.kit ?? []).slice(0, 3)" :key="'pk' + ki" class="lv-dosrow" style="opacity:.85"><i>{{ ki === 0 ? 'KITS' : '' }}</i><span>{{ k }}</span></div>
          <div class="lv-doscounter"><i>⮞ COUNTER</i><span>{{ preview.them.dossier.counter }}</span></div>
        </div>
        <div v-else class="lv-note" style="padding:8px 2px">a human-run club — no AI tells; scout their form and playbook coverage above</div>
      </div>
    </div>

    <div v-if="clubModal" class="lv-clubmodal" @click.self="clubModal = null">
      <div class="lv-clubcard">
        <button class="lv-clubx" @click="clubModal = null">✕</button>
        <!-- crest hero: the club's identity -->
        <div class="lv-clubhero" :style="{ '--cc': `hsl(${hue(clubModal.tag)} 66% 56%)` }">
          <div class="lv-crest" :style="{ background: `linear-gradient(150deg, hsl(${hue(clubModal.tag)} 55% 26%), hsl(${hue(clubModal.tag)} 50% 16%))`, borderColor: `hsl(${hue(clubModal.tag)} 66% 56%)` }">
            <span class="lv-cresttag">{{ clubModal.tag }}</span>
          </div>
          <div class="lv-clubid">
            <b class="lv-clubname">{{ clubModal.name }}</b>
            <div class="lv-clubtags">
              <span class="lv-clubdiv">{{ clubModal.division || tierName(clubModal.tier) }}</span>
              <span class="lv-stars" :title="`squad quality`">{{ '★'.repeat(clubStars(clubModal.power)) }}<i>{{ '★'.repeat(5 - clubStars(clubModal.power)) }}</i></span>
              <span :class="clubModal.owned ? 'lv-owntag' : 'lv-aitag'">{{ clubModal.owned ? '◉ OWNED' : '⚙ AI' }}</span>
              <span v-if="clubModal.vip" class="lv-vip" title="this club's owner is a VIP supporter">★ VIP</span>
              <button v-if="myClub && !mine(clubModal.tag)" class="lv-challenge" :disabled="challengeBusy"
                      :title="clubModal.owned ? 'challenge this owner to a FRIENDLY — instant, engine-resolved, watchable; standings untouched' : 'scrim this AI club — instant, engine-resolved, watchable'"
                      @click="doChallenge(clubModal.tag)">⚔ {{ challengeBusy ? 'playing…' : clubModal.owned ? 'challenge' : 'scrim' }}</button>
              <span v-if="clubModal.phase" class="lv-phase" :class="'ph-' + clubModal.phase">{{ PHASE_LABEL[clubModal.phase] }}</span>
            </div>
            <span v-if="clubModal.style" class="lv-aistyle" :class="'ai-' + clubModal.style.archetype.toLowerCase()" :title="`AI manager style — ${clubModal.style.label}`">⚙ {{ clubModal.style.archetype }} · {{ clubModal.style.label }}</span>
          </div>
        </div>
        <!-- VS YOU: how you stack up against the club you're scouting -->
        <div v-if="challengeResult" class="lv-chresult">
          ⚔ <b>{{ challengeResult.home.tag }}</b> {{ challengeResult.score[0] }}–{{ challengeResult.score[1] }} <b>{{ challengeResult.away.tag }}</b>
          on <i class="hq-rmap">{{ challengeResult.map }}</i>
          <span :class="challengeResult.score[0] > challengeResult.score[1] ? 'pos' : 'neg'">{{ challengeResult.score[0] > challengeResult.score[1] ? 'you won the friendly' : 'they took it' }}</span>
          <button class="lv-watch" :disabled="loadingWatch" @click="watchFriendly(challengeResult.id)">▷ watch it</button>
        </div>
        <div v-if="friendlyH2h[clubModal.tag]" class="lv-pbscout" title="your friendly head-to-head vs this club">
          ⚔ friendly record vs {{ clubModal.tag }}: <b :class="friendlyH2h[clubModal.tag].w >= friendlyH2h[clubModal.tag].l ? 'pos' : 'neg'">{{ friendlyH2h[clubModal.tag].w }}–{{ friendlyH2h[clubModal.tag].l }}</b>
        </div>
        <div v-if="clubModal.owned && clubModal.playbookMaps?.length" class="lv-pbscout"
             title="which maps this owner has AUTHORED plays on (coverage only — the plays themselves stay private). Expect set pieces there; the uncovered maps run on dials alone.">
          ▦ authored playbooks: <b v-for="m in clubModal.playbookMaps" :key="m" class="lv-pbmap">{{ m }}</b>
        </div>
        <div v-if="clubModal.vsYou" class="lv-vsyou">
          <span class="lv-vslbl">⚔ VS YOU</span>
          <span class="lv-vsmine">{{ clubModal.vsYou.tag }} <i>{{ clubModal.vsYou.power }}</i></span>
          <span class="lv-vsdelta" :class="clubModal.vsYou.power - (clubModal.power ?? 0) >= 0 ? 'up' : 'down'">{{ clubModal.vsYou.power - (clubModal.power ?? 0) >= 0 ? '+' : '' }}{{ clubModal.vsYou.power - (clubModal.power ?? 0) }} OVR</span>
          <span v-if="clubModal.vsYou.played" class="lv-vsh2h">series {{ clubModal.vsYou.w }}–{{ clubModal.vsYou.l }}</span>
          <span v-else class="lv-vsh2h none">not played yet</span>
        </div>
        <!-- the read: how good + how they rank -->
        <div class="lv-clubstats">
          <div class="lv-cstat"><b>{{ clubModal.power ?? clubModal.rating }}</b><span>SQUAD OVR</span></div>
          <div class="lv-cstat"><b>#{{ clubModal.powerRank ?? '—' }}</b><span>WORLD RANK<i v-if="clubPct(clubModal.powerRank, clubModal.totalClubs)"> · top {{ clubPct(clubModal.powerRank, clubModal.totalClubs) }}%</i></span></div>
          <div class="lv-cstat"><b class="lv-hqpips"><i v-for="n in 5" :key="n" :class="{ on: n <= (clubModal.infra ?? 0) }"></i></b><span>HQ INFRA</span></div>
          <div class="lv-cstat"><b class="lv-trophyn">{{ (clubModal.titles || 0) + (clubModal.intlTitles || 0) + (clubModal.wcTitles || 0) }}</b><span>TROPHIES</span></div>
          <div v-if="clubModal.fans" class="lv-cstat" :title="`the club's following — results grow it, stars hold it, and it prices the sponsor table (a grown brand draws bigger cheques)`"><b>{{ kfans(clubModal.fans) }}</b><span>FOLLOWERS</span></div>
        </div>
        <!-- the cabinet -->
        <div v-if="clubModal.titles || clubModal.intlTitles || clubModal.wcTitles" class="lv-honstrip">
          <span v-if="clubModal.titles" class="lv-hon">🏆 <b>{{ clubModal.titles }}×</b> league</span>
          <span v-if="clubModal.intlTitles" class="lv-hon">🌐 <b>{{ clubModal.intlTitles }}×</b> Masters</span>
          <span v-if="clubModal.wcTitles" class="lv-hon gold">🌍 <b>{{ clubModal.wcTitles }}×</b> World Cup mgr</span>
        </div>
        <!-- franchise legends: careers that finished wearing this tag -->
        <div v-if="clubModal.clubLegends?.length" class="lv-honstrip" title="retired players whose careers ended at this club — the franchise's history">
          <span v-for="l in clubModal.clubLegends" :key="l.handle" class="lv-hon">
            {{ l.inducted ? '🏛' : '🎙' }} <b>{{ l.handle }}</b> <i style="opacity:.75">{{ l.kills.toLocaleString() }}k · {{ l.seasons }}s</i>
          </span>
        </div>
        <!-- current form: how good RIGHT NOW (resolved games only) -->
        <div v-if="clubModal.record && (clubModal.record.w + clubModal.record.l) > 0" class="lv-clubform">
          <span class="lv-formlbl">FORM</span>
          <span class="lv-formpills">
            <i v-for="(g, i) in clubModal.form" :key="i" :class="g.r === 'W' ? 'w' : 'l'" :title="`${g.r === 'W' ? 'won' : 'lost'} ${g.us}–${g.them} vs ${g.opp} (md ${g.day})`">{{ g.r }}</i>
          </span>
          <span class="lv-formrec"><b>{{ clubModal.record.w }}W–{{ clubModal.record.l }}L</b><template v-if="clubModal.standing"> · {{ ord(clubModal.standing) }} in {{ clubModal.division }}</template></span>
        </div>
        <div v-if="clubModal.dossier" class="lv-dossier">
          <div class="lv-doshead">⌖ SCOUTING REPORT</div>
          <div class="lv-dosrow"><i>ATTACK</i><span>{{ clubModal.dossier.attack }}<em v-if="clubModal.dossier.lurk"> · runs a lurk</em></span></div>
          <div class="lv-dosrow"><i>DEFENSE</i><span>{{ clubModal.dossier.defense }}</span></div>
          <div v-if="clubModal.dossier.smoke" class="lv-dosrow"><i>UTILITY</i><span>{{ clubModal.dossier.smoke }}</span></div>
          <div v-for="(k, ki) in clubModal.dossier.kit ?? []" :key="'kit' + ki" class="lv-dosrow" style="opacity:.85"><i>{{ ki === 0 ? 'KITS' : '' }}</i><span>{{ k }}</span></div>
          <div class="lv-doscounter"><i>⮞ COUNTER</i><span>{{ clubModal.dossier.counter }}</span></div>
        </div>
        <div class="lv-clubfive">
          <div v-for="p in clubModal.five" :key="p.handle" class="lv-fiverow">
            <span class="rs-role" :class="p.role">{{ roleAbbr(p.role) }}</span>
            <span class="lv-fivehandle">
              <span class="lv-fivetop"><b>{{ p.handle }}</b><i v-if="p.igl" class="lv-igltag">IGL</i><span v-if="p.trait" class="lv-fivetrait" :title="`personality: ${p.trait}`">✦ {{ p.trait }}</span><span v-for="a in p.accolades ?? []" :key="a" class="lv-acc" :title="a.startsWith('MVP') ? 'season MVP — the market prices the proof' : 'season Young Gun (best U22)'">★ {{ a }}</span></span>
              <span v-if="p.name" class="lv-fiveperson" :title="p.country"><span class="lv-flag">{{ p.flag }}</span> {{ p.name }}<i v-if="p.age"> · {{ p.age }}</i></span>
            </span>
            <span v-if="p.agent" class="lv-fiveagent">{{ p.agent }}</span>
            <span v-if="p.solo" class="lv-ldsolo" :class="'rk-' + (p.soloTier || '').toLowerCase()">{{ p.solo }}</span>
            <span class="lv-fiveovr">{{ p.overall }} <i>OVR</i></span>
            <button v-if="clubModal.owned && myClub && !mine(clubModal.tag)" class="lv-watch" style="padding:1px 7px"
                    :title="`bid for ${p.handle} — an owner-to-owner deal; ${clubModal.tag}'s owner decides`"
                    @click="offerFor = offerFor?.handle === p.handle ? null : { handle: p.handle, amount: '' }">⇄ bid</button>
          </div>
          <div v-if="offerFor && clubModal.owned" class="lv-frow" style="gap:8px">
            <span class="lv-fscore">offer for <b>{{ offerFor.handle }}</b>: $</span>
            <input v-model="offerFor.amount" type="number" min="1" placeholder="amount" style="width:110px;background:#1c1f27;border:1px solid #3a3f4d;color:#e8e8ea;border-radius:6px;padding:3px 8px"
                   @keyup.enter="sendOffer(clubModal.tag)" />
            <button class="lv-watch" :disabled="offerBusy" @click="sendOffer(clubModal.tag)">{{ offerBusy ? 'sending…' : 'send offer' }}</button>
          </div>
          <div v-if="offerMsg && clubModal.owned" class="lv-note" style="padding:4px 10px">{{ offerMsg }}</div>
        </div>
      </div>
    </div>

    <!-- player profile card (your squad) — a full dossier, reusing the single-player card -->
    <div v-if="playerCard" class="pc-overlay" @click.self="playerCard = null">
      <div class="pc-card">
        <button class="lv-clubx" @click="playerCard = null">✕</button>
        <div class="pc-head">
          <span class="rs-role" :class="playerCard.role">{{ playerCard.role.slice(0, 3).toUpperCase() }}</span>
          <div class="pc-headmeta">
            <b class="pc-tag">{{ playerCard.handle }}<i v-if="playerCard.starter" class="lv-starter">XI</i><i v-if="playerCard.igl" class="rs-igl">IGL</i></b>
            <span class="pc-name">{{ person(playerCard.id).nation.flag }} {{ person(playerCard.id).name }} · {{ person(playerCard.id).nation.country }}</span>
          </div>
          <div class="pc-ovr"><b>{{ playerCard.overall }}</b><span>OVR</span></div>
        </div>
        <div class="pc-bio">
          <span><i>Age</i> {{ playerCard.age }}</span>
          <span><i>Birthday</i> 🎂 {{ bday(playerCard.id) }}</span>
          <span :class="'rk-' + solo(playerCard.overall).tier.toLowerCase()"><i>Solo rank</i> {{ solo(playerCard.overall).label }}</span>
          <span><i>Ceiling</i> ↗ {{ playerCard.ceiling[0] }}–{{ playerCard.ceiling[1] }}<em v-if="playerCard.room" class="pc-room"> (+{{ playerCard.room }})</em></span>
          <span v-if="trait(playerCard.id)"><i>Trait</i> ✦ {{ trait(playerCard.id)!.label }}</span>
          <span :class="{ gold: playerCard.injury || playerCard.fatigue >= 70 }"><i>Condition</i> <template v-if="playerCard.injury">⚕ OUT {{ playerCard.injury }}d</template><template v-else>{{ playerCard.fatigue }}% fatigue</template></span>
          <span :class="{ gold: playerCard.mood >= 72, muted: playerCard.mood < 48 }"><i>Morale</i> {{ playerCard.mood >= 72 ? '☺' : playerCard.mood < 48 ? '☹' : '·' }} {{ playerCard.mood }}% ({{ moodLabel(playerCard.mood) }})</span>
          <span :class="{ gold: playerCard.contractYears === 1 }"><i>Contract</i> <template v-if="playerCard.contractYears">{{ playerCard.contractYears }}y · {{ kfmt(playerCard.wage) }}/y</template><template v-else>no deal</template></span>
          <span><i>Value</i> {{ kfmt(playerCard.value) }}</span>
          <span v-if="playerCard.focus"><i>Training</i> ◎ {{ ATTR_LABEL[playerCard.focus] || playerCard.focus }}</span>
          <span v-if="playerCard.captain || playerCard.mentor || playerCard.mentee"><i>Role</i>
            <template v-if="playerCard.captain">Ⓒ Captain</template>
            <template v-if="playerCard.mentor">🎓 Mentor</template>
            <template v-if="playerCard.mentee">↑ Mentored</template>
          </span>
        </div>
        <div class="pc-section">Attributes <span class="pc-ceilkey">current ↗ scouted ceiling</span></div>
        <div class="pc-attrs">
          <div v-for="a in playerCard.attrs" :key="a.key" class="pc-attr">
            <span class="pc-al">{{ ATTR_LABEL[a.key] }}</span>
            <span class="pc-abar"><i :class="{ mech: a.mech }" :style="{ width: a.cur + '%' }"></i><span class="pc-tick" :style="{ left: a.ceil + '%' }"></span></span>
            <span class="pc-av"><b>{{ a.cur }}</b><em v-if="a.ceil > a.cur">↗{{ a.ceil }}</em></span>
          </div>
        </div>
        <template v-if="playerCard.agents.length">
          <div class="pc-section">Agent pool</div>
          <div class="pc-agents">
            <span v-for="ag in playerCard.agents" :key="ag.agent" class="pc-agent"><span>{{ ag.agent }}</span><b>{{ ag.level }}</b></span>
          </div>
        </template>
        <div v-if="trait(playerCard.id)" class="pc-traitnote">✦ {{ trait(playerCard.id)!.blurb }}</div>
      </div>
    </div>
  </div>
</template>
