import { describe, expect, it } from 'vitest';
import { normalizeCondition } from '../../src/crawler/condition';

describe('normalizeCondition', () => {
  it.each([
    ['Novostavba', 'new_build'],
    ['Ve výstavbě', 'new_build'],
    ['Projekt', 'new_build'],
    ['Po rekonstrukci', 'renovated'],
    ['Velmi dobrý', 'good'],
    ['Dobrý', 'good'],
    ['Před rekonstrukcí', 'needs_renovation'],
    ['PŘED REKONSTRUKCÍ', 'needs_renovation'],
    ['Neznámý', 'unknown'],
  ])('portal value %s -> %s', (v, c) => {
    expect(normalizeCondition(v)).toBe(c);
  });
  it('falls back to keywords, diacritics-insensitive', () => {
    expect(normalizeCondition(undefined, 'Pronájem bytu v novostavbě')).toBe('new_build');
    expect(normalizeCondition(undefined, 'byt po rekonstrukci')).toBe('renovated');
    expect(normalizeCondition('', 'Byt k rekonstrukci')).toBe('needs_renovation');
    expect(normalizeCondition(undefined, 'byt po rekonstrukci')).toBe('renovated');
  });
  it('portal value wins over text; unknown value falls through to text', () => {
    expect(normalizeCondition('Dobrý', 'novostavba')).toBe('good');
    expect(normalizeCondition('Neuvedeno', 'po rekonstrukci')).toBe('renovated');
  });
  it('returns unknown with no input', () => {
    expect(normalizeCondition()).toBe('unknown');
  });
});
