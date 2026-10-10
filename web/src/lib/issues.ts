import type { Issue, IssueCategory, IssueSeverity } from '@app/shared';

/** Display order: what blocks filing first, then what needs checking, then FYI. */
export const SEVERITY_ORDER: readonly IssueSeverity[] = ['blocker', 'warning', 'info'];

/** Category order within a severity: concrete gaps and conflicts before advisories. */
export const CATEGORY_ORDER: readonly IssueCategory[] = [
  'missing_data',
  'discrepancy',
  'valuation',
  'classification',
  'compliance',
  'ocr',
  'format',
  'assumption',
];

export interface CategoryGroup {
  category: IssueCategory;
  issues: Issue[];
}

export interface SeverityGroup {
  severity: IssueSeverity;
  count: number;
  categories: CategoryGroup[];
}

export type SeverityCounts = Record<IssueSeverity, number>;

export function countBySeverity(issues: Issue[]): SeverityCounts {
  const counts: SeverityCounts = { blocker: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  return counts;
}

const rank = <T>(order: readonly T[], value: T) => {
  const i = order.indexOf(value);
  return i === -1 ? order.length : i;
};

/**
 * Groups issues by severity (blockers first), then by category in CATEGORY_ORDER.
 * Unknown categories sort last; issue order inside a category is preserved. Empty groups are omitted.
 */
export function groupIssues(issues: Issue[]): SeverityGroup[] {
  const groups: SeverityGroup[] = [];
  for (const severity of SEVERITY_ORDER) {
    const ofSeverity = issues.filter((issue) => issue.severity === severity);
    if (ofSeverity.length === 0) continue;
    const byCategory = new Map<IssueCategory, Issue[]>();
    for (const issue of ofSeverity) {
      const list = byCategory.get(issue.category) ?? [];
      list.push(issue);
      byCategory.set(issue.category, list);
    }
    const categories = [...byCategory.entries()]
      .sort(([a], [b]) => rank(CATEGORY_ORDER, a) - rank(CATEGORY_ORDER, b) || a.localeCompare(b))
      .map(([category, list]) => ({ category, issues: list }));
    groups.push({ severity, count: ofSeverity.length, categories });
  }
  return groups;
}
