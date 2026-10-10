/**
 * Builders for small hand-made ExtractedDocuments. The base shipment is a clean, consistent FOB
 * shipment (Indian knitwear, ocean, one container) unrelated to the sample; rule tests break one
 * thing at a time.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Address,
  AirWaybillData,
  BillOfLadingData,
  CommercialInvoiceData,
  DocType,
  ExtractedDocument,
  InvoiceLine,
  Issue,
  OtherDocData,
  PackingListData,
  PackingListLine,
} from '@app/shared';
import { buildContext } from '../../src/reconcile/merge';
import type { ReconcileContext, Rule } from '../../src/reconcile/context';

export const addr = (name: string, country: string, extra: Partial<Address> = {}): Address => ({
  name,
  lines: extra.lines ?? [],
  country,
  raw: extra.raw ?? [name, ...(extra.lines ?? []), extra.city, extra.stateProvince, extra.postalCode, country].filter(Boolean).join('\n'),
  ...extra,
});

function doc<T extends ExtractedDocument['data']>(docId: string, docType: DocType, data: T, extra: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    docId,
    fileName: `${docId}.pdf`,
    docType,
    classificationScore: 1,
    source: 'text',
    pageCount: 1,
    data,
    fieldMeta: {},
    observations: [],
    warnings: [],
    ...extra,
  };
}

export const SELLER = addr('SUNRISE KNITWEAR PVT. LTD.', 'IN', { lines: ['14 Mill Road'], city: 'Tiruppur', stateProvince: 'Tamil Nadu' });
export const BUYER = addr('HARBOR LANE APPAREL LLC', 'US', { lines: ['900 Alameda St'], city: 'Los Angeles', stateProvince: 'CA', postalCode: '90021' });

export const invLine = (l: Partial<InvoiceLine> & { lineNo: number }): InvoiceLine => ({
  description: '',
  details: [],
  quantity: 0,
  unit: 'PCS',
  ...l,
});

export const BASE_LINES: InvoiceLine[] = [
  invLine({
    lineNo: 1, styleNo: 'SK-100', description: "MEN'S PIQUE POLO SHIRT", details: ['100% cotton pique, knitted'], hsCode: '6105.10',
    quantity: 1000, unit: 'PCS', unitPrice: 4.5, amount: 4500, composition: [{ fiber: 'cotton', pct: 100 }], compositionRaw: '100% cotton',
    construction: 'knit', gender: 'men', garmentType: 'polo',
  }),
  invLine({
    lineNo: 2, styleNo: 'SK-200', description: "WOMEN'S CARDIGAN", details: ['80% polyester 20% viscose, knitted'], hsCode: '6110.30',
    quantity: 500, unit: 'PCS', unitPrice: 8, amount: 4000, composition: [{ fiber: 'polyester', pct: 80 }, { fiber: 'viscose', pct: 20 }],
    compositionRaw: '80% polyester 20% viscose', construction: 'knit', gender: 'women', garmentType: 'sweater',
  }),
];

export function invoice(over: Partial<CommercialInvoiceData> = {}, extra: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const data: CommercialInvoiceData = {
    kind: 'commercial_invoice',
    invoiceNumber: 'SK-INV-0042',
    invoiceDateRaw: '02-MAR-2026',
    invoiceDate: '2026-03-02',
    seller: SELLER,
    buyer: BUYER,
    poNumbers: ['HL-7781'],
    currency: 'USD',
    incoterm: { code: 'FOB', place: 'CHENNAI' },
    countryOfOrigin: 'IN',
    portOfLoading: 'CHENNAI, INDIA',
    portOfDischarge: 'LOS ANGELES, CA',
    etd: '2026-03-08',
    eta: '2026-04-10',
    lines: structuredClone(BASE_LINES),
    charges: [],
    totals: [{ label: 'TOTAL FOB CHENNAI (USD)', amount: 8500 }],
    totalPackages: { count: 60, unit: 'CARTONS' },
    assists: [],
    notes: [],
    ...over,
  };
  return doc('t-ci', 'commercial_invoice', data, extra);
}

export const plLine = (l: Partial<PackingListLine>): PackingListLine => ({ description: '', details: [], ...l });

export function packingList(over: Partial<PackingListData> = {}, extra: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const data: PackingListData = {
    kind: 'packing_list',
    plNumber: 'SK-PL-0042',
    date: '2026-03-04',
    invoiceRefs: ['SK-INV-0042'],
    poNumbers: ['HL-7781'],
    shipper: SELLER,
    consignee: BUYER,
    lines: [
      plLine({ styleNo: 'SK-100', description: 'MENS POLO', details: ['100% COTTON PIQUE'], cartons: 40, pcsPerCarton: 25, totalPcs: 1000, netWeightKg: 220, grossWeightKg: 250, composition: [{ fiber: 'cotton', pct: 100 }], compositionRaw: '100% COTTON' }),
      plLine({ styleNo: 'SK-200', description: 'LADIES CARDIGAN', details: ['80/20 POLY/VISCOSE'], cartons: 20, pcsPerCarton: 25, totalPcs: 500, netWeightKg: 175, grossWeightKg: 190, composition: [{ fiber: 'polyester', pct: 80 }, { fiber: 'viscose', pct: 20 }], compositionRaw: '80/20 POLY/VISCOSE' }),
    ],
    totals: { cartons: 60, pcs: 1500, netWeightKg: 395, grossWeightKg: 440 },
    remarks: [],
    ...over,
  };
  return doc('t-pl', 'packing_list', data, { source: 'ocr', ...extra });
}

export function billOfLading(over: Partial<BillOfLadingData> = {}, extra: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const data: BillOfLadingData = {
    kind: 'bill_of_lading',
    blType: 'master',
    blNumber: 'SEAU260300123',
    issuerName: 'SEAWAYS CONTAINER LINE',
    issuerScac: 'SEAU',
    carrierName: 'SEAWAYS CONTAINER LINE',
    carrierScac: 'SEAU',
    shipper: SELLER,
    consignee: BUYER,
    notifyParty: BUYER,
    exportReferences: ['SK-INV-0042'],
    vessel: 'NORTHERN STAR',
    voyage: '112E',
    portOfLoading: 'CHENNAI, INDIA',
    portOfDischarge: 'LOS ANGELES, CA',
    placeOfDelivery: 'LOS ANGELES, CA',
    onBoardDate: '2026-03-08',
    issueDate: '2026-03-08',
    containers: [{ number: 'CSQU3054383', checkDigitValid: true, sealNumbers: ['SL123456'], sizeType: '40HC' }],
    packages: { count: 60, unit: 'CARTONS' },
    grossWeightKg: 440,
    cargoDescription: ['60 CARTONS KNITTED GARMENTS'],
    hsCodes: ['6105.10', '6110.30'],
    freightTerms: 'FREIGHT COLLECT',
    charges: [{ description: 'OCEAN FREIGHT', terms: 'collect' }],
    releaseType: 'original',
    countryOfOrigin: 'IN',
    ...over,
  };
  return doc('t-bl', 'bill_of_lading', data, { source: 'ocr', ...extra });
}

export function airWaybill(over: Partial<AirWaybillData> = {}, extra: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const data: AirWaybillData = {
    kind: 'air_waybill',
    awbNumber: 'FRA-7781234',
    awbType: 'house',
    masterAwbNumber: '176-12345675',
    carrierCode: 'EK',
    carrierName: 'EMIRATES SKYCARGO',
    shipper: addr('KUECHENWERK GMBH', 'DE', { city: 'Solingen' }),
    consignee: addr('CHEF SUPPLY CO', 'US', { city: 'Chicago', stateProvince: 'IL', postalCode: '60607' }),
    airportOfDeparture: 'FRANKFURT (FRA), GERMANY',
    airportOfDestination: "CHICAGO O'HARE (ORD)",
    flight: 'EK 9912',
    flightDate: '2026-05-02',
    pieces: 12,
    grossWeightKg: 180,
    goodsDescription: ['KITCHEN KNIVES'],
    hsCodes: [],
    charges: [],
    ...over,
  };
  return doc('t-awb', 'air_waybill', data, { source: 'ocr', ...extra });
}

export function otherDoc(docId: string, docType: DocType, text: string, title?: string): ExtractedDocument {
  const data: OtherDocData = { kind: 'other', text, ...(title ? { title } : {}) };
  return doc(docId, docType, data, { classificationScore: 0.2 });
}

export const arrivalNotice = (text = 'ARRIVAL NOTICE\nB/L SEAU260300123\nArrival Date: 04/09/2026\nFirms code: Y123') => otherDoc('t-an', 'arrival_notice', text, 'ARRIVAL NOTICE');

/** The clean base shipment: invoice + packing list + master B/L + arrival notice. */
export const baseDocs = (): ExtractedDocument[] => [invoice(), packingList(), billOfLading(), arrivalNotice()];

/** Build a context from docs and run one rule on it. */
export function runRule(rule: Rule, docs: ExtractedDocument[]): { issues: Issue[]; ctx: ReconcileContext } {
  const ctx = buildContext(docs);
  return { issues: rule.run(ctx), ctx };
}

export const ids = (issues: Issue[]): string[] => issues.map((i) => i.id);

const fixtureDir = join(import.meta.dirname, '..', 'fixtures', 'sample');
/** The three sample documents' ground-truth ExtractedDocuments. */
export function sampleDocs(): ExtractedDocument[] {
  return ['invoice', 'packing-list', 'bill-of-lading'].map((n) => JSON.parse(readFileSync(join(fixtureDir, `${n}.expected.json`), 'utf8')) as ExtractedDocument);
}

export function golden(): {
  expectedIssues: { id: string; severity: string; decisionKey?: string; defaultChoice?: string }[];
  mustNotHaveIssues: string[];
} {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'golden', 'sample-expected.json'), 'utf8'));
}
