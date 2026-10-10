/**
 * SELLER_NOT_MANUFACTURER + FIRST_SALE_OPPORTUNITY: the invoicing seller is not the factory that
 * made the goods (a trading company / middleman). The MID must identify the manufacturer, and the
 * factory price may support first-sale valuation.
 */
import type { Address, Evidence, Issue } from '@app/shared';
import type { InvoiceSource, ReconcileContext, Rule } from '../context';
import { invoiceKey } from '../context';
import { countryName } from '../lib/countries';
import { evidenceFor, makeIssue } from '../lib/issues';
import { oneLine, partyName, sameParty } from '../lib/parties';
import { listText } from './helpers';

function runInvoice(ctx: ReconcileContext, inv: InvoiceSource): Issue[] {
  const seller = inv.data.seller;
  if (!seller?.name) return [];
  const links = ctx.links.filter((l) => l.inv === inv);
  // Only stated manufacturers count; a manufacturer assumed from the seller would trivially match.
  const makers: Address[] = [];
  for (const l of links) {
    const m = l.line.manufacturer;
    if (m?.name && !ctx.manufacturerAssumed.has(l.line.id) && !makers.some((x) => sameParty(x, m))) makers.push(m);
  }
  if (!makers.length || makers.some((m) => sameParty(m, seller))) return [];

  const sel = `${partyName(seller)}${seller.country ? ` (${countryName(seller.country)})` : ''}`;
  const mk = listText(makers.map((m) => `${partyName(m)}${m.country ? ` (${countryName(m.country)})` : ''}`));
  const evidence: Evidence[] = [evidenceFor(inv.doc, oneLine(seller), 'seller')];
  for (const m of makers) {
    const pl = ctx.packingLists.find((p) => p.data.manufacturer && sameParty(p.data.manufacturer, m));
    const plLine = ctx.packingLists.flatMap((p) => (p.data.lines ?? []).map((l, i) => ({ p, l, i }))).find((x) => x.l.manufacturer && sameParty(x.l.manufacturer, m));
    if (pl) evidence.push(evidenceFor(pl.doc, oneLine(pl.data.manufacturer), 'manufacturer'));
    else if (plLine) evidence.push(evidenceFor(plLine.p.doc, oneLine(plLine.l.manufacturer), `lines[${plLine.i}].manufacturer`));
    else if (inv.data.manufacturer && sameParty(inv.data.manufacturer, m)) evidence.push(evidenceFor(inv.doc, oneLine(m), 'manufacturer'));
  }
  const key = invoiceKey(ctx, inv);
  const middlemanCountry = seller.country && makers.every((m) => m.country && m.country !== seller.country);
  return [
    makeIssue({
      code: 'SELLER_NOT_MANUFACTURER',
      key,
      severity: 'info',
      category: 'compliance',
      title: 'Seller is not the manufacturer',
      detail: `The invoice is issued by ${sel}, but the goods were made by ${mk}. The manufacturer identification code (MID) must identify the actual producer of each line, not the seller; the seller is reported as the selling party.`,
      evidence,
      action: 'Build each line\'s MID from its manufacturer\'s name and address (not the seller\'s) and verify the factory address with the importer.',
      field: 'manufacturers',
    }),
    makeIssue({
      code: 'FIRST_SALE_OPPORTUNITY',
      key,
      severity: 'info',
      category: 'valuation',
      title: 'Possible first-sale valuation',
      detail:
        `${partyName(seller)} appears to be a middleman${middlemanCountry ? ` (located in ${countryName(seller.country)}, factory elsewhere)` : ''} buying from ${mk}. ` +
        'If the factory-to-middleman sale is a bona fide sale clearly destined for the United States, the entry may be valued on that first-sale price (Nissho Iwai; 19 CFR 152.103(a)(1)), which is usually lower than the price on this invoice.',
      evidence: evidence.slice(0, 2),
      action: 'Optional: ask the importer whether the factory invoice, proof of payment and the supply-chain contracts are available to support a first-sale declaration; otherwise value on this invoice.',
      field: `invoices[${inv.index}]`,
    }),
  ];
}

export const sellerManufacturerRule: Rule = {
  name: 'seller-manufacturer',
  codes: ['SELLER_NOT_MANUFACTURER', 'FIRST_SALE_OPPORTUNITY'],
  run: (ctx) => ctx.invoices.flatMap((inv) => runInvoice(ctx, inv)),
};
