/**
 * LINE_AMOUNT_MISMATCH: quantity × unit price ≠ printed line amount. Which figure is right is decided
 * by the printed sub-totals/totals (arithmetic evidence); when they don't decide, the higher value is
 * kept (conservative on value). The broker can flip via decision amount:<lineId>.
 */
import type { Issue } from '@app/shared';
import { DECISION_KEYS } from '@app/shared';
import type { InvoiceSource, LineLink, ReconcileContext, Rule } from '../context';
import { linePath } from '../context';
import { makeIssue } from '../lib/issues';
import { decimals, fmtMoney, isDigitTransposition, isNum, round2 } from '../lib/num';
import { checkTotals, countExplained, type TotalsInput } from '../lib/totals';
import { invoiceLineEvidence, lineName, money, qtyText, totalEvidence, lineNameLc } from './helpers';
import { sourced } from '../merge/sourced';

interface Mismatch {
  link: LineLink;
  computed: number;
  printed: number;
}

/** Lines whose printed amount disagrees with quantity × unit price beyond unit-price rounding. */
export function findAmountMismatches(links: LineLink[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const link of links) {
    const { invLine } = link;
    if (!isNum(invLine.quantity) || !isNum(invLine.unitPrice) || !isNum(invLine.amount) || invLine.quantity <= 0) continue;
    const printed = link.line.noCommercialValue ? Math.abs(invLine.amount) : invLine.amount;
    const computed = round2(invLine.quantity * Math.abs(invLine.unitPrice)) * Math.sign(printed || 1);
    // A unit price printed to 2 decimals may hide more precision: allow half a unit of its last decimal per piece.
    const roundingTol = invLine.quantity * 0.5 * 10 ** -Math.max(2, decimals(invLine.unitPrice));
    const diff = Math.abs(computed - printed);
    if (diff > 0.01 && diff > roundingTol) out.push({ link, computed, printed });
  }
  return out;
}

function totalsInput(inv: InvoiceSource, links: LineLink[], amounts: number[]): TotalsInput {
  return {
    amounts,
    ncv: links.map((l) => l.line.noCommercialValue),
    lineNos: links.map((l) => l.line.invoiceLineNo),
    charges: inv.data.charges ?? [],
    totals: inv.data.totals ?? [],
    currency: inv.invoice.currency,
  };
}

function runInvoice(ctx: ReconcileContext, inv: InvoiceSource): Issue[] {
  const links = ctx.links.filter((l) => l.inv === inv);
  const mism = findAmountMismatches(links);
  if (!mism.length) return [];
  const base = links.map((l) => l.line.amount.value);
  const pos = mism.map((m) => links.indexOf(m.link));
  const amountsFor = (mask: number) => base.map((v, i) => {
    const k = pos.indexOf(i);
    if (k < 0) return v;
    return mask & (1 << k) ? mism[k].computed : mism[k].printed;
  });
  const score = (mask: number) => countExplained(totalsInput(inv, links, amountsFor(mask)));
  const total = (mask: number) => amountsFor(mask).reduce((a, b) => a + b, 0);

  // Joint choice over all mismatched lines (≤ 10 lines → ≤ 1024 combinations).
  let best = 0;
  if (mism.length <= 10) {
    let bestScore = -1;
    for (let mask = 0; mask < 1 << mism.length; mask++) {
      const s = score(mask);
      if (s > bestScore || (s === bestScore && total(mask) > total(best))) {
        bestScore = s;
        best = mask;
      }
    }
  } else {
    mism.forEach((m, k) => {
      if (m.computed > m.printed) best |= 1 << k;
    });
  }
  const bestScore = score(best);
  const explainedBest = checkTotals(totalsInput(inv, links, amountsFor(best))).filter((c) => c.explainedBy);

  return mism.map((m, k) => {
    const { link } = m;
    const useComputed = !!(best & (1 << k));
    const flipped = best ^ (1 << k);
    const corroborated = bestScore > score(flipped);
    const cur = inv.invoice.currency;
    const chosenValue = useComputed ? m.computed : m.printed;
    const other = useComputed ? m.printed : m.computed;
    const p = `lines[${link.index}]`;

    if (useComputed) {
      link.line.printedAmount = m.printed;
      link.line.amount = sourced(m.computed, 'corrected', link.inv.doc, [`${p}.quantity`, `${p}.unitPrice`, `${p}.amount`], `Printed ${fmtMoney(m.printed, cur)}; corrected to quantity × unit price.`);
    }

    const q = link.invLine.quantity as number;
    const price = link.invLine.unitPrice as number;
    const parts = [
      `${lineName(link)}: ${qtyText(q, link.line.unit)} × ${money(link, price)} = ${money(link, m.computed)}, but the printed amount is ${money(link, m.printed)} (difference ${money(link, Math.abs(m.computed - m.printed))}${isDigitTransposition(m.computed, m.printed) ? '; the digits look transposed' : ''}).`,
    ];
    if (corroborated) {
      const reconciled = explainedBest.map((c) => `"${c.total.label}" ${fmtMoney(c.total.amount, cur)}`);
      parts.push(`The printed totals reconcile only with ${money(link, chosenValue)} (${reconciled.join('; ')}), so ${useComputed ? 'the line amount was corrected to the computed value' : 'the printed amount is kept and the unit price or quantity is suspect'}.`);
    } else {
      parts.push(`No printed total decides between the two figures; the higher value ${money(link, chosenValue)} is used to avoid under-declaring.`);
    }
    return makeIssue({
      code: 'LINE_AMOUNT_MISMATCH',
      key: link.line.id,
      severity: 'warning',
      category: 'discrepancy',
      title: `${lineName(link)}: quantity × unit price ≠ printed amount`,
      detail: parts.join(' '),
      evidence: [invoiceLineEvidence(link), ...explainedBest.slice(0, 3).map((c) => totalEvidence(inv, c.total))],
      action: `Ask the seller to confirm the line value (or issue a corrected invoice). Switch to "${useComputed ? 'printed' : 'computed'}" (${money(link, other)}) only if the seller confirms that figure.`,
      field: linePath(link, 'amount'),
      lineId: link.line.id,
      decision: {
        key: DECISION_KEYS.amount(link.line.id),
        question: `Which value should be entered for ${lineNameLc(link)}?`,
        options: [
          { value: 'computed', label: `Computed: ${qtyText(q, link.line.unit)} × ${money(link, price)} = ${money(link, m.computed)}` },
          { value: 'printed', label: `As printed: ${money(link, m.printed)}` },
        ],
        chosen: useComputed ? 'computed' : 'printed',
      },
    });
  });
}

export const lineAmountRule: Rule = {
  name: 'line-amount',
  codes: ['LINE_AMOUNT_MISMATCH'],
  run: (ctx) => ctx.invoices.flatMap((inv) => runInvoice(ctx, inv)),
};
