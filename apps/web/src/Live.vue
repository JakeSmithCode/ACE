<script setup lang="ts">
// The Match Center — the async-PvP client. The world resolves on the @ace/server
// tick, not in this browser; here we watch it. During a match's broadcast window the
// running score streams in live (SSE) with the result SEALED (the embargo — no
// spoilers until it's over); once revealed we pull the snapshot and re-sim it in the
// viewer (the engine runs client-side, so watching costs the server nothing). This is
// the seam between the deep persistence backend and the broadcast-grade viewer.
import { onMounted, onUnmounted, ref, computed, watch as vueWatch } from 'vue';
import type { MapId, Tactics } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import { RANK_TIERS, personOf, soloRank, traitOf, fmtDayMonth } from '@ace/world';
import { Viewer } from './viewer';
import { AceServer, type WorldSummary, type StandingRow, type LiveFixture, type ClubPage, type MarketEntry, type SquadPlayer, type LeaderRow, type ClubRankRow, type NewsItem, type StatRow, type CupView, type CupTieView } from './serverApi';
const SCOUT_MAX = 3;

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
// mirror the access token to localStorage so a single sign-in carries to other views
// (the World Cup election panel reuses it). Cleared on sign-out.
vueWatch(token, (t: string | null) => { if (t) localStorage.setItem('ace.token', t); else localStorage.removeItem('ace.token'); });
const tierName = (t: number) => RANK_TIERS[t] ?? `T${t}`;
const mine = (tag: string) => myClub.value?.tag === tag;

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
  } catch (e) { authErr.value = (e as Error).message; } finally { busy.value = false; }
}
async function refreshMe() { if (server.value && token.value) { myClub.value = await server.value.me(token.value).catch(() => null); syncTac(); await loadNotifs(); await loadMail(); } }
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
async function renew(sp: SquadPlayer) {
  if (!server.value || !token.value) return;
  marketBusy.value = true;
  try { const r = await server.value.renew(sp.id, token.value); if (r.ok) await refreshMe(); }
  catch (e) { errMsg.value = (e as Error).message; } finally { marketBusy.value = false; }
}

// --- the academy — your homegrown youth pipeline (build → intake → develop → graduate)
const academyOpen = ref(false);
const acadBusy = ref(false);
const acadMsg = ref('');
function toggleAcademy() { academyOpen.value = !academyOpen.value; }
const academy = computed(() => myClub.value?.academy ?? null);
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
    table.value = (await s.standings(world.value.season, 0, 0)).table;
    server.value = s; status.value = 'live';
    const saved = localStorage.getItem('ace.token');   // stay signed in across refresh
    if (saved && !token.value) token.value = saved;
    await refreshMe();
    await loadHonors();
    await loadNews();
    openStream();
    // a shared deep-link (?watch=season/day/slot) → auto-open that replay
    const wp = new URL(location.href).searchParams.get('watch');
    if (wp) { const [ws, wd, wsl] = wp.split('/').map(Number); if (![ws, wd, wsl].some(isNaN)) void watchAt(ws, wd, wsl); }
    // standings only move at reveal — refresh them every few seconds while watching
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { refreshTable(); if (!notifOpen.value) loadNotifs(); if (!mailOpen.value) loadMail(); }, 4000);
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
    await loadNews();
    if (statsOpen.value) await loadStats();
    if (r.rollover) cupView.value = null;            // a new season → a fresh cup
    if (cupOpen.value) await loadCup();
  } catch (e) { errMsg.value = (e as Error).message; } finally { advancing.value = false; }
}
async function refreshTable() { if (server.value && world.value) try { table.value = (await server.value.standings(world.value.season, 0, 0)).table; } catch { /* transient */ } }
// the Hall of Fame — the world's champions (the legacy engine)
const hof = ref<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[] }>({ honors: [], allTime: [] });
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
    computeBox(out);
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav); });
  } catch (e) { errMsg.value = (e as Error).message; } finally { loadingWatch.value = false; }
}

// season stat leaders — top fraggers from the watched (Premier) matches that have played
const statRows = ref<StatRow[]>([]);
const statsOpen = ref(false);
async function loadStats() { if (server.value) try { statRows.value = (await server.value.stats()).players; } catch { /* transient */ } }
async function toggleStats() { statsOpen.value = !statsOpen.value; if (statsOpen.value) await loadStats(); }

// --- watch a revealed fixture back in the viewer (live or via a shared link) ---
interface Watched { home: { tag: string; name: string }; away: { tag: string; name: string }; final: [number, number] | null; map: string | null; season: number; day: number; slot: number; live?: boolean; cup?: boolean }
const host = ref<HTMLElement | null>(null);
const watching = ref<Watched | null>(null);
const loadingWatch = ref(false);

// the post-match box score — derived client-side from the re-simmed timeline's kill
// events (the engine keys kills by player handle). Each player's K/D, first bloods,
// and a Player of the Match (most kills, K−D tiebreak). The watch view is the product.
interface BoxRow { handle: string; name?: string; flag?: string; role: string; agent?: string; igl?: boolean; kills: number; deaths: number; fb: number; mvp: boolean }
const boxScore = ref<{ teams: [BoxRow[], BoxRow[]]; mvp: string } | null>(null);
function computeBox(tl: import('@ace/shared').MatchTimeline) {
  const kills: Record<string, number> = {}, deaths: Record<string, number> = {}, fb: Record<string, number> = {};
  for (const r of tl.rounds) {
    const ks = r.events.filter((e): e is Extract<typeof e, { kind: 'kill' }> => e.kind === 'kill').sort((a, b) => a.t - b.t);
    ks.forEach((e, i) => { kills[e.killer] = (kills[e.killer] || 0) + 1; deaths[e.victim] = (deaths[e.victim] || 0) + 1; if (i === 0) fb[e.killer] = (fb[e.killer] || 0) + 1; });
  }
  const rowsOf = (t: number): BoxRow[] => tl.teams[t].players.map(p => { const person = personOf(p.id); return { handle: p.handle, name: person.name, flag: person.nation.flag, role: p.role, agent: p.agent, igl: p.igl, kills: kills[p.handle] || 0, deaths: deaths[p.handle] || 0, fb: fb[p.handle] || 0, mvp: false }; })
    .sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths));
  const all = [...rowsOf(0), ...rowsOf(1)];
  const mvp = all.slice().sort((a, b) => b.kills - a.kills || (b.kills - b.deaths) - (a.kills - a.deaths))[0];
  if (mvp) mvp.mvp = true;
  boxScore.value = { teams: [rowsOf(0).map(r => ({ ...r, mvp: r.handle === mvp?.handle })), rowsOf(1).map(r => ({ ...r, mvp: r.handle === mvp?.handle }))], mvp: mvp?.handle ?? '' };
}
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
    computeBox(out);
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, out, `/${map}.png`, nav); });
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
    boxScore.value = null;
    requestAnimationFrame(() => { viewer?.destroy(); if (host.value) viewer = new Viewer(host.value, tl, `/${map}.png`, nav, { live: !lt.resolved }); });
    if (lt.resolved) computeBox(tl);
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
        if (watching.value) watching.value = { ...watching.value, live: false, final: lt.timeline.finalScore };
      }
    } catch { /* transient — keep polling */ }
  }, 2500);
}
function closeWatch() { stopLivePoll(); watching.value = null; boxScore.value = null; viewer?.destroy(); viewer = null; }
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
  try { clubModal.value = await server.value.club(slug, token.value ?? undefined); }
  catch (e) { errMsg.value = (e as Error).message; } finally { clubBusy.value = false; }
}
const roleAbbr = (r: string) => r.slice(0, 3).toUpperCase();
// club-profile readouts: a star tier from squad power, and the world-rank percentile
const clubStars = (power = 0) => Math.max(1, Math.min(5, Math.round((power - 55) / 7)));   // ~55→1★ .. ~90→5★
const clubPct = (rank?: number | null, total?: number) => (rank && total ? Math.max(1, Math.round((rank / total) * 100)) : null);
const ord = (n: number) => { const s = n % 100; return n + (s > 3 && s < 21 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th')); };

onMounted(connect);
onUnmounted(() => { stopStream?.(); chatStop?.(); if (pollTimer) clearInterval(pollTimer); stopLivePoll(); viewer?.destroy(); });
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
          <button class="lv-planbtn acad" :class="{ on: academyOpen }" @click="toggleAcademy">⬡ academy</button>
          <span v-if="myClub.balance != null" class="lv-bank">bank {{ kfmt(myClub.balance) }}</span>
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
                <div v-for="n in notifList" :key="n.id" class="lv-notifrow" :class="[n.kind, { unread: !n.read }]">
                  <i class="lv-notifico">{{ notifIcon[n.kind] }}</i>
                  <span class="lv-notiftext">{{ n.text }}</span>
                  <span class="lv-notifage">S{{ n.season }}</span>
                </div>
                <div v-if="!notifList.length" class="lv-empty">no notifications yet</div>
              </div>
            </div>
          </Teleport>
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
          <template v-for="e in board" :key="e.handle">
          <div class="lv-mktrow">
            <span class="rs-role" :class="e.role">{{ e.role.slice(0, 3).toUpperCase() }}</span>
            <b class="lv-mkthandle clk" :class="{ open: expanded.has('m:'+e.handle) }" title="per-skill scouting" @click="toggleExpand('m:'+e.handle)">{{ e.handle }}<i class="lv-disc">▾</i></b>
            <span class="lv-mktage">age {{ e.age }}</span>
            <span class="lv-mktovr">{{ e.overall }} <i>OVR</i></span>
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
                <b class="lv-mkthandle clk" title="open profile card" @click="playerCard = sp">{{ sp.handle }}<i v-if="sp.starter" class="lv-starter">XI</i><i v-if="sp.igl" class="lv-iglb">IGL</i></b>
                <span class="lv-sqperson">{{ person(sp.id).nation.flag }} {{ person(sp.id).name }}
                  <i class="lv-sqsolo" :class="'rk-'+solo(sp.overall).tier.toLowerCase()">{{ solo(sp.overall).label }}</i>
                  <i v-if="trait(sp.id)" class="lv-sqtrait rs-trait" :class="'tr-'+trait(sp.id)!.key" :title="trait(sp.id)!.blurb">✦ {{ trait(sp.id)!.label }}</i>
                  <i v-if="sp.injury" class="lv-sqinj" :title="`injured — out ${sp.injury} more match-day(s); a reserve covers, or he plays hurt`">⚕ OUT {{ sp.injury }}d</i>
                  <i v-else-if="sp.fatigue >= 40" class="lv-sqfat" :class="{ tired: sp.fatigue >= 70 }" :title="`match fatigue ${sp.fatigue}% — rotate him out to recover; high fatigue dulls his game and risks injury`">◔ {{ sp.fatigue }}%</i>
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
                <button v-if="sp.contractYears > 0 && sp.contractYears <= 1" class="lv-scoutbtn renew" :disabled="marketBusy" :title="`re-sign at his current wage (${kfmt(sp.renew)}/yr) — or he walks free at season's end`" @click="renew(sp)">renew</button>
                <button v-if="canStart(sp)" class="lv-scoutbtn start" :disabled="marketBusy" title="field him — starters get reps and develop" @click="startReserve(sp)">▶ start</button>
                <button v-else-if="canBench(sp)" class="lv-scoutbtn" :disabled="marketBusy" title="bench him (a benched player rusts)" @click="benchStarter(sp)">bench</button>
                <button class="lv-sellbtn" :disabled="marketBusy" @click="sell(sp)">sell</button>
              </span>
              <span class="lv-mktmsg" :class="{ ok: (sellMsg[sp.id] || '').startsWith('✓') }">{{ sellMsg[sp.id] }}</span>
            </div>
            <div v-if="expanded.has('s:'+sp.id)" class="lv-attrs">
              <div v-for="a in sp.attrs" :key="a.key" class="lv-attr" :class="{ mech: a.mech }">
                <span class="lv-attrk">{{ ATTR_LABEL[a.key] }}</span>
                <span class="lv-attrbar"><i class="fill" :style="{ width: a.cur + '%' }"></i><i v-if="a.ceil > a.cur" class="gap" :style="{ left: a.cur + '%', width: (a.ceil - a.cur) + '%' }"></i><i class="tick" :style="{ left: a.ceil + '%' }"></i></span>
                <span class="lv-attrv">{{ a.cur }}<em v-if="a.ceil > a.cur">↗{{ a.ceil }}</em></span>
              </div>
            </div>
            </template>
          </div>
        </div>
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
          <span v-for="(n, i) in newsFeed.slice(0, 14)" :key="i" class="lv-newsitem" :class="n.kind">
            <i class="lv-newsico">{{ newsIcon[n.kind] }}</i>{{ n.text }}<em class="lv-newsage">S{{ n.season }}</em>
          </span>
        </div>
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
        <!-- post-match box score + Player of the Match (derived from the timeline) -->
        <div v-if="boxScore" class="lv-box">
          <div v-for="(team, ti) in boxScore.teams" :key="ti" class="lv-boxteam">
            <div class="lv-boxhead">
              <i class="hq-dot" :style="{ background: `hsl(${hue(ti === 0 ? watching.home.tag : watching.away.tag)} 65% 55%)` }"></i>
              <b>{{ ti === 0 ? watching.home.name : watching.away.name }}</b>
              <span class="lv-boxsc">{{ watching.final?.[ti] }}</span>
            </div>
            <div class="lv-boxrow lv-boxthead"><span>Player</span><span>K</span><span>D</span><span>+/−</span><span>FB</span></div>
            <div v-for="p in team" :key="p.handle" class="lv-boxrow" :class="{ mvp: p.mvp }">
              <span class="lv-boxp"><span class="rs-role" :class="p.role">{{ p.role.slice(0,3).toUpperCase() }}</span><b>{{ p.handle }}</b><span v-if="p.flag" class="lv-boxflag" :title="p.name">{{ p.flag }}</span><i v-if="p.igl" class="lv-igl">IGL</i><i v-if="p.mvp" class="lv-mvp">★ MVP</i></span>
              <span>{{ p.kills }}</span><span>{{ p.deaths }}</span>
              <span :class="p.kills - p.deaths >= 0 ? 'pos' : 'neg'">{{ p.kills - p.deaths >= 0 ? '+' : '' }}{{ p.kills - p.deaths }}</span>
              <span>{{ p.fb }}</span>
            </div>
          </div>
        </div>
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

      <!-- the world's best players — a cross-club prestige board (solo rank ≠ division) -->
      <div class="lv-leaders">
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
      <div class="lv-leaders">
        <div class="lv-tableh">
          <button class="lv-kicker btn" @click="toggleStats">🎯 Season stat leaders <i class="lv-disc" :class="{ open: statsOpen }">▾</i></button>
          <span class="lv-note">top fraggers from Premier matches played so far this season</span>
        </div>
        <template v-if="statsOpen">
          <div class="lv-ldboard">
            <div class="lv-strow lv-sthead"><span class="lv-ldrank">#</span><span></span><span>Player</span><span>K</span><span>D</span><span>K/D</span><span>FB</span><span>MVP</span><span>GP</span></div>
            <div v-for="s in statRows" :key="s.handle" class="lv-strow">
              <span class="lv-ldrank" :class="{ top: s.rank <= 3 }">{{ s.rank }}</span>
              <span class="rs-role" :class="s.role">{{ s.role.slice(0,3).toUpperCase() }}</span>
              <b class="lv-sthandle">{{ s.handle }} <i class="lv-stclub" @click="openClub(s.club)">{{ s.club }}</i></b>
              <span class="lv-stk">{{ s.kills }}</span><span>{{ s.deaths }}</span>
              <span :class="s.kd >= 1 ? 'pos' : 'neg'">{{ s.kd.toFixed(2) }}</span>
              <span>{{ s.fb }}</span><span class="lv-stmvp">{{ s.mvp || '' }}</span><span>{{ s.matches }}</span>
            </div>
            <div v-if="!statRows.length" class="lv-empty">no matches resolved yet — advance a match-day</div>
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
              <span v-if="clubModal.phase" class="lv-phase" :class="'ph-' + clubModal.phase">{{ PHASE_LABEL[clubModal.phase] }}</span>
            </div>
            <span v-if="clubModal.style" class="lv-aistyle" :class="'ai-' + clubModal.style.archetype.toLowerCase()" :title="`AI manager style — ${clubModal.style.label}`">⚙ {{ clubModal.style.archetype }} · {{ clubModal.style.label }}</span>
          </div>
        </div>
        <!-- VS YOU: how you stack up against the club you're scouting -->
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
        </div>
        <!-- the cabinet -->
        <div v-if="clubModal.titles || clubModal.intlTitles || clubModal.wcTitles" class="lv-honstrip">
          <span v-if="clubModal.titles" class="lv-hon">🏆 <b>{{ clubModal.titles }}×</b> league</span>
          <span v-if="clubModal.intlTitles" class="lv-hon">🌐 <b>{{ clubModal.intlTitles }}×</b> Masters</span>
          <span v-if="clubModal.wcTitles" class="lv-hon gold">🌍 <b>{{ clubModal.wcTitles }}×</b> World Cup mgr</span>
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
          <div class="lv-doscounter"><i>⮞ COUNTER</i><span>{{ clubModal.dossier.counter }}</span></div>
        </div>
        <div class="lv-clubfive">
          <div v-for="p in clubModal.five" :key="p.handle" class="lv-fiverow">
            <span class="rs-role" :class="p.role">{{ roleAbbr(p.role) }}</span>
            <span class="lv-fivehandle">
              <span class="lv-fivetop"><b>{{ p.handle }}</b><i v-if="p.igl" class="lv-igltag">IGL</i><span v-if="p.trait" class="lv-fivetrait" :title="`personality: ${p.trait}`">✦ {{ p.trait }}</span></span>
              <span v-if="p.name" class="lv-fiveperson" :title="p.country"><span class="lv-flag">{{ p.flag }}</span> {{ p.name }}<i v-if="p.age"> · {{ p.age }}</i></span>
            </span>
            <span v-if="p.agent" class="lv-fiveagent">{{ p.agent }}</span>
            <span v-if="p.solo" class="lv-ldsolo" :class="'rk-' + (p.soloTier || '').toLowerCase()">{{ p.solo }}</span>
            <span class="lv-fiveovr">{{ p.overall }} <i>OVR</i></span>
          </div>
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
          <span :class="{ gold: playerCard.contractYears === 1 }"><i>Contract</i> <template v-if="playerCard.contractYears">{{ playerCard.contractYears }}y · {{ kfmt(playerCard.wage) }}/y</template><template v-else>no deal</template></span>
          <span><i>Value</i> {{ kfmt(playerCard.value) }}</span>
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
