/**
 * Hand-built parser outputs shaped like the three synthetic shipments documented in
 * samples/synthetic/README.md (air/EUR/FCA without packing list; scanned combined CI+PL under DDP
 * with an included price breakdown; minimal US-style invoice from India with a bad container).
 * Asserts the T3-owned parts of their issuesInclude / issuesExclude lists.
 */
import type { AirWaybillData, ExtractedDocument, Issue, IssueCode } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { reconcile } from '../../src/reconcile';
import { isValidContainerNumber } from '../../src/reconcile/lib/iso6346';
import { addr, airWaybill, billOfLading, invLine, invoice } from './helpers';

const codes = (issues: Issue[]) => new Set(issues.map((i) => i.code));
function expectCodes(issues: Issue[], include: IssueCode[], exclude: IssueCode[]) {
  const c = codes(issues);
  for (const x of include) expect(c.has(x), `expected ${x}`).toBe(true);
  for (const x of exclude) expect(c.has(x), `unexpected ${x}: ${issues.find((i) => i.code === x)?.detail}`).toBe(false);
}

describe('air / EUR / FCA, no packing list', () => {
  const seller = addr('RHEINWERK KUECHENTECHNIK GMBH', 'DE', { city: 'Solingen' });
  const buyer = addr('LAKESHORE CULINARY SUPPLY CO.', 'US', { city: 'Chicago', stateProvince: 'IL', postalCode: '60607' });
  const docs = (carrierCode: string): ExtractedDocument[] => [
    invoice({
      invoiceNumber: 'RW-26-10387', invoiceDateRaw: '18.09.2026', invoiceDate: '2026-09-18', seller, buyer, currency: 'EUR',
      incoterm: { code: 'FCA', place: 'Frankfurt Airport' }, countryOfOrigin: 'DE', etd: undefined, eta: undefined,
      lines: [
        invLine({ lineNo: 1, styleNo: 'RW-4012-SS', description: 'Steak knife, 12 cm', hsCode: '8211.91.40', quantity: 2400, unit: 'PCS', unitPrice: 3.85, amount: 9240 }),
        invLine({ lineNo: 2, styleNo: 'RW-4020-PM', description: 'Steak knife, 11 cm', hsCode: '8211.91.50', quantity: 1800, unit: 'PCS', unitPrice: 2.15, amount: 3870 }),
        invLine({ lineNo: 3, styleNo: 'RW-7310-B3', description: 'Mixing bowl set', hsCode: '7323.93.00', quantity: 400, unit: 'SETS', unitPrice: 11.6, amount: 4640 }),
        invLine({ lineNo: 4, styleNo: 'RW-7324-SB', description: 'Colander 24 cm', hsCode: '7323.93.00', quantity: 640, unit: 'PCS', unitPrice: 6.45, amount: 4128 }),
      ],
      totals: [{ label: 'Gesamtbetrag / Total EUR', amount: 21878 }],
      totalPackages: { count: 46, unit: 'CARTONS' },
      packingTotals: { grossWeightKg: 1342, netWeightKg: 1190 },
    }),
    airWaybill({ awbNumber: 'MSA2604417', masterAwbNumber: '020-12345675', carrierCode, carrierName: 'LUFTHANSA CARGO', shipper: seller, consignee: buyer, pieces: 46, grossWeightKg: 1342, chargeableWeightKg: 1498, flightDate: '2026-09-19' }),
  ];

  it('flags only the missing packing list among T3 issues', () => {
    const { issues } = reconcile(docs('LH'));
    expectCodes(issues, ['MISSING_DOCUMENT'], [
      'NON_DUTIABLE_CHARGES', 'CHARGES_NOT_ITEMIZED', 'LINE_AMOUNT_MISMATCH', 'TOTALS_MISMATCH', 'CONTAINER_NUMBER_INVALID',
      'CONTAINER_NUMBER_CORRECTED', 'DATE_AMBIGUOUS', 'ORIGIN_DIFFERS', 'NCV_VALUE', 'ASSIST', 'QTY_MISMATCH', 'GROSS_WEIGHT_MISMATCH',
      'PACKAGE_COUNT_MISMATCH', 'TELEX_RELEASE',
    ]);
    expect(issues.find((i) => i.code === 'MISSING_DOCUMENT')?.id).toBe('MISSING_DOCUMENT:packing_list');
  });

  it('maps the air waybills; a numeric AWB prefix is not used as carrier code', () => {
    expect(reconcile(docs('LH')).shipment.bills).toEqual([{ house: { number: 'MSA2604417' }, master: { scac: 'LH', number: '02012345675' } }]);
    const r = reconcile(docs('020'));
    expect(r.shipment.bills).toEqual([{ house: { number: 'MSA2604417' }, master: { number: '02012345675' } }]);
    expect(r.shipment.transport.carrierScac).toBeUndefined();
    expect(r.shipment.grossWeightKg?.value).toBe(1342);
  });

  it('uses the IATA designator from the flight (carrierIata) when the AWB prefix is numeric', () => {
    const d = docs('020');
    (d[1].data as AirWaybillData).carrierIata = 'LH';
    const r = reconcile(d);
    expect(r.shipment.bills).toEqual([{ house: { number: 'MSA2604417' }, master: { scac: 'LH', number: '02012345675' } }]);
    expect(r.shipment.transport.carrierScac).toBe('LH');
  });
});

describe('scanned combined invoice + packing list, DDP with an included price breakdown', () => {
  const buyer = addr('TYBEE TRADING COMPANY LLC', 'US', { city: 'Savannah', stateProvince: 'GA', postalCode: '31401' });
  const line = (lineNo: number, styleNo: string, description: string, hs: string, quantity: number, unitPrice: number, amount: number, cartons: number, gw: number) =>
    invLine({ lineNo, styleNo, description, hsCode: hs, quantity, unit: 'PCS', unitPrice, amount, cartons, grossWeightKg: gw, countryOfOrigin: undefined });
  const docs: ExtractedDocument[] = [
    invoice(
      {
        invoiceNumber: 'NBHY-260917', invoiceDateRaw: 'SEP. 08, 2026', invoiceDate: '2026-09-08',
        seller: addr('NINGBO HAOYU HOME & TRAVEL GOODS CO., LTD.', 'CN', { city: 'Ningbo' }), buyer,
        incoterm: { code: 'DDP', place: 'Savannah, GA' }, countryOfOrigin: 'CN', etd: undefined, eta: '2026-10-20',
        lines: [
          line(1, 'HY-ST2201', 'ACACIA WOOD SIDE TABLE', '9403.60.80', 240, 18.5, 4440, 120, 1620),
          line(2, 'HY-BS4410', 'BOOKSHELF 5-TIER', '9403.60.80', 150, 32.4, 4860, 150, 2475),
          line(3, 'HY-BP3080', 'LAPTOP BACKPACK', '4202.92.31', 1200, 6.85, 8280, 60, 840),
          line(4, 'HY-BP3090', 'KIDS BACKPACK', '4202.92.31', 800, 4.25, 3400, 40, 400),
        ],
        charges: [
          { type: 'freight', amount: 2850, description: 'Ocean freight Ningbo - Savannah' },
          { type: 'insurance', amount: 96, description: 'Cargo insurance' },
          { type: 'other', amount: 1214, description: 'US duties & customs fees (estimate)' },
          { type: 'other', amount: 420, description: 'US inland delivery to door' },
        ],
        totals: [{ label: 'TOTAL DDP SAVANNAH, GA (USD)', amount: 20920 }],
        totalPackages: { count: 370, unit: 'CTNS' },
        packingTotals: { cartons: 370, netWeightKg: 4830, grossWeightKg: 5335, volumeCbm: 58.6 },
      },
      { docType: 'invoice_packing_list', source: 'ocr' },
    ),
    billOfLading({
      blType: 'house', blNumber: 'CXSVNGB26091187', issuerScac: 'CXSV', issuerName: 'CROSSWAVE LOGISTICS', masterBlNumber: 'ZSPLNGB2609180',
      carrierScac: 'ZSPL', carrierName: 'ZEN SHIPPING LINE', consignee: buyer, notifyParty: buyer, shipper: addr('NINGBO HAOYU HOME & TRAVEL GOODS CO., LTD.', 'CN'),
      portOfLoading: 'NINGBO, CHINA', portOfDischarge: 'SAVANNAH, GA', placeOfDelivery: 'SAVANNAH, GA', onBoardDate: '2026-09-15',
      containers: [{ number: 'ZSPU4182074', checkDigitValid: true, sealNumbers: ['ZS1'] }], packages: { count: 370, unit: 'CARTONS' }, grossWeightKg: 5335,
      freightTerms: 'FREIGHT PREPAID', charges: [{ description: 'OCEAN FREIGHT', terms: 'prepaid' }], releaseType: 'original',
    }),
  ];
  const { shipment, issues } = reconcile(docs);

  it('corrects line 3, deducts the breakdown, and raises no false positives', () => {
    expect(isValidContainerNumber('ZSPU4182074')).toBe(true);
    expectCodes(issues, ['LINE_AMOUNT_MISMATCH', 'NON_DUTIABLE_CHARGES'], [
      'MISSING_DOCUMENT', 'CHARGES_NOT_ITEMIZED', 'TOTALS_MISMATCH', 'CONTAINER_NUMBER_INVALID', 'CONTAINER_NUMBER_CORRECTED', 'DATE_AMBIGUOUS',
      'GROSS_WEIGHT_MISMATCH', 'PACKAGE_COUNT_MISMATCH', 'ORIGIN_DIFFERS', 'NCV_VALUE', 'ASSIST', 'QTY_MISMATCH', 'TELEX_RELEASE', 'ULTIMATE_CONSIGNEE_ASSUMED',
    ]);
    expect(issues.find((i) => i.id === 'LINE_AMOUNT_MISMATCH:inv0-line3')?.decision?.chosen).toBe('computed');
    expect(shipment.invoices[0].lines[2].amount.value).toBe(8220);
  });

  it('marks the lines as including the charges and types them for deduction', () => {
    const inv = shipment.invoices[0];
    expect(inv.linesAreFob).toBe(false);
    expect(inv.charges.map((c) => c.type)).toEqual(['freight', 'insurance', 'duty', 'inland_freight_us']);
    expect(issues.find((i) => i.code === 'NON_DUTIABLE_CHARGES')?.detail).toMatch(/4,580\.00/);
    expect(shipment.bills).toEqual([{ house: { scac: 'CXSV', number: 'NGB26091187' }, master: { scac: 'ZSPL', number: 'NGB2609180' } }]);
    expect(shipment.invoices[0].lines.map((l) => l.grossWeightKg?.value)).toEqual([1620, 2475, 840, 400]);
  });
});

describe('minimal invoice from India, month-first date, 3PL consignee, bad container', () => {
  const buyer = addr('BRIGHTWATER APPAREL GROUP, INC.', 'US', { city: 'Newark', stateProvince: 'NJ' });
  const docs: ExtractedDocument[] = [
    invoice({
      invoiceNumber: 'KKE/1187/25-26', invoiceDateRaw: '03/04/2026', invoiceDate: '2026-04-03', invoiceDateAmbiguous: true, invoiceDateAlternatives: ['2026-03-04'],
      seller: addr('KAVERI KNIT EXPORTS PVT. LTD.', 'IN', { city: 'Tiruppur' }), buyer, incoterm: { code: 'FOB', place: 'Chennai' }, countryOfOrigin: 'IN', etd: undefined, eta: undefined,
      lines: [
        invLine({ lineNo: 1, styleNo: 'KK-M1042', description: "MEN'S CREW NECK T-SHIRT", details: ['100% COTTON JERSEY'], quantity: 3000, unit: 'PCS', unitPrice: 2.4, amount: 7200 }),
        invLine({ lineNo: 2, styleNo: 'KK-M1046', description: "MEN'S V-NECK T-SHIRT", details: ['100% COTTON JERSEY'], quantity: 2400, unit: 'PCS', unitPrice: 2.25, amount: 5400 }),
        invLine({ lineNo: 3, styleNo: 'LW-W2210', description: "WOMEN'S STRAIGHT LEG TROUSERS", details: ['100% COTTON TWILL', 'MADE IN SRI LANKA (Lanka Weave Garments, Colombo)'], quantity: 1200, unit: 'PCS', unitPrice: 7.15, amount: 8580 }),
      ],
      totals: [{ label: 'TOTAL US$', amount: 21180 }],
      totalPackages: { count: 186, unit: 'CTNS' },
    }),
    billOfLading(
      {
        blType: 'master', blNumber: 'BYXLMAA26031287', issuerScac: 'BYXL', issuerName: 'BAYOU EXPRESS LINE', carrierScac: undefined, carrierName: undefined,
        shipper: addr('KAVERI KNIT EXPORTS PVT. LTD.', 'IN'),
        consignee: addr('RARITAN LOGISTICS SERVICES LLC', 'US', { city: 'Edison', stateProvince: 'NJ', raw: 'RARITAN LOGISTICS SERVICES LLC\n55 Distribution Way, Edison, NJ 08817\nFOR ACCOUNT OF BRIGHTWATER APPAREL GROUP, INC.' }),
        notifyParty: buyer, portOfLoading: 'CHENNAI, INDIA', portOfDischarge: 'NEWARK, NJ', placeOfDelivery: 'EDISON, NJ', onBoardDate: '2026-03-14',
        containers: [{ number: 'BYXU5209184', checkDigitValid: false, sealNumbers: ['BX99'] }], packages: { count: 186, unit: 'CARTONS' }, grossWeightKg: 1986.4,
        freightTerms: 'FREIGHT COLLECT', charges: [], releaseType: 'unknown', countryOfOrigin: undefined,
      },
      { observations: [{ kind: 'stamp', text: 'TELEX RELEASE', page: 1 }] },
    ),
  ];
  const { shipment, issues } = reconcile(docs);

  it('raises the expected issues and never invents a container correction', () => {
    expectCodes(issues, ['ORIGIN_DIFFERS', 'CONTAINER_NUMBER_INVALID', 'ULTIMATE_CONSIGNEE_ASSUMED', 'DATE_AMBIGUOUS', 'MISSING_DOCUMENT', 'TELEX_RELEASE'], [
      'CONTAINER_NUMBER_CORRECTED', 'NON_DUTIABLE_CHARGES', 'CHARGES_NOT_ITEMIZED', 'LINE_AMOUNT_MISMATCH', 'TOTALS_MISMATCH', 'NCV_VALUE', 'ASSIST',
      'QTY_MISMATCH', 'PACKAGE_COUNT_MISMATCH',
    ]);
    expect(shipment.containers[0]).toMatchObject({ number: 'BYXU5209184', checkDigitValid: false });
  });

  it('resolves the date by chronology against the country convention', () => {
    expect(shipment.invoices[0].invoiceDate?.value).toBe('2026-03-04');
    expect(issues.find((i) => i.code === 'DATE_AMBIGUOUS')?.severity).toBe('info');
  });

  it('reads the Sri Lankan line origin from the line text and uses the buyer as ultimate consignee', () => {
    expect(shipment.invoices[0].lines.map((l) => l.countryOfOrigin.value)).toEqual(['IN', 'IN', 'LK']);
    expect(issues.find((i) => i.code === 'ORIGIN_DIFFERS')?.id).toBe('ORIGIN_DIFFERS:inv0-line3');
    expect(shipment.ultimateConsignee?.value.name).toBe('BRIGHTWATER APPAREL GROUP, INC.');
    expect(shipment.importer?.value.name).toBe('BRIGHTWATER APPAREL GROUP, INC.');
    expect(shipment.transport.destinationState).toBe('NJ');
    expect(shipment.bills).toEqual([{ master: { scac: 'BYXL', number: 'MAA26031287' } }]);
    expect(shipment.releaseType).toBe('telex');
  });
});
