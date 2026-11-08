import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { criteria, listing, listingState, match, priceHistory, type Criteria } from '../../db/schema';
import type { Db } from '../../db/index';
import { normalizeText } from './geo';
import { scoreListings, type ScoreCriteria, type ScoreListing, type ScoreResult } from './score';

const INSERT_CHUNK = 500;
/** First key of the per-criteria advisory lock serializing concurrent rescores. */
const RESCORE_LOCK_NS = 0x5c0e;

export function toScoreCriteria(c: Criteria): ScoreCriteria {
  return {
    offer_type: c.offerType,
    city: c.city,
    localities: c.localities,
    price_min: c.priceMin,
    price_max: c.priceMax,
    layouts: c.layouts,
    area_min: c.areaMin,
    area_max: c.areaMax,
    must: {
      balcony: c.must.balcony === true,
      parking: c.must.parking === true,
      elevator: c.must.elevator === true,
    },
    weights: c.weights,
    anchor_lat: c.anchorLat,
    anchor_lng: c.anchorLng,
    max_distance_km: c.maxDistanceKm,
  };
}

/** `prices` in chronological order; dropped when the latest price is lower than the previous one. */
export function isPriceDropped(prices: readonly number[]): boolean {
  const n = prices.length;
  return n >= 2 && prices[n - 1]! < prices[n - 2]!;
}

export interface CandidateRow {
  id: number;
  offerType: string;
  priceCzk: number | null;
  areaM2: number | null;
  layout: string | null;
  condition: string;
  lat: number | null;
  lng: number | null;
  city: string | null;
  district: string | null;
  localityText: string | null;
  hasBalcony: boolean | null;
  hasParking: boolean | null;
  hasElevator: boolean | null;
  firstSeenAt: Date;
  removedAt: Date | null;
  status: string | null;
}

export function toScoreListing(row: CandidateRow, prices: readonly number[]): ScoreListing {
  return {
    id: row.id,
    offer_type: row.offerType,
    price_czk: row.priceCzk,
    area_m2: row.areaM2,
    layout: row.layout,
    condition: row.condition,
    lat: row.lat,
    lng: row.lng,
    city: row.city,
    district: row.district,
    locality_text: row.localityText,
    has_balcony: row.hasBalcony,
    has_parking: row.hasParking,
    has_elevator: row.hasElevator,
    first_seen_at: row.firstSeenAt,
    price_dropped: isPriceDropped(prices),
    removed: row.removedAt != null,
    hidden: row.status === 'hidden',
  };
}

export function buildMatchRows(criteriaId: number, results: ScoreResult[], computedAt: Date) {
  return results.map((r) => ({
    criteriaId,
    listingId: Number(r.listingId),
    score: r.score,
    breakdown: r.breakdown as Record<string, unknown>,
    computedAt,
  }));
}

/** LIKE pattern over diacritics-stripped text, or null when no city prefilter applies. */
export function cityLikePattern(city: string): string | null {
  const n = normalizeText(city);
  if (n === '') return null;
  return `%${n.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * SQL `translate` mapping kept in sync with `normalizeText`: every Latin-1 / Latin Extended-A letter
 * (both cases) that normalizeText reduces to a single different char. Built from normalizeText itself.
 */
const CZ_MAP: [string, string][] = [];
for (let cp = 0xc0; cp <= 0x17f; cp++) {
  const ch = String.fromCharCode(cp);
  const n = normalizeText(ch);
  if (n.length === 1 && n !== ch) CZ_MAP.push([ch, n]);
}
export const CZ_FROM = CZ_MAP.map(([f]) => f).join('');
export const CZ_TO = CZ_MAP.map(([, t]) => t).join('');

async function loadCandidates(db: Db, c: Criteria) {
  const conds = [isNull(listing.removedAt), eq(listing.offerType, c.offerType)];
  const pattern = cityLikePattern(c.city);
  if (pattern) {
    conds.push(
      sql`translate(lower(coalesce(${listing.city}, '') || ' ' || coalesce(${listing.district}, '') || ' ' || coalesce(${listing.localityText}, '')), ${CZ_FROM}, ${CZ_TO}) like ${pattern}`,
    );
  }
  const where = and(...conds);

  const rows: CandidateRow[] = await db
    .select({
      id: listing.id,
      offerType: listing.offerType,
      priceCzk: listing.priceCzk,
      areaM2: listing.areaM2,
      layout: listing.layout,
      condition: listing.condition,
      lat: listing.lat,
      lng: listing.lng,
      city: listing.city,
      district: listing.district,
      localityText: listing.localityText,
      hasBalcony: listing.hasBalcony,
      hasParking: listing.hasParking,
      hasElevator: listing.hasElevator,
      firstSeenAt: listing.firstSeenAt,
      removedAt: listing.removedAt,
      status: listingState.status,
    })
    .from(listing)
    .leftJoin(listingState, eq(listingState.listingId, listing.id))
    .where(where);

  const history = await db
    .select({ listingId: priceHistory.listingId, priceCzk: priceHistory.priceCzk })
    .from(priceHistory)
    .where(inArray(priceHistory.listingId, db.select({ id: listing.id }).from(listing).where(where)))
    .orderBy(asc(priceHistory.listingId), asc(priceHistory.observedAt), asc(priceHistory.id));
  const pricesById = new Map<number, number[]>();
  for (const h of history) {
    const list = pricesById.get(h.listingId);
    if (list) list.push(h.priceCzk);
    else pricesById.set(h.listingId, [h.priceCzk]);
  }
  return rows.map((r) => toScoreListing(r, pricesById.get(r.id) ?? []));
}

async function rescoreRow(db: Db, c: Criteria): Promise<number> {
  const candidates = c.active ? await loadCandidates(db, c) : [];
  const now = new Date();
  const rows = buildMatchRows(c.id, scoreListings(candidates, toScoreCriteria(c), now), now);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RESCORE_LOCK_NS}, ${c.id})`);
    await tx.delete(match).where(eq(match.criteriaId, c.id));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(match).values(rows.slice(i, i + INSERT_CHUNK));
    }
  });
  return rows.length;
}

/** Rescores every active criteria; returns the number of match rows written. */
export async function rescoreAll(db: Db): Promise<number> {
  const rows = await db.select().from(criteria).where(eq(criteria.active, true));
  let total = 0;
  for (const c of rows) total += await rescoreRow(db, c);
  return total;
}

/** Rescores one criteria (inactive criteria end up with no matches). Returns rows written. */
export async function rescoreCriteria(db: Db, id: number): Promise<number> {
  const [c] = await db.select().from(criteria).where(eq(criteria.id, id));
  if (!c) return 0;
  return rescoreRow(db, c);
}
