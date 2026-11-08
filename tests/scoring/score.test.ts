import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  passesHardFilters,
  scoreListings,
  type ScoreCriteria,
  type ScoreListing,
  type Weights,
} from '../../src/scoring/score.ts';

const NOW = new Date('2026-01-10T12:00:00Z');
const BRNO = { lat: 49.1951, lng: 16.6068 };

const crit = (o: Partial<ScoreCriteria> = {}): ScoreCriteria => ({
  offer_type: 'sale',
  city: 'Brno',
  localities: [],
  layouts: [],
  must: {},
  weights: { ...DEFAULT_WEIGHTS },
  ...o,
});

let seq = 0;
const lst = (o: Partial<ScoreListing> = {}): ScoreListing => ({
  id: ++seq,
  offer_type: 'sale',
  price_czk: 5_000_000,
  area_m2: 50,
  layout: '2+kk',
  condition: 'good',
  lat: BRNO.lat,
  lng: BRNO.lng,
  city: 'Brno',
  district: null,
  locality_text: null,
  has_balcony: null,
  has_parking: null,
  has_elevator: null,
  first_seen_at: NOW,
  price_dropped: false,
  removed: false,
  hidden: false,
  ...o,
});

const only = (k: keyof Weights, v = 1): Weights => ({
  price_per_m2: 0, distance: 0, condition: 0, area: 0, freshness: 0, extras: 0, price_drop: 0, [k]: v,
});

const s1 = (l: ScoreListing[], c: ScoreCriteria, i = 0) => scoreListings(l, c, NOW)[i]!;

describe('passesHardFilters', () => {
  it('accepts a matching listing', () => expect(passesHardFilters(lst(), crit())).toBe(true));
  it('keeps hidden (view filters by status) but rejects removed and other offer type', () => {
    expect(passesHardFilters(lst({ hidden: true }), crit())).toBe(true);
    expect(passesHardFilters(lst({ removed: true }), crit())).toBe(false);
    expect(passesHardFilters(lst({ offer_type: 'rent' }), crit())).toBe(false);
  });
  it('matches city and localities case/diacritics-insensitively', () => {
    expect(passesHardFilters(lst({ city: 'PLZEŇ' }), crit({ city: 'plzen' }))).toBe(true);
    expect(passesHardFilters(lst({ city: 'Praha' }), crit())).toBe(false);
    const c = crit({ localities: ['Královo Pole'] });
    expect(passesHardFilters(lst({ district: 'KRALOVO POLE'.replace('KRALOVO', 'KRÁLOVO') }), c)).toBe(true);
    expect(passesHardFilters(lst({ locality_text: 'Brno, královo pole, Purkyňova' }), c)).toBe(true);
    expect(passesHardFilters(lst({ district: 'Žabovřesky' }), c)).toBe(false);
  });
  it('price range, with null failing only when bound set', () => {
    const c = crit({ price_min: 4_000_000, price_max: 6_000_000 });
    expect(passesHardFilters(lst({ price_czk: 3_999_999 }), c)).toBe(false);
    expect(passesHardFilters(lst({ price_czk: 6_000_001 }), c)).toBe(false);
    expect(passesHardFilters(lst({ price_czk: 6_000_000 }), c)).toBe(true);
    expect(passesHardFilters(lst({ price_czk: null }), c)).toBe(false);
    expect(passesHardFilters(lst({ price_czk: null }), crit())).toBe(true);
    expect(passesHardFilters(lst({ price_czk: null }), crit({ price_max: 1 }))).toBe(false);
  });
  it('area range, with null failing only when bound set', () => {
    const c = crit({ area_min: 40, area_max: 60 });
    expect(passesHardFilters(lst({ area_m2: 39 }), c)).toBe(false);
    expect(passesHardFilters(lst({ area_m2: 61 }), c)).toBe(false);
    expect(passesHardFilters(lst({ area_m2: 40 }), c)).toBe(true);
    expect(passesHardFilters(lst({ area_m2: null }), c)).toBe(false);
    expect(passesHardFilters(lst({ area_m2: null }), crit())).toBe(true);
  });
  it('layouts', () => {
    const c = crit({ layouts: ['2+KK', '3+1'] });
    expect(passesHardFilters(lst({ layout: '2+kk' }), c)).toBe(true);
    expect(passesHardFilters(lst({ layout: '4+1' }), c)).toBe(false);
    expect(passesHardFilters(lst({ layout: null }), c)).toBe(false);
  });
  it('must extras require true', () => {
    const c = crit({ must: { balcony: true, parking: true, elevator: true } });
    const full = { has_balcony: true, has_parking: true, has_elevator: true };
    expect(passesHardFilters(lst(full), c)).toBe(true);
    expect(passesHardFilters(lst({ ...full, has_balcony: null }), c)).toBe(false);
    expect(passesHardFilters(lst({ ...full, has_parking: false }), c)).toBe(false);
    expect(passesHardFilters(lst({ ...full, has_elevator: null }), c)).toBe(false);
    expect(passesHardFilters(lst({ has_balcony: false }), crit({ must: { balcony: false } }))).toBe(true);
  });
});

describe('scoreListings factors', () => {
  it('price_per_m2: cheaper than median scores higher; clamped', () => {
    const ls = [
      lst({ price_czk: 4_000_000 }), // 80k
      lst({ price_czk: 5_000_000 }), // 100k (median)
      lst({ price_czk: 9_000_000 }), // 180k
    ];
    const r = scoreListings(ls, crit({ weights: only('price_per_m2') }), NOW);
    const by = new Map(r.map((x) => [x.listingId, x.breakdown.price_per_m2.s]));
    expect(by.get(ls[1]!.id)).toBeCloseTo(0.5);
    expect(by.get(ls[0]!.id)).toBeCloseTo(0.7);
    expect(by.get(ls[2]!.id)).toBe(0);
    expect(r[0]!.listingId).toBe(ls[0]!.id);
  });
  it('price_per_m2: missing data -> 0.5, and excluded from the median', () => {
    const noPrice = lst({ price_czk: null });
    const r = s1([noPrice, lst()], crit({ weights: only('price_per_m2') }));
    const nr = scoreListings([noPrice, lst()], crit(), NOW).find((x) => x.listingId === noPrice.id)!;
    expect(nr.breakdown.price_per_m2.s).toBe(0.5);
    expect(r.score).toBeGreaterThan(0);
  });
  it('median computed only over passing listings', () => {
    const cheapOther = lst({ city: 'Praha', price_czk: 100_000 });
    const a = lst({ price_czk: 5_000_000 });
    const b = lst({ price_czk: 5_000_000 });
    const r = scoreListings([cheapOther, a, b], crit(), NOW);
    expect(r).toHaveLength(2);
    expect(r[0]!.breakdown.price_per_m2.s).toBeCloseTo(0.5);
  });
  it('distance: anchor defaults to city centre, linear to max (default 10 km)', () => {
    const c = crit({ weights: only('distance') });
    expect(s1([lst()], c).breakdown.distance.s).toBeCloseTo(1);
    // ~0.0899 deg lat ≈ 10 km
    expect(s1([lst({ lat: BRNO.lat + 0.0899 })], c).breakdown.distance.s).toBeCloseTo(0, 1);
    expect(s1([lst({ lat: BRNO.lat + 1 })], c).breakdown.distance.s).toBe(0);
    expect(s1([lst({ lat: BRNO.lat + 0.045 })], c).breakdown.distance.s).toBeCloseTo(0.5, 1);
  });
  it('distance: custom anchor and max_distance_km', () => {
    const c = crit({ anchor_lat: 50, anchor_lng: 15, max_distance_km: 100 });
    const r = s1([lst({ lat: 50, lng: 15 })], c);
    expect(r.breakdown.distance.s).toBeCloseTo(1);
  });
  it('distance: missing coords or unknown anchor -> 0.5', () => {
    expect(s1([lst({ lat: null, lng: null })], crit()).breakdown.distance.s).toBe(0.5);
    const c = crit({ city: 'Neznámo' });
    expect(s1([lst({ city: 'Neznámo' })], c).breakdown.distance.s).toBe(0.5);
  });
  it('condition values', () => {
    const expected: Record<string, number> = {
      new_build: 1, renovated: 0.9, good: 0.5, unknown: 0.4, needs_renovation: 0.1, weird: 0.4,
    };
    for (const [cond, v] of Object.entries(expected)) {
      expect(s1([lst({ condition: cond })], crit()).breakdown.condition.s).toBe(v);
    }
  });
  it('area: uses explicit bounds', () => {
    const c = crit({ area_min: 40, area_max: 80, weights: only('area') });
    const ls = [lst({ area_m2: 40 }), lst({ area_m2: 60 }), lst({ area_m2: 80 })];
    const r = scoreListings(ls, c, NOW);
    expect(r.map((x) => x.breakdown.area.s)).toEqual([1, 0.5, 0]);
  });
  it('area: falls back to p10/p90 of candidates', () => {
    const ls = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130].map((a) => lst({ area_m2: a }));
    const r = scoreListings(ls, crit({ weights: only('area') }), NOW);
    const by = new Map(r.map((x) => [x.listingId, x.breakdown.area.s]));
    expect(by.get(ls[0]!.id)).toBe(0);
    expect(by.get(ls[10]!.id)).toBe(1);
    expect(by.get(ls[5]!.id)).toBeCloseTo(0.5);
  });
  it('area: missing area or degenerate range -> 0.5', () => {
    expect(s1([lst({ area_m2: null }), lst()], crit()).breakdown.area.s).toBeDefined();
    expect(s1([lst()], crit()).breakdown.area.s).toBe(0.5); // single listing: p10 == p90
    const c = crit({ area_min: 50, area_max: 50 });
    expect(s1([lst()], c).breakdown.area.s).toBe(0.5);
    const r = scoreListings([lst({ area_m2: null })], crit(), NOW);
    expect(r[0]!.breakdown.area.s).toBe(0.5);
  });
  it('freshness: exp(-age/7)', () => {
    const c = crit({ weights: only('freshness') });
    expect(s1([lst()], c).breakdown.freshness.s).toBeCloseTo(1);
    const week = new Date(NOW.getTime() - 7 * 86_400_000);
    expect(s1([lst({ first_seen_at: week })], c).breakdown.freshness.s).toBeCloseTo(Math.exp(-1));
    const future = new Date(NOW.getTime() + 86_400_000);
    expect(s1([lst({ first_seen_at: future })], c).breakdown.freshness.s).toBe(1);
  });
  it('extras: 1 if any extra present, else 0', () => {
    const c = crit({ weights: only('extras') });
    expect(s1([lst({ has_elevator: true })], c).breakdown.extras.s).toBe(1);
    expect(s1([lst({ has_balcony: false })], c).breakdown.extras.s).toBe(0);
    expect(s1([lst()], c).breakdown.extras.s).toBe(0);
  });
  it('price_drop: 0/1', () => {
    const c = crit({ weights: only('price_drop') });
    expect(s1([lst({ price_dropped: true })], c).score).toBe(100);
    expect(s1([lst()], c).score).toBe(0);
  });
});

describe('scoreListings aggregate', () => {
  it('weighted formula, 1 decimal, breakdown carries weights', () => {
    const w: Weights = { ...only('condition', 3), distance: 1 };
    // condition good = 0.5 (w3), distance 1 (w1) -> 100*(1.5+1)/4 = 62.5
    const r = s1([lst()], crit({ weights: w }));
    expect(r.score).toBe(62.5);
    expect(r.breakdown.condition).toEqual({ s: 0.5, w: 3 });
    expect(r.breakdown.distance).toEqual({ s: 1, w: 1 });
  });
  it('rounds to one decimal', () => {
    const r = s1([lst({ condition: 'renovated' })], crit({ weights: { ...only('condition', 1), distance: 2 } }));
    // (0.9 + 2)/3 = 96.666..
    expect(r.score).toBe(96.7);
  });
  it('empty set and all-filtered set give []', () => {
    expect(scoreListings([], crit(), NOW)).toEqual([]);
    expect(scoreListings([lst({ removed: true })], crit(), NOW)).toEqual([]);
  });
  it('single listing works without NaN', () => {
    const r = s1([lst()], crit());
    expect(Number.isFinite(r.score)).toBe(true);
    for (const b of Object.values(r.breakdown)) expect(Number.isFinite(b.s)).toBe(true);
  });
  it('all weights zero -> score 0, no NaN', () => {
    const r = scoreListings([lst(), lst({ condition: 'new_build' })], crit({ weights: only('price_per_m2', 0) }), NOW);
    expect(r.map((x) => x.score)).toEqual([0, 0]);
  });
  it('zero price and zero area do not produce NaN', () => {
    const r = scoreListings([lst({ price_czk: 0 }), lst({ area_m2: 0 })], crit(), NOW);
    for (const x of r) {
      expect(Number.isFinite(x.score)).toBe(true);
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(100);
    }
  });
  it('sorted by score descending', () => {
    const ls = [
      lst({ condition: 'needs_renovation' }),
      lst({ condition: 'new_build' }),
      lst({ condition: 'good' }),
    ];
    const r = scoreListings(ls, crit({ weights: only('condition') }), NOW);
    expect(r.map((x) => x.listingId)).toEqual([ls[1]!.id, ls[2]!.id, ls[0]!.id]);
    const scores = r.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
  it('does not mutate input', () => {
    const ls = [lst({ condition: 'good' }), lst({ condition: 'new_build' })];
    const ids = ls.map((x) => x.id);
    scoreListings(ls, crit(), NOW);
    expect(ls.map((x) => x.id)).toEqual(ids);
  });
});
