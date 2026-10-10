/**
 * DECLARATION_CONFLICT: a printed, shipment-wide origin statement (invoice declaration/notes,
 * packing-list remarks, carton marks "MADE IN …") names a country that some line is not from.
 * Statements that refer to a specific style/item/carton are line-specific and skipped.
 */
import type { Evidence, ExtractedDocument, Issue } from '@app/shared';
import type { LineLink, ReconcileContext, Rule } from '../context';
import { countriesInText, countryName } from '../lib/countries';
import { evidenceFor, makeIssue } from '../lib/issues';
import { clean, normKey, truncate } from '../lib/text';
import { listText, lineNameLc } from './helpers';

interface Declaration {
  doc: ExtractedDocument;
  path: string;
  text: string;
  countries: string[];
  kind: 'declaration' | 'marking';
}

const DECLARATION_RE = [
  /\b(?:goods|merchandise|products|items|articles|commodities)\b[^.]{0,80}?\b(?:origin|made in|manufactured in|produced in)\b/i,
  /\b(?:goods|merchandise|products)\b[^.]{0,60}\b(?:manufactured|produced|made)\b[^.]{0,80}\bin\b/i,
  /\b(?:we|i)\s+(?:hereby\s+)?(?:certify|declare|confirm)\b[^.]*\borigin\b/i,
  /\bcountry of origin\s*[:-]/i,
];
const MARKING_RE = /^\s*(?:MADE|PRODUCT|MANUFACTURED) (?:IN|OF)\s+(.+)$/i;
const LINE_SPECIFIC_RE = /\b(?:items?|styles?|lines?|cartons?|ctns?|c\/no|art(?:icle)?)\.?\s*(?:no\.?|nos?\.?|#)?\s*[:.]?\s*[A-Z]*-?\d/i;

/** Quote the clause that names the country ("…the goods are of Vietnam origin.") rather than the text's start. */
export function quoteAround(text: string, codes: string[], max = 160): string {
  if (text.length <= max) return text;
  const up = text.toUpperCase();
  let at = -1;
  for (const c of codes) {
    const i = up.indexOf(countryName(c).toUpperCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return truncate(text, max);
  const before = text.slice(0, at);
  let start = 0;
  for (const [sep, len] of [['. ', 2], ['; ', 2], [': ', 2], [' that ', 6]] as const) {
    const i = before.lastIndexOf(sep);
    if (i >= 0) start = Math.max(start, i + len);
  }
  const dot = text.indexOf('.', at);
  const clause = text.slice(start, dot < 0 ? text.length : dot + 1).trim();
  return `${start > 0 ? '…' : ''}${truncate(clause, max)}`;
}

function lineSpecific(text: string, links: LineLink[]): boolean {
  if (LINE_SPECIFIC_RE.test(text) && !/\bC\/NO\.?\s*:?\s*1\s*[-–]/i.test(text)) return true;
  const key = normKey(text);
  return links.some((l) => {
    const k = normKey(l.line.styleNo);
    return k.length >= 4 && key.includes(k);
  });
}

/** Shipment-wide origin statements found in invoices and packing lists. */
export function findDeclarations(ctx: ReconcileContext): Declaration[] {
  const out: Declaration[] = [];
  const consider = (doc: ExtractedDocument, path: string, text: string, links: LineLink[]) => {
    if (!text || !DECLARATION_RE.some((re) => re.test(text)) || lineSpecific(text, links)) return;
    const countries = [...new Set(countriesInText(text, { demonyms: true }))];
    if (countries.length) out.push({ doc, path, text: clean(text), countries, kind: 'declaration' });
  };
  for (const inv of ctx.invoices) {
    const links = ctx.links.filter((l) => l.inv === inv);
    (inv.data.notes ?? []).forEach((n, i) => consider(inv.doc, `notes[${i}]`, n, links));
  }
  for (const pl of ctx.packingLists) {
    (pl.data.remarks ?? []).forEach((r, i) => consider(pl.doc, `remarks[${i}]`, r, ctx.links));
    const marks = pl.data.shippingMarks ?? [];
    marks.forEach((m, i) => {
      const mm = MARKING_RE.exec(m);
      if (!mm) return;
      const countries = countriesInText(mm[1]);
      const range = marks.find((x) => /C\/NO|CTN|CARTON/i.test(x));
      if (countries.length) out.push({ doc: pl.doc, path: `shippingMarks[${i}]`, text: clean([m, range].filter(Boolean).join(' / ')), countries, kind: 'marking' });
    });
  }
  return out;
}

export const declarationConflictRule: Rule = {
  name: 'declaration-conflict',
  codes: ['DECLARATION_CONFLICT'],
  run(ctx) {
    const decls = findDeclarations(ctx);
    const conflicts: { d: Declaration; lines: LineLink[] }[] = [];
    for (const d of decls) {
      const lines = ctx.links.filter((l) => l.line.countryOfOrigin.value && !d.countries.includes(l.line.countryOfOrigin.value));
      if (lines.length) conflicts.push({ d, lines });
    }
    if (!conflicts.length) return [];
    const lines = [...new Set(conflicts.flatMap((c) => c.lines))];
    const declared = [...new Set(conflicts.flatMap((c) => c.d.countries))];
    const byOrigin = lines.map((l) => `${lineNameLc(l)} is of ${countryName(l.line.countryOfOrigin.value)} origin (${l.line.countryOfOrigin.value})`);
    const statements = conflicts.map((c) => `${c.d.kind === 'marking' ? 'the carton marks read' : 'a printed statement reads'} "${quoteAround(c.d.text, c.d.countries)}"`);
    const joined = statements.join('; ');
    const evidence: Evidence[] = conflicts.map((c) => evidenceFor(c.d.doc, c.d.text, c.d.path));
    const hasMarking = conflicts.some((c) => c.d.kind === 'marking');
    const issue: Issue = makeIssue({
      code: 'DECLARATION_CONFLICT',
      severity: 'warning',
      category: 'compliance',
      title: `Origin declaration (${listText(declared.map(countryName))}) contradicts line origins`,
      detail: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}, but ${listText(byOrigin)}. A false origin statement on a commercial document is a compliance risk even when the entry lines are declared correctly.`,
      evidence,
      action: `Ask the seller to correct the declaration (or state the ${listText([...new Set(lines.map((l) => countryName(l.line.countryOfOrigin.value)))])} origin of the affected goods separately)${hasMarking ? ' and make sure those cartons are marked with their true country of origin (19 USC 1304)' : ''}.`,
    });
    return [issue];
  },
};
