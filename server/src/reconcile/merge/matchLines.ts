/**
 * Packing-list line ↔ invoice line matching. Passes, most to least certain:
 * exact normalized style → OCR-folded style → one style containing the other → description
 * similarity (+ quantity agreement). Several PL lines may feed one invoice line (split cartons).
 */
import type { PackingListData } from '@app/shared';
import type { DocSource, InvoiceSource, LineLink, PlLineRef } from '../context';
import { compareCompositions } from '../lib/composition';
import { isNum } from '../lib/num';
import { descTokens, dice, normKey, ocrKey } from '../lib/text';
import { piecesPerUnit } from '../lib/units';

/** Pieces on a PL line: printed total, else cartons × pcs per carton. */
export function plPieces(line: PackingListData['lines'][number]): number | undefined {
  if (isNum(line.totalPcs)) return line.totalPcs;
  if (isNum(line.cartons) && isNum(line.pcsPerCarton)) return line.cartons * line.pcsPerCarton;
  return undefined;
}

function invoicePieces(link: LineLink): number | undefined {
  const f = piecesPerUnit(link.line.unit);
  return f && link.line.quantity.value > 0 ? link.line.quantity.value * f : undefined;
}

/** Description similarity, with a bonus when quantities agree and a small one when compositions agree. */
export function descriptionScore(link: LineLink, ref: PlLineRef): number {
  const a = descTokens(link.invLine.description);
  const b = descTokens(ref.line.description);
  let score = dice(a, b);
  const pcs = plPieces(ref.line);
  if (pcs !== undefined && pcs === invoicePieces(link)) score += 0.25;
  if (link.invLine.composition?.length && ref.line.composition?.length && !compareCompositions(link.invLine.composition, ref.line.composition).conflict) score += 0.1;
  return score;
}

/** Invoices a packing list belongs to: by its invoice references, else all of them. */
export function invoicesFor(pl: DocSource<PackingListData>, invoices: InvoiceSource[]): InvoiceSource[] {
  const refs = new Set((pl.data.invoiceRefs ?? []).map(normKey).filter(Boolean));
  const hit = invoices.filter((i) => refs.has(normKey(i.data.invoiceNumber)));
  return hit.length ? hit : invoices;
}

function pickAmong(cands: LineLink[], ref: PlLineRef): LineLink {
  if (cands.length === 1) return cands[0];
  const pcs = plPieces(ref.line);
  const sameQty = cands.filter((c) => pcs !== undefined && invoicePieces(c) === pcs);
  if (sameQty.length === 1) return sameQty[0];
  const pool = sameQty.length ? sameQty : cands;
  return pool.reduce((best, c) => (descriptionScore(c, ref) > descriptionScore(best, ref) ? c : best), pool[0]);
}

const DESCRIPTION_THRESHOLD = 0.45;

/**
 * Attach packing-list lines to invoice lines (mutates link.pl) and return the PL lines that matched nothing.
 */
export function matchPackingLists(links: LineLink[], invoices: InvoiceSource[], packingLists: DocSource<PackingListData>[]): PlLineRef[] {
  const unmatched: PlLineRef[] = [];
  for (const pl of packingLists) {
    const invs = new Set(invoicesFor(pl, invoices));
    const pool = links.filter((l) => invs.has(l.inv));
    let pending: PlLineRef[] = (pl.data.lines ?? []).map((line, index) => ({ pl, index, line }));

    const stylePass = (key: (s: string | undefined) => string, method: PlLineRef['method'], partial = false) => {
      const rest: PlLineRef[] = [];
      for (const ref of pending) {
        const k = key(ref.line.styleNo);
        if (k.length < 3) {
          rest.push(ref);
          continue;
        }
        const cands = pool.filter((l) => {
          const lk = key(l.line.styleNo);
          if (lk.length < 3) return false;
          return partial ? lk !== k && Math.min(lk.length, k.length) >= 4 && (lk.includes(k) || k.includes(lk)) : lk === k;
        });
        if (!cands.length || (method !== 'style' && cands.length > 1)) {
          rest.push(ref);
          continue;
        }
        const target = pickAmong(cands, ref);
        target.pl.push({ ...ref, method });
      }
      pending = rest;
    };
    stylePass(normKey, 'style');
    stylePass(ocrKey, 'style_ocr');
    stylePass(normKey, 'style_partial', true);

    // Description pass: only invoice lines that have no PL line yet, greedy by best score.
    const free = pool.filter((l) => !l.pl.length);
    const pairs: { link: LineLink; ref: PlLineRef; score: number }[] = [];
    for (const ref of pending) for (const link of free) pairs.push({ link, ref, score: descriptionScore(link, ref) });
    pairs.sort((a, b) => b.score - a.score);
    const usedLinks = new Set<LineLink>();
    const usedRefs = new Set<PlLineRef>();
    for (const p of pairs) {
      if (p.score < DESCRIPTION_THRESHOLD || usedLinks.has(p.link) || usedRefs.has(p.ref)) continue;
      p.link.pl.push({ ...p.ref, method: 'description', score: Math.round(p.score * 100) / 100 });
      usedLinks.add(p.link);
      usedRefs.add(p.ref);
    }
    unmatched.push(...pending.filter((r) => !usedRefs.has(r)));
  }
  return unmatched;
}
