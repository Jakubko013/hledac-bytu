/** Pure helpers behind view-data.ts (no DB access), unit-tested in tests/web. */
import { haversineKm, type LatLng } from '../scoring/geo';
import { FACTORS, type Condition, type Factor, type FactorDetail, type FactorMap, type ListingSource, type Portal } from './view-types';

export const NEW_WINDOW_MS = 48 * 3_600_000;

/** DB weight/breakdown key -> view-model factor key. */
export const DB_KEY_BY_FACTOR: Record<Factor, string> = {
  price_per_m2: 'price_per_m2',
  distance_to_centre: 'distance',
  condition: 'condition',
  area: 'area',
  freshness: 'freshness',
  extras: 'extras',
  price_drop: 'price_drop',
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** DB weights (`distance`) -> view FactorMap (`distance_to_centre`). */
export function weightsToFactorMap(weights: Record<string, unknown>): FactorMap {
  const out = {} as FactorMap;
  for (const f of FACTORS) out[f] = num(weights[DB_KEY_BY_FACTOR[f]]);
  return out;
}

/** View FactorMap -> DB weights keys. */
export function factorMapToWeights(map: FactorMap) {
  return {
    price_per_m2: map.price_per_m2,
    distance: map.distance_to_centre,
    condition: map.condition,
    area: map.area,
    freshness: map.freshness,
    extras: map.extras,
    price_drop: map.price_drop,
  };
}

/** Stored breakdown `{ key: { s, w } }` -> separate score and weight maps. Tolerates malformed JSON. */
export function parseBreakdown(raw: unknown): { scores: FactorMap; weights: FactorMap } {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const scores = {} as FactorMap;
  const weights = {} as FactorMap;
  for (const f of FACTORS) {
    const e = obj[DB_KEY_BY_FACTOR[f]];
    const rec = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
    scores[f] = num(rec.s);
    weights[f] = num(rec.w);
  }
  return { scores, weights };
}

/** Percent drop between the last two prices (chronological), or null when not dropped. */
export function priceDropPct(prices: readonly number[]): number | null {
  const n = prices.length;
  if (n < 2) return null;
  const prev = prices[n - 2]!;
  const last = prices[n - 1]!;
  if (!(prev > 0) || last >= prev) return null;
  return Math.max(1, Math.round(((prev - last) / prev) * 100));
}

export function isNewListing(status: string | null, firstSeenAt: Date, now: Date = new Date()): boolean {
  return (status ?? 'new') === 'new' && now.getTime() - firstSeenAt.getTime() < NEW_WINDOW_MS;
}

export function distanceKm(
  anchor: { lat: number | null; lng: number | null },
  point: { lat: number | null; lng: number | null },
): number | null {
  if (anchor.lat == null || anchor.lng == null || point.lat == null || point.lng == null) return null;
  const a: LatLng = { lat: anchor.lat, lng: anchor.lng };
  return Math.round(haversineKm(a, { lat: point.lat, lng: point.lng }) * 10) / 10;
}

export interface SiblingRow {
  fingerprint: string;
  listingId: number;
  portal: Portal;
  url: string;
  priceCzk: number | null;
}

/**
 * Dedup grouping: for each primary (best row of its fingerprint), collects the other portals
 * and urls of same-fingerprint listings. Returns a map keyed by the primary listing id.
 */
export function groupAlsoOn(
  primaries: readonly { listingId: number; fingerprint: string; portal: Portal }[],
  siblings: readonly SiblingRow[],
): Map<number, { also_on: Portal[]; also_on_links: ListingSource[] }> {
  const byFp = new Map<string, SiblingRow[]>();
  for (const s of siblings) {
    const list = byFp.get(s.fingerprint);
    if (list) list.push(s);
    else byFp.set(s.fingerprint, [s]);
  }
  const out = new Map<number, { also_on: Portal[]; also_on_links: ListingSource[] }>();
  for (const p of primaries) {
    const others = (byFp.get(p.fingerprint) ?? []).filter((s) => s.listingId !== p.listingId);
    const links = others.map((s) => ({ portal: s.portal, url: s.url, price_czk: s.priceCzk ?? 0 }));
    const portals = [...new Set(others.map((s) => s.portal).filter((portal) => portal !== p.portal))];
    out.set(p.listingId, { also_on: portals, also_on_links: links });
  }
  return out;
}

const CONDITION_TEXT: Record<Condition, string> = {
  new_build: 'novostavba',
  renovated: 'po rekonstrukci',
  good: 'dobrý stav',
  unknown: 'stav neznámý',
  needs_renovation: 'k rekonstrukci',
};

const cz = (n: number, digits = 0) => n.toLocaleString('cs-CZ', { maximumFractionDigits: digits });

export interface ExplainInput {
  priceCzk: number | null;
  areaM2: number | null;
  condition: Condition;
  distanceKm: number | null;
  maxDistanceKm: number | null;
  ageDays: number;
  hasBalcony: boolean | null;
  hasParking: boolean | null;
  hasElevator: boolean | null;
  priceDropPct: number | null;
}

/** Czech explanation per factor, derived from the stored breakdown scores (0-1) and listing facts. */
export function explainFactors(scores: FactorMap, i: ExplainInput): Record<Factor, string> {
  const pct = (f: Factor) => Math.round(scores[f] * 100);
  const extras = [i.hasBalcony && 'balkon', i.hasParking && 'parkování', i.hasElevator && 'výtah']
    .filter(Boolean)
    .join(', ');
  const perM2 = i.priceCzk != null && i.areaM2 ? Math.round(i.priceCzk / i.areaM2) : null;
  return {
    price_per_m2:
      perM2 == null
        ? 'Cena nebo plocha chybí – neutrální hodnota.'
        : `${cz(perM2)} Kč/m², výhodnost ${pct('price_per_m2')} % vůči mediánu nabídek tohoto hledání.`,
    distance_to_centre:
      i.distanceKm == null
        ? 'Bez souřadnic – neutrální hodnota 0,5.'
        : `${cz(i.distanceKm, 1)} km od středu${i.maxDistanceKm ? ` (limit ${cz(i.maxDistanceKm, 1)} km)` : ''}; čím blíž, tím lépe.`,
    condition: `Stav: ${CONDITION_TEXT[i.condition]}.`,
    area:
      i.areaM2 == null
        ? 'Plocha chybí – neutrální hodnota.'
        : `${cz(i.areaM2, 1)} m², ${pct('area')} % požadovaného rozsahu plochy.`,
    freshness:
      i.ageDays < 1 ? 'Nabídka je dnešní.' : `Nabídka je stará ${cz(i.ageDays)} dní; váha klesá exponenciálně.`,
    extras: extras ? `Vybavení: ${extras}.` : 'Žádné z hlídaných vybavení.',
    price_drop: i.priceDropPct ? `Cena klesla o ${i.priceDropPct} %.` : 'Cena nebyla snížena.',
  };
}

export function buildFactorDetails(
  scores: FactorMap,
  weights: FactorMap,
  input: ExplainInput,
): FactorDetail[] {
  const text = explainFactors(scores, input);
  return FACTORS.map((factor) => ({ factor, score: scores[factor], weight: weights[factor], explanation: text[factor] }));
}
