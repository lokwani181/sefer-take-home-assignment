/**
 * Small code-like domain extractors: HS codes, Incoterms, currencies, weights/volumes,
 * SCAC + bill numbers. Each is a pure function over text so it can be unit-tested and
 * reused by every document parser.
 */

// ── HS codes ────────────────────────────────────────────────────────────────

/** Highest 4-digit heading per HS chapter (HS 2022). Used to flag impossible OCR readings. */
const MAX_HEADING: Record<number, number> = {
  1: 6, 2: 10, 3: 9, 4: 10, 5: 11, 6: 4, 7: 14, 8: 14, 9: 10, 10: 8, 11: 9, 12: 14, 13: 2, 14: 4, 15: 22, 16: 5,
  17: 4, 18: 6, 19: 5, 20: 9, 21: 6, 22: 9, 23: 9, 24: 4, 25: 30, 26: 21, 27: 16, 28: 53, 29: 42, 30: 6, 31: 5,
  32: 15, 33: 7, 34: 7, 35: 7, 36: 6, 37: 7, 38: 27, 39: 26, 40: 17, 41: 15, 42: 6, 43: 4, 44: 21, 45: 4, 46: 2,
  47: 7, 48: 23, 49: 11, 50: 7, 51: 13, 52: 12, 53: 11, 54: 8, 55: 16, 56: 9, 57: 5, 58: 11, 59: 11, 60: 6, 61: 17,
  62: 17, 63: 10, 64: 6, 65: 7, 66: 3, 67: 4, 68: 15, 69: 14, 70: 20, 71: 18, 72: 29, 73: 26, 74: 19, 75: 8, 76: 16,
  78: 6, 79: 7, 80: 7, 81: 13, 82: 15, 83: 11, 84: 87, 85: 49, 86: 9, 87: 16, 88: 7, 89: 8, 90: 33, 91: 14, 92: 9,
  93: 7, 94: 6, 95: 8, 96: 20, 97: 6, 98: 17, 99: 4,
};

/** True when the 4-digit heading of an HS/HTS code can exist (chapter known, heading within range). */
export function hsHeadingExists(code: string): boolean {
  const d = code.replace(/\D/g, '');
  if (d.length < 4) return false;
  const ch = Number(d.slice(0, 2));
  const h = Number(d.slice(2, 4));
  const max = MAX_HEADING[ch];
  return max !== undefined && h >= 1 && h <= max;
}

/** HS/HTS codes written with dots ("6109.10", "6110.30.30.53", "6109.10.0012"). */
export function findHsCodes(text: string): Array<{ code: string; index: number }> {
  const out: Array<{ code: string; index: number }> = [];
  for (const m of text.matchAll(/\b\d{4}\.\d{2}(?:\.\d{2,4}(?:\.\d{2})?)?\b/g)) out.push({ code: m[0], index: m.index ?? 0 });
  return out;
}

/** Parses an HS cell that may be dotted or plain digits (6, 8 or 10 digits). */
export function parseHsCell(text: string): string | undefined {
  const t = text.trim();
  const dotted = findHsCodes(t)[0];
  if (dotted) return dotted.code;
  const plain = /^(\d{6}|\d{8}|\d{10})$/.exec(t.replace(/[\s.]/g, ''));
  if (plain && /^\d[\d.\s]*$/.test(t)) {
    const d = plain[1];
    return d.length === 6 ? `${d.slice(0, 4)}.${d.slice(4)}` : d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8)}`;
  }
  return undefined;
}

// ── Incoterms ──────────────────────────────────────────────────────────────

export interface IncotermParse {
  code: string;
  place?: string;
  version?: string;
}

const INCOTERM_RE = /\b(EXW|EX[\s-]?WORKS|F\.?C\.?A\.?|F\.?A\.?S\.?|F\.?O\.?B\.?|C\.?F\.?R\.?|C\s*&\s*F|CNF|C\s*AND\s*F|C\.?I\.?F\.?|C\.?P\.?T\.?|C\.?I\.?P\.?|D\.?A\.?P\.?|DPU|D\.?D\.?P\.?|DAT|DDU|DES|DEQ|DAF|FREE\s+ON\s+BOARD|FREE\s+CARRIER|DELIVERED\s+DUTY\s+PAID|COST\s*,?\s*INSURANCE\s+(?:AND|&)\s+FREIGHT|COST\s+(?:AND|&)\s+FREIGHT)(?=[\s,.(:/]|$)/i;

const SPELLED: Array<[RegExp, string]> = [
  [/^EX[\s-]?WORKS$/i, 'EXW'],
  [/^FREE\s+ON\s+BOARD$/i, 'FOB'],
  [/^FREE\s+CARRIER$/i, 'FCA'],
  [/^DELIVERED\s+DUTY\s+PAID$/i, 'DDP'],
  [/^COST\s*,?\s*INSURANCE/i, 'CIF'],
  [/^COST\s+(?:AND|&)\s+FREIGHT$/i, 'CFR'],
  [/^(?:C\s*&\s*F|CNF|C\s*AND\s*F)$/i, 'CFR'],
];
const CODES = new Set(['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'DAT', 'DDU', 'DES', 'DEQ', 'DAF']);

/** Normalizes an Incoterm mention ("F.O.B.", "C&F", "Free on Board") to its 3-letter code. */
export function normalizeIncotermCode(raw: string): string | undefined {
  for (const [re, code] of SPELLED) if (re.test(raw.trim())) return code;
  const c = raw.toUpperCase().replace(/[.\s]/g, '');
  return CODES.has(c) ? c : undefined;
}

/** Parses "CIF TACOMA, WA (INCOTERMS 2020)" → { code: CIF, place: "TACOMA, WA", version: "2020" }. */
export function parseIncoterm(text: string): IncotermParse | null {
  const m = INCOTERM_RE.exec(text);
  if (!m) return null;
  const code = normalizeIncotermCode(m[1]);
  if (!code) return null;
  const rest = text.slice(m.index + m[0].length);
  const version = /INCOTERMS?\s*[®]?\s*(\d{4})/i.exec(text)?.[1] ?? /\b(2000|2010|2020)\b/.exec(rest)?.[1];
  const place = rest
    .split(/\(?\s*\bINCOTERMS?\b|\s+\/\s+|;|\bVALUE\b|\bPRICE\b|\bTOTAL\b/i)[0]
    .replace(/\(\s*[A-Z]{3,5}\s*\)/g, ' ')
    .replace(/\b(?:2000|2010|2020)\b/, '')
    .replace(/[()®]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:-]+|[\s,:.-]+$/g, '')
    .trim();
  return { code, place: place && /[A-Za-z]{2,}/.test(place) ? place : undefined, version };
}

// ── Currency ───────────────────────────────────────────────────────────────

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/\bHONG\s*KONG\s+DOLLARS?\b|\bHK\$|\bHKD\b/i, 'HKD'],
  [/\bSINGAPORE\s+DOLLARS?\b|\bS\$|\bSGD\b/i, 'SGD'],
  [/\bCANADIAN\s+DOLLARS?\b|\bC\$|\bCAD\b/i, 'CAD'],
  [/\bAUSTRALIAN\s+DOLLARS?\b|\bA\$|\bAUD\b/i, 'AUD'],
  [/\bNEW\s+TAIWAN\s+DOLLARS?\b|\bNT\$|\bTWD\b/i, 'TWD'],
  [/\bU\.?\s?S\.?\s+DOLLARS?\b|\bUS\$|\bUSD\b|\bU\.S\.D\.?/i, 'USD'],
  [/\bEUROS?\b|€|\bEUR\b/i, 'EUR'],
  [/\bPOUNDS?\s+STERLING\b|£|\bGBP\b/i, 'GBP'],
  [/\bRENMINBI\b|\bYUAN\b|\bRMB\b|\bCNY\b/i, 'CNY'],
  [/\bJAPANESE\s+YEN\b|\bJPY\b/i, 'JPY'],
  [/\bINDIAN\s+RUPEES?\b|\bINR\b|₹/i, 'INR'],
  [/\bVIETNAM(?:ESE)?\s+DONG\b|\bVND\b/i, 'VND'],
  [/\bSWISS\s+FRANCS?\b|\bCHF\b/i, 'CHF'],
  [/\bKOREAN\s+WON\b|\bKRW\b/i, 'KRW'],
  [/\bTHAI\s+BAHT\b|\bTHB\b/i, 'THB'],
  [/\bMEXICAN\s+PESOS?\b|\bMXN\b/i, 'MXN'],
  [/\b(?:BDT|TAKA)\b/i, 'BDT'],
  [/\b(?:PKR)\b/i, 'PKR'],
  [/\b(?:IDR|RUPIAH)\b/i, 'IDR'],
  [/\b(?:MYR|RINGGIT)\b/i, 'MYR'],
  [/\b(?:TRY|TURKISH\s+LIRA)\b/i, 'TRY'],
];

/** ISO 4217 code from a currency mention ("US DOLLARS", "EURO", "USD", "€"). */
export function parseCurrency(text: string): string | undefined {
  let best: { code: string; index: number } | undefined;
  for (const [re, code] of CURRENCY_WORDS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { code, index: m.index };
  }
  return best?.code;
}

// ── Weights / volumes ──────────────────────────────────────────────────────

const LB_TO_KG = 0.45359237;
const CFT_TO_CBM = 0.0283168466;

/** Unit-aware weight: "1,930.000 KGS" → 1930, "4,255 LBS" → 1930.04. Returns kg. */
export function weightToKg(value: number, unitText: string | undefined): number {
  if (unitText && /\b(?:LBS?|POUNDS?)\b/i.test(unitText)) return Math.round(value * LB_TO_KG * 1000) / 1000;
  return value;
}

/** Unit-aware volume: CBM/M3 as is, CFT converted. Returns cubic metres. */
export function volumeToCbm(value: number, unitText: string | undefined): number {
  if (unitText && /\b(?:CFT|CU\.?\s*FT|CUBIC\s+FEET)\b/i.test(unitText)) return Math.round(value * CFT_TO_CBM * 1000) / 1000;
  return value;
}

// ── SCAC / bills ───────────────────────────────────────────────────────────

/** 4-letter SCAC in parentheses or after a "SCAC" label. */
export function findScac(text: string): string | undefined {
  const lab = /\bSCAC\s*(?:CODE)?\s*[:#]?\s*([A-Z]{4})\b/.exec(text);
  if (lab) return lab[1].toUpperCase();
  const par = /\(([A-Z]{4})\)/.exec(text);
  return par ? par[1] : undefined;
}

/** Cleans a bill/booking number value: drops spaces around joiners ("BMLHCM2609 -0377" → "BMLHCM2609-0377"). */
export function cleanCode(text: string): string {
  return text
    .trim()
    .replace(/\s*([-/])\s*/g, '$1')
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '');
}

/** A bill/booking number looks like an alphanumeric code with digits, 6–25 characters. */
export function looksLikeBillNumber(text: string): boolean {
  const t = cleanCode(text).replace(/[-/]/g, '');
  return /^[A-Z0-9]{6,25}$/i.test(t) && /\d/.test(t) && /\d{3,}/.test(t);
}
