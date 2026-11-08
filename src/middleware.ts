import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { AuthConfigError, loadAuthConfig, SESSION_COOKIE, verifySessionToken } from './lib/auth';
import { withSecurityHeaders } from './lib/security-headers';

const PUBLIC_EXACT = new Set(['/login', '/api/login', '/favicon.ico', '/favicon.svg', '/robots.txt']);
const STATIC_PREFIXES = ['/_astro/', '/assets/'];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return STATIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  // Hashed static assets are never modified here (Netlify [[headers]] own their caching).
  if (pathname.startsWith('/_astro/')) return next();
  return withSecurityHeaders(await handle(context, next));
});

async function handle(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const { pathname, search } = context.url;

  let config: ReturnType<typeof loadAuthConfig>;
  try {
    config = loadAuthConfig();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error(`Auth misconfigured: ${err.message}`);
      return new Response('Server misconfigured', { status: 500 });
    }
    throw err;
  }

  const { secret, users } = config;
  const verified = verifySessionToken(context.cookies.get(SESSION_COOKIE)?.value, secret);
  const user = verified && users.has(verified) ? verified : null;
  if (user) context.locals.user = user;

  if (isPublicPath(pathname)) return next();
  if (user) return next();

  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
}
