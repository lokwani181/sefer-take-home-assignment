/** Date parsing + day-month ambiguity helpers (ISO strings throughout). */

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Countries whose documents conventionally write numeric dates month-first. */
export const MONTH_FIRST_COUNTRIES = new Set(['US', 'PR', 'PH', 'FM', 'MH', 'PW', 'GU', 'AS', 'VI', 'MP']);

export function toIso(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const isIsoDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Parse a date out of free text. Numeric d/m/y dates use `order` only when both readings are
 * possible; textual months ("24-SEP-2026", "Sep 24, 2026") and year-first dates are unambiguous.
 */
export function parseDateText(text: string | undefined, order: 'dmy' | 'mdy' = 'dmy'): string | undefined {
  if (!text) return undefined;
  const t = text.toUpperCase();
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  m = /\b(\d{1,2})[\s\-/.]*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\.?[\s\-/.,]*(\d{4}|\d{2})\b/.exec(t);
  if (m) return toIso(+m[3], MONTHS[m[2]], +m[1]);
  m = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t);
  if (m) return toIso(+m[3], MONTHS[m[1]], +m[2]);
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(t);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    if (a > 12) return toIso(y, b, a);
    if (b > 12) return toIso(y, a, b);
    return order === 'dmy' ? toIso(y, b, a) : toIso(y, a, b);
  }
  return undefined;
}

/** Both readings of an ambiguous numeric date like "12/09/2026"; undefined when only one is valid. */
export function numericDateReadings(raw: string | undefined): { dayFirst: string; monthFirst: string } | undefined {
  if (!raw) return undefined;
  const m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(raw);
  if (!m) return undefined;
  const dayFirst = toIso(+m[3], +m[2], +m[1]);
  const monthFirst = toIso(+m[3], +m[1], +m[2]);
  if (!dayFirst || !monthFirst || dayFirst === monthFirst) return undefined;
  return { dayFirst, monthFirst };
}
