import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActiveQueries } from '../../src/crawler/queries';
import { createDbRateLimiter } from '../../src/lib/rate-limit';
import { createTestDb, insertCriteria, type TestDb } from '../helpers/pg';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pg.exec('TRUNCATE criteria, login_attempt RESTART IDENTITY CASCADE'); });

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

describe('createDbRateLimiter', () => {
  it('is not limited below 5 failures and limited at 5', async () => {
    const rl = createDbRateLimiter(t.db);
    for (let i = 0; i < 4; i++) await rl.recordFailure('ip:1');
    expect(await rl.isLimited('ip:1')).toBe(false);
    await rl.recordFailure('ip:1');
    expect(await rl.isLimited('ip:1')).toBe(true);
  });

  it('keys are independent', async () => {
    const rl = createDbRateLimiter(t.db);
    for (let i = 0; i < 5; i++) await rl.recordFailure('a');
    expect(await rl.isLimited('a')).toBe(true);
    expect(await rl.isLimited('b')).toBe(false);
  });

  it('failures older than 15 minutes age out; those inside the window count', async () => {
    const rl = createDbRateLimiter(t.db);
    for (let i = 0; i < 5; i++) {
      await t.pg.query(`INSERT INTO login_attempt (key, attempted_at) VALUES ('k', now() - interval '16 minutes')`);
    }
    expect(await rl.isLimited('k')).toBe(false);
    for (let i = 0; i < 4; i++) {
      await t.pg.query(`INSERT INTO login_attempt (key, attempted_at) VALUES ('k', now() - interval '14 minutes')`);
    }
    expect(await rl.isLimited('k')).toBe(false);
    await rl.recordFailure('k');
    expect(await rl.isLimited('k')).toBe(true);
  });

  it('prunes rows older than 24h on recordFailure but keeps recent ones', async () => {
    const rl = createDbRateLimiter(t.db);
    await t.pg.query(`INSERT INTO login_attempt (key, attempted_at) VALUES ('old', now() - interval '25 hours')`);
    await t.pg.query(`INSERT INTO login_attempt (key, attempted_at) VALUES ('mid', now() - interval '20 hours')`);
    await rl.recordFailure('new');
    const { rows } = await t.pg.query<{ key: string }>(`SELECT key FROM login_attempt ORDER BY key`);
    expect(rows.map((r) => r.key)).toEqual(['mid', 'new']);
  });
});
