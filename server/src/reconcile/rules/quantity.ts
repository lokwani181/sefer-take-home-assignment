/**
 * QTY_MISMATCH: the invoiced quantity of a style differs from the packed quantity on the packing list
 * (blocker, decision quantity:<lineId>, default = invoice per the conservative-value policy).
 * Also flags packed goods missing from the invoice and invoiced goods missing from the packing list.
 */
import type { Issue } from '@app/shared';
import { DECISION_KEYS } from '@app/shared';
import type { LineLink, ReconcileContext, Rule } from '../context';
import { linePath } from '../context';
import { makeIssue } from '../lib/issues';
import { fmtNum, isNum, pctDiff, round2 } from '../lib/num';
import { piecesPerUnit } from '../lib/units';
import { invoicesFor, plPieces } from '../merge/matchLines';
import { invoiceLineEvidence, lineName, money, plLineEvidence, qtyText, lineNameLc } from './helpers';

/** Invoice-wide vs packing-list-wide piece totals, to point out when they agree by coincidence. */
function grandTotals(ctx: ReconcileContext, link: LineLink): { inv: number[]; pl?: number } {
  const lines = ctx.links.filter((l) => l.inv === link.inv);
  const pcs = (l: LineLink) => (piecesPerUnit(l.line.unit) ?? NaN) * l.line.quantity.value;
  const all = lines.map(pcs);
  const nonNcv = lines.filter((l) => !l.line.noCommercialValue).map(pcs);
  const invTotals = [all, nonNcv].filter((xs) => xs.every(isNum)).map((xs) => xs.reduce((a, b) => a + b, 0));
  const pl = link.pl[0]?.pl.data;
  let plTotal: number | undefined = pl?.totals?.pcs;
  if (!isNum(plTotal) && pl) {
    const xs = (pl.lines ?? []).map(plPieces);
    plTotal = xs.every(isNum) ? (xs as number[]).reduce((a, b) => a + b, 0) : undefined;
  }
  return { inv: [...new Set(invTotals)], pl: plTotal };
}

function lineIssue(ctx: ReconcileContext, link: LineLink): Issue | undefined {
  const factor = piecesPerUnit(link.line.unit);
  if (!link.pl.length || !factor || link.line.quantity.status === 'assumed' || link.line.quantity.status === 'derived') return undefined;
  const pieces = link.pl.map((r) => plPieces(r.line));
  if (!pieces.every(isNum)) return undefined;
  const packedPcs = (pieces as number[]).reduce((a, b) => a + b, 0);
  const invQty = link.line.quantity.value;
  // Compare in pieces; allow for invoice quantities rounded to 2 decimals in dozens.
  if (Math.abs(invQty * factor - packedPcs) < Math.max(0.5, factor * 0.01)) return undefined;
  const packed = round2(packedPcs / factor);

  link.line.packedQuantity = packed;
  const unit = link.line.unit;
  const diff = round2(invQty - packed);
  const price = link.line.unitPrice;
  const packedValue = isNum(price) ? round2(packed * price) : undefined;
  const physical = link.pl
    .filter((r) => isNum(r.line.cartons) && isNum(r.line.pcsPerCarton))
    .map((r) => `${r.line.cartons} ctns × ${r.line.pcsPerCarton} pcs/ctn = ${fmtNum((r.line.cartons as number) * (r.line.pcsPerCarton as number))}`);
  const parts = [
    `${lineName(link)}: invoice ${qtyText(invQty, unit)}, packing list ${qtyText(packed, unit)}${physical.length ? ` (${physical.join('; ')})` : ''}: ${fmtNum(Math.abs(diff))} ${unit} ${diff > 0 ? 'fewer packed than invoiced' : 'more packed than invoiced'} (${fmtNum(round2(pctDiff(packed, invQty)), 1)}%).`,
  ];
  if (packedValue !== undefined) parts.push(`At ${money(link, price as number)}/${unit} the packed quantity is worth ${money(link, packedValue)} vs ${money(link, link.line.amount.value)} invoiced.`);
  const g = grandTotals(ctx, link);
  if (isNum(g.pl) && g.inv.includes(g.pl)) {
    parts.push(`The documents' overall totals coincidentally agree (${fmtNum(g.pl)} pieces), which hides this per-style difference.`);
  }
  parts.push('Per the decision policy the invoice quantity and value are kept until the difference is explained.');

  return makeIssue({
    code: 'QTY_MISMATCH',
    key: link.line.id,
    severity: 'blocker',
    category: 'discrepancy',
    title: `${lineName(link)}: invoiced ${fmtNum(invQty)} vs packed ${fmtNum(packed)} ${unit}`,
    detail: parts.join(' '),
    evidence: [invoiceLineEvidence(link, 'quantity'), ...link.pl.map((r) => plLineEvidence(r, 'totalPcs'))],
    action: `Confirm with the shipper whether ${fmtNum(Math.abs(diff))} ${unit} were short/over-shipped (request a corrected invoice or credit note) or the packing list is wrong. The entry must declare the quantity actually shipped.`,
    field: linePath(link, 'quantity'),
    lineId: link.line.id,
    decision: {
      key: DECISION_KEYS.quantity(link.line.id),
      question: `Which quantity should be entered for ${lineNameLc(link)}?`,
      options: [
        { value: 'invoice', label: `Invoice quantity ${qtyText(invQty, unit)} (${money(link, link.line.amount.value)})` },
        { value: 'packed', label: `Packed quantity ${qtyText(packed, unit)}${packedValue !== undefined ? ` (${money(link, packedValue)})` : ''}` },
      ],
      chosen: 'invoice',
    },
  });
}

function unmatchedIssues(ctx: ReconcileContext): Issue[] {
  const out: Issue[] = [];
  for (const ref of ctx.unmatchedPl) {
    const pcs = plPieces(ref.line);
    // Only real goods rows: a style number or a piece count (not marks, remarks or sub-headings).
    if (!ref.line.styleNo && !isNum(pcs)) continue;
    out.push(
      makeIssue({
        code: 'QTY_MISMATCH',
        key: `pl:${ref.pl.doc.docId}:line${ref.index + 1}`,
        severity: 'warning',
        category: 'discrepancy',
        title: `Packed goods not found on the invoice: ${ref.line.styleNo ?? ref.line.description}`,
        detail: `Packing list line ${ref.index + 1} (${[ref.line.styleNo, ref.line.description].filter(Boolean).join(' ')}${isNum(pcs) ? `, ${fmtNum(pcs)} pcs` : ''}) matches no invoice line by style or description. Goods in the shipment but not on the invoice would be undeclared.`,
        evidence: [plLineEvidence(ref)],
        action: 'Check whether this style is on another invoice or was omitted; obtain a corrected invoice if the goods were shipped.',
      }),
    );
  }
  for (const pl of ctx.packingLists) {
    if (!(pl.data.lines ?? []).length) continue;
    const invs = new Set(invoicesFor(pl, ctx.invoices));
    // Only when this packing list demonstrably belongs to the invoice (some of its lines matched).
    const matchedInvs = new Set(ctx.links.filter((l) => l.pl.some((r) => r.pl === pl)).map((l) => l.inv));
    for (const link of ctx.links) {
      if (!invs.has(link.inv) || !matchedInvs.has(link.inv) || link.pl.length) continue;
      if (out.some((i) => i.id === `QTY_MISMATCH:${link.line.id}`)) continue;
      out.push(
        makeIssue({
          code: 'QTY_MISMATCH',
          key: link.line.id,
          severity: 'warning',
          category: 'discrepancy',
          title: `${lineName(link)} not found on the packing list`,
          detail: `${lineName(link)} (${qtyText(link.line.quantity.value, link.line.unit)}) matches no packing-list line by style or description, so the packed quantity can't be confirmed.`,
          evidence: [invoiceLineEvidence(link, 'quantity')],
          action: 'Confirm the style was shipped (check the packing list / carton marks); if it was not, the line must be removed from the entry.',
          field: linePath(link, 'quantity'),
          lineId: link.line.id,
        }),
      );
    }
  }
  return out;
}

export const quantityRule: Rule = {
  name: 'quantity',
  codes: ['QTY_MISMATCH'],
  run: (ctx) => [...ctx.links.map((l) => lineIssue(ctx, l)).filter((i): i is Issue => !!i), ...unmatchedIssues(ctx)],
};
