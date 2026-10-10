import { describe, expect, it } from 'vitest';
import { mapContainerSizeType, normalizeBillNo, normalizeInvoiceNo, normalizePackageUnit } from '../../src/netchb';
import { chunkWords, collapse, formatHts, isIsoDate, truncateWords } from '../../src/netchb/normalize';
import { PATTERNS } from '../../src/netchb/enums';

describe('normalizeInvoiceNo (invoiceNoType [A-Za-z0-9-]{1,17})', () => {
  it.each([
    ['KBAS/NB/26-0912', 'KBAS-NB-26-0912', true],
    ['INV-2026-001', 'INV-2026-001', false],
    ['INV 2026 / 001', 'INV-2026-001', true],
    ['  RE#4410.A  ', 'RE-4410-A', true],
    ['/ABC//123/', 'ABC-123', true],
    ['ABCDEFGHIJKLMNOPQRSTU', 'ABCDEFGHIJKLMNOPQ', true],
    ['ABCDEFGHIJKLMNOP/QRS', 'ABCDEFGHIJKLMNOP', true],
    ['Rechnung Nr. 4711', 'Rechnung-Nr-4711', true],
    ['', '', false],
  ])('%j → %j (changed=%s)', (input, value, changed) => {
    const r = normalizeInvoiceNo(input);
    expect(r).toEqual({ value, changed });
    if (r.value) expect(PATTERNS.invoiceNo.test(r.value)).toBe(true);
  });
});

describe('normalizeBillNo (billNoType alphanumeric ≤ 50)', () => {
  it.each([
    ['SGN260917735', 'SGN260917735', false],
    ['SGN-2609 17735', 'SGN260917735', true],
    ['hcm26090418', 'HCM26090418', true],
    ['020-12345675', '02012345675', true],
    ['X'.repeat(60), 'X'.repeat(50), true],
  ])('%j → %j', (input, value, changed) => {
    expect(normalizeBillNo(input)).toEqual({ value, changed });
  });
});

describe('normalizePackageUnit (manifest unit ≤ 5 chars)', () => {
  it.each([
    ['CARTONS', 'CTN'],
    ['ctns', 'CTN'],
    ['Packages', 'PKG'],
    ['PALLETS', 'PLT'],
    ['PIECES', 'PCS'],
    ['BAGS', 'BAG'],
    ['ROLLS', 'RL'],
    ['BOXES', 'BX'],
    ['CASES', 'CAS'],
    ['CRATES', 'CRT'],
    ['DRUMS', 'DR'],
    ['BUNDLES', 'BDL'],
    [undefined, 'PKG'],
    ['WOODENCASKS', 'WOODE'],
  ])('%j → %j', (input, code) => {
    expect(normalizePackageUnit(input)).toBe(code);
  });
});

describe('mapContainerSizeType (XSD container-size / container-type enums)', () => {
  it.each([
    ['20GP', { size: '20 ft', type: 'Dry' }],
    ["20'GP", { size: '20 ft', type: 'Dry' }],
    ['40HC', { size: '40 ft HC', type: 'Dry' }],
    ['40HQ', { size: '40 ft HC', type: 'Dry' }],
    ['40DV', { size: '40 ft', type: 'Dry' }],
    ['40RF', { size: '40 ft', type: 'Reefer' }],
    ['20OT', { size: '20 ft', type: 'Open' }],
    ['40FR', { size: '40 ft', type: 'Flat Rack' }],
    ['20TK', { size: '20 ft', type: 'Tank' }],
    ['45HC', { size: '45 ft HC', type: 'Dry' }],
    ['22G1', { size: '20 ft', type: 'Dry' }],
    ['45G1', { size: '40 ft HC', type: 'Dry' }],
    ['42R1', { size: '40 ft', type: 'Reefer' }],
    ['L5G1', { size: '45 ft HC', type: 'Dry' }],
    ['ZZ', {}],
    [undefined, {}],
  ])('%j → %j', (input, expected) => {
    expect(mapContainerSizeType(input)).toEqual(expected);
  });
});

describe('text helpers', () => {
  it('collapse / truncateWords / chunkWords', () => {
    expect(collapse('  a \n b\tc ')).toBe('a b c');
    expect(truncateWords('KOWLOON BAY APPAREL SOURCING LIMITED', 35)).toBe('KOWLOON BAY APPAREL SOURCING');
    expect(truncateWords('short', 35)).toBe('short');
    const chunks = chunkWords('Unit 1708, 17/F, Hing Fat Industrial Building, 223 Wai Yip Street', 35);
    expect(chunks.every((c) => c.length <= 35)).toBe(true);
    expect(chunks.join(' ')).toBe('Unit 1708, 17/F, Hing Fat Industrial Building, 223 Wai Yip Street');
  });

  it('formatHts and isIsoDate', () => {
    expect(formatHts('6109100012')).toBe('6109.10.00.12');
    expect(formatHts('610910')).toBe('6109.10');
    expect(isIsoDate('2026-10-14')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('14/10/2026')).toBe(false);
  });

  it('tax id pattern matches data_type.xsd taxIdType', () => {
    for (const ok of ['93-1234567', '93-123456700', '93-1234567AB', '123456-12345', '123-45-6789']) expect(PATTERNS.taxId.test(ok), ok).toBe(true);
    for (const bad of ['931234567', '93-123456', '93-1234567ABC', 'ABC']) expect(PATTERNS.taxId.test(bad), bad).toBe(false);
  });
});
