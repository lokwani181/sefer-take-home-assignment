/**
 * ASSIST: buyer-supplied materials (fabric, trims, tooling) are part of dutiable value
 * (19 USC 1401a(b)(1)(C) and (h)(1)(A)). Explains the value and how it was apportioned to each line;
 * also flags lines priced CMT / "buyer fabric" where no assist value is stated.
 */
import type { Issue } from '@app/shared';
import type { AssistAllocation, LineLink, ReconcileContext, Rule } from '../context';
import { linePath } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { fmtMoney, round2 } from '../lib/num';
import { clean } from '../lib/text';
import { BUYER_MATERIAL_RE } from '../merge/assists';
import { invoiceLineEvidence, lineName, lineNameLc, listText, money } from './helpers';

const LAW = 'The value of materials supplied free or at reduced cost by the buyer for use in producing the goods must be added to the price actually paid (19 USC 1401a(b)(1)(C) and (h)(1)(A)).';

function apportionText(ctx: ReconcileContext, a: AssistAllocation, link: LineLink, share: number): string {
  const others = a.shares.filter((s) => s.lineId !== link.line.id).map((s) => ctx.linkById.get(s.lineId)).filter((l): l is LineLink => !!l);
  const cur = link.inv.invoice.currency;
  if (a.split === 'single') {
    const why = a.basis === 'style' ? `the only line for style ${listText(a.assist.styleRefs)}` : a.basis === 'line_text' ? 'the only line priced as CMT / buyer-supplied material' : 'the only commercial line';
    return `The whole ${fmtMoney(share, cur)} is added to this line, ${why}.`;
  }
  const how = a.split === 'quantity' ? 'in proportion to quantity' : 'in proportion to line value';
  const which = a.basis === 'all_lines' ? 'No style is referenced, so it is spread over all commercial lines' : `It is shared with ${listText(others.map(lineNameLc))}`;
  return `${which} ${how}: ${fmtMoney(share, cur)} to this line (assumption).`;
}

function allocationIssues(ctx: ReconcileContext): Issue[] {
  // One issue per line, listing every assist apportioned to it.
  const byLine = new Map<string, { a: AssistAllocation; value: number }[]>();
  for (const a of ctx.assistAllocations) for (const s of a.shares) byLine.set(s.lineId, [...(byLine.get(s.lineId) ?? []), { a, value: s.value }]);
  const out: Issue[] = [];
  for (const [lineId, items] of byLine) {
    const link = ctx.linkById.get(lineId);
    if (!link) continue;
    const cur = link.inv.invoice.currency;
    const base = link.line.amount.value;
    const added = round2(items.reduce((sum, x) => sum + x.value, 0));
    const parts = items.map(({ a, value }) => {
      const assistCur = a.assist.currency?.toUpperCase();
      return (
        `${clean(a.assist.description)}${a.assist.reference ? ` (ref. ${a.assist.reference})` : ''}: value ${fmtMoney(a.assist.value, assistCur ?? cur)}, not included in the invoice price. ${apportionText(ctx, a, link, value)}` +
        (assistCur && assistCur !== cur ? ` The assist is stated in ${assistCur} while the invoice is in ${cur}; convert at the entry exchange rate.` : '')
      );
    });
    const evidence = items.map(({ a }) => {
      const note = a.inv.data.notes?.findIndex((n) => !!a.assist.reference && n.includes(a.assist.reference)) ?? -1;
      return note >= 0
        ? evidenceFor(a.inv.doc, a.inv.data.notes[note] ?? '', `notes[${note}]`)
        : evidenceFor(a.inv.doc, `${a.assist.description} ${fmtMoney(a.assist.value, a.assist.currency ?? cur)}`, `assists[${a.index}]`);
    });
    out.push(
      makeIssue({
        code: 'ASSIST',
        key: lineId,
        severity: 'warning',
        category: 'valuation',
        title: `${lineName(link)}: buyer-supplied materials (assist) ${money(link, added)} added to value`,
        detail: `${parts.join(' ')} ${LAW} Entered value: ${money(link, base)} + ${money(link, added)} = ${money(link, round2(base + added))}.`,
        evidence: [...evidence, invoiceLineEvidence(link)],
        action: 'Confirm the assist value (cost of acquisition plus transport to the factory) and that it relates only to the goods on this entry; if the materials cover several shipments, apportion per 19 CFR 152.103(e). Keep the buyer\'s purchase order for the materials on file.',
        field: linePath(link, 'assists'),
        lineId,
      }),
    );
  }
  return out;
}

/** Lines that look like they used buyer materials but have no assist value. */
function unvaluedIssues(ctx: ReconcileContext): Issue[] {
  const out: Issue[] = [];
  for (const link of ctx.links) {
    if (link.line.assists.length) continue;
    const texts = [link.invLine.description, ...(link.invLine.details ?? []), ...link.pl.flatMap((r) => [r.line.description, ...(r.line.details ?? [])])];
    const hit = texts.find((t) => t && BUYER_MATERIAL_RE.test(t));
    if (!hit) continue;
    out.push(
      makeIssue({
        code: 'ASSIST',
        key: link.line.id,
        severity: 'warning',
        category: 'valuation',
        title: `${lineName(link)}: possible assist with no stated value`,
        detail: `${lineName(link)} reads "${clean(hit)}", which indicates the buyer supplied materials or the price covers cutting/making only, but no assist value is stated on the invoice. ${LAW}`,
        evidence: [invoiceLineEvidence(link)],
        action: 'Ask the importer for the value of any materials, components or tooling it supplied for this style and add it to the line value.',
        field: linePath(link, 'assists'),
        lineId: link.line.id,
      }),
    );
  }
  return out;
}

export const assistRule: Rule = {
  name: 'assist',
  codes: ['ASSIST'],
  run: (ctx) => [...allocationIssues(ctx), ...unvaluedIssues(ctx)],
};
