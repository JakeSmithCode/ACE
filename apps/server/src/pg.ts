// Postgres-backed stores (docs/PHASE2.md §5, build step 2). They implement the SAME
// async `WorldStore` / `AccountStore` interfaces the `MemoryStore` does — so swapping
// them in changes NO resolution code (the tick worker + HTTP layer already await every
// call). Zero-dep on purpose: they run over a minimal `Queryable` (which `pg.Pool`
// satisfies), so a deployment passes `new Pool(...)` and nothing here imports `pg`.
//
// Storage model: the WorldState value object is stored verbatim as `jsonb` (§5 — "jsonb
// holds the sim's value objects"), with fixtures + the tick-log as their own rows for
// the queryable record + DB-enforced idempotency. The SQL matches
// `infra/migrations/0002_worldstore.sql`. NOTE: not yet run against a live database in
// CI — `infra/docker-compose` spins one up to integration-test.
import { randomUUID } from 'node:crypto';
import type { WorldState } from '@ace/world';
import type { WorldStore, FixtureRow, TickRow, TickKind } from './store.js';
import type { AccountStore, Account, RefreshRow } from './accounts.js';

/** The minimal query surface both stores need — exactly what `pg.Pool`/`Client`
 *  expose, so no dependency on the `pg` package is taken here. */
export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

/** A `WorldStore` over Postgres. The WorldState is one `jsonb` blob; fixtures and the
 *  tick-log are rows (the latter's PK is the idempotency key — a duplicate tick errors
 *  at the DB). node-postgres parses `jsonb` back to objects, so reads need no JSON.parse. */
export class PgStore implements WorldStore {
  constructor(private db: Queryable) {}

  async createWorld(w: WorldState): Promise<string> {
    const id = `world-${randomUUID()}`;
    await this.db.query('insert into ace_world (id, snapshot) values ($1, $2)', [id, JSON.stringify(w)]);
    return id;
  }
  async loadWorld(id: string): Promise<WorldState | null> {
    const { rows } = await this.db.query('select snapshot from ace_world where id = $1', [id]);
    return rows[0] ? (rows[0].snapshot as WorldState) : null;
  }
  async saveWorld(id: string, w: WorldState): Promise<void> {
    const { rows } = await this.db.query('update ace_world set snapshot = $2 where id = $1 returning id', [id, JSON.stringify(w)]);
    if (!rows[0]) throw new Error(`saveWorld: unknown world ${id}`);
  }
  async listWorlds(): Promise<string[]> {
    const { rows } = await this.db.query('select id from ace_world order by id');
    return rows.map(r => r.id as string);
  }

  async appendFixtures(id: string, fixtures: FixtureRow[]): Promise<void> {
    for (const r of fixtures) {
      await this.db.query('insert into ace_fixture (world_id, season, day, slot, data) values ($1, $2, $3, $4, $5)', [id, r.season, r.day, r.slot, JSON.stringify(r)]);
    }
  }
  async fixtures(id: string, season?: number): Promise<FixtureRow[]> {
    const { rows } = season == null
      ? await this.db.query('select data from ace_fixture where world_id = $1 order by id', [id])
      : await this.db.query('select data from ace_fixture where world_id = $1 and season = $2 order by id', [id, season]);
    return rows.map(r => r.data as FixtureRow);
  }

  async tickDone(id: string, season: number, day: number, kind: TickKind): Promise<boolean> {
    const { rows } = await this.db.query('select 1 from ace_tick_log where world_id = $1 and season = $2 and day = $3 and kind = $4', [id, season, day, kind]);
    return rows.length > 0;
  }
  async recordTick(row: TickRow): Promise<void> {
    // the unique PK (world_id, season, day, kind) enforces idempotency at the DB level
    await this.db.query('insert into ace_tick_log (world_id, season, day, kind, fixtures) values ($1, $2, $3, $4, $5)', [row.worldId, row.season, row.day, row.kind, row.fixtures]);
  }
  async ticks(id: string): Promise<TickRow[]> {
    const { rows } = await this.db.query('select world_id, season, day, kind, fixtures from ace_tick_log where world_id = $1 order by season, day', [id]);
    return rows.map(r => ({ worldId: r.world_id as string, season: r.season as number, day: r.day as number, kind: r.kind as TickKind, fixtures: r.fixtures as number }));
  }

  async loadAccountData(id: string, account: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query('select data from ace_account_data where world_id = $1 and account_id = $2', [id, account]);
    return rows[0] ? (rows[0].data as Record<string, unknown>) : null;
  }
  async saveAccountData(id: string, account: string, data: Record<string, unknown>): Promise<void> {
    // upsert: one blob per (world, account) — re-saving overwrites (the PK is the key)
    await this.db.query(
      'insert into ace_account_data (world_id, account_id, data) values ($1, $2, $3) on conflict (world_id, account_id) do update set data = excluded.data',
      [id, account, JSON.stringify(data)],
    );
  }
  async listAccountData(id: string): Promise<{ account: string; data: Record<string, unknown> }[]> {
    const { rows } = await this.db.query('select account_id, data from ace_account_data where world_id = $1 order by account_id', [id]);
    return rows.map(r => ({ account: r.account_id as string, data: r.data as Record<string, unknown> }));
  }
}

/** An `AccountStore` over Postgres (accounts span worlds → its own tables). The email
 *  unique constraint enforces "one account per email"; refresh tokens are stored hashed
 *  and rotated (revoked) in place, matching the `MemoryAccountStore` semantics exactly. */
export class PgAccountStore implements AccountStore {
  constructor(private db: Queryable) {}
  private acc = (r: Record<string, unknown>): Account => ({ id: r.id as string, email: r.email as string, passwordHash: r.password_hash as string, createdAt: Number(r.created_at), verified: !!r.verified, verifyToken: (r.verify_token as string | null) ?? null, vipUntil: r.vip_until == null ? null : Number(r.vip_until) });

  async create(email: string, passwordHash: string, now: number, verifyToken: string): Promise<Account> {
    const id = `acct-${randomUUID()}`;
    const norm = email.trim().toLowerCase();
    try {
      await this.db.query('insert into ace_account (id, email, password_hash, created_at, verified, verify_token) values ($1, $2, $3, $4, false, $5)', [id, norm, passwordHash, now, verifyToken]);
    } catch { throw new Error('email already registered'); }   // unique(email) violation
    return { id, email: norm, passwordHash, createdAt: now, verified: false, verifyToken, vipUntil: null };
  }
  async byEmail(email: string): Promise<Account | undefined> {
    const { rows } = await this.db.query('select * from ace_account where email = $1', [email.trim().toLowerCase()]);
    return rows[0] ? this.acc(rows[0]) : undefined;
  }
  async byId(id: string): Promise<Account | undefined> {
    const { rows } = await this.db.query('select * from ace_account where id = $1', [id]);
    return rows[0] ? this.acc(rows[0]) : undefined;
  }
  async byVerifyToken(token: string): Promise<Account | undefined> {
    const { rows } = await this.db.query('select * from ace_account where verify_token = $1', [token]);
    return rows[0] ? this.acc(rows[0]) : undefined;
  }
  async markVerified(accountId: string): Promise<void> {
    await this.db.query('update ace_account set verified = true, verify_token = null where id = $1', [accountId]);
  }
  async setVip(accountId: string, vipUntil: number | null): Promise<void> {
    await this.db.query('update ace_account set vip_until = $2 where id = $1', [accountId, vipUntil]);
  }
  async saveRefresh(accountId: string, hash: string, expiresAt: number): Promise<void> {
    await this.db.query('insert into ace_refresh (token_hash, account_id, expires_at, revoked) values ($1, $2, $3, false)', [hash, accountId, expiresAt]);
  }
  async refresh(hash: string): Promise<RefreshRow | undefined> {
    const { rows } = await this.db.query('select account_id, token_hash, expires_at, revoked from ace_refresh where token_hash = $1', [hash]);
    const r = rows[0];
    return r ? { accountId: r.account_id as string, tokenHash: r.token_hash as string, expiresAt: Number(r.expires_at), revoked: r.revoked as boolean } : undefined;
  }
  async revokeRefresh(hash: string): Promise<void> {
    await this.db.query('update ace_refresh set revoked = true where token_hash = $1', [hash]);
  }
  async byIdentity(provider: string, subject: string): Promise<Account | undefined> {
    const r = await this.db.query('select a.* from ace_account a join ace_oauth_identity i on i.account_id = a.id where i.provider = $1 and i.subject = $2', [provider, subject]);
    return r.rows[0] ? this.acc(r.rows[0]) : undefined;
  }
  async linkIdentity(provider: string, subject: string, accountId: string): Promise<void> {
    await this.db.query('insert into ace_oauth_identity (provider, subject, account_id) values ($1, $2, $3) on conflict (provider, subject) do update set account_id = $3', [provider, subject, accountId]);
  }
  async createVerified(email: string, now: number): Promise<Account> {
    const id = `acct-${randomUUID()}`;
    const norm = email.trim().toLowerCase();
    try {
      await this.db.query("insert into ace_account (id, email, password_hash, created_at, verified, verify_token) values ($1, $2, '', $3, true, null)", [id, norm, now]);
    } catch { throw new Error('email already registered'); }
    return { id, email: norm, passwordHash: '', createdAt: now, verified: true, verifyToken: null, vipUntil: null };
  }
  async saveReset(accountId: string, hash: string, expiresAt: number): Promise<void> {
    await this.db.query('insert into ace_reset (token_hash, account_id, expires_at, used) values ($1, $2, $3, false)', [hash, accountId, expiresAt]);
  }
  async resetRow(hash: string): Promise<{ accountId: string; expiresAt: number; used: boolean } | undefined> {
    const r = await this.db.query('select account_id, expires_at, used from ace_reset where token_hash = $1', [hash]);
    return r.rows[0] ? { accountId: r.rows[0].account_id as string, expiresAt: Number(r.rows[0].expires_at), used: !!r.rows[0].used } : undefined;
  }
  async consumeReset(hash: string): Promise<void> {
    await this.db.query('update ace_reset set used = true where token_hash = $1', [hash]);
  }
  async setPassword(accountId: string, passwordHash: string): Promise<void> {
    await this.db.query('update ace_account set password_hash = $1 where id = $2', [passwordHash, accountId]);
  }
  async revokeAllRefresh(accountId: string): Promise<void> {
    await this.db.query('update ace_refresh set revoked = true where account_id = $1', [accountId]);
  }
}
