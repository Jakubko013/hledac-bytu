import { cityCentre, haversineKm, normalizeText, type LatLng } from './geo.ts';

export type Weights = {
  price_per_m2: number;
  distance: number;
  condition: number;
  area: number;
  freshness: number;
  extras: number;
  price_drop: number;
};

export const DEFAULT_WEIGHTS: Readonly<Weights> = {
  price_per_m2: 3,
  distance: 3,
  condition: 3,
  area: 3,
  freshness: 1,
  extras: 0.5,
  price_drop: 0.5,
};

export type Condition = 'new_build' | 'renovated' | 'good' | 'unknown' | 'needs_renovation';

export type ScoreCriteria = {
  offer_type: string;
  city: string;
  localities: string[];
  price_min?: number | null;
  price_max?: number | null;
  layouts: string[];
  area_min?: number | null;
  area_max?: number | null;
  must: { balcony?: boolean; parking?: boolean; elevator?: boolean };
  weights: Weights;
  anchor_lat?: number | null;
  anchor_lng?: number | null;
  max_distance_km?: number | null;
};

export type ScoreListing = {
  id: number | string;
  offer_type: string;
  price_czk: number | null;
  area_m2: number | null;
  layout: string | null;
  condition: Condition | string;
  lat: number | null;
  lng: number | null;
  city: string | null;
  district: string | null;
  locality_text: string | null;
  has_balcony: boolean | null;
  has_parking: boolean | null;
  has_elevator: boolean | null;
  first_seen_at: Date;
  price_dropped: boolean;
  removed: boolean;
  hidden: boolean;
};

export type ScoreBreakdown = Record<keyof Weights, { s: number; w: number }>;
export type ScoreResult = { listingId: ScoreListing['id']; score: number; breakdown: ScoreBreakdown };

const DEFAULT_MAX_DISTANCE_KM = 10;
const MISSING = 0.5;
const DAY_MS = 86_400_000;

const CONDITION_SCORES: Record<string, number> = {
  new_build: 1.0,
  renovated: 0.9,
  good: 0.5,
  unknown: 0.4,
  needs_renovation: 0.1,
};

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : MISSING);

function textFields(l: ScoreListing): string[] {
  return [l.city, l.district, l.locality_text]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map(normalizeText);
}

function matchesPlace(fields: string[], place: string): boolean {
  const p = normalizeText(place);
  return p !== '' && fields.some((f) => f === p || f.includes(p));
}

export function passesHardFilters(l: ScoreListing, c: ScoreCriteria): boolean {
  // hidden listings stay scored (the view filters by status) so they can be unhidden without a rescore
  if (l.removed) return false;
  if (l.offer_type !== c.offer_type) return false;

  const fields = textFields(l);
  if (c.city.trim() !== '' && !matchesPlace(fields, c.city)) return false;
  if (c.localities.length > 0 && !c.localities.some((loc) => matchesPlace(fields, loc))) return false;

  if (c.price_min != null && (l.price_czk == null || l.price_czk < c.price_min)) return false;
  if (c.price_max != null && (l.price_czk == null || l.price_czk > c.price_max)) return false;
  if (c.area_min != null && (l.area_m2 == null || l.area_m2 < c.area_min)) return false;
  if (c.area_max != null && (l.area_m2 == null || l.area_m2 > c.area_max)) return false;

  if (c.layouts.length > 0) {
    if (l.layout == null) return false;
    const layout = normalizeText(l.layout);
    if (!c.layouts.some((x) => normalizeText(x) === layout)) return false;
  }

  if (c.must.balcony && l.has_balcony !== true) return false;
  if (c.must.parking && l.has_parking !== true) return false;
  if (c.must.elevator && l.has_elevator !== true) return false;
  return true;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Linear-interpolated percentile, p in [0,1]. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

function resolveAnchor(c: ScoreCriteria): LatLng | null {
  if (c.anchor_lat != null && c.anchor_lng != null) return { lat: c.anchor_lat, lng: c.anchor_lng };
  return cityCentre(c.city);
}

export function scoreListings(
  listings: ScoreListing[],
  c: ScoreCriteria,
  now: Date = new Date(),
): ScoreResult[] {
  const candidates = listings.filter((l) => passesHardFilters(l, c));
  if (candidates.length === 0) return [];

  // hidden listings are scored but must not skew the market statistics
  const stats = candidates.filter((l) => !l.hidden);
  const ppm2 = stats
    .filter((l) => l.price_czk != null && l.area_m2 != null && l.area_m2 > 0)
    .map((l) => l.price_czk! / l.area_m2!);
  const medianPpm2 = median(ppm2);

  const areas = stats.map((l) => l.area_m2).filter((a): a is number => a != null);
  const areaLo = c.area_min ?? percentile(areas, 0.1);
  const areaHi = c.area_max ?? percentile(areas, 0.9);

  const anchor = resolveAnchor(c);
  const maxDist = c.max_distance_km != null && c.max_distance_km > 0 ? c.max_distance_km : DEFAULT_MAX_DISTANCE_KM;

  const weightSum = Object.values(c.weights).reduce((a, b) => a + b, 0);

  const results = candidates.map((l): ScoreResult => {
    let sPrice = MISSING;
    if (medianPpm2 != null && medianPpm2 > 0 && l.price_czk != null && l.area_m2 != null && l.area_m2 > 0) {
      sPrice = clamp01(0.5 + (medianPpm2 - l.price_czk / l.area_m2) / medianPpm2);
    }

    let sDistance = MISSING;
    if (anchor && l.lat != null && l.lng != null) {
      sDistance = clamp01(1 - haversineKm(anchor, { lat: l.lat, lng: l.lng }) / maxDist);
    }

    let sArea = MISSING;
    if (l.area_m2 != null && areaLo != null && areaHi != null && areaHi > areaLo) {
      sArea = clamp01((l.area_m2 - areaLo) / (areaHi - areaLo));
    }

    const sCondition = CONDITION_SCORES[l.condition] ?? CONDITION_SCORES.unknown!;

    const ageDays = Math.max(0, (now.getTime() - l.first_seen_at.getTime()) / DAY_MS);
    const sFreshness = clamp01(Math.exp(-ageDays / 7));

    const sExtras = l.has_balcony === true || l.has_parking === true || l.has_elevator === true ? 1 : 0;
    const sDrop = l.price_dropped ? 1 : 0;

    const s: Record<keyof Weights, number> = {
      price_per_m2: sPrice,
      distance: sDistance,
      condition: sCondition,
      area: sArea,
      freshness: sFreshness,
      extras: sExtras,
      price_drop: sDrop,
    };

    const breakdown = {} as ScoreBreakdown;
    let weighted = 0;
    for (const key of Object.keys(s) as Array<keyof Weights>) {
      const w = c.weights[key];
      breakdown[key] = { s: s[key], w };
      weighted += w * s[key];
    }

    const raw = weightSum > 0 ? (100 * weighted) / weightSum : 0;
    const score = Number.isFinite(raw) ? Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10 : 0;
    return { listingId: l.id, score, breakdown };
  });

  return results.sort((a, b) => b.score - a.score);
}
