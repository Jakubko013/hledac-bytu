import { defineMiddleware } from 'astro:middleware';
import { withSecurityHeaders } from './lib/security-headers';

export const onRequest = defineMiddleware(async (context, next) => {
  // Hashed static assets are never modified here (Netlify [[headers]] own their caching).
  if (context.url.pathname.startsWith('/_astro/')) return next();
  return withSecurityHeaders(await next());
});
