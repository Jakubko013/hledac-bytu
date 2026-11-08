import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { listing, listingState, match, priceHistory } from '../../db/schema';
import { rescoreAll, rescoreCriteria } from '../../src/scoring/rescore';
import { upsertListings } from '../../src/crawler/upsert';
import { createTestDb, insertCriteria, makeListing, type TestDb } from '../helpers/pg';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await t.pg.exec('TRUNCATE listing, price_history, criteria, match, listing_state RESTART IDENTITY CASCADE');
});

const matchesOf = async (criteriaId: number) =>
  (await t.db.select().from(match).where(eq(match.criteriaId, criteriaId)).orderBy(asc(match.listingId))).map(
    (m) => m.listingId,
  );
const idOf = async (externalId: string) =>
  (await t.db.select({ id: listing.id }).from(listing).where(eq(listing.externalId, externalId)))[0]!.id;

describe('rescoreAll / rescoreCriteria', () => {
  it('writes matches only for listings passing the filters; score in 0..100 with breakdown', async () => {
    await upsertListings(t.db, [
      makeListing({ externalId: 'ok' }),
      makeListing({ externalId: 'sale', offerType: 'sale' }),
      makeListing({ externalId: 'praha', city: 'Praha', localityText: 'Praha 1' }),
      makeListing({ externalId: 'pricey', priceCzk: 90000 }),
    ]);
    const c = await insertCriteria(t.db, { priceMax: 30000 });
    expect(await rescoreAll(t.db)).toBe(1);
    expect(await matchesOf(c.id)).toEqual([await idOf('ok')]);
    const [m] = await t.db.select().from(match);
    expect(m!.score).toBeGreaterThan(0);
    expect(m!.score).toBeLessThanOrEqual(100);
    expect(m!.breakdown).toHaveProperty('price_per_m2');
  });

  it('is idempotent and replaces previous matches (stale ones removed)', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' }), makeListing({ externalId: 'b' })]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toHaveLength(2);
    await t.db.update(listing).set({ removedAt: new Date() }).where(eq(listing.externalId, 'b'));
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toEqual([await idOf('a')]);
  });

  it('city prefilter is diacritics- and case-insensitive (translate/LIKE)', async () => {
    await upsertListings(t.db, [
      makeListing({ externalId: 'plzen', city: 'Plzeň', localityText: 'Plzeň-Bolevec', lat: 49.75, lng: 13.38 }),
      makeListing({ externalId: 'upper', city: 'PLZEŇ', localityText: null, lat: 49.75, lng: 13.38 }),
      makeListing({ externalId: 'hk', city: null, localityText: 'Hradec Králové - Slezské Předměstí' }),
      makeListing({ externalId: 'ricany', city: 'Říčany', localityText: 'Říčany', lat: 49.9, lng: 14.6 }),
      makeListing({ externalId: 'brno' }),
    ]);
    const plzen = await insertCriteria(t.db, { city: 'plzen' });
    const plzenAccent = await insertCriteria(t.db, { city: 'PLZEŇ' });
    const hk = await insertCriteria(t.db, { city: 'hradec kralove' });
    const ricany = await insertCriteria(t.db, { city: 'Říčany' });
    await rescoreAll(t.db);
    const plzenIds = [await idOf('plzen'), await idOf('upper')].sort((a, b) => a - b);
    expect(await matchesOf(plzen.id)).toEqual(plzenIds);
    expect(await matchesOf(plzenAccent.id)).toEqual(plzenIds);
    expect(await matchesOf(hk.id)).toEqual([await idOf('hk')]);
    expect(await matchesOf(ricany.id)).toEqual([await idOf('ricany')]);
  });

  it('city with LIKE metacharacters is escaped, not treated as a wildcard', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a', city: 'Brno' })]);
    const c = await insertCriteria(t.db, { city: '%' });
    const u = await insertCriteria(t.db, { city: '_rno' });
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toEqual([]);
    expect(await matchesOf(u.id)).toEqual([]);
  });

  it('removed listings get no match; hidden and favorite listings keep theirs', async () => {
    await upsertListings(t.db, [
      makeListing({ externalId: 'h' }), makeListing({ externalId: 'f' }), makeListing({ externalId: 'r' }),
    ]);
    await t.db.insert(listingState).values([
      { listingId: await idOf('h'), status: 'hidden' },
      { listingId: await idOf('f'), status: 'favorite' },
    ]);
    await t.db.update(listing).set({ removedAt: new Date() }).where(eq(listing.externalId, 'r'));
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toEqual([await idOf('h'), await idOf('f')].sort((a, b) => a - b));
  });

  it('concurrent rescores of one criteria (advisory lock) leave exactly one set of matches', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' }), makeListing({ externalId: 'b' })]);
    const c = await insertCriteria(t.db);
    await Promise.all([rescoreCriteria(t.db, c.id), rescoreCriteria(t.db, c.id), rescoreAll(t.db)]);
    expect(await matchesOf(c.id)).toHaveLength(2);
  });

  it('price drop raises the score vs. identical listing without drop', async () => {
    await upsertListings(t.db, [
      makeListing({ externalId: 'drop', priceCzk: 20000 }),
      makeListing({ externalId: 'flat', priceCzk: 18000 }),
    ]);
    // drop: history 20000 -> 18000 ; flat: 18000 only
    await upsertListings(t.db, [makeListing({ externalId: 'drop', priceCzk: 18000 })]);
    const c = await insertCriteria(t.db, { weights: { price_per_m2: 0, distance: 0, condition: 0, area: 0, freshness: 0, extras: 0, price_drop: 1 } });
    await rescoreAll(t.db);
    const rows = await t.db.select().from(match).where(eq(match.criteriaId, c.id));
    const score = (id: number) => rows.find((r) => r.listingId === id)!.score;
    expect(score(await idOf('drop'))).toBe(100);
    expect(score(await idOf('flat'))).toBe(0);
    expect((await t.db.select().from(priceHistory)).length).toBe(3);
  });

  it('price increase after a drop is not a drop (uses chronological order)', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'x', priceCzk: 20000 })]);
    await upsertListings(t.db, [makeListing({ externalId: 'x', priceCzk: 18000 })]);
    await upsertListings(t.db, [makeListing({ externalId: 'x', priceCzk: 19000 })]);
    const c = await insertCriteria(t.db, { weights: { price_per_m2: 0, distance: 0, condition: 0, area: 0, freshness: 0, extras: 0, price_drop: 1 } });
    await rescoreAll(t.db);
    const [m] = await t.db.select().from(match).where(eq(match.criteriaId, c.id));
    expect(m!.score).toBe(0);
  });

  it('inactive criteria: rescoreAll skips them; rescoreCriteria clears their matches', async () => {
    await upsertListings(t.db, [makeListing()]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toHaveLength(1);
    await t.pg.exec(`UPDATE criteria SET active = false`);
    expect(await rescoreAll(t.db)).toBe(0);
    expect(await matchesOf(c.id)).toHaveLength(1); // untouched by rescoreAll
    expect(await rescoreCriteria(t.db, c.id)).toBe(0);
    expect(await matchesOf(c.id)).toEqual([]);
  });

  it('rescoreCriteria on unknown id returns 0 and leaves others intact', async () => {
    await upsertListings(t.db, [makeListing()]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    expect(await rescoreCriteria(t.db, 9999)).toBe(0);
    expect(await matchesOf(c.id)).toHaveLength(1);
  });

  it('handles more rows than one insert chunk (500)', async () => {
    const items = Array.from({ length: 620 }, (_, i) => makeListing({ externalId: `e${i}`, lat: 49.2 + i / 100000 }));
    await upsertListings(t.db, items);
    const c = await insertCriteria(t.db);
    expect(await rescoreCriteria(t.db, c.id)).toBe(620);
    expect(await matchesOf(c.id)).toHaveLength(620);
  });

  it('criteria with no city text filter (blank city) matches all of the offer type', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' }), makeListing({ externalId: 'b', city: 'Praha', localityText: 'Praha' })]);
    const c = await insertCriteria(t.db, { city: '   ' });
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toHaveLength(2);
  });

  it('locality, layout, must-have and price/area bounds are applied end-to-end', async () => {
    await upsertListings(t.db, [
      makeListing({ externalId: 'good', layout: '2+kk', hasBalcony: true, localityText: 'Brno-Žabovřesky', areaM2: 55 }),
      makeListing({ externalId: 'nobalc', layout: '2+kk', hasBalcony: false, localityText: 'Brno-Žabovřesky' }),
      makeListing({ externalId: 'layout', layout: '3+1', hasBalcony: true, localityText: 'Brno-Žabovřesky' }),
      makeListing({ externalId: 'loc', layout: '2+kk', hasBalcony: true, localityText: 'Brno-Líšeň' }),
      makeListing({ externalId: 'small', layout: '2+kk', hasBalcony: true, localityText: 'Brno-Žabovřesky', areaM2: 30, lat: 49.21 }),
    ]);
    const c = await insertCriteria(t.db, {
      layouts: ['2+kk'], localities: ['zabovresky'], must: { balcony: true }, areaMin: 40, priceMin: 10000, priceMax: 25000,
    });
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toEqual([await idOf('good')]);
  });
});

describe('city prefilter', () => {
  it('accepts Slovak diacritics the same way normalizeText does', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'sk', city: 'Ľubľana', localityText: 'Ľubľana' })]);
    const c = await insertCriteria(t.db, { city: 'lublana' });
    await rescoreAll(t.db);
    expect(await matchesOf(c.id)).toHaveLength(1);
  });
});
