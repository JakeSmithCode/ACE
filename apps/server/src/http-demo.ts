// `pnpm run server:live` — boot the live-broadcast HTTP server on a SHORT window
// and act as a client against it, proving the result embargo + the synced SSE
// match-center end to end over the real wall-clock. Same code path as a real 8pm
// slot, just a ~12s broadcast so the demo finishes while you watch.
import { startLiveServer } from './http.js';

const BROADCAST = 12;   // seconds — a tiny stand-in for the 40-min real slot

const get = async (url: string) => (await fetch(url)).json() as Promise<any>;

// stream an SSE endpoint, handing each `data:` frame to `onFrame`; resolves on `event: done`
async function sse(url: string, onFrame: (f: any) => void): Promise<void> {
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
      if (chunk.startsWith('event: done')) return;
      const line = chunk.split('\n').find(l => l.startsWith('data:'));
      if (line) onFrame(JSON.parse(line.slice(5).trim()));
    }
  }
}

async function main() {
  const srv = await startLiveServer({ seed: 7, broadcastSecs: BROADCAST });
  console.log(`\n  live server up at ${srv.url} · world ${srv.id} · ${BROADCAST}s broadcast window\n`);

  const health = await get(`${srv.url}/health`);
  // find a watchable Premier fixture (slot 0 is full-simmed; the embargo applies to all)
  const SEASON = 1, DAY = 0, SLOT = 0;
  const fxUrl = `${srv.url}/fixtures/${SEASON}/${DAY}/${SLOT}`;

  // ── 0a. self-owned auth: register → tokens → refresh rotation ─────────────
  const reg = await (await fetch(`${srv.url}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'jake@ace.gg', password: 'correct horse' }) })).json();
  const noAuth = await fetch(`${srv.url}/me`);                                    // no token → 401
  const reused = await fetch(`${srv.url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'jake@ace.gg', password: 'wrong' }) });
  const refreshed = await (await fetch(`${srv.url}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: reg.refreshToken }) })).json();
  const replayOld = await fetch(`${srv.url}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: reg.refreshToken }) });
  console.log(`  auth          : register → access+refresh issued ${reg.accessToken ? '✓' : '✗'}; no token → HTTP ${noAuth.status}; bad password → HTTP ${reused.status}`);
  console.log(`  refresh       : rotated → new access ${refreshed.accessToken ? '✓' : '✗'}; reusing the old refresh → HTTP ${replayOld.status} ${replayOld.status === 401 ? '(single-use ✓)' : '(REPLAY ✗)'}`);
  const token = refreshed.accessToken as string;   // the rotated, valid access token

  // ── 0b. the API surface: public club page, ownership, embargo-aware standings ─
  const w = srv.store.loadWorld(srv.id)!;
  const target = w.clubs.find(c => c.tier === 0 && !c.owner)!.tag;
  const acct = (m: string, p: string, body?: unknown) => fetch(`${srv.url}${p}`, { method: m, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const standDuring = await get(`${srv.url}/standings/${SEASON}/0/0`);
  const claimed = await (await acct('POST', `/clubs/${target}/claim`)).json();
  const denied = await fetch(`${srv.url}/clubs/${target}/claim`, { method: 'POST', headers: { 'x-account': 'acct-rival' } });
  await acct('PATCH', '/me/plan', { tactics: { attack: { siteBias: 1, tempo: 1 }, defense: { read: 1, aggression: 0.6 } } });
  const me = await (await acct('GET', '/me')).json();
  const clubPage = await get(`${srv.url}/clubs/${target}`);
  console.log(`  club page     : ${clubPage.tag} (T${clubPage.tier} · ${clubPage.rating} OVR · five ${clubPage.five.map((p: any) => p.handle).join('/')}) owned=${clubPage.owned}`);
  console.log(`  ownership     : ${reg.accountId} claimed ${claimed.tag} via Bearer → owned ${claimed.owned ? '✓' : '✗'}; rival claim → HTTP ${denied.status} ${denied.status === 409 ? '(blocked ✓)' : '(LEAK ✗)'}`);
  console.log(`  plan write    : /me read=${me.plan.tactics.defense.read} tempo=${me.plan.tactics.attack.tempo} → authored ✓`);
  const playedDuring = standDuring.table.reduce((n: number, r: any) => n + r.played, 0);
  console.log(`  standings     : during window → ${playedDuring} games played in the table ${playedDuring === 0 ? '(embargoed ✓)' : '(LEAK ✗)'}`);
  const world = await get(`${srv.url}/world`);
  const sched = await get(`${srv.url}/schedule/0/0`);
  const liveDay = sched.matchdays[0].filter((f: any) => f.status !== 'scheduled').length;
  console.log(`  world         : ${world.region} S${world.season} D${world.day} · ${world.tiers} tiers · ${world.divisions} divisions · ${world.clubs} clubs`);
  console.log(`  schedule      : Premier ${sched.matchdays.length} match-days, ${sched.matchdays[0].length} games/day; day-0 live/resolved ${liveDay} ${liveDay > 0 ? '✓' : '✗'}`);

  // ── 1. mid-broadcast: the result is SEALED ───────────────────────────────
  const during = await get(fxUrl);
  console.log(`  during window : status=${during.status} score=${during.score ? during.score.join('–') : 'SEALED'} snapshot=${during.snapshot ? 'present' : 'hidden'}`);
  const replay425 = await fetch(`${fxUrl}/replay`);
  console.log(`  replay (early): HTTP ${replay425.status} ${replay425.status === 425 ? '(too early ✓)' : '(LEAK ✗)'}`);

  // ── 2. watch the synced live match-center tick the score up ──────────────
  console.log(`\n  live match-center (SSE /live/${SEASON}/${DAY}) — running score from completed rounds:`);
  let lastScore = '';
  await sse(`${srv.url}/live/${SEASON}/${DAY}`, (f) => {
    const top = f.fixtures[0];
    const s = `${top.running[0]}–${top.running[1]}`;
    const tag = `${s} (rd ${top.round}, ${(top.frac * 100).toFixed(0)}%, ${top.status})`;
    if (tag !== lastScore) { console.log(`     ${tag}`); lastScore = tag; }
  });

  // ── 3. after reveal: score + snapshot are PUBLIC, replay works ────────────
  const after = await get(fxUrl);
  const replay = await fetch(`${fxUrl}/replay`);
  const rbody = replay.status === 200 ? await replay.json() : null;
  console.log(`\n  after reveal  : status=${after.status} score=${after.score ? after.score.join('–') : 'MISSING'} snapshot=${after.snapshot ? 'present' : 'MISSING'}`);
  console.log(`  replay (late) : HTTP ${replay.status} snapshot=${rbody?.snapshot ? 'present ✓' : 'MISSING ✗'} score ${rbody?.score?.join('–') ?? '—'}`);

  // standings move only AFTER the broadcast resolves (embargo-aware derivation)
  const standAfter = await get(`${srv.url}/standings/${SEASON}/0/0`);
  const playedAfter = standAfter.table.reduce((n: number, r: any) => n + r.played, 0);
  console.log(`  standings     : after reveal → ${playedAfter} games played in the table ${playedAfter > 0 ? '(table moves ✓)' : '(STUCK ✗)'}`);

  const sealed = !during.score && !during.snapshot && replay425.status === 425;
  const released = !!after.score && !!after.snapshot && replay.status === 200;
  console.log(`\n  embargo holds : sealed during → ${sealed ? '✓' : '✗'} · released at reveal → ${released ? '✓' : '✗'}`);
  void health;

  await srv.close();
  console.log(`  server closed.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
