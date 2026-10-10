/** Library helpers and merge steps, tested on their own. */
import { describe, expect, it } from 'vitest';
import type { CommercialInvoiceData, PackingListData } from '@app/shared';
import { compareCompositions, normFiber, predominantFiber } from '../../src/reconcile/lib/composition';
import { countriesInText, countryFromText, countryName } from '../../src/reconcile/lib/countries';
import { numericDateReadings, parseDateText } from '../../src/reconcile/lib/dates';
import { assessFobBasis } from '../../src/reconcile/lib/fob';
import { containerRepairs, iso6346CheckDigit, isValidContainerNumber } from '../../src/reconcile/lib/iso6346';
import { accountOfParty, logisticsKeyword } from '../../src/reconcile/lib/parties';
import { descTokens, dice, ocrKey, sameCompany } from '../../src/reconcile/lib/text';
import { checkTotals, discountsDeducted } from '../../src/reconcile/lib/totals';
import { usStateFromText } from '../../src/reconcile/lib/usStates';
import { buildContext } from '../../src/reconcile/merge';
import { manufacturersInNotes } from '../../src/reconcile/merge/parties';
import { splitBill } from '../../src/reconcile/merge/transport';
import { addr, billOfLading, invoice, packingList, sampleDocs } from './helpers';

describe('ISO 6346', () => {
  it('computes check digits (incl. the standard CSQU3054383 example)', () => {
    expect(iso6346CheckDigit('CSQU305438')).toBe(3);
    expect(isValidContainerNumber('CSQU3054383')).toBe(true);
    expect(isValidContainerNumber('CSQU 305438-3')).toBe(true);
    expect(isValidContainerNumber('CSQU3054384')).toBe(false);
    expect(isValidContainerNumber('CSQX3054383')).toBe(false);
  });

  it('repairs only via letter/digit confusions and never invents a digit', () => {
    expect(containerRepairs('CSQU3O54383')).toEqual(['CSQU3054383']);
    expect(containerRepairs('CSQU305438')).toEqual([]);
    expect(containerRepairs('CSQU3054389')).toEqual([]);
  });
});

describe('dates', () => {
  it('parses common formats', () => {
    expect(parseDateText('24-SEP-2026')).toBe('2026-09-24');
    expect(parseDateText('Sep 24, 2026')).toBe('2026-09-24');
    expect(parseDateText('2026/09/24')).toBe('2026-09-24');
    expect(parseDateText('13/09/2026')).toBe('2026-09-13');
    expect(parseDateText('09/13/2026')).toBe('2026-09-13');
    expect(parseDateText('04/09/2026', 'mdy')).toBe('2026-04-09');
  });

  it('gives both readings only when ambiguous', () => {
    expect(numericDateReadings('12/09/2026')).toEqual({ dayFirst: '2026-09-12', monthFirst: '2026-12-09' });
    expect(numericDateReadings('13/09/2026')).toBeUndefined();
    expect(numericDateReadings('05/05/2026')).toBeUndefined();
  });
});

describe('countries and states', () => {
  it('reads countries from free text', () => {
    expect(countryFromText('CAT LAI, HCMC, VN')).toBe('VN');
    expect(countryFromText('SHANGHAI, CHINA')).toBe('CN');
    expect(countryFromText('Portland, OR 97210, U.S.A.')).toBe('US');
    expect(countryFromText('NHAVA SHEVA')).toBeUndefined();
    expect(countriesInText('the goods are of Chinese origin', { demonyms: true })).toEqual(['CN']);
    expect(countryName('BD')).toBe('Bangladesh');
  });

  it('reads US states from addresses and place names', () => {
    expect(usStateFromText('KENT, WA (DOOR)')).toBe('WA');
    expect(usStateFromText('Portland, OR 97210, U.S.A.')).toBe('OR');
    expect(usStateFromText('LOS ANGELES, CA')).toBe('CA');
    expect(usStateFromText('Savannah, Georgia')).toBe('GA');
    expect(usStateFromText('HAMBURG, GERMANY')).toBeUndefined();
  });
});

describe('composition', () => {
  it('normalizes fibre names and finds the predominant fibre', () => {
    expect(normFiber('Spandex')).toBe('elastane');
    expect(normFiber('POLY')).toBe('polyester');
    expect(predominantFiber([{ fiber: 'cotton', pct: 50 }, { fiber: 'polyester', pct: 50 }])).toBeUndefined();
  });

  it('flags predominant-fibre changes and ≥10-point differences only', () => {
    expect(compareCompositions([{ fiber: 'cotton', pct: 60 }, { fiber: 'polyester', pct: 40 }], [{ fiber: 'polyester', pct: 65 }, { fiber: 'cotton', pct: 35 }]).conflict).toBe(true);
    expect(compareCompositions([{ fiber: 'cotton', pct: 98 }, { fiber: 'spandex', pct: 2 }], [{ fiber: 'cotton', pct: 98 }, { fiber: 'elastane', pct: 2 }]).conflict).toBe(false);
    expect(compareCompositions([{ fiber: 'cotton', pct: 95 }, { fiber: 'elastane', pct: 5 }], [{ fiber: 'cotton', pct: 85 }, { fiber: 'elastane', pct: 15 }]).conflict).toBe(true);
    expect(compareCompositions([{ fiber: 'cotton', pct: 100 }], undefined).conflict).toBe(false);
  });
});

describe('text matching', () => {
  it('folds apparel synonyms and OCR confusions', () => {
    expect(dice(descTokens("MEN'S CREW NECK S/S TEE"), descTokens("MEN'S CREW NECK SHORT SLEEVE T-SHIRT"))).toBe(1);
    expect(dice(descTokens('LADIES PULLOVER HOODIE'), descTokens("WOMEN'S PULLOVER HOODIE W/ KANGAROO POCKET"))).toBeGreaterThan(0.7);
    expect(ocrKey('NB-H2O5')).toBe(ocrKey('nb h205'));
  });

  it('compares company names across legal-form spellings', () => {
    expect(sameCompany('SAIGON PHOENIX GARMENT JSC', 'Saigon Phoenix Garment Joint Stock Company')).toBe(true);
    expect(sameCompany('Northbound Outfitters, Inc.', 'NORTHBOUND OUTFITTERS INC')).toBe(true);
    expect(sameCompany('Saigon Phoenix Trading Co., Ltd.', 'Saigon Phoenix Garment JSC')).toBe(false);
    expect(sameCompany('KOWLOON BAY APPAREL SOURCING LIMITED', 'SAIGON PHOENIX GARMENT JSC')).toBe(false);
  });

  it('detects logistics providers and "for account of" clauses', () => {
    expect(logisticsKeyword(addr('CASCADE FULFILLMENT PARTNERS LLC', 'US'))).toBe('FULFILLMENT');
    expect(logisticsKeyword(addr('Midwest Distribution Center', 'US'))).toBeTruthy();
    expect(logisticsKeyword(addr('NORTHBOUND OUTFITTERS, INC.', 'US'))).toBeUndefined();
    expect(accountOfParty(addr('X', 'US', { raw: 'X\nc/o Acme Corp' }))).toBe('Acme Corp');
  });
});

describe('totals and FOB basis', () => {
  const data = (over: Partial<CommercialInvoiceData>): CommercialInvoiceData =>
    ({ kind: 'commercial_invoice', invoiceNumber: 'X', poNumbers: [], lines: [], charges: [], totals: [], assists: [], notes: [], ...over }) as CommercialInvoiceData;

  it('explains page sub-totals and goods + charges', () => {
    const checks = checkTotals({
      amounts: [100, 200, 300],
      ncv: [false, false, false],
      lineNos: [1, 2, 3],
      charges: [{ type: 'freight', amount: 50, description: 'Freight' }],
      totals: [{ label: 'Carried forward', amount: 300 }, { label: 'Page 2 total', amount: 300 }, { label: 'TOTAL CFR', amount: 650 }, { label: 'TOTAL', amount: 999 }],
    });
    expect(checks.map((c) => !!c.explainedBy)).toEqual([true, true, true, false]);
  });

  it('a discount counts as deducted on the invoice only when a printed total is goods − discount', () => {
    const charges = [{ type: 'discount' as const, amount: -300, description: 'LESS 3% VOLUME DISCOUNT' }];
    const amounts = [4000, 6000];
    const ncv = [false, false];
    expect(discountsDeducted(charges, [{ label: 'SUB TOTAL', amount: 10000 }, { label: 'TOTAL AMOUNT', amount: 9700 }], amounts, ncv)).toBe(true);
    expect(discountsDeducted(charges, [{ label: 'TOTAL', amount: 10000 }], amounts, ncv)).toBe(false);
    expect(discountsDeducted(charges, [], amounts, ncv)).toBe(false);
    // with freight on top (CFR): goods − discount + freight
    const withFreight = [...charges, { type: 'freight' as const, amount: 500, description: 'Ocean freight' }];
    expect(discountsDeducted(withFreight, [{ label: 'TOTAL CFR', amount: 10200 }], amounts, ncv)).toBe(true);
    expect(discountsDeducted([{ type: 'freight' as const, amount: 500, description: 'Ocean freight' }], [{ label: 'TOTAL', amount: 10500 }], amounts, ncv)).toBe(false);
  });

  it('decides linesAreFob from the incoterm and the printed totals', () => {
    const charges = [{ type: 'freight' as const, amount: 50, description: 'Freight' }];
    expect(assessFobBasis(data({ incoterm: { code: 'FCA' } }), [600], [false]).linesAreFob).toBe(true);
    expect(assessFobBasis(data({ incoterm: { code: 'CFR' }, charges, totals: [{ label: 'TOTAL CFR', amount: 650 }] }), [600], [false])).toMatchObject({ linesAreFob: true, basis: 'totals' });
    expect(assessFobBasis(data({ incoterm: { code: 'CFR' }, charges, totals: [{ label: 'TOTAL CFR', amount: 600 }] }), [600], [false])).toMatchObject({ linesAreFob: false, basis: 'includes_charges' });
    expect(assessFobBasis(data({ incoterm: { code: 'CFR' }, charges }), [600], [false])).toMatchObject({ linesAreFob: false, basis: 'unverified' });
    expect(assessFobBasis(data({ incoterm: { code: 'DDP' } }), [600], [false])).toMatchObject({ linesAreFob: false, basis: 'no_charges' });
  });

  // "Value breakdown (included in the CFR prices above): FOB value 550 + ocean freight 50 = CFR value 600"
  it('a printed FOB breakdown does not make line amounts that equal the C/D total FOB', () => {
    const charges = [{ type: 'freight' as const, amount: 50, description: 'Ocean freight' }];
    const totals = [{ label: 'FOB value, Tanjung Priok', amount: 550 }, { label: 'CFR value, Savannah', amount: 600 }];
    expect(assessFobBasis(data({ incoterm: { code: 'CFR' }, charges, totals }), [400, 200], [false, false])).toMatchObject({ linesAreFob: false, basis: 'includes_charges' });
  });
});

describe('bills', () => {
  it('strips a known SCAC prefix, or takes a leading 4-letter block as SCAC', () => {
    expect(splitBill('BMLVHCM26090418', 'BMLV')).toEqual({ scac: 'BMLV', number: 'HCM26090418' });
    expect(splitBill('HCM26090418', 'BMLV')).toEqual({ scac: 'BMLV', number: 'HCM26090418' });
    expect(splitBill('MAEU 123456789')).toEqual({ scac: 'MAEU', number: '123456789' });
    expect(splitBill('SGN260917735')).toEqual({ number: 'SGN260917735' });
  });
});

describe('merge', () => {
  it('matches packing-list lines by description and quantity when style numbers are missing', () => {
    const docs = sampleDocs();
    for (const d of docs) {
      if (d.data.kind === 'packing_list') for (const l of (d.data as PackingListData).lines) delete l.styleNo;
    }
    const ctx = buildContext(docs);
    expect(ctx.links.map((l) => l.pl.map((r) => r.index))).toEqual([[0], [1], [2], [3], [4]]);
    expect(ctx.links.every((l) => l.pl[0].method === 'description')).toBe(true);
    expect(ctx.unmatchedPl).toEqual([]);
  });

  it('matches OCR-garbled and partial style numbers', () => {
    const pl = packingList();
    if (pl.data.kind === 'packing_list') {
      pl.data.lines[0].styleNo = 'SK-1OO';
      pl.data.lines[1].styleNo = 'SK-200/A';
    }
    const ctx = buildContext([invoice(), pl]);
    expect(ctx.links.map((l) => l.pl[0]?.method)).toEqual(['style_ocr', 'style_partial']);
  });

  it('sums a style packed on several packing-list lines', () => {
    const pl = packingList();
    if (pl.data.kind === 'packing_list') {
      const first = pl.data.lines[0];
      pl.data.lines.splice(0, 1, { ...first, cartons: 30, totalPcs: 750, netWeightKg: 165, grossWeightKg: 187.5 }, { ...first, cartons: 10, totalPcs: 250, netWeightKg: 55, grossWeightKg: 62.5 });
    }
    const ctx = buildContext([invoice(), pl]);
    const line = ctx.shipment.invoices[0].lines[0];
    expect(ctx.links[0].pl).toHaveLength(2);
    expect(line.cartons).toBe(40);
    expect(line.netWeightKg).toMatchObject({ value: 220, status: 'derived' });
  });

  it('finds named producers in notes', () => {
    const found = manufacturersInNotes(['3. Carton 9: samples produced at our sister unit Delta Knits Pvt. Ltd., Plot 7, Colombo, Sri Lanka.', 'Goods manufactured by our contracted factory in Binh Duong, Vietnam.']);
    expect(found.map((a) => [a.name, a.country])).toEqual([['Delta Knits Pvt. Ltd.', 'LK']]);
  });

  it('prefers the invoice line origin, then the packing list, then the header', () => {
    const inv = invoice({ countryOfOrigin: 'IN' });
    if (inv.data.kind === 'commercial_invoice') inv.data.lines[0].countryOfOrigin = 'Sri Lanka';
    const pl = packingList();
    if (pl.data.kind === 'packing_list') pl.data.lines[1].countryOfOrigin = 'BD';
    const lines = buildContext([inv, pl]).shipment.invoices[0].lines;
    expect(lines.map((l) => [l.countryOfOrigin.value, l.countryOfOrigin.sources[0].docType])).toEqual([['LK', 'commercial_invoice'], ['BD', 'packing_list']]);
  });
});

describe('provenance', () => {
  it('takes Sourced confidence from fieldMeta, including child fields', () => {
    const doc = billOfLading({}, { fieldMeta: { 'packages.count': { conf: 62 }, grossWeightKg: { conf: 91 } } });
    const s = buildContext([invoice(), doc]).shipment;
    expect(s.packages?.conf).toBe(62);
    expect(s.grossWeightKg?.conf).toBe(91);
    expect(s.invoices[0].lines[0].quantity.conf).toBeUndefined();
  });
});
