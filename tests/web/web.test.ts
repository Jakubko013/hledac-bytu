import { describe, expect, it } from 'vitest';
import { criteriaErrorLocation, parseCriteriaForm, parseToggleForm } from '../../src/lib/criteria-form';
import { parseListingStateForm } from '../../src/lib/listing-state-form';
import {
  explainFactors, factorMapToWeights, groupAlsoOn, isNewListing, parseBreakdown, priceDropPct,
  weightsToFactorMap,
} from '../../src/lib/view-logic';

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}
const base: [string, string][] = [['name', 'Byt Brno'], ['offer_type', 'rent'], ['city', 'Brno']];

describe('parseCriteriaForm', () => {
  it('parses a full form with defaults, anchor and weight mapping', () => {
    const r = parseCriteriaForm(form([
      ...base, ['localities', 'Královo Pole, Žabovřesky, Královo Pole'], ['price_min', '10000'], ['price_max', '20000'],
      ['layouts', '2+kk'], ['layouts', '3+kk'], ['must_balcony', '1'], ['active', '1'],
      ['weight_distance_to_centre', '4.5'], ['weight_price_per_m2', '2'],
    ]));
    if (!r.ok) throw new Error(r.error);
    expect(r.id).toBeNull();
    expect(r.values.localities).toEqual(['Královo Pole', 'Žabovřesky']);
    expect(r.values.layouts).toEqual(['2+kk', '3+kk']);
    expect(r.values.must).toEqual({ balcony: true, parking: false, elevator: false });
    expect(r.values.weights.distance).toBe(4.5);
    expect(r.values.weights.price_per_m2).toBe(2);
    expect(r.values.weights.condition).toBe(3);
    expect(r.values.maxDistanceKm).toBe(10);
    expect(r.values.anchorLat).toBeCloseTo(49.1951);
    expect(r.values.active).toBe(true);
  });

  it('unknown city gives null anchor; id is parsed', () => {
    const r = parseCriteriaForm(form([['id', '7'], ['name', 'x'], ['offer_type', 'sale'], ['city', 'Znojmo'], ['max_distance_km', '3']]));
    if (!r.ok) throw new Error(r.error);
    expect(r.id).toBe(7);
    expect(r.values.anchorLat).toBeNull();
    expect(r.values.maxDistanceKm).toBe(3);
    expect(r.values.active).toBe(false);
  });

  const bad = (extra: [string, string][], replace?: string) =>
    parseCriteriaForm(form([...base.filter(([k]) => k !== replace), ...extra]));

  it.each([
    ['min > max price', [['price_min', '5'], ['price_max', '1']]],
    ['negative number', [['area_min', '-1']]],
    ['NaN', [['price_max', 'abc']]],
    ['bad layout', [['layouts', '9+9']]],
    ['bad weight step', [['weight_area', '2.3']]],
    ['weight > 5', [['weight_area', '6']]],
    ['bad id', [['id', 'abc']]],
    ['too many localities', [['localities', Array.from({ length: 21 }, (_, i) => `L${i}`).join(',')]]],
    ['long locality', [['localities', 'x'.repeat(61)]]],
  ] as [string, [string, string][]][])('rejects %s', (_n, extra) => {
    expect(bad(extra).ok).toBe(false);
  });

  it('rejects bad offer_type and long/empty name', () => {
    expect(bad([['offer_type', 'swap']], 'offer_type').ok).toBe(false);
    expect(bad([['name', 'x'.repeat(101)]], 'name').ok).toBe(false);
    expect(bad([['name', '  ']], 'name').ok).toBe(false);
  });

  it('error carries id and builds a redirect location', () => {
    const r = parseCriteriaForm(form([['id', '4'], ...base, ['price_min', '5'], ['price_max', '1']]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.id).toBe(4);
      expect(criteriaErrorLocation(r.id, r.error)).toMatch(/^\/criteria\/4\?error=Cena%20od/);
      expect(criteriaErrorLocation(null, 'x y')).toBe('/criteria/new?error=x%20y');
    }
  });
});

describe('parseToggleForm', () => {
  it('accepts valid and rejects invalid', () => {
    expect(parseToggleForm(form([['id', '3'], ['active', 'false']]))).toEqual({ ok: true, id: 3, active: false });
    expect(parseToggleForm(form([['id', '3'], ['active', 'yes']])).ok).toBe(false);
    expect(parseToggleForm(form([['active', 'true']])).ok).toBe(false);
  });
});

describe('parseListingStateForm', () => {
  it('parses and sanitizes next', () => {
    const r = parseListingStateForm(form([['listing_id', '5'], ['status', 'hidden'], ['next', '//evil.com']]));
    expect(r).toEqual({ ok: true, listingId: 5, status: 'hidden', note: undefined, next: '/' });
  });
  it('rejects invalid status, id and long note', () => {
    expect(parseListingStateForm(form([['listing_id', '5'], ['status', 'new']])).ok).toBe(false);
    expect(parseListingStateForm(form([['listing_id', '0'], ['status', 'seen']])).ok).toBe(false);
    expect(parseListingStateForm(form([['listing_id', '1'], ['status', 'seen'], ['note', 'x'.repeat(2001)]])).ok).toBe(false);
  });
  it('keeps note semantics', () => {
    const r = parseListingStateForm(form([['listing_id', '1'], ['status', 'seen'], ['note', ' hi ']]));
    expect(r.ok && r.note).toBe('hi');
  });
});

describe('weights mapping', () => {
  it('round-trips distance <-> distance_to_centre', () => {
    const w = { price_per_m2: 1, distance: 2, condition: 3, area: 4, freshness: 5, extras: 0.5, price_drop: 0 };
    const m = weightsToFactorMap(w);
    expect(m.distance_to_centre).toBe(2);
    expect(factorMapToWeights(m)).toEqual(w);
  });
  it('parseBreakdown tolerates malformed data', () => {
    const { scores, weights } = parseBreakdown({ distance: { s: 0.4, w: 3 }, area: 'x' });
    expect(scores.distance_to_centre).toBe(0.4);
    expect(weights.distance_to_centre).toBe(3);
    expect(scores.area).toBe(0);
    expect(parseBreakdown(null).scores.condition).toBe(0);
  });
});

describe('explainFactors', () => {
  const scores = weightsToFactorMap({ price_per_m2: 0.7, distance: 0.5, condition: 1, area: 0.25, freshness: 1, extras: 0, price_drop: 0 });
  const input = {
    priceCzk: 20000, areaM2: 50, condition: 'renovated' as const, distanceKm: 2.34, maxDistanceKm: 10, ageDays: 0,
    hasBalcony: true, hasParking: null, hasElevator: false, priceDropPct: 8,
  };
  it('generates Czech texts', () => {
    const t = explainFactors(scores, input);
    expect(t.price_per_m2).toContain('400 Kč/m²');
    expect(t.distance_to_centre).toContain('2,3 km');
    expect(t.condition).toBe('Stav: po rekonstrukci.');
    expect(t.freshness).toBe('Nabídka je dnešní.');
    expect(t.extras).toBe('Vybavení: balkon.');
    expect(t.price_drop).toBe('Cena klesla o 8 %.');
  });
  it('handles missing data', () => {
    const t = explainFactors(scores, { ...input, priceCzk: null, distanceKm: null, areaM2: null, priceDropPct: null, hasBalcony: false });
    expect(t.price_per_m2).toContain('chybí');
    expect(t.distance_to_centre).toContain('Bez souřadnic');
    expect(t.extras).toContain('Žádné');
    expect(t.price_drop).toBe('Cena nebyla snížena.');
  });
});

describe('groupAlsoOn', () => {
  it('lists other portals and urls per primary', () => {
    const g = groupAlsoOn(
      [{ listingId: 1, fingerprint: 'a', portal: 'sreality' }],
      [
        { fingerprint: 'a', listingId: 1, portal: 'sreality', url: 'u1', priceCzk: 10 },
        { fingerprint: 'a', listingId: 2, portal: 'idnes', url: 'u2', priceCzk: 11 },
        { fingerprint: 'a', listingId: 3, portal: 'idnes', url: 'u3', priceCzk: null },
        { fingerprint: 'b', listingId: 4, portal: 'bezrealitky', url: 'u4', priceCzk: 5 },
      ],
    );
    expect(g.get(1)).toEqual({
      also_on: ['idnes'],
      also_on_links: [
        { portal: 'idnes', url: 'u2', price_czk: 11 },
        { portal: 'idnes', url: 'u3', price_czk: 0 },
      ],
    });
  });
  it('empty when no siblings', () => {
    expect(groupAlsoOn([{ listingId: 1, fingerprint: 'a', portal: 'idnes' }], []).get(1)).toEqual({ also_on: [], also_on_links: [] });
  });
});

describe('price drop / new', () => {
  it('priceDropPct', () => {
    expect(priceDropPct([100])).toBeNull();
    expect(priceDropPct([100, 110])).toBeNull();
    expect(priceDropPct([100, 90])).toBe(10);
    expect(priceDropPct([200, 100, 95])).toBe(5);
  });
  it('isNewListing', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    expect(isNewListing(null, new Date('2026-01-01T00:00:00Z'), now)).toBe(false);
    expect(isNewListing(null, new Date('2026-01-09T13:00:00Z'), now)).toBe(true);
    expect(isNewListing('new', new Date('2026-01-09T13:00:00Z'), now)).toBe(true);
    expect(isNewListing('new', new Date('2026-01-01T00:00:00Z'), now)).toBe(false);
    for (const s of ['seen', 'favorite', 'hidden']) {
      expect(isNewListing(s, new Date('2026-01-09T13:00:00Z'), now)).toBe(false);
    }
  });
});
