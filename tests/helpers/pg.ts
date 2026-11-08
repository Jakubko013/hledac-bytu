import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../db/schema';
import type { Db } from '../../db/index';
import type { NormalizedListing } from '../../src/crawler/types';
import { fingerprint } from '../../src/crawler/fingerprint';

const MIGRATIONS = join(import.meta.dirname, '../../netlify/database/migrations');

export interface TestDb {
  /** Typed as production `Db` (test-only cast: PGlite and netlify-db drizzle share the pg dialect). */
  db: Db;
  pg: PGlite;
  close(): Promise<void>;
}

/** Fresh in-process Postgres with the real migration SQL applied. */
export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  for (const dir of readdirSync(MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const sqlText = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  const db = drizzle({ client: pg, schema }) as unknown as Db;
  return { db, pg, close: () => pg.close() };
}

export const WEIGHTS = {
  price_per_m2: 3, distance: 3, condition: 3, area: 3, freshness: 1, extras: 0.5, price_drop: 0.5,
};

export function makeListing(o: Partial<NormalizedListing> = {}): NormalizedListing {
  const base: NormalizedListing = {
    portal: 'sreality',
    externalId: 'ext-1',
    url: 'https://example.test/1',
    title: 'Byt 2+kk',
    offerType: 'rent',
    priceCzk: 20000,
    feesCzk: null,
    areaM2: 50,
    layout: '2+kk',
    floor: null,
    condition: 'good',
    hasBalcony: null,
    hasParking: null,
    hasElevator: null,
    lat: 49.2,
    lng: 16.6,
    localityText: 'Brno-střed',
    city: 'Brno',
    district: null,
    images: [],
    raw: { a: 1 },
    fingerprint: '',
    ...o,
  };
  base.fingerprint = o.fingerprint ?? fingerprint(base);
  return base;
}

export const insertCriteria = (db: Db, o: Partial<typeof schema.criteria.$inferInsert> = {}) =>
  db
    .insert(schema.criteria)
    .values({ name: 'Test', offerType: 'rent', city: 'Brno', anchorLat: 49.1951, anchorLng: 16.6068, weights: WEIGHTS, ...o })
    .returning()
    .then((r) => r[0]!);
