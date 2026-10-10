/**
 * IMPORTER_ASSUMED / ULTIMATE_CONSIGNEE_ASSUMED: explain which party was used as importer of record
 * and ultimate consignee, and why (buyer vs notify party / consignee; buyer vs 3PL ship-to).
 */
import type { Evidence, Issue } from '@app/shared';
import type { ReconcileContext, Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { oneLine, partyName } from '../lib/parties';
import { resolveParties } from '../merge/parties';

function evidenceFromRefs(ctx: ReconcileContext, refs: { docId: string; field?: string }[], text: string): Evidence[] {
  return refs
    .map((r) => {
      const doc = ctx.docs.find((d) => d.docId === r.docId);
      return doc ? evidenceFor(doc, text, r.field) : undefined;
    })
    .filter((e): e is Evidence => !!e);
}

export const partiesRule: Rule = {
  name: 'parties',
  codes: ['IMPORTER_ASSUMED', 'ULTIMATE_CONSIGNEE_ASSUMED'],
  run(ctx) {
    const p = resolveParties(ctx);
    const issues: Issue[] = [];
    const imp = p.importer?.value;

    if (imp && p.importerBasis !== 'buyer') {
      const role = p.importerBasis === 'notify_party' ? 'notify party' : 'consignee';
      issues.push(
        makeIssue({
          code: 'IMPORTER_ASSUMED',
          severity: 'info',
          category: 'assumption',
          title: `Importer assumed: ${partyName(imp)} (${role})`,
          detail: `No buyer/sold-to party was found on an invoice, so the transport document's ${role} ${partyName(imp)} is used as importer of record.`,
          evidence: p.importerRef ? evidenceFromRefs(ctx, [p.importerRef], oneLine(imp)) : [],
          action: 'Confirm the importer of record and provide its IRS/EIN number.',
          field: 'importer',
        }),
      );
    } else if (imp && imp.country && imp.country !== 'US') {
      issues.push(
        makeIssue({
          code: 'IMPORTER_ASSUMED',
          severity: 'info',
          category: 'assumption',
          title: `Importer is a non-US buyer: ${partyName(imp)}`,
          detail: `The buyer ${partyName(imp)} is located outside the US (${imp.country}). It is used as importer of record; a non-resident importer needs a CBP-assigned number and a resident agent/bond arrangement.`,
          evidence: p.importerRef ? evidenceFromRefs(ctx, [p.importerRef], oneLine(imp)) : [],
          action: 'Confirm who acts as importer of record (non-resident buyer or a US party) and provide its importer number.',
          field: 'importer',
        }),
      );
    }

    const uc = p.ultimateConsignee?.value;
    const st = p.shipTo;
    if (uc && p.ucBasis !== 'same_as_buyer' && p.ucBasis !== 'none') {
      let detail: string;
      let title: string;
      if ((p.ucBasis === 'buyer_logistics' || p.ucBasis === 'buyer_account_of') && st) {
        const why = [
          p.logisticsKeyword ? `looks like a logistics provider ("${p.logisticsKeyword}")` : undefined,
          p.accountOf ? `receives the goods "for account of ${p.accountOf}"` : undefined,
        ].filter(Boolean).join(' and ');
        title = `Ultimate consignee = buyer ${partyName(uc)}, not the ship-to`;
        detail = `The ship-to ${partyName(st)}${st.city ? ` (${st.city}${st.stateProvince ? `, ${st.stateProvince}` : ''})` : ''} ${why}. The ultimate consignee is the US party the goods were sold to, so ${partyName(uc)} is used; ${partyName(st)} stays the ship-to/delivery party and gives the destination state.`;
      } else if (p.ucBasis === 'buyer_to_order') {
        title = `Ultimate consignee = buyer ${partyName(uc)} (bill consigned to order)`;
        detail = `The transport document is consigned "${p.toOrder}": a negotiable to-order bill, as used with a letter of credit. The order party holds the bill as security and endorses it over for release; it does not receive the goods. The buyer ${partyName(uc)} is used as importer and ultimate consignee.`;
      } else if (p.ucBasis === 'ship_to' && st) {
        title = `Ultimate consignee = ship-to ${partyName(uc)}`;
        detail = `The ship-to ${partyName(st)} differs from the buyer${imp ? ` ${partyName(imp)}` : ''} and does not look like a logistics provider, so it is used as ultimate consignee (the party receiving the goods). If the buyer resells to the ship-to only after import, the buyer is the ultimate consignee instead.`;
      } else {
        title = `Ultimate consignee = importer ${partyName(uc)}`;
        detail = `No separate ship-to or consignee is printed, so the importer ${partyName(uc)} is used as ultimate consignee.`;
      }
      const refs = [...(p.ultimateConsignee?.sources ?? []), ...(p.shipToRef && p.ucBasis !== 'ship_to' ? [p.shipToRef] : [])];
      const ev = refs
        .map((r) => {
          const doc = ctx.docs.find((d) => d.docId === r.docId);
          const addr = r.field === p.shipToRef?.field && r.docId === p.shipToRef?.docId ? st : uc;
          return doc ? evidenceFor(doc, oneLine(addr), r.field) : undefined;
        })
        .filter((e): e is Evidence => !!e);
      issues.push(
        makeIssue({
          code: 'ULTIMATE_CONSIGNEE_ASSUMED',
          severity: 'info',
          category: 'assumption',
          title,
          detail,
          evidence: ev,
          action: 'Confirm the ultimate consignee and provide its IRS/EIN number (or CBP-assigned number).',
          field: 'ultimateConsignee',
        }),
      );
    }
    return issues;
  },
};
