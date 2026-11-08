import { eq } from 'drizzle-orm';
import { criteria, type Criteria } from '../../db/schema';
import type { Db } from '../../db/index';
import { normalizeText } from '../scoring/geo';
import type { CrawlQuery } from './types';

type QueryInput = Pick<
  Criteria,
  'offerType' | 'city' | 'layouts' | 'priceMin' | 'priceMax' | 'areaMin' | 'areaMax'
>;

/** Lower bound across criteria: any unbounded criteria makes the envelope unbounded. */
function mergeMin(values: (number | null)[]): number | undefined {
  if (values.some((v) => v == null)) return undefined;
  return Math.min(...(values as number[]));
}
function mergeMax(values: (number | null)[]): number | undefined {
  if (values.some((v) => v == null)) return undefined;
  return Math.max(...(values as number[]));
}

/**
 * One query per (offer_type, city): price/area envelope across criteria, union of layouts.
 * A criteria without layouts accepts any layout, so the merged query then has no layout restriction.
 */
export function deriveQueries(rows: QueryInput[]): CrawlQuery[] {
  const groups = new Map<string, QueryInput[]>();
  for (const r of rows) {
    const city = r.city.trim();
    if (city === '') continue;
    const key = `${r.offerType}\u0000${normalizeText(city)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  return [...groups.values()].map((g): CrawlQuery => {
    const q: CrawlQuery = { offerType: g[0]!.offerType, city: g[0]!.city.trim() };
    if (g.every((r) => r.layouts.length > 0)) {
      q.layouts = [...new Set(g.flatMap((r) => r.layouts))];
    }
    const priceMin = mergeMin(g.map((r) => r.priceMin));
    const priceMax = mergeMax(g.map((r) => r.priceMax));
    const areaMin = mergeMin(g.map((r) => r.areaMin));
    const areaMax = mergeMax(g.map((r) => r.areaMax));
    if (priceMin !== undefined) q.priceMin = priceMin;
    if (priceMax !== undefined) q.priceMax = priceMax;
    if (areaMin !== undefined) q.areaMin = areaMin;
    if (areaMax !== undefined) q.areaMax = areaMax;
    return q;
  });
}

export async function loadActiveQueries(db: Db): Promise<CrawlQuery[]> {
  const rows = await db.select().from(criteria).where(eq(criteria.active, true));
  return deriveQueries(rows);
}
