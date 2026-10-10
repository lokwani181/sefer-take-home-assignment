/**
 * Generalization: the T7 synthetic shipments use layouts, wording, column orders, number
 * formats and document mixes that differ from the sample on purpose. Layout snapshots are in
 * fixtures/synthetic (regenerate with fixtures/make-synthetic-layouts.py); the expectations below
 * are copied from samples/synthetic/<case>/expected.json so this test is a stable snapshot.
 * Values the worst-case OCR could not read at all are listed explicitly as known losses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AirWaybillData, BillOfLadingData, CommercialInvoiceData, DocumentLayout, ExtractedDocument } from '@app/shared';
import { parseDocument } from '../../src/parse';

const dir = join(import.meta.dirname, 'fixtures', 'synthetic');
const parse = (c: string, f: string): ExtractedDocument => parseDocument(JSON.parse(readFileSync(join(dir, c, `${f}.layout.json`), 'utf8')) as DocumentLayout);

interface LineExp {
  lineNo: number;
  styleNo?: string;
  descriptionContains: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  countryOfOrigin: string;
  hs?: string;
}

const results: string[] = [];
let checks = 0;
let passed = 0;
/** Soft-counts a field check for the metrics table and asserts it. */
function check(label: string, actual: unknown, expected: unknown) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else results.push(`  MISS ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  expect(actual, label).toEqual(expected);
}

function checkLines(doc: ExtractedDocument, exp: LineExp[], skip: Record<number, Array<keyof LineExp>> = {}) {
  const d = doc.data as CommercialInvoiceData;
  check('line count', d.lines.length, exp.length);
  for (const e of exp) {
    const l = d.lines.find((x) => x.lineNo === e.lineNo)!;
    const text = [l.description, ...l.details].join(' ').toUpperCase();
    const actual: Record<string, unknown> = {
      styleNo: l.styleNo,
      descriptionContains: text.includes(e.descriptionContains.toUpperCase()) ? e.descriptionContains : text.slice(0, 40),
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
      countryOfOrigin: l.countryOfOrigin ?? d.countryOfOrigin,
      hs: l.hsCode,
    };
    for (const k of Object.keys(actual) as Array<keyof LineExp>) {
      if (k === 'lineNo' || (skip[e.lineNo] ?? []).includes(k)) continue;
      check(`line ${e.lineNo}.${k}`, actual[k], e[k]);
    }
  }
}

describe('S1: German invoice (text layer, EUR, bilingual labels) + scanned house AWB', () => {
  it('invoice', () => {
    const doc = parse('s1-air-eur-fca', 'RW-26-10387_Rechnung');
    const d = doc.data as CommercialInvoiceData;
    check('docType', doc.docType, 'commercial_invoice');
    check('invoiceNumber', d.invoiceNumber, 'RW-26-10387');
    check('invoiceDate', d.invoiceDate, '2026-09-18');
    check('currency', d.currency, 'EUR');
    check('incoterm', [d.incoterm?.code, d.incoterm?.place], ['FCA', 'Frankfurt Airport']);
    check('seller', d.seller?.name, 'Rheinwerk Kuechentechnik GmbH');
    check('buyer (unlabelled address window)', d.buyer?.name, 'Lakeshore Culinary Supply Co.');
    check('buyer city', d.buyer?.city, 'Chicago');
    check('charges (FCA: none itemized)', d.charges, []);
    checkLines(doc, [
      { lineNo: 1, styleNo: 'RW-4012-SS', descriptionContains: 'Steak knife, 12 cm', quantity: 2400, unit: 'PCS', unitPrice: 3.85, amount: 9240, countryOfOrigin: 'DE', hs: '8211.91.40' },
      { lineNo: 2, styleNo: 'RW-4020-PM', descriptionContains: 'Steak knife, 11 cm', quantity: 1800, unit: 'PCS', unitPrice: 2.15, amount: 3870, countryOfOrigin: 'DE', hs: '8211.91.50' },
      { lineNo: 3, styleNo: 'RW-7310-B3', descriptionContains: 'Mixing bowl set', quantity: 400, unit: 'SETS', unitPrice: 11.6, amount: 4640, countryOfOrigin: 'DE', hs: '7323.93.00' },
      { lineNo: 4, styleNo: 'RW-7324-SB', descriptionContains: 'Colander 24 cm', quantity: 640, unit: 'PCS', unitPrice: 6.45, amount: 4128, countryOfOrigin: 'DE', hs: '7323.93.00' },
    ]);
  });

  it('air waybill', () => {
    const doc = parse('s1-air-eur-fca', 'HAWB_MSA2604417_scan');
    const d = doc.data as AirWaybillData;
    check('docType', doc.docType, 'air_waybill');
    check('awb', [d.awbType, d.awbNumber, d.masterAwbNumber], ['house', 'MSA2604417', '020-12345675']);
    check('grossWeightKg (not the chargeable weight)', d.grossWeightKg, 1342);
    check('chargeableWeightKg', d.chargeableWeightKg, 1498);
    check('pieces', d.pieces, 46);
    check('flight', [d.flight, d.flightDate], ['LH8402', '2026-09-21']);
    check('carrier (IATA from the flight; numeric AWB prefix kept as carrierCode)', [d.carrierIata, d.carrierCode], ['LH', '020']);
    check('airports', [d.airportOfDeparture, d.airportOfDestination], ['FRANKFURT/MAIN (FRA)', "CHICAGO O'HARE (ORD)"]);
    check('shipper', d.shipper?.name, 'RHEINWERK KUECHENTECHNIK GMBH');
    check('consignee', d.consignee?.name, 'LAKESHORE CULINARY SUPPLY CO.');
  });
});

describe('S2: scanned combined invoice & packing list (DDP) + text-layer house B/L', () => {
  it('combined invoice / packing list', () => {
    const doc = parse('s2-scan-cn-ddp', 'scan_20260915_0042');
    const d = doc.data as CommercialInvoiceData;
    check('docType', doc.docType, 'invoice_packing_list');
    check('kind', d.kind, 'commercial_invoice');
    check('invoiceNumber', d.invoiceNumber, 'NBHY-260917');
    check('invoiceDate', d.invoiceDate, '2026-09-08');
    check('currency', d.currency, 'USD');
    check('incoterm', [d.incoterm?.code, d.incoterm?.place?.toUpperCase()], ['DDP', 'SAVANNAH, GA']);
    check('seller', d.seller?.name, 'NINGBO HAOYU HOME & TRAVEL GOODS CO., LTD.');
    check('buyer', d.buyer?.name, 'TYBEE TRADING COMPANY LLC');
    check('itemized DDP charges', d.charges.map((c) => [c.type, c.amount]), [
      ['freight', 2850],
      ['insurance', 96],
      ['duty', 1214],
      ['inland_freight_us', 420],
    ]);
    check('printed total', d.totals.find((t) => /TOTAL AMOUNT/i.test(t.label))?.amount, 20920);
    check('packingTotals', d.packingTotals, { cartons: 370, netWeightKg: 4830, grossWeightKg: 5335 });
    // known OCR loss on the worst-case scan: line 3's style, HS code and description title are not in the OCR text
    checkLines(
      doc,
      [
        { lineNo: 1, styleNo: 'HY-ST2201', descriptionContains: 'ACACIA WOOD', quantity: 240, unit: 'PCS', unitPrice: 18.5, amount: 4440, countryOfOrigin: 'CN', hs: '9403.60.80' },
        { lineNo: 2, styleNo: 'HY-BS4410', descriptionContains: 'BOOKSHELF', quantity: 150, unit: 'PCS', unitPrice: 32.4, amount: 4860, countryOfOrigin: 'CN', hs: '9403.60.80' },
        { lineNo: 3, styleNo: 'HY-BP3080', descriptionContains: 'LAPTOP BACKPACK', quantity: 1200, unit: 'PCS', unitPrice: 6.85, amount: 8280, countryOfOrigin: 'CN', hs: '4202.92.31' },
        { lineNo: 4, styleNo: 'HY-BP3090', descriptionContains: 'KIDS BACKPACK', quantity: 800, unit: 'PCS', unitPrice: 4.25, amount: 3400, countryOfOrigin: 'CN', hs: '4202.92.31' },
      ],
      { 3: ['styleNo', 'hs', 'descriptionContains'] },
    );
    // the printed amount of line 3 disagrees with qty × price and is kept as printed
    expect(doc.observations.some((o) => o.field === 'lines[2].amount')).toBe(true);
  });

  it('house bill of lading', () => {
    const doc = parse('s2-scan-cn-ddp', 'CXSVNGB26091187_BL');
    const d = doc.data as BillOfLadingData;
    check('docType', doc.docType, 'bill_of_lading');
    check('house bill', [d.blType, d.blNumber, d.issuerScac], ['house', 'CXSVNGB26091187', 'CXSV']);
    check('master bill', [d.masterBlNumber, d.carrierScac, d.carrierName], ['ZSPLNGB2609180', 'ZSPL', 'ZHOUSHAN PACIFIC LINES']);
    check('container', d.containers.map((c) => [c.number, c.checkDigitValid, c.sealNumbers, c.sizeType]), [['ZSPU4182074', true, ['ZP0915447'], '40HC']]);
    check('grossWeightKg', d.grossWeightKg, 5335);
    check('volumeCbm', d.volumeCbm, 58.6);
    check('packages', d.packages, { count: 370, unit: 'CARTONS' });
    check('vessel/voyage', [d.vessel, d.voyage], ['ZHOUSHAN PIONEER', '0926E']);
    check('ports', [d.portOfLoading, d.portOfDischarge], ['NINGBO, CHINA', 'SAVANNAH, GA, USA']);
    check('onBoardDate', d.onBoardDate, '2026-09-15');
    check('freight', d.freightTerms, 'FREIGHT PREPAID');
  });
});

describe('S3: US-style invoice from India (MM/DD, no HS) + scanned carrier B/L with a bad check digit', () => {
  it('invoice', () => {
    const doc = parse('s3-messy-minimal', 'Invoice_KKE-1187');
    const d = doc.data as CommercialInvoiceData;
    check('docType', doc.docType, 'commercial_invoice');
    check('invoiceNumber', d.invoiceNumber, 'KKE/1187/25-26');
    // India writes DD/MM, so 03/04/2026 → 3 April primary; the MM/DD reading stays available for chronology
    check('invoiceDate ambiguous', [d.invoiceDateAmbiguous, [d.invoiceDate, ...(d.invoiceDateAlternatives ?? [])].includes('2026-03-04')], [true, true]);
    check('currency', d.currency, 'USD');
    check('incoterm', [d.incoterm?.code, d.incoterm?.place?.toUpperCase()], ['FOB', 'CHENNAI']);
    check('seller', d.seller?.name, 'KAVERI KNIT EXPORTS PVT. LTD.');
    // the letterhead's city line shares a visual line with the DATE / INVOICE # box beside the title
    check('seller address', [d.seller?.lines, d.seller?.city, d.seller?.postalCode, d.seller?.country], [['S.F. No. 214/2, Kangeyam Road'], 'Tiruppur', '641 604', 'IN']);
    check('buyer', d.buyer?.name, 'BRIGHTWATER APPAREL GROUP, INC.');
    check('no HS codes printed', d.lines.map((l) => l.hsCode), [undefined, undefined, undefined]);
    checkLines(doc, [
      { lineNo: 1, styleNo: 'KK-M1042', descriptionContains: 'CREW NECK T-SHIRT', quantity: 3000, unit: 'PCS', unitPrice: 2.4, amount: 7200, countryOfOrigin: 'IN' },
      { lineNo: 2, styleNo: 'KK-M1046', descriptionContains: 'V-NECK T-SHIRT', quantity: 2400, unit: 'PCS', unitPrice: 2.25, amount: 5400, countryOfOrigin: 'IN' },
      { lineNo: 3, styleNo: 'LW-W2210', descriptionContains: 'STRAIGHT LEG TROUSERS', quantity: 1200, unit: 'PCS', unitPrice: 7.15, amount: 8580, countryOfOrigin: 'LK' },
    ]);
    const l3 = d.lines[2];
    check('line 3 manufacturer', l3.manufacturer?.name, 'Lanka Weave Garments (Pvt) Ltd');
    // the maker block ends at the blank line before "186 CTNS / Currency: US$"
    check('line 3 manufacturer address', [l3.manufacturer?.lines, l3.manufacturer?.city, l3.manufacturer?.country], [['41 Baseline Road'], 'Colombo', 'LK']);
    check('line 3 attributes', [l3.gender, l3.construction, l3.garmentType], ['women', 'woven', 'trousers']);
  });

  it('carrier bill of lading: invalid check digit is never "corrected"', () => {
    const doc = parse('s3-messy-minimal', 'BL_BYXLMAA26031287_scan');
    const d = doc.data as BillOfLadingData;
    check('docType', doc.docType, 'bill_of_lading');
    check('bill', [d.blType, d.blNumber, d.issuerScac, d.carrierScac], ['master', 'BYXLMAA26031287', 'BYXL', 'BYXL']);
    check('container', d.containers.map((c) => [c.number, c.checkDigitValid, c.sealNumbers]), [['BYXU5209184', false, ['BX441207']]]);
    check('grossWeightKg', d.grossWeightKg, 1986.4);
    check('vessel/voyage', [d.vessel, d.voyage], ['SEA ORCHID', '611W']);
    check('ports', [d.portOfLoading, d.portOfDischarge], ['CHENNAI, INDIA', 'NEWARK, NJ, USA']);
    check('consignee is the 3PL', d.consignee?.name, 'RARITAN LOGISTICS SERVICES LLC');
    check('freight collect', d.freightTerms, 'FREIGHT COLLECT');
    check('originals', d.originalsCount, 3);
  });

  it('prints the generalization summary', () => {
    console.log(`\nsynthetic generalization: ${passed}/${checks} field checks passed${results.length ? `\n${results.join('\n')}` : ''}`);
    expect(passed).toBe(checks);
  });
});
