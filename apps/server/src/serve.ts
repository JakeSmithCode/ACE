// `pnpm run server:serve` — boot the live-broadcast server and KEEP it running (vs
// http-demo.ts which acts as a client and exits). This is what the web app's Match
// Center connects to: a real world ticked day 0 with the Premier full-simmed and a
// live broadcast window, served over HTTP+SSE with the result embargo. Flags:
//   --seed N         world seed (default 7)
//   --broadcast SECS live window length (default 600 — long enough to watch live)
//   --port N         listen port (default 8787)
//   --auto SECS      auto-advance a match-day every N seconds (the scheduled tick
//                    worker — the production "matches resolve on a schedule" behaviour;
//                    0/unset = manual /advance only)
import { startLiveServer } from './http.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: number) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : d; };

const autoAdvanceSecs = flag('auto', 0);
const srv = await startLiveServer({ seed: flag('seed', 7), broadcastSecs: flag('broadcast', 600), port: flag('port', 8787), autoAdvanceSecs });
const revealIn = Math.round((await (await fetch(`${srv.url}/health`)).json()).revealAt - Date.now() / 1000);
console.log(`\n  ACE live server · ${srv.url} · world ${srv.id}`);
console.log(`  Premier match-day live now — reveals in ~${revealIn}s. Point the web Match Center here.`);
if (autoAdvanceSecs) console.log(`  ⏱ scheduled tick worker ON — auto-advancing a match-day every ${autoAdvanceSecs}s (the BullMQ job's contract).`);
console.log('');
console.log(`  GET /world · /standings/1/0/0 · /schedule/0/0 · /live/1/0 (SSE) · /fixtures/1/0/:slot[/replay]\n`);

process.on('SIGINT', async () => { await srv.close(); process.exit(0); });
process.on('SIGTERM', async () => { await srv.close(); process.exit(0); });
