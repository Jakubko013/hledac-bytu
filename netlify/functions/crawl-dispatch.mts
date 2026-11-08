import type { Config } from '@netlify/functions';
import { adapters } from '../../src/crawler/portals/index';
import { getCrawlSecret } from '../../src/lib/crawl-auth';

export default async (): Promise<void> => {
  const base = process.env.URL;
  if (!base) {
    console.error('crawl-dispatch: URL is not set');
    return;
  }
  const secret = getCrawlSecret();
  const portals = Object.keys(adapters);
  const results = await Promise.allSettled(
    portals.map(async (portal) => {
      const res = await fetch(`${base}/.netlify/functions/crawl-portal-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-crawl-secret': secret },
        body: JSON.stringify({ portal }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`responded ${res.status}`);
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`crawl-dispatch: ${portals[i]} dispatch failed`, r.reason);
  });
};

export const config: Config = { schedule: '0 4 * * *' };
