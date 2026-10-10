/**
 * Decide whether invoice line amounts already exclude international freight/insurance
 * (ShipmentInvoice.linesAreFob). E/F terms: yes by definition. C/D terms: only when the charges are
 * itemized AND the printed totals prove goods + charges = the C/D total. Otherwise no, and the
 * assembler prorates the itemized deductions over the lines.
 */
import type { Charge, ChargeType, CommercialInvoiceData, PrintedTotal } from '@app/shared';
import { normalizeCharges } from './charges';
import { includesFreight, isFobLike, normIncoterm } from './incoterms';
import { approx, fmtMoney, round2, sum } from './num';
import { isMonetaryTotal, signedCharge, TOTAL_TOL } from './totals';

/** Charges outside the dutiable transaction value when separately identified (19 USC 1401a(b)(4)). */
export const NON_DUTIABLE_TYPES = new Set<ChargeType>(['freight', 'insurance', 'duty', 'inland_freight_us']);
/** Charges that are part of dutiable value when the buyer pays them (19 USC 1401a(b)(1)). */
export const DUTIABLE_TYPES = new Set<ChargeType>(['packing', 'commission', 'inland_freight_foreign']);

export type FobBasis = 'incoterm' | 'totals' | 'no_charges' | 'includes_charges' | 'unverified' | 'no_incoterm';

export interface FobAssessment {
  linesAreFob: boolean;
  basis: FobBasis;
  /** One sentence with the numbers, for issue details. */
  reason: string;
  incoterm?: string;
  nonDutiable: Charge[];
  nonDutiableSum: number;
  goodsTotal: number;
  fobTotal?: PrintedTotal;
  termTotal?: PrintedTotal;
}

const FOB_LABEL = /\b(FOB|FCA|FAS|EXW|EX[- ]?WORKS)\b/i;
const TOTAL_LABEL = /\b(grand total|invoice total|total amount|amount due|total invoice|total value|total)\b/i;

const validCharge = (c: Charge) => typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount !== 0;

/** Printed total for the C/D term itself: labelled with the code, else the largest plain "total". */
export function findTermTotal(totals: PrintedTotal[], code: string | undefined): PrintedTotal | undefined {
  const money = totals.filter(isMonetaryTotal);
  const byMax = (xs: PrintedTotal[]) => xs.reduce<PrintedTotal | undefined>((best, t) => (!best || t.amount > best.amount ? t : best), undefined);
  if (code) {
    const re = new RegExp(`\\b${code}\\b`, 'i');
    const labelled = money.filter((t) => re.test(t.label));
    if (labelled.length) return byMax(labelled);
  }
  return byMax(money.filter((t) => TOTAL_LABEL.test(t.label) && !FOB_LABEL.test(t.label)));
}

export const findFobTotal = (totals: PrintedTotal[]): PrintedTotal | undefined =>
  totals.filter(isMonetaryTotal).find((t) => FOB_LABEL.test(t.label));

export function assessFobBasis(data: CommercialInvoiceData, amounts: number[], ncv: boolean[], currency = 'USD'): FobAssessment {
  const code = normIncoterm(data.incoterm?.code);
  const charges = normalizeCharges(data.charges).filter(validCharge);
  const nonDutiable = charges.filter((c) => NON_DUTIABLE_TYPES.has(c.type));
  const nonDutiableSum = sum(nonDutiable.map((c) => c.amount));
  const goodsTotal = sum(amounts.filter((_, i) => !ncv[i]));
  const goodsAll = sum(amounts);
  const allCharges = round2(charges.reduce((s, c) => s + signedCharge(c), 0));
  const totals = data.totals ?? [];
  const fobTotal = findFobTotal(totals);
  const termTotal = findTermTotal(totals, code && !isFobLike(code) ? code : undefined);
  const base = { incoterm: code, nonDutiable, nonDutiableSum, goodsTotal, fobTotal, termTotal };
  const m = (n: number) => fmtMoney(n, currency);

  if (isFobLike(code)) {
    return { ...base, linesAreFob: true, basis: 'incoterm', reason: `${code} prices stop at the export point, so line amounts exclude international freight and insurance.` };
  }
  if (!nonDutiable.length) {
    if (code && includesFreight(code)) {
      return { ...base, linesAreFob: false, basis: 'no_charges', reason: `${code} prices include freight${code === 'DDP' ? ', insurance and duties' : ''} but no amounts are itemized, so nothing can be deducted.` };
    }
    return { ...base, linesAreFob: true, basis: 'no_incoterm', reason: 'No freight or insurance is itemized, so there is nothing to deduct from the line amounts.' };
  }
  if (termTotal) {
    // the line amounts themselves add up to the C/D total: they include the charges, whatever a printed
    // FOB breakdown says ("FOB value 109,950 + freight 4,350 = CFR value 114,300" describes the same prices)
    if (approx(goodsTotal, termTotal.amount, TOTAL_TOL) || approx(goodsAll, termTotal.amount, TOTAL_TOL)) {
      return {
        ...base,
        linesAreFob: false,
        basis: 'includes_charges',
        reason: `Line amounts ${m(goodsTotal)} already equal the printed "${termTotal.label}" ${m(termTotal.amount)}, so they include the itemized charges, which must be deducted.`,
      };
    }
    const bases: { v: number; what: string }[] = [];
    if (fobTotal) bases.push({ v: fobTotal.amount, what: `printed "${fobTotal.label}" ${m(fobTotal.amount)}` });
    bases.push({ v: goodsTotal, what: `line amounts ${m(goodsTotal)}` }, { v: goodsAll, what: `line amounts incl. NCV ${m(goodsAll)}` });
    for (const b of bases) {
      for (const add of [allCharges, nonDutiableSum]) {
        if (approx(b.v + add, termTotal.amount, TOTAL_TOL)) {
          return {
            ...base,
            linesAreFob: true,
            basis: 'totals',
            reason: `${b.what} + itemized charges ${m(add)} = printed "${termTotal.label}" ${m(termTotal.amount)}, so the line amounts already exclude the charges.`,
          };
        }
      }
    }
  }
  return {
    ...base,
    linesAreFob: false,
    basis: 'unverified',
    reason: `No printed total proves whether the line amounts (${m(goodsTotal)}) include the itemized charges (${m(nonDutiableSum)}); assuming they do, the charges are prorated off the lines.`,
  };
}
