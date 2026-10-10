/**
 * Locale- and OCR-tolerant number parsing.
 *
 * Why: the same document set mixes "1,234.56", "1.234,56", "(24.00)" (NCV/negative)
 * and OCR confusions such as "S55" or a comma read instead of a decimal point
 * ("14,60" in a column of "15.80" values). Every repair is reported so callers can
 * lower confidence and record an observation instead of silently trusting it.
 */
import { normalizePunct } from './text';

export interface ParsedNumber {
  value: number;
  /** Text as read. */
  original: string;
  /** Printed in parentheses, e.g. "(24.00)". The value is returned positive; see `negative`. */
  parenthesized: boolean;
  /** Leading/trailing minus. Parentheses are NOT folded in: the caller decides (NCV vs credit). */
  negative: boolean;
  /** True when an OCR confusion or separator repair was needed to read the value. */
  repaired: boolean;
  repairs: string[];
  /** Digits after the decimal separator as printed (0 for integers). */
  decimals: number;
}

export interface ParseNumberOptions {
  /** Decimal separator used by the surrounding column/document, when known. */
  decimalSep?: '.' | ',';
  /** Map OCR letter confusions (O→0, l/I/|→1, S→5, B→8, Z→2). Default true. */
  ocrFix?: boolean;
}

const OCR_MAP: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', '|': '1', i: '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };

const PREFIX_RE = /^(?:USD|US\$|U\.S\.\$|HK\$|S\$|RMB|CNY|EUR|GBP|JPY|INR|VND|\$|€|£|¥)\s*/i;
const SUFFIX_RE = /\s*(?:PCS|PC|PCE|KGS|KG|LBS|LB|CBM|M3|USD|EUR|SETS|SET|DOZ|CTNS|CTN|CARTONS|PKGS|NOS|EA|%|\*+|\/\s*(?:PC|PCS|UNIT|SET|EA))\.?$/i;

/**
 * Parses one numeric token/cell. Returns null when the text is not a number.
 * Thousands/decimal separators are inferred per token, guided by `opts.decimalSep`.
 */
export function parseNumber(text: string, opts: ParseNumberOptions = {}): ParsedNumber | null {
  const original = text;
  const repairs: string[] = [];
  let s = normalizePunct(text).trim().replace(/[,;:]+$/, '').trim();
  if (!s) return null;
  // footnote markers glued to the value
  s = s.replace(/\s*\*+$/, '').replace(/^\*+\s*/, '');
  // table rules glued to a number by OCR ("60|", "1,200]", "240}")
  if (/^[|\][{}]?\d[\d.,]*\d?[|\][{}]$/.test(s) || /^[|\][{}]\d[\d.,]*$/.test(s)) s = s.replace(/^[|\][{}]|[|\][{}]$/g, '');
  let parenthesized = false;
  if (/^\(.*\)$/.test(s) || /^\([^)]*\d[^)]*$/.test(s) || /^[^(]*\d[^(]*\)$/.test(s)) {
    parenthesized = true;
    s = s.replace(/^\(/, '').replace(/\)$/, '').trim();
  }
  let negative = false;
  if (/^-/.test(s) || /-$/.test(s)) {
    negative = true;
    s = s.replace(/^-\s*/, '').replace(/\s*-$/, '');
  }
  s = s.replace(PREFIX_RE, '').replace(SUFFIX_RE, '').trim();
  if (/^-/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (!s) return null;
  // space as thousands separator: "1 234 567,89"
  if (/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) s = s.replace(/ /g, '');
  if (/\s/.test(s)) return null;

  if (/[^\d.,]/.test(s)) {
    if (opts.ocrFix === false) return null;
    const digits = (s.match(/\d/g) ?? []).length;
    const letters = (s.match(/[^\d.,]/g) ?? []).length;
    if (!digits || letters > digits || s.length < 2) return null;
    let fixed = '';
    for (const ch of s) {
      if (/[\d.,]/.test(ch)) fixed += ch;
      else if (OCR_MAP[ch]) fixed += OCR_MAP[ch];
      else return null;
    }
    repairs.push(`OCR confusion: "${s}" read as ${fixed}`);
    s = fixed;
  }
  if (!/\d/.test(s) || /^[.,]|[.,]{2}/.test(s)) return null;

  let intPart = s;
  let fracPart = '';
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    const i = s.lastIndexOf(dec);
    intPart = s.slice(0, i).split(thou).join('');
    fracPart = s.slice(i + 1);
    if (intPart.includes(dec)) return null;
  } else if (hasComma) {
    const groups = s.split(',');
    const thousands = /^\d{1,3}(,\d{3})+$/.test(s) || /^\d{1,2}(,\d{2})+,\d{3}$/.test(s);
    if (thousands && !(opts.decimalSep === ',' && groups.length === 2)) {
      intPart = groups.join('');
    } else if (groups.length === 2) {
      intPart = groups[0];
      fracPart = groups[1];
      if (opts.decimalSep === '.') repairs.push(`comma read as decimal point in "${original.trim()}"`);
    } else {
      // several commas that are not thousands groups: treat the last as decimal (OCR)
      intPart = groups.slice(0, -1).join('');
      fracPart = groups[groups.length - 1];
      repairs.push(`ambiguous separators in "${original.trim()}"`);
    }
  } else if (hasDot) {
    const groups = s.split('.');
    if (groups.length > 2) {
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) intPart = groups.join('');
      else {
        intPart = groups.slice(0, -1).join('');
        fracPart = groups[groups.length - 1];
        repairs.push(`ambiguous separators in "${original.trim()}"`);
      }
    } else if (opts.decimalSep === ',' && /^\d{1,3}\.\d{3}$/.test(s)) {
      intPart = groups.join('');
    } else {
      intPart = groups[0];
      fracPart = groups[1];
    }
  }
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null;
  const value = Number(fracPart ? `${intPart}.${fracPart}` : intPart);
  if (!Number.isFinite(value)) return null;
  return { value, original, parenthesized, negative, repaired: repairs.length > 0, repairs, decimals: fracPart.length };
}

/** Signed value: negative sign or parentheses make it negative. */
export function signedValue(p: ParsedNumber): number {
  return p.negative || p.parenthesized ? -p.value : p.value;
}

/**
 * Infers the decimal separator of a column/document from the unambiguous tokens it contains
 * ("1,234.56" or "15.80" → '.', "1.234,56" or "15,8" in a majority → ',').
 */
export function detectDecimalSep(texts: readonly string[]): '.' | ',' | undefined {
  let dot = 0;
  let comma = 0;
  for (const raw of texts) {
    const t = raw.replace(/[()\s*]/g, '');
    if (/\d,\d{3}\.\d+$/.test(t) || /^\d+\.\d{1,2}$/.test(t)) dot++;
    else if (/\d\.\d{3},\d+$/.test(t) || /^\d+,\d{1,2}$/.test(t)) comma++;
  }
  if (dot === comma) return undefined;
  return dot > comma ? '.' : ',';
}

/** Finds numeric tokens inside free text (e.g. "value USD 4,180.00, not included"). */
export function findNumbers(text: string, opts: ParseNumberOptions = {}): Array<ParsedNumber & { index: number }> {
  const out: Array<ParsedNumber & { index: number }> = [];
  const re = /\(?-?\d[\d.,]*\d\)?|\(?-?\d\)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = parseNumber(m[0], { ...opts, ocrFix: false });
    if (p) out.push({ ...p, index: m.index });
  }
  return out;
}
