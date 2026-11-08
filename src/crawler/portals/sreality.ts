import { z } from 'zod';
import { normalizeCondition } from '../condition';
import { fingerprint } from '../fingerprint';
import { filterHttpsUrls } from '../url';
import type { CrawlCtx, CrawlQuery, NormalizedListing, PortalAdapter } from '../types';

const BASE = 'https://www.sreality.cz';
const SEARCH_URL = `${BASE}/api/v1/estates/search`;
const DETAIL_URL = `${BASE}/api/v1/estates`;
const PAGE_SIZE = 60;
const MAX_IMAGES = 10;
const CATEGORY_FLAT = 1;
const OFFER_CODE = { sale: 1, rent: 2 } as const;
const OFFER_PATH = { sale: 'prodej', rent: 'pronajem' } as const;
const IMAGE_PARAMS = 'fl=res,749,562,3|shr,,20|jpg,90';

/** category_sub_cb codes (verified live). */
const LAYOUT_CODES: Record<string, number> = {
  '1+kk': 2,
  '1+1': 3,
  '2+kk': 4,
  '2+1': 5,
  '3+kk': 6,
  '3+1': 7,
  '4+kk': 8,
  '4+1': 9,
  '5+kk': 10,
  '5+1': 11,
  '6+': 12,
  atypicky: 16,
};

/** City preset -> Sreality okres (locality_district_id) + exact `locality.city` used to drop villages of the same okres. */
const CITIES: Record<string, { districtId: number; city: string }> = {
  brno: { districtId: 72, city: 'Brno' },
  praha: { districtId: 47, city: 'Praha' },
  ostrava: { districtId: 65, city: 'Ostrava' },
  plzen: { districtId: 12, city: 'Plzeň' },
  olomouc: { districtId: 42, city: 'Olomouc' },
  liberec: { districtId: 22, city: 'Liberec' },
  'hradec kralove': { districtId: 28, city: 'Hradec Králové' },
  'ceske budejovice': { districtId: 1, city: 'České Budějovice' },
};

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const cb = z.object({ name: z.string().nullish(), value: z.number() });

const localitySchema = z.object({
  city: z.string().nullish(),
  city_seo_name: z.string().nullish(),
  citypart: z.string().nullish(),
  citypart_seo_name: z.string().nullish(),
  street: z.string().nullish(),
  street_seo_name: z.string().nullish(),
  district: z.string().nullish(),
  quarter: z.string().nullish(),
  gps_lat: z.number().nullish(),
  gps_lon: z.number().nullish(),
});

const itemSchema = z.object({
  hash_id: z.number().int(),
  advert_name: z.string(),
  category_sub_cb: cb,
  price_czk: z.number().nullish(),
  advert_images: z.array(z.string()).nullish(),
  advert_images_all: z.array(z.object({ advert_image_sdn_url: z.string() })).nullish(),
  locality: localitySchema,
});
type Item = z.infer<typeof itemSchema>;

const pageSchema = z.object({
  pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number() }),
  results: z.array(z.unknown()),
});

const detailSchema = z.object({
  result: z.object({
    building_condition: cb.nullish(),
    elevator: cb.nullish(),
    balcony: z.boolean().nullish(),
    loggia: z.boolean().nullish(),
    terrace: z.boolean().nullish(),
    parking: z.number().nullish(),
    parking_lots: z.boolean().nullish(),
    garage: z.boolean().nullish(),
    floor_number: z.number().nullish(),
    usable_area: z.number().nullish(),
    cost_of_living: z.string().nullish(),
    price_note: z.string().nullish(),
    advert_description: z.string().nullish(),
  }),
});
type Detail = z.infer<typeof detailSchema>['result'];

export function resolveCity(city: string): { districtId: number; city: string } {
  const hit = CITIES[fold(city)];
  if (!hit) throw new Error(`Sreality: unsupported city "${city}" (supported: ${Object.values(CITIES).map((c) => c.city).join(', ')})`);
  return hit;
}

function layoutCode(layout: string): number | undefined {
  const l = fold(layout);
  if (/^[6-9]\+/.test(l)) return LAYOUT_CODES['6+'];
  if (l.startsWith('atyp')) return LAYOUT_CODES.atypicky;
  return LAYOUT_CODES[l];
}

export function buildSearchUrl(q: CrawlQuery, offset: number): string {
  const { districtId } = resolveCity(q.city);
  const p = new URLSearchParams({
    category_main_cb: String(CATEGORY_FLAT),
    category_type_cb: String(OFFER_CODE[q.offerType]),
    locality_district_id: String(districtId),
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  const codes = [...new Set((q.layouts ?? []).map(layoutCode).filter((c): c is number => c !== undefined))];
  if (codes.length) p.set('category_sub_cb', codes.join(','));
  if (q.priceMin != null) p.set('price_from', String(q.priceMin));
  if (q.priceMax != null) p.set('price_to', String(q.priceMax));
  if (q.areaMin != null) p.set('usable_area_from', String(q.areaMin));
  if (q.areaMax != null) p.set('usable_area_to', String(q.areaMax));
  return `${SEARCH_URL}?${p.toString()}`;
}

const clean = (s: string): string => s.replace(/[ \s]+/g, ' ').trim();

function parseLayout(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = clean(name).toLowerCase();
  if (/^\d\+(kk|\d)$/.test(n)) return n;
  if (/^[6-9] a v/.test(n)) return '6+';
  return null;
}

function parseArea(title: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*m²/.exec(title.replace(/[ \s]+/g, ' '));
  return m ? Number(m[1]!.replace(',', '.')) : null;
}

const AMOUNT = /(\d{1,3}(?:[\s .]\d{3})+|\d+)\s*(?:,-\s*)?(?:Kč|,-)/i;

/** Monthly fees (utilities/service advances) from free text; Sreality has no structured field. Rent only. */
export function parseFees(detail: Detail | null): number | null {
  if (!detail) return null;
  const sources = [detail.cost_of_living, detail.price_note].map((s) => (s ? clean(s) : ''));
  for (const [i, text] of sources.entries()) {
    if (!text) continue;
    if (i === 1 && !/z[aá]lohy|n[aá]klady|energi|slu[zž]b|poplat/i.test(text)) continue;
    const m = AMOUNT.exec(text);
    if (m) {
      const n = Number(m[1]!.replace(/[\s.]/g, ''));
      if (n > 0) return n;
    }
  }
  return null;
}

const slug = (s: string): string => fold(s).replace(/[^a-z0-9+]+/g, '-').replace(/^-|-$/g, '');

export function buildListingUrl(item: Item, offerType: CrawlQuery['offerType']): string {
  const l = item.locality;
  const layout = parseLayout(item.category_sub_cb.name) ?? slug(item.category_sub_cb.name ?? 'byt');
  const place = [l.city_seo_name, l.citypart_seo_name, l.street_seo_name].filter(Boolean).join('-') || 'x';
  return `${BASE}/detail/${OFFER_PATH[offerType]}/byt/${layout}/${place}/${item.hash_id}`;
}

function imageUrls(item: Item): string[] {
  const all = item.advert_images_all?.map((i) => i.advert_image_sdn_url) ?? [];
  const urls = all.length ? all : (item.advert_images ?? []);
  return filterHttpsUrls(
    urls.slice(0, MAX_IMAGES).map((u) => `${u.startsWith('//') ? `https:${u}` : u}?${IMAGE_PARAMS}`),
  );
}

export function mapItem(item: Item, offerType: CrawlQuery['offerType'], detail: Detail | null): NormalizedListing {
  const l = item.locality;
  const title = clean(item.advert_name);
  const layout = parseLayout(item.category_sub_cb.name);
  const areaM2 = detail?.usable_area && detail.usable_area > 0 ? detail.usable_area : parseArea(title);
  const lat = l.gps_lat ?? null;
  const lng = l.gps_lon ?? null;
  const externalId = String(item.hash_id);

  const elevator = detail?.elevator?.value;
  const hasAnyParking = detail ? Boolean(detail.parking_lots || detail.garage || (detail.parking ?? 0) > 0) : null;
  const { advert_images_all: _omit, ...rawItem } = item as Item & Record<string, unknown>;

  return {
    portal: 'sreality',
    externalId,
    url: buildListingUrl(item, offerType),
    title,
    offerType,
    priceCzk: item.price_czk && item.price_czk > 0 ? Math.round(item.price_czk) : null,
    feesCzk: offerType === 'rent' ? parseFees(detail) : null,
    areaM2,
    layout,
    floor: detail?.floor_number ?? null,
    condition: normalizeCondition(detail?.building_condition?.name ?? undefined, `${title} ${detail?.advert_description ?? ''}`),
    hasBalcony: detail ? Boolean(detail.balcony || detail.loggia || detail.terrace) : null,
    hasParking: hasAnyParking,
    hasElevator: elevator === 1 ? true : elevator === 2 ? false : null,
    lat,
    lng,
    localityText: [l.street, l.citypart, l.city].filter(Boolean).join(', ') || null,
    city: l.city ?? null,
    district: l.quarter ?? l.district ?? null,
    images: imageUrls(item),
    raw: { list: rawItem, detail },
    fingerprint: fingerprint({ portal: 'sreality', externalId, offerType, layout, areaM2, lat, lng }),
  };
}

async function getJson(url: string, ctx: CrawlCtx): Promise<{ status: number; body: unknown }> {
  const res = await ctx.fetch(url, { headers: { accept: 'application/json' }, signal: ctx.signal });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, body: null };
  }
  try {
    return { status: res.status, body: await res.json() };
  } catch (err) {
    throw new Error(`Sreality: invalid JSON from ${url}`, { cause: err });
  }
}

async function fetchDetail(id: string, ctx: CrawlCtx): Promise<Detail | null> {
  const url = `${DETAIL_URL}/${id}`;
  const { status, body } = await getJson(url, ctx);
  if (status !== 200) {
    ctx.log.warn('sreality: detail fetch failed', { id, status });
    return null;
  }
  const parsed = detailSchema.safeParse(body);
  if (!parsed.success) {
    ctx.log.warn('sreality: detail schema mismatch', { id, error: z.prettifyError(parsed.error) });
    return null;
  }
  return parsed.data.result;
}

async function* fetchListings(q: CrawlQuery, ctx: CrawlCtx): AsyncGenerator<NormalizedListing> {
  const { city } = resolveCity(q.city);
  const cityKey = fold(city);
  let offset = 0;

  for (let page = 0; page < ctx.maxPages; page++) {
    ctx.signal?.throwIfAborted();
    const url = buildSearchUrl(q, offset);
    ctx.countPage?.();
    const { status, body } = await getJson(url, ctx);
    if (status !== 200) throw new Error(`Sreality: search returned HTTP ${status} (${url})`);

    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Sreality: search response schema mismatch: ${z.prettifyError(parsed.error)}`);
    }
    const { pagination, results } = parsed.data;

    for (const raw of results) {
      ctx.signal?.throwIfAborted();
      const item = itemSchema.safeParse(raw);
      if (!item.success) {
        ctx.log.warn('sreality: skipping malformed item', { error: z.prettifyError(item.error) });
        continue;
      }
      if (item.data.locality.city && fold(item.data.locality.city) !== cityKey) continue;

      const id = String(item.data.hash_id);
      const price = item.data.price_czk && item.data.price_czk > 0 ? Math.round(item.data.price_czk) : null;
      const wantDetail = ctx.needsDetail ? ctx.needsDetail(id, price) : true;
      const detail = wantDetail ? await fetchDetail(id, ctx) : null;
      yield mapItem(item.data, q.offerType, detail);
    }

    offset += PAGE_SIZE;
    if (results.length === 0 || offset >= pagination.total) return;
  }
  // loop exhausted without reaching the end of the results
  ctx.markTruncated?.();
}

export const srealityAdapter: PortalAdapter = {
  id: 'sreality',
  fetch: (q, ctx) => fetchListings(q, ctx),
};
