/** Sourced<T> construction with provenance + fieldMeta confidence. */
import type { ExtractedDocument, SourceRef, SourceStatus, Sourced } from '@app/shared';
import { confOf } from '../lib/issues';

export const refOf = (doc: ExtractedDocument, field?: string): SourceRef =>
  field ? { docId: doc.docId, docType: doc.docType, field } : { docId: doc.docId, docType: doc.docType };

/** Wrap a value with its sources; conf = lowest fieldMeta confidence among the source paths. */
export function sourced<T>(value: T, status: SourceStatus, doc: ExtractedDocument | undefined, fields: string[] = [], note?: string): Sourced<T> {
  const out: Sourced<T> = { value, status, sources: doc ? (fields.length ? fields.map((f) => refOf(doc, f)) : [refOf(doc)]) : [] };
  const conf = doc ? confOf(doc, ...fields) : undefined;
  if (conf !== undefined) out.conf = conf;
  if (note) out.note = note;
  return out;
}

/** Combine several sources into one Sourced value (e.g. a sum over packing-list lines). */
export function sourcedMulti<T>(value: T, status: SourceStatus, refs: { doc: ExtractedDocument; field: string }[], note?: string): Sourced<T> {
  const confs = refs.map((r) => confOf(r.doc, r.field)).filter((c): c is number => c !== undefined);
  const out: Sourced<T> = { value, status, sources: refs.map((r) => refOf(r.doc, r.field)) };
  if (confs.length) out.conf = Math.min(...confs);
  if (note) out.note = note;
  return out;
}
