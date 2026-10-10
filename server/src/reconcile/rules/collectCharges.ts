/**
 * COLLECT_CHARGES advisory: charges payable at destination (collect) are not part of the price
 * paid for the goods and are not included in entered value.
 */
import type { Evidence } from '@app/shared';
import type { Rule } from '../context';
import { evidenceFor, makeIssue } from '../lib/issues';
import { listText } from './helpers';

export const collectChargesRule: Rule = {
  name: 'collect-charges',
  codes: ['COLLECT_CHARGES'],
  run(ctx) {
    const items: { text: string; ev: Evidence }[] = [];
    for (const b of ctx.bills) {
      (b.data.charges ?? []).forEach((c, i) => {
        if (c.terms === 'collect') items.push({ text: c.description, ev: evidenceFor(b.doc, `${c.description} COLLECT`, `charges[${i}]`) });
      });
      if (!(b.data.charges ?? []).length && /COLLECT/i.test(b.data.freightTerms ?? '')) items.push({ text: b.data.freightTerms as string, ev: evidenceFor(b.doc, b.data.freightTerms as string, 'freightTerms') });
    }
    for (const a of ctx.airWaybills) {
      (a.data.charges ?? []).forEach((c, i) => {
        if (c.terms === 'collect') items.push({ text: c.description, ev: evidenceFor(a.doc, `${c.description} COLLECT`, `charges[${i}]`) });
      });
    }
    if (!items.length) return [];
    return [
      makeIssue({
        code: 'COLLECT_CHARGES',
        severity: 'info',
        category: 'valuation',
        title: 'Charges payable at destination (collect)',
        detail: `${listText(items.map((i) => i.text))} ${items.length === 1 ? 'is' : 'are'} payable by the consignee at destination. These transport charges arise after export, are not part of the price paid for the goods, and are not included in the entered value.`,
        evidence: items.map((i) => i.ev),
        action: 'No valuation change needed; make sure the consignee expects the destination charges before release.',
      }),
    ];
  },
};
