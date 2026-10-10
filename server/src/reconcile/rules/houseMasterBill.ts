/**
 * HOUSE_MASTER_BILL: the shipment moves on a house bill (NVOCC/forwarder) under a carrier master
 * bill. Both must be reported on the entry manifest; the master SCAC is the importing carrier.
 */
import type { Evidence } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { listText } from './helpers';

const fmt = (b?: { scac?: string; number: string }) => (b ? `${b.scac ? `${b.scac} ` : ''}${b.number}` : '');

export const houseMasterBillRule: Rule = {
  name: 'house-master-bill',
  codes: ['HOUSE_MASTER_BILL'],
  run(ctx) {
    const pairs = ctx.shipment.bills.filter((b) => b.house && b.master);
    if (!pairs.length) return [];
    const t = ctx.transport;
    const evidence: Evidence[] = [];
    let issuer = '';
    let carrier = '';
    if (t?.kind === 'bl') {
      const d = t.src.data;
      evidence.push(evidenceFor(t.src.doc, `B/L No.: ${d.blNumber}`, 'blNumber'));
      if (d.masterBlNumber) evidence.push(evidenceFor(t.src.doc, `MBL: ${d.masterBlNumber}${d.carrierName ? ` CARRIER: ${d.carrierName}${d.carrierScac ? ` (${d.carrierScac})` : ''}` : ''}`, 'masterBlNumber'));
      issuer = d.issuerName ?? '';
      carrier = d.carrierName ?? '';
    } else if (t?.kind === 'awb') {
      const d = t.src.data;
      evidence.push(evidenceFor(t.src.doc, `HAWB ${d.awbNumber}${d.masterAwbNumber ? ` / MAWB ${d.masterAwbNumber}` : ''}`, 'awbNumber'));
      carrier = d.carrierName ?? '';
    }
    const air = t?.kind === 'awb';
    return [
      makeIssue({
        code: 'HOUSE_MASTER_BILL',
        severity: 'info',
        category: 'compliance',
        title: `House ${air ? 'air waybill' : 'bill'} under a master ${air ? 'air waybill' : 'bill'}`,
        detail:
          `${listText(pairs.map((p) => `house ${fmt(p.house)}${issuer ? ` (issued by ${issuer})` : ''} under master ${fmt(p.master)}${carrier ? ` (${carrier})` : ''}`))}. ` +
          `Both bills must be reported on the entry manifest (house and master SCAC/number); CBP matches the house bill to the ${air ? 'air AMS' : 'AMS/ISF'} filing and the master bill to the carrier's manifest.`,
        evidence,
        action: 'Report both bill numbers on the entry; confirm the master bill with the carrier\'s arrival notice.',
        field: 'bills',
      }),
    ];
  },
};
