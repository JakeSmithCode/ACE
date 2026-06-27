// Self-owned auth (docs/PHASE2.md §5/§9, DESIGN §16 "our own tables, never a
// vendor"). Zero-dep on purpose — node's crypto gives us a strong KDF (scrypt) and
// an HS256 JWT in ~40 lines, matching the rest of this slice (the NestJS version
// swaps in argon2id/passport but exposes the same tokens). Password hashing uses a
// random salt — that randomness is auth, NOT the sim, so engine/world determinism is
// untouched. The `now` clock is injectable so token expiry is testable/deterministic.
import { createHmac, timingSafeEqual, randomBytes, scryptSync, createHash } from 'node:crypto';

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const KDF_LEN = 32;

/** scrypt password hash, self-describing as `salt:hash` (hex). */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, KDF_LEN).toString('hex')}`;
}
/** Constant-time verify against a `salt:hash` string. */
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = scryptSync(pw, Buffer.from(saltHex, 'hex'), KDF_LEN);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** sha256 hex — refresh tokens are stored hashed (a DB leak doesn't grant sessions). */
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface TokenClaims { sub: string; iat: number; exp: number }

/** Mint an HS256 JWT for `sub` (the account id), expiring `ttlSec` after `now`. */
export function signToken(sub: string, secret: string, ttlSec: number, now: number): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ sub, iat: now, exp: now + ttlSec }));
  const data = `${head}.${body}`;
  return `${data}.${b64url(createHmac('sha256', secret).update(data).digest())}`;
}
/** Verify signature + expiry; returns the claims or null (never throws). */
export function verifyToken(token: string, secret: string, now: number): TokenClaims | null {
  const p = token.split('.');
  if (p.length !== 3) return null;
  const want = Buffer.from(b64url(createHmac('sha256', secret).update(`${p[0]}.${p[1]}`).digest()));
  const got = Buffer.from(p[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const body = JSON.parse(Buffer.from(p[1], 'base64url').toString()) as TokenClaims;
    return body.exp && now > body.exp ? null : body;
  } catch { return null; }
}

/** An opaque refresh token (rotated on use). Random, never derived from the access
 *  token, so leaking one doesn't grant the other. */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');
