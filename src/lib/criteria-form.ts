import { z } from 'zod';
import { cityCentre } from '../scoring/geo';
import { DEFAULT_WEIGHTS } from '../scoring/score';
import { LAYOUTS } from './format';
import { FACTORS, type Factor, type FactorMap } from './view-types';
import { factorMapToWeights } from './view-logic';

export const DEFAULT_MAX_DISTANCE_KM = 10;
export const MAX_LOCALITIES = 20;

const MAX_VALUE = 1_000_000_000;
const DEFAULT_FACTORS: FactorMap = {
  price_per_m2: DEFAULT_WEIGHTS.price_per_m2,
  distance_to_centre: DEFAULT_WEIGHTS.distance,
  condition: DEFAULT_WEIGHTS.condition,
  area: DEFAULT_WEIGHTS.area,
  freshness: DEFAULT_WEIGHTS.freshness,
  extras: DEFAULT_WEIGHTS.extras,
  price_drop: DEFAULT_WEIGHTS.price_drop,
};

/** Empty string / missing -> null, otherwise a number (NaN when unparsable so zod rejects it). */
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  return s === '' ? null : Number(s);
};

const nonNeg = (label: string) =>
  z
    .number({ error: `${label}: neplatné číslo.` })
    .min(0, `${label}: nesmí být záporné.`)
    .max(MAX_VALUE, `${label}: hodnota je příliš velká.`)
    .nullable();

const weight = (label: string) =>
  z
    .number({ error: `Váha „${label}“: neplatné číslo.` })
    .min(0, `Váha „${label}“ musí být 0–5.`)
    .max(5, `Váha „${label}“ musí být 0–5.`)
    .refine((n) => Number.isInteger(n * 2), `Váha „${label}“ musí být po 0,5.`);

const WEIGHT_LABELS: Record<Factor, string> = {
  price_per_m2: 'cena/m²', distance_to_centre: 'vzdálenost', condition: 'stav', area: 'velikost',
  freshness: 'čerstvost', extras: 'vybavení', price_drop: 'zlevnění',
};

const schema = z
  .object({
    id: z.number().int().positive().nullable(),
    name: z.string().trim().min(1, 'Zadejte název hledání.').max(100, 'Název může mít nejvýše 100 znaků.'),
    offer_type: z.enum(['rent', 'sale'], { error: 'Neplatný typ nabídky.' }),
    city: z.string().trim().min(1, 'Zadejte město.').max(60, 'Město může mít nejvýše 60 znaků.'),
    localities: z
      .array(z.string().max(60, 'Lokalita může mít nejvýše 60 znaků.'))
      .max(MAX_LOCALITIES, `Nejvýše ${MAX_LOCALITIES} lokalit.`),
    price_min: nonNeg('Cena od'),
    price_max: nonNeg('Cena do'),
    layouts: z.array(z.enum(LAYOUTS as [string, ...string[]], { error: 'Neplatná dispozice.' })),
    area_min: nonNeg('Plocha od'),
    area_max: nonNeg('Plocha do'),
    must: z.object({ balcony: z.boolean(), parking: z.boolean(), elevator: z.boolean() }),
    max_distance_km: nonNeg('Maximální vzdálenost'),
    active: z.boolean(),
    weights: z.object(
      Object.fromEntries(FACTORS.map((f) => [f, weight(WEIGHT_LABELS[f])])) as Record<Factor, ReturnType<typeof weight>>,
    ),
  })
  .superRefine((d, ctx) => {
    if (d.price_min != null && d.price_max != null && d.price_min > d.price_max) {
      ctx.addIssue({ code: 'custom', message: 'Cena od nesmí být vyšší než cena do.' });
    }
    if (d.area_min != null && d.area_max != null && d.area_min > d.area_max) {
      ctx.addIssue({ code: 'custom', message: 'Plocha od nesmí být větší než plocha do.' });
    }
  });

export interface CriteriaValues {
  name: string;
  active: boolean;
  offerType: 'rent' | 'sale';
  city: string;
  localities: string[];
  priceMin: number | null;
  priceMax: number | null;
  layouts: string[];
  areaMin: number | null;
  areaMax: number | null;
  must: { balcony: boolean; parking: boolean; elevator: boolean };
  weights: ReturnType<typeof factorMapToWeights>;
  anchorLat: number | null;
  anchorLng: number | null;
  maxDistanceKm: number;
}

export type CriteriaParse =
  | { ok: true; id: number | null; values: CriteriaValues }
  | { ok: false; error: string; id: number | null };

type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };

export function parseLocalities(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Valid positive integer id from a form value, else null. */
export function parseId(v: FormDataEntryValue | null): number | null {
  const s = v == null ? '' : String(v).trim();
  return /^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null;
}

export function parseCriteriaForm(form: FormLike): CriteriaParse {
  const rawId = String(form.get('id') ?? '').trim();
  const id = parseId(form.get('id'));
  if (rawId !== '' && id == null) return { ok: false, error: 'Neplatné ID hledání.', id: null };

  const checked = (name: string) => form.get(name) === '1';
  const weights = {} as Record<Factor, number>;
  for (const f of FACTORS) {
    const raw = form.get(`weight_${f}`);
    weights[f] = raw == null || String(raw).trim() === '' ? DEFAULT_FACTORS[f] : Number(String(raw).replace(',', '.'));
  }

  const parsed = schema.safeParse({
    id,
    name: String(form.get('name') ?? ''),
    offer_type: String(form.get('offer_type') ?? ''),
    city: String(form.get('city') ?? ''),
    localities: parseLocalities(String(form.get('localities') ?? '')),
    price_min: numOrNull(form.get('price_min')),
    price_max: numOrNull(form.get('price_max')),
    layouts: [...new Set(form.getAll('layouts').map(String))],
    area_min: numOrNull(form.get('area_min')),
    area_max: numOrNull(form.get('area_max')),
    must: { balcony: checked('must_balcony'), parking: checked('must_parking'), elevator: checked('must_elevator') },
    max_distance_km: numOrNull(form.get('max_distance_km')),
    active: checked('active'),
    weights,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Neplatný formulář.', id };
  }
  const d = parsed.data;
  const centre = cityCentre(d.city);
  return {
    ok: true,
    id: d.id,
    values: {
      name: d.name,
      active: d.active,
      offerType: d.offer_type,
      city: d.city,
      localities: d.localities,
      priceMin: d.price_min,
      priceMax: d.price_max,
      layouts: d.layouts,
      areaMin: d.area_min,
      areaMax: d.area_max,
      must: d.must,
      weights: factorMapToWeights(d.weights),
      anchorLat: centre?.lat ?? null,
      anchorLng: centre?.lng ?? null,
      maxDistanceKm: d.max_distance_km ?? DEFAULT_MAX_DISTANCE_KM,
    },
  };
}

export function criteriaErrorLocation(id: number | null, message: string): string {
  return `/criteria/${id ?? 'new'}?error=${encodeURIComponent(message)}`;
}

export type ToggleParse = { ok: true; id: number; active: boolean } | { ok: false };

export function parseToggleForm(form: FormLike): ToggleParse {
  const id = parseId(form.get('id'));
  const active = String(form.get('active') ?? '');
  if (id == null || (active !== 'true' && active !== 'false')) return { ok: false };
  return { ok: true, id, active: active === 'true' };
}
