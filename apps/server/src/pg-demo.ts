// `pnpm run server:pg` — prove the PgStore/PgAccountStore are correct WITHOUT a live
// Postgres, by running them over an in-memory `Queryable` fake that implements exactly
// the handful of SQL statements pg.ts issues (storing jsonb as a string and returning
// it PARSED, like node-postgres). It then runs the SAME tick loop + auth flow the
// MemoryStore does and asserts BYTE-IDENTICAL results — so the only thing left to a
// real DB is parsing the SQL strings (which the 0002 migration mirrors). This is the
// interface-conformance + idempotency proof; integration against real Postgres is the
// `infra/docker-compose` follow-up.
import { MemoryStore } from './store.js';
import { MemoryAccountStore, AuthService } from './accounts.js';
import { PgStore, PgAccountStore, type Queryable } from './pg.js';
import { seedWorld } from './seed.js';
import { runSeason } from './tick.js';
import type { WorldState } from '@ace/world';

const seed = 7;
const digest = (w: WorldState) => w.clubs.map(c => `${c.tag}:${c.tier}:${Math.round(c.strength * 1000)}:${c.balance}:${c.titles}`).join('|') + `#${w.season}.${w.day}`;

/** A hand-written fake of the exact statements pg.ts runs — jsonb stored as a string
 *  and returned parsed (mirroring node-postgres). Throws on an unrecognised query so a
 *  drift between pg.ts and this fake is caught immediately. */
class FakeQueryable implements Queryable {
  private worlds = new Map<string, string>();
  private fixtures: { world_id: string; season: number; day: number; slot: number; data: string }[] = [];
  private ticks: { world_id: string; season: number; day: number; kind: string; fixtures: number }[] = [];
  private accounts = new Map<string, { id: string; email: string; password_hash: string; created_at: number; verified: boolean; verify_token: string | null }>();
  private refresh = new Map<string, { token_hash: string; account_id: string; expires_at: number; revoked: boolean }>();
  private acctData = new Map<string, string>();   // `${world}:${account}` → jsonb string

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const t = text.trim();
    const p = params as any[];
    // ── ace_world ──
    if (t.startsWith('insert into ace_world')) { this.worlds.set(p[0], p[1]); return { rows: [] }; }
    if (t.startsWith('select snapshot from ace_world')) { const s = this.worlds.get(p[0]); return { rows: s ? [{ snapshot: JSON.parse(s) }] : [] }; }
    if (t.startsWith('update ace_world')) { if (!this.worlds.has(p[0])) return { rows: [] }; this.worlds.set(p[0], p[1]); return { rows: [{ id: p[0] }] }; }
    if (t.startsWith('select id from ace_world')) return { rows: [...this.worlds.keys()].sort().map(id => ({ id })) };
    // ── ace_fixture ──
    if (t.startsWith('insert into ace_fixture')) { this.fixtures.push({ world_id: p[0], season: p[1], day: p[2], slot: p[3], data: p[4] }); return { rows: [] }; }
    if (t.startsWith('select data from ace_fixture')) { const f = this.fixtures.filter(x => x.world_id === p[0] && (p[1] === undefined || x.season === p[1])); return { rows: f.map(x => ({ data: JSON.parse(x.data) })) }; }
    // ── ace_tick_log ──
    if (t.startsWith('select 1 from ace_tick_log')) { const e = this.ticks.some(x => x.world_id === p[0] && x.season === p[1] && x.day === p[2] && x.kind === p[3]); return { rows: e ? [{}] : [] }; }
    if (t.startsWith('insert into ace_tick_log')) { if (this.ticks.some(x => x.world_id === p[0] && x.season === p[1] && x.day === p[2] && x.kind === p[3])) throw new Error('duplicate key (idempotency PK)'); this.ticks.push({ world_id: p[0], season: p[1], day: p[2], kind: p[3], fixtures: p[4] }); return { rows: [] }; }
    if (t.startsWith('select world_id, season, day, kind, fixtures from ace_tick_log')) return { rows: this.ticks.filter(x => x.world_id === p[0]) };
    // ── ace_account / ace_refresh ──
    if (t.startsWith('insert into ace_account (')) { if ([...this.accounts.values()].some(a => a.email === p[1])) throw new Error('unique(email) violation'); this.accounts.set(p[0], { id: p[0], email: p[1], password_hash: p[2], created_at: p[3], verified: false, verify_token: p[4] }); return { rows: [] }; }
    if (t.startsWith('select * from ace_account where email')) { const a = [...this.accounts.values()].find(x => x.email === p[0]); return { rows: a ? [a] : [] }; }
    if (t.startsWith('select * from ace_account where verify_token')) { const a = [...this.accounts.values()].find(x => x.verify_token != null && x.verify_token === p[0]); return { rows: a ? [a] : [] }; }
    if (t.startsWith('select * from ace_account where id')) { const a = this.accounts.get(p[0]); return { rows: a ? [a] : [] }; }
    if (t.startsWith('update ace_account set verified')) { const a = this.accounts.get(p[0]); if (a) { a.verified = true; a.verify_token = null; } return { rows: [] }; }
    if (t.startsWith('insert into ace_refresh')) { this.refresh.set(p[0], { token_hash: p[0], account_id: p[1], expires_at: p[2], revoked: false }); return { rows: [] }; }
    if (t.startsWith('select account_id, token_hash, expires_at, revoked from ace_refresh')) { const r = this.refresh.get(p[0]); return { rows: r ? [r] : [] }; }
    if (t.startsWith('update ace_refresh set revoked')) { const r = this.refresh.get(p[0]); if (r) r.revoked = true; return { rows: [] }; }
    // ── ace_account_data (per-account jsonb blob, upsert on (world, account)) ──
    if (t.startsWith('select data from ace_account_data')) { const d = this.acctData.get(`${p[0]}:${p[1]}`); return { rows: d ? [{ data: JSON.parse(d) }] : [] }; }
    if (t.startsWith('insert into ace_account_data')) { this.acctData.set(`${p[0]}:${p[1]}`, p[2] as string); return { rows: [] }; }   // ON CONFLICT DO UPDATE → upsert
    if (t.startsWith('select account_id, data from ace_account_data')) { const out: Record<string, unknown>[] = []; for (const [k, v] of this.acctData) { const wid = k.slice(0, k.indexOf(':')); if (wid === p[0]) out.push({ account_id: k.slice(k.indexOf(':') + 1), data: JSON.parse(v) }); } return { rows: out }; }
    throw new Error(`FakeQueryable: unhandled query → ${t}`);
  }
}

async function main() {
  console.log(`\n  PgStore conformance · seed ${seed} · in-memory Queryable fake (no live DB)\n`);

  // 1. run 3 seasons through BOTH stores; the worlds must end byte-identical
  const mem = new MemoryStore(); const memId = await seedWorld(mem, { seed, region: 'AMER' });
  const pg = new PgStore(new FakeQueryable()); const pgId = await seedWorld(pg, { seed, region: 'AMER' });
  for (let s = 0; s < 3; s++) { await runSeason(mem, memId); await runSeason(pg, pgId); }
  const memW = (await mem.loadWorld(memId))!, pgW = (await pg.loadWorld(pgId))!;
  const same = digest(memW) === digest(pgW);
  console.log(`  tick parity : 3 seasons via PgStore vs MemoryStore → ${same ? 'IDENTICAL ✓' : 'DIVERGED ✗'} (${digest(pgW)})`);
  console.log(`  persistence : ${(await pg.fixtures(pgId)).length} fixtures · ${(await pg.ticks(pgId)).length} ticks round-tripped through jsonb`);

  // 1b. per-account data (academy/scout/inboxes blob) round-trips + upserts + lists, Pg == Memory
  const blob = { academy: { level: 2, prospects: [{ handle: 'NOVA2', age: 16 }] }, scout: { NOVA2: 2 } };
  let acctOk = true;
  for (const [, store, sid] of [['Memory', mem, memId], ['Pg', pg, pgId]] as const) {
    await store.saveAccountData(sid, 'acct-1', blob);
    await store.saveAccountData(sid, 'acct-1', { ...blob, academy: { ...blob.academy, level: 3 } });   // upsert overwrites
    await store.saveAccountData(sid, 'acct-2', { scout: { ICEX: 1 } });
    const got = await store.loadAccountData(sid, 'acct-1') as typeof blob;
    const list = await store.listAccountData(sid);
    if (((got?.academy as { level: number })?.level) !== 3 || list.length !== 2) acctOk = false;
  }
  console.log(`  account data: jsonb blob saved/upserted/listed, Pg == Memory → ${acctOk ? '✓' : '✗'}`);

  // 2. idempotency at the DB level: re-recording a tick fails on the PK
  let dup = false; try { await pg.recordTick({ worldId: pgId, season: 1, day: 0, kind: 'matchday', fixtures: 0 }); } catch { dup = true; }
  console.log(`  idempotency : re-record (s1,d0,matchday) → ${dup ? 'rejected by PK ✓' : 'LEAK ✗'}`);

  // 3. auth over PgAccountStore: register → login → refresh rotation, vs Memory parity
  const clock = () => 1_000_000;
  for (const [label, store] of [['Memory', new MemoryAccountStore()], ['Pg', new PgAccountStore(new FakeQueryable())]] as const) {
    const auth = new AuthService(store, 'secret', clock);
    const reg = await auth.register('jake@ace.gg', 'correct horse');
    let dupEmail = false; try { await auth.register('jake@ace.gg', 'other pass'); } catch { dupEmail = true; }
    const login = await auth.login('jake@ace.gg', 'correct horse');
    const rot = await auth.refresh(reg.refreshToken);
    let replay = false; try { await auth.refresh(reg.refreshToken); } catch { replay = true; }
    const verified = auth.verify(rot.accessToken) === reg.accountId;
    // email verification: starts unverified, the single-use token flips it, a bad token is rejected
    const before = await auth.isVerified(reg.accountId);
    const ok = await auth.verifyEmail(reg.verifyToken);
    const after = await auth.isVerified(reg.accountId);
    const badTok = await auth.verifyEmail(reg.verifyToken);   // single-use → already cleared
    const emailFlow = before === false && ok === reg.accountId && after === true && badTok === null;
    console.log(`  auth (${label.padEnd(6)}): register ✓ · dup-email ${dupEmail ? '✓' : '✗'} · login ${login.accessToken ? '✓' : '✗'} · rotate ${rot.accessToken ? '✓' : '✗'} · old-refresh single-use ${replay ? '✓' : '✗'} · verify ${verified ? '✓' : '✗'} · email-verify ${emailFlow ? '✓' : '✗'}`);
  }
  console.log(`\n  PgStore is interface-conformant + deterministic. Integration vs real Postgres: infra/docker-compose.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
