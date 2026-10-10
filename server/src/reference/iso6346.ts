/**
 * ISO 6346 container number check digit. Letters map to 10..38 skipping multiples of 11;
 * each of the first 10 characters is weighted by 2^position; sum mod 11 (10 → 0).
 */
const LETTER_VALUES: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    out[ch] = v++;
  }
  return out;
})();

/** Check digit for the first 10 characters of a container number (owner code + category + serial). Throws on malformed input. */
export function iso6346CheckDigit(container: string): number {
  const s = container.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{4}\d{6}/.test(s)) throw new Error(`Not an ISO 6346 container number: "${container}"`);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const val = /\d/.test(ch) ? Number(ch) : LETTER_VALUES[ch];
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10;
}

/** True for an 11-character number whose last digit equals the computed check digit. */
export function isValidContainerNumber(container: string): boolean {
  const s = container.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{3}[UJZR]\d{7}$/.test(s)) return false;
  return iso6346CheckDigit(s) === Number(s[10]);
}
