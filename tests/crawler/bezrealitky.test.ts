import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/crawler/http';
import { bezrealitkyAdapter, buildSearchUrl } from '../../src/crawler/portals/bezrealitky';
import type { CrawlCtx, CrawlQuery, NormalizedListing } from '../../src/crawler/types';

const fx = (name: string): string => readFileSync(new URL(`../fixtures/bezrealitky/${name}`, import.meta.url), 'utf8');
const P1 = fx('search-rent-brno-p1.html');
const P2 = fx('search-rent-brno-p2.html');
const SALE = fx('search-sale-praha.html');
const DETAIL = fx('detail-741248.html');

/** Edits the embedded __NEXT_DATA__ JSON of a fixture. */
function patch(html: string, fn: (d: any) => void): string {
  return html.replace(/(<script id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>)/, (_m, a: string, json: string, c: string) => {
    const d = JSON.parse(json);
    fn(d);
    return `${a}${JSON.stringify(d)}${c}`;
  });
}
const cacheOf = (d: any): Record<string, any> => d.props.pageProps.apolloCache;
const listEntry = (d: any): any => {
  const root = cacheOf(d)['ROOT_QUERY'];
  return root[Object.keys(root).find((k) => k.startsWith('listAdverts('))!];
};

function makeCtx(pages: (url: string) => string | Response, extra: Partial<CrawlCtx> = {}) {
  const urls: string[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: CrawlCtx = {
    fetch: async (u) => {
      const url = String(u);
      urls.push(url);
      const r = pages(url);
      return typeof r === 'string' ? new Response(r, { status: 200 }) : r;
    },
    log,
    maxPages: 5,
    needsDetail: () => false,
    ...extra,
  };
  return { ctx, urls, log };
}

async function collect(q: CrawlQuery, ctx: CrawlCtx): Promise<NormalizedListing[]> {
  const out: NormalizedListing[] = [];
  for await (const l of bezrealitkyAdapter.fetch(q, ctx)) out.push(l);
  return out;
}

const rentBrno: CrawlQuery = { offerType: 'rent', city: 'Brno' };

describe('buildSearchUrl', () => {
  it('builds rent URL with layouts, price, area and page', () => {
    const u = new URL(
      buildSearchUrl({ offerType: 'rent', city: 'Hradec Králové', layouts: ['2+kk', '2+1', 'atypicky'], priceMin: 10000, priceMax: 30000, areaMin: 40, areaMax: 80 }, 2),
    );
    expect(u.pathname).toBe('/vypis/nabidka-pronajem/byt/hradec-kralove');
    expect(u.searchParams.getAll('disposition')).toEqual(['DISP_2_KK', 'DISP_2_1']);
    expect(u.searchParams.get('priceFrom')).toBe('10000');
    expect(u.searchParams.get('priceTo')).toBe('30000');
    expect(u.searchParams.get('surfaceFrom')).toBe('40');
    expect(u.searchParams.get('surfaceTo')).toBe('80');
    expect(u.searchParams.get('page')).toBe('2');
  });
  it('uses sale path, slugifies presets and omits page=1', () => {
    for (const [city, slug] of [['Praha', 'praha'], ['Plzeň', 'plzen'], ['České Budějovice', 'ceske-budejovice'], ['Ostrava', 'ostrava']] as const) {
      const u = new URL(buildSearchUrl({ offerType: 'sale', city }, 1));
      expect(u.pathname).toBe(`/vypis/nabidka-prodej/byt/${slug}`);
      expect(u.search).toBe('');
    }
  });
});

describe('bezrealitkyAdapter field mapping (list data)', () => {
  it('maps a rent advert incl. fees, tags, coords and images', async () => {
    const { ctx } = makeCtx(() => patch(P1, (d) => (listEntry(d).totalCount = 4)));
    const res = await collect({ ...rentBrno, layouts: ['3+1'] }, ctx);
    expect(res).toHaveLength(4);
    const l = res.find((r) => r.externalId === '741248')!;
    expect(l).toMatchObject({
      portal: 'bezrealitky',
      url: 'https://www.bezrealitky.cz/nemovitosti-byty-domy/741248-nabidka-pronajem-bytu-kabatnikova',
      title: 'Pronájem bytu 3+1 71 m², Kabátníkova',
      offerType: 'rent',
      priceCzk: 22000,
      feesCzk: 5000,
      areaM2: 71,
      layout: '3+1',
      floor: null,
      condition: 'unknown',
      hasBalcony: true,
      hasParking: true,
      hasElevator: true,
      lat: 49.211,
      lng: 16.60052,
      city: 'Brno',
      district: 'Ponava',
      localityText: 'Kabátníkova, Brno - Ponava, Jihomoravský kraj',
    });
    expect(l.images.length).toBeGreaterThan(0);
    expect(l.images.length).toBeLessThanOrEqual(10);
    expect(l.images.every((i) => i.startsWith('https://'))).toBe(true);
    expect(l.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    const noTags = res.find((r) => r.externalId === '968827')!;
    expect(noTags).toMatchObject({ layout: '1+kk', priceCzk: 19900, feesCzk: 300, hasBalcony: null, hasParking: null, hasElevator: null });
  });

  it('maps a sale advert (no fees)', async () => {
    const { ctx, urls } = makeCtx(() => patch(SALE, (d) => (listEntry(d).totalCount = 2)));
    const res = await collect({ offerType: 'sale', city: 'Praha' }, ctx);
    expect(urls[0]).toBe('https://www.bezrealitky.cz/vypis/nabidka-prodej/byt/praha');
    expect(res).toHaveLength(2);
    for (const l of res) {
      expect(l.offerType).toBe('sale');
      expect(l.feesCzk).toBeNull();
      expect(l.priceCzk).toBeGreaterThan(100_000);
      expect(l.city).toBe('Praha');
    }
  });
});

describe('bezrealitkyAdapter detail hook', () => {
  it('fetches detail only when needsDetail says so and enriches floor/condition/images', async () => {
    const needsDetail = vi.fn((id: string) => id === '741248');
    const { ctx, urls } = makeCtx(
      (url) => (url.includes('/nemovitosti-byty-domy/741248') ? DETAIL : patch(P1, (d) => (listEntry(d).totalCount = 4))),
      { needsDetail },
    );
    const res = await collect(rentBrno, ctx);
    expect(needsDetail).toHaveBeenCalledWith('741248', 22000);
    expect(needsDetail).toHaveBeenCalledTimes(4);
    expect(urls.filter((u) => u.includes('/nemovitosti-byty-domy/'))).toHaveLength(1);
    const l = res.find((r) => r.externalId === '741248')!;
    expect(l.floor).toBe(4);
    expect(l.condition).toBe('good');
    expect(l.hasBalcony).toBe(true);
    expect(l.hasElevator).toBe(true);
    expect(l.images.length).toBeGreaterThan(3);
    expect(l.images.length).toBeLessThanOrEqual(10);
    expect(res.find((r) => r.externalId === '849236')!.floor).toBeNull();
  });

  it('falls back to list data (with a warning) when the detail page is broken', async () => {
    const { ctx, log } = makeCtx(
      (url) => (url.includes('/nemovitosti-byty-domy/') ? '<html>nope</html>' : patch(P1, (d) => (listEntry(d).totalCount = 4))),
      { needsDetail: () => true },
    );
    const res = await collect(rentBrno, ctx);
    expect(res).toHaveLength(4);
    expect(res[0]!.floor).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('detail unavailable'), expect.anything());
  });
});

describe('bezrealitkyAdapter pagination', () => {
  it('requests the next page until offset+limit reaches totalCount', async () => {
    const { ctx, urls } = makeCtx((url) => (url.includes('page=2') ? P2 : patch(P1, (d) => (listEntry(d).totalCount = 28))));
    const res = await collect(rentBrno, ctx);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get('page')).toBe('2');
    expect(res).toHaveLength(7);
    expect(new Set(res.map((r) => r.externalId)).size).toBe(7);
  });

  it('stops after the first page when everything fits on it', async () => {
    const { ctx, urls } = makeCtx(() => patch(P1, (d) => (listEntry(d).totalCount = 4)));
    await collect(rentBrno, ctx);
    expect(urls).toHaveLength(1);
  });

  it('respects ctx.maxPages', async () => {
    const { ctx, urls } = makeCtx(() => P1, { maxPages: 1 });
    await collect(rentBrno, ctx);
    expect(urls).toHaveLength(1);
  });

  it('signals truncation and counts list pages only when maxPages cuts off more results', async () => {
    const markTruncated = vi.fn();
    const countPage = vi.fn();
    const { ctx } = makeCtx(() => patch(P1, (d) => (listEntry(d).totalCount = 500)), { maxPages: 1, markTruncated, countPage, needsDetail: () => true });
    await collect(rentBrno, ctx);
    expect(markTruncated).toHaveBeenCalledTimes(1);
    expect(countPage).toHaveBeenCalledTimes(1);
  });

  it('does not signal truncation when the last page is reached', async () => {
    const markTruncated = vi.fn();
    const { ctx } = makeCtx(() => patch(P1, (d) => (listEntry(d).totalCount = 4)), { maxPages: 1, markTruncated });
    await collect(rentBrno, ctx);
    expect(markTruncated).not.toHaveBeenCalled();
  });

  it('stops on an empty page beyond the first', async () => {
    const empty = patch(P2, (d) => (listEntry(d).list = []));
    const { ctx, urls } = makeCtx((url) => (url.includes('page=2') ? empty : P1), { maxPages: 10 });
    const res = await collect(rentBrno, ctx);
    expect(urls).toHaveLength(2);
    expect(res).toHaveLength(4);
  });

  it('treats totalCount 0 as a legitimately empty result', async () => {
    const zero = patch(P1, (d) => {
      listEntry(d).list = [];
      listEntry(d).totalCount = 0;
    });
    const { ctx } = makeCtx(() => zero);
    expect(await collect(rentBrno, ctx)).toEqual([]);
  });

  it('aborts when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const { ctx, urls } = makeCtx(() => P1, { signal: ac.signal });
    await expect(collect(rentBrno, ctx)).rejects.toThrow('stop');
    expect(urls).toHaveLength(0);
  });
});

describe('bezrealitkyAdapter malformed items', () => {
  it('skips a malformed advert, logs it and keeps the rest', async () => {
    const html = patch(P1, (d) => {
      listEntry(d).totalCount = 4;
      cacheOf(d)['Advert:968827'].price = { not: 'a number' };
    });
    const { ctx, log } = makeCtx(() => html);
    const res = await collect(rentBrno, ctx);
    expect(res.map((r) => r.externalId)).not.toContain('968827');
    expect(res).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.objectContaining({ ref: 'Advert:968827' }));
  });

  it('skips a dangling reference', async () => {
    const html = patch(P1, (d) => {
      listEntry(d).totalCount = 4;
      delete cacheOf(d)['Advert:849236'];
    });
    const { ctx, log } = makeCtx(() => html);
    expect(await collect(rentBrno, ctx)).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('bezrealitkyAdapter structure changes', () => {
  it('throws when __NEXT_DATA__ is missing', async () => {
    const { ctx } = makeCtx(() => '<html><body>Just a moment...</body></html>');
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/__NEXT_DATA__ not found/);
  });
  it('throws when __NEXT_DATA__ is not valid JSON', async () => {
    const { ctx } = makeCtx(() => '<script id="__NEXT_DATA__" type="application/json">{oops</script>');
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/not valid JSON/);
  });
  it('throws when apolloCache is gone', async () => {
    const { ctx } = makeCtx(() => patch(P1, (d) => delete d.props.pageProps.apolloCache));
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/unexpected __NEXT_DATA__ shape/);
  });
  it('throws when the listAdverts query is missing', async () => {
    const { ctx } = makeCtx(() =>
      patch(P1, (d) => {
        const root = cacheOf(d)['ROOT_QUERY'];
        for (const k of Object.keys(root)) if (k.startsWith('listAdverts(')) delete root[k];
      }),
    );
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/listAdverts entry not found/);
  });
  it('throws when the first page has no adverts although totalCount > 0', async () => {
    const { ctx } = makeCtx(() => patch(P1, (d) => (listEntry(d).list = [])));
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/no adverts although totalCount=95/);
  });
  it('throws HttpError on a blocked response', async () => {
    const { ctx } = makeCtx(() => new Response('forbidden', { status: 403 }));
    await expect(collect(rentBrno, ctx)).rejects.toBeInstanceOf(HttpError);
  });
});
