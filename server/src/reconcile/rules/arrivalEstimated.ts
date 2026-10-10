/** ARRIVAL_ESTIMATED: the arrival date is an ETA, not the actual arrival from an arrival notice. */
import type { Evidence } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';

export const arrivalEstimatedRule: Rule = {
  name: 'arrival-estimated',
  codes: ['ARRIVAL_ESTIMATED'],
  run(ctx) {
    const t = ctx.shipment.transport;
    if (!t.arrivalDateEstimated || !t.arrivalDate) return [];
    const src = t.arrivalDate.sources[0];
    const doc = src ? ctx.docs.find((d) => d.docId === src.docId) : undefined;
    const evidence: Evidence[] = doc ? [evidenceFor(doc, `ETA: ${t.arrivalDate.value}`, src?.field)] : [];
    const fromNotice = doc?.docType === 'arrival_notice';
    return [
      makeIssue({
        code: 'ARRIVAL_ESTIMATED',
        severity: 'warning',
        category: 'assumption',
        title: `Arrival date ${t.arrivalDate.value} is an estimate`,
        detail: `The arrival date ${t.arrivalDate.value} is the estimated time of arrival printed on the ${fromNotice ? 'arrival notice' : 'commercial invoice'}; ${fromNotice ? 'the notice gives no actual arrival date' : 'no arrival notice was provided'}. The entry's arrival date, entry date and exchange rate depend on the actual arrival.`,
        evidence,
        action: 'Confirm the actual arrival date from the carrier\'s arrival notice (or enter it in the broker inputs) before filing.',
        field: 'transport.arrivalDate',
      }),
    ];
  },
};
