/**
 * Pure normalizers that turn document values into the lexical forms the NetCHB
 * XSD accepts. Each returns whether it changed the value so callers can raise
 * an Issue instead of silently rewriting what the documents say.
 */
import { MAX_LEN } from './enums';

export interface Normalized {
  value: string;
  changed: boolean;
}

/**
 * invoiceNoType is [A-Za-z0-9-]{1,17}. Invoice numbers printed with '/', spaces
 * or '.' are common, so invalid characters become '-', repeats collapse, edge
 * dashes are trimmed and the result is cut to 17 characters.
 */
export function normalizeInvoiceNo(s: string): Normalized {
  const original = s ?? '';
  let v = original.trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (v.length > 17) v = v.slice(0, 17).replace(/-+$/, '');
  return { value: v, changed: v !== original };
}

/**
 * billNoType is alphanumeric only (max 50). Separators printed inside bill
 * numbers ("ABC-1234 5678") are dropped and the value is upper-cased.
 */
export function normalizeBillNo(s: string): Normalized {
  const original = s ?? '';
  const v = original.replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 50);
  return { value: v, changed: v !== original };
}

/** Package-unit synonyms → short manifest unit codes (unit is xsd:token maxLength 5). */
const PACKAGE_UNITS: [RegExp, string][] = [
  [/^(CARTONS?|CTNS?|CARTOONS?|CT)$/, 'CTN'],
  [/^(PACKAGES?|PKGS?|PACKS?|PK)$/, 'PKG'],
  [/^(PALLETS?|PLTS?|PALETTES?)$/, 'PLT'],
  [/^(PIECES?|PCS?|PIECE|PC)$/, 'PCS'],
  [/^(BAGS?|SACKS?)$/, 'BAG'],
  [/^(ROLLS?|RLS?)$/, 'RL'],
  [/^(BOX|BOXES|BXS?)$/, 'BX'],
  [/^(CASES?|CS|CAS)$/, 'CAS'],
  [/^(CRATES?|CRT)$/, 'CRT'],
  [/^(DRUMS?|DR)$/, 'DR'],
  [/^(BALES?|BL)$/, 'BL'],
  [/^(BUNDLES?|BDLS?)$/, 'BDL'],
  [/^(SKIDS?|SKD)$/, 'SKD'],
  [/^(UNITS?)$/, 'UNT'],
  [/^(SETS?)$/, 'SET'],
];

/** Normalizes a manifest package unit ("CARTONS" → "CTN"); unknown units are upper-cased and cut to 5 chars. */
export function normalizePackageUnit(unit: string | undefined): string {
  const u = (unit ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!u) return 'PKG';
  for (const [re, code] of PACKAGE_UNITS) if (re.test(u)) return code;
  return u.slice(0, MAX_LEN.manifestUnit);
}

/**
 * Maps a container size/type as printed ("20GP", "40'HC", "22G1", "45R1") to the
 * XSD's container-size / container-type enumerations. Returns undefined parts when
 * the code is not recognised rather than guessing.
 */
export function mapContainerSizeType(sizeType: string | undefined): { size?: string; type?: string } {
  if (!sizeType) return {};
  const s = sizeType.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // ISO 6346 size/type code: length digit/letter + height digit + type group letter + detail digit.
  const iso = /^([24L])([0-9])([A-Z])\d$/.exec(s);
  if (iso) {
    const len = iso[1] === '2' ? '20' : iso[1] === '4' ? '40' : '45';
    const hc = iso[2] === '5' || iso[2] === '6';
    return { size: `${len} ft${hc ? ' HC' : ''}`, type: isoGroupType(iso[3]) };
  }
  const m = /^(20|40|45|53)(.*)$/.exec(s);
  if (!m) return {};
  const rest = m[2];
  const hc = /^(HC|HQ|HCD|HCG|HG|HCRF|HR|HCRE)/.test(rest) || /HC|HQ/.test(rest);
  let type: string | undefined;
  if (/^(GP|DV|DC|ST|DRY|G|SD|STD|HC|HQ)$/.test(rest) || rest === '') type = 'Dry';
  else if (/RF|RE|RH|REEFER/.test(rest)) type = 'Reefer';
  else if (/OT|OPEN/.test(rest)) type = 'Open';
  else if (/FR|FLAT|PF/.test(rest)) type = 'Flat Rack';
  else if (/TK|TANK/.test(rest)) type = 'Tank';
  return { size: `${m[1]} ft${hc ? ' HC' : ''}`, type };
}

function isoGroupType(group: string): string | undefined {
  switch (group) {
    case 'G':
    case 'V':
    case 'B':
    case 'S':
      return 'Dry';
    case 'R':
    case 'H':
      return 'Reefer';
    case 'U':
      return 'Open';
    case 'P':
      return 'Flat Rack';
    case 'T':
      return 'Tank';
    default:
      return undefined;
  }
}

/** Collapses whitespace the way xsd:token does, so length checks match what the validator sees. */
export function collapse(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Cuts text to max characters at a word boundary when possible. */
export function truncateWords(s: string, max: number): string {
  const t = collapse(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  const out = space > max * 0.5 ? cut.slice(0, space) : t.slice(0, max);
  return out.replace(/[\s,;:/-]+$/, '');
}

/** Splits an address line into ≤max-char chunks on word boundaries (address-information is 35 chars). */
export function chunkWords(s: string, max: number): string[] {
  const words = collapse(s).split(' ').filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const piece = w.length > max ? w.slice(0, max) : w;
    if (!cur) cur = piece;
    else if (cur.length + 1 + piece.length <= max) cur += ' ' + piece;
    else {
      out.push(cur);
      cur = piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Rounds to 2 decimals (tariff quantities and dollar amounts allow 2 fraction digits). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Formats a 10-digit HTS number as 1234.56.78.90 for display. */
export function formatHts(digits: string): string {
  const d = digits.replace(/\D/g, '');
  const parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  return parts.join('.');
}

/** Upper-cased alphanumeric key used to compare party names across documents. */
export function nameKey(s: string | undefined): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/\b(INC|LLC|LTD|LIMITED|CO|CORP|CORPORATION|COMPANY|JSC|GMBH|SA|PLC)\b\.?/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

/** True for a real calendar date in YYYY-MM-DD form (xsd:date without timezone). */
export function isIsoDate(s: string | undefined): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
