/**
 * GROSS_WEIGHT_MISMATCH: packing-list vs transport-document gross weight differ by more than 1%.
 * The header uses the manifested (transport document) weight by default; decision grossWeight.
 */
import type { Evidence } from '@app/shared';
import { DECISION_KEYS } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { fmtNum, isNum, pctDiff, round2, round3 } from '../lib/num';
import { packingGross } from '../merge/transport';
import { sourced } from '../merge/sourced';

export const GROSS_WEIGHT_TOLERANCE_PCT = 1;

export const grossWeightRule: Rule = {
  name: 'gross-weight',
  codes: ['GROSS_WEIGHT_MISMATCH'],
  run(ctx) {
    const t = ctx.transport;
    const tw = t?.kind === 'bl' ? t.src.data.grossWeightKg : t?.kind === 'awb' ? t.src.data.grossWeightKg : undefined;
    const pw = packingGross(ctx);
    if (!t || !isNum(tw) || !pw) return [];
    const pct = pctDiff(pw.value, tw);
    if (pct <= GROSS_WEIGHT_TOLERANCE_PCT) return [];

    ctx.shipment.grossWeightKg = sourced(tw, 'extracted', t.src.doc, ['grossWeightKg']);
    const tName = t.kind === 'bl' ? 'Bill of lading' : 'Air waybill';
    const plDoc = ctx.docs.find((d) => d.docId === pw.sources[0]?.docId);
    const evidence: Evidence[] = [evidenceFor(t.src.doc, `Gross weight: ${fmtNum(tw)} KGS`, 'grossWeightKg')];
    if (plDoc) evidence.push(evidenceFor(plDoc, `Total G.W.: ${fmtNum(pw.value)} KGS`, pw.sources[0]?.field));
    const palletNote = ctx.packingLists.flatMap((p) => (p.data.remarks ?? []).map((r, i) => ({ p, r, i })).filter((x) => /pallet/i.test(x.r)))[0];
    if (palletNote) evidence.push(evidenceFor(palletNote.p.doc, palletNote.r, `remarks[${palletNote.i}]`));

    return [
      makeIssue({
        code: 'GROSS_WEIGHT_MISMATCH',
        severity: 'warning',
        category: 'discrepancy',
        title: `Gross weight: ${tName.toLowerCase()} ${fmtNum(tw)} kg vs packing list ${fmtNum(pw.value)} kg`,
        detail:
          `${tName}: ${fmtNum(tw)} kg; packing list: ${fmtNum(pw.value)} kg (difference ${fmtNum(round3(Math.abs(tw - pw.value)))} kg, ${fmtNum(round2(pct), 1)}%, above the ${GROSS_WEIGHT_TOLERANCE_PCT}% tolerance). ` +
          `The entry header gross weight should match the manifested weight, so the ${tName.toLowerCase()} figure is used; line-level weights still come from the packing list.` +
          (palletNote ? ` The packing list notes: "${palletNote.r}".` : ''),
        evidence,
        action: 'Confirm the weight with the carrier/forwarder (a CFS re-weigh, pallets or dunnage explain a higher manifest weight). Choose "packing_list" only if the manifest weight is wrong.',
        field: 'grossWeightKg',
        decision: {
          key: DECISION_KEYS.grossWeight,
          question: 'Which gross weight should be reported on the entry header?',
          options: [
            { value: 'transport_doc', label: `${tName}: ${fmtNum(tw)} kg` },
            { value: 'packing_list', label: `Packing list: ${fmtNum(pw.value)} kg` },
          ],
          chosen: 'transport_doc',
        },
      }),
    ];
  },
};
