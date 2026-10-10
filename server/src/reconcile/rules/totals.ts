/**
 * TOTALS_MISMATCH: printed invoice totals that no combination of the (corrected) line amounts and
 * itemized charges reproduces, and packing-list grand totals that differ from the sum of their lines.
 * Runs after LINE_AMOUNT_MISMATCH so a corroborated correction doesn't double-fire here.
 */
import type { Evidence, Issue, PackingListData } from '@app/shared';
import type { DocSource, InvoiceSource, ReconcileContext, Rule } from '../context';
import { invoiceKey } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { approx, fmtMoney, fmtNum, isNum, round3, sum } from '../lib/num';
import { checkTotals } from '../lib/totals';
import { totalEvidence } from './helpers';

function invoiceTotals(ctx: ReconcileContext, inv: InvoiceSource): Issue | undefined {
  const links = ctx.links.filter((l) => l.inv === inv);
  // Unread lines or values are reported by MISSING_FIELD; the arithmetic can't be checked without them.
  if (!links.length || links.some((l) => l.line.amount.status === 'assumed')) return undefined;
  const amounts = links.map((l) => l.line.amount.value);
  const ncv = links.map((l) => l.line.noCommercialValue);
  const checks = checkTotals({
    amounts,
    ncv,
    lineNos: links.map((l) => l.line.invoiceLineNo),
    charges: inv.data.charges ?? [],
    totals: inv.data.totals ?? [],
    currency: inv.invoice.currency,
  });
  const bad = checks.filter((c) => !c.explainedBy);
  if (!bad.length) return undefined;
  const cur = inv.invoice.currency;
  const goods = sum(amounts.filter((_, i) => !ncv[i]));
  const charges = (inv.data.charges ?? []).filter((c) => isNum(c.amount));
  const chargeText = charges.length ? `; itemized charges ${charges.map((c) => `${c.description || c.type} ${fmtMoney(c.amount, cur)}`).join(', ')}` : '';
  return makeIssue({
    code: 'TOTALS_MISMATCH',
    key: invoiceKey(ctx, inv),
    severity: 'warning',
    category: 'discrepancy',
    title: `Invoice ${inv.data.invoiceNumber || ''} totals don't add up`.replace(/\s+/g, ' '),
    detail: `${bad.map((c) => `"${c.total.label}" ${fmtMoney(c.total.amount, cur)}`).join('; ')} cannot be reproduced from the line amounts (goods ${fmtMoney(goods, cur)}${ncv.some(Boolean) ? ` excluding no-commercial-value lines, ${fmtMoney(sum(amounts), cur)} including them` : ''}${chargeText}). A line, a charge or a discount may be missing or misread.`,
    evidence: bad.map((c) => totalEvidence(inv, c.total)),
    action: 'Check the invoice arithmetic against the original and confirm with the seller which total was actually paid; the entered value follows the line amounts.',
    field: `invoices[${inv.index}].printedTotals`,
  });
}

type PlTotalKey = 'cartons' | 'pcs' | 'netWeightKg' | 'grossWeightKg';

function packingTotals(pl: DocSource<PackingListData>): Issue | undefined {
  const lines = pl.data.lines ?? [];
  const totals = pl.data.totals ?? {};
  if (!lines.length) return undefined;
  const lineValue = (key: PlTotalKey, l: PackingListData['lines'][number]): number | undefined => {
    if (key === 'pcs') return isNum(l.totalPcs) ? l.totalPcs : isNum(l.cartons) && isNum(l.pcsPerCarton) ? l.cartons * l.pcsPerCarton : undefined;
    if (key === 'cartons') return l.cartons;
    return l[key];
  };
  const labels: Record<PlTotalKey, string> = { cartons: 'cartons', pcs: 'pieces', netWeightKg: 'net weight (kg)', grossWeightKg: 'gross weight (kg)' };
  const diffs: string[] = [];
  const evidence: Evidence[] = [];
  for (const key of ['cartons', 'pcs', 'netWeightKg', 'grossWeightKg'] as PlTotalKey[]) {
    const printed = totals[key];
    const vals = lines.map((l) => lineValue(key, l));
    if (!isNum(printed) || !vals.every(isNum)) continue;
    const s = round3((vals as number[]).reduce((a, b) => a + b, 0));
    const tol = key === 'cartons' || key === 'pcs' ? 0 : Math.max(0.05, printed * 0.001);
    if (!approx(s, printed, tol)) {
      diffs.push(`${labels[key]}: lines add up to ${fmtNum(s)} but the grand total reads ${fmtNum(printed)}`);
      evidence.push(evidenceFor(pl.doc, `GRAND TOTAL ${labels[key]} ${fmtNum(printed)}`, `totals.${key}`));
    }
  }
  if (!diffs.length) return undefined;
  return makeIssue({
    code: 'TOTALS_MISMATCH',
    key: `pl:${pl.doc.docId}`,
    severity: 'warning',
    category: 'discrepancy',
    title: 'Packing list totals don\'t add up',
    detail: `Packing list ${pl.data.plNumber ?? pl.doc.fileName}: ${diffs.join('; ')}. A line may be missing or misread (OCR).`,
    evidence,
    action: 'Check the packing list against the original; per-line quantities and weights are used for the entry.',
  });
}

export const totalsRule: Rule = {
  name: 'totals',
  codes: ['TOTALS_MISMATCH'],
  run: (ctx) =>
    [...ctx.invoices.map((inv) => invoiceTotals(ctx, inv)), ...ctx.packingLists.map(packingTotals)].filter((i): i is Issue => !!i),
};
