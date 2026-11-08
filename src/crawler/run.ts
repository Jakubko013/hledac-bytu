import { and, avg, eq, gt, gte, isNull, lt } from 'drizzle-orm';
import { crawlRun, listing, type Portal, type RunStatus, type Runner } from '../../db/schema';
import type { Db } from '../../db/index';
import { rescoreAll } from '../scoring/rescore';
import { createHttp } from './http';
import { loadActiveQueries } from './queries';
import type { CrawlCtx, Logger, NormalizedListing, PortalAdapter } from './types';
import { loadKnownRows, MAX_DETAIL_RETRIES, needsDetailFor, sanitizeListings, upsertListings } from './upsert';

export const REMOVED_AFTER_DAYS = 3;
export const MIN_FETCHED_RATIO = 0.3;
export const ACTIVE_RUN_WINDOW_MS = 15 * 60_000;
/** Per-portal budget on the GitHub runner; stays below ACTIVE_RUN_WINDOW_MS like the Netlify limit. */
export const PORTAL_TIMEOUT_MS = 14 * 60_000;

/** Pure: a run counts as active when it is `running` and started less than 15 min before `now`. */
export function isActiveRun(run: { status: string; startedAt: Date }, now: number = Date.now()): boolean {
  return run.status === 'running' && now - run.startedAt.getTime() < ACTIVE_RUN_WINDOW_MS;
}

/** True when a recent `running` crawl_run exists (for one portal, or any portal when omitted). */
export async function hasActiveRun(db: Db, portal?: Portal): Promise<boolean> {
  const since = new Date(Date.now() - ACTIVE_RUN_WINDOW_MS);
  const rows = await db
    .select({ id: crawlRun.id })
    .from(crawlRun)
    .where(
      and(
        eq(crawlRun.status, 'running'),
        gt(crawlRun.startedAt, since),
        portal ? eq(crawlRun.portal, portal) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
const BATCH_SIZE = 50;
const DAY_MS = 86_400_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface RunOptions {
  runner: Runner;
  maxPages: number;
  signal?: AbortSignal;
}

export interface PortalRunResult {
  portal: Portal;
  runId: number | null;
  status: Exclude<RunStatus, 'running'>;
  pages: number;
  fetched: number;
  newCount: number;
  updatedCount: number;
  error: string | null;
}

/**
 * Pure status classification.
 * - error with no data -> failed; error after some data -> partial
 * - nothing fetched -> failed
 * - fetched below 30% of the 7-day average of ok runs -> partial
 */
export function classifyRunStatus(input: {
  fetched: number;
  hadError: boolean;
  avg7d: number | null;
}): Exclude<RunStatus, 'running'> {
  const { fetched, hadError, avg7d } = input;
  if (fetched === 0) return 'failed';
  if (hadError) return 'partial';
  if (avg7d != null && avg7d > 0 && fetched < MIN_FETCHED_RATIO * avg7d) return 'partial';
  return 'ok';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeLogger(portal: Portal): Logger {
  const fmt = (msg: string) => `[crawl:${portal}] ${msg}`;
  return {
    debug: (m, meta) => console.debug(fmt(m), meta ?? ''),
    info: (m, meta) => console.info(fmt(m), meta ?? ''),
    warn: (m, meta) => console.warn(fmt(m), meta ?? ''),
    error: (m, meta) => console.error(fmt(m), meta ?? ''),
  };
}

async function averageOkFetched(db: Db, portal: Portal): Promise<number | null> {
  const since = new Date(Date.now() - 7 * DAY_MS);
  const [row] = await db
    .select({ value: avg(crawlRun.fetched) })
    .from(crawlRun)
    .where(and(eq(crawlRun.portal, portal), eq(crawlRun.status, 'ok'), gte(crawlRun.startedAt, since)));
  return row?.value != null ? Number(row.value) : null;
}

async function markRemoved(db: Db, portal: Portal): Promise<void> {
  const cutoff = new Date(Date.now() - REMOVED_AFTER_DAYS * DAY_MS);
  await db
    .update(listing)
    .set({ removedAt: new Date() })
    .where(and(eq(listing.portal, portal), lt(listing.lastSeenAt, cutoff), isNull(listing.removedAt)));
}

/** Marks `running` rows older than the active window as failed (their process died or timed out). */
async function failStaleRuns(db: Db, portal: Portal): Promise<void> {
  await db
    .update(crawlRun)
    .set({ status: 'failed', finishedAt: new Date(), error: 'přerušeno (timeout)' })
    .where(
      and(
        eq(crawlRun.portal, portal),
        eq(crawlRun.status, 'running'),
        lt(crawlRun.startedAt, new Date(Date.now() - ACTIVE_RUN_WINDOW_MS)),
      ),
    );
}

export async function runPortal(db: Db, adapter: PortalAdapter, opts: RunOptions): Promise<PortalRunResult> {
  const portal = adapter.id;
  const log = makeLogger(portal);
  await failStaleRuns(db, portal);
  const [created] = await db
    .insert(crawlRun)
    .values({ portal, runner: opts.runner, status: 'running' })
    .returning({ id: crawlRun.id });
  const runId = created!.id;

  const result: PortalRunResult = {
    portal,
    runId,
    status: 'failed',
    pages: 0,
    fetched: 0,
    newCount: 0,
    updatedCount: 0,
    error: null,
  };
  const errors: string[] = [];
  let truncated = false;

  const saveProgress = () =>
    db
      .update(crawlRun)
      .set({
        pages: result.pages,
        fetched: result.fetched,
        newCount: result.newCount,
        updatedCount: result.updatedCount,
      })
      .where(eq(crawlRun.id, runId));

  try {
    const queries = await loadActiveQueries(db);
    if (queries.length === 0) {
      log.info('no active criteria, nothing to crawl');
      result.status = 'ok';
    } else {
      const known = await loadKnownRows(db, portal);
      const retryBudget = { left: MAX_DETAIL_RETRIES };
      const http = createHttp({ delayMs: 1500, retries: 3, userAgent: USER_AGENT });
      const ctx: CrawlCtx = {
        fetch: (url, init) => http(url, init),
        countPage: () => {
          result.pages++;
        },
        markTruncated: () => {
          truncated = true;
        },
        log,
        signal: opts.signal,
        maxPages: opts.maxPages,
        needsDetail: (externalId, priceCzk) => needsDetailFor(known, externalId, priceCzk, retryBudget),
      };

      let buffer: NormalizedListing[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        const { safe, dropped } = sanitizeListings(batch);
        if (dropped > 0) log.warn(`dropped ${dropped} invalid listing(s) (non-https url)`);
        const counts = await upsertListings(db, safe);
        result.fetched += safe.length;
        result.newCount += counts.newCount;
        result.updatedCount += counts.updatedCount;
        await saveProgress();
      };

      for (const query of queries) {
        try {
          for await (const item of adapter.fetch(query, ctx)) {
            buffer.push(item);
            if (buffer.length >= BATCH_SIZE) await flush();
          }
        } catch (err) {
          errors.push(`${query.offerType}/${query.city}: ${errMsg(err)}`);
          log.error('query failed', { query, error: errMsg(err) });
        }
        try {
          await flush();
        } catch (err) {
          errors.push(`upsert ${query.offerType}/${query.city}: ${errMsg(err)}`);
          log.error('upsert failed', { error: errMsg(err) });
        }
      }

      const avg7d = await averageOkFetched(db, portal);
      result.status = classifyRunStatus({ fetched: result.fetched, hadError: errors.length > 0, avg7d });
      if (result.status === 'partial' && errors.length === 0) {
        errors.push(`fetched ${result.fetched} is below ${MIN_FETCHED_RATIO * 100}% of 7-day average ${avg7d}`);
      }
      if (result.status === 'failed' && errors.length === 0) errors.push('no listings fetched');
    }
  } catch (err) {
    errors.push(errMsg(err));
    result.status = result.fetched > 0 ? 'partial' : 'failed';
    log.error('run crashed', { error: errMsg(err) });
  }

  result.error = errors.length > 0 ? errors.join('; ').slice(0, 2000) : null;

  if (truncated) {
    log.warn('run truncated at maxPages; skipping markRemoved', { maxPages: opts.maxPages });
  } else if (result.status === 'ok' && result.fetched > 0) {
    try {
      await markRemoved(db, portal);
    } catch (err) {
      log.error('marking removed failed', { error: errMsg(err) });
    }
  }
  try {
    await rescoreAll(db);
  } catch (err) {
    log.error('rescore failed', { error: errMsg(err) });
  }

  await db
    .update(crawlRun)
    .set({
      status: result.status,
      finishedAt: new Date(),
      pages: result.pages,
      fetched: result.fetched,
      newCount: result.newCount,
      updatedCount: result.updatedCount,
      error: result.error,
    })
    .where(eq(crawlRun.id, runId));
  return result;
}

/** Sequential; a portal that throws (e.g. DB down) is reported as failed without stopping the rest. */
export async function runAll(
  db: Db,
  adapters: Partial<Record<Portal, PortalAdapter>>,
  opts: RunOptions,
): Promise<PortalRunResult[]> {
  const results: PortalRunResult[] = [];
  for (const adapter of Object.values(adapters)) {
    if (!adapter) continue;
    try {
      const timeout = AbortSignal.timeout(PORTAL_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      results.push(await runPortal(db, adapter, { ...opts, signal }));
    } catch (err) {
      console.error(`[crawl:${adapter.id}] run failed`, err);
      results.push({
        portal: adapter.id,
        runId: null,
        status: 'failed',
        pages: 0,
        fetched: 0,
        newCount: 0,
        updatedCount: 0,
        error: errMsg(err),
      });
    }
  }
  return results;
}
