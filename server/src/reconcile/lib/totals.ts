/**
 * Printed-totals arithmetic. A printed total is "explained" when it equals some meaningful
 * combination of the current line amounts and itemized charges: page sub-totals (prefix/suffix sums),
 * labelled item ranges, the goods total with or without NCV lines, and goods + any subset of charges.
 */
import type { Charge, PrintedTotal } from '@app/shared';
import { chargeKind } from './charges';
import { approx, fmtMoney, round2, sum } from './num';

export interface TotalsInput {
  /** Current amount per invoice line, in invoice order. */
  amounts: number[];
  /** Whether each line is no-commercial-value (often excluded from totals). */
  ncv: boolean[];
  lineNos: number[];
  charges: Charge[];
  totals: PrintedTotal[];
  currency?: string;
}

export interface TotalCheck {
  total: PrintedTotal;
  /** Human description of the combination that reproduces the total. */
  explainedBy?: string;
}

const NON_MONETARY = /\b(qty|quantity|quantities|pcs|pieces|cartons?|ctns?|packages?|pkgs?|weight|n\.?w|g\.?w|kgs?|lbs?|cbm|m3|volume|meas(?:urement)?|units?|dozens?)\b/i;
const PAYMENT_STATE = /\b(deposit|advance|balance|paid|prepayment|outstanding)\b/i;

/** Only money totals are reconciled; quantity/weight totals and payment-state lines are skipped. */
export function isMonetaryTotal(t: PrintedTotal): boolean {
  return typeof t.amount === 'number' && Number.isFinite(t.amount) && !NON_MONETARY.test(t.label) && !PAYMENT_STATE.test(t.label);
}

/** Charge amount signed for totals arithmetic (discounts reduce the total). */
export const signedCharge = (c: Charge): number => (chargeKind(c) === 'discount' ? -Math.abs(c.amount) : c.amount);

interface Candidate {
  value: number;
  label: string;
}

function candidates(input: TotalsInput): Candidate[] {
  const { amounts, ncv, lineNos, charges, totals } = input;
  const cur = input.currency ?? 'USD';
  const out: Candidate[] = [];
  const n = amounts.length;
  const lbl = (i: number) => lineNos[i] ?? i + 1;
  for (const excludeNcv of [true, false]) {
    const vals = amounts.map((a, i) => (excludeNcv && ncv[i] ? 0 : a));
    const tag = excludeNcv && ncv.some(Boolean) ? ' excluding NCV lines' : '';
    for (let k = 1; k <= n; k++) out.push({ value: sum(vals.slice(0, k)), label: `lines ${lbl(0)}–${lbl(k - 1)}${tag}` });
    for (let k = 1; k < n; k++) out.push({ value: sum(vals.slice(k)), label: `lines ${lbl(k)}–${lbl(n - 1)}${tag}` });
    for (const t of totals) {
      const m = /\b(?:items?|lines?|nos?)\.?\s*(\d+)\s*(?:-|–|to|thru|through)\s*(\d+)/i.exec(t.label);
      if (!m) continue;
      const [a, b] = [Number(m[1]), Number(m[2])];
      const v = sum(vals.filter((_, i) => lbl(i) >= a && lbl(i) <= b));
      out.push({ value: v, label: `lines ${a}–${b}${tag}` });
    }
    const goods = sum(vals);
    const cs = charges.filter((c) => typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount !== 0);
    const subsets = cs.length <= 10 ? 1 << cs.length : 0;
    for (let mask = 1; mask < subsets; mask++) {
      const picked = cs.filter((_, i) => mask & (1 << i));
      const chargeSum = round2(picked.reduce((s, c) => s + signedCharge(c), 0));
      const names = picked.map((c) => `${c.description || c.type} ${fmtMoney(signedCharge(c), cur)}`).join(' + ');
      out.push({ value: round2(goods + chargeSum), label: `goods ${fmtMoney(goods, cur)}${tag} + ${names}` });
      out.push({ value: round2(goods - chargeSum), label: `goods ${fmtMoney(goods, cur)}${tag} − ${names} (charges included in the prices)` });
      out.push({ value: chargeSum, label: `charges ${names}` });
    }
    if (cs.length > 10) {
      const chargeSum = round2(cs.reduce((s, c) => s + signedCharge(c), 0));
      out.push({ value: round2(goods + chargeSum), label: `goods + all charges${tag}` });
    }
  }
  return out;
}

/** Tolerance for printed totals: a couple of cents of accumulated rounding. */
export const TOTAL_TOL = 0.02;

/** Which printed money totals can be reproduced from the current amounts and charges. */
export function checkTotals(input: TotalsInput): TotalCheck[] {
  const cands = candidates(input);
  return input.totals.filter(isMonetaryTotal).map((total) => {
    const hit = cands.find((c) => approx(c.value, total.amount, TOTAL_TOL));
    return hit ? { total, explainedBy: hit.label } : { total };
  });
}

/** Number of printed money totals the given amounts reproduce (used to corroborate line corrections). */
export const countExplained = (input: TotalsInput): number => checkTotals(input).filter((c) => c.explainedBy).length;

/**
 * True when the itemized discount(s) are deducted on the invoice itself: some printed money total equals
 * the goods minus every discount (plus any subset of the other itemized charges). The price actually
 * paid is then net of the discount (19 USC 1401a(b)(1)); a total that ignores the discount means it is
 * informational (or a rebate settled elsewhere) and the undiscounted price stands.
 */
export function discountsDeducted(charges: Charge[], totals: PrintedTotal[], amounts: number[], ncv: boolean[]): boolean {
  const valid = charges.filter((c) => typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount !== 0);
  const discounts = valid.filter((c) => chargeKind(c) === 'discount');
  if (!discounts.length) return false;
  const others = valid.filter((c) => chargeKind(c) !== 'discount').slice(0, 10);
  const less = sum(discounts.map((c) => Math.abs(c.amount)));
  const money = totals.filter(isMonetaryTotal);
  for (const goods of [sum(amounts.filter((_, i) => !ncv[i])), sum(amounts)]) {
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const extra = others.reduce((s, c, i) => (mask & (1 << i) ? s + signedCharge(c) : s), 0);
      const net = round2(goods - less + extra);
      if (money.some((t) => approx(t.amount, net, TOTAL_TOL))) return true;
    }
  }
  return false;
}
