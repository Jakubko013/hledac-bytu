import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const PORTALS = ['sreality', 'bezrealitky', 'idnes'] as const;
export const OFFER_TYPES = ['rent', 'sale'] as const;
export const CONDITIONS = ['new_build', 'renovated', 'good', 'needs_renovation', 'unknown'] as const;
export const LISTING_STATUSES = ['new', 'seen', 'favorite', 'hidden'] as const;
export const RUNNERS = ['netlify', 'github', 'manual'] as const;
export const RUN_STATUSES = ['running', 'ok', 'partial', 'failed'] as const;

export type Portal = (typeof PORTALS)[number];
export type OfferType = (typeof OFFER_TYPES)[number];
export type Condition = (typeof CONDITIONS)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type Runner = (typeof RUNNERS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export type Weights = {
  price_per_m2: number;
  distance: number;
  condition: number;
  area: number;
  freshness: number;
  extras: number;
  price_drop: number;
};

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const listing = pgTable(
  'listing',
  {
    id: serial('id').primaryKey(),
    portal: text('portal', { enum: PORTALS }).notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    offerType: text('offer_type', { enum: OFFER_TYPES }).notNull(),
    priceCzk: integer('price_czk'),
    feesCzk: integer('fees_czk'),
    areaM2: doublePrecision('area_m2'),
    layout: text('layout'),
    floor: integer('floor'),
    condition: text('condition', { enum: CONDITIONS }).notNull().default('unknown'),
    hasBalcony: boolean('has_balcony'),
    hasParking: boolean('has_parking'),
    hasElevator: boolean('has_elevator'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    localityText: text('locality_text'),
    city: text('city'),
    district: text('district'),
    images: jsonb('images').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    raw: jsonb('raw').$type<unknown>(),
    fingerprint: text('fingerprint').notNull(),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    removedAt: tstz('removed_at'),
  },
  (t) => [
    uniqueIndex('listing_portal_external_id_uq').on(t.portal, t.externalId),
    index('listing_fingerprint_idx').on(t.fingerprint),
    index('listing_offer_city_idx').on(t.offerType, t.city),
  ],
);

export const priceHistory = pgTable(
  'price_history',
  {
    id: serial('id').primaryKey(),
    listingId: integer('listing_id')
      .notNull()
      .references(() => listing.id, { onDelete: 'cascade' }),
    priceCzk: integer('price_czk').notNull(),
    observedAt: tstz('observed_at').notNull().defaultNow(),
  },
  (t) => [index('price_history_listing_observed_idx').on(t.listingId, t.observedAt)],
);

export const criteria = pgTable('criteria', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  offerType: text('offer_type', { enum: OFFER_TYPES }).notNull(),
  city: text('city').notNull(),
  localities: text('localities').array().notNull().default(sql`'{}'::text[]`),
  priceMin: integer('price_min'),
  priceMax: integer('price_max'),
  layouts: text('layouts').array().notNull().default(sql`'{}'::text[]`),
  areaMin: doublePrecision('area_min'),
  areaMax: doublePrecision('area_max'),
  must: jsonb('must').$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  weights: jsonb('weights').$type<Weights>().notNull(),
  anchorLat: doublePrecision('anchor_lat'),
  anchorLng: doublePrecision('anchor_lng'),
  maxDistanceKm: doublePrecision('max_distance_km'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const match = pgTable(
  'match',
  {
    criteriaId: integer('criteria_id')
      .notNull()
      .references(() => criteria.id, { onDelete: 'cascade' }),
    listingId: integer('listing_id')
      .notNull()
      .references(() => listing.id, { onDelete: 'cascade' }),
    score: doublePrecision('score').notNull(),
    breakdown: jsonb('breakdown').$type<Record<string, unknown>>().notNull(),
    computedAt: tstz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.criteriaId, t.listingId] }),
    index('match_criteria_score_idx').on(t.criteriaId, t.score.desc()),
    index('match_listing_idx').on(t.listingId),
  ],
);

export const listingState = pgTable('listing_state', {
  listingId: integer('listing_id')
    .primaryKey()
    .references(() => listing.id, { onDelete: 'cascade' }),
  status: text('status', { enum: LISTING_STATUSES }).notNull().default('new'),
  note: text('note'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const crawlRun = pgTable(
  'crawl_run',
  {
    id: serial('id').primaryKey(),
    portal: text('portal', { enum: PORTALS }).notNull(),
    runner: text('runner', { enum: RUNNERS }).notNull(),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('running'),
    pages: integer('pages').notNull().default(0),
    fetched: integer('fetched').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('crawl_run_portal_started_idx').on(t.portal, t.startedAt.desc())],
);

/** UNUSED: left over from the removed login rate limiter; kept to avoid a destructive migration. */
export const loginAttempt = pgTable(
  'login_attempt',
  {
    id: serial('id').primaryKey(),
    key: text('key').notNull(),
    attemptedAt: tstz('attempted_at').notNull().defaultNow(),
  },
  (t) => [index('login_attempt_key_attempted_idx').on(t.key, t.attemptedAt)],
);

export type Listing = typeof listing.$inferSelect;
export type NewListing = typeof listing.$inferInsert;
export type PriceHistory = typeof priceHistory.$inferSelect;
export type NewPriceHistory = typeof priceHistory.$inferInsert;
export type Criteria = typeof criteria.$inferSelect;
export type NewCriteria = typeof criteria.$inferInsert;
export type Match = typeof match.$inferSelect;
export type NewMatch = typeof match.$inferInsert;
export type ListingState = typeof listingState.$inferSelect;
export type NewListingState = typeof listingState.$inferInsert;
export type CrawlRun = typeof crawlRun.$inferSelect;
export type NewCrawlRun = typeof crawlRun.$inferInsert;
export type LoginAttempt = typeof loginAttempt.$inferSelect;
export type NewLoginAttempt = typeof loginAttempt.$inferInsert;
