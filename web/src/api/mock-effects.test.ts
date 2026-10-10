// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '@app/shared';
import { applyMockInputs } from './mock-effects';
import { mockResult } from './mock-result';

const lineValue = (r: PipelineResult, lineId: string) =>
  r.entryModel.invoices.flatMap((i) => i.lineItems).find((li) => li.lineId === lineId)!.tariffs[0];
const issueIds = (r: PipelineResult) => r.issues.map((i) => i.id);

describe('mockResult (hand-built sample)', () => {
  it('is internally consistent: valuations, tariffs, header total and estimates agree', () => {
    const items = mockResult.entryModel.invoices.flatMap((i) => i.lineItems);
    expect(items).toHaveLength(5);
    for (const v of mockResult.valuations) {
      expect(Math.round(v.steps.reduce((s, step) => s + step.amount, 0))).toBe(v.enteredValue);
      expect(lineValue(mockResult, v.lineId).value).toBe(v.enteredValue);
    }
    expect(mockResult.entryModel.header.totalEntryValue).toBe(27439);
    expect(mockResult.entryModel.header.charges).toBe(4035);
    // Re-deriving with no inputs must reproduce the hand-written numbers exactly.
    const same = applyMockInputs(mockResult, {});
    expect(same.estimates.lines).toEqual(mockResult.estimates.lines);
    expect(same.estimates.totalDuty).toBe(mockResult.estimates.totalDuty);
    expect(same.estimates.mpf).toBe(mockResult.estimates.mpf);
    expect(same.estimates.hmf).toBe(mockResult.estimates.hmf);
    expect(same.xml).toBe(mockResult.xml);
  });

  it('carries the golden sample values', () => {
    const values = mockResult.valuations.map((v) => v.enteredValue);
    expect(values).toEqual([6840, 8880, 6255, 5440, 24]);
    expect(lineValue(mockResult, 'inv0-line5')).toMatchObject({ quantity1: 2, quantity2: 5.1 });
    expect(mockResult.entryModel.invoices[0].lineItems[4].countryOrigin).toBe('BD');
    expect(mockResult.xml).toContain('<invoice-no>KBAS-NB-26-0912</invoice-no>');
    expect(mockResult.xml).not.toContain('<transmit');
    expect(mockResult.documents.map((d) => d.source)).toEqual(['text', 'ocr', 'ocr']);
  });
});

describe('applyMockInputs', () => {
  it('applies the packed-quantity decision', () => {
    const r = applyMockInputs(mockResult, { decisions: { 'quantity:inv0-line2': 'packed' } });
    expect(lineValue(r, 'inv0-line2')).toMatchObject({ value: 8702, quantity1: 98 });
    expect(r.entryModel.header.totalEntryValue).toBe(27439 - 178);
    expect(r.issues.find((i) => i.id === 'QTY_MISMATCH:inv0-line2')?.decision?.chosen).toBe('packed');
    expect(r.xml).toContain('<value>8702</value>');
  });

  it('switches classification on the composition decision', () => {
    const r = applyMockInputs(mockResult, { decisions: { 'composition:inv0-line2': 'other_doc' } });
    expect(lineValue(r, 'inv0-line2').tariffNo.startsWith('611030')).toBe(true);
    expect(r.classifications['inv0-line2'].htsNumber.startsWith('611030')).toBe(true);
    expect(r.estimates.totalDuty).toBeGreaterThan(mockResult.estimates.totalDuty);
  });

  it('declares the printed amount when chosen', () => {
    const r = applyMockInputs(mockResult, { decisions: { 'amount:inv0-line1': 'printed' } });
    expect(lineValue(r, 'inv0-line1').value).toBe(6480);
  });

  it('broker inputs clear their blockers and appear in the XML', () => {
    const r = applyMockInputs(mockResult, { importerTaxId: '93-1234567', bondType: '08', suretyCode: '036', locationOfGoods: 'W123' });
    for (const id of ['MISSING_IMPORTER_ID', 'MISSING_BOND', 'MISSING_SURETY', 'MISSING_LOCATION_OF_GOODS']) {
      expect(issueIds(mockResult)).toContain(id);
      expect(issueIds(r)).not.toContain(id);
    }
    expect(r.xml).toContain('<importer-tax-id>93-1234567</importer-tax-id>');
    expect(r.xml).toContain('<surety-code>036</surety-code>');
    expect(r.brokerInputs.importerTaxId).toBe('93-1234567');
    expect(r.issues.filter((i) => i.severity === 'blocker')).toHaveLength(2);
  });

  it('marks the XML invalid for a malformed tax id and never mutates the base', () => {
    const before = JSON.stringify(mockResult);
    const r = applyMockInputs(mockResult, { importerTaxId: '931234567' });
    expect(r.xsdValidation.valid).toBe(false);
    expect(r.xsdValidation.errors[0]).toContain('importer-tax-id');
    expect(JSON.stringify(mockResult)).toBe(before);
  });
});

// The mock claims "XSD-valid"; prove it with the vendored schema when xmllint is installed.
const schemaPath = fileURLToPath(new URL('../../../server/src/netchb/schema/entry.xsd', import.meta.url));
const hasXmllint = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return existsSync(schemaPath);
  } catch {
    return false;
  }
})();

describe.skipIf(!hasXmllint)('mock XML against entry.xsd (xmllint)', () => {
  it('validates for default and fully-edited inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-xml-'));
    try {
      const edited = applyMockInputs(mockResult, {
        importerTaxId: '93-1234567AB',
        ultimateConsigneeTaxId: '931231-12345',
        bondType: '08',
        suretyCode: '036',
        paymentType: '2',
        locationOfGoods: 'W123',
        brokerReference: 'REF-1',
        autoApplyRemedies: false,
        decisions: { 'quantity:inv0-line2': 'packed', 'composition:inv0-line2': 'other_doc', grossWeight: 'packing_list' },
      });
      for (const [name, xml] of [
        ['default.xml', mockResult.xml],
        ['edited.xml', edited.xml],
      ]) {
        const file = join(dir, name);
        writeFileSync(file, xml);
        expect(() => execFileSync('xmllint', ['--noout', '--schema', schemaPath, file], { stdio: 'pipe' })).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
