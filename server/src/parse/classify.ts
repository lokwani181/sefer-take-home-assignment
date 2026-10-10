/**
 * Document classification: title phrases on page 1 first, body keyword signals as backup.
 *
 * Why: the pipeline routes each upload to the right parser; graders upload documents with
 * different wording, so titles and content signals come from vocab.ts and the score is
 * explainable (title strength + share of matched signals).
 */
import type { DocType, DocumentLayout } from '@app/shared';
import { prepareLayout, type PDoc } from './layout';
import { CONTENT_SIGNALS } from './vocab';
import { compactKey } from './text';
import { findTitles } from './docs/common';
import { extractTable } from './table';

export interface Classification {
  docType: DocType;
  /** 0–1 */
  score: number;
  /** Per-type scores (for debugging / UI). */
  scores: Record<string, number>;
}

/** Classifies an already prepared document. */
export function classifyPrepared(doc: PDoc): Classification {
  const text = compactKey(doc.pages.map((p) => p.lines.map((l) => l.text).join(' ')).join(' '));
  const titles = findTitles(doc);
  const scores: Record<string, number> = {};
  const types = ['commercial_invoice', 'packing_list', 'bill_of_lading', 'air_waybill', 'arrival_notice'] as const;
  for (const t of types) {
    const signals = CONTENT_SIGNALS[t];
    const hits = signals.filter((s) => text.includes(compactKey(s))).length;
    const content = Math.min(1, hits / 5);
    const title = titles.find((h) => h.type === t)?.strength ?? 0;
    scores[t] = title ? 0.75 * title + 0.25 * content : 0.6 * content;
  }
  const combinedTitle = titles.find((h) => h.type === 'invoice_packing_list');
  if (combinedTitle) scores.invoice_packing_list = 0.75 * combinedTitle.strength + 0.25 * Math.max(scores.commercial_invoice, scores.packing_list) / 1;

  // table evidence: an invoice table that also carries cartons/weights is a combined document
  const best0 = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best0 && (best0[0] === 'commercial_invoice' || best0[0] === 'packing_list')) {
    const table = extractTable(doc, { anchors: ['lineNo', 'style', 'cartonRange', 'description'], minFields: 3 });
    const fields = new Set(table.pages.flatMap((p) => p.columns.map((c) => c.field)));
    const priced = fields.has('unitPrice') || fields.has('amount');
    const packed = (fields.has('cartons') || fields.has('cartonRange') || fields.has('pcsPerCarton')) && (fields.has('netWeight') || fields.has('grossWeight'));
    if (priced && packed) scores.invoice_packing_list = Math.max(scores.invoice_packing_list ?? 0, best0[1]);
    else if (priced) scores.commercial_invoice = Math.min(1, scores.commercial_invoice + 0.1);
    else if (packed) scores.packing_list = Math.min(1, scores.packing_list + 0.1);
  }
  const [bestType, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] ?? ['other', 0];
  if (bestScore < 0.3) return { docType: 'other', score: Math.round((1 - bestScore) * 100) / 100, scores };
  return { docType: bestType as DocType, score: Math.round(Math.min(1, bestScore) * 100) / 100, scores };
}

/** Classifies a document layout by title and content signals. */
export function classifyDocument(layout: DocumentLayout): { docType: DocType; score: number } {
  const { docType, score } = classifyPrepared(prepareLayout(layout));
  return { docType, score };
}
