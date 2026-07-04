// The account + refresh-token persistence boundary (docs/PHASE2.md §5: the `account`
// and `refresh_token` tables). Mirrors the world `WorldStore` pattern — an interface
// the auth service runs against, with a `MemoryAccountStore` for headless runs; a
// `PgAccountStore` (same interface) is the mechanical follow-up. Accounts span worlds
// (one login, many shards), so this is separate from the per-world `WorldStore`.
import { hashPassword, verifyPassword, signToken, verifyToken, newRefreshToken, tokenHash } from './auth.js';

/** A register result — the session plus the email-verification token. In production
 *  the token is emailed (never returned); this slice surfaces it as `verifyToken` so
 *  the dev flow + headless tests can complete verification without a mail server. */
export interface RegisterResult extends Session { verifyToken: string }

export interface Account { id: string; email: string; passwordHash: string; createdAt: number; verified: boolean; verifyToken: string | null; vipUntil: number | null }
export interface RefreshRow { accountId: string; tokenHash: string; expiresAt: number; revoked: boolean }

/** **Async** so a `PgAccountStore` fits the same interface (the `MemoryAccountStore`
 *  resolves immediately). Accounts span worlds, so this is separate from `WorldStore`. */
export interface AccountStore {
  create(email: string, passwordHash: string, now: number, verifyToken: string): Promise<Account>;   // throws if email taken; starts unverified
  byEmail(email: string): Promise<Account | undefined>;
  byId(id: string): Promise<Account | undefined>;
  /** The account holding a pending email-verification token (or undefined). */
  byVerifyToken(token: string): Promise<Account | undefined>;
  /** Mark an account email-verified and clear its pending token. */
  markVerified(accountId: string): Promise<void>;
  /** Set the VIP horizon (epoch seconds; null clears). The Stripe webhook is the
   *  source of truth — this is only ever called from billing (DESIGN §8.4). */
  setVip(accountId: string, vipUntil: number | null): Promise<void>;
  saveRefresh(accountId: string, hash: string, expiresAt: number): Promise<void>;
  /** The live row for a refresh-token hash (or undefined) — for verify + rotation. */
  refresh(hash: string): Promise<RefreshRow | undefined>;
  revokeRefresh(hash: string): Promise<void>;
}

export class MemoryAccountStore implements AccountStore {
  private accounts = new Map<string, Account>();   // id → account
  private byEmailIdx = new Map<string, string>();  // email → id
  private refreshes = new Map<string, RefreshRow>();
  private n = 0;

  async create(email: string, passwordHash: string, now: number, verifyToken: string): Promise<Account> {
    const norm = email.trim().toLowerCase();
    if (this.byEmailIdx.has(norm)) throw new Error('email already registered');
    const acc: Account = { id: `acct-${++this.n}`, email: norm, passwordHash, createdAt: now, verified: false, verifyToken, vipUntil: null };
    this.accounts.set(acc.id, acc);
    this.byEmailIdx.set(norm, acc.id);
    return acc;
  }
  async byEmail(email: string): Promise<Account | undefined> { const id = this.byEmailIdx.get(email.trim().toLowerCase()); return id ? this.accounts.get(id) : undefined; }
  async byId(id: string): Promise<Account | undefined> { return this.accounts.get(id); }
  async byVerifyToken(token: string): Promise<Account | undefined> { for (const a of this.accounts.values()) if (a.verifyToken && a.verifyToken === token) return a; return undefined; }
  async markVerified(accountId: string): Promise<void> { const a = this.accounts.get(accountId); if (a) this.accounts.set(accountId, { ...a, verified: true, verifyToken: null }); }
  async setVip(accountId: string, vipUntil: number | null): Promise<void> { const a = this.accounts.get(accountId); if (a) this.accounts.set(accountId, { ...a, vipUntil }); }
  async saveRefresh(accountId: string, hash: string, expiresAt: number): Promise<void> { this.refreshes.set(hash, { accountId, tokenHash: hash, expiresAt, revoked: false }); }
  async refresh(hash: string): Promise<RefreshRow | undefined> { return this.refreshes.get(hash); }
  async revokeRefresh(hash: string): Promise<void> { const r = this.refreshes.get(hash); if (r) this.refreshes.set(hash, { ...r, revoked: true }); }
}

export const ACCESS_TTL = 15 * 60;            // 15 min access token
export const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 day refresh token

export interface Session { accountId: string; accessToken: string; refreshToken: string }

/** Register / login / refresh / verify over an `AccountStore`. The access token is a
 *  short-lived HS256 JWT; the refresh token is an opaque rotating secret stored
 *  hashed. `clock` is injectable so expiry is deterministic in tests. */
export class AuthService {
  constructor(private store: AccountStore, private secret: string, private clock: () => number = () => Date.now() / 1000) {}

  private async issue(accountId: string): Promise<Session> {
    const now = Math.floor(this.clock());
    const accessToken = signToken(accountId, this.secret, ACCESS_TTL, now);
    const refreshToken = newRefreshToken();
    await this.store.saveRefresh(accountId, tokenHash(refreshToken), now + REFRESH_TTL);
    return { accountId, accessToken, refreshToken };
  }

  async register(email: string, password: string): Promise<RegisterResult> {
    if (!email?.includes('@') || !password || password.length < 8) throw new Error('a valid email and an 8+ char password are required');
    const verifyToken = newRefreshToken();   // opaque, single-use; emailed in prod, surfaced here for the dev flow
    const acc = await this.store.create(email, hashPassword(password), Math.floor(this.clock()), verifyToken);
    return { ...(await this.issue(acc.id)), verifyToken };
  }
  /** Complete email verification with the token from the (emailed) link. Single-use:
   *  the token is cleared on success. Returns the account id, or null if invalid. */
  async verifyEmail(token: string): Promise<string | null> {
    const acc = await this.store.byVerifyToken(token ?? '');
    if (!acc) return null;
    await this.store.markVerified(acc.id);
    return acc.id;
  }
  /** Is this account email-verified? (gates club ownership.) */
  async isVerified(accountId: string): Promise<boolean> {
    return (await this.store.byId(accountId))?.verified ?? false;
  }
  async login(email: string, password: string): Promise<Session> {
    const acc = await this.store.byEmail(email ?? '');
    if (!acc || !verifyPassword(password ?? '', acc.passwordHash)) throw new Error('invalid email or password');
    return this.issue(acc.id);
  }
  /** Rotate a refresh token: the presented one is revoked and a fresh pair issued
   *  (so a stolen-then-used token is detectable and single-use). */
  async refresh(refreshToken: string): Promise<Session> {
    const hash = tokenHash(refreshToken ?? '');
    const row = await this.store.refresh(hash);
    if (!row || row.revoked || Math.floor(this.clock()) > row.expiresAt) throw new Error('invalid or expired refresh token');
    await this.store.revokeRefresh(hash);
    return this.issue(row.accountId);
  }
  /** The account id behind a bearer access token, or null (verify is pure — no store). */
  verify(accessToken: string): string | null {
    return verifyToken(accessToken, this.secret, Math.floor(this.clock()))?.sub ?? null;
  }
}
