import { describe, expect, it } from 'vitest';
import { CITY_CENTRES, cityCentre, haversineKm, normalizeText } from '../../src/scoring/geo.ts';
import { CZ_FROM, CZ_TO } from '../../src/scoring/rescore.ts';

describe('geo', () => {
  it('zero distance for identical points', () => {
    expect(haversineKm(CITY_CENTRES.Brno!, CITY_CENTRES.Brno!)).toBe(0);
  });
  it('Praha-Brno is about 185 km', () => {
    const d = haversineKm(CITY_CENTRES.Praha!, CITY_CENTRES.Brno!);
    expect(d).toBeGreaterThan(180);
    expect(d).toBeLessThan(190);
  });
  it('is symmetric', () => {
    const a = CITY_CENTRES.Plzeň!;
    const b = CITY_CENTRES.Ostrava!;
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
  it('has all 8 presets and matches ignoring case/diacritics', () => {
    expect(Object.keys(CITY_CENTRES)).toHaveLength(8);
    expect(cityCentre('plzen')).toEqual({ lat: 49.7477, lng: 13.3776 });
    expect(cityCentre('CESKE BUDEJOVICE')).toEqual({ lat: 48.9745, lng: 14.4743 });
    expect(cityCentre('Neexistuje')).toBeNull();
  });
});

describe('rescore SQL translate mapping', () => {
  it('CZ_FROM/CZ_TO stay in sync with normalizeText', () => {
    expect(CZ_FROM.length).toBe(CZ_TO.length);
    expect(CZ_FROM.length).toBeGreaterThan(0);
    for (const [i, ch] of [...CZ_FROM].entries()) expect(normalizeText(ch)).toBe([...CZ_TO][i]);
    for (const ch of 'ľĺŕôäĽĹŔÔÄáčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ') expect(CZ_FROM).toContain(ch);
  });
});
