/**
 * Amounts in words for the "SAY TOTAL …" lines that Asian export invoices print under the total.
 * English, upper case, hand-rolled (no Intl) so output never depends on the machine.
 */

const ONES = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

/** 0–999 → words; `and` inserts "AND" between hundreds and the rest (British style). */
function under1000(n: number, and: boolean, hyphen: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} HUNDRED`);
  if (r > 0) {
    if (h > 0 && and) parts.push('AND');
    if (r < 20) parts.push(ONES[r]);
    else parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? (hyphen ? '-' : ' ') + ONES[r % 10] : ''));
  }
  return parts.join(' ');
}

/** Whole number (< 1e9) in words, e.g. 171354 → "ONE HUNDRED SEVENTY-ONE THOUSAND THREE HUNDRED FIFTY-FOUR". */
export function intWords(n: number, opts: { and?: boolean; hyphen?: boolean } = {}): string {
  const and = opts.and ?? false;
  const hyphen = opts.hyphen ?? true;
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) throw new Error(`intWords: unsupported ${n}`);
  if (n === 0) return 'ZERO';
  const parts: string[] = [];
  const m = Math.floor(n / 1e6);
  const t = Math.floor((n % 1e6) / 1000);
  const r = n % 1000;
  if (m) parts.push(`${under1000(m, and, hyphen)} MILLION`);
  if (t) parts.push(`${under1000(t, and, hyphen)} THOUSAND`);
  if (r) parts.push(under1000(r, and, hyphen));
  return parts.join(' ');
}

/** Dollars and cents: 171354.77 → "… FIFTY-FOUR AND CENTS SEVENTY-SEVEN". */
export function moneyWords(v: number, opts: { and?: boolean; hyphen?: boolean; centsWord?: string } = {}): string {
  const cents = Math.round(v * 100) % 100;
  const whole = Math.round(v * 100 - cents) / 100;
  const base = intWords(whole, opts);
  if (cents === 0) return base;
  return `${base} AND ${opts.centsWord ?? 'CENTS'} ${intWords(cents, opts)}`;
}
