import { createHash } from 'node:crypto';
import type { OfferType, Portal } from './types';

export interface FingerprintInput {
  portal: Portal;
  externalId: string;
  offerType: OfferType;
  layout?: string | null;
  areaM2?: number | null;
  lat?: number | null;
  lng?: number | null;
}

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * hash(offer_type, layout, round(area), round(lat,3), round(lng,3)).
 * Without area or coordinates the listing cannot be matched reliably, so it falls back to
 * portal + external_id (unique per listing, never merges with others).
 */
export function fingerprint(l: FingerprintInput): string {
  const layout = l.layout?.trim().toLowerCase();
  const parts =
    isNum(l.areaM2) && isNum(l.lat) && isNum(l.lng) && layout
      ? ['geo', l.offerType, layout, Math.round(l.areaM2), l.lat.toFixed(3), l.lng.toFixed(3)]
      : ['id', l.portal, l.externalId];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}
