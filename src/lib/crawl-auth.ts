import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time compare of the provided secret against the expected one (length-independent). */
export function secretsMatch(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

/**
 * Crawl secret derived from the DB URL (already a deployment secret), so no extra env var is needed.
 * Throws when no DB URL is configured. Never log the result.
 */
export function getCrawlSecret(): string {
  const key = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL;
  if (!key) throw new Error('NETLIFY_DB_URL or DATABASE_URL must be set to derive the crawl secret');
  return createHmac('sha256', key).update('hledac-bytu:crawl').digest('hex');
}
