/** Single data-access seam for all pages, backed by the database. */
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { createDb, type Db } from '../../db/index';
import {
  PORTALS, crawlRun, criteria, listing, listingState, match, priceHistory,
  type Criteria as CriteriaRow,
} from '../../db/schema';
import { DEFAULT_WEIGHTS } from '../scoring/score';
import {
  buildFactorDetails, distanceKm, groupAlsoOn, isNewListing, parseBreakdown, priceDropPct,
  weightsToFactorMap,
} from './view-logic';
import {
  FACTORS,
  type CrawlRun, type Criteria, type FactorMap, type ListingCard, type ListingDetail, type ListingStatus,
  type Portal, type RankedPage, type StatusFilter,
} from './view-types';

export const PAGE_SIZE = 24;

export interface RankedOptions {
  status?: StatusFilter;
  page?: number;
}

let cachedDb: Db | undefined;
const getDb = (): Db => (cachedDb ??= createDb());

const iso = (d: Date) => d.toISOString();

const DEFAULT_FACTOR_MAP: FactorMap = weightsToFactorMap({ ...DEFAULT_WEIGHTS });

function mapCriteria(c: CriteriaRow): Criteria {
  return {
    id: c.id,
    name: c.name,
    active: c.active,
    offer_type: c.offerType,
    city: c.city,
    localities: c.localities,
    price_min: c.priceMin,
    price_max: c.priceMax,
    layouts: c.layouts,
    area_min: c.areaMin,
    area_max: c.areaMax,
    must: { balcony: c.must.balcony === true, parking: c.must.parking === true, elevator: c.must.elevator === true },
    weights: weightsToFactorMap(c.weights),
    anchor_lat: c.anchorLat,
    anchor_lng: c.anchorLng,
    max_distance_km: c.maxDistanceKm,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
  };
}

export async function getCriteriaList(): Promise<Criteria[]> {
  const rows = await getDb().select().from(criteria).orderBy(desc(criteria.active), asc(criteria.id));
  return rows.map(mapCriteria);
}

export async function getCriteria(id: number): Promise<Criteria | null> {
  const [row] = await getDb().select().from(criteria).where(eq(criteria.id, id));
  return row ? mapCriteria(row) : null;
}

/** Blank criteria used by /criteria/new. */
export function getEmptyCriteria(): Criteria {
  const now = new Date().toISOString();
  return {
    id: 0, name: '', active: true, offer_type: 'rent', city: 'Brno', localities: [],
    price_min: null, price_max: null, layouts: [], area_min: null, area_max: null,
    must: { balcony: false, parking: false, elevator: false }, weights: { ...DEFAULT_FACTOR_MAP },
    anchor_lat: null, anchor_lng: null, max_distance_km: null, created_at: now, updated_at: now,
  };
}

const effectiveStatus = sql<string>`coalesce(${listingState.status}, 'new')`;

function statusCondition(status: StatusFilter): SQL {
  switch (status) {
    case 'hidden': return sql`${effectiveStatus} = 'hidden'`;
    case 'new': return sql`${effectiveStatus} = 'new'`;
    case 'favorite': return sql`${effectiveStatus} = 'favorite'`;
    default: return sql`${effectiveStatus} <> 'hidden'`;
  }
}

/** Listings for a criteria, sorted by score desc, one row per fingerprint. Hidden excluded unless status === 'hidden'. */
export async function getRankedListings(
  criteriaId: number,
  { status = 'all', page = 1 }: RankedOptions = {},
): Promise<RankedPage> {
  const db = getDb();
  const [crit] = await db.select().from(criteria).where(eq(criteria.id, criteriaId));
  if (!crit) return { items: [], total: 0, page: 1, page_size: PAGE_SIZE, page_count: 1 };

  // Best row per fingerprint (highest score, then cheapest), decided in SQL so pagination stays in SQL too.
  const ranked = db
    .select({
      listingId: listing.id,
      score: match.score,
      rn: sql<number>`row_number() over (partition by ${listing.fingerprint} order by ${match.score} desc, ${listing.priceCzk} asc nulls last, ${listing.id} asc)`
        .mapWith(Number)
        .as('rn'),
    })
    .from(match)
    .innerJoin(listing, eq(listing.id, match.listingId))
    .leftJoin(listingState, eq(listingState.listingId, listing.id))
    .where(and(eq(match.criteriaId, criteriaId), isNull(listing.removedAt), statusCondition(status)))
    .as('ranked');

  const [countRow] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(ranked)
    .where(eq(ranked.rn, 1));
  const total = countRow?.n ?? 0;
  const page_count = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), page_count);

  const rows = await db
    .select({
      id: listing.id, title: listing.title, portal: listing.portal, fingerprint: listing.fingerprint,
      images: listing.images, priceCzk: listing.priceCzk, feesCzk: listing.feesCzk, areaM2: listing.areaM2,
      layout: listing.layout, condition: listing.condition, localityText: listing.localityText,
      lat: listing.lat, lng: listing.lng, firstSeenAt: listing.firstSeenAt,
      score: match.score, breakdown: match.breakdown, status: listingState.status,
    })
    .from(ranked)
    .innerJoin(listing, eq(listing.id, ranked.listingId))
    .innerJoin(match, and(eq(match.listingId, listing.id), eq(match.criteriaId, criteriaId)))
    .leftJoin(listingState, eq(listingState.listingId, listing.id))
    .where(eq(ranked.rn, 1))
    .orderBy(desc(match.score), asc(listing.id))
    .limit(PAGE_SIZE)
    .offset((p - 1) * PAGE_SIZE);

  const ids = rows.map((r) => r.id);
  const fingerprints = [...new Set(rows.map((r) => r.fingerprint))];
  const [history, siblings] = ids.length === 0
    ? [[], []]
    : await Promise.all([
        db.select({ listingId: priceHistory.listingId, priceCzk: priceHistory.priceCzk })
          .from(priceHistory)
          .where(inArray(priceHistory.listingId, ids))
          .orderBy(asc(priceHistory.listingId), asc(priceHistory.observedAt), asc(priceHistory.id)),
        db.select({
          fingerprint: listing.fingerprint, listingId: listing.id, portal: listing.portal,
          url: listing.url, priceCzk: listing.priceCzk,
        })
          .from(listing)
          .where(and(inArray(listing.fingerprint, fingerprints), isNull(listing.removedAt)))
          .orderBy(asc(listing.id)),
      ]);

  const pricesById = new Map<number, number[]>();
  for (const h of history) {
    const list = pricesById.get(h.listingId);
    if (list) list.push(h.priceCzk);
    else pricesById.set(h.listingId, [h.priceCzk]);
  }
  const also = groupAlsoOn(rows.map((r) => ({ listingId: r.id, fingerprint: r.fingerprint, portal: r.portal })), siblings);
  const anchor = { lat: crit.anchorLat, lng: crit.anchorLng };
  const now = new Date();

  const items: ListingCard[] = rows.map((r) => {
    const st: ListingStatus = r.status ?? 'new';
    const g = also.get(r.id);
    return {
      id: r.id,
      criteria_id: criteriaId,
      title: r.title,
      portal: r.portal,
      also_on: g?.also_on ?? [],
      also_on_links: g?.also_on_links ?? [],
      image: r.images[0] ?? null,
      price_czk: r.priceCzk,
      fees_czk: r.feesCzk,
      area_m2: r.areaM2,
      layout: r.layout,
      condition: r.condition,
      locality_text: r.localityText ?? '',
      distance_km: distanceKm(anchor, r),
      score: r.score,
      breakdown: parseBreakdown(r.breakdown).scores,
      status: st,
      is_new: isNewListing(r.status, r.firstSeenAt, now),
      price_drop_pct: priceDropPct(pricesById.get(r.id) ?? []),
    };
  });
  return { items, total, page: p, page_size: PAGE_SIZE, page_count };
}

/** Listing detail. Uses `criteriaId` when given, otherwise the criteria with the best match. */
export async function getListing(id: number, criteriaId?: number): Promise<ListingDetail | null> {
  const db = getDb();
  const [l] = await db.select().from(listing).where(eq(listing.id, id));
  if (!l) return null;

  const matchRows = await db
    .select({ match, criteria })
    .from(match)
    .innerJoin(criteria, eq(criteria.id, match.criteriaId))
    .where(and(eq(match.listingId, id), criteriaId ? eq(match.criteriaId, criteriaId) : undefined))
    .orderBy(desc(match.score))
    .limit(1);
  const best = matchRows[0];

  const [state] = await db.select().from(listingState).where(eq(listingState.listingId, id));
  const history = await db
    .select({ priceCzk: priceHistory.priceCzk, observedAt: priceHistory.observedAt })
    .from(priceHistory)
    .where(eq(priceHistory.listingId, id))
    .orderBy(asc(priceHistory.observedAt), asc(priceHistory.id));
  const siblings = await db
    .select({ portal: listing.portal, url: listing.url, priceCzk: listing.priceCzk })
    .from(listing)
    .where(and(eq(listing.fingerprint, l.fingerprint), ne(listing.id, id), isNull(listing.removedAt)))
    .orderBy(asc(listing.id));

  const prices = history.map((h) => h.priceCzk);
  const drop = priceDropPct(prices);
  const anchorCrit = best?.criteria;
  const { scores, weights } = best
    ? parseBreakdown(best.match.breakdown)
    : { scores: { ...DEFAULT_FACTOR_MAP }, weights: { ...DEFAULT_FACTOR_MAP } };
  if (!best) for (const f of FACTORS) scores[f] = 0;
  const dist = anchorCrit ? distanceKm({ lat: anchorCrit.anchorLat, lng: anchorCrit.anchorLng }, l) : null;
  const now = new Date();
  const ageDays = Math.max(0, Math.floor((now.getTime() - l.firstSeenAt.getTime()) / 86_400_000));
  const status: ListingStatus = state?.status ?? 'new';

  const sources = [
    { portal: l.portal as Portal, url: l.url, price_czk: l.priceCzk ?? 0 },
    ...siblings.map((s) => ({ portal: s.portal as Portal, url: s.url, price_czk: s.priceCzk ?? 0 })),
  ];

  return {
    id: l.id,
    title: l.title,
    portal: l.portal,
    also_on: [...new Set(siblings.map((s) => s.portal).filter((p) => p !== l.portal))],
    also_on_links: siblings.map((s) => ({ portal: s.portal, url: s.url, price_czk: s.priceCzk ?? 0 })),
    image: l.images[0] ?? null,
    price_czk: l.priceCzk,
    fees_czk: l.feesCzk,
    area_m2: l.areaM2,
    layout: l.layout,
    condition: l.condition,
    locality_text: l.localityText ?? '',
    distance_km: dist,
    score: best?.match.score ?? 0,
    breakdown: scores,
    status,
    is_new: isNewListing(state?.status ?? null, l.firstSeenAt, now),
    price_drop_pct: drop,
    offer_type: l.offerType,
    city: l.city ?? '',
    district: l.district,
    floor: l.floor,
    has_balcony: l.hasBalcony,
    has_parking: l.hasParking,
    has_elevator: l.hasElevator,
    images: l.images,
    first_seen_at: iso(l.firstSeenAt),
    last_seen_at: iso(l.lastSeenAt),
    removed_at: l.removedAt ? iso(l.removedAt) : null,
    price_history: history.map((h) => ({ price_czk: h.priceCzk, observed_at: iso(h.observedAt) })),
    sources,
    factor_details: buildFactorDetails(scores, weights, {
      priceCzk: l.priceCzk,
      areaM2: l.areaM2,
      condition: l.condition,
      distanceKm: dist,
      maxDistanceKm: anchorCrit?.maxDistanceKm ?? null,
      ageDays,
      hasBalcony: l.hasBalcony,
      hasParking: l.hasParking,
      hasElevator: l.hasElevator,
      priceDropPct: drop,
    }),
    note: state?.note ?? '',
    criteria_id: best?.criteria.id ?? 0,
  };
}

/** Latest run per portal; portals that never ran get a placeholder row (id 0, empty started_at). */
export async function getHealth(): Promise<CrawlRun[]> {
  const db = getDb();
  return Promise.all(
    PORTALS.map(async (portal): Promise<CrawlRun> => {
      const [r] = await db
        .select()
        .from(crawlRun)
        .where(eq(crawlRun.portal, portal))
        .orderBy(desc(crawlRun.startedAt), desc(crawlRun.id))
        .limit(1);
      if (!r) {
        return {
          id: 0, portal, runner: 'manual', started_at: '', finished_at: null, status: 'never_run',
          pages: 0, fetched: 0, new_count: 0, updated_count: 0, error: null,
        };
      }
      return {
        id: r.id, portal: r.portal, runner: r.runner, started_at: iso(r.startedAt),
        finished_at: r.finishedAt ? iso(r.finishedAt) : null, status: r.status, pages: r.pages,
        fetched: r.fetched, new_count: r.newCount, updated_count: r.updatedCount, error: r.error,
      };
    }),
  );
}
