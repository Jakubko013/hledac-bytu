import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/crawler/http';
import { buildSearchUrl, idnesAdapter, priceOf } from '../../src/crawler/portals/idnes';
import type { CrawlCtx, CrawlQuery, NormalizedListing } from '../../src/crawler/types';

const fx = (name: string): string => readFileSync(new URL(`../fixtures/idnes/${name}`, import.meta.url), 'utf8');
const P1 = fx('search-rent-brno-p1.html');
const EMPTY = fx('search-empty.html');
const DETAIL_OWN = fx('detail-6ae8c7facf2252b4ac0a61d3.html'); // Vondrákova, "velmi dobrý stav", exact coords
const DETAIL_NOGEO = fx('detail-6ae059136f90e17c9f01d3ff.html'); // Dunajská, only similar listings on the map
const DETAIL_SALE = fx('detail-6aae6eacb0b2c974510600e8.html'); // Praha 10 sale, "po rekonstrukci"

const ID_A = '6ae8c7facf2252b4ac0a61d3';
const ID_B = '6ae8c5b47e4797d101095757';
const ID_NOGEO = '6ae059136f90e17c9f01d3ff';

function makeCtx(pages: (url: string, call: number) => string | Response, extra: Partial<CrawlCtx> = {}) {
  const urls: string[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: CrawlCtx = {
    fetch: async (u) => {
      const url = String(u);
      urls.push(url);
      const r = pages(url, urls.length - 1);
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
  for await (const l of idnesAdapter.fetch(q, ctx)) out.push(l);
  return out;
}

const rentBrno: CrawlQuery = { offerType: 'rent', city: 'Brno' };
const noNext = (html: string): string => html.replace('paging__item next', 'paging__item');

describe('buildSearchUrl', () => {
  it('builds rent URL with filters', () => {
    const u = new URL(
      buildSearchUrl({ offerType: 'rent', city: 'České Budějovice', layouts: ['2+kk', '2+1', 'atypicky'], priceMin: 10000, priceMax: 25000, areaMin: 40, areaMax: 70 }),
    );
    expect(u.pathname).toBe('/s/pronajem/byty/ceske-budejovice/');
    expect(u.searchParams.getAll('f[subtypeFlat][]')).toEqual(['2k', '21']);
    expect(u.searchParams.get('f[priceMin]')).toBe('10000');
    expect(u.searchParams.get('f[priceMax]')).toBe('25000');
    expect(u.searchParams.get('f[usableAreaMin]')).toBe('40');
    expect(u.searchParams.get('f[usableAreaMax]')).toBe('70');
  });
  it('uses the sale path and slugifies presets', () => {
    for (const [city, slug] of [['Praha', 'praha'], ['Plzeň', 'plzen'], ['Hradec Králové', 'hradec-kralove'], ['Olomouc', 'olomouc']] as const) {
      const u = new URL(buildSearchUrl({ offerType: 'sale', city }));
      expect(u.pathname).toBe(`/s/prodej/byty/${slug}/`);
      expect(u.search).toBe('');
    }
  });
});

describe('idnesAdapter field mapping (list data)', () => {
  it('maps cards, skipping link-less banner cards', async () => {
    const { ctx } = makeCtx(() => noNext(P1));
    const res = await collect(rentBrno, ctx);
    expect(res).toHaveLength(4);
    const l = res.find((r) => r.externalId === ID_A)!;
    expect(l).toMatchObject({
      portal: 'idnes',
      url: `https://reality.idnes.cz/detail/pronajem/byt/brno-vondrakova/${ID_A}/`,
      title: 'Pronájem bytu 1+1 33 m²',
      offerType: 'rent',
      priceCzk: 15000,
      feesCzk: null,
      areaM2: 33,
      layout: '1+1',
      floor: null,
      condition: 'unknown',
      hasBalcony: null,
      lat: null,
      city: 'Brno',
      district: 'Bystrc',
      localityText: 'Vondrákova, Brno - Bystrc',
    });
    expect(l.images).toHaveLength(1);
    expect(l.images[0]).toMatch(/^https:\/\/sta-reality2\.1gr\.cz\/.*\.webp$/);
    expect(res.find((r) => r.externalId === ID_B)).toMatchObject({ layout: '4+kk', areaM2: 120, priceCzk: 30500 });
  });
});

describe('idnesAdapter detail hook', () => {
  it('enriches floor, condition, extras, coords and gallery from the detail page', async () => {
    const needsDetail = vi.fn((id: string) => id === ID_A);
    const { ctx, urls } = makeCtx((url) => (url.includes(`/detail/`) ? DETAIL_OWN : noNext(P1)), { needsDetail });
    const res = await collect(rentBrno, ctx);
    expect(needsDetail).toHaveBeenCalledWith(ID_A, 15000);
    expect(urls.filter((u) => u.includes('/detail/'))).toEqual([`https://reality.idnes.cz/detail/pronajem/byt/brno-vondrakova/${ID_A}/`]);
    const l = res.find((r) => r.externalId === ID_A)!;
    expect(l.floor).toBe(2);
    expect(l.condition).toBe('good'); // portal "velmi dobrý stav" wins over "po rekonstrukci" in the text
    expect(l.hasBalcony).toBe(true); // Lodžie
    expect(l.lat).toBeCloseTo(49.2217333, 5);
    expect(l.lng).toBeCloseTo(16.5264203, 5);
    expect(l.images).toHaveLength(5);
    expect(res.find((r) => r.externalId === ID_B)!.floor).toBeNull();
  });

  it('does not take coordinates from similar listings on the map', async () => {
    const html = noNext(P1).replaceAll(ID_B, ID_NOGEO);
    const { ctx } = makeCtx((url) => (url.includes('/detail/') ? DETAIL_NOGEO : html), { needsDetail: (id) => id === ID_NOGEO });
    const l = (await collect(rentBrno, ctx)).find((r) => r.externalId === ID_NOGEO)!;
    expect(l.lat).toBeNull();
    expect(l.lng).toBeNull();
    expect(l.floor).toBe(6);
    expect(l.hasElevator).toBe(true);
    expect(l.condition).toBe('renovated');
  });

  it('parses a sale detail (high floor, elevator, balcony, renovated)', async () => {
    const id = '6aae6eacb0b2c974510600e8';
    const html = noNext(P1).replaceAll(ID_B, id);
    const { ctx } = makeCtx((url) => (url.includes('/detail/') ? DETAIL_SALE : html), { needsDetail: (i) => i === id });
    const l = (await collect({ offerType: 'sale', city: 'Praha' }, ctx)).find((r) => r.externalId === id)!;
    expect(l).toMatchObject({ offerType: 'sale', floor: 10, hasElevator: true, hasBalcony: true, condition: 'renovated' });
    expect(l.lat).toBeCloseTo(50.0597, 3);
  });

  it('falls back to list data with a warning when the detail request fails', async () => {
    const { ctx, log } = makeCtx((url) => (url.includes('/detail/') ? new Response('', { status: 500 }) : noNext(P1)), { needsDetail: () => true });
    const res = await collect(rentBrno, ctx);
    expect(res).toHaveLength(4);
    expect(res[0]!.floor).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('detail unavailable'), expect.anything());
  });
});

describe('idnesAdapter pagination', () => {
  it('follows the "next" link and de-duplicates; stops when there is none', async () => {
    const { ctx, urls } = makeCtx((_u, call) => (call === 0 ? P1 : noNext(P1)));
    const res = await collect(rentBrno, ctx);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe('https://reality.idnes.cz/s/pronajem/byty/brno-mesto/?page=1');
    expect(res).toHaveLength(4);
  });

  it('respects ctx.maxPages', async () => {
    const { ctx, urls } = makeCtx(() => P1, { maxPages: 1 });
    await collect(rentBrno, ctx);
    expect(urls).toHaveLength(1);
  });

  it('does not loop on a self-referencing next link', async () => {
    const { ctx, urls } = makeCtx((u) => P1.replace('/s/pronajem/byty/brno-mesto/?page=1" class="btn paging__item next', `${new URL(u).pathname}${new URL(u).search}" class="btn paging__item next`), { maxPages: 10 });
    await collect(rentBrno, ctx);
    expect(urls).toHaveLength(1);
  });

  it('accepts the explicit "no results" page', async () => {
    const { ctx, urls } = makeCtx(() => EMPTY);
    expect(await collect(rentBrno, ctx)).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('aborts when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const { ctx, urls } = makeCtx(() => P1, { signal: ac.signal });
    await expect(collect(rentBrno, ctx)).rejects.toThrow('stop');
    expect(urls).toHaveLength(0);
  });
});

describe('idnesAdapter malformed items', () => {
  it('skips a card with an unrecognizable id and logs it', async () => {
    const html = noNext(P1).replace(`/brno-vranovska/${ID_B}/`, '/brno-vranovska/not-an-id/');
    const { ctx, log } = makeCtx(() => html);
    const res = await collect(rentBrno, ctx);
    expect(res).toHaveLength(3);
    expect(res.map((r) => r.externalId)).not.toContain(ID_B);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.anything());
  });

  it('skips a card without a title', async () => {
    const html = noNext(P1).replace(/<h2 class="c-products__title">[\s\S]*?<\/h2>/, '<h2 class="c-products__title"></h2>');
    const { ctx, log } = makeCtx(() => html);
    expect(await collect(rentBrno, ctx)).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps a card with an unparsable price as priceCzk null', async () => {
    const html = noNext(P1).replace('15 000 Kč/měsíc', 'Info u RK');
    const { ctx } = makeCtx(() => html);
    const res = await collect(rentBrno, ctx);
    expect(res.find((r) => r.externalId === ID_A)!.priceCzk).toBeNull();
  });
});

describe('idnesAdapter structure changes', () => {
  it('throws when there are no listing cards and no "no results" marker', async () => {
    const { ctx } = makeCtx(() => '<html><body><div id="app">Redesigned</div></body></html>');
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/no listing cards/);
  });
  it('throws when the card markup changed (link class renamed)', async () => {
    const { ctx } = makeCtx(() => P1.replaceAll('c-products__link', 'c-card__link'));
    await expect(collect(rentBrno, ctx)).rejects.toThrow(/no listing cards/);
  });
  it('throws HttpError on a blocked response', async () => {
    const { ctx } = makeCtx(() => new Response('forbidden', { status: 403 }));
    await expect(collect(rentBrno, ctx)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('idnesAdapter without a needsDetail hook', () => {
  it('fetches detail pages for every card', async () => {
    const { ctx, urls } = makeCtx((url) => (url.includes('/detail/') ? DETAIL_OWN : noNext(P1)));
    delete ctx.needsDetail;
    await collect(rentBrno, ctx);
    expect(urls.filter((u) => u.includes('/detail/'))).toHaveLength(4);
  });
});

describe('idnes url hardening', () => {
  const card = (href: string, img = 'https://sta-reality2.1gr.cz/a.jpg') =>
    `<div class="c-products__item"><a class="c-products__link" href="${href}"><span class="c-products__title">2+kk 50 m²</span></a>` +
    `<p class="c-products__info">Brno</p><p class="c-products__price">10 000 Kč</p><img data-src="${img}"></div>`;
  const page = (cards: string, next = '') => `<html><body>${cards}${next}</body></html>`;
  const run = async (html: string) => {
    const { ctx, log } = (() => {
      const c = makeCtx(() => html);
      return { ctx: c.ctx, log: c.ctx.log };
    })();
    const out: NormalizedListing[] = [];
    for await (const l of idnesAdapter.fetch(q, ctx)) out.push(l);
    return { out, log };
  };
  const q: CrawlQuery = { offerType: 'rent', city: 'Brno' };
  const ok = 'https://reality.idnes.cz/detail/6ae8c7facf2252b4ac0a61d3/';

  it('skips cards with foreign hosts or non-https schemes', async () => {
    const { out, log } = await run(
      page(
        card('https://evil.example/6ae8c7facf2252b4ac0a61d3/') +
          card('http://reality.idnes.cz/6ae8c5b47e4797d101095757/') +
          card('javascript:alert(1)') +
          card(ok),
      ),
    );
    expect(out.map((l) => l.externalId)).toEqual(['6ae8c7facf2252b4ac0a61d3']);
    expect(log.warn).toHaveBeenCalled();
  });
  it('drops non-https card images', async () => {
    const { out } = await run(page(card(ok, 'http://cdn.example/a.jpg')));
    expect(out[0]!.images).toEqual([]);
  });
  it('does not follow a foreign next-page link', async () => {
    const calls: string[] = [];
    const { ctx } = makeCtx((u) => (calls.push(u), page(card(ok), '<a class="paging__item next" href="https://evil.example/?page=1">n</a>')));
    for await (const _ of idnesAdapter.fetch(q, ctx)) void _;
    expect(calls.every((u) => new URL(u).hostname === 'reality.idnes.cz')).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('priceOf', () => {
  it('parses a plain price with period suffix', () => expect(priceOf('15 000 Kč/měsíc')).toBe(15000));
  it('parses nbsp-separated thousands', () => expect(priceOf('1\u00a0250\u00a0000 Kč')).toBe(1250000));
  it('takes only the first amount when a discount is shown', () => {
    expect(priceOf('15 000 Kč 17 500 Kč')).toBe(15000);
    expect(priceOf('Sleva 12 900 Kč původně 14 500 Kč/měsíc')).toBe(12900);
  });
  it('ignores "+ poplatky" amounts', () => {
    expect(priceOf('18 000 Kč + 3 500 Kč poplatky')).toBe(18000);
    expect(priceOf('18 000 Kč + poplatky')).toBe(18000);
  });
  it('returns null without an amount', () => expect(priceOf('Info u RK')).toBeNull());
});
