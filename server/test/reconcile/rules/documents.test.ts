/** Document-level rules: missing documents/fields, unrecognized documents, OCR verification. */
import { describe, expect, it } from 'vitest';
import { missingDocumentRule } from '../../../src/reconcile/rules/missingDocument';
import { missingFieldRule } from '../../../src/reconcile/rules/missingField';
import { ocrVerifyRule } from '../../../src/reconcile/rules/ocrVerify';
import { unrecognizedDocumentRule } from '../../../src/reconcile/rules/unrecognizedDocument';
import { addr, BASE_LINES, baseDocs, billOfLading, ids, invLine, invoice, otherDoc, packingList, runRule, SELLER } from '../helpers';

describe('MISSING_DOCUMENT', () => {
  it('passes with invoice, packing list and B/L', () => {
    expect(runRule(missingDocumentRule, baseDocs()).issues).toEqual([]);
  });

  it('grades a missing invoice, transport document and packing list', () => {
    const none = runRule(missingDocumentRule, [packingList()]).issues;
    expect(none.map((i) => [i.id, i.severity])).toEqual([
      ['MISSING_DOCUMENT:commercial_invoice', 'blocker'],
      ['MISSING_DOCUMENT:transport_document', 'warning'],
    ]);
    const onlyInvoice = runRule(missingDocumentRule, [invoice()]).issues;
    expect(onlyInvoice.map((i) => [i.id, i.severity])).toEqual([
      ['MISSING_DOCUMENT:transport_document', 'warning'],
      ['MISSING_DOCUMENT:packing_list', 'info'],
    ]);
  });

  it('does not ask for a packing list when the invoice is a combined invoice/packing list', () => {
    const combined = invoice({ packingTotals: { cartons: 60, grossWeightKg: 440 } }, { docType: 'invoice_packing_list' });
    expect(ids(runRule(missingDocumentRule, [combined, billOfLading()]).issues)).toEqual([]);
  });
});

describe('MISSING_FIELD', () => {
  it('passes when everything critical is stated', () => {
    expect(runRule(missingFieldRule, [invoice({ manufacturer: SELLER }), packingList(), billOfLading()]).issues).toEqual([]);
  });

  it('blocks lines without quantity or value and shipments without any origin', () => {
    const lines = [invLine({ lineNo: 1, styleNo: 'X-1', description: 'GADGET' })];
    const { issues } = runRule(missingFieldRule, [invoice({ lines, countryOfOrigin: undefined, totals: [], seller: addr('ACME TRADING', 'HK') })]);
    const byId = Object.fromEntries(issues.map((i) => [i.id, i.severity]));
    expect(byId).toMatchObject({ 'MISSING_FIELD:quantity': 'blocker', 'MISSING_FIELD:value': 'blocker', 'MISSING_FIELD:origin': 'blocker', 'MISSING_FIELD:manufacturer': 'warning' });
  });

  it('takes a missing invoice quantity from the packing list with a warning', () => {
    const lines = structuredClone(BASE_LINES);
    lines[0].quantity = 0;
    const { issues, ctx } = runRule(missingFieldRule, [invoice({ lines, manufacturer: SELLER }), packingList()]);
    expect(issues.find((i) => i.id === 'MISSING_FIELD:quantity-from-packing-list')?.severity).toBe('warning');
    expect(ctx.shipment.invoices[0].lines[0].quantity).toMatchObject({ value: 1000, status: 'derived' });
  });

  it('warns about assumed currency, missing incoterm/importer and a manufacturer outside the origin country', () => {
    const lines = structuredClone(BASE_LINES);
    lines[1].countryOfOrigin = 'BD';
    const inv = invoice({ lines, currency: undefined, incoterm: undefined, buyer: undefined, manufacturer: SELLER });
    const { issues } = runRule(missingFieldRule, [inv]);
    const byId = Object.fromEntries(issues.map((i) => [i.id, i.severity]));
    expect(byId).toMatchObject({
      'MISSING_FIELD:currency': 'warning',
      'MISSING_FIELD:incoterm': 'warning',
      'MISSING_FIELD:importer': 'blocker',
      'MISSING_FIELD:manufacturer-country:inv0-line2': 'warning',
    });
  });

  it('notes a manufacturer assumed from the shipper as info', () => {
    const { issues, ctx } = runRule(missingFieldRule, baseDocs());
    expect(ids(issues)).toEqual(['MISSING_FIELD:manufacturer-assumed']);
    expect(issues[0].severity).toBe('info');
    expect(ctx.shipment.invoices[0].lines[0].manufacturer?.name).toBe(SELLER.name);
  });
});

describe('UNRECOGNIZED_DOCUMENT', () => {
  it('passes when every document is recognized', () => {
    expect(runRule(unrecognizedDocumentRule, baseDocs()).issues).toEqual([]);
  });

  it('notes unclassified documents', () => {
    const { issues } = runRule(unrecognizedDocumentRule, [invoice(), otherDoc('t-coo', 'other', 'CERTIFICATE OF ORIGIN Form A ...', 'CERTIFICATE OF ORIGIN')]);
    expect(issues[0]).toMatchObject({ id: 'UNRECOGNIZED_DOCUMENT:t-coo', severity: 'info' });
    expect(issues[0].evidence[0].text).toMatch(/CERTIFICATE OF ORIGIN/);
  });
});

describe('OCR_VERIFY', () => {
  it('passes for clean readings (and ignores conf ≥ 70 without repair)', () => {
    expect(runRule(ocrVerifyRule, baseDocs()).issues).toEqual([]);
    const ok = packingList({}, { fieldMeta: { 'lines[0].totalPcs': { conf: 88 } } });
    expect(runRule(ocrVerifyRule, [ok]).issues).toEqual([]);
  });

  it('lists low-confidence and repaired fields plus handwriting, one issue per document', () => {
    const pl = packingList({}, {
      fieldMeta: {
        'lines[0].totalPcs': { conf: 55 },
        'totals.grossWeightKg': { conf: 81, repaired: true, originalText: '44O' },
      },
      observations: [{ kind: 'handwritten', text: 'Handwritten note: 2 cartons damaged', page: 1 }],
    });
    const { issues } = runRule(ocrVerifyRule, [invoice(), pl]);
    expect(ids(issues)).toEqual(['OCR_VERIFY:t-pl']);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].detail).toMatch(/lines\[0\]\.totalPcs = 1000 \(conf 55\)/);
    expect(issues[0].detail).toMatch(/totals\.grossWeightKg = 440 \(conf 81, repaired from "44O"\)/);
    expect(issues[0].detail).toMatch(/handwritten: Handwritten note/);
    expect(issues[0].evidence).toHaveLength(3);
  });
});
