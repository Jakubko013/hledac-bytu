// View-model types. Field names mirror docs/DESIGN.md (snake_case) so DB wiring is a 1:1 mapping.

export type Portal = 'sreality' | 'bezrealitky' | 'idnes';
export type OfferType = 'rent' | 'sale';
export type Condition = 'new_build' | 'renovated' | 'good' | 'needs_renovation' | 'unknown';
export type ListingStatus = 'new' | 'seen' | 'favorite' | 'hidden';
export type StatusFilter = 'all' | 'new' | 'favorite' | 'hidden';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'never_run';
export type Runner = 'netlify' | 'github' | 'manual';

export const FACTORS = [
  'price_per_m2',
  'distance_to_centre',
  'condition',
  'area',
  'freshness',
  'extras',
  'price_drop',
] as const;
export type Factor = (typeof FACTORS)[number];

/** Per-factor value: weights 0-5, breakdown scores 0-1. */
export type FactorMap = Record<Factor, number>;

export interface Must {
  balcony: boolean;
  parking: boolean;
  elevator: boolean;
}

export interface Criteria {
  id: number;
  name: string;
  active: boolean;
  offer_type: OfferType;
  city: string;
  localities: string[];
  price_min: number | null;
  price_max: number | null;
  layouts: string[];
  area_min: number | null;
  area_max: number | null;
  must: Must;
  weights: FactorMap;
  anchor_lat: number | null;
  anchor_lng: number | null;
  max_distance_km: number | null;
  created_at: string;
  updated_at: string;
}

export interface ListingCard {
  id: number;
  criteria_id: number;
  title: string;
  portal: Portal;
  /** Other portals with the same fingerprint ("také na"). */
  also_on: Portal[];
  /** Same data with urls (other portals with the same fingerprint). */
  also_on_links: ListingSource[];
  /** Photo URLs in display order (up to 10); the first one is the card thumbnail. */
  images: string[];
  price_czk: number | null;
  fees_czk: number | null;
  area_m2: number | null;
  layout: string | null;
  condition: Condition;
  locality_text: string;
  /** Distance from the criteria anchor, km. */
  distance_km: number | null;
  score: number;
  breakdown: FactorMap;
  status: ListingStatus;
  is_new: boolean;
  /** Percent drop vs. previous price, or null. */
  price_drop_pct: number | null;
}

export interface FactorDetail {
  factor: Factor;
  score: number;
  weight: number;
  explanation: string;
}

export interface ListingSource {
  portal: Portal;
  url: string;
  price_czk: number;
}

export interface ListingDetail extends ListingCard {
  offer_type: OfferType;
  city: string;
  district: string | null;
  floor: number | null;
  has_balcony: boolean | null;
  has_parking: boolean | null;
  has_elevator: boolean | null;
  first_seen_at: string;
  last_seen_at: string;
  removed_at: string | null;
  price_history: { price_czk: number; observed_at: string }[];
  sources: ListingSource[];
  factor_details: FactorDetail[];
  note: string;
}

export interface RankedPage {
  items: ListingCard[];
  total: number;
  page: number;
  page_size: number;
  page_count: number;
}

export interface CrawlRun {
  id: number;
  portal: Portal;
  runner: Runner;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  pages: number;
  fetched: number;
  new_count: number;
  updated_count: number;
  error: string | null;
}
