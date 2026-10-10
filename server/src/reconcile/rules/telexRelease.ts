/**
 * TELEX_RELEASE advisory: the originals were surrendered at origin (or a sea waybill was issued),
 * so no original bill is needed to take delivery.
 */
import type { Evidence } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';

const STAMP_RE = /TELEX|SURRENDER|EXPRESS RELEASE|SEAWAY|SEA WAYBILL/i;

export const telexReleaseRule: Rule = {
  name: 'telex-release',
  codes: ['TELEX_RELEASE'],
  run(ctx) {
    const evidence: Evidence[] = [];
    for (const b of ctx.bills) {
      for (const o of b.doc.observations ?? []) if (o.kind === 'stamp' && STAMP_RE.test(o.text)) evidence.push({ docId: b.doc.docId, page: o.page ?? 1, text: o.text });
    }
    const rel = ctx.shipment.releaseType;
    if (rel !== 'telex' && rel !== 'seaway' && !evidence.length) return [];
    const seaway = rel === 'seaway';
    if (!evidence.length && ctx.transport?.kind === 'bl') evidence.push(evidenceFor(ctx.transport.src.doc, seaway ? 'SEA WAYBILL' : 'TELEX RELEASE', 'releaseType'));
    return [
      makeIssue({
        code: 'TELEX_RELEASE',
        severity: 'info',
        category: 'compliance',
        title: seaway ? 'Sea waybill: no original bill required' : 'Telex release: originals surrendered at origin',
        detail: seaway
          ? 'The goods move on a sea waybill, so the carrier releases them to the named consignee without an original bill.'
          : 'The bill of lading was telex-released (originals surrendered at origin), so the carrier can release the cargo without presentation of an original bill.',
        evidence,
        action: 'Confirm with the carrier/forwarder that the release is posted at destination and freight is settled before arranging delivery.',
      }),
    ];
  },
};
