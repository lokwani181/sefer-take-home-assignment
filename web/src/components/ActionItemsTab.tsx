import type { ApiError, Issue, PipelineResult } from '@app/shared';
import { categoryLabel, severityLabel } from '../lib/format';
import { countBySeverity, groupIssues } from '../lib/issues';
import { ErrorBanner } from './ErrorBanner';
import { IssueCard } from './IssueCard';

interface ActionItemsTabProps {
  result: PipelineResult;
  decisions: Record<string, string>;
  recommended: Record<string, string>;
  onDecisionChange(key: string, value: string): void;
  regenerating: boolean;
  regenerateError: ApiError | null;
  onDismissRegenerateError(): void;
}

/** Action items grouped by severity (blockers first) and category, with inline decisions. */
export function ActionItemsTab({
  result,
  decisions,
  recommended,
  onDecisionChange,
  regenerating,
  regenerateError,
  onDismissRegenerateError,
}: ActionItemsTabProps) {
  const groups = groupIssues(result.issues);
  const counts = countBySeverity(result.issues);
  const docNames = new Map(result.documents.map((d) => [d.docId, d.fileName]));
  const decisionCount = result.issues.filter((i: Issue) => i.decision).length;

  return (
    <div className="action-items" aria-busy={regenerating}>
      <div className="tab-intro">
        <p>
          {counts.blocker > 0 ? (
            <>
              <strong>{counts.blocker} blocker{counts.blocker === 1 ? '' : 's'}</strong> must be resolved before this entry can be filed.
            </>
          ) : (
            <strong>No blockers.</strong>
          )}{' '}
          {decisionCount > 0 && `${decisionCount} item${decisionCount === 1 ? ' has a choice' : 's have choices'}; changing one regenerates the entry.`}
        </p>
        <span className={`regen-status${regenerating ? ' is-active' : ''}`} role="status">
          {regenerating ? 'Regenerating entry…' : ''}
        </span>
      </div>

      {regenerateError && <ErrorBanner error={regenerateError} title="Regeneration failed" onDismiss={onDismissRegenerateError} />}

      {groups.length === 0 && <p className="empty">No action items. Review the entry XML before filing.</p>}

      {groups.map((group) => (
        <section key={group.severity} className={`severity-group severity-${group.severity}`} aria-labelledby={`sev-${group.severity}`}>
          <h3 id={`sev-${group.severity}`} className="severity-heading">
            {severityLabel(group.severity, true)} <span className="count-pill">{group.count}</span>
          </h3>
          {group.categories.map((cat) => (
            <div key={cat.category} className="category-group">
              <h4 className="category-heading">
                {categoryLabel(cat.category)} <span className="muted">({cat.issues.length})</span>
              </h4>
              <div className="issue-list">
                {cat.issues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    docNames={docNames}
                    chosen={issue.decision ? (decisions[issue.decision.key] ?? issue.decision.chosen) : undefined}
                    recommended={issue.decision ? recommended[issue.decision.key] : undefined}
                    onDecisionChange={onDecisionChange}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
