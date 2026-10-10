/**
 * PACKAGE_COUNT_MISMATCH: invoice, packing list and transport document disagree on the number of
 * packages. Counts are compared only between compatible package kinds (cartons vs pallets aren't).
 */
import type { Evidence, Issue } from '@app/shared';
import type { ReconcileContext, Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { fmtNum, isNum } from '../lib/num';
import { packageKind, packageKindsComparable } from '../lib/units';

interface Count {
  who: string;
  count: number;
  unit: string;
  ev: Evidence;
}

/** Package count per document family (summed over several invoices / packing lists). */
export function packageCounts(ctx: ReconcileContext): Count[] {
  const out: Count[] = [];
  const invCounts = ctx.invoices.map((i) => {
    const tp = i.data.totalPackages;
    if (tp && isNum(tp.count)) return { count: tp.count, unit: tp.unit, ev: evidenceFor(i.doc, `Total Packages: ${fmtNum(tp.count)} ${tp.unit}`, 'totalPackages') };
    const c = i.data.packingTotals?.cartons;
    if (isNum(c)) return { count: c, unit: 'CARTONS', ev: evidenceFor(i.doc, `Total cartons: ${fmtNum(c)}`, 'packingTotals.cartons') };
    return undefined;
  });
  if (invCounts.length && invCounts.every(Boolean)) {
    const xs = invCounts as NonNullable<(typeof invCounts)[number]>[];
    out.push({ who: 'invoice', count: xs.reduce((s, x) => s + x.count, 0), unit: xs[0].unit, ev: xs[0].ev });
  }
  const plCounts = ctx.packingLists.map((p) => {
    if (isNum(p.data.totals?.cartons)) return { count: p.data.totals.cartons as number, ev: evidenceFor(p.doc, `GRAND TOTAL ${fmtNum(p.data.totals.cartons as number)} cartons`, 'totals.cartons') };
    const ls = p.data.lines ?? [];
    if (ls.length && ls.every((l) => isNum(l.cartons))) {
      const n = ls.reduce((s, l) => s + (l.cartons as number), 0);
      return { count: n, ev: evidenceFor(p.doc, `Sum of carton counts: ${fmtNum(n)}`, 'lines') };
    }
    return undefined;
  });
  if (plCounts.length && plCounts.every(Boolean)) {
    const xs = plCounts as NonNullable<(typeof plCounts)[number]>[];
    out.push({ who: 'packing list', count: xs.reduce((s, x) => s + x.count, 0), unit: 'CARTONS', ev: xs[0].ev });
  }
  const t = ctx.transport;
  if (t?.kind === 'bl' && t.src.data.packages && isNum(t.src.data.packages.count)) {
    const p = t.src.data.packages;
    out.push({ who: t.src.arrivalNotice ? 'arrival notice' : 'bill of lading', count: p.count, unit: p.unit, ev: evidenceFor(t.src.doc, `No. of Pkgs: ${fmtNum(p.count)} ${p.unit}`, 'packages') });
  } else if (t?.kind === 'awb' && isNum(t.src.data.pieces)) {
    out.push({ who: 'air waybill', count: t.src.data.pieces, unit: 'PIECES', ev: evidenceFor(t.src.doc, `No. of pieces: ${fmtNum(t.src.data.pieces)}`, 'pieces') });
  }
  return out;
}

export const packageCountRule: Rule = {
  name: 'package-count',
  codes: ['PACKAGE_COUNT_MISMATCH'],
  run(ctx) {
    const counts = packageCounts(ctx);
    let conflict = false;
    for (let i = 0; i < counts.length; i++) {
      for (let j = i + 1; j < counts.length; j++) {
        const a = counts[i];
        const b = counts[j];
        if (packageKindsComparable(packageKind(a.unit), packageKind(b.unit)) && a.count !== b.count) conflict = true;
      }
    }
    if (!conflict) return [];
    const issue: Issue = makeIssue({
      code: 'PACKAGE_COUNT_MISMATCH',
      severity: 'warning',
      category: 'discrepancy',
      title: 'Package counts differ between documents',
      detail: `${counts.map((c) => `${c.who}: ${fmtNum(c.count)} ${c.unit}`).join('; ')}. The manifest quantity (transport document) is reported on the entry and must match the cargo presented.`,
      evidence: counts.map((c) => c.ev),
      action: 'Confirm the piece count with the carrier/CFS (tally or arrival notice) and get the wrong document corrected; a count discrepancy can hold the cargo at release.',
      field: 'packages',
    });
    return [issue];
  },
};
