/**
 * Per-line customs valuation (transaction value, 19 USC 1401a) with a signed,
 * human-readable computation trail.
 *
 *   base (line amount, or stated value for NCV lines)
 *   − non-dutiable charges included in the price (prorated by line value), only when
 *     the line prices are NOT already net of them and the incoterm puts them in the price
 *   + dutiable charges itemized on top of the line prices (packing, selling commissions)
 *   − discounts deducted on the invoice itself (prorated by line value)
 *   + assists (100% to the carrying line; split by value when several lines carry one)
 *   = entered value, rounded to whole units only at the very end.
 *
 * Amounts stay in the invoice currency; conversion is left to NetCHB.
 */
import type { Assist, Charge, ChargeType, Incoterm, LineValuation, ValuationStep } from '@app/shared';
import { round2 } from './normalize';

export interface ValuationLineInput {
  lineId: string;
  /** Line amount after decisions (invoice currency). */
  amount: number;
  /** How the amount was obtained, e.g. "Invoice amount (2,400 × 2.85)". */
  amountLabel: string;
  noCommercialValue: boolean;
  /** Stated value for customs (whole line), NCV/FOC lines. */
  customsValue?: number;
  assists: Assist[];
}

export interface ValuationInvoiceInput {
  currency: string;
  incoterm?: Incoterm;
  /** True when line amounts already exclude freight/insurance (charges itemized on top). */
  linesAreFob: boolean;
  charges: Charge[];
  lines: ValuationLineInput[];
  /** The itemized discounts are deducted on the invoice (ShipmentInvoice.discountsDeducted). */
  discountsDeducted?: boolean;
}

export interface InvoiceValuation {
  valuations: LineValuation[];
  /** Unrounded entered value per lineId (invoice currency). */
  exactValues: Record<string, number>;
  /** Base value per lineId (before adjustments). */
  baseValues: Record<string, number>;
  /** Total deducted per charge type. */
  deducted: Partial<Record<ChargeType, number>>;
  /** Total added per charge type. */
  added: Partial<Record<ChargeType, number>>;
}

/** Charge types that are excluded from transaction value when included in the price and itemized. */
const NON_DUTIABLE_BY_TERM: Record<string, ChargeType[]> = {
  EXW: [],
  FCA: [],
  FAS: [],
  FOB: [],
  CFR: ['freight', 'insurance', 'inland_freight_us'],
  CPT: ['freight', 'insurance', 'inland_freight_us'],
  CIF: ['freight', 'insurance', 'inland_freight_us'],
  CIP: ['freight', 'insurance', 'inland_freight_us'],
  DAP: ['freight', 'insurance', 'inland_freight_us', 'handling'],
  DPU: ['freight', 'insurance', 'inland_freight_us', 'handling'],
  DAT: ['freight', 'insurance', 'inland_freight_us', 'handling'],
  DDP: ['freight', 'insurance', 'inland_freight_us', 'handling', 'duty'],
};

const CHARGE_LABEL: Record<ChargeType, string> = {
  freight: 'international freight',
  insurance: 'insurance',
  packing: 'packing',
  commission: 'selling commission',
  discount: 'discount',
  duty: 'U.S. duties/taxes',
  inland_freight_foreign: 'foreign inland freight',
  inland_freight_us: 'U.S. inland freight',
  handling: 'destination handling',
  other: 'other charges',
};

/** Non-dutiable charge types an incoterm puts into the price ([] for E/F terms or unknown terms). */
export function nonDutiableChargeTypes(incoterm: Incoterm | undefined): ChargeType[] {
  if (!incoterm?.code) return [];
  return NON_DUTIABLE_BY_TERM[incoterm.code.toUpperCase().trim()] ?? [];
}

/** True for charges that are part of dutiable value when itemized on top of the price. */
function isDutiableAddition(c: Charge): boolean {
  if (c.type === 'packing') return true;
  if (c.type === 'commission') return !/\bbuying\b/i.test(c.description);
  return false;
}

const fmt = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** Values every line of one invoice. Pure; no rounding until the final step. */
export function valueInvoice(inv: ValuationInvoiceInput): InvoiceValuation {
  const currency = inv.currency || 'USD';
  const term = inv.incoterm?.code?.toUpperCase();

  const base = new Map<string, number>();
  const baseNote = new Map<string, string>();
  for (const l of inv.lines) {
    if (l.noCommercialValue && l.customsValue !== undefined) {
      base.set(l.lineId, l.customsValue);
      baseNote.set(l.lineId, 'No commercial value: stated value for customs purposes');
    } else base.set(l.lineId, l.amount);
  }

  // Proration basis: commercial lines (NCV lines did not bear the invoice's charges), unless all lines are NCV.
  const commercial = inv.lines.filter((l) => !l.noCommercialValue);
  const basisLines = commercial.length ? commercial : inv.lines;
  const basisTotal = basisLines.reduce((s, l) => s + (base.get(l.lineId) ?? 0), 0);
  const shareOf = (lineId: string): number => {
    if (!basisLines.some((l) => l.lineId === lineId)) return 0;
    if (basisTotal > 0) return (base.get(lineId) ?? 0) / basisTotal;
    return 1 / basisLines.length;
  };

  const steps = new Map<string, ValuationStep[]>();
  const exact = new Map<string, number>();
  for (const l of inv.lines) {
    const b = base.get(l.lineId) ?? 0;
    steps.set(l.lineId, [{ label: baseNote.has(l.lineId) ? 'Stated value for customs (NCV line)' : l.amountLabel, amount: round2(b), note: baseNote.get(l.lineId) }]);
    exact.set(l.lineId, b);
  }
  const push = (lineId: string, label: string, note: string, exactAmount: number) => {
    steps.get(lineId)!.push({ label, amount: round2(exactAmount), note });
    exact.set(lineId, (exact.get(lineId) ?? 0) + exactAmount);
  };

  const deducted: Partial<Record<ChargeType, number>> = {};
  const added: Partial<Record<ChargeType, number>> = {};
  const totalsByType = (pred: (c: Charge) => boolean): Map<ChargeType, number> => {
    const m = new Map<ChargeType, number>();
    for (const c of inv.charges) if (pred(c) && Number.isFinite(c.amount) && c.amount !== 0) m.set(c.type, (m.get(c.type) ?? 0) + Math.abs(c.amount));
    return m;
  };

  if (!inv.linesAreFob) {
    // Charges are inside the line prices: back out the ones the incoterm makes non-dutiable.
    const types = new Set(nonDutiableChargeTypes(inv.incoterm));
    for (const [type, total] of totalsByType((c) => types.has(c.type))) {
      deducted[type] = total;
      for (const l of basisLines) {
        const share = shareOf(l.lineId);
        if (share <= 0) continue;
        push(
          l.lineId,
          `Less ${CHARGE_LABEL[type]} (${term ?? 'incoterm'}, non-dutiable)`,
          `Itemized ${fmt(total)} ${currency} × ${pct(share)} of invoice line value`,
          -total * share,
        );
      }
    }
  } else {
    // Charges are itemized on top of the line prices: add the dutiable ones.
    for (const [type, total] of totalsByType(isDutiableAddition)) {
      added[type] = total;
      for (const l of basisLines) {
        const share = shareOf(l.lineId);
        if (share <= 0) continue;
        push(
          l.lineId,
          `Plus ${CHARGE_LABEL[type]} (itemized, dutiable)`,
          `Itemized ${fmt(total)} ${currency} × ${pct(share)} of invoice line value`,
          total * share,
        );
      }
    }
  }

  // Discounts deducted on the invoice itself lower the price actually paid (19 USC 1401a(b)(1)); only a
  // decrease made after importation is disregarded (19 USC 1401a(b)(4)(B)). Apportioned by line value.
  if (inv.discountsDeducted) {
    for (const c of inv.charges) {
      if (c.type !== 'discount' || !Number.isFinite(c.amount) || c.amount === 0) continue;
      const total = Math.abs(c.amount);
      deducted.discount = (deducted.discount ?? 0) + total;
      for (const l of basisLines) {
        const share = shareOf(l.lineId);
        if (share <= 0) continue;
        push(
          l.lineId,
          `Less discount: ${c.description || 'discount'}`,
          `Deducted on the invoice: ${fmt(total)} ${currency} × ${pct(share)} of invoice line value. The price actually paid is net of it (19 USC 1401a(b)(1)); a rebate granted after importation would not be deductible (19 USC 1401a(b)(4)(B)).`,
          -total * share,
        );
      }
    }
  }

  // Assists: group identical assists across lines, then apportion among the lines that carry them.
  const groups = new Map<string, { assist: Assist; lineIds: string[] }>();
  for (const l of inv.lines) {
    for (const a of l.assists) {
      const key = `${a.description}|${a.value}|${a.reference ?? ''}|${a.currency ?? ''}`;
      const g = groups.get(key) ?? { assist: a, lineIds: [] };
      if (!g.lineIds.includes(l.lineId)) g.lineIds.push(l.lineId);
      groups.set(key, g);
    }
  }
  for (const { assist, lineIds } of groups.values()) {
    const carriersTotal = lineIds.reduce((s, id) => s + (base.get(id) ?? 0), 0);
    for (const id of lineIds) {
      const share = lineIds.length === 1 ? 1 : carriersTotal > 0 ? (base.get(id) ?? 0) / carriersTotal : 1 / lineIds.length;
      const currencyNote =
        assist.currency && assist.currency.toUpperCase() !== currency.toUpperCase()
          ? ` Assist stated in ${assist.currency}, invoice in ${currency}: convert before filing.`
          : '';
      push(
        id,
        `Plus assist: ${assist.description}`,
        (lineIds.length === 1
          ? `100% of ${fmt(assist.value)} apportioned to this line (19 USC 1401a(h)).`
          : `${fmt(assist.value)} split by line value across ${lineIds.length} lines: ${pct(share)} (19 USC 1401a(h)).`) +
          currencyNote,
        assist.value * share,
      );
    }
  }

  const valuations: LineValuation[] = inv.lines.map((l) => {
    const value = exact.get(l.lineId) ?? 0;
    const entered = Math.round(value);
    const s = steps.get(l.lineId)!;
    const diff = round2(entered - value);
    if (diff !== 0) s.push({ label: 'Rounded to whole units', amount: diff });
    return { lineId: l.lineId, currency, steps: s, enteredValue: entered };
  });

  return {
    valuations,
    exactValues: Object.fromEntries(exact),
    baseValues: Object.fromEntries(base),
    deducted,
    added,
  };
}
