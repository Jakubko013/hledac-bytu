import type { Config } from '@netlify/functions';
import { z } from 'zod';
import { createDb } from '../../db/index';
import { PORTALS, RUNNERS } from '../../db/schema';
import { adapters } from '../../src/crawler/portals/index';
import { hasActiveRun, runPortal } from '../../src/crawler/run';
import { secretsMatch } from '../../src/lib/crawl-auth';

const Body = z.object({
  portal: z.enum(PORTALS),
  runner: z.enum(RUNNERS).optional(),
});

const MAX_PAGES = 30;
// Netlify background functions are killed at 15 min; abort slightly earlier so the run closes cleanly.
const RUN_TIMEOUT_MS = 14 * 60_000;

export default async (req: Request): Promise<void> => {
  if (!secretsMatch(req.headers.get('x-crawl-secret'), process.env.CRAWL_SECRET)) {
    console.error('crawl-portal-background: invalid secret');
    return;
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    console.error('crawl-portal-background: invalid body');
    return;
  }
  const { portal, runner } = parsed.data;
  const adapter = adapters[portal];
  if (!adapter) {
    console.error(`crawl-portal-background: no adapter for ${portal}`);
    return;
  }
  try {
    const db = createDb();
    if (await hasActiveRun(db, portal)) {
      console.warn(`crawl-portal-background: ${portal} already running, skipping`);
      return;
    }
    const res = await runPortal(db, adapter, {
      runner: runner ?? 'netlify',
      maxPages: MAX_PAGES,
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    console.info(`crawl-portal-background: ${portal} ${res.status} fetched=${res.fetched}`);
  } catch (err) {
    // runPortal closes its own crawl_run; this only fires if the DB itself is unreachable.
    console.error(`crawl-portal-background: ${portal} crashed`, err);
  }
};

export const config: Config = { background: true };
