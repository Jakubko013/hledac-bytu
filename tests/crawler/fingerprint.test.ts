import { describe, expect, it } from 'vitest';
import { fingerprint, type FingerprintInput } from '../../src/crawler/fingerprint';

const base: FingerprintInput = {
  portal: 'sreality', externalId: '1', offerType: 'rent', layout: '2+kk', areaM2: 54.4, lat: 49.19512, lng: 16.60681,
};

describe('fingerprint', () => {
  it('matches across portals for the same flat', () => {
    const a = fingerprint(base);
    const b = fingerprint({ ...base, portal: 'idnes', externalId: '99', areaM2: 53.6, lat: 49.1953, lng: 16.6065 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
  it('differs for different offer type, layout or area', () => {
    const a = fingerprint(base);
    expect(fingerprint({ ...base, offerType: 'sale' })).not.toBe(a);
    expect(fingerprint({ ...base, layout: '3+kk' })).not.toBe(a);
    expect(fingerprint({ ...base, areaM2: 60 })).not.toBe(a);
  });
  it('falls back to portal+externalId when area or coords are missing', () => {
    const x = fingerprint({ ...base, areaM2: null });
    const y = fingerprint({ ...base, portal: 'idnes', areaM2: null });
    const z = fingerprint({ ...base, externalId: '2', lat: undefined });
    expect(new Set([x, y, z, fingerprint(base)]).size).toBe(4);
    expect(fingerprint({ ...base, lng: NaN })).toBe(x);
  });
});
