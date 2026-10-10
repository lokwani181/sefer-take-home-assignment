/**
 * RELATED_PARTY_ASSUMED: no document says whether buyer and seller are related, so "not related"
 * is assumed (the usual case, but the broker must confirm it for the entry).
 */
import type { Rule } from '../context';
import { makeIssue } from '../lib/issues';
import { partyName } from '../lib/parties';
import { listText } from './helpers';

export const relatedPartyRule: Rule = {
  name: 'related-party',
  codes: ['RELATED_PARTY_ASSUMED'],
  run(ctx) {
    const assumed = ctx.invoices.filter((i) => i.invoice.relatedParty.status === 'assumed');
    if (!assumed.length) return [];
    const pairs = assumed.map((i) => `${partyName(i.data.seller)} → ${partyName(i.data.buyer)}${ctx.invoices.length > 1 ? ` (invoice ${i.data.invoiceNumber})` : ''}`);
    return [
      makeIssue({
        code: 'RELATED_PARTY_ASSUMED',
        severity: 'info',
        category: 'assumption',
        title: 'Buyer and seller assumed not related',
        detail: `No document states whether the parties are related (${listText(pairs)}). The entry is prepared as a non-related-party transaction. Related parties (e.g. common ownership, 5%+ shareholding, employer/employee) must be declared, and the price must then be shown to be acceptable.`,
        evidence: [],
        action: 'Confirm with the importer whether it is related to the seller; if it is, switch related-party to Y on the invoice.',
        field: 'invoices[0].relatedParty',
      }),
    ];
  },
};
