/**
 * COMPOSITION_CONFLICT: the invoice and packing list give different fibre contents for a style
 * (different predominant fibre, or any fibre ≥ 10 points apart). Textiles are classified by the
 * fibre that predominates by weight, so this can change the HTS subheading and duty rate.
 */
import type { Issue } from '@app/shared';
import { DECISION_KEYS } from '@app/shared';
import type { LineLink, Rule } from '../context';
import { linePath } from '../context';
import { compareCompositions, fiberFamily, fmtComposition } from '../lib/composition';
import { makeIssue } from '../lib/issues';
import { refOf } from '../merge/sourced';
import { invoiceLineEvidence, lineName, plLineEvidence, lineNameLc } from './helpers';

function lineIssue(link: LineLink): Issue | undefined {
  const inv = link.invLine.composition;
  if (!inv?.length) return undefined;
  for (const ref of link.pl) {
    const other = ref.line.composition;
    if (!other?.length) continue;
    const cmp = compareCompositions(inv, other);
    if (!cmp.conflict) continue;

    link.line.altComposition = other;
    link.line.altCompositionSource = refOf(ref.pl.doc, `lines[${ref.index}].composition`);

    const pa = cmp.predominantA;
    const pb = cmp.predominantB;
    const famA = pa ? fiberFamily(pa.fiber) : undefined;
    const famB = pb ? fiberFamily(pb.fiber) : undefined;
    const rawA = link.invLine.compositionRaw ?? fmtComposition(inv);
    const rawB = ref.line.compositionRaw ?? fmtComposition(other);
    const why = cmp.predominantDiffers
      ? `The predominant fibre changes from ${pa?.fiber} (${pa?.pct}%) to ${pb?.fiber} (${pb?.pct}%)${famA && famB && famA !== famB ? `, i.e. ${famA} vs ${famB}` : ''}.`
      : `${cmp.maxDiffFiber} differs by ${cmp.maxDiff} percentage points.`;
    const hs = link.line.hsCodeDeclared ? ` (declared HS ${link.line.hsCodeDeclared})` : '';
    return makeIssue({
      code: 'COMPOSITION_CONFLICT',
      key: link.line.id,
      severity: 'blocker',
      category: 'classification',
      title: `${lineName(link)}: fibre content differs between invoice and packing list`,
      detail:
        `Invoice: "${rawA}" = ${fmtComposition(inv)}. Packing list: "${rawB}" = ${fmtComposition(other)}. ${why} ` +
        `Textiles are classified by the fibre that predominates by weight, so the composition decides the subheading${hs} ` +
        `(e.g. a cotton vs a man-made-fibre subheading) and therefore the duty rate and textile category. ` +
        `Per the decision policy the invoice composition is used until it is confirmed.`,
      evidence: [invoiceLineEvidence(link, 'composition'), plLineEvidence(ref, 'composition', ref.line.compositionRaw)],
      action: 'Obtain the fibre-content specification or a lab test report from the manufacturer and confirm which composition is correct before filing.',
      field: linePath(link, 'attributes.composition'),
      lineId: link.line.id,
      decision: {
        key: DECISION_KEYS.composition(link.line.id),
        question: `Which fibre content should ${lineNameLc(link)} be classified under?`,
        options: [
          { value: 'invoice', label: `Invoice: ${fmtComposition(inv)}` },
          { value: 'other_doc', label: `Packing list: ${fmtComposition(other)}` },
        ],
        chosen: 'invoice',
      },
    });
  }
  return undefined;
}

export const compositionRule: Rule = {
  name: 'composition',
  codes: ['COMPOSITION_CONFLICT'],
  run: (ctx) => ctx.links.map(lineIssue).filter((i): i is Issue => !!i),
};
