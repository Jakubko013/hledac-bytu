import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { crawlRun, listing, match } from '../../db/schema';
import { runPortal, runAll } from '../../src/crawler/run';
import { upsertListings } from '../../src/crawler/upsert';
import type { CrawlCtx, CrawlQuery, NormalizedListing, PortalAdapter } from '../../src/crawler/types';
import { createTestDb, insertCriteria, makeListing, type TestDb } from '../helpers/pg';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await t.pg.exec('TRUNCATE listing, price_history, criteria, match, listing_state, crawl_run RESTART IDENTITY CASCADE');
});

const opts = { runner: 'manual' as const, maxPages: 1 };
const adapter = (
  gen: (q: CrawlQuery, ctx: CrawlCtx) => AsyncIterable<NormalizedListing>,
  id: PortalAdapter['id'] = 'sreality',
): PortalAdapter => ({ id, fetch: gen });
const emit = (items: NormalizedListing[], id: PortalAdapter['id'] = 'sreality') =>
  adapter(async function* () { for (const i of items) yield i; }, id);
const runs = () => t.db.select().from(crawlRun).orderBy(asc(crawlRun.id));
const day = 86_400_000;

describe('runPortal', () => {
  it('no active criteria: ok, run finished, nothing fetched', async () => {
    const r = await runPortal(t.db, emit([makeListing()]), opts);
    expect(r).toMatchObject({ status: 'ok', fetched: 0, error: null });
    const [row] = await runs();
    expect(row).toMatchObject({ status: 'ok', runner: 'manual', portal: 'sreality' });
    expect(row!.finishedAt).not.toBeNull();
  });

  it('happy path: upserts, counts, status ok, rescored matches, run row finalized', async () => {
    const c = await insertCriteria(t.db);
    const r = await runPortal(t.db, emit([makeListing({ externalId: 'a' }), makeListing({ externalId: 'b' })]), opts);
    expect(r).toMatchObject({ status: 'ok', fetched: 2, newCount: 2, updatedCount: 0, error: null });
    expect(r.runId).toBeGreaterThan(0);
    const [row] = await runs();
    expect(row).toMatchObject({ status: 'ok', fetched: 2, newCount: 2, updatedCount: 0, error: null });
    expect(row!.finishedAt).not.toBeNull();
    expect(await t.db.select().from(match).where(eq(match.criteriaId, c.id))).toHaveLength(2);
  });

  it('second run reports updated, not new', async () => {
    await insertCriteria(t.db);
    await runPortal(t.db, emit([makeListing()]), opts);
    const r = await runPortal(t.db, emit([makeListing()]), opts);
    expect(r).toMatchObject({ status: 'ok', fetched: 1, newCount: 0, updatedCount: 1 });
  });

  it('flushes in batches of 50 (120 items) and counts all', async () => {
    await insertCriteria(t.db);
    const items = Array.from({ length: 120 }, (_, i) => makeListing({ externalId: `e${i}` }));
    const r = await runPortal(t.db, emit(items), opts);
    expect(r).toMatchObject({ status: 'ok', fetched: 120, newCount: 120 });
  });

  it('adapter yielding nothing -> failed with "no listings fetched"', async () => {
    await insertCriteria(t.db);
    const r = await runPortal(t.db, emit([]), opts);
    expect(r).toMatchObject({ status: 'failed', fetched: 0, error: 'no listings fetched' });
    expect((await runs())[0]).toMatchObject({ status: 'failed', error: 'no listings fetched' });
  });

  it('adapter throwing immediately -> failed with error message, run finalized', async () => {
    await insertCriteria(t.db);
    const a = adapter(async function* () { throw new Error('boom'); });
    const r = await runPortal(t.db, a, opts);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('boom');
    const [row] = await runs();
    expect(row!.status).toBe('failed');
    expect(row!.finishedAt).not.toBeNull();
  });

  it('adapter throwing after yielding data -> partial, data kept', async () => {
    await insertCriteria(t.db);
    const a = adapter(async function* () {
      yield makeListing({ externalId: 'a' });
      throw new Error('later');
    });
    const r = await runPortal(t.db, a, opts);
    expect(r).toMatchObject({ status: 'partial', fetched: 1 });
    expect(r.error).toContain('later');
    expect(await t.db.select().from(listing)).toHaveLength(1);
  });

  it('a failing query does not stop the next query', async () => {
    await insertCriteria(t.db, { city: 'Brno' });
    await insertCriteria(t.db, { city: 'Praha' });
    const a = adapter(async function* (q) {
      if (q.city === 'Brno') throw new Error('brno down');
      yield makeListing({ externalId: 'p', city: 'Praha', localityText: 'Praha' });
    });
    const r = await runPortal(t.db, a, opts);
    expect(r).toMatchObject({ status: 'partial', fetched: 1 });
    expect(r.error).toContain('rent/Brno');
  });

  it('fetched far below 30% of the 7-day ok average -> partial with explanation', async () => {
    await insertCriteria(t.db);
    for (let i = 0; i < 3; i++) await t.db.insert(crawlRun).values({ portal: 'sreality', runner: 'manual', status: 'ok', fetched: 100 });
    const r = await runPortal(t.db, emit([makeListing()]), opts);
    expect(r.status).toBe('partial');
    expect(r.error).toMatch(/below 30% of 7-day average 100/);
  });

  it('ok runs older than 7 days, other portals and non-ok runs do not influence the average', async () => {
    await insertCriteria(t.db);
    await t.pg.query(`INSERT INTO crawl_run (portal, runner, status, fetched, started_at) VALUES ('sreality','manual','ok',1000, now() - interval '8 days')`);
    await t.db.insert(crawlRun).values({ portal: 'idnes', runner: 'manual', status: 'ok', fetched: 1000 });
    await t.db.insert(crawlRun).values({ portal: 'sreality', runner: 'manual', status: 'partial', fetched: 1000 });
    const r = await runPortal(t.db, emit([makeListing()]), opts);
    expect(r.status).toBe('ok');
  });

  it('marks listings unseen for >3 days as removed after an ok run; fresh and other-portal ones stay', async () => {
    await insertCriteria(t.db);
    await upsertListings(t.db, [
      makeListing({ externalId: 'stale' }), makeListing({ externalId: 'recent' }),
      makeListing({ portal: 'idnes', externalId: 'other' }),
    ]);
    await t.pg.query(`UPDATE listing SET last_seen_at = now() - interval '4 days' WHERE external_id IN ('stale','other')`);
    await t.pg.query(`UPDATE listing SET last_seen_at = now() - interval '2 days' WHERE external_id = 'recent'`);
    await runPortal(t.db, emit([makeListing({ externalId: 'new1' })]), opts);
    const byId = Object.fromEntries((await t.db.select().from(listing)).map((l) => [l.externalId, l.removedAt]));
    expect(byId.stale).not.toBeNull();
    expect(byId.recent).toBeNull();
    expect(byId.other).toBeNull();
    expect(byId.new1).toBeNull();
    // removed listing gets no match after the end-of-run rescore (recent, other, new1 remain)
    const matched = await t.db.select({ id: match.listingId }).from(match);
    expect(matched).toHaveLength(3);
    const staleRow = (await t.db.select().from(listing).where(eq(listing.externalId, 'stale')))[0]!;
    expect(matched.map((m) => m.id)).not.toContain(staleRow.id);
  });

  it('does NOT mark removed after a partial/failed run', async () => {
    await insertCriteria(t.db);
    await upsertListings(t.db, [makeListing({ externalId: 'stale' })]);
    await t.pg.query(`UPDATE listing SET last_seen_at = now() - interval '5 days'`);
    await runPortal(t.db, emit([]), opts);
    expect((await t.db.select().from(listing))[0]!.removedAt).toBeNull();
  });

  it('does NOT mark removed after a truncated (maxPages) run, but stays ok', async () => {
    await insertCriteria(t.db);
    await upsertListings(t.db, [makeListing({ externalId: 'stale' })]);
    await t.pg.query(`UPDATE listing SET last_seen_at = now() - interval '5 days'`);
    const a = adapter(async function* (_q, ctx) {
      ctx.countPage?.();
      yield makeListing({ externalId: 'new1' });
      ctx.markTruncated?.();
    });
    const r = await runPortal(t.db, a, opts);
    expect(r).toMatchObject({ status: 'ok', pages: 1 });
    const byId = Object.fromEntries((await t.db.select().from(listing)).map((l) => [l.externalId, l.removedAt]));
    expect(byId.stale).toBeNull();
  });

  it('marks stale running rows of the same portal as failed at start', async () => {
    await t.pg.query(`INSERT INTO crawl_run (portal, runner, status, started_at) VALUES
      ('sreality','github','running', now() - interval '20 minutes'),
      ('sreality','github','running', now() - interval '2 minutes'),
      ('idnes','github','running', now() - interval '20 minutes')`);
    await runPortal(t.db, emit([]), opts);
    const rows = await runs();
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'přerušeno (timeout)' });
    expect(rows[0]!.finishedAt).not.toBeNull();
    expect(rows[1]!.status).toBe('running');
    expect(rows[2]!.status).toBe('running');
  });

  it('pages counts only countPage() calls, not ctx.fetch', async () => {
    await insertCriteria(t.db);
    const a = adapter(async function* (_q, ctx) {
      ctx.countPage?.();
      ctx.countPage?.();
      yield makeListing();
    });
    expect((await runPortal(t.db, a, opts)).pages).toBe(2);
  });

  it('re-seen removed listing is revived and matched again', async () => {
    const c = await insertCriteria(t.db);
    await upsertListings(t.db, [makeListing({ externalId: 'x' })]);
    await t.db.update(listing).set({ removedAt: new Date(Date.now() - day) });
    await runPortal(t.db, emit([makeListing({ externalId: 'x' })]), opts);
    expect((await t.db.select().from(listing))[0]!.removedAt).toBeNull();
    expect(await t.db.select().from(match).where(eq(match.criteriaId, c.id))).toHaveLength(1);
  });

  it('needsDetail: false for known listing with same price, true for new or changed price', async () => {
    await insertCriteria(t.db);
    await upsertListings(t.db, [makeListing({ externalId: 'known', priceCzk: 20000 })]);
    const seen: Record<string, boolean> = {};
    const a = adapter(async function* (_q, ctx) {
      seen.same = ctx.needsDetail!('known', 20000);
      seen.changed = ctx.needsDetail!('known', 19000);
      seen.unknown = ctx.needsDetail!('nope', 20000);
      yield makeListing({ externalId: 'known' });
    });
    await runPortal(t.db, a, opts);
    expect(seen).toEqual({ same: false, changed: true, unknown: true });
  });

  it('ctx.maxPages and signal are passed through to the adapter', async () => {
    await insertCriteria(t.db);
    const ac = new AbortController();
    let got: { maxPages: number; signal?: AbortSignal } | undefined;
    const a = adapter(async function* (_q, ctx) {
      got = { maxPages: ctx.maxPages, signal: ctx.signal };
      yield makeListing();
    });
    await runPortal(t.db, a, { runner: 'github', maxPages: 7, signal: ac.signal });
    expect(got).toEqual({ maxPages: 7, signal: ac.signal });
    expect((await runs())[0]!.runner).toBe('github');
  });

  it('the run row is "running" while the adapter works', async () => {
    await insertCriteria(t.db);
    let during: string | undefined;
    const a = adapter(async function* () {
      during = (await runs())[0]!.status;
      yield makeListing();
    });
    await runPortal(t.db, a, opts);
    expect(during).toBe('running');
  });

  it('a bad listing that breaks the upsert is reported as an error, not a crash', async () => {
    await insertCriteria(t.db);
    const a = emit([makeListing({ priceCzk: 3_000_000_000 })]); // overflows int4
    const r = await runPortal(t.db, a, opts);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('upsert');
    expect((await runs())[0]!.finishedAt).not.toBeNull();
  });
});

describe('runAll', () => {
  it('runs each adapter sequentially and returns one result per portal', async () => {
    await insertCriteria(t.db);
    const res = await runAll(
      t.db,
      { sreality: emit([makeListing()]), idnes: emit([makeListing({ portal: 'idnes' })], 'idnes') },
      opts,
    );
    expect(res.map((r) => [r.portal, r.status])).toEqual([['sreality', 'ok'], ['idnes', 'ok']]);
  });
});

describe('runPortal fetched counting', () => {
  it('counts only listings that pass sanitization', async () => {
    await insertCriteria(t.db);
    const r = await runPortal(
      t.db,
      emit([
        makeListing({ externalId: 'ok' }),
        makeListing({ externalId: 'bad', url: 'http://example.test/bad' }),
        makeListing({ externalId: 'bad2', url: 'javascript:alert(1)' }),
      ]),
      opts,
    );
    expect(r.fetched).toBe(1);
    const [row] = await runs();
    expect(row!.fetched).toBe(1);
  });
});
