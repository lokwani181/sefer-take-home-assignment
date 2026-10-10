/**
 * Small string helpers shared by every parser. Kept dependency-free so that
 * the primitives can be unit-tested in isolation.
 */

/** Removes diacritics ("Đóng" → "Dong") so that keyword matching works on Vietnamese/European text. */
export function stripDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0111\u0110]/g, (c) => (c === 'đ' ? 'd' : 'D'));
}

/** Normalizes typographic quotes/dashes that OCR and PDF text layers emit inconsistently. */
export function normalizePunct(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201b\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u00a0/g, ' ');
}

/** Collapses runs of whitespace and trims. */
export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Compact matching key: upper-case ASCII letters/digits only (plus '#').
 * "Invoice No.:" → "INVOICENO", "N.W./Ctn (kg)" → "NWCTNKG".
 */
export function compactKey(s: string): string {
  return stripDiacritics(normalizePunct(s)).toUpperCase().replace(/[^A-Z0-9#]/g, '');
}

/** Word-preserving key: upper-case, punctuation → space, collapsed. "U.S.A." → "U S A". */
export function spacedKey(s: string): string {
  return squash(stripDiacritics(normalizePunct(s)).toUpperCase().replace(/[^A-Z0-9#]+/g, ' '));
}

/** Classic Levenshtein distance (small strings only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity on normalized text (1 = identical ignoring case, spacing and punctuation style). */
export function similarity(a: string, b: string): number {
  const x = squash(stripDiacritics(normalizePunct(a)).toUpperCase());
  const y = squash(stripDiacritics(normalizePunct(b)).toUpperCase());
  if (!x.length && !y.length) return 1;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
}

/** Escapes a literal for use inside a RegExp. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips trailing separators that OCR/layout leaves on values ("LLC," → "LLC"). */
export function trimSeparators(s: string): string {
  return s.replace(/^[\s,;:|_~-]+/, '').replace(/[\s,;:|_~]+$/, '').trim();
}

/** True when the string contains at least one digit. */
export const hasDigit = (s: string): boolean => /\d/.test(s);

/** Share of characters that are printable ASCII letters/digits/punctuation (1 = all ASCII). */
export function asciiRatio(s: string): number {
  if (!s.length) return 1;
  let n = 0;
  for (const ch of s) if (ch.charCodeAt(0) < 128) n++;
  return n / [...s].length;
}

/** Splits prose into sentences without breaking on common abbreviations (P.O., No., Ltd., Co.). */
export function splitSentences(text: string): string[] {
  const abbrev = /(?:\b(?:P\.O|No|Ltd|Co|Inc|Corp|St|Rd|Ave|Bldg|Ind|Ref|approx|Dept|Mr|Ms|Mrs|Dr|U\.S|e\.g|i\.e|vs|Nos|Pcs|Ctns|Inv)|\b[A-Z])\.$/i;
  const out: string[] = [];
  let start = 0;
  const re = /[.!?](?=\s+[A-Z(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const candidate = text.slice(start, m.index + 1);
    if (abbrev.test(candidate)) continue;
    out.push(candidate.trim());
    start = m.index + 1;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}
