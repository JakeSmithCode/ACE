// The account + refresh-token persistence boundary (docs/PHASE2.md §5: the `account`
// and `refresh_token` tables). Mirrors the world `WorldStore` pattern — an interface
// the auth service runs against, with a `MemoryAccountStore` for headless runs; a
// `PgAccountStore` (same interface) is the mechanical follow-up. Accounts span worlds
// (one login, many shards), so this is separate from the per-world `WorldStore`.
import { hashPassword, verifyPassword, signToken, verifyToken, newRefreshToken, tokenHash } from './auth.js';

export interface Account { id: string; email: string; passwordHash: string; createdAt: number }
export interface RefreshRow { accountId: string; tokenHash: string; expiresAt: number; revoked: boolean }

export interface AccountStore {
  create(email: string, passwordHash: string, now: number): Account;   // throws if email taken
  byEmail(email: string): Account | undefined;
  byId(id: string): Account | undefined;
  saveRefresh(accountId: string, hash: string, expiresAt: number): void;
  /** The live row for a refresh-token hash (or undefined) — for verify + rotation. */
  refresh(hash: string): RefreshRow | undefined;
  revokeRefresh(hash: string): void;
}

export class MemoryAccountStore implements AccountStore {
  private accounts = new Map<string, Account>();   // id → account
  private byEmailIdx = new Map<string, string>();  // email → id
  private refreshes = new Map<string, RefreshRow>();
  private n = 0;

  create(email: string, passwordHash: string, now: number): Account {
    const norm = email.trim().toLowerCase();
    if (this.byEmailIdx.has(norm)) throw new Error('email already registered');
    const acc: Account = { id: `acct-${++this.n}`, email: norm, passwordHash, createdAt: now };
    this.accounts.set(acc.id, acc);
    this.byEmailIdx.set(norm, acc.id);
    return acc;
  }
  byEmail(email: string): Account | undefined { const id = this.byEmailIdx.get(email.trim().toLowerCase()); return id ? this.accounts.get(id) : undefined; }
  byId(id: string): Account | undefined { return this.accounts.get(id); }
  saveRefresh(accountId: string, hash: string, expiresAt: number): void { this.refreshes.set(hash, { accountId, tokenHash: hash, expiresAt, revoked: false }); }
  refresh(hash: string): RefreshRow | undefined { return this.refreshes.get(hash); }
  revokeRefresh(hash: string): void { const r = this.refreshes.get(hash); if (r) this.refreshes.set(hash, { ...r, revoked: true }); }
}

export const ACCESS_TTL = 15 * 60;            // 15 min access token
export const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 day refresh token

export interface Session { accountId: string; accessToken: string; refreshToken: string }

/** Register / login / refresh / verify over an `AccountStore`. The access token is a
 *  short-lived HS256 JWT; the refresh token is an opaque rotating secret stored
 *  hashed. `clock` is injectable so expiry is deterministic in tests. */
export class AuthService {
  constructor(private store: AccountStore, private secret: string, private clock: () => number = () => Date.now() / 1000) {}

  private issue(accountId: string): Session {
    const now = Math.floor(this.clock());
    const accessToken = signToken(accountId, this.secret, ACCESS_TTL, now);
    const refreshToken = newRefreshToken();
    this.store.saveRefresh(accountId, tokenHash(refreshToken), now + REFRESH_TTL);
    return { accountId, accessToken, refreshToken };
  }

  register(email: string, password: string): Session {
    if (!email?.includes('@') || !password || password.length < 8) throw new Error('a valid email and an 8+ char password are required');
    const acc = this.store.create(email, hashPassword(password), Math.floor(this.clock()));
    return this.issue(acc.id);
  }
  login(email: string, password: string): Session {
    const acc = this.store.byEmail(email ?? '');
    if (!acc || !verifyPassword(password ?? '', acc.passwordHash)) throw new Error('invalid email or password');
    return this.issue(acc.id);
  }
  /** Rotate a refresh token: the presented one is revoked and a fresh pair issued
   *  (so a stolen-then-used token is detectable and single-use). */
  refresh(refreshToken: string): Session {
    const hash = tokenHash(refreshToken ?? '');
    const row = this.store.refresh(hash);
    if (!row || row.revoked || Math.floor(this.clock()) > row.expiresAt) throw new Error('invalid or expired refresh token');
    this.store.revokeRefresh(hash);
    return this.issue(row.accountId);
  }
  /** The account id behind a bearer access token, or null. */
  verify(accessToken: string): string | null {
    return verifyToken(accessToken, this.secret, Math.floor(this.clock()))?.sub ?? null;
  }
}
