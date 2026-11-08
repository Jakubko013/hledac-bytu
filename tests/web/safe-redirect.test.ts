import { describe, expect, it } from 'vitest';
import { sanitizeNext } from '../../src/lib/safe-redirect';

describe('sanitizeNext', () => {
  it('allows relative paths', () => {
    expect(sanitizeNext('/criteria?id=1')).toBe('/criteria?id=1');
  });
  it('blocks open redirects', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', '', undefined, 42, '/a\nb']) {
      expect(sanitizeNext(bad)).toBe('/');
    }
  });
});
