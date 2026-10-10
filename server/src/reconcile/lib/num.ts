/** Small numeric helpers shared by merge and rules. */

/** True for finite numbers only (parsers may emit NaN/undefined for unread cells). */
export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Round to cents; avoids float artefacts like 0.1 × 3 = 0.30000000000000004. */
export const round2 = (n: number): number => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export const approx = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol + 1e-9;

export const sum = (xs: number[]): number => round2(xs.reduce((a, b) => a + b, 0));

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Relative difference of a vs reference b, in percent. */
export const pctDiff = (a: number, b: number): number => (b === 0 ? (a === 0 ? 0 : 100) : (Math.abs(a - b) / Math.abs(b)) * 100);

/** "6,840" / "715.4" — human-readable number with grouping. */
export function fmtNum(n: number, maxDecimals = 3): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDecimals });
}

/** "USD 6,840.00" */
export function fmtMoney(n: number, currency = 'USD'): string {
  return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Number of decimals a parsed number carries (2.85 → 2). */
export function decimals(n: number): number {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** True when the two numbers' digit strings are permutations of each other (e.g. 1230 vs 1320). */
export function isDigitTransposition(a: number, b: number): boolean {
  const da = String(Math.round(a * 100)).split('').sort().join('');
  const db = String(Math.round(b * 100)).split('').sort().join('');
  return a !== b && da === db;
}
