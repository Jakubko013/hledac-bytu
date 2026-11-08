import type { APIRoute } from 'astro';
import { createDb } from '../../../db/index';
import { hasActiveRun } from '../../crawler/run';
import { adapters } from '../../crawler/portals/index';

export const prerender = false;

export const POST: APIRoute = async ({ url, locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const secret = process.env.CRAWL_SECRET;
  if (!secret) {
    console.error('run-now: CRAWL_SECRET is not set');
    return new Response('Server misconfigured', { status: 500 });
  }

  try {
    if (await hasActiveRun(createDb())) {
      return new Response(null, { status: 303, headers: { Location: '/health?busy=1' } });
    }
  } catch (err) {
    console.error('run-now: busy check failed', err);
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
