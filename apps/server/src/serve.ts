// `pnpm run server:serve` — boot the live-broadcast server and KEEP it running (vs
// http-demo.ts which acts as a client and exits). This is what the web app's Match
// Center connects to, and it doubles as the PRODUCTION entrypoint: environment
// variables select the durable stores and the server RESUMES an existing world
// instead of seeding a fresh one (the restart-resume property the deploy relies on).
//
// Flags (dev):                          Env (production):
//   --seed N       world seed (7)         PORT             listen port
//   --broadcast S  live window (600s)     ACE_SEED         world seed (fresh worlds only)
//   --port N       listen port (8787)     ACE_BROADCAST    live window seconds
//   --auto SECS    auto-advance cadence   ACE_AUTO         auto-advance cadence (the tick worker)
//                                         ACE_JWT_SECRET   STABLE token secret (sessions survive restarts)
//                                         STRIPE_WEBHOOK_SECRET  arms /billing/webhook (VIP source of truth)
//                                         DATABASE_URL     Postgres → PgStore/PgAccountStore (durable
//                                                          world + accounts; requires `pg` installed —
//                                                          the one optional dependency, loaded dynamically)
import { startLiveServer, type LiveServerOpts } from './http.js';
import { PgStore, PgAccountStore } from './pg.js';
import { googleProvider, discordProvider, type OAuthProvider } from './oauth.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: number) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : d; };
const env = (n: string) => process.env[n];

// THE WORLD CLOCK IS SERVER-OWNED: match-days resolve on the scheduled tick,
// never on a user's click. Default cadence 900s (a match-day every 15 min);
// `--auto 0` freezes the clock, which only makes sense with the dev opt-in
// below. `POST /advance` is refused unless ACE_DEV_ADVANCE=1 / --dev-advance
// (local development + the verification suites), so no deployment can ship a
// user-advanceable shared world by accident.
const devAdvance = argv.includes('--dev-advance') || env('ACE_DEV_ADVANCE') === '1';
const auto = flag('auto', Number(env('ACE_AUTO') ?? (devAdvance ? 0 : 900)));
const opts: LiveServerOpts = {
  seed: flag('seed', Number(env('ACE_SEED') ?? 7)),
  broadcastSecs: flag('broadcast', Number(env('ACE_BROADCAST') ?? 600)),
  port: flag('port', Number(env('PORT') ?? 8787)),
  autoAdvanceSecs: auto,
  allowManualAdvance: devAdvance,
  jwtSecret: env('ACE_JWT_SECRET'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  publicBase: env('ACE_PUBLIC_URL'),
};
// outbound mail: ACE_MAIL_WEBHOOK posts {to, subject, text} as JSON to any HTTP
// sender (a Resend/SES/worker endpoint — the fetch IS the mailer, zero-dep).
// Configured → verification/reset tokens are mailed, never surfaced in responses.
if (env('ACE_MAIL_WEBHOOK')) {
  const hook = env('ACE_MAIL_WEBHOOK')!;
  opts.mailer = async (to, subject, text) => {
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, text }) });
    if (!r.ok) throw new Error(`mail webhook ${r.status}`);
  };
  console.log('  outbound mail: webhook configured');
}
// social sign-in: any provider with an id+secret configured lights up its button
{
  const oauth: OAuthProvider[] = [];
  if (env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET')) oauth.push(googleProvider(env('GOOGLE_CLIENT_ID')!, env('GOOGLE_CLIENT_SECRET')!));
  if (env('DISCORD_CLIENT_ID') && env('DISCORD_CLIENT_SECRET')) oauth.push(discordProvider(env('DISCORD_CLIENT_ID')!, env('DISCORD_CLIENT_SECRET')!));
  if (oauth.length) { opts.oauth = oauth; console.log(`  social sign-in: ${oauth.map(o => o.label).join(' + ')}`); }
}
if (!auto && !devAdvance) console.warn('  ⚠ world clock FROZEN: no scheduler (--auto 0) and no --dev-advance — nothing can advance a match-day.');

// DATABASE_URL → the durable Pg stores. `pg` is deliberately NOT a dependency of
// this zero-dep slice (PgStore takes an injected Queryable); a deployment that
// wants Postgres installs `pg` and this dynamic import picks it up.
if (env('DATABASE_URL')) {
  try {
    const { Pool } = await import('pg' as string) as { Pool: new (o: { connectionString: string }) => { query(q: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } };
    const pool = new Pool({ connectionString: env('DATABASE_URL')! });
    opts.store = new PgStore(pool);
    opts.accounts = new PgAccountStore(pool);
    console.log('  durable stores: Postgres (DATABASE_URL) — the world resumes across restarts');
  } catch {
    console.error('DATABASE_URL is set but the `pg` package is not installed — `pnpm add pg` in the deployment, or unset DATABASE_URL for in-memory.');
    process.exit(1);
  }
}
if (env('DATABASE_URL') && !env('ACE_JWT_SECRET')) {
  console.warn('  ⚠ DATABASE_URL without ACE_JWT_SECRET: accounts persist but tokens die each restart — set a stable secret.');
}

const srv = await startLiveServer(opts);
const health = await (await fetch(`${srv.url}/health`)).json() as { revealAt: number; broadcastDay: number };
const revealIn = Math.round(health.revealAt - Date.now() / 1000);
console.log(`\n  ACE live server · ${srv.url} · world ${srv.id}`);
console.log(revealIn > 0
  ? `  match-day ${health.broadcastDay + 1} live now — reveals in ~${revealIn}s. Point the web Match Center here.`
  : `  resumed at match-day ${health.broadcastDay + 1} (history revealed). Point the web Match Center here.`);
if (opts.autoAdvanceSecs) console.log(`  ⏱ scheduled tick worker ON — a match-day every ${opts.autoAdvanceSecs}s (the server owns the clock; the BullMQ job's contract).`);
if (devAdvance) console.log('  ⚠ DEV MODE: manual POST /advance enabled — never run production with this flag.');
console.log('');
console.log(`  GET /world · /standings/1/0/0 · /schedule/0/0 · /live/1/0 (SSE) · /fixtures/1/0/:slot[/replay]\n`);

process.on('SIGINT', async () => { await srv.close(); process.exit(0); });
process.on('SIGTERM', async () => { await srv.close(); process.exit(0); });
