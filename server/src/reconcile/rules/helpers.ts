/** Formatting + evidence helpers shared by rules. */
import type { Evidence, PrintedTotal } from '@app/shared';
import type { InvoiceSource, LineLink, PlLineRef } from '../context';
import { evidenceFor } from '../lib/issues';
import { fmtMoney, fmtNum, isNum } from '../lib/num';
import { clean } from '../lib/text';

/** "Line 2 (AB-123)" */
export const lineName = (link: LineLink): string =>
  link.line.styleNo ? `Line ${link.line.invoiceLineNo} (${link.line.styleNo})` : `Line ${link.line.invoiceLineNo}`;

/** "line 2 (AB-123)" for use mid-sentence. */
export const lineNameLc = (link: LineLink): string => lineName(link).replace(/^Line/, 'line');

/** Money in the line's invoice currency. */
export const money = (link: LineLink, n: number): string => fmtMoney(n, link.inv.invoice.currency);

/** Quantity with unit: "1,200 PCS". */
export const qtyText = (n: number, unit: string): string => `${fmtNum(n)} ${unit || 'units'}`.trim();

/** Evidence quoting an invoice line's printed figures. */
export function invoiceLineEvidence(link: LineLink, field = 'amount'): Evidence {
  const li = link.invLine;
  const parts = [
    li.lineNo,
    li.styleNo,
    li.description,
    li.hsCode,
    isNum(li.quantity) ? fmtNum(li.quantity) : undefined,
    li.unit,
    isNum(li.unitPrice) ? li.unitPrice.toFixed(2) : undefined,
    isNum(li.amount) ? fmtNum(li.amount, 2) : undefined,
  ].filter((x) => x !== undefined && x !== '');
  return evidenceFor(link.inv.doc, parts.join(' '), `lines[${link.index}].${field}`);
}

/** Evidence quoting a packing-list line. */
export function plLineEvidence(ref: PlLineRef, field?: string, extra?: string): Evidence {
  const l = ref.line;
  const parts = [
    l.cartonRange,
    l.styleNo,
    l.description,
    extra ?? l.details?.[0],
    isNum(l.cartons) ? `${l.cartons} ctns` : undefined,
    isNum(l.pcsPerCarton) ? `× ${l.pcsPerCarton}` : undefined,
    isNum(l.totalPcs) ? `= ${fmtNum(l.totalPcs)} pcs` : undefined,
  ].filter(Boolean);
  return evidenceFor(ref.pl.doc, parts.join(' '), `lines[${ref.index}]${field ? `.${field}` : ''}`);
}

/** Evidence for a printed invoice total; carried-forward sub-totals sit before the last page. */
export function totalEvidence(inv: InvoiceSource, total: PrintedTotal): Evidence {
  const idx = (inv.data.totals ?? []).indexOf(total);
  const path = idx >= 0 ? `totals[${idx}]` : undefined;
  const ev = evidenceFor(inv.doc, `${total.label}: ${fmtMoney(total.amount, inv.invoice.currency)}`, path);
  const known = path && (inv.doc.fieldMeta?.[path]?.evidence || inv.doc.observations?.some((o) => o.field === path));
  if (!known) {
    const last = Math.max(1, inv.doc.pageCount || 1);
    ev.page = /carried forward|\bc\/f\b/i.test(total.label) ? Math.max(1, last - 1) : last;
  }
  return ev;
}

/** Line detail rows matching a pattern (e.g. "(Origin: Bangladesh)"). */
export const detailsMatching = (link: LineLink, re: RegExp): string[] =>
  [link.invLine.description, ...(link.invLine.details ?? [])].filter((d) => d && re.test(d)).map(clean);

/** "a, b and c" */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
