/**
 * Per-document parse context: collects field confidence/evidence, observations and warnings
 * while the document parsers run, so every parser reports provenance the same way.
 */
import type { FieldMeta, Observation, ObservationKind } from '@app/shared';
import { bboxOf, joinWords, minConf, type PDoc, type PWord } from './layout';

/** Fields with confidence at or above this are not flagged (unless repaired). */
export const CONF_FLAG_THRESHOLD = 90;

export interface MetaOptions {
  /** Override the confidence (default: min word confidence). */
  conf?: number;
  repaired?: boolean;
  originalText?: string;
  /** Record even when confident and not repaired. */
  force?: boolean;
}

export class ParseContext {
  readonly fieldMeta: Record<string, FieldMeta> = {};
  readonly observations: Observation[] = [];
  readonly warnings: string[] = [];
  constructor(readonly doc: PDoc) {}

  /**
   * Records confidence + evidence for a field path when it is worth flagging
   * (OCR confidence below threshold, or a repair was applied).
   */
  meta(path: string, words: readonly PWord[] | undefined, opts: MetaOptions = {}): void {
    const ws = words ?? [];
    const conf = Math.round(opts.conf ?? (ws.length ? minConf(ws) : 100));
    if (!opts.force && !opts.repaired && conf >= CONF_FLAG_THRESHOLD) return;
    const m: FieldMeta = { conf: Math.min(conf, this.fieldMeta[path]?.conf ?? 100) };
    if (opts.repaired) m.repaired = true;
    if (opts.originalText !== undefined) m.originalText = opts.originalText;
    if (ws.length) m.evidence = { docId: this.doc.docId, page: ws[0].page, text: joinWords(ws), bbox: bboxOf(ws) };
    this.fieldMeta[path] = { ...this.fieldMeta[path], ...m };
  }

  observe(kind: ObservationKind, text: string, field?: string, page?: number): void {
    if (this.observations.some((o) => o.kind === kind && o.text === text && o.field === field)) return;
    const o: Observation = { kind, text };
    if (field) o.field = field;
    if (page) o.page = page;
    this.observations.push(o);
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }
}
