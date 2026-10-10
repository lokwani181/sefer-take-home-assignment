/**
 * Apportion invoice assists (buyer-supplied materials) to lines: by style reference, else lines whose
 * text points to buyer-supplied/CMT pricing, else all commercial lines. Several targets share the
 * value by quantity (same unit) or by amount.
 */
import type { Assist } from '@app/shared';
import type { AssistAllocation, LineLink, ReconcileContext } from '../context';
import { round2 } from '../lib/num';
import { normKey } from '../lib/text';

/** Line text that signals buyer-supplied materials or a CMT-only price. */
export const BUYER_MATERIAL_RE = /\bC\.?M\.?T\.?\b|cut,? make (?:and|&) trim|buyer[- ](?:supplied|provided|furnished|fabric|material)|(?:supplied|provided|furnished) by (?:the )?buyer|consigned (?:fabric|material)/i;

function lineText(link: LineLink): string {
  return [link.invLine.description, ...(link.invLine.details ?? []), ...link.pl.flatMap((r) => [r.line.description, ...(r.line.details ?? [])])].join(' \n ');
}

function targetsFor(assist: Assist, lines: LineLink[]): { basis: AssistAllocation['basis']; targets: LineLink[] } {
  const refs = (assist.styleRefs ?? []).map(normKey).filter((k) => k.length >= 3);
  if (refs.length) {
    const exact = lines.filter((l) => refs.includes(normKey(l.line.styleNo)));
    if (exact.length) return { basis: 'style', targets: exact };
    const partial = lines.filter((l) => {
      const k = normKey(l.line.styleNo);
      return k.length >= 4 && refs.some((r) => r.includes(k) || k.includes(r));
    });
    if (partial.length) return { basis: 'style', targets: partial };
  }
  const flagged = lines.filter((l) => BUYER_MATERIAL_RE.test(lineText(l)));
  if (flagged.length) return { basis: 'line_text', targets: flagged };
  return { basis: 'all_lines', targets: lines.filter((l) => !l.line.noCommercialValue) };
}

function split(value: number, targets: LineLink[]): { split: AssistAllocation['split']; shares: number[] } {
  if (targets.length === 1) return { split: 'single', shares: [value] };
  const sameUnit = new Set(targets.map((t) => t.line.unit)).size === 1 && targets.every((t) => t.line.quantity.value > 0);
  const weights = sameUnit ? targets.map((t) => t.line.quantity.value) : targets.map((t) => Math.max(0, t.line.amount.value));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return { split: 'amount', shares: targets.map((_, i) => (i === 0 ? value : 0)) };
  const shares = weights.map((w) => round2((value * w) / total));
  shares[shares.length - 1] = round2(value - shares.slice(0, -1).reduce((a, b) => a + b, 0));
  return { split: sameUnit ? 'quantity' : 'amount', shares };
}

/** Attach apportioned assists to line.assists and return the allocation record. */
export function allocateAssists(ctx: ReconcileContext): AssistAllocation[] {
  const out: AssistAllocation[] = [];
  for (const inv of ctx.invoices) {
    const lines = ctx.links.filter((l) => l.inv === inv);
    (inv.data.assists ?? []).forEach((assist, index) => {
      if (!(assist?.value > 0) || !lines.length) return;
      const { basis, targets } = targetsFor(assist, lines);
      if (!targets.length) return;
      const s = split(assist.value, targets);
      const shares = targets.map((t, i) => ({ lineId: t.line.id, value: s.shares[i] }));
      targets.forEach((t, i) => t.line.assists.push({ ...assist, value: s.shares[i] }));
      out.push({ inv, index, assist, basis, split: s.split, shares });
    });
  }
  return out;
}
