import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { criteria, listing, listingState, match } from '../../db/schema';
import { createTestDb, insertCriteria, makeListing, type TestDb } from '../helpers/pg';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../db/index', () => ({ createDb: () => holder.db }));

import { POST as criteriaPost } from '../../src/pages/api/criteria';
import { POST as statePost } from '../../src/pages/api/listing-state';
import { upsertListings } from '../../src/crawler/upsert';
import { rescoreAll } from '../../src/scoring/rescore';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
});
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await t.pg.exec('TRUNCATE listing, price_history, criteria, match, listing_state RESTART IDENTITY CASCADE');
});

const call = (
  handler: unknown,
  fields: Record<string, string | string[]>,
  user: unknown = { id: 'u' },
) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  const request = new Request('http://localhost/api/x', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return (handler as (c: unknown) => Promise<Response>)({ request, locals: { user } });
};

const valid = { name: 'Brno 2+kk', offer_type: 'rent', city: 'Brno', active: '1', layouts: ['2+kk', '3+kk'], price_max: '30000' };

describe('POST /api/criteria', () => {
  it('401 without a user, nothing written', async () => {
    const res = await call(criteriaPost, valid, null);
    expect(res.status).toBe(401);
    expect(await t.db.select().from(criteria)).toHaveLength(0);
  });

  it('creates criteria (anchor from city centre, default weights), rescores, redirects to /?c=id', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' }), makeListing({ externalId: 'b', priceCzk: 99000 })]);
    const res = await call(criteriaPost, { ...valid, must_balcony: '1', localities: 'Žabovřesky, Líšeň, Líšeň' });
    expect(res.status).toBe(303);
    const [c] = await t.db.select().from(criteria);
    expect(res.headers.get('Location')).toBe(`/?c=${c!.id}`);
    expect(c).toMatchObject({
      name: 'Brno 2+kk', offerType: 'rent', city: 'Brno', active: true, priceMax: 30000,
      layouts: ['2+kk', '3+kk'], localities: ['Žabovřesky', 'Líšeň'], maxDistanceKm: 10,
      must: { balcony: true, parking: false, elevator: false },
    });
    expect(c!.anchorLat).toBeCloseTo(49.1951);
    expect(c!.weights).toMatchObject({ price_per_m2: 3, extras: 0.5 });
    // must balcony and none of the seeded listings has one -> rescore ran and produced no matches
    expect(await t.db.select().from(match)).toHaveLength(0);
  });

  it('create triggers rescore with matches', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' })]);
    const res = await call(criteriaPost, { name: 'x', offer_type: 'rent', city: 'Brno', active: '1' });
    expect(res.status).toBe(303);
    expect(await t.db.select().from(match)).toHaveLength(1);
  });

  it('updates an existing criteria and rescores; created_at untouched, updated_at moved', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a', priceCzk: 20000 })]);
    const c0 = await insertCriteria(t.db, { name: 'old' });
    await rescoreAll(t.db);
    expect(await t.db.select().from(match)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15));
    const res = await call(criteriaPost, { ...valid, id: String(c0.id), price_max: '10000' });
    expect(res.headers.get('Location')).toBe(`/?c=${c0.id}`);
    const [c1] = await t.db.select().from(criteria);
    expect(c1).toMatchObject({ id: c0.id, name: 'Brno 2+kk', priceMax: 10000 });
    expect(c1!.createdAt.getTime()).toBe(c0.createdAt.getTime());
    expect(c1!.updatedAt.getTime()).toBeGreaterThan(c0.updatedAt.getTime());
    expect(await t.db.select().from(match)).toHaveLength(0); // price filter now excludes the listing
  });

  it('update of a missing id redirects to the error page, creates nothing', async () => {
    const res = await call(criteriaPost, { ...valid, id: '999' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toMatch(/^\/criteria\/999\?error=/);
    expect(await t.db.select().from(criteria)).toHaveLength(0);
  });

  it('invalid form redirects to /criteria/new?error=..., nothing written', async () => {
    const res = await call(criteriaPost, { ...valid, name: '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toMatch(/^\/criteria\/new\?error=/);
    expect(await t.db.select().from(criteria)).toHaveLength(0);
  });

  it('rejects price_min > price_max without writing', async () => {
    const res = await call(criteriaPost, { ...valid, price_min: '50000', price_max: '1000' });
    expect(res.headers.get('Location')).toMatch(/error=/);
    expect(await t.db.select().from(criteria)).toHaveLength(0);
  });

  it('toggle_active off clears matches, on restores them; 404 for unknown id; 400 for bad payload', async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' })]);
    const c = await insertCriteria(t.db);
    await rescoreAll(t.db);
    const off = await call(criteriaPost, { intent: 'toggle_active', id: String(c.id), active: 'false' });
    expect(off.status).toBe(303);
    expect(off.headers.get('Location')).toBe('/criteria');
    expect((await t.db.select().from(criteria))[0]!.active).toBe(false);
    expect(await t.db.select().from(match)).toHaveLength(0);
    await call(criteriaPost, { intent: 'toggle_active', id: String(c.id), active: 'true' });
    expect(await t.db.select().from(match)).toHaveLength(1);
    expect((await call(criteriaPost, { intent: 'toggle_active', id: '999', active: 'true' })).status).toBe(404);
    expect((await call(criteriaPost, { intent: 'toggle_active', id: '1', active: 'maybe' })).status).toBe(400);
    expect((await call(criteriaPost, { intent: 'toggle_active', id: 'abc', active: 'true' })).status).toBe(400);
  });
});

describe('POST /api/listing-state', () => {
  const seedListing = async () => {
    await upsertListings(t.db, [makeListing({ externalId: 'a' })]);
    return (await t.db.select().from(listing))[0]!.id;
  };

  it('401 without user', async () => {
    const id = await seedListing();
    expect((await call(statePost, { listing_id: String(id), status: 'hidden' }, null)).status).toBe(401);
    expect(await t.db.select().from(listingState)).toHaveLength(0);
  });

  it('inserts state with note, then upserts (ON CONFLICT) keeping a single row', async () => {
    const id = await seedListing();
    const r1 = await call(statePost, { listing_id: String(id), status: 'favorite', note: '  call Monday ', next: '/?c=1' });
    expect(r1.status).toBe(303);
    expect(r1.headers.get('Location')).toBe('/?c=1');
    expect(await t.db.select().from(listingState)).toMatchObject([{ listingId: id, status: 'favorite', note: 'call Monday' }]);

    await call(statePost, { listing_id: String(id), status: 'seen' }); // no note field -> keep note
    expect(await t.db.select().from(listingState)).toMatchObject([{ status: 'seen', note: 'call Monday' }]);

    await call(statePost, { listing_id: String(id), status: 'seen', note: '' }); // empty -> clears
    expect((await t.db.select().from(listingState))[0]!.note).toBeNull();
  });

  it('404 for unknown listing, 400 for invalid input, unsafe next is sanitised', async () => {
    const id = await seedListing();
    expect((await call(statePost, { listing_id: '9999', status: 'hidden' })).status).toBe(404);
    expect((await call(statePost, { listing_id: String(id), status: 'bogus' })).status).toBe(400);
    expect((await call(statePost, { listing_id: 'x', status: 'hidden' })).status).toBe(400);
    const res = await call(statePost, { listing_id: String(id), status: 'hidden', next: 'https://evil.test/' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).not.toContain('evil.test');
  });

  it('hiding a listing and rescoring keeps its match (view filters by status)', async () => {
    const id = await seedListing();
    await insertCriteria(t.db);
    await rescoreAll(t.db);
    expect(await t.db.select().from(match).where(eq(match.listingId, id))).toHaveLength(1);
    await call(statePost, { listing_id: String(id), status: 'hidden' });
    await rescoreAll(t.db);
    expect(await t.db.select().from(match)).toHaveLength(1);
  });
});
