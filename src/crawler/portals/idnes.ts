import * as cheerio from 'cheerio';
import { z } from 'zod';
import { normalizeCondition } from '../condition';
import { fingerprint } from '../fingerprint';
import { HttpError } from '../http';
import { safeHttpsUrl } from '../url';
import type { CrawlCtx, CrawlQuery, NormalizedListing, PortalAdapter } from '../types';

const BASE = 'https://reality.idnes.cz';
const ALLOWED_HOSTS = ['reality.idnes.cz'] as const;

/** Resolves a scraped href; null unless the result is https on the expected host. */
const resolveSafe = (href: string, base: string, hosts?: readonly string[]): string | null => {
  try {
    return safeHttpsUrl(new URL(href, base).toString(), hosts);
  } catch {
    return null;
  }
};
const MAX_IMAGES = 10;
const EMPTY_MARKER = /Moment[aá]ln[eě] tu nen[ií] [zž][aá]dn[yý] inzer[aá]t/i;

/*
 * Plain server-rendered HTML. Search: `/s/{pronajem|prodej}/byty/{city}/?f[...]` (redirects to a canonical
 * path-style URL, so subsequent pages are taken from the `a.paging__item.next` link, which is 0-based
 * `?page=N`). Cards (`.c-products__item`) carry id (24-hex in the detail URL), title (layout + area),
 * address, price and one thumbnail. Floor, condition, coordinates and the gallery exist only on the detail
 * page (`.b-definition-columns` params, `script[data-maptiler-json]`), fetched when `ctx.needsDetail` says so.
 */

export class IdnesStructureError extends Error {
  constructor(message: string) {
    super(`iDNES Reality: ${message}`);
    this.name = 'IdnesStructureError';
  }
}

const cardSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  url: z.url(),
  title: z.string().min(1),
  address: z.string().nullable(),
  priceText: z.string(),
  image: z.string().nullable(),
});
type Card = z.infer<typeof cardSchema>;

const geoSchema = z.object({
  geojson: z.object({
    features: z.array(
      z.object({
        geometry: z.object({ type: z.string(), coordinates: z.array(z.unknown()) }),
        properties: z.looseObject({ id: z.string().nullish(), isSimilar: z.boolean().nullish() }),
      }),
    ),
  }),
});

interface DetailInfo {
  params: Record<string, string>;
  condition: string | undefined;
  floor: number | null;
  hasBalcony: boolean | null;
  hasParking: boolean | null;
  hasElevator: boolean | null;
  description: string;
  lat: number | null;
  lng: number | null;
  images: string[];
}

const ws = (s: string): string =>
  s
    .replace(/[​-‍ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

export const slugify = (s: string): string =>
  fold(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const LAYOUT_CODE: Record<string, string> = { kk: 'k', '1': '1' };
function layoutCode(layout: string): string | null {
  const m = /^(\d)\s*\+\s*(kk|1)$/i.exec(layout.trim());
  return m ? `${m[1]}${LAYOUT_CODE[m[2]!.toLowerCase()]}` : null;
}

export function buildSearchUrl(q: CrawlQuery): string {
  const offer = q.offerType === 'rent' ? 'pronajem' : 'prodej';
  const url = new URL(`${BASE}/s/${offer}/byty/${slugify(q.city)}/`);
  for (const l of q.layouts ?? []) {
    const c = layoutCode(l);
    if (c) url.searchParams.append('f[subtypeFlat][]', c);
  }
  if (q.priceMin != null) url.searchParams.set('f[priceMin]', String(q.priceMin));
  if (q.priceMax != null) url.searchParams.set('f[priceMax]', String(q.priceMax));
  if (q.areaMin != null) url.searchParams.set('f[usableAreaMin]', String(q.areaMin));
  if (q.areaMax != null) url.searchParams.set('f[usableAreaMax]', String(q.areaMax));
  return url.toString();
}

const PRICE_RE = /(\d{1,3}(?:[\s\u00a0\u202f]\d{3})+|\d+)\s*Kč/;

export const priceOf = (text: string): number | null => {
  const m = PRICE_RE.exec(text);
  const n = m ? Number(m[1]!.replace(/\D+/g, '')) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const layoutOf = (title: string): string | null => {
  const m = /(\d)\s*\+\s*(kk|1)\b/i.exec(title);
  return m ? `${m[1]}+${m[2]!.toLowerCase()}` : null;
};

const areaOf = (title: string): number | null => {
  const m = /(\d+(?:[.,]\d+)?)\s*m²/.exec(title);
  const n = m ? Number(m[1]!.replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

function parseAddress(address: string | null): { city: string | null; district: string | null } {
  if (!address) return { city: null, district: null };
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  const withDash = parts.find((p) => p.includes(' - '));
  if (withDash) {
    const [city, ...rest] = withDash.split(' - ');
    return { city: city?.trim() || null, district: rest.join(' - ').trim() || null };
  }
  return { city: parts[parts.length - 1] ?? null, district: null };
}

const unescapeCss = (s: string): string => s.replace(/\\(.)/g, '$1');

const safeImage = (src: string | null | undefined, base: string): string | null =>
  src ? resolveSafe(src, base) : null;

interface SearchPage {
  cards: Array<{ raw: unknown; href: string | undefined; rawHref: string | undefined }>;
  nextUrl: string | null;
  nextHref?: string;
}

function parseSearchPage(html: string, pageUrl: string): SearchPage {
  const $ = cheerio.load(html);
  const items = $('.c-products__item').toArray();
  // Cards without a detail link are banners/ads, not listings.
  const listingItems = items.filter((el) => $(el).find('a.c-products__link[href]').length > 0);
  if (listingItems.length === 0) {
    if (EMPTY_MARKER.test($.root().text())) return { cards: [], nextUrl: null };
    throw new IdnesStructureError(`no listing cards (.c-products__item a.c-products__link) found on ${pageUrl}; page structure changed or blocked`);
  }

  const cards = listingItems.map((el) => {
    const card = $(el);
    const a = card.find('a.c-products__link').first();
    const href = a.attr('href');
    const abs = href ? (resolveSafe(href, pageUrl, ALLOWED_HOSTS) ?? undefined) : undefined;
    const bg = /url\(\s*'([^']+)'\s*\)/.exec(card.find('.c-products__img').first().attr('style') ?? '')?.[1];
    return {
      href: abs,
      rawHref: href,
      raw: {
        id: abs ? /\/([0-9a-f]{24})\/?(?:[?#].*)?$/.exec(abs)?.[1] : undefined,
        url: abs,
        title: ws(card.find('.c-products__title').first().text()),
        address: ws(card.find('.c-products__info').first().text()) || null,
        priceText: ws(card.find('.c-products__price').first().text()),
        image: safeImage(card.find('img[data-src]').first().attr('data-src') ?? (bg ? unescapeCss(bg) : null), pageUrl),
      },
    };
  });

  const next = $('a.paging__item.next[href]').first().attr('href');
  return { cards, nextUrl: next ? resolveSafe(next, pageUrl, ALLOWED_HOSTS) : null, nextHref: next };
}

function parseDetail(html: string, externalId: string, pageUrl: string): DetailInfo {
  const $ = cheerio.load(html);
  const params: Record<string, string> = {};
  $('.b-definition-columns dt').each((_, dt) => {
    const label = fold(ws($(dt).text()));
    if (label) params[label] = ws($(dt).next('dd').text());
  });
  if (Object.keys(params).length === 0 && $('h1.b-detail__title').length === 0) {
    throw new IdnesStructureError(`detail page has neither params nor title (${pageUrl})`);
  }

  const has = (re: RegExp): boolean => Object.keys(params).some((k) => re.test(k));
  const floorText = fold(params['podlazi'] ?? '');
  const floorMatch = /(\d+)\.\s*(?:patro|podlazi)/.exec(floorText);
  const parkingCount = Number(/\d+/.exec(params['pocet parkovacich mist'] ?? '')?.[0] ?? 0);

  let lat: number | null = null;
  let lng: number | null = null;
  const geoRaw = $('script[data-maptiler-json]').first().html();
  if (geoRaw) {
    try {
      const geo = geoSchema.safeParse(JSON.parse(geoRaw));
      const own = geo.success
        ? geo.data.geojson.features.find((f) => f.properties.id === externalId && !f.properties.isSimilar && f.geometry.type === 'Point')
        : undefined;
      const [x, y] = own?.geometry.coordinates ?? [];
      if (typeof x === 'number' && typeof y === 'number') {
        lng = x;
        lat = y;
      }
    } catch {
      // coordinates are optional; ignore unparsable map JSON
    }
  }

  const images: string[] = [];
  $('a[data-fancybox="images"][href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || images.length >= MAX_IMAGES) return;
    const abs = resolveSafe(href, pageUrl);
    if (abs && !images.includes(abs)) images.push(abs);
  });

  const conditionKey = Object.keys(params).find((k) => k.startsWith('stav '));
  return {
    params,
    condition: conditionKey ? params[conditionKey] : undefined,
    floor: floorMatch ? Number(floorMatch[1]) : /prizemi/.test(floorText) ? 0 : null,
    hasBalcony: has(/^(balkon|lodzie|terasa)/) ? true : null,
    hasParking: has(/^(parkovani|garaz)/) || parkingCount > 0 ? true : null,
    hasElevator: has(/^vytah/) ? true : null,
    description: ws($('.b-desc').first().text()),
    lat,
    lng,
    images,
  };
}

function mapCard(card: Card, detail: DetailInfo | null, q: CrawlQuery): NormalizedListing {
  const offerType = q.offerType;
  const title = card.title.charAt(0).toUpperCase() + card.title.slice(1);
  const layout = layoutOf(card.title);
  const areaM2 = areaOf(card.title);
  const { city, district } = parseAddress(card.address);
  const images = detail && detail.images.length > 0 ? detail.images : card.image ? [card.image] : [];

  return {
    portal: 'idnes',
    externalId: card.id,
    url: card.url,
    title,
    offerType,
    priceCzk: priceOf(card.priceText),
    feesCzk: null,
    areaM2,
    layout,
    floor: detail?.floor ?? null,
    condition: normalizeCondition(detail?.condition, `${title} ${detail?.description ?? ''}`),
    hasBalcony: detail?.hasBalcony ?? null,
    hasParking: detail?.hasParking ?? null,
    hasElevator: detail?.hasElevator ?? null,
    lat: detail?.lat ?? null,
    lng: detail?.lng ?? null,
    localityText: card.address,
    city,
    district,
    images: images.slice(0, MAX_IMAGES),
    raw: { card, detail: detail ? { params: detail.params } : null },
    fingerprint: fingerprint({ portal: 'idnes', externalId: card.id, offerType, layout, areaM2, lat: detail?.lat, lng: detail?.lng }),
  };
}

async function getHtml(url: string, ctx: CrawlCtx): Promise<{ html: string; finalUrl: string }> {
  const res = await ctx.fetch(url, {
    signal: ctx.signal,
    headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'cs-CZ,cs;q=0.9' },
  });
  if (!res.ok) throw new HttpError(`iDNES Reality: HTTP ${res.status} for ${url}`, res.status);
  return { html: await res.text(), finalUrl: res.url || url };
}

async function loadDetail(card: Card, ctx: CrawlCtx): Promise<DetailInfo | null> {
  try {
    const { html, finalUrl } = await getHtml(card.url, ctx);
    return parseDetail(html, card.id, safeHttpsUrl(finalUrl, ALLOWED_HOSTS) ?? card.url);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.log.warn('idnes: detail unavailable, using list data only', { id: card.id, error: String(err) });
    return null;
  }
}

export const idnesAdapter: PortalAdapter = {
  id: 'idnes',
  async *fetch(q, ctx) {
    const seenIds = new Set<string>();
    const seenPages = new Set<string>();
    let url: string | null = buildSearchUrl(q);

    for (let page = 1; url && page <= ctx.maxPages; page++) {
      ctx.signal?.throwIfAborted();
      seenPages.add(url);
      ctx.countPage?.();
      const { html, finalUrl } = await getHtml(url, ctx);
      const sp = parseSearchPage(html, finalUrl);
      ctx.log.debug('idnes: page parsed', { page, cards: sp.cards.length });

      for (const c of sp.cards) {
        const parsed = cardSchema.safeParse(c.raw);
        if (!parsed.success) {
          ctx.log.warn('idnes: skipping malformed card', { href: c.rawHref, issues: z.prettifyError(parsed.error) });
          continue;
        }
        const card = parsed.data;
        if (seenIds.has(card.id)) continue;
        seenIds.add(card.id);

        const detail = (ctx.needsDetail ? await Promise.resolve(ctx.needsDetail(card.id, priceOf(card.priceText))) : true) ? await loadDetail(card, ctx) : null;
        yield mapCard(card, detail, q);
      }

      if (sp.nextHref && !sp.nextUrl) ctx.log.warn('idnes: skipping disallowed next-page url', { href: sp.nextHref });
      url = sp.nextUrl && !seenPages.has(sp.nextUrl) ? sp.nextUrl : null;
    }
    if (url) ctx.markTruncated?.();
  },
};
