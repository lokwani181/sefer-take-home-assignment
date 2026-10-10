/**
 * Locale-style number formatting done by hand (not Intl) so the rendered documents
 * never depend on the ICU build of the machine that runs the generator.
 */

export type NumberStyle = 'en' | 'de';

function groupThousands(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** 21878 → "21,878.00" (en) or "21.878,00" (de). */
export function fmtNum(value: number, decimals: number, style: NumberStyle = 'en'): string {
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const thousands = style === 'de' ? '.' : ',';
  const decimal = style === 'de' ? ',' : '.';
  const body = groupThousands(intPart, thousands) + (frac !== undefined ? decimal + frac : '');
  return neg ? `-${body}` : body;
}

/** Money with two decimals. */
export function fmtMoney(value: number, style: NumberStyle = 'en'): string {
  return fmtNum(value, 2, style);
}

/** Integer with thousands separators. */
export function fmtInt(value: number, style: NumberStyle = 'en'): string {
  return fmtNum(value, 0, style);
}

/** Round half away from zero to cents, avoiding binary float drift (e.g. 1.005). */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON * Math.sign(value)) * 100) / 100;
}
