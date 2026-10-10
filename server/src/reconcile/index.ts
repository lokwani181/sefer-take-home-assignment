/**
 * Reconciliation (T3): ExtractedDocument[] → Shipment + Issues.
 *
 *   buildContext   merge every document into a draft Shipment with Sourced provenance and
 *                  invoice-line ↔ packing-list links
 *   RULES          cross-document checks, each one file in rules/, which emit Issues (with
 *                  broker decisions where ambiguous) and refine the shipment
 *
 * Deterministic and offline. Defaults follow the decision policy: the commercial invoice wins unless
 * arithmetic/physical evidence proves it wrong, value is never under-declared when ambiguous, and
 * nothing is invented.
 */
import type { Issue, ReconcileFn } from '@app/shared';
import type { Rule } from './context';
import { finalizeIssues } from './lib/issues';
import { buildContext } from './merge';
import { RULES } from './rules';

/** Run the given rules over a fresh context (exposed for tests and tooling). */
export function runRules(docs: Parameters<ReconcileFn>[0], rules: Rule[] = RULES): ReturnType<ReconcileFn> {
  const ctx = buildContext(docs);
  const issues: Issue[] = [];
  for (const rule of rules) {
    try {
      issues.push(...rule.run(ctx));
    } catch (err) {
      // One faulty rule must not sink the whole entry; the rest still run.
      console.error(`[reconcile] rule ${rule.name} failed:`, err);
    }
  }
  return { shipment: ctx.shipment, issues: finalizeIssues(issues) };
}

/** Merge extracted documents into one shipment and list every discrepancy, assumption and advisory. */
export const reconcile: ReconcileFn = (docs) => runRules(docs);

export { buildContext } from './merge';
export { RULES } from './rules';
export type { ReconcileContext, Rule } from './context';
export { isValidContainerNumber, iso6346CheckDigit } from './lib/iso6346';
