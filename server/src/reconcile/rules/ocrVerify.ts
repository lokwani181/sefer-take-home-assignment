/**
 * OCR_VERIFY (one per document): fields read with low confidence (< 70) or repaired by the parser,
 * plus handwritten / struck-through / low-confidence observations. The broker should check them
 * against the original.
 */
import type { Evidence, ExtractedDocument, Issue } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, getPath, makeIssue } from '../lib/issues';
import { truncate } from '../lib/text';

export const OCR_CONF_THRESHOLD = 70;

function valueText(doc: ExtractedDocument, path: string): string {
  const v = getPath(doc.data, path);
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return truncate(JSON.stringify(v), 60);
  return String(v);
}

export function ocrVerifyIssue(doc: ExtractedDocument): Issue | undefined {
  const fields = Object.entries(doc.fieldMeta ?? {})
    .filter(([, m]) => m && (m.repaired || (typeof m.conf === 'number' && m.conf < OCR_CONF_THRESHOLD)))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  // Handwriting/strike-through always; low-confidence/repair notes only when fieldMeta doesn't already list the field.
  const covered = new Set(fields.map(([p]) => p));
  const obs = (doc.observations ?? []).filter(
    (o) => o.kind === 'handwritten' || o.kind === 'strikethrough' || ((o.kind === 'low_confidence' || o.kind === 'ocr_repair') && !(o.field && covered.has(o.field))),
  );
  if (!fields.length && !obs.length) return undefined;

  const items = fields.map(([path, m]) => {
    const v = valueText(doc, path);
    const bits = [`conf ${m.conf}`];
    if (m.repaired) bits.push(`repaired${m.originalText !== undefined ? ` from "${m.originalText}"` : ''}`);
    return `${path}${v ? ` = ${v}` : ''} (${bits.join(', ')})`;
  });
  const obsText = obs.map((o) => `${o.kind}: ${o.text.trim().replace(/[.;]+$/, '')}`);
  const evidence: Evidence[] = [
    ...fields.map(([path, m]) => evidenceFor(doc, m.evidence?.text || `${path}: ${valueText(doc, path) || m.originalText || ''}`, path)),
    ...obs.map((o) => ({ docId: doc.docId, page: o.page ?? 1, text: truncate(o.text) })),
  ];
  const n = fields.length + obsText.length;
  return makeIssue({
    code: 'OCR_VERIFY',
    key: doc.docId,
    severity: 'warning',
    category: 'ocr',
    title: `Verify ${n} OCR reading${n === 1 ? '' : 's'} on ${doc.fileName}`,
    detail: `${[...items, ...obsText].join('; ')}.`,
    evidence,
    action: `Check these fields against the original ${doc.fileName} (scan quality, handwriting or corrections) and fix any misreads before filing.`,
  });
}

export const ocrVerifyRule: Rule = {
  name: 'ocr-verify',
  codes: ['OCR_VERIFY'],
  run: (ctx) => ctx.docs.map(ocrVerifyIssue).filter((i): i is Issue => !!i),
};
