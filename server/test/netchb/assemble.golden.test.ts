import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AssembleOutput, BrokerInputs, EntryLineItem, Issue } from '@app/shared';
import { assembleEntry } from '../../src/netchb';
import {
  sampleAltClassifications,
  sampleClassifications,
  sampleIssues,
  sampleShipment,
  stubLookups,
} from './fixtures/sample';

interface GoldenLine {
  lineId: string;
  styleNo: string;
  tariffPrefix: string;
  altTariffPrefix?: string;
  countryOrigin: string;
  value: number;
  quantity1: number;
  unitOfMeasure1: string;
  quantity2: number;
  unitOfMeasure2: string;
  midCountry: string;
}

interface Golden {
  invoiceNoNormalized: string;
  header: Record<string, string | number>;
  exportDate: string;
  countryExport: string;
  billsOfLading: Record<string, string | number>[];
  containers: Record<string, string>[];
  lines: GoldenLine[];
  decisionFlips: {
    decisions: Record<string, string>;
    expect: Partial<GoldenLine> & { lineId: string };
    /** The decision-carrying issue after the broker's explicit choice (blockers drop to warning). */
    issueAfter?: { id: string; severity: string };
  }[];
  expectedIssues: { id: string; severity: string; decisionKey?: string; defaultChoice?: string }[];
  mustNotHaveIssues: string[];
  brokerInputsClearBlockers: { inputs: BrokerInputs; clears: string[] };
}

const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'golden', 'sample-expected.json'), 'utf8'),
) as Golden;

/** Codes T5 emits (PLAN/types.ts [T5 assemble]); the rest of expectedIssues come from reconcile. */
const T5_CODES = new Set([
  'HTS_RESOLVED', 'HTS_LOW_CONFIDENCE', 'HTS_NOT_DECLARED', 'CHAPTER_MISMATCH', 'MISSING_IMPORTER_ID', 'MISSING_CONSIGNEE_ID',
  'MISSING_BOND', 'MISSING_SURETY', 'MISSING_LOCATION_OF_GOODS', 'MID_VERIFY', 'PORT_UNKNOWN', 'LADING_PORT_UNKNOWN',
  'INVOICE_NO_NORMALIZED', 'BILL_NO_NORMALIZED', 'CHAPTER_99_NOT_COMPUTED', 'AUTO_REMEDIES', 'CURRENCY_CONVERSION',
  'WEIGHT_PRORATED', 'ENTRY_DATE_DEFAULTED', 'XSD_INVALID', 'FIELD_OMITTED', 'BROKER_INPUT_INVALID', 'MANIFEST_QUANTITY_UNKNOWN',
]);

function run(brokerInputs: BrokerInputs = {}): AssembleOutput {
  return assembleEntry({
    shipment: sampleShipment(),
    classifications: sampleClassifications(),
    altClassifications: sampleAltClassifications(),
    brokerInputs,
    issues: sampleIssues(),
    lookups: stubLookups(),
  });
}

function lineItem(out: AssembleOutput, lineId: string): EntryLineItem {
  const item = out.entryModel.invoices.flatMap((i) => i.lineItems).find((l) => l.lineId === lineId);
  if (!item) throw new Error(`no line item ${lineId}`);
  return item;
}

const issue = (out: AssembleOutput, id: string): Issue | undefined => out.issues.find((i) => i.id === id);

describe('assembleEntry: sample shipment matches the golden file', () => {
  const out = run();
  const m = out.entryModel;

  it.each(Object.entries(golden.header))('header.%s = %s', (key, value) => {
    expect((m.header as unknown as Record<string, unknown>)[key]).toEqual(value);
  });

  it('defaults the entry date to the arrival date and import date to arrival', () => {
    expect(m.header.entryDate).toBe(golden.header.arrivalDate);
    expect(m.header.importDate).toBe(golden.header.arrivalDate);
    expect(issue(out, 'ENTRY_DATE_DEFAULTED')?.severity).toBe('info');
  });

  it('derives a short commodity description and the customer reference', () => {
    expect(m.header.description).toBe('WEARING APPAREL');
    expect(m.header.customerReferenceNo).toBe('NB-26-0918');
  });

  it('uses a system-generated entry number and enables auto-apply-remedies by default', () => {
    expect(m.entryNo).toEqual({ kind: 'system' });
    expect(m.autoApplyRemedies).toBe(true);
  });

  it('normalizes the invoice number', () => {
    expect(m.invoices).toHaveLength(1);
    expect(m.invoices[0].invoiceNo).toBe(golden.invoiceNoNormalized);
    expect(m.invoices[0].foreignCurrency).toBeUndefined();
  });

  it('builds the manifest from the house/master bills', () => {
    expect(m.manifest.billsOfLading).toEqual(golden.billsOfLading);
  });

  it('builds containers with XSD size/type and seals', () => {
    expect(m.containers).toHaveLength(golden.containers.length);
    expect(m.containers[0]).toMatchObject(golden.containers[0]);
    expect(m.containers[0]).toMatchObject({ containerSize: '20 ft', containerType: 'Dry' });
  });

  it.each(golden.lines.map((l) => [l.lineId, l] as const))('%s: tariff, value, origin, quantities, MID', (lineId, g) => {
    const li = lineItem(out, lineId);
    const t = li.tariffs[0];
    expect(li.tariffs).toHaveLength(1);
    expect(t.tariffNo).toMatch(/^\d{10}$/);
    expect(t.tariffNo.startsWith(g.tariffPrefix)).toBe(true);
    expect(t.value).toBe(g.value);
    expect(li.countryOrigin).toBe(g.countryOrigin);
    expect(t.quantity1).toBe(g.quantity1);
    expect(t.unitOfMeasure1).toBe(g.unitOfMeasure1);
    expect(t.quantity2).toBe(g.quantity2);
    expect(t.unitOfMeasure2).toBe(g.unitOfMeasure2);
    expect(li.manufacturerId?.slice(0, 2)).toBe(g.midCountry);
    expect(li.exportDate).toBe(golden.exportDate);
    expect(li.countryExport).toBe(golden.countryExport);
    expect(li.relatedParty).toBe('N');
  });

  it('keeps the line order of the invoice', () => {
    expect(m.invoices[0].lineItems.map((l) => l.lineId)).toEqual(golden.lines.map((l) => l.lineId));
  });

  it('totals: entry value is the sum of tariff values, charges = itemized freight + insurance', () => {
    const sum = m.invoices.flatMap((i) => i.lineItems).reduce((s, l) => s + l.tariffs[0].value, 0);
    expect(sum).toBe(27439);
    expect(m.header.totalEntryValue).toBe(sum);
    expect(m.header.charges).toBe(4035);
  });

  it('line 4 includes the assist and line 5 uses the stated NCV value', () => {
    const v4 = out.valuations.find((v) => v.lineId === 'inv0-line4')!;
    expect(v4.enteredValue).toBe(5440);
    expect(v4.steps.map((s) => s.amount)).toEqual([1260, 4180]);
    expect(v4.steps[1].label).toMatch(/assist/i);
    const v5 = out.valuations.find((v) => v.lineId === 'inv0-line5')!;
    expect(v5.enteredValue).toBe(24);
    expect(v5.steps[0].label).toMatch(/NCV/);
  });

  it('valuations: one per line, steps sum to the entered value', () => {
    expect(out.valuations).toHaveLength(5);
    for (const v of out.valuations) {
      const sum = v.steps.reduce((s, x) => s + x.amount, 0);
      expect(Math.abs(sum - v.enteredValue)).toBeLessThan(0.011);
      expect(v.currency).toBe('USD');
    }
  });

  it('line gross weights come from the packing list, rounded', () => {
    expect(golden.lines.map((l) => lineItem(out, l.lineId).grossWeight)).toEqual([480, 774, 522, 106, 6]);
    expect(out.issues.some((i) => i.code === 'WEIGHT_PRORATED')).toBe(false);
  });

  it('textile categories and commercial descriptions with fibre content', () => {
    expect(lineItem(out, 'inv0-line1').categoryNo).toBe('338');
    const d2 = lineItem(out, 'inv0-line2').commercialDescription!;
    expect(d2).toContain('HOODIE');
    expect(d2).toContain('60% COTTON 40% POLYESTER');
    for (const l of m.invoices[0].lineItems) expect(l.commercialDescription!.length).toBeLessThanOrEqual(70);
  });

  it('cargo release parties: SE seller, BY buyer, ST ship-to, MF manufacturers; never CN; max 5', () => {
    const codes = m.cargoReleaseParties.map((p) => p.entityCode);
    expect(codes.slice(0, 3)).toEqual(['SE', 'BY', 'ST']);
    expect(codes).toContain('MF');
    expect(codes).not.toContain('CN');
    expect(codes.length).toBeLessThanOrEqual(5);
    const se = m.cargoReleaseParties[0];
    expect(se.entityName).toBe('KOWLOON BAY APPAREL SOURCING LTD');
    expect(se.address?.country).toBe('HK');
    for (const p of m.cargoReleaseParties) {
      expect(p.entityName!.length).toBeLessThanOrEqual(35);
      for (const c of p.address?.addressComponents ?? []) expect(c.length).toBeLessThanOrEqual(35);
    }
    // The consolidator has no address on the documents, so it is reported rather than sent: a field-level
    // omission (FIELD_OMITTED), not a schema failure (the XML is valid).
    expect(issue(out, 'FIELD_OMITTED:cargoReleaseParties')?.detail).toMatch(/CS BLUE MERIDIAN/);
    expect(out.issues.filter((i) => i.code === 'XSD_INVALID').map((i) => i.id)).toEqual([]);
  });

  it('MID comes from the manufacturer, not the seller', () => {
    expect(lineItem(out, 'inv0-line1').manufacturerId).toMatch(/^VN/);
    expect(lineItem(out, 'inv0-line5').manufacturerId).toMatch(/^BD/);
    expect(out.issues.find((i) => i.code === 'MID_VERIFY')?.severity).toBe('warning');
  });

  it('every expected issue is present with its severity and default decision', () => {
    const ids = new Set(out.issues.map((i) => i.id));
    const inputIds = new Set(sampleIssues().map((i) => i.id));
    for (const exp of golden.expectedIssues) {
      const code = exp.id.split(':')[0];
      if (!T5_CODES.has(code) && !inputIds.has(exp.id)) continue; // reconcile-owned and not in our stub input
      expect(ids.has(exp.id), exp.id).toBe(true);
      const found = issue(out, exp.id)!;
      expect(found.severity, exp.id).toBe(exp.severity);
      if (exp.decisionKey) {
        expect(found.decision?.key).toBe(exp.decisionKey);
        expect(found.decision?.chosen).toBe(exp.defaultChoice);
      }
    }
  });

  it('emits none of the mustNotHave issues', () => {
    const ids = new Set(out.issues.map((i) => i.id));
    for (const id of golden.mustNotHaveIssues) expect(ids.has(id), id).toBe(false);
  });

  it('passes the reconcile issues through and adds HTS_RESOLVED per line', () => {
    for (const i of sampleIssues()) expect(issue(out, i.id)).toBeDefined();
    for (const l of golden.lines) {
      const h = issue(out, `HTS_RESOLVED:${l.lineId}`)!;
      expect(h.severity).toBe('info');
      expect(h.title).toMatch(/-> \d{4}\.\d{2}\.\d{2}\.\d{2} /);
    }
    expect(issue(out, 'HTS_RESOLVED:inv0-line1')!.title).toContain("6109.10 -> 6109.10.00.12 Other T-shirts: Men's (338), 16.5%");
  });

  it('every issue has a title, detail and action; ids are unique', () => {
    const ids = out.issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of out.issues) {
      expect(i.title, i.id).toBeTruthy();
      expect(i.detail, i.id).toBeTruthy();
      expect(i.action, i.id).toBeTruthy();
    }
  });

  it('CHAPTER_99_NOT_COMPUTED names the origins and the entry date', () => {
    const c = issue(out, 'CHAPTER_99_NOT_COMPUTED')!;
    expect(c.detail).toContain('VN');
    expect(c.detail).toContain('BD');
    expect(c.detail).toContain('2026-10-14');
    expect(c.detail).toMatch(/auto-apply-remedies is enabled/);
  });

  it('estimates: per-line duty, MPF clamp, HMF for ocean', () => {
    const e = out.estimates;
    expect(e.lines.find((l) => l.lineId === 'inv0-line1')).toMatchObject({ ratePct: 16.5, duty: 1128.6, enteredValue: 6840 });
    expect(e.lines.find((l) => l.lineId === 'inv0-line4')?.duty).toBe(1463.36);
    expect(e.mpf).toBe(95.05);
    expect(e.hmf).toBe(34.3);
    expect(e.totalDuty).toBeCloseTo(5100.22, 2);
    expect(e.notes.join(' ')).toMatch(/Chapter 99/);
    expect(e.notes.join(' ')).toMatch(/[Cc]otton fee/);
  });
});

describe('assembleEntry: decision flips', () => {
  it.each(golden.decisionFlips.map((f) => [JSON.stringify(f.decisions), f] as const))('%s', (_label, flip) => {
    const out = run({ decisions: flip.decisions });
    const li = lineItem(out, flip.expect.lineId);
    if (flip.expect.value !== undefined) expect(li.tariffs[0].value).toBe(flip.expect.value);
    if (flip.expect.quantity1 !== undefined) expect(li.tariffs[0].quantity1).toBe(flip.expect.quantity1);
    if (flip.expect.tariffPrefix !== undefined) expect(li.tariffs[0].tariffNo.startsWith(flip.expect.tariffPrefix)).toBe(true);
    // The issue that carries the decision reports the broker's choice.
    const [key, value] = Object.entries(flip.decisions)[0];
    expect(out.issues.find((i) => i.decision?.key === key)?.decision?.chosen).toBe(value);
    // An explicit choice resolves the issue: it no longer blocks, and the decision stays flippable.
    if (flip.issueAfter) {
      const after = issue(out, flip.issueAfter.id)!;
      expect(after.severity).toBe(flip.issueAfter.severity);
      expect(after.decision?.key).toBe(key);
      expect(after.detail).toMatch(/Resolved by broker choice: .+\. Keep supporting documents \(e\.g\. credit note \/ fibre test report\)\./);
    }
  });

  it('an explicit choice downgrades the blocker to a warning and names the chosen option', () => {
    const before = issue(run(), 'QTY_MISMATCH:inv0-line2')!;
    expect(before.severity).toBe('blocker');
    expect(before.detail).not.toMatch(/Resolved by broker choice/);
    const out = run({ decisions: { 'quantity:inv0-line2': 'packed' } });
    const q = issue(out, 'QTY_MISMATCH:inv0-line2')!;
    const label = q.decision!.options.find((o) => o.value === 'packed')!.label;
    expect(q.severity).toBe('warning');
    expect(q.decision).toMatchObject({ key: 'quantity:inv0-line2', chosen: 'packed', options: before.decision!.options });
    expect(q.detail).toBe(`${before.detail} Resolved by broker choice: ${label}. Keep supporting documents (e.g. credit note / fibre test report).`);
  });

  it('explicitly confirming the default option also resolves the blocker', () => {
    const out = run({ decisions: { 'composition:inv0-line2': 'invoice' } });
    const c = issue(out, 'COMPOSITION_CONFLICT:inv0-line2')!;
    expect(c.severity).toBe('warning');
    expect(c.decision?.chosen).toBe('invoice');
    expect(c.detail).toMatch(/Resolved by broker choice: /);
    // the other blocker without a choice keeps its default severity
    expect(issue(out, 'QTY_MISMATCH:inv0-line2')?.severity).toBe('blocker');
  });

  it('a rejected choice resolves nothing', () => {
    const q = issue(run({ decisions: { 'quantity:inv0-line2': 'bogus' } }), 'QTY_MISMATCH:inv0-line2')!;
    expect(q.severity).toBe('blocker');
    expect(q.detail).not.toMatch(/Resolved by broker choice/);
  });

  it('a non-blocking decision issue keeps its severity but records the choice', () => {
    const a = issue(run({ decisions: { 'amount:inv0-line1': 'printed' } }), 'LINE_AMOUNT_MISMATCH:inv0-line1')!;
    expect(a.severity).toBe('warning');
    expect(a.detail).toMatch(/Resolved by broker choice: /);
  });

  it('packed quantity also changes the invoice quantity and the totals', () => {
    const out = run({ decisions: { 'quantity:inv0-line2': 'packed' } });
    const li = lineItem(out, 'inv0-line2');
    expect(li.invoiceQuantity).toBe(1176);
    expect(out.entryModel.header.totalEntryValue).toBe(27439 - 8880 + 8702);
    const v = out.valuations.find((x) => x.lineId === 'inv0-line2')!;
    expect(v.steps[0].label).toMatch(/Packed quantity/);
    expect(v.steps.at(-1)).toMatchObject({ label: 'Rounded to whole units', amount: -0.4 });
  });

  it('other_doc composition switches tariff, category, description and duty rate', () => {
    const out = run({ decisions: { 'composition:inv0-line2': 'other_doc' } });
    const li = lineItem(out, 'inv0-line2');
    expect(li.tariffs[0].tariffNo).toBe('6110303059');
    expect(li.categoryNo).toBe('639');
    expect(li.commercialDescription).toContain('65% POLYESTER 35% COTTON');
    expect(out.estimates.lines.find((l) => l.lineId === 'inv0-line2')?.ratePct).toBe(32);
    expect(out.issues.find((i) => i.id === 'HTS_RESOLVED:inv0-line2')?.detail).toMatch(/other document/);
  });

  it('grossWeight packing_list uses the PL total (sum of line gross weights)', () => {
    const out = run({ decisions: { grossWeight: 'packing_list' } });
    expect(out.entryModel.header.grossWeight).toBe(1888);
  });

  it('hts override replaces the tariff number and keeps the decision flippable', () => {
    const out = run({ decisions: { 'hts:inv0-line3': '6203.42.40.11' } });
    const li = lineItem(out, 'inv0-line3');
    expect(li.tariffs[0].tariffNo).toBe('6203424011');
    const h = out.issues.find((i) => i.id === 'HTS_RESOLVED:inv0-line3')!;
    expect(h.title).toMatch(/Broker override/);
    expect(h.decision?.key).toBe('hts:inv0-line3');
    expect(h.decision?.chosen).toBe('6203424011');
  });

  it('an override equal to an alternative reuses its rate and units', () => {
    const out = run({ decisions: { 'hts:inv0-line2': '6110303059' } });
    expect(lineItem(out, 'inv0-line2').tariffs[0]).toMatchObject({ tariffNo: '6110303059', unitOfMeasure1: 'DOZ', quantity1: 100 });
    expect(out.estimates.lines.find((l) => l.lineId === 'inv0-line2')?.ratePct).toBe(32);
  });

  it('rejects a decision value that is not an option and keeps the default', () => {
    const out = run({ decisions: { 'quantity:inv0-line2': 'bogus' } });
    expect(lineItem(out, 'inv0-line2').tariffs[0].value).toBe(8880);
    const q = out.issues.find((i) => i.id === 'QTY_MISMATCH:inv0-line2')!;
    expect(q.decision?.chosen).toBe('invoice');
    expect(q.detail).toMatch(/"bogus" ignored/);
  });

  it('does not mutate its inputs', () => {
    const shipment = sampleShipment();
    const issues = sampleIssues();
    const before = JSON.stringify({ shipment, issues });
    assembleEntry({
      shipment,
      classifications: sampleClassifications(),
      altClassifications: sampleAltClassifications(),
      brokerInputs: { decisions: { 'quantity:inv0-line2': 'packed', 'amount:inv0-line1': 'printed' } },
      issues,
      lookups: stubLookups(),
    });
    expect(JSON.stringify({ shipment, issues })).toBe(before);
  });
});

describe('assembleEntry: broker inputs', () => {
  it('clear the missing-data blockers (golden)', () => {
    const { inputs, clears } = golden.brokerInputsClearBlockers;
    const before = run();
    for (const id of clears) expect(before.issues.some((i) => i.id === id), id).toBe(true);
    const after = run(inputs);
    for (const id of clears) expect(after.issues.some((i) => i.id === id), id).toBe(false);
    expect(after.entryModel.header).toMatchObject({
      importerTaxId: '93-1234567',
      bondType: '08',
      suretyCode: '036',
      locationOfGoods: 'W123',
      ultimateConsignee: { taxId: '93-1234567', consigneeName: 'NORTHBOUND OUTFITTERS, INC.' },
    });
    expect(after.issues.filter((i) => i.severity === 'blocker').map((i) => i.id).sort()).toEqual([
      'COMPOSITION_CONFLICT:inv0-line2',
      'QTY_MISMATCH:inv0-line2',
    ]);
    // ...and once the broker has decided both conflicts, nothing blocks any more
    const decided = run({ ...inputs, decisions: { 'quantity:inv0-line2': 'invoice', 'composition:inv0-line2': 'invoice' } });
    expect(decided.issues.filter((i) => i.severity === 'blocker').map((i) => i.id)).toEqual([]);
  });

  it('invalid formats stay blockers and are not emitted', () => {
    const out = run({ importerTaxId: '931234567X', bondType: '07', suretyCode: '1234', locationOfGoods: 'TOOLONG', paymentType: '4', entryType: '99' });
    const h = out.entryModel.header;
    expect(h.importerTaxId).toBeUndefined();
    expect(h.bondType).toBeUndefined();
    expect(h.suretyCode).toBeUndefined();
    expect(h.locationOfGoods).toBeUndefined();
    expect(h.paymentType).toBeUndefined();
    expect(h.entryType).toBe('01');
    expect(issue(out, 'MISSING_IMPORTER_ID')).toMatchObject({ severity: 'blocker' });
    expect(issue(out, 'MISSING_IMPORTER_ID')!.detail).toMatch(/931234567X/);
    expect(issue(out, 'MISSING_BOND')!.detail).toMatch(/\("07"\) was rejected/);
    expect(issue(out, 'MISSING_SURETY')!.detail).toMatch(/1234/);
    expect(issue(out, 'MISSING_LOCATION_OF_GOODS')!.severity).toBe('blocker');
    expect(issue(out, 'BROKER_INPUT_INVALID:paymentType')!.severity).toBe('blocker');
    expect(issue(out, 'BROKER_INPUT_INVALID:entryType')!.detail).toMatch(/01/);
  });

  it('accepts EIN with suffix, CBP-assigned and SSN formats', () => {
    for (const id of ['93-123456700', '123456-12345', '123-45-6789']) {
      const out = run({ importerTaxId: id });
      expect(out.entryModel.header.importerTaxId).toBe(id);
      expect(issue(out, 'MISSING_IMPORTER_ID')).toBeUndefined();
    }
  });

  it('bond type 00 needs no surety; 09 does', () => {
    expect(issue(run({ bondType: '00' }), 'MISSING_SURETY')).toBeUndefined();
    expect(issue(run({ bondType: '09' }), 'MISSING_SURETY')?.severity).toBe('blocker');
  });

  it('entry type 86 does not require the importer tax id', () => {
    expect(issue(run({ entryType: '86' }), 'MISSING_IMPORTER_ID')).toBeUndefined();
  });

  it('entry port, dates, references and auto-apply-remedies come from the broker', () => {
    const out = run({
      entryPort: '3001',
      entryDate: '2026-10-16',
      arrivalDate: '2026-10-15',
      brokerReference: 'REF-123',
      paymentType: '7',
      autoApplyRemedies: false,
      importerName: 'Northbound Outfitters Inc',
    });
    const h = out.entryModel.header;
    expect(h).toMatchObject({
      entryPort: '3001',
      processingPort: '3001',
      unladingPort: '3002',
      entryDate: '2026-10-16',
      arrivalDate: '2026-10-15',
      importDate: '2026-10-15',
      brokerReferenceNo: 'REF-123',
      paymentType: '7',
      importerName: 'Northbound Outfitters Inc',
    });
    expect(out.entryModel.autoApplyRemedies).toBe(false);
    expect(issue(out, 'AUTO_REMEDIES')?.severity).toBe('warning');
    expect(issue(out, 'ENTRY_DATE_DEFAULTED')).toBeUndefined();
  });

  it('a consignee that differs from the importer needs its own tax id', () => {
    const shipment = sampleShipment();
    shipment.ultimateConsignee = { value: { ...shipment.shipTo!, taxId: undefined }, status: 'extracted', sources: [] };
    const input = {
      shipment,
      classifications: sampleClassifications(),
      altClassifications: sampleAltClassifications(),
      issues: sampleIssues(),
      lookups: stubLookups(),
    };
    const out = assembleEntry({ ...input, brokerInputs: { importerTaxId: '93-1234567' } });
    expect(issue(out, 'MISSING_CONSIGNEE_ID')?.severity).toBe('warning');
    expect(out.entryModel.header.ultimateConsignee).toEqual({ consigneeName: 'CASCADE FULFILLMENT PARTNERS LLC' });
    const fixed = assembleEntry({ ...input, brokerInputs: { importerTaxId: '93-1234567', ultimateConsigneeTaxId: '91-7654321' } });
    expect(issue(fixed, 'MISSING_CONSIGNEE_ID')).toBeUndefined();
    expect(fixed.entryModel.header.ultimateConsignee?.taxId).toBe('91-7654321');
  });
});
