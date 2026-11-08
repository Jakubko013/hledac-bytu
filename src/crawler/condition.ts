import type { Condition } from './types';

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Order matters: negative / more specific patterns first.
const RULES: ReadonlyArray<readonly [RegExp, Condition]> = [
  [/pred (celkovou )?rekonstrukci|k (celkove )?rekonstrukci|vyzaduje rekonstrukci|k modernizaci|spatny/, 'needs_renovation'],
  [/novostavb|ve vystavbe|^projekt$|developersk/, 'new_build'],
  [/po (uplne |celkove |castecne )?(rekonstrukci|modernizaci)|(z)?rekonstruovan/, 'renovated'],
  [/^(velmi )?dobry|udrzovan/, 'good'],
];

/**
 * Maps a portal-provided condition value (preferred) or free text (title/description keywords)
 * to a normalized Condition. Diacritics-insensitive.
 */
export function normalizeCondition(portalValue?: string, text?: string): Condition {
  for (const source of [portalValue, text]) {
    if (!source) continue;
    const s = fold(source);
    for (const [re, cond] of RULES) {
      if (re.test(s)) return cond;
    }
  }
  return 'unknown';
}
