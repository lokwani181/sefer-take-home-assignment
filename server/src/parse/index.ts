/**
 * Document parsers: DocumentLayout → ExtractedDocument.
 *
 * Deterministic, rule-based and layout-aware: classification by title/content signals,
 * generic primitives (labels, tables, numbers, dates, parties, footnotes), domain
 * extractors (containers, bills, HS, incoterms, composition, ...) and constraint repair.
 */
import type { DocData, DocumentLayout, ExtractedDocument, OtherDocData, ParseFn } from '@app/shared';
import { prepareLayout, type PDoc } from './layout';
import { classifyPrepared } from './classify';
import { ParseContext } from './context';
import { parseInvoice } from './docs/invoice';
import { parsePackingList } from './docs/packingList';
import { parseBillOfLading } from './docs/billOfLading';
import { parseAirWaybill } from './docs/airWaybill';
import { findTitles } from './docs/common';

export { classifyDocument, classifyPrepared } from './classify';
export { compareExtraction, accuracySummary, type FieldComparison } from './accuracy';
export { findLabelValue, findLabelValues, findLabels } from './labels';
export { extractTable, matchColumnField } from './table';
export { parseNumber, detectDecimalSep } from './numbers';
export { parseDate, findDates } from './dates';
export { parseParty } from './party';
export { parseComposition } from './domain/composition';
export { isValidContainerNumber, isoCheckDigit } from './domain/container';
export { prepareLayout } from './layout';

function otherData(doc: PDoc): OtherDocData {
  const text = doc.pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n').slice(0, 2000);
  const title = findTitles(doc)[0]?.line.text ?? doc.pages[0]?.lines[0]?.text;
  const out: OtherDocData = { kind: 'other', text };
  if (title) out.title = title;
  return out;
}

/**
 * Parses one document. Never throws on unexpected layouts: a parser failure is reported in
 * `warnings` and the document is returned as 'other' so the pipeline can continue.
 */
export const parseDocument: ParseFn = (layout: DocumentLayout): ExtractedDocument => {
  const doc = prepareLayout(layout);
  const cls = classifyPrepared(doc);
  let ctx = new ParseContext(doc);
  let docType = cls.docType;
  let data: DocData;
  try {
    switch (docType) {
      case 'commercial_invoice':
        data = parseInvoice(doc, ctx).data;
        break;
      case 'invoice_packing_list':
        data = parseInvoice(doc, ctx, { combined: true }).data;
        break;
      case 'packing_list':
        data = parsePackingList(doc, ctx).data;
        break;
      case 'bill_of_lading':
      case 'arrival_notice':
        data = parseBillOfLading(doc, ctx);
        break;
      case 'air_waybill':
        data = parseAirWaybill(doc, ctx);
        break;
      default:
        data = otherData(doc);
    }
  } catch (err) {
    ctx = new ParseContext(doc);
    ctx.warn(`parser for ${docType} failed: ${(err as Error).message}`);
    docType = 'other';
    data = otherData(doc);
  }
  const sources = new Set(layout.pages.map((p) => p.source));
  return {
    docId: layout.docId,
    fileName: layout.fileName,
    docType,
    classificationScore: cls.score,
    source: sources.size > 1 ? 'mixed' : sources.has('ocr') ? 'ocr' : 'text',
    pageCount: layout.pages.length,
    data,
    fieldMeta: ctx.fieldMeta,
    observations: ctx.observations,
    warnings: ctx.warnings,
  };
};
