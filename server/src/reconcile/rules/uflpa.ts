/**
 * UFLPA advisory: cotton-containing apparel/textile lines (HS chapters 50–63 or cotton in the
 * composition) are a CBP enforcement priority under the Uyghur Forced Labor Prevention Act
 * whatever the declared origin, so supply-chain tracing documents should be ready.
 */
import type { Rule } from '../context';
import { hasCotton } from '../lib/composition';
import { countryName } from '../lib/countries';
import { evidenceFor, makeIssue } from '../lib/issues';
import { lineName, listText } from './helpers';

const chapter = (hs: string | undefined): number | undefined => {
  const d = hs?.replace(/\D/g, '');
  return d && d.length >= 2 ? Number(d.slice(0, 2)) : undefined;
};

const COTTON_TEXT = /\bcotton\b|\bCVC\b|\bT\/?C\b/i;

export const uflpaRule: Rule = {
  name: 'uflpa',
  codes: ['UFLPA'],
  run(ctx) {
    const flagged = ctx.links.filter((l) => {
      const ch = chapter(l.line.hsCodeDeclared);
      const textile = ch !== undefined && ch >= 50 && ch <= 63;
      const comps = [l.line.attributes.composition, l.line.altComposition];
      const cotton = comps.some(hasCotton) || ch === 52 || [l.line.description, ...l.line.details].some((t) => COTTON_TEXT.test(t ?? ''));
      const unknownTextile = textile && !l.line.attributes.composition?.length;
      return cotton || unknownTextile;
    });
    if (!flagged.length) return [];
    const origins = [...new Set(flagged.map((l) => l.line.countryOfOrigin.value).filter(Boolean))];
    return [
      makeIssue({
        code: 'UFLPA',
        severity: 'warning',
        category: 'compliance',
        title: `UFLPA: cotton-containing textiles (${flagged.length} line${flagged.length === 1 ? '' : 's'})`,
        detail:
          `${listText(flagged.map(lineName))} ${flagged.length === 1 ? 'contains' : 'contain'} cotton${flagged.some((l) => !l.line.attributes.composition?.length) ? ' (or may: textile lines without a stated composition are included)' : ''}. ` +
          `Cotton apparel is a CBP enforcement priority under the Uyghur Forced Labor Prevention Act regardless of the declared origin${origins.length ? ` (${listText(origins.map(countryName))})` : ''}: goods with Xinjiang-sourced cotton anywhere in the supply chain are presumed inadmissible and can be detained.`,
        evidence: flagged.map((l) =>
          evidenceFor(l.inv.doc, `${l.line.styleNo ?? `Line ${l.line.invoiceLineNo}`}: ${l.invLine.compositionRaw ?? l.line.details[0] ?? l.line.description}`, `lines[${l.index}].composition`),
        ),
        action: 'Have supply-chain tracing documents ready (fabric and yarn mill invoices, cotton origin certificates, production records, purchase orders) in case CBP detains the shipment.',
        field: 'invoices',
      }),
    ];
  },
};
