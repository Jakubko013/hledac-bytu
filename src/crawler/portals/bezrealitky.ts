import { z } from 'zod';
import { normalizeCondition } from '../condition';
import { fingerprint } from '../fingerprint';
import { HttpError } from '../http';
import type { CrawlCtx, CrawlQuery, NormalizedListing, PortalAdapter } from '../types';

const BASE = 'https://www.bezrealitky.cz';
const DEFAULT_LIMIT = 15;
const MAX_IMAGES = 10;

/*
 * Data source: the search page embeds Next.js `__NEXT_DATA__` whose `props.pageProps.apolloCache` is a
 * normalized Apollo cache: `ROOT_QUERY["listAdverts({...args})"] = { totalCount, list: [{__ref}] }`,
 * `Advert:<id>` and `Image:<id>` entries. Field keys carry their GraphQL arguments, e.g.
 * `address({"locale":"CS"})`, `url({"filter":"RECORD_MAIN"})`. Floor and condition exist only on the
 * detail page (`/nemovitosti-byty-domy/<uri>`), fetched only when `ctx.needsDetail` says so.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cache value for field `name`, regardless of the GraphQL arguments baked into the key. */
function pick(obj: Json, name: string): unknown {
  if (name in obj) return obj[name];
  const prefix = `${name}(`;
  for (const k of Object.keys(obj)) if (k.startsWith(prefix)) return obj[k];
  return undefined;
}

const refSchema = z.object({ __ref: z.string() });
const idSchema = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);
const num = z.number().nullish();
const bool = z.boolean().nullish();
const gpsSchema = z.object({ lat: z.number(), lng: z.number() }).nullish();

const nextDataSchema = z.object({
  props: z.object({ pageProps: z.object({ apolloCache: z.record(z.string(), z.unknown()) }) }),
});

const listEntrySchema = z.object({ totalCount: z.number().int().nonnegative(), list: z.array(refSchema) });

const listAdvertSchema = z.object({
  id: idSchema,
  uri: z.string().min(1),
  offerType: z.enum(['PRONAJEM', 'PRODEJ']),
  disposition: z.string().nullish(),
  surface: num,
  price: num,
  charges: num,
  gps: gpsSchema,
  address: z.string().nullish(),
  imageAltText: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  mainImage: refSchema.nullish(),
  publicImages: z.array(refSchema).nullish(),
});
type ListAdvert = z.infer<typeof listAdvertSchema>;

const detailSchema = z.object({
  condition: z.string().nullish(),
  etage: z.number().int().nullish(),
  description: z.string().nullish(),
  balcony: bool,
  loggia: bool,
  terrace: bool,
  parking: bool,
  garage: bool,
  lift: bool,
  gps: gpsSchema,
  publicImages: z.array(refSchema).nullish(),
  mainImage: refSchema.nullish(),
});
type DetailAdvert = z.infer<typeof detailSchema>;

export class BezrealitkyStructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Bezrealitky: ${message}`, options);
    this.name = 'BezrealitkyStructureError';
  }
}

function readCache(html: string, where: string): Record<string, unknown> {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new BezrealitkyStructureError(`__NEXT_DATA__ not found on ${where} (page structure changed or blocked)`);
  let json: unknown;
  try {
    json = JSON.parse(m[1]);
  } catch (err) {
    throw new BezrealitkyStructureError(`__NEXT_DATA__ is not valid JSON on ${where}`, { cause: err });
  }
  const parsed = nextDataSchema.safeParse(json);
  if (!parsed.success) {
    throw new BezrealitkyStructureError(`unexpected __NEXT_DATA__ shape on ${where}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.props.pageProps.apolloCache;
}

interface SearchPage {
  cache: Record<string, unknown>;
  totalCount: number;
  limit: number;
  refs: string[];
}

function parseSearchPage(html: string, where: string): SearchPage {
  const cache = readCache(html, where);
  const root = cache['ROOT_QUERY'];
  if (!isObj(root)) throw new BezrealitkyStructureError(`ROOT_QUERY missing in apolloCache on ${where}`);
  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith('listAdverts(')) continue;
    let args: unknown;
    try {
      args = JSON.parse(key.slice(key.indexOf('(') + 1, key.lastIndexOf(')')));
    } catch {
      continue;
    }
    // The paginated main query has numeric `offset`; other listAdverts entries are promo widgets.
    if (!isObj(args) || typeof args['offset'] !== 'number') continue;
    const entry = listEntrySchema.safeParse(value);
    if (!entry.success) {
      throw new BezrealitkyStructureError(`unexpected listAdverts shape on ${where}: ${z.prettifyError(entry.error)}`);
    }
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? args['limit'] : DEFAULT_LIMIT;
    return { cache, totalCount: entry.data.totalCount, limit, refs: entry.data.list.map((r) => r.__ref) };
  }
  throw new BezrealitkyStructureError(`listAdverts entry not found in apolloCache on ${where}`);
}

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

export const slugify = (s: string): string =>
  fold(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function dispositionOf(layout: string): string | null {
  const m = /^(\d)\s*\+\s*(kk|1)$/i.exec(layout.trim());
  return m ? `DISP_${m[1]}_${m[2]!.toUpperCase()}` : null;
}

export function layoutOf(disposition: string | null | undefined): string | null {
  const m = /^DISP_(\d)_(KK|1)$/.exec(disposition ?? '');
  return m ? `${m[1]}+${m[2] === 'KK' ? 'kk' : '1'}` : null;
}

export function buildSearchUrl(q: CrawlQuery, page: number): string {
  const offer = q.offerType === 'rent' ? 'nabidka-pronajem' : 'nabidka-prodej';
  const url = new URL(`${BASE}/vypis/${offer}/byt/${slugify(q.city)}`);
  for (const l of q.layouts ?? []) {
    const d = dispositionOf(l);
    if (d) url.searchParams.append('disposition', d);
  }
  if (q.priceMin != null) url.searchParams.set('priceFrom', String(q.priceMin));
  if (q.priceMax != null) url.searchParams.set('priceTo', String(q.priceMax));
  if (q.areaMin != null) url.searchParams.set('surfaceFrom', String(q.areaMin));
  if (q.areaMax != null) url.searchParams.set('surfaceTo', String(q.areaMax));
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function imageUrl(cache: Record<string, unknown>, ref: string): string | null {
  const img = cache[ref];
  if (!isObj(img)) return null;
  let fallback: string | null = null;
  for (const [k, v] of Object.entries(img)) {
    if (!k.startsWith('url(') || typeof v !== 'string' || !v.startsWith('https://')) continue;
    if (k.includes('RECORD_MAIN')) return v;
    fallback ??= v;
  }
  return fallback;
}

function collectImages(cache: Record<string, unknown>, ...groups: Array<ReadonlyArray<{ __ref: string }> | null | undefined>): string[] {
  const out: string[] = [];
  for (const g of groups) {
    for (const r of g ?? []) {
      const u = imageUrl(cache, r.__ref);
      if (u && !out.includes(u)) out.push(u);
      if (out.length >= MAX_IMAGES) return out;
    }
  }
  return out;
}

/** "Kabátníkova, Brno - Ponava, Jihomoravský kraj" -> city Brno, district Ponava. */
function parseAddress(address: string | null | undefined): { city: string | null; district: string | null } {
  if (!address) return { city: null, district: null };
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  const withDash = parts.find((p) => p.includes(' - '));
  if (withDash) {
    const [city, ...rest] = withDash.split(' - ');
    return { city: city?.trim() || null, district: rest.join(' - ').trim() || null };
  }
  return { city: (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) ?? null, district: null };
}

function conditionValue(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.toUpperCase();
  if (v.includes('BEFORE_RECONSTRUCTION') || v.includes('BAD')) return 'spatny stav';
  if (v.includes('AFTER_RECONSTRUCTION')) return 'po rekonstrukci';
  if (v === 'NEW' || v.startsWith('NEW_') || v.includes('NEWBUILD')) return 'novostavba';
  if (v.includes('GOOD')) return 'dobry stav';
  return undefined;
}

function anyOf(...vals: Array<boolean | null | undefined>): boolean | null {
  if (vals.some((v) => v === true)) return true;
  if (vals.some((v) => v === false)) return false;
  return null;
}

function mapAdvert(
  advert: ListAdvert,
  detail: DetailAdvert | null,
  cache: Record<string, unknown>,
  detailCache: Record<string, unknown> | null,
): NormalizedListing {
  const offerType = advert.offerType === 'PRONAJEM' ? 'rent' : 'sale';
  const tags = (advert.tags ?? []).map(fold);
  const tagged = (re: RegExp): true | null => (tags.some((t) => re.test(t)) ? true : null);
  const title = (advert.imageAltText ?? '').replace(/[,\s]+$/, '') || `${offerType === 'rent' ? 'Pronájem' : 'Prodej'} bytu`;
  const layout = layoutOf(advert.disposition);
  const areaM2 = advert.surface != null && advert.surface > 0 ? advert.surface : null;
  const gps = detail?.gps ?? advert.gps ?? null;
  const images = detail
    ? collectImages(detailCache ?? cache, detail.mainImage ? [detail.mainImage] : null, detail.publicImages)
    : collectImages(cache, advert.mainImage ? [advert.mainImage] : null, advert.publicImages);
  const { city, district } = parseAddress(advert.address);
  const floor = detail?.etage ?? null;
  const priceCzk = advert.price != null && advert.price > 0 ? Math.round(advert.price) : null;
  const externalId = advert.id;

  return {
    portal: 'bezrealitky',
    externalId,
    url: `${BASE}/nemovitosti-byty-domy/${advert.uri}`,
    title,
    offerType,
    priceCzk,
    feesCzk: offerType === 'rent' && advert.charges != null && advert.charges >= 0 ? Math.round(advert.charges) : null,
    areaM2,
    layout,
    floor,
    condition: normalizeCondition(conditionValue(detail?.condition), `${title} ${detail?.description ?? ''}`),
    // Detail flags can contradict list tags (flag false, tag "Balkón 13,4 m²"); a positive signal wins.
    hasBalcony: anyOf(detail?.balcony, detail?.loggia, detail?.terrace, tagged(/balkon|lodzie|terasa/)),
    hasParking: anyOf(detail?.parking, detail?.garage, tagged(/parkov|garaz/)),
    hasElevator: anyOf(detail?.lift, tagged(/vytah/)),
    lat: gps?.lat ?? null,
    lng: gps?.lng ?? null,
    localityText: advert.address ?? null,
    city,
    district,
    images,
    raw: { list: advert, detail },
    fingerprint: fingerprint({ portal: 'bezrealitky', externalId, offerType, layout, areaM2, lat: gps?.lat, lng: gps?.lng }),
  };
}

async function getHtml(url: string, ctx: CrawlCtx): Promise<string> {
  const res = await ctx.fetch(url, {
    signal: ctx.signal,
    headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'cs-CZ,cs;q=0.9' },
  });
  if (!res.ok) throw new HttpError(`Bezrealitky: HTTP ${res.status} for ${url}`, res.status);
  return res.text();
}

async function loadDetail(
  advert: ListAdvert,
  ctx: CrawlCtx,
): Promise<{ detail: DetailAdvert; cache: Record<string, unknown> } | null> {
  const url = `${BASE}/nemovitosti-byty-domy/${advert.uri}`;
  try {
    const cache = readCache(await getHtml(url, ctx), `detail ${advert.id}`);
    const obj = cache[`Advert:${advert.id}`];
    if (!isObj(obj)) throw new BezrealitkyStructureError(`Advert:${advert.id} missing on detail page`);
    const description = pick(obj, 'descriptionByLocale') ?? pick(obj, 'description');
    const parsed = detailSchema.safeParse({
      condition: pick(obj, 'condition'),
      etage: pick(obj, 'etage'),
      description,
      balcony: pick(obj, 'balcony'),
      loggia: pick(obj, 'loggia'),
      terrace: pick(obj, 'terrace'),
      parking: pick(obj, 'parking'),
      garage: pick(obj, 'garage'),
      lift: pick(obj, 'lift'),
      gps: pick(obj, 'gps'),
      publicImages: pick(obj, 'publicImages'),
      mainImage: pick(obj, 'mainImage'),
    });
    if (!parsed.success) throw new BezrealitkyStructureError(z.prettifyError(parsed.error));
    return { detail: parsed.data, cache };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.log.warn('bezrealitky: detail unavailable, using list data only', { id: advert.id, error: String(err) });
    return null;
  }
}

function parseListAdvert(cache: Record<string, unknown>, ref: string): z.ZodSafeParseResult<ListAdvert> {
  const obj = cache[ref];
  if (!isObj(obj)) return listAdvertSchema.safeParse(undefined);
  return listAdvertSchema.safeParse({
    id: pick(obj, 'id'),
    uri: pick(obj, 'uri'),
    offerType: pick(obj, 'offerType'),
    disposition: pick(obj, 'disposition'),
    surface: pick(obj, 'surface'),
    price: pick(obj, 'price'),
    charges: pick(obj, 'charges'),
    gps: pick(obj, 'gps'),
    address: pick(obj, 'address'),
    imageAltText: pick(obj, 'imageAltText'),
    tags: pick(obj, 'tags'),
    mainImage: pick(obj, 'mainImage'),
    publicImages: pick(obj, 'publicImages'),
  });
}

export const bezrealitkyAdapter: PortalAdapter = {
  id: 'bezrealitky',
  async *fetch(q, ctx) {
    const seen = new Set<string>();
    for (let page = 1; page <= ctx.maxPages; page++) {
      ctx.signal?.throwIfAborted();
      const url = buildSearchUrl(q, page);
      ctx.countPage?.();
      const sp = parseSearchPage(await getHtml(url, ctx), url);
      ctx.log.debug('bezrealitky: page parsed', { page, total: sp.totalCount, items: sp.refs.length });

      if (page === 1 && sp.refs.length === 0 && sp.totalCount > 0) {
        throw new BezrealitkyStructureError(`search page has no adverts although totalCount=${sp.totalCount} (${url})`);
      }

      for (const ref of sp.refs) {
        const parsed = parseListAdvert(sp.cache, ref);
        if (!parsed.success) {
          ctx.log.warn('bezrealitky: skipping malformed advert', { ref, issues: z.prettifyError(parsed.error) });
          continue;
        }
        const advert = parsed.data;
        if (seen.has(advert.id)) continue;
        seen.add(advert.id);

        const priceCzk = advert.price != null && advert.price > 0 ? Math.round(advert.price) : null;
        const extra = (ctx.needsDetail ? await Promise.resolve(ctx.needsDetail(advert.id, priceCzk)) : true) ? await loadDetail(advert, ctx) : null;
        yield mapAdvert(advert, extra?.detail ?? null, sp.cache, extra?.cache ?? null);
      }

      if (sp.refs.length === 0 || page * sp.limit >= sp.totalCount) return;
    }
    ctx.markTruncated?.();
  },
};
