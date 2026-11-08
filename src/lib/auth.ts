import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const KEYLEN = 64;
const MAX_SCRYPT_N = 1 << 20;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;

export class AuthConfigError extends Error {}

export type UserMap = ReadonlyMap<string, string>;

/** Parses `user1:hash1,user2:hash2`. Hashes contain no ':' or ','. Malformed entries are skipped. */
export function parseUsers(raw: string | undefined): UserMap {
  const users = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const name = entry.slice(0, idx).trim();
    const hash = entry.slice(idx + 1).trim();
    if (name && hash) users.set(name, hash);
  }
  return users;
}

/** Fail closed: throws AuthConfigError when auth is not safely configured. */
export function loadAuthConfig(env: Record<string, string | undefined> = process.env): {
  users: UserMap;
  secret: string;
} {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError('SESSION_SECRET missing or shorter than 32 characters');
  }
  const users = parseUsers(env.APP_USERS);
  if (users.size === 0) throw new AuthConfigError('APP_USERS is empty');
  return { users, secret };
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [parts[1], parts[2], parts[3]].map((v) => (/^\d+$/.test(v ?? '') ? Number(v) : NaN)) as [
    number,
    number,
    number,
  ];
  if (![N, r, p].every(Number.isSafeInteger)) return null;
  if (N < 2 || (N & (N - 1)) !== 0 || N > MAX_SCRYPT_N) return null;
  if (r < 1 || r > MAX_SCRYPT_R || p < 1 || p > MAX_SCRYPT_P) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const hash = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || hash.length !== KEYLEN) return null;
  return { N, r, p, salt, hash };
}

const DUMMY_SALT = Buffer.alloc(16, 1);

function dummyScrypt(password: string): void {
  scryptSync(password, DUMMY_SALT, KEYLEN, { N: 16384, r: 8, p: 1 });
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const parsed = stored === undefined ? null : parseHash(stored);
  if (!parsed) {
    dummyScrypt(password); // keep timing similar for unknown user / malformed hash
    return false;
  }
  const { N, r, p, salt, hash } = parsed;
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, hash.length, { N, r, p, maxmem: 256 * N * r });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, hash);
}

/** Returns the username when credentials are valid, otherwise null. */
export function authenticate(users: UserMap, username: string, password: string): string | null {
  const ok = verifyPassword(password, users.get(username));
  return ok ? username : null;
}

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function createSessionToken(
  username: string,
  secret: string,
  now: number = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

/** Returns the username for a valid, unexpired token; otherwise null. */
export function verifySessionToken(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): string | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const given = Buffer.from(sig, 'base64url');
  const expected = sign(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data !== 'object' || data === null) return null;
    const { u, exp } = data as { u?: unknown; exp?: unknown };
    if (typeof u !== 'string' || !u || typeof exp !== 'number') return null;
    if (exp <= Math.floor(now / 1000)) return null;
    return u;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(secure: boolean, maxAge: number = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

/** Secure everywhere except local dev over plain http. */
export function isSecureRequest(url: URL): boolean {
  return url.protocol === 'https:' || !(import.meta.env?.DEV ?? false);
}

/** Only same-origin relative paths: starts with '/', not '//' or '/\'. */
export function sanitizeNext(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  return next;
}
