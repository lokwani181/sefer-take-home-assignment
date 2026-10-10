import { describe, expect, it } from 'vitest';
import type { BillOfLadingData, CommercialInvoiceData, ExtractedDocument, PackingListData } from '@app/shared';
import { accuracySummary, compareExtraction } from '../../src/parse/accuracy';

function doc(data: ExtractedDocument['data'], docType: ExtractedDocument['docType'] = data.kind as ExtractedDocument['docType']): ExtractedDocument {
  return { docId: 'd', fileName: 'f.pdf', docType, classificationScore: 1, source: 'text', pageCount: 1, data, fieldMeta: {}, observations: [], warnings: [] };
}

const invoice = (over: Partial<CommercialInvoiceData> = {}): CommercialInvoiceData => ({
  kind: 'commercial_invoice',
  invoiceNumber: 'INV-1',
  poNumbers: ['PO-1', 'PO-2'],
  lines: [
    { lineNo: 1, styleNo: 'A-1', description: "MEN'S T-SHIRT", details: ['100% cotton'], quantity: 100, unit: 'PCS', unitPrice: 2.5, amount: 250, composition: [{ fiber: 'cotton', pct: 100 }] },
    { lineNo: 2, styleNo: 'B-2', description: 'SAMPLES', details: [], quantity: 5, unit: 'PCS', unitPrice: 1, amount: 5, noCommercialValue: true, countryOfOrigin: 'BD' },
  ],
  charges: [{ type: 'freight', amount: 100, description: 'Ocean freight' }],
  totals: [{ label: 'TOTAL', amount: 255 }],
  assists: [{ description: 'fabric supplied by buyer', value: 40, styleRefs: ['A-1'] }],
  notes: [],
  buyer: { name: 'ACME TRADING, INC.', lines: ['1 Main St'], city: 'Kent', stateProvince: 'WA', postalCode: '98032', country: 'US', raw: '' },
  ...over,
});

const row = (rows: ReturnType<typeof compareExtraction>, field: string) => rows.find((r) => r.field === field)!;

describe('compareExtraction', () => {
  it('identical documents are 100% correct', () => {
    const rows = compareExtraction(doc(invoice()), doc(invoice()));
    const s = accuracySummary(rows);
    expect(s.criticalAccuracy).toBe(1);
    expect(s.overallAccuracy).toBe(1);
    expect(s.criticalTotal).toBeGreaterThan(10);
  });

  it('numbers within ±0.01, strings case/space-normalized, descriptions by similarity', () => {
    const exp = invoice();
    const act = invoice({
      invoiceNumber: 'inv-1 ',
      lines: [
        { ...exp.lines[0], unitPrice: 2.505, description: "MENS T-SHIRT" },
        { ...exp.lines[1] },
      ],
    });
    const rows = compareExtraction(doc(act), doc(exp));
    expect(row(rows, 'invoiceNumber').ok).toBe(true);
    expect(row(rows, 'lines[0].unitPrice').ok).toBe(true);
    expect(row(rows, 'lines[0].description').ok).toBe(true);
    const off = compareExtraction(doc(invoice({ lines: [{ ...exp.lines[0], amount: 252 }, exp.lines[1]] })), doc(exp));
    expect(row(off, 'lines[0].amount')).toMatchObject({ ok: false, critical: true });
  });

  it('addresses compare name + country + postal code only', () => {
    const exp = invoice();
    const act = invoice({ buyer: { ...exp.buyer!, name: 'Acme Trading Inc', lines: ['different street'], raw: 'x', city: 'KENT' } });
    const rows = compareExtraction(doc(act), doc(exp));
    expect(rows.filter((r) => r.field.startsWith('buyer')).map((r) => [r.field, r.ok])).toEqual([
      ['buyer.name', true],
      ['buyer.country', true],
      ['buyer.postalCode', true],
    ]);
  });

  it('arrays compare as sets', () => {
    const rows = compareExtraction(doc(invoice({ poNumbers: ['PO-2', 'PO-1'] })), doc(invoice()));
    expect(row(rows, 'poNumbers').ok).toBe(true);
    const extra = compareExtraction(doc(invoice({ poNumbers: ['PO-1', 'PO-2', 'PO-3'] })), doc(invoice()));
    expect(row(extra, 'poNumbers').ok).toBe(false);
  });

  it('a critical field the truth omits must be absent (no false NCV / origin)', () => {
    const exp = invoice();
    const act = invoice({ lines: [{ ...exp.lines[0], noCommercialValue: true, countryOfOrigin: 'CN' }, exp.lines[1]] });
    const rows = compareExtraction(doc(act), doc(exp));
    expect(row(rows, 'lines[0].noCommercialValue')).toMatchObject({ ok: false, critical: true });
    expect(row(rows, 'lines[0].countryOfOrigin')).toMatchObject({ ok: false, critical: true });
  });

  it('lines are aligned by line number, extra lines count against accuracy', () => {
    const exp = invoice();
    const act = invoice({ lines: [exp.lines[1], exp.lines[0], { ...exp.lines[0], lineNo: 3 }] });
    const rows = compareExtraction(doc(act), doc(exp));
    expect(row(rows, 'lines[0].styleNo').ok).toBe(true);
    expect(row(rows, 'lines.length')).toMatchObject({ ok: false, critical: true });
  });

  it('composition is compared as a set of fibre/percent pairs', () => {
    const exp = invoice();
    const wrong = invoice({ lines: [{ ...exp.lines[0], composition: [{ fiber: 'polyester', pct: 100 }] }, exp.lines[1]] });
    expect(row(compareExtraction(doc(wrong), doc(exp)), 'lines[0].composition')).toMatchObject({ ok: false, critical: true });
  });

  it('charges are matched by type, assists by index', () => {
    const exp = invoice();
    const rows = compareExtraction(doc(invoice({ charges: [{ type: 'freight', amount: 100, description: 'OCEAN FREIGHT' }], assists: [{ ...exp.assists[0], styleRefs: [] }] })), doc(exp));
    expect(row(rows, 'charges[0].amount').ok).toBe(true);
    expect(row(rows, 'assists[0].styleRefs')).toMatchObject({ ok: false, critical: true });
  });

  it('packing list lines align by style; totals are critical', () => {
    const pl: PackingListData = {
      kind: 'packing_list',
      invoiceRefs: [],
      poNumbers: [],
      remarks: [],
      lines: [
        { styleNo: 'A', description: 'x', details: [], cartons: 2, pcsPerCarton: 10, totalPcs: 20 },
        { styleNo: 'B', description: 'y', details: [], cartons: 1, pcsPerCarton: 5, totalPcs: 5 },
      ],
      totals: { cartons: 3, pcs: 25 },
    };
    const act: PackingListData = { ...pl, lines: [pl.lines[1], { ...pl.lines[0], totalPcs: 19 }], totals: { cartons: 3, pcs: 24 } };
    const rows = compareExtraction(doc(act), doc(pl));
    expect(row(rows, 'lines[0].totalPcs')).toMatchObject({ ok: false, critical: true, expected: 20, actual: 19 });
    expect(row(rows, 'lines[1].totalPcs').ok).toBe(true);
    expect(row(rows, 'totals.pcs')).toMatchObject({ ok: false, critical: true });
  });

  it('bill of lading critical fields and wrong document kinds', () => {
    const bl: BillOfLadingData = {
      kind: 'bill_of_lading',
      blType: 'house',
      blNumber: 'ABCD123456',
      exportReferences: [],
      containers: [{ number: 'CSQU3054383', checkDigitValid: true, sealNumbers: ['S1'] }],
      cargoDescription: [],
      hsCodes: [],
      charges: [],
      grossWeightKg: 100,
      packages: { count: 3, unit: 'CTNS' },
    };
    const rows = compareExtraction(doc({ ...bl, containers: [{ ...bl.containers[0], number: 'CSQU3054384' }], packages: { count: 4, unit: 'CTNS' } }), doc(bl));
    expect(row(rows, 'containers[0].number')).toMatchObject({ ok: false, critical: true });
    expect(row(rows, 'packages.count')).toMatchObject({ ok: false, critical: true });
    const kind = compareExtraction(doc(invoice()), doc(bl));
    expect(kind.map((r) => r.field)).toEqual(['docType', 'data.kind']);
    expect(accuracySummary(kind).criticalAccuracy).toBe(0);
  });
});
