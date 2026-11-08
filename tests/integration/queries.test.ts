import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActiveQueries } from '../../src/crawler/queries';
import { createTestDb, insertCriteria, type TestDb } from '../helpers/pg';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pg.exec('TRUNCATE criteria RESTART IDENTITY CASCADE'); });

describe('loadActiveQueries', () => {
  it('returns [] with no criteria', async () => {
    expect(await loadActiveQueries(t.db)).toEqual([]);
  });

  it('ignores inactive criteria', async () => {
    await insertCriteria(t.db, { active: false });
    expect(await loadActiveQueries(t.db)).toEqual([]);
  });

  it('merges active criteria per (offer_type, city) read from real rows', async () => {
    await insertCriteria(t.db, { city: 'Plzeň', layouts: ['2+kk'], priceMin: 10000, priceMax: 20000, areaMin: 40, areaMax: 60 });
    await insertCriteria(t.db, { city: 'plzen', layouts: ['3+1'], priceMin: 8000, priceMax: 25000, areaMin: 50, areaMax: 80 });
    await insertCriteria(t.db, { offerType: 'sale', city: 'Brno' });
    await insertCriteria(t.db, { city: 'Praha', active: false });
    const q = await loadActiveQueries(t.db);
    expect(q).toHaveLength(2);
    const rent = q.find((x) => x.offerType === 'rent')!;
    expect(rent).toMatchObject({ city: 'Plzeň', priceMin: 8000, priceMax: 25000, areaMin: 40, areaMax: 80 });
    expect([...rent.layouts!].sort()).toEqual(['2+kk', '3+1']);
    const sale = q.find((x) => x.offerType === 'sale')!;
    expect(sale).toEqual({ offerType: 'sale', city: 'Brno' });
  });

  it('an unbounded criteria makes the envelope unbounded', async () => {
    await insertCriteria(t.db, { priceMax: 20000 });
    await insertCriteria(t.db, { priceMax: null });
    const [q] = await loadActiveQueries(t.db);
    expect(q!.priceMax).toBeUndefined();
  });
});
