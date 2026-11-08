import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildSearchUrl, parseFees, srealityAdapter } from '../../src/crawler/portals/sreality';
import type { CrawlCtx, CrawlQuery, NormalizedListing } from '../../src/crawler/types';

const load = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/sreality/${n}.json`, import.meta.url), 'utf8'));
const search = () => load('search-brno-rent-2kk');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const query: CrawlQuery = { offerType: 'rent', city: 'Brno', layouts: ['2+kk'] };

function makeCtx(handler: (url: string) => Response | Promise<Response>, over: Partial<CrawlCtx> = {}) {
  const fetch = vi.fn(async (url: string | URL) => handler(String(url)));
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: CrawlCtx = { fetch, log, maxPages: 5, ...over };
  return { ctx, fetch, log };
}

async function collect(q: CrawlQuery, ctx: CrawlCtx): Promise<NormalizedListing[]> {
  const out: NormalizedListing[] = [];
  for await (const l of srealityAdapter.fetch(q, ctx)) out.push(l);
  return out;
}

const details: Record<string, unknown> = {
  '2338390092': load('detail-with-fees'),
  '622198860': load('detail-minimal'),
};
const route = (url: string): Response => {
  if (url.includes('/estates/search')) return json(search());
  const id = url.split('/').pop()!;
  return details[id] ? json(details[id]) : new Response('', { status: 404 });
};

describe('srealityAdapter', () => {
  it('maps every NormalizedListing field (with detail)', async () => {
    const { ctx } = makeCtx(route);
    const [l] = await collect(query, ctx);
    expect(l).toMatchObject({
      portal: 'sreality',
      externalId: '2338390092',
      url: 'https://www.sreality.cz/detail/pronajem/byt/2+kk/brno-zabrdovice-pricni/2338390092',
      title: 'Pronájem bytu 2+kk 57 m²',
      offerType: 'rent',
      priceCzk: 23900,
      feesCzk: 4963,
      areaM2: 57,
      layout: '2+kk',
      floor: 6,
      condition: 'new_build',
      hasBalcony: true,
      hasParking: true,
      hasElevator: true,
      city: 'Brno',
    });
    expect(l!.lat).toBeCloseTo(49.2, 0);
    expect(l!.lng).toBeCloseTo(16.6, 0);
    expect(l!.localityText).toContain('Brno');
    expect(l!.district).toBeTruthy();
    expect(l!.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(l!.raw).toHaveProperty('list.hash_id', 2338390092);
    expect(l!.raw).not.toHaveProperty('list.advert_images_all');
  });

  it('caps images at 10, prefixes https and sizes them', async () => {
    const { ctx } = makeCtx(route);
    const [l] = await collect(query, ctx);
    expect(l!.images).toHaveLength(10);
    expect(l!.images.every((u) => u.startsWith('https://') && u.includes('?fl=res,749,562'))).toBe(true);
  });

  it('keeps unknown extras null when detail is missing or empty (elevator not set)', async () => {
    const { ctx } = makeCtx(route);
    const all = await collect(query, ctx);
    const minimal = all.find((l) => l.externalId === '622198860')!;
    expect(minimal).toMatchObject({ condition: 'good', hasElevator: null, hasBalcony: true, hasParking: false, feesCzk: null, floor: 5 });
    const noDetail = all.find((l) => l.externalId === '877002828')!; // detail 404
    expect(noDetail).toMatchObject({ condition: 'unknown', floor: null, hasBalcony: null, hasParking: null, hasElevator: null, feesCzk: null });
    expect(noDetail.areaM2).toBe(65); // parsed from title
    expect(noDetail.priceCzk).toBe(20990);
  });

  it('fetches detail only when needsDetail says so', async () => {
    const needsDetail = vi.fn((id: string) => id === '2338390092');
    const { ctx, fetch } = makeCtx(route, { needsDetail });
    const all = await collect(query, ctx);
    expect(needsDetail).toHaveBeenCalledWith('622198860', 15500);
    expect(fetch.mock.calls.filter(([u]) => !String(u).includes('/search'))).toHaveLength(1);
    expect(all[0]!.floor).toBe(6);
    expect(all[1]!.floor).toBeNull();
  });

  it('stops paginating when offset reaches total', async () => {
    const { ctx, fetch } = makeCtx(route, { needsDetail: () => false });
    await collect(query, ctx);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('continues until total and respects maxPages', async () => {
    const page = (offset: number) => ({ ...search(), pagination: { limit: 60, offset, total: 500 } });
    const { ctx, fetch } = makeCtx((u) => json(page(Number(new URL(u).searchParams.get('offset')))), {
      needsDetail: () => false,
      maxPages: 3,
    });
    await collect(query, ctx);
    const offsets = fetch.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '60', '120']);
  });

  it('stops on an empty page', async () => {
    const { ctx, fetch } = makeCtx(() => json({ pagination: { limit: 60, offset: 0, total: 500 }, results: [] }));
    expect(await collect(query, ctx)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('skips malformed items and logs them', async () => {
    const body = search();
    body.results.splice(1, 0, { hash_id: 'nope' }, { advert_name: 'x' });
    const { ctx, log } = makeCtx((u) => (u.includes('/search') ? json(body) : json({}, 404)), { needsDetail: () => false });
    const all = await collect(query, ctx);
    expect(all.map((l) => l.externalId)).toEqual(['2338390092', '622198860', '877002828']);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('skips items from other cities of the same okres', async () => {
    const body = search();
    body.results[0].locality.city = 'Modřice';
    const { ctx } = makeCtx(() => json(body), { needsDetail: () => false });
    expect((await collect(query, ctx)).map((l) => l.externalId)).toEqual(['622198860', '877002828']);
  });

  it('throws a descriptive error on schema mismatch', async () => {
    const { ctx } = makeCtx(() => json({ pagination: { total: 'many' }, items: [] }));
    await expect(collect(query, ctx)).rejects.toThrow(/Sreality: search response schema mismatch/);
  });

  it('throws on non-200 search and on unsupported city', async () => {
    const { ctx } = makeCtx(() => new Response('', { status: 404 }));
    await expect(collect(query, ctx)).rejects.toThrow(/HTTP 404/);
    await expect(collect({ ...query, city: 'Atlantis' }, ctx)).rejects.toThrow(/unsupported city/);
  });

  it('tolerates a failing detail (keeps list data, warns)', async () => {
    const { ctx, log } = makeCtx((u) => (u.includes('/search') ? json(search()) : json({ result: { floor_number: 'x' } })));
    const all = await collect(query, ctx);
    expect(all).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledWith('sreality: detail schema mismatch', expect.anything());
  });

  it('aborts when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const { ctx } = makeCtx(route, { signal: ac.signal });
    await expect(collect(query, ctx)).rejects.toThrow('stop');
  });
});

describe('buildSearchUrl', () => {
  it('encodes sale/rent, layouts, price, area and city', () => {
    const u = new URL(
      buildSearchUrl({ offerType: 'sale', city: 'Plzeň', layouts: ['2+kk', '3+1', 'atypický'], priceMin: 1, priceMax: 9, areaMin: 40, areaMax: 80 }, 60),
    );
    const p = u.searchParams;
    expect(u.pathname).toBe('/api/v1/estates/search');
    expect(Object.fromEntries(p)).toEqual({
      category_main_cb: '1',
      category_type_cb: '1',
      locality_district_id: '12',
      limit: '60',
      offset: '60',
      category_sub_cb: '4,7,16',
      price_from: '1',
      price_to: '9',
      usable_area_from: '40',
      usable_area_to: '80',
    });
  });
  it('uses rent code and omits empty filters', () => {
    const p = new URL(buildSearchUrl({ offerType: 'rent', city: 'České Budějovice' }, 0)).searchParams;
    expect(p.get('category_type_cb')).toBe('2');
    expect(p.get('locality_district_id')).toBe('1');
    expect(p.has('category_sub_cb')).toBe(false);
    expect(p.has('price_from')).toBe(false);
  });
});

describe('parseFees', () => {
  const d = (cost_of_living: string | null, price_note: string | null) => ({ cost_of_living, price_note }) as never;
  it('parses the common real-world formats', () => {
    expect(parseFees(d('5 262Kč (včetně elektřiny, pojištění..)', ''))).toBe(5262);
    expect(parseFees(d('5 059,- Kč zálohy na energie a služby', ''))).toBe(5059);
    expect(parseFees(d('', 'vratná jistota, náklady na bydlení 3660 Kč, poplatek'))).toBe(3660);
    expect(parseFees(d('', 'vratná kauce 30 000 Kč'))).toBeNull();
    expect(parseFees(null)).toBeNull();
  });
});
