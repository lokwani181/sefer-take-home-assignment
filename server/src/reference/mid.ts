/**
 * CBP Manufacturer Identification Code (MID), built exactly per "Rules for Constructing the
 * Manufacturer Identification Code" in CBP's ACE Entry Summary Instructions (v2.4, pp. 43-45),
 * which restate Customs Directive 3550-055 (1986):
 *   ISO country (Canada: province code) + first 3 chars of the first two name "words"
 *   + up to 4 digits of the largest number on the street address line + first 3 letters of the city.
 */
import type { Address, MidResult } from '@app/shared';
import { countryCode } from './countries.js';
import { stripDiacritics } from './text.js';

/** "CA" is not valid in a MID; CBP lists these province/territory codes instead. */
export const CANADA_PROVINCE_CODES: Record<string, string> = {
  AB: 'XA', ALBERTA: 'XA',
  BC: 'XC', 'BRITISH COLUMBIA': 'XC',
  MB: 'XM', MANITOBA: 'XM',
  NB: 'XB', 'NEW BRUNSWICK': 'XB',
  NL: 'XW', NF: 'XW', NEWFOUNDLAND: 'XW', 'NEWFOUNDLAND AND LABRADOR': 'XW', LABRADOR: 'XW',
  NT: 'XT', 'NORTHWEST TERRITORIES': 'XT',
  NS: 'XN', 'NOVA SCOTIA': 'XN',
  NU: 'XV', NUNAVUT: 'XV',
  ON: 'XO', ONT: 'XO', ONTARIO: 'XO',
  PE: 'XP', PEI: 'XP', 'PRINCE EDWARD ISLAND': 'XP',
  QC: 'XQ', PQ: 'XQ', QUEBEC: 'XQ',
  SK: 'XS', SASKATCHEWAN: 'XS',
  YT: 'XY', YUKON: 'XY', 'YUKON TERRITORY': 'XY',
};

/** City-states: CBP says to use the country name for the city piece. */
const CITY_STATE_CITY: Record<string, string> = { HK: 'HON', SG: 'SIN', MO: 'MAC', MC: 'MON' };

/** English words CBP says to ignore in the name. */
const IGNORED_WORDS = new Set(['A', 'AN', 'AND', 'OF', 'THE']);

/**
 * Leading words that only say what kind of entity it is. CBP's examples: Indonesian "PT",
 * Russian "JSC/OAO/OOO/ZAO", Macau "Fabrica de Artigos de Vestuario", and "Companhia Textil Karsten"
 * → KAR. `byGuidance: false` entries follow the same principle but are not named by CBP.
 */
const GENERIC_PREFIXES: { words: string[]; byGuidance: boolean }[] = [
  { words: ['FABRICA', 'DE', 'ARTIGOS', 'DE', 'VESTUARIO'], byGuidance: true },
  { words: ['COMPANHIA', 'TEXTIL'], byGuidance: true },
  { words: ['PT'], byGuidance: true },
  { words: ['JSC'], byGuidance: true },
  { words: ['OAO'], byGuidance: true },
  { words: ['OOO'], byGuidance: true },
  { words: ['ZAO'], byGuidance: true },
  { words: ['PAO'], byGuidance: false },
  { words: ['CONG', 'TY', 'TRACH', 'NHIEM', 'HUU', 'HAN'], byGuidance: false },
  { words: ['CONG', 'TY', 'CO', 'PHAN'], byGuidance: false },
  { words: ['CONG', 'TY', 'TNHH'], byGuidance: false },
  { words: ['CONG', 'TY', 'CP'], byGuidance: false },
  { words: ['CONG', 'TY'], byGuidance: false },
  { words: ['MS'], byGuidance: false }, // Indian "M/s" (Messrs)
];

/** Name → MID words: hyphenated parts join, runs of single-letter initials join, lone initials drop. */
export function midNameWords(name: string, notes: string[] = []): { words: string[]; prefixByAnalogy: boolean } {
  let s = stripDiacritics(name).toUpperCase();
  s = s.replace(/^\s*M\/S\.?\s+/, 'MS ');
  s = s.replace(/\s*[-‐‑–—]+\s*/g, ''); // "Rawles-Aden" / "Rawles – Aden" are one word
  s = s.replace(/[&'’`]/g, ' ');
  const raw = s.split(/[\s,;/()]+/).filter(Boolean);
  // Each token: dotted initials ("E.K.", "S.P.A.", "N.") → letters; otherwise strip punctuation.
  const toks: { text: string; single: boolean }[] = [];
  for (const t of raw) {
    const letters = /^([A-Z0-9]\.)+[A-Z0-9]?\.?$/.test(t) ? t.replace(/\./g, '') : t.replace(/[^A-Z0-9]/g, '');
    if (!letters) continue;
    toks.push({ text: letters, single: letters.length === 1 && /[A-Z]/.test(letters) });
  }
  // Consecutive single letters are one word ("A B C" → "ABC"); a lone one is ignored ("Thomas S. Delvaux").
  const merged: string[] = [];
  for (let i = 0; i < toks.length; ) {
    if (toks[i].single) {
      let j = i;
      let run = '';
      while (j < toks.length && toks[j].single) run += toks[j++].text;
      if (run.length > 1) merged.push(run);
      i = j;
    } else {
      merged.push(toks[i++].text);
    }
  }
  let words = merged.filter((w) => !IGNORED_WORDS.has(w));
  let prefixByAnalogy = false;
  for (const p of GENERIC_PREFIXES) {
    if (words.length > p.words.length && p.words.every((w, k) => words[k] === w)) {
      notes.push(
        `Dropped leading "${p.words.join(' ')}" from the manufacturer name (${p.byGuidance ? 'per CBP guidance on generic prefixes' : 'generic entity prefix, by analogy with CBP\'s PT/JSC examples'}).`,
      );
      words = words.slice(p.words.length);
      prefixByAnalogy = !p.byGuidance;
      break;
    }
  }
  return { words, prefixByAnalogy };
}

/**
 * Numbers on a street line per CBP: commas and hyphens between digits are ignored
 * ("12-34-56" → 123456) but a space is a delimiter ("2-6, 8-Chome" → 26 and 8, as in CBP's
 * N. MINAMI example → 26).
 */
export function streetNumbers(line: string): string[] {
  const joined = line.replace(/(\d)[,\-‐‑–—]+(?=\d)/g, '$1');
  return joined.match(/\d+/g) ?? [];
}

function largestNumber(nums: string[]): string | undefined {
  let best: string | undefined;
  for (const n of nums) {
    const v = n.replace(/^0+(?=\d)/, '');
    if (!best || v.length > best.length || (v.length === best.length && v > best)) best = v;
  }
  return best;
}

/**
 * Administrative-division words printed before a city name ("Kab. Tangerang" = Tangerang Regency,
 * "TP. Ho Chi Minh" = Ho Chi Minh City, "Amphoe Mueang"). "Kota" is left alone: it is part of real
 * city names (Kota Kinabalu).
 */
const ADMIN_PREFIX = new Set(['KAB', 'KABUPATEN', 'KEC', 'KECAMATAN', 'KEL', 'KELURAHAN', 'TP', 'THANH', 'HUYEN', 'TINH', 'QUAN', 'AMPHOE', 'CHANGWAT', 'KHET']);

/** First three letters of the city, ignoring digits, punctuation, spaces, "The" ("The Hague" → HAG) and admin prefixes. */
export function midCityPiece(city: string): string {
  const words = stripDiacritics(city)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'THE');
  // "THANH PHO Ho Chi Minh": both words of the prefix go
  while (words.length > 1 && ADMIN_PREFIX.has(words[0])) {
    const w = words.shift();
    if (w === 'THANH' && words[0] === 'PHO' && words.length > 1) words.shift();
  }
  return words.join('').slice(0, 3);
}

/** Contact / tax-registration lines. Short labels need a colon ("Ph:", "TIN:") so "Tin Hau Road" stays a street. */
const CONTACT_LINE =
  /^\s*(?:(?:TEL|PHONE|FAX|EMAIL|E-MAIL|ATTN|CONTACT|MST|TAX|VAT|REG|BR NO|WEB)\b|(?:PH|MOB|MOBILE|CELL|GSTIN|GST|IEC|EIN|EORI|CIN|PAN|TIN|USCI|CNPJ|RFC|NIF)\s*(?:NO\.?|#)?\s*[:.])/i;

/** Text that is never part of a street address (package counts, currency/amount/total labels, weights). */
const NON_ADDRESS = /(?:^|[\s,;])(?:\d[\d,.]*\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PCS|PIECES|PALLETS?|PLTS?|BALES?|ROLLS?|KGS?|LBS?|CBM)\b|(?:CURRENCY|TOTAL|SUB-?TOTAL|AMOUNT)\b|US\$|USD\b)/i;

/** A line that names a street / building, or starts with a house number. */
const STREET_LINE =
  /\b(?:STREET|STR|ST|STRASSE|STRAßE|ROAD|RD|AVENUE|AVE|AV|LANE|LN|DRIVE|DR|WAY|BOULEVARD|BLVD|HIGHWAY|HWY|PLAZA|SQUARE|SQ|RUE|VIA|CALLE|CARRERA|JALAN|JL|SOI|MOO|ALLEY|LOT|PLOT|BLOCK|BLK|BUILDING|BLDG|FLOOR|FL|UNIT|SUITE|STE|ROOM|RM|NO|P\.?\s*O\.?\s*BOX)\b|^\s*\d+[A-Z]?\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The street part of an address line: text run on after the address (carton counts, currency…)
 * and a trailing ", <city> [postal district]" (e.g. "41 Baseline Road, Colombo 09") are dropped,
 * because CBP takes the number from the street address only.
 */
function streetPart(line: string, city: string | undefined): string {
  let s = line;
  const junk = NON_ADDRESS.exec(s);
  if (junk) s = s.slice(0, junk.index);
  const c = city?.trim();
  if (c) s = s.replace(new RegExp(`[,;]\\s*${escapeRe(c)}\\b.*$`, 'i'), '');
  return s.trim();
}

/** A line that is the locality itself ("Colombo 09", "42651 Solingen"): its numbers are postal, not street numbers. */
function isLocalityLine(line: string, manufacturer: Address): boolean {
  const key = stripDiacritics(line).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const city = stripDiacritics(manufacturer.city ?? '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!city) return false;
  const pc = (manufacturer.postalCode ?? '').replace(/\s+/g, '').toUpperCase();
  const rest = key.replace(city, '').replace(/\s+/g, '');
  return key.includes(city) && (rest === '' || /^\d{1,2}$/.test(rest) || (!!pc && rest === pc));
}

/**
 * Build the MID for a manufacturer address. Returns needsVerification + notes whenever a
 * judgment call was needed (several numbered address lines, alphanumeric lot/unit numbers,
 * missing city/country, generic prefix dropped by analogy). Returns null without a name.
 */
export function buildMid(manufacturer: Address): MidResult | null {
  if (!manufacturer?.name?.trim()) return null;
  const notes: string[] = [];
  let needsVerification = false;

  // Piece 1: country (Canada → province).
  let country = manufacturer.country?.toUpperCase() || countryCode(manufacturer.raw ?? '') || undefined;
  if (!manufacturer.country && country) {
    notes.push(`Country ${country} inferred from the address text.`);
    needsVerification = true;
  }
  if (!country) {
    return { mid: '', needsVerification: true, notes: ['Manufacturer country unknown; the MID starts with the ISO country code.'] };
  }
  if (country === 'CA') {
    const prov = manufacturer.stateProvince ? CANADA_PROVINCE_CODES[stripDiacritics(manufacturer.stateProvince).toUpperCase().replace(/\./g, '').trim()] : undefined;
    if (!prov) {
      return {
        mid: '',
        needsVerification: true,
        notes: ['Canadian manufacturer: CBP requires the province code (XA…XY) instead of CA, and the province was not found.'],
      };
    }
    country = prov;
  }

  // Pieces 2-3: name.
  const { words, prefixByAnalogy } = midNameWords(manufacturer.name, notes);
  if (prefixByAnalogy) needsVerification = true;
  if (words.length === 0) {
    return { mid: '', needsVerification: true, notes: [...notes, 'No usable words in the manufacturer name.'] };
  }
  const namePiece = words
    .slice(0, 2)
    .map((w) => w.slice(0, 3))
    .join('');

  // Piece 4: largest number on the street address line. Contact/tax lines, run-on text (cartons,
  // currency), the locality and anything after ", <city>" are not the street address; among the
  // remaining numbered lines a line that names a street/building wins.
  const lines = (manufacturer.lines ?? []).filter((l) => l.trim() && !CONTACT_LINE.test(l));
  const numbered = lines.map((l) => streetPart(l, manufacturer.city)).filter((l) => /\d/.test(l) && !isLocalityLine(l, manufacturer));
  let numberPiece = '';
  if (numbered.length > 0) {
    const line = numbered.find((l) => STREET_LINE.test(l)) ?? numbered[0];
    let nums = streetNumbers(line);
    if (manufacturer.postalCode) {
      const pc = manufacturer.postalCode.replace(/\D/g, '');
      const withoutPc = nums.filter((n) => n !== pc);
      if (withoutPc.length < nums.length) notes.push(`Ignored postal code ${manufacturer.postalCode} on the street line.`);
      nums = withoutPc;
    }
    const largest = largestNumber(nums);
    if (largest) numberPiece = largest.slice(0, 4);
    if (numbered.length > 1) {
      needsVerification = true;
      notes.push(`Several address lines contain numbers; used the street line "${line.trim()}".`);
    }
    const alnum = (line.match(/\b(?=[A-Z0-9/]*[A-Z])(?=[A-Z0-9/]*\d)[A-Z0-9]+(?:[/-][A-Z0-9]+)*\b/gi) ?? []).filter(
      (t) => !/^\d+(ST|ND|RD|TH)$/i.test(t), // ordinals like "76th" are ordinary street numbers
    );
    if (alnum.length > 0) {
      needsVerification = true;
      notes.push(
        `Street line "${line.trim()}" mixes letters and digits (${alnum.join(', ')}); took the largest number ${numberPiece || '(none)'} from all digit groups. Verify against the MID the broker has on file.`,
      );
    }
  }

  // Piece 5: city.
  let cityPiece = CITY_STATE_CITY[country] ?? '';
  if (!cityPiece) {
    const city = manufacturer.city?.trim();
    if (!city) {
      needsVerification = true;
      notes.push('City missing from the parsed address; MID has no city piece.');
    } else {
      cityPiece = midCityPiece(city);
    }
  } else if (manufacturer.city) {
    notes.push(`City-state ${country}: city piece taken from the country name ("${cityPiece}").`);
  }

  const mid = `${country}${namePiece}${numberPiece}${cityPiece}`.slice(0, 15);
  return { mid, needsVerification, notes };
}
