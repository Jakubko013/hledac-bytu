import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { listing, priceHistory } from '../../db/schema';
import { loadKnownRows, upsertListings } from '../../src/crawler/upsert';
import { fingerprint } from '../../src/crawler/fingerprint';
import { createTestDb, makeListing, type TestDb } from '../helpers/pg';

const IMG = (n: string) => `https://img.example.test/${n}.jpg`;
let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pg.exec('TRUNCATE listing, price_history RESTART IDENTITY CASCADE'); });

const rows = () => t.db.select().from(listing).orderBy(asc(listing.id));
const history = () => t.db.select().from(priceHistory).orderBy(asc(priceHistory.id));

describe('upsertListings', () => {
  it('inserts new listings, counts them and records first price', async () => {
    const r = await upsertListings(t.db, [makeListing(), makeListing({ externalId: 'ext-2', priceCzk: null })]);
    expect(r).toEqual({ newCount: 2, updatedCount: 0 });
    expect(await rows()).toHaveLength(2);
    const h = await history();
    expect(h).toHaveLength(1);
    expect(h[0]!.priceCzk).toBe(20000);
  });

  it('empty input is a no-op', async () => {
    expect(await upsertListings(t.db, [])).toEqual({ newCount: 0, updatedCount: 0 });
  });

  it('re-sighting with same price: updated, no history row, first_seen kept, last_seen moves', async () => {
    await upsertListings(t.db, [makeListing()]);
    const [before] = await rows();
    await new Promise((r) => setTimeout(r, 15));
    const r = await upsertListings(t.db, [makeListing({ title: 'New title', url: 'https://example.test/new' })]);
    expect(r).toEqual({ newCount: 0, updatedCount: 1 });
    const [after] = await rows();
    expect(after!.id).toBe(before!.id);
    expect(after!.title).toBe('New title');
    expect(after!.url).toBe('https://example.test/new');
    expect(after!.firstSeenAt.getTime()).toBe(before!.firstSeenAt.getTime());
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());
    expect(await history()).toHaveLength(1);
  });

  it('price change appends price_history in order', async () => {
    await upsertListings(t.db, [makeListing({ priceCzk: 20000 })]);
    await upsertListings(t.db, [makeListing({ priceCzk: 18000 })]);
    await upsertListings(t.db, [makeListing({ priceCzk: 18000 })]);
    expect((await history()).map((h) => h.priceCzk)).toEqual([20000, 18000]);
    expect((await rows())[0]!.priceCzk).toBe(18000);
  });

  it('null price on a known listing overwrites price and does not write history; later price records again', async () => {
    await upsertListings(t.db, [makeListing({ priceCzk: 20000 })]);
    await upsertListings(t.db, [makeListing({ priceCzk: null })]);
    expect((await rows())[0]!.priceCzk).toBeNull();
    expect(await history()).toHaveLength(1);
    await upsertListings(t.db, [makeListing({ priceCzk: 20000 })]);
    expect(await history()).toHaveLength(2);
  });

  it('list-only sighting never erases known detail data (coalesce/case guards)', async () => {
    await upsertListings(t.db, [
      makeListing({
        feesCzk: 2500, floor: 3, hasBalcony: true, hasParking: false, hasElevator: true,
        condition: 'renovated', district: 'Žabovřesky', images: [IMG('a'), IMG('b')],
      }),
    ]);
    await upsertListings(t.db, [
      makeListing({
        areaM2: null, layout: null, lat: null, lng: null, city: null, condition: 'unknown', images: [],
        priceCzk: 21000,
      }),
    ]);
    const [r] = await rows();
    expect(r).toMatchObject({
      feesCzk: 2500, floor: 3, hasBalcony: true, hasParking: false, hasElevator: true,
      condition: 'renovated', district: 'Žabovřesky', images: [IMG('a'), IMG('b')],
      areaM2: 50, layout: '2+kk', lat: 49.2, lng: 16.6, city: 'Brno', priceCzk: 21000,
    });
    // fingerprint is recomputed from merged values, i.e. equals the geo-based one, not the id fallback
    expect(r!.fingerprint).toBe(fingerprint(makeListing()));
  });

  it('incoming known values override stored ones; longer image list replaces shorter', async () => {
    await upsertListings(t.db, [makeListing({ condition: 'good', images: [IMG('a')], areaM2: 50 })]);
    await upsertListings(t.db, [makeListing({ condition: 'new_build', images: [IMG('a'), IMG('b'), IMG('c')], areaM2: 55 })]);
    const [r] = await rows();
    expect(r).toMatchObject({ condition: 'new_build', images: [IMG('a'), IMG('b'), IMG('c')], areaM2: 55 });
  });

  it('clears removed_at when a removed listing is seen again', async () => {
    await upsertListings(t.db, [makeListing()]);
    await t.db.update(listing).set({ removedAt: new Date() });
    await upsertListings(t.db, [makeListing()]);
    expect((await rows())[0]!.removedAt).toBeNull();
  });

  it('collapses duplicates inside one batch (last wins) without ON CONFLICT double-hit', async () => {
    const r = await upsertListings(t.db, [makeListing({ title: 'first' }), makeListing({ title: 'last' })]);
    expect(r).toEqual({ newCount: 1, updatedCount: 0 });
    expect((await rows())[0]!.title).toBe('last');
  });

  it('same external_id on different portals are distinct rows', async () => {
    await upsertListings(t.db, [makeListing({ portal: 'sreality' }), makeListing({ portal: 'idnes' })]);
    expect(await rows()).toHaveLength(2);
  });

  it('handles batches larger than one chunk (>200) mixing new and known', async () => {
    const first = Array.from({ length: 250 }, (_, i) => makeListing({ externalId: `e${i}`, priceCzk: 1000 + i }));
    expect(await upsertListings(t.db, first)).toEqual({ newCount: 250, updatedCount: 0 });
    const second = Array.from({ length: 450 }, (_, i) => makeListing({ externalId: `e${i}`, priceCzk: 1000 + i }));
    expect(await upsertListings(t.db, second)).toEqual({ newCount: 200, updatedCount: 250 });
    expect(await rows()).toHaveLength(450);
    expect(await history()).toHaveLength(450);
  });

  it('stores raw jsonb and unicode text', async () => {
    await upsertListings(t.db, [makeListing({ raw: { x: [1, 2], s: 'žluťoučký' }, localityText: 'Řečkovice' })]);
    const [r] = await rows();
    expect(r!.raw).toEqual({ x: [1, 2], s: 'žluťoučký' });
    expect(r!.localityText).toBe('Řečkovice');
  });

  it('cascade: deleting a listing removes its price_history', async () => {
    await upsertListings(t.db, [makeListing()]);
    await t.db.delete(listing).where(eq(listing.externalId, 'ext-1'));
    expect(await history()).toHaveLength(0);
  });
});

describe('https sanitising', () => {
  it('drops listings with non-https url and strips non-https images', async () => {
    const r = await upsertListings(t.db, [
      makeListing({ externalId: 'http', url: 'http://example.test/1' }),
      makeListing({ externalId: 'js', url: 'javascript:alert(1)' }),
      makeListing({ externalId: 'ok', images: [IMG('a'), 'http://x.test/b.jpg', 'data:image/png;base64,AAAA'] }),
    ]);
    expect(r).toEqual({ newCount: 1, updatedCount: 0 });
    const all = await rows();
    expect(all.map((x) => x.externalId)).toEqual(['ok']);
    expect(all[0]!.images).toEqual([IMG('a')]);
  });
});

describe('loadKnownRows', () => {
  it('returns external_id -> price for one portal only, including null prices', async () => {
    await upsertListings(t.db, [
      makeListing({ externalId: 'a', priceCzk: 100 }),
      makeListing({ externalId: 'b', priceCzk: null }),
      makeListing({ portal: 'idnes', externalId: 'c', priceCzk: 300 }),
    ]);
    const m = await loadKnownRows(t.db, 'sreality');
    expect([...m.entries()].map(([k, v]) => [k, v.priceCzk]).sort()).toEqual([['a', 100], ['b', null]]);
    expect((await loadKnownRows(t.db, 'bezrealitky')).size).toBe(0);
  });
});

describe('list-only sightings never erase known data', () => {
  it('null locality_text keeps the known locality_text', async () => {
    await upsertListings(t.db, [makeListing({ localityText: 'Brno-Žabovřesky' })]);
    await upsertListings(t.db, [makeListing({ localityText: null })]);
    const [r] = await t.db.select().from(listing);
    expect(r!.localityText).toBe('Brno-Žabovřesky');
  });

  it('within one batch a detailed record followed by a list-only one keeps the detail', async () => {
    await upsertListings(t.db, [
      makeListing({ areaM2: 61, floor: 3, localityText: 'Brno-Líšeň', images: [IMG('a'), IMG('b')], priceCzk: 20000 }),
      makeListing({ areaM2: null, floor: null, localityText: null, images: [], priceCzk: 21000 }),
    ]);
    const rows = await t.db.select().from(listing);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ areaM2: 61, floor: 3, localityText: 'Brno-Líšeň', priceCzk: 21000 });
    expect(rows[0]!.images).toEqual([IMG('a'), IMG('b')]);
  });
});
