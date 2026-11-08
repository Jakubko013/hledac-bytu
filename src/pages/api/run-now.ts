import type { APIRoute } from 'astro';
import { createDb } from '../../../db/index';
import { desc } from 'drizzle-orm';
import { crawlRun } from '../../../db/schema';
import { getCrawlSecret } from '../../lib/crawl-auth';
import { isInCooldown } from '../../lib/run-cooldown';
import { adapters } from '../../crawler/portals/index';

export const prerender = false;

export const POST: APIRoute = async ({ url }) => {
  const secret = getCrawlSecret();

  try {
    const db = createDb();
    const [last] = await db.select({ startedAt: crawlRun.startedAt }).from(crawlRun).orderBy(desc(crawlRun.startedAt)).limit(1);
    if (isInCooldown(last?.startedAt)) {
      return new Response(null, { status: 303, headers: { Location: '/health?busy=1' } });
    }
  } catch (err) {
    console.error('run-now: cooldown check failed', err);
    return new Response('Service unavailable', { status: 503 });
  }

  // The secret goes only to the site's own configured origin; url.origin (request-derived) only in local dev.
  const target = new URL('/.netlify/functions/crawl-portal-background', process.env.URL ?? url.origin);
  const results = await Promise.allSettled(
    Object.keys(adapters).map(async (portal) => {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-crawl-secret': secret },
        body: JSON.stringify({ portal, runner: 'manual' }),
      });
      if (!res.ok) throw new Error(`${portal}: HTTP ${res.status}`);
    }),
  );
  for (const r of results) if (r.status === 'rejected') console.error('run-now: dispatch failed', r.reason);

  return new Response(null, { status: 303, headers: { Location: '/health?started=1' } });
};
