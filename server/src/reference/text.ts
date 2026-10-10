/** Small text helpers shared by the reference lookups (no domain data here). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Read a committed JSON file from server/src/reference/data (sync: lookups are synchronous by contract). */
export function readDataJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(here, 'data', file), 'utf8')) as T;
}

/** Remove accents so "Đà Nẵng" / "Bình Dương" compare equal to their ASCII spellings. */
export function stripDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[Đđ]/g, (c) => (c === 'Đ' ? 'D' : 'd'));
}

/** Uppercase, ASCII, punctuation → single spaces. Keeps letters, digits and spaces only. */
export function normalizeKey(s: string): string {
  return stripDiacritics(s)
    .toUpperCase()
    .replace(/[’'`]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** True when `needle` (normalized) occurs in `hay` (normalized) on word boundaries. */
export function containsWords(hay: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${hay} `.includes(` ${needle} `);
}

/** Index of a whole-word occurrence of `needle` in `hay` (both normalized), or -1. */
export function indexOfWords(hay: string, needle: string): number {
  if (!needle) return -1;
  const i = ` ${hay} `.indexOf(` ${needle} `);
  return i < 0 ? -1 : i;
}
