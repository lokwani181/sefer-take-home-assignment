/**
 * The sample shipment (ground-truth parser output) through reconcile: every golden issue owned by
 * T3 is produced with the right severity/decision, nothing on the must-not list appears, and the
 * merged Shipment carries the golden values.
 */
import type { IssueCode } from '@app/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { reconcile } from '../../src/reconcile';
import { golden, sampleDocs } from './helpers';

const T3_CODES = new Set<IssueCode>([
  'LINE_AMOUNT_MISMATCH', 'TOTALS_MISMATCH', 'QTY_MISMATCH', 'COMPOSITION_CONFLICT', 'PACKAGE_COUNT_MISMATCH',
  'GROSS_WEIGHT_MISMATCH', 'CONTAINER_NUMBER_CORRECTED', 'CONTAINER_NUMBER_INVALID', 'ORIGIN_DIFFERS', 'DECLARATION_CONFLICT',
  'NCV_VALUE', 'ASSIST', 'NON_DUTIABLE_CHARGES', 'CHARGES_NOT_ITEMIZED', 'DATE_AMBIGUOUS', 'SELLER_NOT_MANUFACTURER',
  'FIRST_SALE_OPPORTUNITY', 'ULTIMATE_CONSIGNEE_ASSUMED', 'IMPORTER_ASSUMED', 'HOUSE_MASTER_BILL', 'ARRIVAL_ESTIMATED',
  'RELATED_PARTY_ASSUMED', 'OCR_VERIFY', 'MISSING_DOCUMENT', 'MISSING_FIELD', 'UNRECOGNIZED_DOCUMENT', 'UFLPA', 'ISF',
  'TELEX_RELEASE', 'COLLECT_CHARGES',
]);

let result: ReturnType<typeof reconcile>;
beforeAll(() => {
  result = reconcile(sampleDocs());
});

const byId = (id: string) => result.issues.find((i) => i.id === id);
const line = (id: string) => result.shipment.invoices.flatMap((i) => i.lines).find((l) => l.id === id);

describe('sample: golden issues', () => {
  const g = golden();
  const mine = g.expectedIssues.filter((e) => T3_CODES.has(e.id.split(':')[0] as IssueCode));

  it('covers the T3-owned golden issues', () => {
    expect(mine.length).toBeGreaterThanOrEqual(21);
  });

  it.each(mine.map((e) => [e.id, e] as const))('%s present with the golden severity/decision', (_id, e) => {
    const issue = byId(e.id);
    expect(issue, `missing ${e.id}`).toBeDefined();
    expect(issue?.severity).toBe(e.severity);
    if (e.decisionKey) {
      expect(issue?.decision?.key).toBe(e.decisionKey);
      expect(issue?.decision?.chosen).toBe(e.defaultChoice);
      expect(issue?.decision?.options.map((o) => o.value)).toContain(e.defaultChoice);
    }
  });

  it.each(g.mustNotHaveIssues)('does not raise %s', (id) => {
    if (id.includes(':')) expect(byId(id)).toBeUndefined();
    else expect(result.issues.filter((i) => i.code === id)).toEqual([]);
  });

  it('emits only T3-owned codes, with unique ids, title/detail/action and evidence', () => {
    const ids = result.issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of result.issues) {
      expect(T3_CODES.has(i.code)).toBe(true);
      expect(i.id === i.code || i.id.startsWith(`${i.code}:`)).toBe(true);
      expect(i.title.length).toBeGreaterThan(5);
      expect(i.detail.length).toBeGreaterThan(20);
      expect(i.action.length).toBeGreaterThan(10);
      for (const ev of i.evidence) {
        expect(['sample-ci', 'sample-pl', 'sample-bl']).toContain(ev.docId);
        expect(ev.page).toBeGreaterThanOrEqual(1);
        expect(ev.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('orders blockers before warnings before info', () => {
    const rank = { blocker: 0, warning: 1, info: 2 } as const;
    const ranks = result.issues.map((i) => rank[i.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('flags OCR repairs per document (PL and B/L), not the text-layer invoice', () => {
    expect(byId('OCR_VERIFY:sample-pl')?.detail).toMatch(/netWeightPerCartonKg.*14,60/);
    expect(byId('OCR_VERIFY:sample-bl')?.detail).toMatch(/containers\[0\]\.number/);
    expect(byId('OCR_VERIFY:sample-ci')).toBeUndefined();
  });

  it('explains the key judgment calls with numbers', () => {
    expect(byId('LINE_AMOUNT_MISMATCH:inv0-line1')?.detail).toMatch(/6,840\.00.*6,480\.00/);
    expect(byId('LINE_AMOUNT_MISMATCH:inv0-line1')?.detail).toMatch(/21,975\.00/);
    expect(byId('QTY_MISMATCH:inv0-line2')?.detail).toMatch(/1,176.*49 ctns × 24/);
    expect(byId('QTY_MISMATCH:inv0-line2')?.detail).toMatch(/coincidentally agree \(5,100/);
    expect(byId('QTY_MISMATCH:inv0-line2')?.detail).toMatch(/8,702\.40/);
    expect(byId('COMPOSITION_CONFLICT:inv0-line2')?.detail).toMatch(/predominates by weight/);
    expect(byId('COMPOSITION_CONFLICT:inv0-line2')?.detail).toMatch(/cotton vs man-made fibres/);
    expect(byId('ASSIST:inv0-line4')?.detail).toMatch(/1401a\(b\)\(1\)\(C\).*\(h\)\(1\)\(A\)/);
    expect(byId('ASSIST:inv0-line4')?.detail).toMatch(/1,260\.00 \+ USD 4,180\.00 = USD 5,440\.00/);
    expect(byId('NON_DUTIABLE_CHARGES')?.detail).toMatch(/3,850\.00.*185\.00.*4,035\.00/);
    expect(byId('GROSS_WEIGHT_MISMATCH')?.detail).toMatch(/1,930.*1,888.*2\.2%/);
    expect(byId('CONTAINER_NUMBER_CORRECTED')?.detail).toMatch(/OPLU3041728.*fails.*OPLU3041722/);
    expect(byId('DATE_AMBIGUOUS')?.detail).toMatch(/2026-09-12.*2026-12-09/);
    expect(byId('DECLARATION_CONFLICT')?.detail).toMatch(/Vietnam origin/);
    expect(byId('DECLARATION_CONFLICT')?.detail).toMatch(/Bangladesh/);
    expect(byId('NCV_VALUE:inv0-line5')?.detail).toMatch(/1\.00\/PCS/);
    expect(byId('ISF')?.detail).toMatch(/IMPORTER\/AGENT/);
  });
});

describe('sample: merged shipment', () => {
  it('has one invoice with 5 lines and the golden header values', () => {
    const s = result.shipment;
    expect(s.invoices).toHaveLength(1);
    const inv = s.invoices[0];
    expect(inv.lines.map((l) => l.id)).toEqual(['inv0-line1', 'inv0-line2', 'inv0-line3', 'inv0-line4', 'inv0-line5']);
    expect(inv.currency).toBe('USD');
    expect(inv.incoterm?.code).toBe('CIF');
    expect(inv.linesAreFob).toBe(true);
    expect(inv.charges.map((c) => [c.type, c.amount])).toEqual([['freight', 3850], ['insurance', 185]]);
    expect(inv.invoiceDate?.value).toBe('2026-09-12');
    expect(inv.invoiceDate?.status).toBe('derived');
    expect(inv.invoiceNumber.value).toBe('KBAS/NB/26-0912');
    expect(inv.relatedParty).toMatchObject({ value: false, status: 'assumed' });
  });

  it('corrects line 1 and keeps the printed amount', () => {
    expect(line('inv0-line1')?.amount).toMatchObject({ value: 6840, status: 'corrected' });
    expect(line('inv0-line1')?.printedAmount).toBe(6480);
  });

  it('keeps the invoice quantity of line 2 with the packed quantity and alternative composition', () => {
    const l2 = line('inv0-line2');
    expect(l2?.quantity.value).toBe(1200);
    expect(l2?.packedQuantity).toBe(1176);
    expect(l2?.attributes.composition).toEqual([{ fiber: 'cotton', pct: 60 }, { fiber: 'polyester', pct: 40 }]);
    expect(l2?.altComposition).toEqual([{ fiber: 'polyester', pct: 65 }, { fiber: 'cotton', pct: 35 }]);
    expect(l2?.altCompositionSource).toMatchObject({ docId: 'sample-pl', docType: 'packing_list' });
  });

  it('apportions the assist to line 4 only', () => {
    expect(line('inv0-line4')?.assists.map((a) => a.value)).toEqual([4180]);
    for (const id of ['inv0-line1', 'inv0-line2', 'inv0-line3', 'inv0-line5']) expect(line(id)?.assists).toEqual([]);
  });

  it('gives line 5 its own origin, NCV value and Bangladeshi manufacturer', () => {
    const l5 = line('inv0-line5');
    expect(l5?.countryOfOrigin.value).toBe('BD');
    expect(l5?.noCommercialValue).toBe(true);
    expect(l5?.customsValue).toBe(24);
    expect(l5?.manufacturer?.name).toMatch(/SP Garments Dhaka/i);
    expect(l5?.manufacturer?.country).toBe('BD');
  });

  it('gives lines 1-4 Vietnamese origin and the Saigon Phoenix factory', () => {
    for (const id of ['inv0-line1', 'inv0-line2', 'inv0-line3', 'inv0-line4']) {
      const l = line(id);
      expect(l?.countryOfOrigin.value).toBe('VN');
      expect(l?.manufacturer?.name).toMatch(/SAIGON PHOENIX/i);
      expect(l?.manufacturer?.country).toBe('VN');
    }
  });

  it('carries packing-list weights and cartons per line', () => {
    expect([1, 2, 3, 4, 5].map((n) => line(`inv0-line${n}`)?.netWeightKg?.value)).toEqual([432, 715.4, 486, 96, 5.1]);
    expect([1, 2, 3, 4, 5].map((n) => line(`inv0-line${n}`)?.cartons)).toEqual([48, 49, 30, 10, 1]);
    expect(line('inv0-line2')?.netWeightKg?.sources[0]).toMatchObject({ docId: 'sample-pl', field: 'lines[1].netWeightKg' });
  });

  it('splits the house and master bills', () => {
    expect(result.shipment.bills).toEqual([{ master: { scac: 'OPLU', number: 'SGN260917735' }, house: { scac: 'BMLV', number: 'HCM26090418' } }]);
  });

  it('chooses the check-digit-valid container and keeps the seal', () => {
    expect(result.shipment.containers).toHaveLength(1);
    expect(result.shipment.containers[0]).toMatchObject({ number: 'OPLU3041722', checkDigitValid: true, sealNumbers: ['OPL7731482'] });
  });

  it('takes packages and gross weight from the transport document', () => {
    expect(result.shipment.packages?.value).toEqual({ count: 138, unit: 'CARTONS' });
    expect(result.shipment.grossWeightKg).toMatchObject({ value: 1930, sources: [{ docId: 'sample-bl' }] });
  });

  it('sets transport dates, mode and destination', () => {
    const t = result.shipment.transport;
    expect(t.mode).toBe('ocean');
    expect(t.containerized).toBe(true);
    expect(t.vessel).toBe('PACIFIC ARGOS');
    expect(t.voyage).toBe('041E');
    expect(t.carrierScac).toBe('OPLU');
    expect(t.exportDate?.value).toBe('2026-09-24');
    expect(t.exportDate?.conf).toBe(60);
    expect(t.arrivalDate?.value).toBe('2026-10-14');
    expect(t.arrivalDateEstimated).toBe(true);
    expect(t.destinationState).toBe('WA');
    expect(result.shipment.countryOfExport).toBe('VN');
    expect(result.shipment.releaseType).toBe('telex');
  });

  it('uses Northbound as importer and ultimate consignee, Cascade as ship-to', () => {
    const s = result.shipment;
    expect(s.importer?.value.name).toMatch(/NORTHBOUND OUTFITTERS/);
    expect(s.ultimateConsignee?.value.name).toMatch(/NORTHBOUND OUTFITTERS/);
    expect(s.ultimateConsignee?.status).toBe('assumed');
    expect(s.shipTo?.name).toMatch(/CASCADE FULFILLMENT/);
    expect(s.seller?.name).toMatch(/KOWLOON BAY/);
    expect(s.consolidator?.name).toMatch(/BLUE MERIDIAN/);
    expect(s.manufacturers.map((m) => m.country)).toEqual(['VN', 'BD']);
  });

  it('is deterministic and does not mutate its input', () => {
    const docs = sampleDocs();
    const before = JSON.stringify(docs);
    const a = reconcile(docs);
    const b = reconcile(docs);
    expect(JSON.stringify(docs)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('gives the same ids and values regardless of document order', () => {
    const [ci, pl, bl] = sampleDocs();
    const r = reconcile([bl, pl, ci]);
    expect(r.issues.map((i) => i.id).sort()).toEqual(result.issues.map((i) => i.id).sort());
    expect(r.shipment.invoices[0].lines.map((l) => l.amount.value)).toEqual(result.shipment.invoices[0].lines.map((l) => l.amount.value));
  });
});
