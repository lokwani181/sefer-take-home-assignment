import { useId } from 'react';
import type { Issue } from '@app/shared';
import { SeverityBadge } from './Badges';

interface IssueCardProps {
  issue: Issue;
  /** docId → file name, for evidence citations. */
  docNames: Map<string, string>;
  /** Currently selected option for this issue's decision (from broker inputs). */
  chosen?: string;
  /** The app's original recommendation for this decision. */
  recommended?: string;
  onDecisionChange?(key: string, value: string): void;
}

/** "inv0-line2" → "Line 2" (invoice 1 is implied; later invoices are spelled out). */
export function lineLabel(lineId: string): string {
  const m = /^inv(\d+)-line(\d+)$/.exec(lineId);
  if (!m) return lineId;
  return m[1] === '0' ? `Line ${m[2]}` : `Invoice ${Number(m[1]) + 1}, line ${m[2]}`;
}

/** One action item: what is wrong, what to do, the evidence, and (if ambiguous) the broker's choice. */
export function IssueCard({ issue, docNames, chosen, recommended, onDecisionChange }: IssueCardProps) {
  const titleId = useId();
  const decision = issue.decision;
  const selected = decision ? (chosen ?? decision.chosen) : undefined;

  return (
    <article className={`issue issue-${issue.severity}`} aria-labelledby={titleId} data-issue-id={issue.id}>
      <header className="issue-head">
        <SeverityBadge severity={issue.severity} />
        <h4 id={titleId} className="issue-title">
          {issue.title}
        </h4>
        {issue.lineId && <span className="chip">{lineLabel(issue.lineId)}</span>}
        <code className="issue-code" title="Issue code">
          {issue.code}
        </code>
      </header>

      <p className="issue-detail">{issue.detail}</p>

      <div className="issue-action">
        <span className="issue-action-label">What to do</span>
        <p>{issue.action}</p>
      </div>

      {issue.evidence.length > 0 && (
        <ul className="evidence" aria-label="Evidence">
          {issue.evidence.map((ev, i) => (
            <li key={`${ev.docId}-${ev.page}-${i}`}>
              <q>{ev.text}</q>
              <cite>
                {docNames.get(ev.docId) ?? ev.docId}, p. {ev.page}
              </cite>
            </li>
          ))}
        </ul>
      )}

      {decision && (
        <fieldset className="decision">
          <legend>{decision.question}</legend>
          {decision.options.map((option) => {
            const id = `${titleId}-${option.value}`;
            return (
              <div className="radio-row" key={option.value}>
                <input
                  type="radio"
                  id={id}
                  name={`decision-${decision.key}`}
                  value={option.value}
                  checked={selected === option.value}
                  onChange={() => onDecisionChange?.(decision.key, option.value)}
                />
                <label htmlFor={id}>
                  {option.label}
                  {recommended === option.value && <span className="recommended"> (recommended)</span>}
                </label>
              </div>
            );
          })}
        </fieldset>
      )}
    </article>
  );
}
