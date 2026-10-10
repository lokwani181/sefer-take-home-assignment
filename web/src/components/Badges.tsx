import type { IssueSeverity, Sourced, XsdValidation } from '@app/shared';
import { LOW_CONFIDENCE, docTypeLabel, severityLabel, statusLabel } from '../lib/format';

/** Small status chips shared by every tab. Text is always visible (never colour alone) for accessibility. */

export function SeverityBadge({ severity }: { severity: IssueSeverity }) {
  return <span className={`badge badge-${severity}`}>{severityLabel(severity)}</span>;
}

export function VerifyBadge({ conf }: { conf?: number }) {
  return (
    <span className="badge badge-verify" title={conf === undefined ? 'Low confidence' : `Confidence ${Math.round(conf)} / 100`}>
      verify{conf === undefined ? '' : ` · ${Math.round(conf)}`}
    </span>
  );
}

/** Explains where a value came from: one of extracted / derived / corrected / assumed / user. */
export function sourceTooltip(sourced: Sourced<unknown>): string {
  const parts = sourced.sources.map((s) => `${docTypeLabel(s.docType)}${s.field ? ` · ${s.field}` : ''}`);
  const lines = [parts.length ? `Sources: ${parts.join('; ')}` : 'No document source'];
  if (sourced.conf !== undefined) lines.push(`Confidence: ${Math.round(sourced.conf)} / 100`);
  if (sourced.note) lines.push(sourced.note);
  return lines.join('\n');
}

/**
 * Provenance chip for a Sourced value. Plain "extracted" values with good confidence stay quiet
 * unless `showExtracted` is set, so the eye goes to what needs attention.
 */
export function SourceBadges({ sourced, showExtracted = false }: { sourced: Sourced<unknown> | undefined; showExtracted?: boolean }) {
  if (!sourced) return null;
  const lowConf = sourced.conf !== undefined && sourced.conf < LOW_CONFIDENCE;
  const showStatus = showExtracted || sourced.status !== 'extracted';
  if (!showStatus && !lowConf) return null;
  return (
    <span className="badges">
      {showStatus && (
        <span className={`badge badge-status-${sourced.status}`} title={sourceTooltip(sourced)}>
          {statusLabel(sourced.status)}
        </span>
      )}
      {lowConf && <VerifyBadge conf={sourced.conf} />}
    </span>
  );
}

export function XsdBadge({ validation }: { validation: XsdValidation }) {
  return validation.valid ? (
    <span className="badge badge-ok" title="The XML validates against NetCHB entry.xsd">
      ✓ XSD-valid
    </span>
  ) : (
    <span className="badge badge-blocker" title={`${validation.errors.length} schema error(s)`}>
      ✕ XSD-invalid
    </span>
  );
}
