// Single source of truth for response security headers set by src/middleware.ts.
// Keep in sync with [[headers]] for="/*" in netlify.toml (which only covers static files).
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://*.sdn.cz https://sta-reality2.1gr.cz https://api.bezrealitky.cz; script-src 'self' 'sha256-2wwePias9r2s9GmpzYui7ZsnHhZpd0QJYGr/RcDrMsg='; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export const SSR_CACHE_CONTROL = 'private, no-store';

export function withSecurityHeaders(response: Response): Response {
  let res = response;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    res.headers.set('Cache-Control', SSR_CACHE_CONTROL);
  } catch {
    // Immutable headers (e.g. redirects / fetched responses): clone into a mutable response.
    res = new Response(response.body, response);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    res.headers.set('Cache-Control', SSR_CACHE_CONTROL);
  }
  return res;
}
