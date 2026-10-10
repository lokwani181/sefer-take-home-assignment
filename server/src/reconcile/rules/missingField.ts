/**
 * MISSING_FIELD: critical data absent from every document (line quantity/value, country of origin,
 * importer, invoice number) is a blocker; data that had to be assumed or taken from a secondary
 * document (currency, incoterm, manufacturer, dates, bill number) is a warning/info.
 */
import type { Issue, IssueSeverity } from '@app/shared';
import type { LineLink, ReconcileContext, Rule } from '../context';
import { invoiceKey, linePath } from '../context';
import { countryName } from '../lib/countries';
import { makeIssue } from '../lib/issues';
import { partyName } from '../lib/parties';
import { lineName, listText } from './helpers';

interface LineProblem {
  kind: string;
  severity: IssueSeverity;
  title: string;
  /** Sentence describing the problem, given the affected line names. */
  detail: (lines: string) => string;
  action: string;
  field: string;
}

const PROBLEMS: Record<string, LineProblem> = {
  quantity: {
    kind: 'quantity', severity: 'blocker', title: 'Line quantity missing',
    detail: (l) => `No quantity was found for ${l} on any document.`,
    action: 'Enter the invoiced quantity for these lines from the original invoice.', field: 'quantity',
  },
  'quantity-from-packing-list': {
    kind: 'quantity-from-packing-list', severity: 'warning', title: 'Line quantity taken from the packing list',
    detail: (l) => `The invoice shows no quantity for ${l}; the packed quantity from the packing list is used.`,
    action: 'Confirm the invoiced quantity with the seller.', field: 'quantity',
  },
  value: {
    kind: 'value', severity: 'blocker', title: 'Line value missing',
    detail: (l) => `No amount, unit price or customs value was found for ${l}.`,
    action: 'Enter the line value from the original invoice (or obtain it from the seller).', field: 'amount',
  },
  origin: {
    kind: 'origin', severity: 'blocker', title: 'Country of origin missing',
    detail: (l) => `No country of origin is stated for ${l} on the invoice, packing list or transport document, and no manufacturer country is known.`,
    action: 'Obtain the country of origin from the seller (or a certificate of origin) and enter it.', field: 'countryOfOrigin',
  },
  'origin-assumed': {
    kind: 'origin-assumed', severity: 'warning', title: 'Country of origin assumed from the manufacturer',
    detail: (l) => `No document states the origin of ${l}; the manufacturer's country is used.`,
    action: 'Confirm the country of origin with the seller.', field: 'countryOfOrigin',
  },
  manufacturer: {
    kind: 'manufacturer', severity: 'warning', title: 'Manufacturer not identified',
    detail: (l) => `No manufacturer is named for ${l}, so the MID (manufacturer identification code) cannot be built.`,
    action: 'Obtain the manufacturer\'s name and full address from the seller.', field: 'manufacturer',
  },
};

function lineProblems(link: LineLink): { kind: string; extra?: string }[] {
  const out: { kind: string; extra?: string }[] = [];
  const l = link.line;
  if (l.quantity.status === 'assumed') out.push({ kind: 'quantity' });
  else if (l.quantity.status === 'derived' && !link.invLine.quantity) out.push({ kind: 'quantity-from-packing-list' });
  if (l.amount.status === 'assumed' && !(l.customsValue && l.customsValue > 0)) out.push({ kind: 'value' });
  if (!l.countryOfOrigin.value) out.push({ kind: 'origin' });
  else if (l.countryOfOrigin.status === 'assumed') out.push({ kind: 'origin-assumed' });
  if (!l.manufacturer?.name) out.push({ kind: 'manufacturer' });
  return out;
}

function lineIssues(ctx: ReconcileContext): Issue[] {
  const by = new Map<string, LineLink[]>();
  for (const link of ctx.links) for (const p of lineProblems(link)) by.set(p.kind, [...(by.get(p.kind) ?? []), link]);
  const issues: Issue[] = [];
  for (const [kind, links] of by) {
    const p = PROBLEMS[kind];
    issues.push(
      makeIssue({
        code: 'MISSING_FIELD',
        key: kind,
        severity: p.severity,
        category: 'missing_data',
        title: `${p.title} (${links.length} line${links.length === 1 ? '' : 's'})`,
        detail: p.detail(listText(links.map(lineName))),
        evidence: [],
        action: p.action,
        field: links.length === 1 ? linePath(links[0], p.field) : undefined,
        lineId: links.length === 1 ? links[0].line.id : undefined,
      }),
    );
  }

  // Manufacturer assumed from the seller/shipper, or located outside the line's origin country.
  const assumed = ctx.links.filter((l) => ctx.manufacturerAssumed.has(l.line.id));
  if (assumed.length) {
    const roles = [...new Set(assumed.map((l) => ctx.manufacturerAssumed.get(l.line.id) as string))];
    const names = [...new Set(assumed.map((l) => partyName(l.line.manufacturer)))];
    issues.push(
      makeIssue({
        code: 'MISSING_FIELD',
        key: 'manufacturer-assumed',
        severity: 'info',
        category: 'assumption',
        title: `Manufacturer assumed: ${listText(names)}`,
        detail: `No manufacturer is named for ${listText(assumed.map(lineName))}; the ${listText(roles)} (${listText(names)}), located in the country of origin, is assumed to be the manufacturer for the MID.`,
        evidence: [],
        action: 'Confirm with the seller that this party actually produced the goods; otherwise obtain the factory name and address.',
      }),
    );
  }
  const wrongCountry = ctx.links.filter((l) => l.line.manufacturer?.country && l.line.countryOfOrigin.value && l.line.manufacturer.country !== l.line.countryOfOrigin.value);
  for (const l of wrongCountry) {
    issues.push(
      makeIssue({
        code: 'MISSING_FIELD',
        key: `manufacturer-country:${l.line.id}`,
        severity: 'warning',
        category: 'missing_data',
        title: `${lineName(l)}: no manufacturer in ${countryName(l.line.countryOfOrigin.value)}`,
        detail: `${lineName(l)} is of ${countryName(l.line.countryOfOrigin.value)} origin but the only manufacturer found is ${partyName(l.line.manufacturer)} (${l.line.manufacturer?.country}). The MID must identify the producer in the country of origin.`,
        evidence: [],
        action: `Obtain the name and address of the ${countryName(l.line.countryOfOrigin.value)} factory for this line.`,
        field: linePath(l, 'manufacturer'),
        lineId: l.line.id,
      }),
    );
  }
  return issues;
}

function headerIssues(ctx: ReconcileContext): Issue[] {
  const issues: Issue[] = [];
  const s = ctx.shipment;
  if (ctx.invoices.length && !s.importer) {
    issues.push(
      makeIssue({
        code: 'MISSING_FIELD', key: 'importer', severity: 'blocker', category: 'missing_data',
        title: 'Importer not identified',
        detail: 'No buyer/sold-to party on the invoice and no usable notify party or consignee on the other documents.',
        evidence: [], action: 'Enter the importer of record (name, address and IRS/EIN number).', field: 'importer',
      }),
    );
  }
  for (const inv of ctx.invoices) {
    const k = invoiceKey(ctx, inv);
    const suffix = k ? `:${k}` : '';
    if (!inv.data.invoiceNumber) {
      issues.push(makeIssue({ code: 'MISSING_FIELD', key: `invoiceNumber${suffix}`, severity: 'blocker', category: 'missing_data', title: 'Invoice number missing', detail: `The invoice ${inv.doc.fileName} has no readable invoice number; it is required on the entry.`, evidence: [], action: 'Enter the invoice number from the original document.', field: `invoices[${inv.index}].invoiceNumber` }));
    }
    if (!(inv.data.lines ?? []).length) {
      issues.push(makeIssue({ code: 'MISSING_FIELD', key: `lines${suffix}`, severity: 'blocker', category: 'missing_data', title: 'No invoice lines read', detail: `No line items could be read from ${inv.doc.fileName}.`, evidence: [], action: 'Check the invoice scan quality and enter the line items manually.', field: `invoices[${inv.index}].lines` }));
    }
    if (inv.currencyInferred) {
      issues.push(makeIssue({
        code: 'MISSING_FIELD', key: `currency${suffix}`, severity: 'warning', category: 'assumption',
        title: `Invoice currency ${inv.currencyInferred === 'text' ? 'inferred' : 'assumed'}: ${inv.invoice.currency}`,
        detail: inv.currencyInferred === 'text' ? `No currency field was read; ${inv.invoice.currency} is named in the invoice totals or notes.` : 'No currency is stated on the invoice; USD is assumed.',
        evidence: [], action: 'Confirm the invoice currency.', field: `invoices[${inv.index}].currency`,
      }));
    }
    if (!inv.invoice.incoterm) {
      issues.push(makeIssue({
        code: 'MISSING_FIELD', key: `incoterm${suffix}`, severity: 'warning', category: 'missing_data',
        title: 'Terms of sale (Incoterm) not stated',
        detail: 'Without the terms of sale it is unknown whether the prices include international freight and insurance, which are not dutiable.',
        evidence: [], action: 'Confirm the Incoterm with the seller (e.g. FOB, CIF, DDP).', field: `invoices[${inv.index}].incoterm`,
      }));
    }
    if (!inv.data.seller?.name) {
      issues.push(makeIssue({ code: 'MISSING_FIELD', key: `seller${suffix}`, severity: 'warning', category: 'missing_data', title: 'Seller not identified', detail: `No seller/exporter could be read from ${inv.doc.fileName}.`, evidence: [], action: 'Enter the seller\'s name and address (selling party).', field: `invoices[${inv.index}].seller` }));
    }
  }
  if (ctx.transport) {
    if (!s.bills.length) {
      issues.push(makeIssue({ code: 'MISSING_FIELD', key: 'bill', severity: 'warning', category: 'missing_data', title: 'Bill number not read', detail: 'The transport document was recognized but no bill of lading / air waybill number could be read.', evidence: [], action: 'Enter the house and master bill numbers.', field: 'bills' }));
    }
    if (!s.transport.exportDate) {
      issues.push(makeIssue({ code: 'MISSING_FIELD', key: 'exportDate', severity: 'warning', category: 'missing_data', title: 'Export date not found', detail: 'No on-board, issue or flight date (nor an invoice ETD) was found.', evidence: [], action: 'Enter the date the goods left the export country.', field: 'transport.exportDate' }));
    }
  }
  if (ctx.invoices.length && !s.transport.arrivalDate) {
    issues.push(makeIssue({ code: 'MISSING_FIELD', key: 'arrivalDate', severity: 'warning', category: 'missing_data', title: 'Arrival date not found', detail: 'No ETA or arrival notice date was found.', evidence: [], action: 'Enter the arrival date from the carrier\'s arrival notice.', field: 'transport.arrivalDate' }));
  }
  return issues;
}

export const missingFieldRule: Rule = {
  name: 'missing-field',
  codes: ['MISSING_FIELD'],
  run: (ctx) => [...lineIssues(ctx), ...headerIssues(ctx)],
};
