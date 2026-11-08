import { describe, expect, it } from 'vitest';
import { deriveQueries } from '../../src/crawler/queries';
import { ACTIVE_RUN_WINDOW_MS, classifyRunStatus, isActiveRun } from '../../src/crawler/run';
import { decideUpsert, dedupeBatch, mergeListing, needsDetailFor, sanitizeListings } from '../../src/crawler/upsert';
import { secretsMatch } from '../../src/lib/crawl-auth';
import { buildMatchRows, cityLikePattern, isPriceDropped, toScoreListing, type CandidateRow } from '../../src/scoring/rescore';
import { fingerprint } from '../../src/crawler/fingerprint';
import type { NormalizedListing } from '../../src/crawler/types';

const crit = (o: Partial<Parameters<typeof deriveQueries>[0][number]> = {}) => ({
  offerType: 'rent' as const,
  city: 'Brno',
  layouts: [] as string[],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  ...o,
});

describe('deriveQueries', () => {
  it('dedupes by offer type + city (diacritics/case-insensitive) and merges envelope', () => {
    const q = deriveQueries([
      crit({ city: 'Plzeň', layouts: ['2+kk'], priceMin: 10000, priceMax: 20000, areaMin: 40, areaMax: 60 }),
      crit({ city: 'plzen', layouts: ['3+1', '2+kk'], priceMin: 8000, priceMax: 25000, areaMin: 50, areaMax: 80 }),
      crit({ offerType: 'sale', city: 'Plzeň' }),
    ]);
    expect(q).toHaveLength(2);
    expect(q[0]).toEqual({
      offerType: 'rent',
      city: 'Plzeň',
      layouts: ['2+kk', '3+1'],
      priceMin: 8000,
      priceMax: 25000,
      areaMin: 40,
      areaMax: 80,
    });
  });
  it('unbounded criteria make the envelope unbounded; empty layouts mean any', () => {
    const [q] = deriveQueries([crit({ layouts: ['2+kk'], priceMin: 5, priceMax: 9 }), crit({ priceMax: 7 })]);
    expect(q).toEqual({ offerType: 'rent', city: 'Brno', priceMax: 9 });
  });
  it('skips blank cities', () => {
    expect(deriveQueries([crit({ city: '  ' })])).toEqual([]);
  });
});

describe('classifyRunStatus', () => {
  it('failed when nothing fetched', () => {
    expect(classifyRunStatus({ fetched: 0, hadError: false, avg7d: null })).toBe('failed');
    expect(classifyRunStatus({ fetched: 0, hadError: true, avg7d: 100 })).toBe('failed');
  });
  it('partial on error after some data', () => {
    expect(classifyRunStatus({ fetched: 10, hadError: true, avg7d: null })).toBe('partial');
  });
  it('partial below 30% of the 7-day average', () => {
    expect(classifyRunStatus({ fetched: 29, hadError: false, avg7d: 100 })).toBe('partial');
    expect(classifyRunStatus({ fetched: 30, hadError: false, avg7d: 100 })).toBe('ok');
  });
  it('ok without history', () => {
    expect(classifyRunStatus({ fetched: 5, hadError: false, avg7d: null })).toBe('ok');
  });
});

describe('needsDetailFor / decideUpsert', () => {
  const row = (priceCzk: number | null, condition = 'good', lat: number | null = 1) => ({ priceCzk, condition, lat });
  const known = new Map([['a', row(1000)], ['n', row(null)], ['u', row(1000, 'unknown')], ['g', row(1000, 'good', null)]]);
  it('unknown or price changed needs detail', () => {
    expect(needsDetailFor(known, 'x', 1)).toBe(true);
    expect(needsDetailFor(known, 'a', 900)).toBe(true);
    expect(needsDetailFor(known, 'a', 1000)).toBe(false);
    expect(needsDetailFor(known, 'n', null)).toBe(false);
  });
  it('known rows missing condition or lat are retried within the budget', () => {
    const budget = { left: 2 };
    expect(needsDetailFor(known, 'a', 1000, budget)).toBe(false);
    expect(needsDetailFor(known, 'u', 1000)).toBe(false);
    expect(needsDetailFor(known, 'u', 1000, budget)).toBe(true);
    expect(needsDetailFor(known, 'g', 1000, budget)).toBe(true);
    expect(budget.left).toBe(0);
    expect(needsDetailFor(known, 'u', 1000, budget)).toBe(false);
  });
  it('records price on first sighting and on change only', () => {
    expect(decideUpsert(undefined, 5)).toEqual({ isNew: true, recordPrice: true });
    expect(decideUpsert(undefined, null)).toEqual({ isNew: true, recordPrice: false });
    expect(decideUpsert({ priceCzk: 5 }, 5)).toEqual({ isNew: false, recordPrice: false });
    expect(decideUpsert({ priceCzk: 5 }, 4)).toEqual({ isNew: false, recordPrice: true });
    expect(decideUpsert({ priceCzk: null }, 4)).toEqual({ isNew: false, recordPrice: true });
    expect(decideUpsert({ priceCzk: 5 }, null)).toEqual({ isNew: false, recordPrice: false });
  });
  const full = (o: Partial<NormalizedListing>): NormalizedListing => ({
    portal: 'idnes', externalId: '1', url: 'https://x.test/1', title: 't', offerType: 'rent', priceCzk: 1,
    feesCzk: null, areaM2: null, layout: null, floor: null, condition: 'unknown', hasBalcony: null,
    hasParking: null, hasElevator: null, lat: null, lng: null, localityText: null, city: null, district: null,
    images: [], raw: {}, fingerprint: '', ...o,
  });
  it('dedupes a batch, last wins for price', () => {
    const out = dedupeBatch([full({ priceCzk: 1 }), full({ externalId: '2', priceCzk: 2 }), full({ priceCzk: 3 })]);
    expect(out).toHaveLength(2);
    expect(out.find((l) => l.externalId === '1')!.priceCzk).toBe(3);
  });
  it('dedupe merges a later list-only duplicate into the detailed one', () => {
    const out = dedupeBatch([
      full({ areaM2: 55, condition: 'good', localityText: 'Brno', images: ['https://i.test/a.jpg'] }),
      full({ priceCzk: 9 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ priceCzk: 9, areaM2: 55, condition: 'good', localityText: 'Brno' });
    expect(out[0]!.images).toHaveLength(1);
  });
});

describe('rescore helpers', () => {
  const row: CandidateRow = {
    id: 7, offerType: 'rent', priceCzk: 1, areaM2: 1, layout: null, condition: 'good', lat: null, lng: null,
    city: 'Brno', district: null, localityText: null, hasBalcony: null, hasParking: null, hasElevator: null,
    firstSeenAt: new Date(0), removedAt: null, status: null,
  };
  it('detects price drop from last < previous', () => {
    expect(isPriceDropped([])).toBe(false);
    expect(isPriceDropped([10])).toBe(false);
    expect(isPriceDropped([10, 12, 11])).toBe(true);
    expect(isPriceDropped([10, 9, 11])).toBe(false);
  });
  it('maps hidden/removed/price_dropped', () => {
    const l = toScoreListing({ ...row, status: 'hidden', removedAt: new Date() }, [5, 4]);
    expect(l).toMatchObject({ hidden: true, removed: true, price_dropped: true, id: 7 });
    expect(toScoreListing({ ...row, status: 'favorite' }, [])).toMatchObject({ hidden: false, removed: false });
  });
  it('builds match rows and city patterns', () => {
    const at = new Date(1);
    expect(buildMatchRows(3, [{ listingId: 7, score: 50, breakdown: {} as never }], at)).toEqual([
      { criteriaId: 3, listingId: 7, score: 50, breakdown: {}, computedAt: at },
    ]);
    expect(cityLikePattern('Ústí_n%')).toBe('%usti\\_n\\%%');
    expect(cityLikePattern(' ')).toBeNull();
  });
});

describe('secretsMatch', () => {
  it('compares safely', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('abcd', 'abc')).toBe(false);
    expect(secretsMatch(null, 'abc')).toBe(false);
    expect(secretsMatch('abc', undefined)).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });
});

describe('mergeListing', () => {
  const base: NormalizedListing = {
    portal: 'idnes', externalId: '1', url: 'u', title: 't', offerType: 'rent', priceCzk: 10000, feesCzk: null,
    areaM2: null, layout: '2+kk', floor: null, condition: 'unknown', hasBalcony: null, hasParking: null,
    hasElevator: null, lat: null, lng: null, localityText: null, city: 'Brno', district: null, images: ['a'],
    raw: {}, fingerprint: 'x',
  };
  const known = {
    ...base, feesCzk: 2000, areaM2: 50, floor: 3, condition: 'good' as const, hasBalcony: true, hasParking: false,
    hasElevator: true, lat: 49.1, lng: 16.6, district: 'Brno-střed', images: ['a', 'b', 'c'],
  };
  it('returns incoming for unknown listings', () => {
    expect(mergeListing(undefined, base)).toBe(base);
  });
  it('keeps known values when the sighting is list-only', () => {
    const m = mergeListing(known, { ...base, priceCzk: 9000, title: 'new' });
    expect(m).toMatchObject({
      priceCzk: 9000, title: 'new', feesCzk: 2000, areaM2: 50, floor: 3, condition: 'good', hasBalcony: true,
      hasParking: false, hasElevator: true, lat: 49.1, lng: 16.6, district: 'Brno-střed',
    });
    expect(m.images).toEqual(['a', 'b', 'c']);
  });
  it('lets detail data override and replace images when not fewer', () => {
    const m = mergeListing(base, { ...known, images: ['a', 'b'] });
    expect(m).toMatchObject({ condition: 'good', floor: 3, images: ['a', 'b'] });
  });
  it('recomputes the fingerprint from merged values', () => {
    const m = mergeListing(known, base);
    expect(m.fingerprint).toBe(
      fingerprint({ portal: 'idnes', externalId: '1', offerType: 'rent', layout: '2+kk', areaM2: 50, lat: 49.1, lng: 16.6 }),
    );
    expect(m.fingerprint).not.toBe(base.fingerprint);
  });
});

describe('sanitizeListings', () => {
  const mk = (url: string, images: string[]) => ({ portal: 'idnes', externalId: url, url, images }) as NormalizedListing;
  it('drops non-https listing urls and keeps https ones', () => {
    const { safe, dropped } = sanitizeListings([
      mk('https://reality.idnes.cz/x', []),
      mk('http://reality.idnes.cz/x', []),
      mk('javascript:alert(1)', []),
      mk('not a url', []),
    ]);
    expect(safe.map((l) => l.url)).toEqual(['https://reality.idnes.cz/x']);
    expect(dropped).toBe(3);
  });
  it('filters images to https only', () => {
    const { safe } = sanitizeListings([
      mk('https://a.cz/1', ['https://cdn.cz/a.jpg', 'http://cdn.cz/b.jpg', 'data:image/png;base64,AA', '//cdn.cz/c.jpg']),
    ]);
    expect(safe[0]!.images).toEqual(['https://cdn.cz/a.jpg']);
  });
});

describe('isActiveRun', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (msAgo: number) => new Date(now - msAgo);
  it('is active only when running and younger than 15 min', () => {
    expect(isActiveRun({ status: 'running', startedAt: at(60_000) }, now)).toBe(true);
    expect(isActiveRun({ status: 'running', startedAt: at(ACTIVE_RUN_WINDOW_MS) }, now)).toBe(false);
    expect(isActiveRun({ status: 'running', startedAt: at(ACTIVE_RUN_WINDOW_MS + 1) }, now)).toBe(false);
    expect(isActiveRun({ status: 'ok', startedAt: at(1000) }, now)).toBe(false);
  });
});
