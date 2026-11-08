export const MANUAL_RUN_COOLDOWN_MS = 60 * 60_000;

/** True when the latest crawl_run started less than the cooldown ago (any runner, any status). */
export function isInCooldown(lastStartedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastStartedAt) return false;
  return now.getTime() - lastStartedAt.getTime() < MANUAL_RUN_COOLDOWN_MS;
}
