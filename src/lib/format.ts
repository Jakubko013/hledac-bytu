import type { Condition, Factor, OfferType, Portal, RunStatus } from './view-types';

const TZ = 'Europe/Prague';
const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });

export const formatNumber = (n: number) => nf.format(n);
export const formatCzk = (n: number) => `${nf.format(n)} Kč`;
export const formatKm = (n: number) => `${n.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} km`;

/** Price per m², or null when price or area is missing/zero. */
export function pricePerM2(price: number | null, area: number | null): number | null {
  return price && area && price > 0 && area > 0 ? Math.round(price / area) : null;
}
export const formatCzkOrDash = (n: number | null) => (n ? formatCzk(n) : '–');

export function formatDateTime(iso: string | null): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date(iso));
}
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeZone: TZ }).format(new Date(iso));
}

export const CONDITION_LABEL: Record<Condition, string> = {
  new_build: 'Novostavba', renovated: 'Po rekonstrukci', good: 'Dobrý stav',
  needs_renovation: 'K rekonstrukci', unknown: 'Stav neuveden',
};
export const PORTAL_LABEL: Record<Portal, string> = {
  sreality: 'Sreality', bezrealitky: 'Bezrealitky', idnes: 'iDNES Reality',
};
export const OFFER_LABEL: Record<OfferType, string> = { rent: 'Pronájem', sale: 'Prodej' };
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Běží', ok: 'V pořádku', partial: 'Částečně', failed: 'Selhalo', never_run: 'Zatím nespuštěno',
};
export const FACTOR_LABEL: Record<Factor, string> = {
  price_per_m2: 'Cena/m²', distance_to_centre: 'Vzdálenost od centra', condition: 'Stav',
  area: 'Velikost', freshness: 'Čerstvost', extras: 'Vybavení', price_drop: 'Zlevnění',
};
export const FACTOR_SHORT: Record<Factor, string> = {
  price_per_m2: 'Cena/m²', distance_to_centre: 'Centrum', condition: 'Stav',
  area: 'Velikost', freshness: 'Čerstvost', extras: 'Vybavení', price_drop: 'Zlevnění',
};
export const CITIES = ['Brno', 'Praha', 'Ostrava', 'Plzeň', 'Olomouc', 'Liberec', 'Hradec Králové', 'České Budějovice'];
export const LAYOUTS = ['1+kk', '1+1', '2+kk', '2+1', '3+kk', '3+1', '4+kk', '4+1', '5+kk', '5+1', '6+'];

/** Only same-origin relative paths; protects against open redirects in hidden `next`. */
export function safeNext(v: string | null | undefined): string {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

export function scoreTone(score: number): 'high' | 'mid' | 'low' {
  return score >= 70 ? 'high' : score >= 50 ? 'mid' : 'low';
}
