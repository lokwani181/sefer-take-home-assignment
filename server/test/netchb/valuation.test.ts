import { describe, expect, it } from 'vitest';
import type { BrokerInputs, Charge, Shipment } from '@app/shared';
import { assembleEntry, buildEntryXml, validateEntryXml } from '../../src/netchb';
import { currencyCountryCode } from '../../src/netchb/assemble';
import { nonDutiableChargeTypes, valueInvoice, type ValuationInvoiceInput, type ValuationLineInput } from '../../src/netchb/valuation';
import { sampleAltClassifications, sampleClassifications, sampleIssues, sampleShipment, stubLookups } from './fixtures/sample';

const L = (lineId: string, amount: number, extra: Partial<ValuationLineInput> = {}): ValuationLineInput => ({
  lineId,
  amount,
  amountLabel: 'Invoice amount',
  noCommercialValue: false,
  assists: [],
  ...extra,
});

const inv = (code: string | undefined, linesAreFob: boolean, charges: Charge[], lines: ValuationLineInput[], currency = 'USD'): ValuationInvoiceInput => ({
  currency,
  incoterm: code ? { code } : undefined,
  linesAreFob,
  charges,
  lines,
});

const C = (type: Charge['type'], amount: number, description: string = type): Charge => ({ type, amount, description });
const values = (r: ReturnType<typeof valueInvoice>) => r.valuations.map((v) => v.enteredValue);

describe('valuation table', () => {
  const lines = () => [L('a', 1000), L('b', 3000)];
  const freightIns = [C('freight', 400), C('insurance', 40)];

  const cases: [string | undefined, boolean, Charge[], number[], string][] = [
    // [incoterm, linesAreFob, charges, expected values, case]
    ['EXW', false, freightIns, [1000, 3000], 'EXW: price excludes transport, nothing to deduct'],
    ['FCA', false, freightIns, [1000, 3000], 'FCA: nothing to deduct'],
    ['FOB', false, freightIns, [1000, 3000], 'FOB: nothing to deduct'],
    ['CFR', false, [C('freight', 400)], [900, 2700], 'CFR: freight prorated by value'],
    ['CIF', false, freightIns, [890, 2670], 'CIF without FOB line values: freight + insurance prorated'],
    ['CIF', true, freightIns, [1000, 3000], 'CIF with FOB line values: already net'],
    ['CIP', false, freightIns, [890, 2670], 'CIP behaves like CIF'],
    ['DAP', false, [...freightIns, C('handling', 60)], [875, 2625], 'DAP: destination handling also deducted'],
    [
      'DDP',
      false,
      [C('freight', 400), C('duty', 300), C('inland_freight_us', 100), C('handling', 60)],
      [785, 2355],
      'DDP itemized: freight, duty, US inland freight and handling deducted',
    ],
    ['DDP', false, [], [1000, 3000], 'DDP not itemized: nothing deducted (reconcile flags it)'],
    [undefined, false, freightIns, [1000, 3000], 'unknown incoterm: conservative, nothing deducted'],
    ['CIF', false, [...freightIns, C('inland_freight_foreign', 80)], [890, 2670], 'foreign inland freight stays dutiable'],
  ];
  it.each(cases)('%s linesAreFob=%s → %j (%s)', (code, fob, charges, expected) => {
    const r = valueInvoice(inv(code, fob, charges, lines()));
    expect(values(r)).toEqual(expected);
  });

  it('records each deduction as a signed, prorated step', () => {
    const r = valueInvoice(inv('CIF', false, freightIns, lines()));
    const a = r.valuations[0];
    expect(a.steps.map((s) => [s.label, s.amount])).toEqual([
      ['Invoice amount', 1000],
      ['Less international freight (CIF, non-dutiable)', -100],
      ['Less insurance (CIF, non-dutiable)', -10],
    ]);
    expect(a.steps[1].note).toBe('Itemized 400.00 USD × 25.0% of invoice line value');
    expect(r.deducted).toEqual({ freight: 400, insurance: 40 });
  });

  it('adds itemized packing and selling commissions on top of FOB line values, but not buying commissions', () => {
    const r = valueInvoice(
      inv('FOB', true, [C('packing', 200), C('commission', 100, 'Selling agent commission'), C('commission', 50, 'Buying agent commission')], lines()),
    );
    expect(values(r)).toEqual([1075, 3225]);
    expect(r.added).toEqual({ packing: 200, commission: 100 });
  });

  it('NCV lines use the stated value and do not share prorated charges', () => {
    const r = valueInvoice(inv('CIF', false, freightIns, [L('a', 1000), L('b', 3000), L('s', 0, { noCommercialValue: true, customsValue: 24 })]));
    expect(values(r)).toEqual([890, 2670, 24]);
    expect(r.valuations[2].steps).toHaveLength(1);
  });

  it('assist: 100% to a single carrying line', () => {
    const assist = { description: 'Moulds', value: 500, styleRefs: ['X'] };
    const r = valueInvoice(inv('FOB', true, [], [L('a', 1000, { assists: [assist] }), L('b', 3000)]));
    expect(values(r)).toEqual([1500, 3000]);
    expect(r.valuations[0].steps[1].note).toMatch(/100% of 500.00/);
  });

  it('assist: split by value across the lines that carry it', () => {
    const assist = { description: 'Fabric', value: 400, styleRefs: ['A', 'B'] };
    const r = valueInvoice(inv('FOB', true, [], [L('a', 1000, { assists: [assist] }), L('b', 3000, { assists: [assist] }), L('c', 500)]));
    expect(values(r)).toEqual([1100, 3300, 500]);
    expect(r.valuations[1].steps[1].note).toMatch(/split by line value across 2 lines: 75.0%/);
  });

  // 19 USC 1401a(b)(1): price actually paid; (b)(4)(B): only decreases made after importation are disregarded
  it('apportions a discount deducted on the invoice by line value (FOB lines)', () => {
    const disc = [C('discount', -5299.63, 'LESS : 3% VOLUME DISCOUNT')];
    const lines4 = [L('a', 45792), L('b', 39024), L('c', 36158.4), L('d', 55680)];
    const r = valueInvoice({ ...inv('FOB', true, disc, lines4), discountsDeducted: true });
    expect(values(r)).toEqual([44418, 37853, 35074, 54010]);
    expect(r.deducted.discount).toBeCloseTo(5299.63, 2);
    expect(r.valuations[0].steps[1]).toMatchObject({ label: expect.stringMatching(/discount/i), amount: -1373.76 });
  });

  it('keeps the undiscounted price when the discount is not shown as deducted on the invoice', () => {
    const disc = [C('discount', -300, 'Volume rebate')];
    expect(values(valueInvoice(inv('FOB', true, disc, [L('a', 1000), L('b', 3000)])))).toEqual([1000, 3000]);
  });

  it('rounds only at the end and records the rounding step', () => {
    const r = valueInvoice(inv('CIF', false, [C('freight', 100)], [L('a', 333.33), L('b', 333.33), L('c', 333.34)]));
    // 333.33 − 33.333 = 299.997 → 300 (rounding per line only at the end)
    expect(values(r)).toEqual([300, 300, 300]);
    for (const v of r.valuations) {
      const sum = v.steps.reduce((s, x) => s + x.amount, 0);
      expect(Math.abs(sum - v.enteredValue)).toBeLessThan(0.011);
    }
  });

  it('keeps the invoice currency', () => {
    const r = valueInvoice(inv('FCA', false, [], [L('a', 1234.56)], 'EUR'));
    expect(r.valuations[0]).toMatchObject({ currency: 'EUR', enteredValue: 1235 });
  });

  it('non-dutiable charge types per incoterm', () => {
    expect(nonDutiableChargeTypes({ code: 'fob' })).toEqual([]);
    expect(nonDutiableChargeTypes({ code: 'CIF' })).toEqual(['freight', 'insurance', 'inland_freight_us']);
    expect(nonDutiableChargeTypes({ code: 'DDP' })).toContain('duty');
    expect(nonDutiableChargeTypes(undefined)).toEqual([]);
  });
});

function shipmentWith(mutate: (s: Shipment) => void): Shipment {
  const s = sampleShipment();
  mutate(s);
  return s;
}

function assemble(shipment: Shipment, brokerInputs: BrokerInputs = {}) {
  return assembleEntry({
    shipment,
    classifications: sampleClassifications(),
    altClassifications: sampleAltClassifications(),
    brokerInputs,
    issues: sampleIssues(),
    lookups: stubLookups(),
  });
}

describe('valuation through assembleEntry', () => {
  it('CIF invoice whose line amounts include freight: lines prorated, header charges still 4,035', () => {
    const out = assemble(shipmentWith((s) => (s.invoices[0].linesAreFob = false)));
    const values = out.entryModel.invoices[0].lineItems.map((l) => l.tariffs[0].value);
    // 4,035 prorated over the four commercial lines (23,235); the NCV line is untouched; the assist is added after.
    expect(values).toEqual([5652, 7338, 5169, 5221, 24]);
    expect(out.entryModel.header.charges).toBe(4035);
    expect(out.entryModel.header.totalEntryValue).toBe(values.reduce((a, b) => a + b, 0));
  });

  it('EUR: currency country from the seller when the export country is outside the eurozone or unknown', async () => {
    const out = assemble(
      shipmentWith((s) => {
        s.invoices[0].currency = 'EUR';
        s.countryOfExport = 'CH';
        s.seller = { ...s.seller!, country: 'DE' };
      }),
    );
    expect(out.entryModel.invoices[0].foreignCurrency).toEqual({ currencyCode: 'EUR', exchangeRate: undefined, currencyCountryCode: 'DE' });
    const none = assemble(
      shipmentWith((s) => {
        s.invoices[0].currency = 'EUR';
        delete s.countryOfExport;
        s.seller = { ...s.seller!, country: 'FR' };
      }),
    );
    expect(none.entryModel.invoices[0].foreignCurrency?.currencyCountryCode).toBe('FR');
    expect(await validateEntryXml(buildEntryXml(none.entryModel))).toEqual({ valid: true, errors: [] });
  });

  it('shared currencies (XOF, XAF, XCD) take the shipment country that uses them', () => {
    expect(currencyCountryCode('XOF', 'SN')).toBe('SN');
    expect(currencyCountryCode('XAF', 'US', ['CM'])).toBe('CM');
    expect(currencyCountryCode('XCD', undefined, ['LC'])).toBe('LC');
    expect(currencyCountryCode('XOF', 'FR')).toBeUndefined();
    expect(currencyCountryCode('XAU', 'SN')).toBeUndefined();
    expect(currencyCountryCode('GBP', 'DE')).toBe('GB');
    expect(currencyCountryCode('EUR', 'CH', ['US', 'AT'])).toBe('AT');
  });

  it('foreign currency without a rate: foreign-currency element, warning, totals omitted', async () => {
    const out = assemble(
      shipmentWith((s) => {
        s.invoices[0].currency = 'EUR';
        s.countryOfExport = 'DE';
      }),
    );
    const invoice = out.entryModel.invoices[0];
    expect(invoice.foreignCurrency).toEqual({ currencyCode: 'EUR', exchangeRate: undefined, currencyCountryCode: 'DE' });
    expect(invoice.lineItems[0].tariffs[0].value).toBe(6840); // stays in EUR
    expect(out.valuations[0].currency).toBe('EUR');
    const cc = out.issues.find((i) => i.id === 'CURRENCY_CONVERSION')!;
    expect(cc.severity).toBe('warning');
    expect(cc.detail).toMatch(/Assumption \(unverified\)/);
    expect(out.entryModel.header.totalEntryValue).toBeUndefined();
    expect(out.entryModel.header.charges).toBeUndefined();
    expect(out.estimates.mpf).toBe(0);
    expect(out.estimates.lines[0].duty).toBeUndefined();
    expect(out.estimates.notes.join(' ')).toMatch(/EUR/);
    const xml = buildEntryXml(out.entryModel);
    expect(xml).toContain('<currency-code>EUR</currency-code>');
    expect(xml).toContain('<currency-country-code>DE</currency-country-code>');
    expect(xml).not.toContain('<exchange-rate>');
    expect(await validateEntryXml(xml)).toEqual({ valid: true, errors: [] });
  });

  it('foreign currency with a broker exchange rate converts totals and estimates', async () => {
    const out = assemble(
      shipmentWith((s) => (s.invoices[0].currency = 'EUR')),
      { exchangeRates: { EUR: 1.1 } },
    );
    expect(out.entryModel.invoices[0].foreignCurrency).toMatchObject({ currencyCode: 'EUR', exchangeRate: 1.1 });
    expect(out.entryModel.header.totalEntryValue).toBe(Math.round(27439 * 1.1));
    expect(out.entryModel.header.charges).toBe(Math.round(4035 * 1.1));
    expect(out.estimates.lines[0].duty).toBeCloseTo(6840 * 1.1 * 0.165, 2);
    const xml = buildEntryXml(out.entryModel);
    expect(xml).toContain('<exchange-rate>1.1</exchange-rate>');
    expect((await validateEntryXml(xml)).valid).toBe(true);
  });
});
