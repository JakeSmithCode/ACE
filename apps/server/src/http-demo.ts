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

  const sealed = !during.score && !during.snapshot && replay425.status === 425;
  const released = !!after.score && !!after.snapshot && replay.status === 200;
  console.log(`\n  embargo holds : sealed during → ${sealed ? '✓' : '✗'} · released at reveal → ${released ? '✓' : '✗'}`);
  void health;

  await srv.close();
  console.log(`  server closed.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
