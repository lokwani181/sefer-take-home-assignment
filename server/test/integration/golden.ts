/**
 * Shared golden assertions for the sample shipment (server/test/golden/sample-expected.json),
 * registered once per path (real OCR through the API, and the committed layout fixtures) so an
 * OCR error and a logic error show up as different failures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { BrokerInputs, DocumentLayout, EntryLineItem, Issue, PipelineResult } from '@app/shared';

export interface GoldenLine {
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

export interface Golden {
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

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const SAMPLES_DIR = join(ROOT, 'samples');
export const SAMPLE_PDFS = [
  'KBAS-NB-26-0912_Commercial_Invoice.pdf',
  'SPG-PL-2609-117_Packing_List.pdf',
  'BMLVHCM26090418_House_BL.pdf',
];

export const golden = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'golden', 'sample-expected.json'), 'utf8')) as Golden;

/** 10-digit numbers pinned by the reference module's own tests (HTS data committed in reference/data/hts). */
export const PINNED_HTS: Record<string, string> = {
  'inv0-line1': '6109100012',
  'inv0-line2': '6110202046',
  'inv0-line3': '6203424518',
  'inv0-line4': '6206403035',
  'inv0-line5': '6106100010',
};
export const PINNED_ALT_HTS: Record<string, string> = { 'inv0-line2': '6110303045' };

export function fixtureLayouts(): DocumentLayout[] {
  const dir = join(import.meta.dirname, '..', 'fixtures', 'sample');
  return ['invoice', 'packing-list', 'bill-of-lading'].map(
    (n) => JSON.parse(readFileSync(join(dir, `${n}.layout.json`), 'utf8')) as DocumentLayout,
  );
}

export function lineItem(result: PipelineResult, lineId: string): EntryLineItem {
  const item = result.entryModel.invoices.flatMap((i) => i.lineItems).find((l) => l.lineId === lineId);
  if (!item) throw new Error(`no line item ${lineId}`);
  return item;
}

export const issueById = (result: PipelineResult, id: string): Issue | undefined => result.issues.find((i) => i.id === id);

/** Severity order blocker > warning > info, as the pipeline promises. */
export function severityOrdered(issues: Issue[]): boolean {
  const rank = { blocker: 0, warning: 1, info: 2 } as const;
  return issues.every((i, k) => k === 0 || rank[issues[k - 1].severity] <= rank[i.severity]);
}

/**
 * Registers the golden checks. `get` returns the default-decision result; `regen` re-assembles the
 * same shipment with other broker inputs (through the API or the pipeline function).
 */
export function goldenSuite(get: () => PipelineResult, regen: (inputs: BrokerInputs) => Promise<PipelineResult>): void {
  it('produces XSD-valid XML with no XSD_INVALID issue', () => {
    const r = get();
    expect(r.xsdValidation.errors).toEqual([]);
    expect(r.xsdValidation.valid).toBe(true);
    expect(issueById(r, 'XSD_INVALID')).toBeUndefined();
    expect(r.xml).toContain('<entry');
    expect(r.xml).not.toContain('<transmit');
    expect(r.soapEnvelope).toContain('uploadEntry');
  });

  it('classifies the three documents', () => {
    const types = get().documents.map((d) => d.docType).sort();
    expect(types).toEqual(['bill_of_lading', 'commercial_invoice', 'packing_list']);
  });

  it(`normalizes the invoice number to ${golden.invoiceNoNormalized}`, () => {
    expect(get().entryModel.invoices.map((i) => i.invoiceNo)).toEqual([golden.invoiceNoNormalized]);
  });

  it.each(Object.entries(golden.header))('header.%s = %s', (key, value) => {
    expect((get().entryModel.header as unknown as Record<string, unknown>)[key]).toEqual(value);
  });

  it('bills of lading match', () => {
    const bills = get().entryModel.manifest.billsOfLading;
    expect(bills).toHaveLength(golden.billsOfLading.length);
    golden.billsOfLading.forEach((b, i) => expect(bills[i]).toMatchObject(b));
  });

  it('containers match', () => {
    const containers = get().entryModel.containers;
    expect(containers).toHaveLength(golden.containers.length);
    golden.containers.forEach((c, i) => expect(containers[i]).toMatchObject(c));
  });

  it.each(golden.lines.map((l) => [l.lineId, l] as const))('line %s matches the golden values', (lineId, g) => {
    const r = get();
    const li = lineItem(r, lineId);
    const t = li.tariffs[0];
    expect(t.tariffNo.startsWith(g.tariffPrefix), `tariff ${t.tariffNo} vs prefix ${g.tariffPrefix}`).toBe(true);
    expect(li.countryOrigin).toBe(g.countryOrigin);
    expect(t.value).toBe(g.value);
    expect(t.quantity1).toBe(g.quantity1);
    expect(t.unitOfMeasure1).toBe(g.unitOfMeasure1);
    expect(t.quantity2).toBe(g.quantity2);
    expect(t.unitOfMeasure2).toBe(g.unitOfMeasure2);
    expect(li.manufacturerId?.slice(0, 2)).toBe(g.midCountry);
    expect(li.exportDate).toBe(golden.exportDate);
    expect(li.countryExport).toBe(golden.countryExport);
    if (g.altTariffPrefix) {
      expect(r.altClassifications[lineId]?.htsNumber.startsWith(g.altTariffPrefix)).toBe(true);
    }
  });

  it.each(Object.entries(PINNED_HTS))('line %s resolves to the pinned HTS %s', (lineId, hts) => {
    const r = get();
    expect(r.classifications[lineId]?.htsNumber).toBe(hts);
    expect(lineItem(r, lineId).tariffs[0].tariffNo).toBe(hts);
  });

  it.each(Object.entries(PINNED_ALT_HTS))('line %s alternative classification is %s', (lineId, hts) => {
    expect(get().altClassifications[lineId]?.htsNumber).toBe(hts);
  });

  it('total entered value is the sum of the line values', () => {
    const r = get();
    const sum = golden.lines.reduce((s, l) => s + l.value, 0);
    expect(r.entryModel.header.totalEntryValue).toBe(sum);
    expect(r.valuations.reduce((s, v) => s + v.enteredValue, 0)).toBe(sum);
  });

  it.each(golden.expectedIssues.map((e) => [e.id, e] as const))('issue %s is present with the golden severity/decision', (id, e) => {
    const issue = issueById(get(), id);
    expect(issue, `missing ${id}`).toBeDefined();
    expect(issue!.severity).toBe(e.severity);
    if (e.decisionKey) {
      expect(issue!.decision?.key).toBe(e.decisionKey);
      expect(issue!.decision?.chosen).toBe(e.defaultChoice);
    }
  });

  it.each(golden.mustNotHaveIssues)('does not raise %s', (id) => {
    const r = get();
    if (id.includes(':')) expect(issueById(r, id)).toBeUndefined();
    else expect(r.issues.filter((i) => i.code === id).map((i) => i.id)).toEqual([]);
  });

  it('issues are unique and sorted blocker > warning > info', () => {
    const r = get();
    const ids = r.issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(severityOrdered(r.issues)).toBe(true);
  });

  it.each(golden.decisionFlips.map((f) => [Object.entries(f.decisions).map(([k, v]) => `${k}=${v}`).join(','), f] as const))(
    'decision flip %s',
    async (_label, flip) => {
      const r = await regen({ decisions: flip.decisions });
      const li = lineItem(r, flip.expect.lineId);
      const t = li.tariffs[0];
      if (flip.expect.value !== undefined) expect(t.value).toBe(flip.expect.value);
      if (flip.expect.quantity1 !== undefined) expect(t.quantity1).toBe(flip.expect.quantity1);
      if (flip.expect.tariffPrefix) expect(t.tariffNo.startsWith(flip.expect.tariffPrefix), t.tariffNo).toBe(true);
      // The decision is echoed back with the broker's choice.
      for (const [key, value] of Object.entries(flip.decisions)) {
        expect(r.issues.find((i) => i.decision?.key === key)?.decision?.chosen).toBe(value);
      }
      // The explicit choice resolves the issue: no longer a blocker, decision kept so it can be changed back.
      if (flip.issueAfter) {
        const after = issueById(r, flip.issueAfter.id);
        expect(after?.severity).toBe(flip.issueAfter.severity);
        expect(after?.decision?.key).toBe(Object.keys(flip.decisions)[0]);
        expect(after?.detail).toMatch(/Resolved by broker choice: .+\. Keep supporting documents/);
      }
      expect(r.xsdValidation.valid).toBe(true);
      expect(severityOrdered(r.issues)).toBe(true);
    },
  );

  it('without an explicit choice the conflicts keep blocking; deciding both leaves no reconcile blocker', async () => {
    const defaults = get();
    expect(issueById(defaults, 'QTY_MISMATCH:inv0-line2')?.severity).toBe('blocker');
    expect(issueById(defaults, 'COMPOSITION_CONFLICT:inv0-line2')?.severity).toBe('blocker');
    const { inputs } = golden.brokerInputsClearBlockers;
    const r = await regen({ ...inputs, decisions: { 'quantity:inv0-line2': 'invoice', 'composition:inv0-line2': 'invoice' } });
    expect(r.issues.filter((i) => i.severity === 'blocker').map((i) => i.id)).toEqual([]);
    expect(issueById(r, 'QTY_MISMATCH:inv0-line2')).toMatchObject({ severity: 'warning', decision: { chosen: 'invoice' } });
    expect(issueById(r, 'COMPOSITION_CONFLICT:inv0-line2')).toMatchObject({ severity: 'warning', decision: { chosen: 'invoice' } });
  });

  it('broker inputs clear the broker-only blockers', async () => {
    const { inputs, clears } = golden.brokerInputsClearBlockers;
    const before = get();
    for (const code of clears) expect(before.issues.some((i) => i.code === code)).toBe(true);
    const r = await regen(inputs);
    for (const code of clears) expect(r.issues.filter((i) => i.code === code).map((i) => i.id)).toEqual([]);
    expect(r.entryModel.header.importerTaxId).toBe(inputs.importerTaxId);
    expect(r.entryModel.header.bondType).toBe(inputs.bondType);
    expect(r.xsdValidation.valid).toBe(true);
  });

  it('an hts:<lineId> override is classified before assembly (units and rate of the chosen code)', async () => {
    const alt = PINNED_ALT_HTS['inv0-line2'];
    const r = await regen({ decisions: { 'hts:inv0-line2': alt } });
    const t = lineItem(r, 'inv0-line2').tariffs[0];
    expect(t.tariffNo).toBe(alt);
    expect(t.unitOfMeasure1).toBe('DOZ');
    expect(t.unitOfMeasure2).toBe('KG');
    expect(r.estimates.lines.find((l) => l.lineId === 'inv0-line2')?.htsNumber).toBe(alt);
    expect(r.xsdValidation.valid).toBe(true);
  });
}
