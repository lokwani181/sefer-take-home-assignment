/** Issue construction + evidence lookup (page/bbox from fieldMeta or observations when available). */
import type { Decision, Evidence, ExtractedDocument, Issue, IssueCategory, IssueCode, IssueSeverity } from '@app/shared';
import { truncate } from './text';

export interface IssueInit {
  code: IssueCode;
  /** Appended as `${code}:${key}`; a lineId or another stable key. */
  key?: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  detail: string;
  evidence?: Evidence[];
  action: string;
  field?: string;
  lineId?: string;
  decision?: Decision;
}

/** Build an Issue with the stable id convention `CODE` or `CODE:key`. */
export function makeIssue(init: IssueInit): Issue {
  const issue: Issue = {
    id: init.key ? `${init.code}:${init.key}` : init.code,
    code: init.code,
    severity: init.severity,
    category: init.category,
    title: init.title,
    detail: init.detail,
    evidence: (init.evidence ?? []).filter((e) => e.text),
    action: init.action,
  };
  if (init.field) issue.field = init.field;
  if (init.lineId) issue.lineId = init.lineId;
  if (init.decision) issue.decision = init.decision;
  return issue;
}

/** Read a JSON path like "lines[1].netWeightPerCartonKg" or "containers[0].number" from an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = (cur as Record<string, unknown> | undefined)?.[m[1]];
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) cur = (cur as unknown[] | undefined)?.[Number(idx[1])];
    if (cur === undefined || cur === null) return cur ?? undefined;
  }
  return cur;
}

const pathPrefixes = (path: string): string[] => {
  const out: string[] = [path];
  let p = path;
  while (/[.[]/.test(p)) {
    p = p.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
    if (!p || out.includes(p)) break;
    out.push(p);
  }
  return out;
};

/** Fields printed after the line table (totals, charges, notes) default to the last page. */
const END_OF_DOC = /^(totals|charges|notes|assists|totalPackages|packingTotals|remarks|shippingMarks)\b/;

/**
 * Page of a field: fieldMeta evidence, else an observation on the field (or its parent), else the
 * last page for end-of-document sections, else 1.
 */
export function pageOf(doc: ExtractedDocument, path?: string): number {
  if (path) {
    for (const p of pathPrefixes(path)) {
      const fm = doc.fieldMeta?.[p]?.evidence;
      if (fm?.page) return fm.page;
      const obs = doc.observations?.find((o) => o.field === p && o.page);
      if (obs?.page) return obs.page;
    }
    if (END_OF_DOC.test(path)) return Math.max(1, doc.pageCount || 1);
  }
  return 1;
}

/**
 * Evidence for a document field. Uses the parser's verbatim evidence (with bbox) when it recorded
 * one, otherwise the supplied text with the best-known page.
 */
export function evidenceFor(doc: ExtractedDocument, text: string, path?: string): Evidence {
  const fm = path ? doc.fieldMeta?.[path]?.evidence : undefined;
  if (fm?.text) return { docId: doc.docId, page: fm.page || pageOf(doc, path), text: truncate(fm.text), ...(fm.bbox ? { bbox: fm.bbox } : {}) };
  return { docId: doc.docId, page: pageOf(doc, path), text: truncate(text), ...(fm?.bbox ? { bbox: fm.bbox } : {}) };
}

/**
 * Lowest fieldMeta confidence among the given paths and their children ("packages" also covers
 * "packages.count"); undefined when none is recorded.
 */
export function confOf(doc: ExtractedDocument, ...paths: string[]): number | undefined {
  const confs: number[] = [];
  for (const [key, meta] of Object.entries(doc.fieldMeta ?? {})) {
    if (typeof meta?.conf !== 'number') continue;
    if (paths.some((p) => key === p || key.startsWith(`${p}.`) || key.startsWith(`${p}[`))) confs.push(meta.conf);
  }
  return confs.length ? Math.min(...confs) : undefined;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { blocker: 0, warning: 1, info: 2 };

/** Dedupe by id (first wins) and order blockers → warnings → info, stable within a severity. */
export function finalizeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const i of issues) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out
    .map((issue, idx) => ({ issue, idx }))
    .sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] || a.idx - b.idx)
    .map((x) => x.issue);
}
