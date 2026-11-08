import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { crawlRun, listing, listingState } from '../../db/schema';
import { createTestDb, insertCriteria, makeListing, type TestDb } from '../helpers/pg';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../db/index', () => ({ createDb: () => holder.db }));

import {
  PAGE_SIZE, getCriteria, getCriteriaList, getHealth, getListing, getRankedListings,
} from '../../src/lib/view-data';
import { rescoreAll } from '../../src/scoring/rescore';
import { upsertListings } from '../../src/crawler/upsert';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
});
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await t.pg.exec('TRUNCATE listing, price_history, criteria, match, listing_state, crawl_run RESTART IDENTITY CASCADE');
});

const idOf = async (externalId: string, portal = 'sreality') =>
  (await t.db.select({ id: listing.id }).from(listing).where(eq(listing.externalId, externalId)))
    .map((r) => r.id)[0]! + 0 * portal.length;

/** n distinct (by fingerprint) Brno listings, price increasing so scores differ. */
const seed = async (n: number, extra: Partial<Parameters<typeof makeListing>[0]> = {}) => {
  await upsertListings(
    t.db,
    Array.from({ length: n }, (_, i) =>
      makeListing({ externalId: `e${i}`, lat: 49.2 + i * 0.01, lng: 16.6, priceCzk: 15000 + i * 1000, ...extra }),
    ),
  );
};

describe('getCriteriaList / getCriteria', () => {
  it('returns [] / null when empty or unknown', async () => {
    expect(await getCriteriaList()).toEqual([]);
    expect(await getCriteria(1)).toBeNull();
  });

  it('lists active first then by id, mapped to view shape with ISO dates and factor weights', async () => {
    const a = await insertCriteria(t.db, { name: 'inactive', active: false });
    const b = await insertCriteria(t.db, { name: 'act1', must: { balcony: true } });
    const c = await insertCriteria(t.db, { name: 'act2' });
    const list = await getCriteriaList();
    expect(list.map((x) => x.id)).toEqual([b.id, c.id, a.id]);
    const one = await getCriteria(b.id);
    expect(one).toMatchObject({
      name: 'act1', offer_type: 'rent', city: 'Brno', must: { balcony: true, parking: false, elevator: false },
    });
    expect(one!.weights.distance_to_centre).toBe(3);
    expect(new Date(one!.created_at).toString()).not.toBe('Invalid Date');
  });
});

describe('getRankedListings', () => {
  it('unknown criteria -> empty page', async () => {
    expect(await getRankedListings(42)).toEqual({ items: [], total: 0, page: 1, page_size: PAGE_SIZE, page_count: 1 });
  });

  it('criteria without matches -> empty page', async () => {
    const c = await insertCriteria(t.db);
    const p = await getRankedListings(c.id);
    expect(p).toMatchObject({ items: [], total: 0, page: 1, page_count: 1 });
  });

  it('sorts by score desc and paginates (24/page), clamping out-of-range pages', async () => {
    await seed(54);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const p1 = await getRankedListings(c.id);
    expect(PAGE_SIZE).toBe(24);
    expect(p1).toMatchObject({ total: 54, page: 1, page_count: 3 });
    expect(p1.items).toHaveLength(24);
    const scores = p1.items.map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const p3 = await getRankedListings(c.id, { page: 3 });
    expect(p3.items).toHaveLength(6);
    const ids = new Set([...p1.items, ...(await getRankedListings(c.id, { page: 2 })).items, ...p3.items].map((i) => i.id));
    expect(ids.size).toBe(54); // no overlap / gaps across pages
    expect((await getRankedListings(c.id, { page: 99 })).page).toBe(3);
    expect((await getRankedListings(c.id, { page: 0 })).page).toBe(1);
    expect((await getRankedListings(c.id, { page: -5 })).page).toBe(1);
    expect((await getRankedListings(c.id, { page: Number.NaN })).page).toBe(1);
  });

  it('dedupes by fingerprint across portals: best score wins, other portal in also_on', async () => {
    await upsertListings(t.db, [
      makeListing({ portal: 'sreality', externalId: 's1', priceCzk: 25000, url: 'https://s/1' }),
      makeListing({ portal: 'idnes', externalId: 'i1', priceCzk: 15000, url: 'https://i/1' }),
      makeListing({ portal: 'bezrealitky', externalId: 'b1', priceCzk: 21000, lat: 49.3, url: 'https://b/1' }),
    ]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const p = await getRankedListings(c.id);
    expect(p.total).toBe(2);
    expect(p.items).toHaveLength(2);
    const dup = p.items.find((i) => i.also_on.length > 0)!;
    expect(dup.portal).toBe('idnes'); // cheaper => better price score => wins the fingerprint
    expect(dup.also_on).toEqual(['sreality']);
    expect(dup.also_on_links).toEqual([{ portal: 'sreality', url: 'https://s/1', price_czk: 25000 }]);
  });

  it('dedup tie on score breaks by cheaper price then lower id; count matches items', async () => {
    await upsertListings(t.db, [
      makeListing({ portal: 'sreality', externalId: 's1' }),
      makeListing({ portal: 'idnes', externalId: 'i1' }),
    ]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const p = await getRankedListings(c.id);
    expect(p.total).toBe(1);
    expect(p.items[0]!.id).toBe(await idOf('s1'));
  });

  it('hidden excluded from all/new/favorite, shown only with status=hidden', async () => {
    await seed(4);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const h = await idOf('e0');
    const f = await idOf('e1');
    const s = await idOf('e2');
    await t.db.insert(listingState).values([
      { listingId: h, status: 'hidden' }, { listingId: f, status: 'favorite' }, { listingId: s, status: 'seen' },
    ]);
    // state is applied at read time: no rescore is needed for the view filters to take effect
    const all = await getRankedListings(c.id);
    expect(all.items.map((i) => i.id)).not.toContain(h);
    expect(all.total).toBe(3);
    expect((await getRankedListings(c.id, { status: 'favorite' })).items.map((i) => i.id)).toEqual([f]);
    expect((await getRankedListings(c.id, { status: 'new' })).items.map((i) => i.id)).toEqual([await idOf('e3')]);
    expect((await getRankedListings(c.id, { status: 'hidden' })).items.map((i) => i.id)).toEqual([h]);
  });

  it('hidden listing survives rescore, shows only in the hidden tab, and unhiding needs no rescore', async () => {
    await seed(3);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const h = await idOf('e0');
    await t.db.insert(listingState).values({ listingId: h, status: 'hidden' });
    await rescoreAll(t.db);
    expect((await getRankedListings(c.id, { status: 'hidden' })).items.map((i) => i.id)).toEqual([h]);
    expect((await getRankedListings(c.id)).items.map((i) => i.id)).not.toContain(h);
    expect((await getRankedListings(c.id)).total).toBe(2);
    await t.db.update(listingState).set({ status: 'seen' }).where(eq(listingState.listingId, h));
    expect((await getRankedListings(c.id)).items.map((i) => i.id)).toContain(h);
    expect((await getRankedListings(c.id, { status: 'hidden' })).total).toBe(0);
  });

  it('removed listings never appear', async () => {
    await seed(2);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    await t.db.update(listing).set({ removedAt: new Date() }).where(eq(listing.externalId, 'e0'));
    const p = await getRankedListings(c.id);
    expect(p.total).toBe(1);
  });

  it('card fields: is_new, price drop pct, status, image, distance, locality', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'x', priceCzk: 20000, images: ['https://img.example.test/i0.jpg'] })]);
    await upsertListings(t.db, [makeListing({ externalId: 'x', priceCzk: 15000, images: ['https://img.example.test/i0.jpg'] })]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const [item] = (await getRankedListings(c.id)).items;
    expect(item).toMatchObject({
      criteria_id: c.id, status: 'new', is_new: true, price_drop_pct: 25, image: 'https://img.example.test/i0.jpg',
      locality_text: 'Brno-střed', price_czk: 15000,
    });
    expect(item!.distance_km).toBeGreaterThanOrEqual(0);
    expect(item!.breakdown.price_per_m2).toBeTypeOf('number');
  });

  it('only returns matches of the requested criteria', async () => {
    await seed(3);
    const a = await insertCriteria(t.db, { priceMax: 15500 });
    const b = await insertCriteria(t.db);
    await rescoreAll(t.db);
    expect((await getRankedListings(a.id)).total).toBe(1);
    expect((await getRankedListings(b.id)).total).toBe(3);
  });
});

describe('getListing', () => {
  it('unknown id -> null', async () => {
    expect(await getListing(123)).toBeNull();
  });

  it('listing without any match: score 0, zeroed breakdown, criteria_id 0', async () => {
    await seed(1);
    const d = await getListing(await idOf('e0'));
    expect(d).toMatchObject({ score: 0, criteria_id: 0, status: 'new', distance_km: null, note: '' });
    expect(Object.values(d!.breakdown).every((v) => v === 0)).toBe(true);
    expect(d!.sources).toEqual([{ portal: 'sreality', url: 'https://example.test/1', price_czk: 15000 }]);
  });

  it('without criteriaId picks the best-scoring criteria; with criteriaId picks that one', async () => {
    await seed(3);
    const weak = await insertCriteria(t.db, { name: 'weak', weights: { price_per_m2: 0, distance: 0, condition: 0, area: 0, freshness: 0, extras: 1, price_drop: 0 } });
    const strong = await insertCriteria(t.db, { name: 'strong', weights: { price_per_m2: 0, distance: 0, condition: 0, area: 0, freshness: 1, extras: 0, price_drop: 0 } });
    await rescoreAll(t.db);
    const id = await idOf('e1');
    const best = await getListing(id);
    expect(best!.criteria_id).toBe(strong.id);
    expect(best!.score).toBeGreaterThan(90);
    const picked = await getListing(id, weak.id);
    expect(picked!.criteria_id).toBe(weak.id);
    expect(picked!.score).toBe(0);
    // criteria without a match for this listing -> falls back to "no match" shape
    const other = await insertCriteria(t.db, { city: 'Praha' });
    await rescoreAll(t.db);
    expect(await getListing(id, other.id)).toMatchObject({ criteria_id: 0, score: 0 });
  });

  it('includes price history, state/note, sources from same-fingerprint siblings, distance', async () => {
    await upsertListings(t.db, [
      makeListing({ portal: 'sreality', externalId: 's1', priceCzk: 20000, floor: 2, hasBalcony: true, images: ['https://img.example.test/a.jpg'] }),
      makeListing({ portal: 'idnes', externalId: 'i1', priceCzk: 19500, url: 'https://i/1' }),
      makeListing({ portal: 'bezrealitky', externalId: 'gone', url: 'https://b/1' }),
    ]);
    await upsertListings(t.db, [makeListing({ portal: 'sreality', externalId: 's1', priceCzk: 18000 })]);
    await t.db.update(listing).set({ removedAt: new Date() }).where(eq(listing.externalId, 'gone'));
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const id = await idOf('s1');
    await t.db.insert(listingState).values({ listingId: id, status: 'favorite', note: 'call them' });
    const d = (await getListing(id, c.id))!;
    expect(d).toMatchObject({
      status: 'favorite', note: 'call them', price_drop_pct: 10, floor: 2, has_balcony: true,
      also_on: ['idnes'], criteria_id: c.id, removed_at: null, image: 'https://img.example.test/a.jpg',
    });
    expect(d.price_history.map((h) => h.price_czk)).toEqual([20000, 18000]);
    expect(d.sources.map((s) => s.portal)).toEqual(['sreality', 'idnes']);
    expect(d.distance_km).not.toBeNull();
    expect(d.is_new).toBe(false); // favorite is not "new"
  });
});

describe('getHealth', () => {
  it('reports never_run placeholders for every portal when no runs exist', async () => {
    const h = await getHealth();
    expect(h.map((r) => [r.portal, r.status, r.id])).toEqual([
      ['sreality', 'never_run', 0], ['bezrealitky', 'never_run', 0], ['idnes', 'never_run', 0],
    ]);
  });

  it('returns the latest run per portal, never_run for the rest', async () => {
    await t.pg.query(`INSERT INTO crawl_run (portal, runner, status, fetched, started_at, finished_at) VALUES
      ('sreality','netlify','failed',0, now() - interval '2 hours', now() - interval '2 hours'),
      ('sreality','github','ok',42, now() - interval '1 hour', now() - interval '30 minutes'),
      ('idnes','manual','running',0, now(), NULL)`);
    const h = await getHealth();
    const sre = h.find((r) => r.portal === 'sreality')!;
    expect(sre).toMatchObject({ status: 'ok', runner: 'github', fetched: 42 });
    expect(sre.finished_at).not.toBeNull();
    expect(h.find((r) => r.portal === 'idnes')).toMatchObject({ status: 'running', finished_at: null });
    expect(h.find((r) => r.portal === 'bezrealitky')!.status).toBe('never_run');
  });

  it('breaks started_at ties by id', async () => {
    await t.pg.query(`INSERT INTO crawl_run (portal, runner, status, started_at) VALUES
      ('sreality','manual','failed','2026-01-01T00:00:00Z'), ('sreality','manual','ok','2026-01-01T00:00:00Z')`);
    expect((await getHealth()).find((r) => r.portal === 'sreality')!.status).toBe('ok');
  });
});

void crawlRun;
