/**
 * NON_DUTIABLE_CHARGES: international freight / insurance / US duties itemized on the invoice are
 * excluded from entered value (19 USC 1401a(b)(4)). Also settles ShipmentInvoice.linesAreFob from the
 * corrected line amounts, and flags itemized charges that are dutiable (packing, selling commission).
 */
import type { Issue } from '@app/shared';
import type { InvoiceSource, ReconcileContext, Rule } from '../context';
import { invoiceKey } from '../context';
import { normalizeCharges } from '../lib/charges';
import { assessFobBasis, DUTIABLE_TYPES } from '../lib/fob';
import { evidenceFor, makeIssue } from '../lib/issues';
import { fmtMoney, sum } from '../lib/num';
import { totalEvidence } from './helpers';

function runInvoice(ctx: ReconcileContext, inv: InvoiceSource): Issue | undefined {
  const links = ctx.links.filter((l) => l.inv === inv);
  const cur = inv.invoice.currency;
  const fob = assessFobBasis(inv.data, links.map((l) => l.line.amount.value), links.map((l) => l.line.noCommercialValue), cur);
  inv.invoice.linesAreFob = fob.linesAreFob;

  const charges = normalizeCharges(inv.data.charges);
  const dutiable = charges.filter((c) => DUTIABLE_TYPES.has(c.type) && c.amount);
  if (!fob.nonDutiable.length && !dutiable.length) return undefined;

  const chargeEv = (c: (typeof charges)[number]) => {
    const i = charges.findIndex((x) => x.description === c.description && x.amount === c.amount);
    return evidenceFor(inv.doc, `${c.description || c.type}: ${fmtMoney(c.amount, cur)}`, i >= 0 ? `charges[${i}]` : 'charges');
  };
  const term = inv.invoice.incoterm ? `${inv.invoice.incoterm.code}${inv.invoice.incoterm.place ? ` ${inv.invoice.incoterm.place}` : ''}` : 'Terms not stated';
  const parts: string[] = [];
  if (fob.nonDutiable.length) {
    parts.push(
      `${term}: ${fob.nonDutiable.map((c) => `${c.description || c.type} ${fmtMoney(c.amount, cur)}`).join(' + ')} = ${fmtMoney(fob.nonDutiableSum, cur)} are costs of international transport/insurance${fob.nonDutiable.some((c) => c.type === 'duty' || c.type === 'inland_freight_us') ? ' and US duties/inland delivery' : ''}, excluded from the entered value and reported as header charges.`,
      fob.reason,
    );
  }
  if (dutiable.length) {
    parts.push(
      `Dutiable charges are also itemized: ${dutiable.map((c) => `${c.description || c.type} ${fmtMoney(c.amount, cur)}`).join(', ')}. Packing costs and selling commissions paid by the buyer are part of the dutiable value (19 USC 1401a(b)(1)(A)-(B)) and must be included if not already in the line prices (${fmtMoney(sum(dutiable.map((c) => c.amount)), cur)}).`,
    );
  }
  const uncertain = fob.basis === 'unverified' || dutiable.length > 0;
  return makeIssue({
    code: 'NON_DUTIABLE_CHARGES',
    key: invoiceKey(ctx, inv),
    severity: uncertain ? 'warning' : 'info',
    category: 'valuation',
    title: fob.nonDutiable.length ? `Freight/insurance excluded from value (${fmtMoney(fob.nonDutiableSum, cur)})` : 'Itemized dutiable charges',
    detail: parts.join(' '),
    evidence: [
      ...[...fob.nonDutiable, ...dutiable].map(chargeEv),
      ...(fob.fobTotal ? [totalEvidence(inv, fob.fobTotal)] : []),
      ...(fob.termTotal ? [totalEvidence(inv, fob.termTotal)] : []),
    ],
    action: uncertain
      ? 'Confirm with the seller whether the line prices include the itemized charges, and keep the freight/insurance invoices on file to support the deduction.'
      : 'Keep the freight and insurance invoices (or the policy) on file to support the deduction; no change needed.',
    field: `invoices[${inv.index}].charges`,
  });
}

export const nonDutiableChargesRule: Rule = {
  name: 'non-dutiable-charges',
  codes: ['NON_DUTIABLE_CHARGES'],
  run: (ctx) => ctx.invoices.map((inv) => runInvoice(ctx, inv)).filter((i): i is Issue => !!i),
};
