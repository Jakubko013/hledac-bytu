import { and, eq, inArray, sql } from 'drizzle-orm';
import { listing, priceHistory } from '../../db/schema';
import type { Db } from '../../db/index';
import { fingerprint } from './fingerprint';
import type { NormalizedListing } from './types';
import { filterHttpsUrls, safeHttpsUrl } from './url';

export interface UpsertResult {
  newCount: number;
  updatedCount: number;
}

export interface UpsertDecision {
  isNew: boolean;
  /** Insert a price_history row: first sighting with a price, or the price changed. */
  recordPrice: boolean;
}

/** Pure decision logic. `existing` is undefined for unknown listings; its price may be null. */
export function decideUpsert(
  existing: { priceCzk: number | null } | undefined,
  priceCzk: number | null,
): UpsertDecision {
  if (!existing) return { isNew: true, recordPrice: priceCzk != null };
  return { isNew: false, recordPrice: priceCzk != null && existing.priceCzk !== priceCzk };
}

export interface KnownRow {
  priceCzk: number | null;
  condition: string;
  lat: number | null;
}

/** Max detail re-fetches per run for known rows that still miss detail-only fields. */
export const MAX_DETAIL_RETRIES = 50;

/**
 * True when the listing is unknown or its price changed. Known rows that still lack detail data
 * (condition `unknown` or no lat) are retried while `retryBudget.left` > 0 (each retry consumes one).
 */
export function needsDetailFor(
  known: ReadonlyMap<string, KnownRow>,
  externalId: string,
  priceCzk: number | null,
  retryBudget?: { left: number },
): boolean {
  const row = known.get(externalId);
  if (!row || row.priceCzk !== priceCzk) return true;
  if ((row.condition === 'unknown' || row.lat == null) && retryBudget && retryBudget.left > 0) {
    retryBudget.left--;
    return true;
  }
  return false;
}

/**
 * Collapses duplicates inside one batch so ON CONFLICT never hits a row twice. Later sightings win but
 * are merged with `mergeListing`, so a list-only sighting never erases detail from an earlier one.
 */
export function dedupeBatch(items: NormalizedListing[]): NormalizedListing[] {
  const byKey = new Map<string, NormalizedListing>();
  for (const l of items) {
    const key = `${l.portal}\u0000${l.externalId}`;
    byKey.set(key, mergeListing(byKey.get(key), l));
  }
  return [...byKey.values()];
}


/** Columns a list-only sighting may leave empty; known values are kept. */
export type ExistingListing = Pick<
  NormalizedListing,
  | 'portal' | 'externalId' | 'offerType' | 'priceCzk' | 'feesCzk' | 'areaM2' | 'layout' | 'floor' | 'condition'
  | 'hasBalcony' | 'hasParking' | 'hasElevator' | 'lat' | 'lng' | 'localityText' | 'city' | 'district' | 'images'
>;

/**
 * Merges a (possibly list-only) sighting into the stored row: nulls, 'unknown' condition and shorter
 * image lists never erase known data. Price, title, url and raw always come from the incoming sighting.
 * The fingerprint is recomputed from the merged values.
 */
export function mergeListing(existing: ExistingListing | undefined, incoming: NormalizedListing): NormalizedListing {
  if (!existing) return incoming;
  const merged: NormalizedListing = {
    ...incoming,
    feesCzk: incoming.feesCzk ?? existing.feesCzk,
    areaM2: incoming.areaM2 ?? existing.areaM2,
    layout: incoming.layout ?? existing.layout,
    floor: incoming.floor ?? existing.floor,
    condition: incoming.condition === 'unknown' ? existing.condition : incoming.condition,
    hasBalcony: incoming.hasBalcony ?? existing.hasBalcony,
    hasParking: incoming.hasParking ?? existing.hasParking,
    hasElevator: incoming.hasElevator ?? existing.hasElevator,
    lat: incoming.lat ?? existing.lat,
    lng: incoming.lng ?? existing.lng,
    localityText: incoming.localityText ?? existing.localityText,
    city: incoming.city ?? existing.city,
    district: incoming.district ?? existing.district,
    images: incoming.images.length >= existing.images.length ? incoming.images : existing.images,
  };
  merged.fingerprint = fingerprint(merged);
  return merged;
}

/** Defense in depth: drops listings whose url is not https and strips non-https images. */
export function sanitizeListings(items: NormalizedListing[]): { safe: NormalizedListing[]; dropped: number } {
  const safe: NormalizedListing[] = [];
  for (const l of items) {
    const url = safeHttpsUrl(l.url);
    if (!url) continue;
    safe.push({ ...l, url, images: filterHttpsUrls(l.images) });
  }
  return { safe, dropped: items.length - safe.length };
}

const CHUNK = 200;

/** Known `external_id -> {price, condition, lat}` for one portal; loaded once per run. */
export async function loadKnownRows(db: Db, portal: NormalizedListing['portal']) {
  const rows = await db
    .select({ externalId: listing.externalId, priceCzk: listing.priceCzk, condition: listing.condition, lat: listing.lat })
    .from(listing)
    .where(eq(listing.portal, portal));
  return new Map<string, KnownRow>(rows.map((r) => [r.externalId, { priceCzk: r.priceCzk, condition: r.condition, lat: r.lat }]));
}

const excluded = (col: string) => sql.raw(`excluded."${col}"`);
const keep = (col: string) => sql.raw(`coalesce(excluded."${col}", listing."${col}")`);

/**
 * Batch upsert on (portal, external_id). first_seen_at is only set on insert; last_seen_at is always
 * now and removed_at is cleared. price_history gets a row on the first sighting and on price change.
 */
export async function upsertListings(db: Db, items: NormalizedListing[]): Promise<UpsertResult> {
  const result: UpsertResult = { newCount: 0, updatedCount: 0 };
  // defensive and silent: runPortal already sanitizes (and logs) before calling this
  const batch = dedupeBatch(sanitizeListings(items).safe);
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    const part = await upsertChunk(db, chunk);
    result.newCount += part.newCount;
    result.updatedCount += part.updatedCount;
  }
  return result;
}

async function upsertChunk(db: Db, chunk: NormalizedListing[]): Promise<UpsertResult> {
  const portals = [...new Set(chunk.map((l) => l.portal))];
  const existingRows = await db
    .select({
      portal: listing.portal, externalId: listing.externalId, offerType: listing.offerType,
      priceCzk: listing.priceCzk, feesCzk: listing.feesCzk, areaM2: listing.areaM2, layout: listing.layout,
      floor: listing.floor, condition: listing.condition, hasBalcony: listing.hasBalcony,
      hasParking: listing.hasParking, hasElevator: listing.hasElevator, lat: listing.lat, lng: listing.lng, localityText: listing.localityText,
      city: listing.city, district: listing.district, images: listing.images,
    })
    .from(listing)
    .where(
      and(inArray(listing.portal, portals), inArray(listing.externalId, chunk.map((l) => l.externalId))),
    );
  const existing = new Map(existingRows.map((r) => [`${r.portal}\u0000${r.externalId}`, r]));

  const merged = chunk.map((l) => mergeListing(existing.get(`${l.portal}\u0000${l.externalId}`), l));
  const now = new Date();
  const saved = await db
    .insert(listing)
    .values(merged.map((l) => ({ ...l, firstSeenAt: now, lastSeenAt: now, removedAt: null })))
    .onConflictDoUpdate({
      target: [listing.portal, listing.externalId],
      set: {
        url: excluded('url'),
        title: excluded('title'),
        offerType: excluded('offer_type'),
        priceCzk: excluded('price_czk'),
        feesCzk: keep('fees_czk'),
        areaM2: keep('area_m2'),
        layout: keep('layout'),
        floor: keep('floor'),
        condition: sql`case when excluded."condition" = 'unknown' then listing."condition" else excluded."condition" end`,
        hasBalcony: keep('has_balcony'),
        hasParking: keep('has_parking'),
        hasElevator: keep('has_elevator'),
        lat: keep('lat'),
        lng: keep('lng'),
        localityText: keep('locality_text'),
        city: keep('city'),
        district: keep('district'),
        images: sql`case when jsonb_array_length(excluded."images") < jsonb_array_length(listing."images") then listing."images" else excluded."images" end`,
        raw: excluded('raw'),
        fingerprint: excluded('fingerprint'),
        lastSeenAt: excluded('last_seen_at'),
        removedAt: sql`null`,
      },
    })
    .returning({ id: listing.id, portal: listing.portal, externalId: listing.externalId });

  const idByKey = new Map(saved.map((r) => [`${r.portal}\u0000${r.externalId}`, r.id]));
  const result: UpsertResult = { newCount: 0, updatedCount: 0 };
  const history: { listingId: number; priceCzk: number; observedAt: Date }[] = [];
  for (const l of chunk) {
    const key = `${l.portal}\u0000${l.externalId}`;
    const decision = decideUpsert(existing.get(key), l.priceCzk);
    if (decision.isNew) result.newCount++;
    else result.updatedCount++;
    const id = idByKey.get(key);
    if (decision.recordPrice && id != null && l.priceCzk != null) {
      history.push({ listingId: id, priceCzk: l.priceCzk, observedAt: now });
    }
  }
  if (history.length > 0) await db.insert(priceHistory).values(history);
  return result;
}
