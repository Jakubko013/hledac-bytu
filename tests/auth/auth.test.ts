import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  authenticate,
  createSessionToken,
  loadAuthConfig,
  parseUsers,
  sanitizeNext,
  verifyPassword,
  verifySessionToken,
} from '../../src/lib/auth';

// Same algorithm/format as scripts/hash-password.ts (N=16384 r=8 p=1, 64-byte key).
function makeHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const SECRET = 'x'.repeat(40);
const fixture = makeHash('correct horse');

describe('verifyPassword', () => {
  it('accepts correct and rejects wrong password', () => {
    expect(verifyPassword('correct horse', fixture)).toBe(true);
    expect(verifyPassword('wrong', fixture)).toBe(false);
  });
  it('rejects malformed hashes', () => {
    for (const bad of [
      '',
      'nope',
      'scrypt$1$2',
      'bcrypt$16384$8$1$AA==$AA==',
      'scrypt$abc$8$1$AA==$AA==',
      'scrypt$16384$8$1$$',
      'scrypt$16383$8$1$AA==$AA==',
      'scrypt$16384$8$1$AA==$AA==',
    ]) {
      expect(verifyPassword('x', bad)).toBe(false);
    }
  });
  it('rejects unknown user', () => {
    expect(verifyPassword('x', undefined)).toBe(false);
    const users = parseUsers(`bob:${fixture}`);
    expect(authenticate(users, 'bob', 'correct horse')).toBe('bob');
    expect(authenticate(users, 'bob', 'bad')).toBeNull();
    expect(authenticate(users, 'eve', 'correct horse')).toBeNull();
  });
});

describe('session token', () => {
  it('round-trips', () => {
    expect(verifySessionToken(createSessionToken('bob', SECRET), SECRET)).toBe('bob');
  });
  it('rejects wrong secret', () => {
    expect(verifySessionToken(createSessionToken('bob', SECRET), 'y'.repeat(40))).toBeNull();
  });
  it('rejects tampered payload and signature', () => {
    const [p, s] = createSessionToken('bob', SECRET).split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: 9999999999 })).toString('base64url');
    expect(verifySessionToken(`${forged}.${s}`, SECRET)).toBeNull();
    expect(verifySessionToken(`${p}.${s.slice(0, -2)}AA`, SECRET)).toBeNull();
  });
  it('expires after 30 days', () => {
    const t0 = 1_700_000_000_000;
    const token = createSessionToken('bob', SECRET, t0);
    expect(verifySessionToken(token, SECRET, t0 + 29 * 86400_000)).toBe('bob');
    expect(verifySessionToken(token, SECRET, t0 + 30 * 86400_000)).toBeNull();
  });
  it('rejects malformed input', () => {
    for (const bad of [undefined, '', 'abc', 'a.b.c', '.', 'a.']) {
      expect(verifySessionToken(bad, SECRET)).toBeNull();
    }
  });
});

describe('parseUsers / config', () => {
  it('parses pairs and skips junk', () => {
    const m = parseUsers(`a:${fixture}, b:h2,,nocolon,:x,c:`);
    expect([...m.keys()]).toEqual(['a', 'b']);
    expect(m.get('a')).toBe(fixture);
  });
  it('handles undefined', () => {
    expect(parseUsers(undefined).size).toBe(0);
  });
  it('fails closed', () => {
    expect(() => loadAuthConfig({ SESSION_SECRET: 'short', APP_USERS: 'a:b' })).toThrow(AuthConfigError);
    expect(() => loadAuthConfig({ SESSION_SECRET: SECRET, APP_USERS: '' })).toThrow(AuthConfigError);
    expect(loadAuthConfig({ SESSION_SECRET: SECRET, APP_USERS: 'a:b' }).users.size).toBe(1);
  });
});

describe('sanitizeNext', () => {
  it('allows relative paths', () => {
    expect(sanitizeNext('/criteria?id=1')).toBe('/criteria?id=1');
  });
  it('blocks open redirects', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', '', undefined, 42, '/a\nb']) {
      expect(sanitizeNext(bad)).toBe('/');
    }
  });
});
