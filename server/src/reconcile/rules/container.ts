/**
 * CONTAINER_NUMBER_CORRECTED / CONTAINER_NUMBER_INVALID: every container reading (typed, struck
 * through, handwritten, OCR) is re-validated with the ISO 6346 check digit. The chosen number must
 * pass; when it came from a correction or a choice between readings, the broker is asked to verify it.
 */
import type { Container, ContainerCandidate, Evidence, Issue } from '@app/shared';
import type { ReconcileContext, Rule } from '../context';
import { compactContainer, containerRepairs, iso6346CheckDigit, isValidContainerNumber } from '../lib/iso6346';
import { evidenceFor, makeIssue } from '../lib/issues';
import { listText } from './helpers';

export interface ContainerReview {
  index: number;
  chosen?: string;
  original: string;
  /** Why this needs verification (empty when the reading was clean). */
  reasons: string[];
  invalid: boolean;
  evidence: Evidence[];
}

function describe(c: ContainerCandidate | { number: string; source?: string }): string {
  const n = compactContainer(c.number);
  const src = 'source' in c && c.source ? ` (${c.source})` : '';
  if (isValidContainerNumber(n)) return `${n}${src} passes the ISO 6346 check digit`;
  const cd = n.length >= 10 ? iso6346CheckDigit(n.slice(0, 10)) : undefined;
  return cd !== undefined && /^\d$/.test(n[10] ?? '') ? `${n}${src} fails the check digit (computed ${cd}, printed ${n[10]})` : `${n}${src} is not a well-formed container number`;
}

/** Pick the container number for one container and explain how it was chosen. */
export function reviewContainer(ctx: ReconcileContext, c: Container, index: number): ContainerReview {
  const doc = ctx.transport?.src.doc;
  const path = `containers[${index}].number`;
  const original = compactContainer(c.number ?? '');
  const cands = (c.candidates ?? []).filter((x) => x.number);
  const distinct = [...new Set([original, ...cands.map((x) => compactContainer(x.number))].filter(Boolean))];
  const valid = distinct.filter(isValidContainerNumber);
  const meta = doc?.fieldMeta?.[path];
  const obs = (doc?.observations ?? []).filter((o) => (o.field === path || o.field === `containers[${index}]`) && ['handwritten', 'strikethrough', 'ocr_repair', 'low_confidence'].includes(o.kind));
  const evidence: Evidence[] = doc ? [evidenceFor(doc, obs.map((o) => o.text).join(' ') || `Container ${original}`, path)] : [];
  const reasons: string[] = [];

  let chosen: string | undefined;
  if (isValidContainerNumber(original)) chosen = original;
  else if (valid.length === 1) {
    chosen = valid[0];
    reasons.push(`the printed reading ${describe({ number: original })}`);
  } else if (valid.length === 0) {
    const repaired = [...new Set(distinct.flatMap(containerRepairs))];
    if (repaired.length === 1) {
      chosen = repaired[0];
      reasons.push(`no reading passed as read; correcting OCR letter/digit confusions gives ${chosen}, the only valid number`);
    }
  }
  if (!chosen) {
    const reasons = valid.length > 1
      ? [`several readings pass the check digit (${listText(valid)}), so the right one can't be chosen automatically`]
      : distinct.length
        ? [`no reading passes the ISO 6346 check digit: ${listText(distinct.map((d) => describe({ number: d })))}`]
        : ['no container number could be read'];
    return { index, original, reasons, invalid: true, evidence };
  }
  if (cands.length && distinct.length > 1) {
    reasons.push(`it was chosen among several readings: ${listText(cands.map(describe))}`);
  }
  if (meta?.repaired) reasons.push(`the OCR text "${meta.originalText ?? ''}" was repaired${typeof meta.conf === 'number' ? ` (confidence ${meta.conf})` : ''}`);
  else if (typeof meta?.conf === 'number' && meta.conf < 70) reasons.push(`OCR confidence is low (${meta.conf})`);
  const kinds = new Set(obs.map((o) => o.kind));
  if (kinds.has('handwritten') && !reasons.some((r) => r.includes('handwritten'))) reasons.push('the number is handwritten');
  if (kinds.has('strikethrough') && !reasons.some((r) => r.includes('strikethrough'))) reasons.push('a typed number is struck through');
  return { index, chosen, original, reasons, invalid: false, evidence };
}

export const containerRule: Rule = {
  name: 'container',
  codes: ['CONTAINER_NUMBER_CORRECTED', 'CONTAINER_NUMBER_INVALID'],
  run(ctx) {
    const corrected: ContainerReview[] = [];
    const invalid: ContainerReview[] = [];
    ctx.shipment.containers.forEach((c, i) => {
      const r = reviewContainer(ctx, c, i);
      if (r.invalid) {
        c.checkDigitValid = false;
        invalid.push(r);
        return;
      }
      c.number = r.chosen as string;
      c.checkDigitValid = true;
      if (r.reasons.length) corrected.push(r);
    });
    const issues: Issue[] = [];
    if (corrected.length) {
      issues.push(
        makeIssue({
          code: 'CONTAINER_NUMBER_CORRECTED',
          severity: 'warning',
          category: 'ocr',
          title: `Container number ${listText(corrected.map((r) => r.chosen as string))} needs verification`,
          detail: corrected.map((r) => `Container ${r.chosen}: ${r.reasons.join('; ')}.`).join(' '),
          evidence: corrected.flatMap((r) => r.evidence),
          action: 'Verify the container number against the carrier\'s arrival notice, the ISF or the seal record before filing; a wrong number delays release.',
          field: corrected.length === 1 ? `containers[${corrected[0].index}].number` : 'containers',
        }),
      );
    }
    if (invalid.length) {
      issues.push(
        makeIssue({
          code: 'CONTAINER_NUMBER_INVALID',
          severity: 'blocker',
          category: 'discrepancy',
          title: `Container number ${listText(invalid.map((r) => r.original || '(unread)'))} fails the ISO 6346 check`,
          detail: `${invalid.map((r) => `Container ${r.original || '(unread)'}: ${r.reasons.join('; ')}`).join('. ')}. The container cannot be identified with confidence.`,
          evidence: invalid.flatMap((r) => r.evidence),
          action: 'Obtain the correct container number from the carrier (arrival notice / manifest) and correct it before filing.',
          field: invalid.length === 1 ? `containers[${invalid[0].index}].number` : 'containers',
        }),
      );
    }
    return issues;
  },
};
