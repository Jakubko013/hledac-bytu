import type { Config } from '@netlify/functions';
import { adapters } from '../../src/crawler/portals/index';

export default async (): Promise<void> => {
  const base = process.env.URL;
  const secret = process.env.CRAWL_SECRET;
  if (!base || !secret) {
    console.error('crawl-dispatch: URL or CRAWL_SECRET is not set');
    return;
  }
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
