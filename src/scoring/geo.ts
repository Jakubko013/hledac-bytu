export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371.0088;

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export const CITY_CENTRES: Readonly<Record<string, LatLng>> = {
  Brno: { lat: 49.1951, lng: 16.6068 },
  Praha: { lat: 50.0875, lng: 14.4213 },
  Ostrava: { lat: 49.8347, lng: 18.282 },
  Plzeň: { lat: 49.7477, lng: 13.3776 },
  Olomouc: { lat: 49.5938, lng: 17.2509 },
  Liberec: { lat: 50.7671, lng: 15.0562 },
  'Hradec Králové': { lat: 50.2092, lng: 15.8328 },
  'České Budějovice': { lat: 48.9745, lng: 14.4743 },
};

const NORMALIZED_CENTRES = new Map<string, LatLng>(
  Object.entries(CITY_CENTRES).map(([name, c]) => [normalizeText(name), c]),
);

/** City centre preset by name (case/diacritics-insensitive), or null if unknown. */
export function cityCentre(city: string): LatLng | null {
  return NORMALIZED_CENTRES.get(normalizeText(city)) ?? null;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
