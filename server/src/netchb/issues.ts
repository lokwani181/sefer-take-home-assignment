/**
 * Small helpers to build Issues consistently (stable ids, evidence from Sourced
 * provenance) for the codes assembly owns.
 */
import type { Evidence, Issue, IssueCategory, IssueCode, IssueSeverity, Sourced } from '@app/shared';

/**
 * Evidence.page value used when the Shipment's provenance does not carry a page
 * number (SourceRef has docId + field only). 0 = "page unknown".
 */
export const UNKNOWN_PAGE = 0;

export interface IssueExtras {
  evidence?: Evidence[];
  field?: string;
  lineId?: string;
  decision?: Issue['decision'];
}

/** Builds an Issue whose id is `${code}` or `${code}:${key}`. */
export function makeIssue(
  code: IssueCode,
  key: string | undefined,
  severity: IssueSeverity,
  category: IssueCategory,
  title: string,
  detail: string,
  action: string,
  extras: IssueExtras = {},
): Issue {
  return {
    id: key ? `${code}:${key}` : code,
    code,
    severity,
    category,
    title,
    detail,
    evidence: extras.evidence ?? [],
    action,
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.lineId ? { lineId: extras.lineId } : {}),
    ...(extras.decision ? { decision: extras.decision } : {}),
  };
}

/** Evidence entries pointing at the documents a Sourced value came from. */
export function evidenceOf(sourced: Sourced<unknown> | undefined, text: string): Evidence[] {
  if (!sourced || !text) return [];
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const s of sourced.sources) {
    if (seen.has(s.docId)) continue;
    seen.add(s.docId);
    out.push({ docId: s.docId, page: UNKNOWN_PAGE, text });
  }
  return out;
}

/** Evidence for a value read from one known document. */
export function evidenceDoc(docId: string | undefined, text: string): Evidence[] {
  return docId && text ? [{ docId, page: UNKNOWN_PAGE, text }] : [];
}

/** Collects issues, keeping the last one for a duplicate id. */
export class IssueBag {
  private readonly byId = new Map<string, Issue>();
  add(issue: Issue): void {
    this.byId.set(issue.id, issue);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  get(id: string): Issue | undefined {
    return this.byId.get(id);
  }
  list(): Issue[] {
    return [...this.byId.values()];
  }
}
