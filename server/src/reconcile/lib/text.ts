/** Text normalization used for cross-document matching (styles, descriptions, party names). */

/** Uppercase alphanumerics only: "ab-123 " → "AB123". Used for style / invoice-number matching. */
export function normKey(s: string | undefined | null): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const OCR_TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };

/**
 * normKey with common OCR letter/digit confusions folded to digits, so "AB-1O5" and "AB-105"
 * compare equal. Only used as a second matching pass after exact keys.
 */
export function ocrKey(s: string | undefined | null): string {
  return normKey(s).replace(/[OQDILZSBG]/g, (c) => OCR_TO_DIGIT[c] ?? c);
}

const PHRASES: [RegExp, string][] = [
  [/\bT[\s-]?SHIRTS?\b/g, ' TSHIRT '],
  [/\bTEES?\b/g, ' TSHIRT '],
  [/\bS\s*\/\s*S\b/g, ' SHORT SLEEVE '],
  [/\bL\s*\/\s*S\b/g, ' LONG SLEEVE '],
  [/\bW\s*\//g, ' WITH '],
];

const SYNONYMS: Record<string, string> = {
  LADIES: 'WOMEN',
  LADY: 'WOMEN',
  WOMENS: 'WOMEN',
  WOMAN: 'WOMEN',
  WOMEN: 'WOMEN',
  MENS: 'MEN',
  GENTS: 'MEN',
  PANT: 'TROUSER',
  PANTS: 'TROUSER',
  TROUSERS: 'TROUSER',
  SLACKS: 'TROUSER',
  HOODY: 'HOODIE',
  HOODIES: 'HOODIE',
  JUMPER: 'SWEATER',
  PULLOVERS: 'PULLOVER',
  BOYS: 'BOY',
  GIRLS: 'GIRL',
  KIDS: 'CHILD',
  CHILDRENS: 'CHILD',
  CHILDREN: 'CHILD',
};

const STOP = new Set(['WITH', 'AND', 'OF', 'THE', 'FOR', 'IN', 'AN', 'TO', 'PCS', 'PC', 'PER']);

/** Description tokens with apparel synonyms folded (LADIES→WOMEN, TEE→TSHIRT, PANT→TROUSER, S/S→SHORT SLEEVE). */
export function descTokens(s: string | undefined): Set<string> {
  let t = (s ?? '').toUpperCase().replace(/[’'`]/g, '');
  for (const [re, rep] of PHRASES) t = t.replace(re, rep);
  const out = new Set<string>();
  for (let w of t.split(/[^A-Z0-9]+/)) {
    if (!w || w.length < 2 || STOP.has(w)) continue;
    w = SYNONYMS[w] ?? w;
    if (w.length > 4 && w.endsWith('S') && !w.endsWith('SS')) w = w.slice(0, -1);
    out.add(SYNONYMS[w] ?? w);
  }
  return out;
}

/** Dice coefficient of two token sets (0..1). */
export function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

const LEGAL_FORMS = new Set([
  'LTD', 'LIMITED', 'CO', 'COMPANY', 'INC', 'INCORPORATED', 'LLC', 'LLP', 'LP', 'CORP', 'CORPORATION', 'JSC',
  'JOINT', 'STOCK', 'PLC', 'GMBH', 'AG', 'SA', 'SAS', 'SARL', 'SRL', 'SPA', 'BV', 'NV', 'PTE', 'PVT', 'PRIVATE',
  'PTY', 'KK', 'OY', 'AB', 'SDN', 'BHD', 'TBK', 'THE', 'AND', 'OF',
]);

/** Distinctive name tokens of a company, legal-form words removed ("Acme Garment JSC" → ACME GARMENT). */
export function companyTokens(name: string | undefined): Set<string> {
  const t = (name ?? '').toUpperCase().replace(/[’'`.]/g, '').replace(/&/g, ' AND ');
  const out = new Set<string>();
  for (const w of t.split(/[^A-Z0-9]+/)) if (w && !LEGAL_FORMS.has(w)) out.add(w);
  return out;
}

/**
 * Whether two party names designate the same company, tolerant of legal-form spelling
 * ("JSC" vs "Joint Stock Company", "Ltd." vs "Limited") and abbreviations ("St." vs "Street" don't matter here).
 */
export function sameCompany(a: string | undefined, b: string | undefined): boolean {
  const A = companyTokens(a);
  const B = companyTokens(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  if (small.size >= 2 && inter === small.size) return true;
  return (2 * inter) / (A.size + B.size) >= 0.75;
}

/** Collapse whitespace and trim, for evidence snippets. */
export function clean(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Shorten long verbatim text for evidence. */
export function truncate(s: string, n = 220): string {
  const c = clean(s);
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
}

