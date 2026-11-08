import type { Condition, OfferType, Portal } from '../../db/schema';

export type { Condition, OfferType, Portal };

/** Portal-agnostic listing; maps onto `listing` minus DB-managed fields (id, first/last seen, removed). */
export interface NormalizedListing {
  portal: Portal;
  externalId: string;
  url: string;
  title: string;
  offerType: OfferType;
  priceCzk: number | null;
  feesCzk: number | null;
  areaM2: number | null;
  layout: string | null;
  floor: number | null;
  condition: Condition;
  hasBalcony: boolean | null;
  hasParking: boolean | null;
  hasElevator: boolean | null;
  lat: number | null;
  lng: number | null;
  localityText: string | null;
  city: string | null;
  district: string | null;
  images: string[];
  raw: unknown;
  fingerprint: string;
}

/** Derived from the union of active criteria. */
export interface CrawlQuery {
  offerType: OfferType;
  city: string;
  layouts?: string[];
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface CrawlCtx {
  fetch: FetchFn;
  log: Logger;
  signal?: AbortSignal;
  maxPages: number;
  /**
   * Optional: true when the listing is unknown or its price changed, i.e. the (expensive) detail
   * page should be fetched. Adapters may skip detail fetches when this returns false.
   */
  /** Adapters call this once per list-page (search) request; detail fetches are not counted. */
  countPage?(): void;
  /** Adapters call this when they stopped at `maxPages` while more results existed. */
  markTruncated?(): void;
  needsDetail?(externalId: string, priceCzk: number | null): boolean;
}

export interface PortalAdapter {
  id: Portal;
  fetch(q: CrawlQuery, ctx: CrawlCtx): AsyncIterable<NormalizedListing>;
}
