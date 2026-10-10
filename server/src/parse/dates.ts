/**
 * Date recognition for trade documents.
 *
 * Why: documents mix "24-SEP-2026", "20-Sep-2026", "12/09/2026", "2026-09-24",
 * "SEP 24, 2026" and stamp text such as "24 SEP 2026". Purely numeric day/month
 * dates are ambiguous; the caller chooses the primary reading from the issuer's
 * country convention and keeps the alternative so reconciliation can use chronology.
 */
import { stripDiacritics } from './text';

export interface ParsedDate {
  /** Best interpretation, ISO yyyy-mm-dd. */
  iso: string;
  raw: string;
  /** Character offset of the match in the searched text. */
  index: number;
  ambiguous: boolean;
  /** Other valid ISO interpretations (only for ambiguous numeric dates). */
  alternatives: string[];
  format: 'iso' | 'dmy-name' | 'mdy-name' | 'numeric' | 'compact';
}

export interface DateOptions {
  /** Prefer MM/DD for numeric dates (US convention). Default false (DD/MM). */
  monthFirst?: boolean;
}

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4, MAY: 5, JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11,
  NOVEMBER: 11, DEC: 12, DECEMBER: 12,
};
const MONTH_RE = '(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)';

/** Lookbehind: the digits are not the last segment of a code such as "MRH-260914-07" or "KBAS-12". */
const NOT_CODE_TAIL = '(?<![A-Z0-9]-)';

/** Countries that write numeric dates month-first. */
const MONTH_FIRST_COUNTRIES = new Set(['US', 'PH', 'FM', 'MH', 'PW', 'GU', 'PR', 'AS', 'MP', 'VI', 'UM']);

/** True when documents issued in this country use MM/DD numeric dates. */
export function isMonthFirstCountry(iso2: string | undefined): boolean {
  return !!iso2 && MONTH_FIRST_COUNTRIES.has(iso2.toUpperCase());
}

function fullYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  return n + (n >= 70 ? 1900 : 2000);
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** OCR in date context: "0CT" → "OCT", "SEP" fine, "2O26" → "2026". */
function ocrNormalize(s: string): string {
  return stripDiacritics(s)
    .toUpperCase()
    .replace(/\b0(?=CT)/g, 'O')
    .replace(/(?<=\d)[O](?=\d)/g, '0')
    .replace(/(?<=\d)[Il](?=\d)/g, '1');
}

/** Finds every date in the text, in order of appearance. */
export function findDates(text: string, opts: DateOptions = {}): ParsedDate[] {
  const s = ocrNormalize(text);
  const out: ParsedDate[] = [];
  const taken: Array<[number, number]> = [];
  const push = (m: RegExpExecArray, d: Omit<ParsedDate, 'raw' | 'index'>) => {
    const a = m.index;
    const b = m.index + m[0].length;
    if (taken.some(([x, y]) => a < y && b > x)) return;
    taken.push([a, b]);
    out.push({ ...d, raw: text.slice(a, b), index: a });
  };
  let m: RegExpExecArray | null;
  // ISO-like: 2026-09-24, 2026/09/24, 2026.09.24
  const isoRe = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = isoRe.exec(s))) {
    const v = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) push(m, { iso: v, ambiguous: false, alternatives: [], format: 'iso' });
  }
  // 24-SEP-2026, 24 SEP 2026, 24.Sep.26, 24th September 2026. The day is not the tail of a hyphenated
  // code ("MRH-260914-07 SEP. 14, 2026"), and a 2-digit "year" followed by a 4-digit year is the day of a
  // month-first date ("07 SEP. 14, 2026" is SEP. 14, 2026).
  const dmyName = new RegExp(`${NOT_CODE_TAIL}\\b(\\d{1,2})(?:ST|ND|RD|TH)?[\\s\\-./,]*${MONTH_RE}[\\s\\-./,']*(\\d{4}|\\d{2}(?![\\s,.]*\\d{4}\\b))\\b`, 'g');
  while ((m = dmyName.exec(s))) {
    const v = iso(fullYear(m[3]), MONTHS[m[2]], Number(m[1]));
    if (v) push(m, { iso: v, ambiguous: false, alternatives: [], format: 'dmy-name' });
  }
  // SEP 24, 2026 / September 24 2026
  const mdyName = new RegExp(`\\b${MONTH_RE}[\\s\\-./]*(\\d{1,2})(?:ST|ND|RD|TH)?[\\s,\\-./]+(\\d{4})\\b`, 'g');
  while ((m = mdyName.exec(s))) {
    const v = iso(Number(m[3]), MONTHS[m[1]], Number(m[2]));
    if (v) push(m, { iso: v, ambiguous: false, alternatives: [], format: 'mdy-name' });
  }
  // numeric: 12/09/2026, 12.09.26, 12-09-2026
  const numeric = new RegExp(`${NOT_CODE_TAIL}\\b(\\d{1,2})([-/.])(\\d{1,2})\\2(\\d{4}|\\d{2})\\b`, 'g');
  while ((m = numeric.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = fullYear(m[4]);
    const dmy = iso(y, b, a);
    const mdy = iso(y, a, b);
    if (!dmy && !mdy) continue;
    if (dmy && mdy && dmy !== mdy) {
      const primary = opts.monthFirst ? mdy : dmy;
      const alt = opts.monthFirst ? dmy : mdy;
      push(m, { iso: primary, ambiguous: true, alternatives: [alt], format: 'numeric' });
    } else {
      push(m, { iso: (dmy ?? mdy)!, ambiguous: false, alternatives: [], format: 'numeric' });
    }
  }
  // compact yyyymmdd
  const compact = /\b(20\d{2})(\d{2})(\d{2})\b/g;
  while ((m = compact.exec(s))) {
    const v = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) push(m, { iso: v, ambiguous: false, alternatives: [], format: 'compact' });
  }
  return out.sort((x, y) => x.index - y.index);
}

/** Parses the first date found in the text. */
export function parseDate(text: string, opts: DateOptions = {}): ParsedDate | null {
  return findDates(text, opts)[0] ?? null;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
