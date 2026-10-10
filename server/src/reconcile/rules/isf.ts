/**
 * ISF advisory (ocean only): the Importer Security Filing (10+2) must have been filed 24 hours
 * before loading at origin; the entry data should match it.
 */
import type { Evidence } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';

export const isfRule: Rule = {
  name: 'isf',
  codes: ['ISF'],
  run(ctx) {
    if (ctx.shipment.transport.mode !== 'ocean') return [];
    const bl = ctx.transport?.kind === 'bl' ? ctx.transport.src : undefined;
    const by = bl?.data.isfFiledBy;
    const ams = bl?.data.amsFiledBy;
    const evidence: Evidence[] = [];
    if (bl && by) evidence.push(evidenceFor(bl.doc, `ISF FILED BY: ${by}`, 'isfFiledBy'));
    if (bl && ams) evidence.push(evidenceFor(bl.doc, `AMS FILED BY: ${ams}`, 'amsFiledBy'));
    return [
      makeIssue({
        code: 'ISF',
        severity: 'info',
        category: 'compliance',
        title: by ? `ISF filed by ${by}` : 'Confirm the ISF (10+2) was filed',
        detail:
          `Ocean shipments to the US require an Importer Security Filing at least 24 hours before loading at the foreign port. ${by ? `The bill of lading states the ISF was filed by "${by}".` : 'No document states who filed it.'}` +
          `${ams ? ` AMS was filed by "${ams}".` : ''} The entry's bill numbers, manufacturer, seller, consignee and country of origin should match the ISF.`,
        evidence,
        action: 'Confirm the ISF was accepted (and matched to the bill) and that its parties and origin agree with this entry; late or inaccurate ISF filings risk liquidated damages and holds.',
      }),
    ];
  },
};
