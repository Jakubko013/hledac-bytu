import { and, count, eq, gt, lt } from 'drizzle-orm';
import { createDb } from '../../db/index';
import { loginAttempt } from '../../db/schema';

export const MAX_FAILED_ATTEMPTS = 5;
export const WINDOW_MINUTES = 15;

export interface RateLimiter {
  /** True when the key has reached the failure limit within the window. */
  isLimited(key: string, max?: number): Promise<boolean>;
  recordFailure(key: string): Promise<void>;
}

/**
 * DB-backed limiter on table login_attempt(id, key, attempted_at). Failures simply age out of the window (not cleared on success, so
 * an attacker holding one valid account cannot reset the counter between guesses).
 */
export function createDbRateLimiter(db: ReturnType<typeof createDb> = createDb()): RateLimiter {
  return {
    async isLimited(key, max = MAX_FAILED_ATTEMPTS) {
      const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60_000);
      const [row] = await db
        .select({ n: count() })
        .from(loginAttempt)
        .where(and(eq(loginAttempt.key, key), gt(loginAttempt.attemptedAt, windowStart)));
      return (row?.n ?? 0) >= max;
    },
    async recordFailure(key) {
      await db.insert(loginAttempt).values({ key });
      // Opportunistic prune of old rows keeps the table small.
      await db.delete(loginAttempt).where(lt(loginAttempt.attemptedAt, new Date(Date.now() - 24 * 3_600_000)));
    },
  };
}
