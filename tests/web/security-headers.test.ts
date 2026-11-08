import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, withSecurityHeaders } from '../../src/lib/security-headers';

const root = new URL('../../', import.meta.url);

describe('CSP inline script hash', () => {
  it('contains the sha256 of the is:inline script in criteria/[id].astro', () => {
    const src = readFileSync(new URL('src/pages/criteria/[id].astro', root), 'utf8');
    const m = /<script is:inline>([\s\S]*?)<\/script>/.exec(src);
    expect(m).not.toBeNull();
    const hash = createHash('sha256').update(m![1]!, 'utf8').digest('base64');
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain(`'sha256-${hash}'`);
  });
});

describe('netlify.toml sync', () => {
  it('has the same values as SECURITY_HEADERS', () => {
    const toml = readFileSync(new URL('netlify.toml', root), 'utf8');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      expect(toml).toContain(`${k} = "${v}"`);
    }
  });
});

describe('withSecurityHeaders', () => {
  it('sets all headers incl. no-store on a normal response', () => {
    const r = withSecurityHeaders(new Response('x'));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('handles immutable headers (Response.redirect)', () => {
    const r = withSecurityHeaders(Response.redirect('http://localhost/health', 302));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://localhost/health');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
