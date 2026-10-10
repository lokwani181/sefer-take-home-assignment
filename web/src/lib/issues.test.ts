import { describe, expect, it } from 'vitest';
import type { Issue } from '@app/shared';
import { mockResult } from '../api/mock-result';
import { countBySeverity, groupIssues } from './issues';

const issue = (id: string, severity: Issue['severity'], category: Issue['category']): Issue => ({
  id,
  code: 'MISSING_FIELD',
  severity,
  category,
  title: id,
  detail: '',
  evidence: [],
  action: '',
});

describe('groupIssues', () => {
  it('orders severities blocker → warning → info and categories by priority, keeping issue order', () => {
    const groups = groupIssues([
      issue('i1', 'info', 'format'),
      issue('w1', 'warning', 'ocr'),
      issue('b1', 'blocker', 'classification'),
      issue('w2', 'warning', 'missing_data'),
      issue('b2', 'blocker', 'missing_data'),
      issue('w3', 'warning', 'ocr'),
      issue('b3', 'blocker', 'missing_data'),
    ]);
    expect(groups.map((g) => g.severity)).toEqual(['blocker', 'warning', 'info']);
    expect(groups.map((g) => g.count)).toEqual([3, 3, 1]);
    expect(groups[0].categories.map((c) => c.category)).toEqual(['missing_data', 'classification']);
    expect(groups[0].categories[0].issues.map((i) => i.id)).toEqual(['b2', 'b3']);
    expect(groups[1].categories.map((c) => [c.category, c.issues.map((i) => i.id)])).toEqual([
      ['missing_data', ['w2']],
      ['ocr', ['w1', 'w3']],
    ]);
  });

  it('omits empty severities', () => {
    const groups = groupIssues([issue('i1', 'info', 'format')]);
    expect(groups.map((g) => g.severity)).toEqual(['info']);
    expect(groupIssues([])).toEqual([]);
  });

  it('groups the sample result with every issue accounted for', () => {
    const groups = groupIssues(mockResult.issues);
    const flattened = groups.flatMap((g) => g.categories.flatMap((c) => c.issues));
    expect(flattened).toHaveLength(mockResult.issues.length);
    expect(new Set(flattened.map((i) => i.id)).size).toBe(mockResult.issues.length);
    expect(groups[0].severity).toBe('blocker');
    expect(groups[0].categories[0].category).toBe('missing_data');
    expect(groups[0].categories.flatMap((c) => c.issues.map((i) => i.code)).sort()).toEqual(
      ['COMPOSITION_CONFLICT', 'MISSING_BOND', 'MISSING_IMPORTER_ID', 'MISSING_SURETY', 'QTY_MISMATCH'].sort(),
    );
  });
});

describe('countBySeverity', () => {
  it('counts each severity, including zeros', () => {
    expect(countBySeverity([])).toEqual({ blocker: 0, warning: 0, info: 0 });
    expect(countBySeverity(mockResult.issues)).toEqual({ blocker: 5, warning: 15, info: 11 });
  });
});
