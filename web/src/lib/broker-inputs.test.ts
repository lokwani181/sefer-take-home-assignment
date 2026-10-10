import { describe, expect, it } from 'vitest';
import { mockResult } from '../api/mock-result';
import {
  TAX_ID_PATTERN,
  decisionDefaults,
  fromFormValues,
  inputsFromResult,
  issuesClearedBy,
  toFormValues,
  validateBrokerForm,
} from './broker-inputs';

const blank = () => toFormValues({});

describe('TAX_ID_PATTERN', () => {
  it.each(['93-1234567', '93-1234567AB', '93-12345670Z', '931231-12345', '123-45-6789'])('accepts %s', (id) => {
    expect(TAX_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(['931234567', '93-123456', '93-1234567ABC', '9-31234567', '123-456-789', '93_1234567', ' 93-1234567'])('rejects %s', (id) => {
    expect(TAX_ID_PATTERN.test(id)).toBe(false);
  });
});

describe('validateBrokerForm', () => {
  it('returns no errors for an empty form (every field is optional)', () => {
    expect(validateBrokerForm(blank())).toEqual({});
  });

  it('flags malformed codes field by field', () => {
    const errors = validateBrokerForm({
      ...blank(),
      importerTaxId: '931234567',
      ultimateConsigneeTaxId: 'abc',
      suretyCode: '36',
      entryPort: '300',
      locationOfGoods: 'W12345',
      entryType: '1',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['entryPort', 'entryType', 'importerTaxId', 'locationOfGoods', 'suretyCode', 'ultimateConsigneeTaxId'].sort(),
    );
  });

  it('accepts well-formed values', () => {
    expect(
      validateBrokerForm({
        ...blank(),
        importerTaxId: '93-1234567',
        suretyCode: '036',
        entryPort: '3002',
        locationOfGoods: 'W123',
        entryDate: '2026-10-15',
      }),
    ).toEqual({});
  });
});

describe('fromFormValues / toFormValues', () => {
  it('trims, uppercases codes, drops empty fields and keeps decisions', () => {
    const inputs = fromFormValues(
      { ...blank(), importerTaxId: ' 93-1234567ab ', suretyCode: 'a1b', locationOfGoods: 'w123', bondType: '08' },
      { grossWeight: 'packing_list' },
    );
    expect(inputs).toEqual({
      importerTaxId: '93-1234567AB',
      suretyCode: 'A1B',
      locationOfGoods: 'W123',
      bondType: '08',
      entryType: '01',
      autoApplyRemedies: true,
      decisions: { grossWeight: 'packing_list' },
    });
  });

  it('defaults entry type to 01 and auto-apply remedies to on', () => {
    expect(blank().entryType).toBe('01');
    expect(blank().autoApplyRemedies).toBe(true);
    expect(toFormValues({ autoApplyRemedies: false }).autoApplyRemedies).toBe(false);
  });
});

describe('decisions and clears', () => {
  it('collects every decision default from the issues', () => {
    expect(decisionDefaults(mockResult.issues)).toEqual({
      'quantity:inv0-line2': 'invoice',
      'composition:inv0-line2': 'invoice',
      'amount:inv0-line1': 'computed',
      grossWeight: 'transport_doc',
    });
  });

  it('keeps only the explicitly chosen decisions (defaults are never sent back as choices)', () => {
    const result = { ...mockResult, brokerInputs: { importerTaxId: '93-1234567', decisions: { grossWeight: 'packing_list' } } };
    expect(inputsFromResult(result)).toEqual({
      importerTaxId: '93-1234567',
      decisions: { grossWeight: 'packing_list' },
    });
  });

  it('omits decisions entirely when the broker has not chosen any', () => {
    const result = { ...mockResult, brokerInputs: { importerTaxId: '93-1234567' } };
    expect(inputsFromResult(result)).toEqual({ importerTaxId: '93-1234567' });
  });

  it('maps inputs to the open issues they clear', () => {
    expect(issuesClearedBy('importerTaxId', mockResult.issues).map((i) => i.id)).toEqual(['MISSING_IMPORTER_ID']);
    expect(issuesClearedBy('bondType', mockResult.issues).map((i) => i.id)).toEqual(['MISSING_BOND']);
    expect(issuesClearedBy('suretyCode', mockResult.issues).map((i) => i.id)).toEqual(['MISSING_SURETY']);
    expect(issuesClearedBy('locationOfGoods', mockResult.issues).map((i) => i.id)).toEqual(['MISSING_LOCATION_OF_GOODS']);
    expect(issuesClearedBy('brokerReference', mockResult.issues)).toEqual([]);
  });
});
