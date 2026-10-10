/**
 * MISSING_DOCUMENT: no commercial invoice (blocker), no transport document (warning),
 * no packing list (info, unless a combined invoice/packing list carries the packing data).
 */
import type { Issue } from '@app/shared';
import type { Rule } from '../context';
import { makeIssue } from '../lib/issues';

export const missingDocumentRule: Rule = {
  name: 'missing-document',
  codes: ['MISSING_DOCUMENT'],
  run(ctx) {
    const issues: Issue[] = [];
    if (!ctx.invoices.length) {
      issues.push(
        makeIssue({
          code: 'MISSING_DOCUMENT',
          key: 'commercial_invoice',
          severity: 'blocker',
          category: 'missing_data',
          title: 'No commercial invoice',
          detail: `None of the ${ctx.docs.length} uploaded document(s) is a commercial invoice. The invoice is required for the entry (19 CFR 141.81): it provides values, quantities, descriptions and the parties.`,
          evidence: [],
          action: 'Upload the commercial invoice (or a pro-forma invoice with a commercial invoice to follow).',
        }),
      );
    }
    if (!ctx.bills.length && !ctx.airWaybills.length) {
      issues.push(
        makeIssue({
          code: 'MISSING_DOCUMENT',
          key: 'transport_document',
          severity: 'warning',
          category: 'missing_data',
          title: 'No bill of lading or air waybill',
          detail: 'Without a transport document the bill numbers, carrier, container(s), manifest quantity, gross weight and export date come only from the invoice, or are missing.',
          evidence: [],
          action: 'Upload the house (and master) bill of lading or air waybill, or the carrier\'s arrival notice.',
        }),
      );
    }
    const combined = ctx.invoices.some((i) => i.combined);
    if (!ctx.packingLists.length && !combined && ctx.invoices.length) {
      issues.push(
        makeIssue({
          code: 'MISSING_DOCUMENT',
          key: 'packing_list',
          severity: 'info',
          category: 'missing_data',
          title: 'No packing list',
          detail: 'Without a packing list the invoice quantities cannot be cross-checked against what was packed, and net weights per line (often the second tariff quantity, kg) are unavailable.',
          evidence: [],
          action: 'Upload the packing list if available; otherwise net weights must be obtained from the shipper.',
        }),
      );
    }
    return issues;
  },
};
