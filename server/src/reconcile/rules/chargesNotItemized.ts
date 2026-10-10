/**
 * CHARGES_NOT_ITEMIZED: the terms of sale put freight/insurance (or, for DDP, US duties) inside the
 * price, but the invoice doesn't state the amounts, so they can't be deducted from entered value.
 * Blocker when nothing is itemized; warning when only part of the expected costs is.
 */
import type { ChargeType, Issue } from '@app/shared';
import type { InvoiceSource, ReconcileContext, Rule } from '../context';
import { invoiceKey } from '../context';
import { normalizeCharges } from '../lib/charges';
import { DUTY_INCLUDED, includesFreight, INSURANCE_INCLUDED } from '../lib/incoterms';
import { evidenceFor, makeIssue } from '../lib/issues';
import { listText } from './helpers';

const LABEL: Partial<Record<ChargeType, string>> = { freight: 'international freight', insurance: 'insurance', duty: 'US duties' };

function runInvoice(ctx: ReconcileContext, inv: InvoiceSource): Issue | undefined {
  const code = inv.invoice.incoterm?.code;
  if (!includesFreight(code)) return undefined;
  const have = new Set<ChargeType>(normalizeCharges(inv.data.charges).filter((c) => c.amount).map((c): ChargeType => (c.type === 'inland_freight_us' ? 'freight' : c.type)));
  const expected: ChargeType[] = ['freight'];
  if (INSURANCE_INCLUDED.has(code as string)) expected.push('insurance');
  if (DUTY_INCLUDED.has(code as string)) expected.push('duty');
  const missing = expected.filter((t) => !have.has(t));
  if (!missing.length) return undefined;
  const none = missing.length === expected.length;
  const term = `${code}${inv.invoice.incoterm?.place ? ` ${inv.invoice.incoterm.place}` : ''}`;
  return makeIssue({
    code: 'CHARGES_NOT_ITEMIZED',
    key: invoiceKey(ctx, inv),
    severity: none ? 'blocker' : 'warning',
    category: 'valuation',
    title: none ? `${code} price includes costs that are not itemized` : `${code}: ${listText(missing.map((t) => LABEL[t] ?? t))} not itemized`,
    detail: `Under ${term} the invoice price includes ${listText(expected.map((t) => LABEL[t] ?? t))}, which are not part of the dutiable value, but the invoice does not state ${none ? 'any of these amounts' : `the ${listText(missing.map((t) => LABEL[t] ?? t))} amount`}. Without the amounts nothing can be deducted, so the entered value would include them (overstated value, excess duty).`,
    evidence: [evidenceFor(inv.doc, `Incoterms: ${term}`, 'incoterm')],
    action: `Obtain the actual ${listText(missing.map((t) => LABEL[t] ?? t))} amounts (freight invoice, insurance certificate${DUTY_INCLUDED.has(code as string) ? ', duty/brokerage breakdown' : ''}) from the seller, or confirm that the full price is to be entered.`,
    field: `invoices[${inv.index}].charges`,
  });
}

export const chargesNotItemizedRule: Rule = {
  name: 'charges-not-itemized',
  codes: ['CHARGES_NOT_ITEMIZED'],
  run: (ctx) => ctx.invoices.map((inv) => runInvoice(ctx, inv)).filter((i): i is Issue => !!i),
};
