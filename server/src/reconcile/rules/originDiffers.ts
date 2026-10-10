/**
 * ORIGIN_DIFFERS: a line's country of origin differs from the invoice header origin, or the invoice
 * line and packing list state different origins. Each line is entered with its own origin, and the
 * MID must name a producer in that country.
 */
import type { Evidence, Issue } from '@app/shared';
import type { LineLink, Rule } from '../context';
import { linePath } from '../context';
import { countryName } from '../lib/countries';
import { evidenceFor, makeIssue } from '../lib/issues';
import { clean } from '../lib/text';
import { toIso2 } from '../merge/lines';
import { detailsMatching, lineName, plLineEvidence, lineNameLc } from './helpers';

const ORIGIN_TEXT = /origin|made in|manufactured in|produced in|country/i;

function lineIssue(link: LineLink): Issue | undefined {
  const origin = link.line.countryOfOrigin.value;
  if (!origin) return undefined;
  const header = toIso2(link.inv.data.countryOfOrigin);
  const invLineCoo = toIso2(link.invLine.countryOfOrigin);
  const plCoos = link.pl.map((r) => ({ r, c: toIso2(r.line.countryOfOrigin) })).filter((x) => x.c);
  const plConflict = invLineCoo ? plCoos.find((x) => x.c !== invLineCoo) : undefined;
  const headerDiffers = !!header && header !== origin;
  if (!headerDiffers && !plConflict) return undefined;

  const evidence: Evidence[] = [];
  const parts: string[] = [];
  const name = (c: string) => `${c} (${countryName(c)})`;
  if (headerDiffers) {
    const quotes = detailsMatching(link, ORIGIN_TEXT);
    parts.push(`${lineName(link)} is of ${name(origin)} origin${quotes.length ? ` ("${quotes.join('"; "')}")` : ''}, while the invoice header states ${name(header as string)}.`);
    evidence.push(evidenceFor(link.inv.doc, quotes[0] ?? `${link.line.styleNo ?? ''} origin ${origin}`, `lines[${link.index}].countryOfOrigin`));
    evidence.push(evidenceFor(link.inv.doc, `Country of Origin: ${countryName(header as string).toUpperCase()}`, 'countryOfOrigin'));
  }
  for (const { r, c } of plCoos) {
    const remark = (r.pl.data.remarks ?? []).find((x) => (!!link.line.styleNo && x.includes(link.line.styleNo)) || (ORIGIN_TEXT.test(x) && x.toUpperCase().includes(countryName(c as string).toUpperCase())));
    evidence.push(remark ? evidenceFor(r.pl.doc, remark, `lines[${r.index}].countryOfOrigin`) : plLineEvidence(r, 'countryOfOrigin'));
  }
  if (plConflict) parts.push(`The invoice line states ${name(invLineCoo as string)} but the packing list states ${name(plConflict.c as string)}; the invoice is used per the decision policy.`);
  else if (plCoos.length) parts.push(`The packing list confirms ${name(origin)}.`);

  const mfr = link.line.manufacturer;
  if (!mfr?.name) parts.push(`No manufacturer in ${countryName(origin)} is identified for this line; the MID must name the actual producer.`);
  else if (mfr.country && mfr.country !== origin) parts.push(`No manufacturer in ${countryName(origin)} is identified for this line (current: ${clean(mfr.name)}, ${mfr.country}); the MID must name the actual producer.`);
  else parts.push(`The MID must come from the producer in that country: ${clean(mfr.name)}${mfr.country ? ` (${mfr.country})` : ''}.`);
  parts.push('Each line is reported with its own country of origin, which can change duty rates, Chapter 99 measures and quota/visa requirements.');

  return makeIssue({
    code: 'ORIGIN_DIFFERS',
    key: link.line.id,
    severity: 'warning',
    category: 'compliance',
    title: `${lineName(link)}: origin ${origin}${headerDiffers ? ` differs from invoice header ${header}` : ' conflicts between documents'}`,
    detail: parts.join(' '),
    evidence,
    action: `Enter ${lineNameLc(link)} with country of origin ${origin} and the MID of its ${countryName(origin)} manufacturer; check origin-specific duties (incl. Chapter 99) and keep proof of origin on file.`,
    field: linePath(link, 'countryOfOrigin'),
    lineId: link.line.id,
  });
}

export const originDiffersRule: Rule = {
  name: 'origin-differs',
  codes: ['ORIGIN_DIFFERS'],
  run: (ctx) => ctx.links.map(lineIssue).filter((i): i is Issue => !!i),
};
