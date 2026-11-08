import { afterEach, describe, expect, it } from 'vitest';
import { getCrawlSecret, secretsMatch } from '../../src/lib/crawl-auth';
import { isInCooldown, MANUAL_RUN_COOLDOWN_MS } from '../../src/lib/run-cooldown';

const saved = { n: process.env.NETLIFY_DB_URL, d: process.env.DATABASE_URL };
afterEach(() => {
  for (const [k, v] of [['NETLIFY_DB_URL', saved.n], ['DATABASE_URL', saved.d]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('getCrawlSecret', () => {
  it('is deterministic hex and differs per DB URL', () => {
    delete process.env.DATABASE_URL;
    process.env.NETLIFY_DB_URL = 'postgres://a';
    const a1 = getCrawlSecret();
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(getCrawlSecret()).toBe(a1);
    process.env.NETLIFY_DB_URL = 'postgres://b';
    expect(getCrawlSecret()).not.toBe(a1);
    expect(secretsMatch(a1, getCrawlSecret())).toBe(false);
  });
  it('falls back to DATABASE_URL and throws without any', () => {
    delete process.env.NETLIFY_DB_URL;
    process.env.DATABASE_URL = 'postgres://c';
    expect(getCrawlSecret()).toMatch(/^[0-9a-f]{64}$/);
    delete process.env.DATABASE_URL;
    expect(() => getCrawlSecret()).toThrow();
  });
});

describe('isInCooldown', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  it('handles none, recent, boundary and old runs', () => {
    expect(isInCooldown(null, now)).toBe(false);
    expect(isInCooldown(new Date(now.getTime() - 59 * 60_000), now)).toBe(true);
    expect(isInCooldown(new Date(now.getTime() - MANUAL_RUN_COOLDOWN_MS), now)).toBe(false);
    expect(isInCooldown(new Date(now.getTime() - 3 * 3600_000), now)).toBe(false);
  });
});
