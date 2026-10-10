/**
 * ISO 6346 container numbers: owner code (3 letters) + category (U/J/Z) + 6-digit serial + check digit.
 * Implemented here so reconcile can re-validate every candidate the parser kept.
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

const SHAPE = /^[A-Z]{3}[UJZ]\d{7}$/;

/** Check digit for the first 10 characters, or undefined when they aren't well-formed. */
export function iso6346CheckDigit(first10: string): number | undefined {
  const s = first10.toUpperCase();
  if (!/^[A-Z]{4}\d{6}$/.test(s)) return undefined;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const val = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    total += val * 2 ** i;
  }
  return (total % 11) % 10;
}

/** Normalize spacing/punctuation: "CSQU 305438-3" → "CSQU3054383". */
export const compactContainer = (s: string): string => s.toUpperCase().replace(/[\s.\-_]/g, '');

export function isValidContainerNumber(n: string | undefined): boolean {
  if (!n) return false;
  const s = compactContainer(n);
  if (!SHAPE.test(s)) return false;
  return iso6346CheckDigit(s.slice(0, 10)) === Number(s[10]);
}

const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '7': 'T', '8': 'B' };
const TO_DIGIT: Record<string, string> = {
  O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', '/': '1', '!': '1', Z: '2', S: '5', B: '8', G: '6', T: '7', A: '4',
};

function foldConfusions(s: string): string {
  return s
    .split('')
    .map((ch, i) => (i < 4 ? (TO_LETTER[ch] ?? ch) : (TO_DIGIT[ch] ?? ch)))
    .join('');
}

/**
 * Check-digit-valid readings of an OCR'd container string, using only letter/digit confusion folding
 * and (for 12-char reads) dropping one spurious character. Never invents a check digit.
 */
export function containerRepairs(raw: string): string[] {
  const s = compactContainer(raw);
  const bases = new Set<string>([s]);
  if (s.length === 12) for (let i = 0; i < 12; i++) bases.add(s.slice(0, i) + s.slice(i + 1));
  const out = new Set<string>();
  for (const b of bases) {
    if (b.length !== 11) continue;
    for (const v of [b, foldConfusions(b)]) if (isValidContainerNumber(v)) out.add(v);
  }
  return [...out];
}
