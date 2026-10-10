/**
 * Identifier check digits used to build (and test) the synthetic transport documents:
 * ISO 6346 for container numbers and the IATA modulus-7 rule for air waybill serials.
 */

const LETTER_VALUES: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let v = 10;
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v += 1; // ISO 6346 skips multiples of 11
    out[c] = v;
    v += 1;
  }
  return out;
})();

/** ISO 6346 check digit for the first 10 characters (owner code + category + serial). */
export function iso6346CheckDigit(first10: string): number {
  if (!/^[A-Z]{4}\d{6}$/.test(first10)) throw new Error(`not an ISO 6346 prefix: ${first10}`);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const val = /\d/.test(ch) ? Number(ch) : LETTER_VALUES[ch];
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10;
}

/** True when an 11-char container number (spaces ignored) has a correct check digit. */
export function isValidContainer(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{4}\d{7}$/.test(s)) return false;
  return iso6346CheckDigit(s.slice(0, 10)) === Number(s[10]);
}

/**
 * Digit look-alikes that OCR (and OCR-repair heuristics) commonly swap.
 * Used to prove a deliberately wrong container number cannot be "repaired" by a
 * single plausible OCR substitution: the document error must stay an error.
 */
export const DIGIT_CONFUSIONS: Record<string, string> = {
  '0': '869',
  '1': '7',
  '2': '7',
  '3': '8',
  '4': '9',
  '5': '6',
  '6': '580',
  '7': '12',
  '8': '0365',
  '9': '40',
};

/** All container numbers reachable from `raw` by one OCR-confusion digit swap. */
export function singleConfusionVariants(raw: string): string[] {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  const out: string[] = [];
  for (let i = 4; i < s.length; i++) {
    for (const r of DIGIT_CONFUSIONS[s[i]] ?? '') out.push(s.slice(0, i) + r + s.slice(i + 1));
  }
  return out;
}

/** IATA air waybill: 3-digit airline prefix + 8-digit serial whose last digit = first 7 mod 7. */
export function isValidAwb(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(s)) return false;
  return Number(s.slice(3, 10)) % 7 === Number(s[10]);
}
