/**
 * Hand-built equivalent of what reconcile (T3) + classify (T4) should produce for
 * the sample shipment (PLAN.md §1, server/test/fixtures/sample/*.expected.json).
 * Factories return fresh objects so tests can mutate them freely.
 */
import type {
  Address,
  FeeConfig,
  Issue,
  LineClassification,
  MidResult,
  ReferenceLookups,
  Shipment,
  ShipmentLine,
  SourceRef,
  Sourced,
} from '@app/shared';

const CI: SourceRef = { docId: 'sample-ci', docType: 'commercial_invoice' };
const PL: SourceRef = { docId: 'sample-pl', docType: 'packing_list' };
const BL: SourceRef = { docId: 'sample-bl', docType: 'bill_of_lading' };

function src<T>(value: T, sources: SourceRef[], status: Sourced<T>['status'] = 'extracted', note?: string): Sourced<T> {
  return { value, status, sources, ...(note ? { note } : {}) };
}

export const SELLER: Address = {
  name: 'KOWLOON BAY APPAREL SOURCING LIMITED',
  lines: ['Unit 1708, 17/F, Hing Fat Industrial Building, 223 Wai Yip Street'],
  city: 'Kwun Tong',
  stateProvince: 'Kowloon',
  country: 'HK',
  raw: 'KOWLOON BAY APPAREL SOURCING LIMITED\nUnit 1708, 17/F, Hing Fat Industrial Building, 223 Wai Yip Street, Kwun Tong, Kowloon, Hong Kong',
};

export const BUYER: Address = {
  name: 'NORTHBOUND OUTFITTERS, INC.',
  lines: ['2150 NW Raleigh Street, Suite 300'],
  city: 'Portland',
  stateProvince: 'OR',
  postalCode: '97210',
  country: 'US',
  raw: 'NORTHBOUND OUTFITTERS, INC.\n2150 NW Raleigh Street, Suite 300\nPortland, OR 97210, U.S.A.',
};

export const SHIP_TO: Address = {
  name: 'CASCADE FULFILLMENT PARTNERS LLC',
  lines: ['21820 76th Avenue South, Dock 4'],
  city: 'Kent',
  stateProvince: 'WA',
  postalCode: '98032',
  country: 'US',
  raw: 'CASCADE FULFILLMENT PARTNERS LLC\n21820 76th Avenue South, Dock 4\nKent, WA 98032, U.S.A.',
};

export const FACTORY_VN: Address = {
  name: 'SAIGON PHOENIX GARMENT JOINT STOCK COMPANY',
  lines: ['Lot C7-C8, Road No. 9, Song Than 2 Industrial Park, Di An Ward'],
  city: 'Di An City',
  stateProvince: 'Binh Duong Province',
  country: 'VN',
  taxId: '3702148865',
  raw: 'SAIGON PHOENIX GARMENT JOINT STOCK COMPANY\nLot C7-C8, Road No. 9, Song Than 2 Industrial Park, Di An Ward, Di An City, Binh Duong Province, Vietnam',
};

export const FACTORY_BD: Address = {
  name: 'SP Garments Dhaka Ltd.',
  lines: ['Plot 41'],
  city: 'Gazipur',
  country: 'BD',
  raw: 'SP Garments Dhaka Ltd., Plot 41, Gazipur, Bangladesh',
};

export const CONSOLIDATOR: Address = {
  name: 'BLUE MERIDIAN LOGISTICS (VIETNAM) CO., LTD.',
  lines: [],
  raw: 'BLUE MERIDIAN LOGISTICS (VIETNAM) CO., LTD.',
};

interface LineSpec {
  n: number;
  style: string;
  description: string;
  hs: string;
  qty: number;
  unitPrice: number;
  amount: number;
  printedAmount?: number;
  packedQuantity?: number;
  net: number;
  gross: number;
  cartons: number;
  composition: { fiber: string; pct: number }[];
  altComposition?: { fiber: string; pct: number }[];
  construction: 'knit' | 'woven';
  gender: 'men' | 'women';
  garmentType: string;
  origin?: string;
  ncv?: boolean;
  assists?: ShipmentLine['assists'];
  manufacturer?: Address;
}

function line(spec: LineSpec): ShipmentLine {
  const id = `inv0-line${spec.n}`;
  return {
    id,
    invoiceIndex: 0,
    invoiceLineNo: spec.n,
    styleNo: spec.style,
    description: spec.description,
    details: [],
    hsCodeDeclared: spec.hs,
    attributes: {
      composition: spec.composition,
      compositionSource: 'invoice',
      construction: spec.construction,
      gender: spec.gender,
      garmentType: spec.garmentType,
    },
    ...(spec.altComposition ? { altComposition: spec.altComposition, altCompositionSource: { ...PL, field: `lines[${spec.n - 1}].composition` } } : {}),
    countryOfOrigin: src(spec.origin ?? 'VN', spec.origin ? [CI, PL] : [CI], spec.origin ? 'extracted' : 'derived'),
    ...(spec.manufacturer ? { manufacturer: spec.manufacturer } : {}),
    quantity: src(spec.qty, [CI]),
    unit: 'PCS',
    ...(spec.packedQuantity !== undefined ? { packedQuantity: spec.packedQuantity } : {}),
    unitPrice: spec.unitPrice,
    amount: src(spec.amount, [CI], spec.printedAmount !== undefined ? 'corrected' : 'extracted'),
    ...(spec.printedAmount !== undefined ? { printedAmount: spec.printedAmount } : {}),
    noCommercialValue: !!spec.ncv,
    ...(spec.ncv ? { customsValue: spec.amount } : {}),
    assists: spec.assists ?? [],
    netWeightKg: src(spec.net, [PL]),
    grossWeightKg: src(spec.gross, [PL]),
    cartons: spec.cartons,
    poNumber: 'NB-26-0918',
  };
}

/** The reconciled sample shipment (default decisions not yet applied: amounts are the corrected ones). */
export function sampleShipment(): Shipment {
  return {
    invoices: [
      {
        docId: 'sample-ci',
        invoiceNumber: src('KBAS/NB/26-0912', [CI, PL]),
        invoiceDate: src('2026-09-12', [CI], 'derived'),
        currency: 'USD',
        incoterm: { code: 'CIF', place: 'TACOMA, WA', version: '2020' },
        seller: SELLER,
        buyer: BUYER,
        shipTo: SHIP_TO,
        charges: [
          { type: 'freight', amount: 3850, description: 'Ocean Freight (Cat Lai - Tacoma)' },
          { type: 'insurance', amount: 185, description: 'Marine Insurance Premium' },
        ],
        linesAreFob: true,
        printedTotals: [
          { label: 'TOTAL FOB VALUE (Items 1 - 4)', amount: 23235 },
          { label: 'TOTAL CIF TACOMA, WA (USD)', amount: 27270 },
        ],
        poNumbers: ['NB-26-0918'],
        relatedParty: src(false, [CI], 'assumed'),
        lines: [
          line({
            n: 1, style: 'NB-T101', description: "MEN'S CREW NECK SHORT SLEEVE T-SHIRT", hs: '6109.10',
            qty: 2400, unitPrice: 2.85, amount: 6840, printedAmount: 6480, net: 432, gross: 480, cartons: 48,
            composition: [{ fiber: 'cotton', pct: 100 }], construction: 'knit', gender: 'men', garmentType: 't-shirt',
          }),
          line({
            n: 2, style: 'NB-H205', description: "WOMEN'S PULLOVER HOODIE W/ KANGAROO POCKET", hs: '6110.20',
            qty: 1200, packedQuantity: 1176, unitPrice: 7.4, amount: 8880, net: 715.4, gross: 774.2, cartons: 49,
            composition: [{ fiber: 'cotton', pct: 60 }, { fiber: 'polyester', pct: 40 }],
            altComposition: [{ fiber: 'polyester', pct: 65 }, { fiber: 'cotton', pct: 35 }],
            construction: 'knit', gender: 'women', garmentType: 'hoodie',
          }),
          line({
            n: 3, style: 'NB-C330', description: "MEN'S SLIM FIT CHINO TROUSERS", hs: '6203.42',
            qty: 900, unitPrice: 6.95, amount: 6255, net: 486, gross: 522, cartons: 30,
            composition: [{ fiber: 'cotton', pct: 98 }, { fiber: 'elastane', pct: 2 }], construction: 'woven', gender: 'men', garmentType: 'trousers',
          }),
          line({
            n: 4, style: 'W-B220', description: "WOMEN'S LONG SLEEVE BLOUSE, V-NECK", hs: '6206.40',
            qty: 600, unitPrice: 2.1, amount: 1260, net: 96, gross: 106, cartons: 10,
            composition: [{ fiber: 'polyester', pct: 100 }], construction: 'woven', gender: 'women', garmentType: 'blouse',
            assists: [
              {
                description: 'Main fabric (100% polyester crepe de chine, 1,450 m) supplied free of charge by buyer',
                value: 4180,
                currency: 'USD',
                styleRefs: ['W-B220'],
                reference: 'NB-26-0918F',
              },
            ],
          }),
          line({
            n: 5, style: 'NB-P118S', description: "WOMEN'S SHORT SLEEVE POLO SHIRT - SAMPLES", hs: '6106.10',
            qty: 24, unitPrice: 1, amount: 24, net: 5.1, gross: 5.8, cartons: 1, ncv: true, origin: 'BD', manufacturer: FACTORY_BD,
            composition: [{ fiber: 'cotton', pct: 100 }], construction: 'knit', gender: 'women', garmentType: 'polo',
          }),
        ],
      },
    ],
    importer: src(BUYER, [CI, PL], 'derived'),
    ultimateConsignee: src(BUYER, [CI, PL], 'assumed'),
    shipTo: SHIP_TO,
    notifyParty: BUYER,
    seller: SELLER,
    manufacturers: [FACTORY_VN, FACTORY_BD],
    consolidator: CONSOLIDATOR,
    transport: {
      mode: 'ocean',
      containerized: true,
      vessel: 'PACIFIC ARGOS',
      voyage: '041E',
      carrierName: 'ORIENT PACIFIC LINES',
      carrierScac: 'OPLU',
      portOfLading: 'CAT LAI, HCMC, VN',
      portOfUnlading: 'TACOMA, WA, USA',
      placeOfDelivery: 'KENT, WA (DOOR)',
      exportDate: src('2026-09-24', [BL]),
      arrivalDate: src('2026-10-14', [CI], 'assumed', 'ETA'),
      arrivalDateEstimated: true,
      destinationState: 'WA',
    },
    bills: [{ master: { scac: 'OPLU', number: 'SGN260917735' }, house: { scac: 'BMLV', number: 'HCM26090418' } }],
    containers: [
      {
        number: 'OPLU3041722',
        checkDigitValid: true,
        sealNumbers: ['OPL7731482'],
        sizeType: '20GP',
        candidates: [
          { number: 'OPLU3041728', checkDigitValid: false, source: 'strikethrough' },
          { number: 'OPLU3041722', checkDigitValid: true, source: 'handwritten' },
        ],
      },
    ],
    packages: src({ count: 138, unit: 'CARTONS' }, [BL, PL]),
    grossWeightKg: src(1930, [BL]),
    volumeCbm: 13.58,
    releaseType: 'telex',
    countryOfExport: 'VN',
  };
}

const ev = (docId: string, text: string, page = 1) => [{ docId, page, text }];

/** Reconcile issues (subset) including every decision the sample needs. */
export function sampleIssues(): Issue[] {
  return [
    {
      id: 'LINE_AMOUNT_MISMATCH:inv0-line1', code: 'LINE_AMOUNT_MISMATCH', severity: 'warning', category: 'discrepancy',
      title: 'Line 1 amount corrected: 2,400 × 2.85 = 6,840 (printed 6,480)', detail: 'The printed subtotal corroborates 6,840.',
      evidence: ev('sample-ci', '2,400 PCS 2.85 6,480.00'), action: 'Confirm with the seller.', lineId: 'inv0-line1',
      decision: { key: 'amount:inv0-line1', question: 'Which amount applies to line 1?', options: [{ value: 'computed', label: '6,840 (qty × price)' }, { value: 'printed', label: '6,480 (as printed)' }], chosen: 'computed' },
    },
    {
      id: 'QTY_MISMATCH:inv0-line2', code: 'QTY_MISMATCH', severity: 'blocker', category: 'discrepancy',
      title: 'NB-H205: invoice 1,200 pcs vs packed 1,176 pcs', detail: '49 cartons × 24 pcs = 1,176.',
      evidence: ev('sample-pl', '49 24 1,176'), action: 'Confirm short shipment or obtain a credit note.', lineId: 'inv0-line2',
      decision: { key: 'quantity:inv0-line2', question: 'Which quantity applies to NB-H205?', options: [{ value: 'invoice', label: 'Invoice 1,200 pcs' }, { value: 'packed', label: 'Packed 1,176 pcs' }], chosen: 'invoice' },
    },
    {
      id: 'COMPOSITION_CONFLICT:inv0-line2', code: 'COMPOSITION_CONFLICT', severity: 'blocker', category: 'classification',
      title: 'NB-H205 composition differs (CI 60/40 cotton/poly vs PL TC 65/35)', detail: 'Cotton vs man-made fibre heading.',
      evidence: ev('sample-pl', 'TC 65/35 FLEECE 280GSM'), action: 'Obtain the fibre content specification.', lineId: 'inv0-line2',
      decision: { key: 'composition:inv0-line2', question: 'Which composition applies?', options: [{ value: 'invoice', label: 'Invoice: 60% cotton 40% polyester' }, { value: 'other_doc', label: 'Packing list: 65% polyester 35% cotton' }], chosen: 'invoice' },
    },
    {
      id: 'GROSS_WEIGHT_MISMATCH', code: 'GROSS_WEIGHT_MISMATCH', severity: 'warning', category: 'discrepancy',
      title: 'Gross weight B/L 1,930 kg vs packing list 1,888 kg', detail: 'Difference 42 kg (2.2%).',
      evidence: ev('sample-bl', '1,930.000 KGS'), action: 'Confirm with the forwarder.',
      decision: { key: 'grossWeight', question: 'Which gross weight applies?', options: [{ value: 'transport_doc', label: 'B/L 1,930 kg' }, { value: 'packing_list', label: 'Packing list 1,888 kg' }], chosen: 'transport_doc' },
    },
    {
      id: 'ASSIST:inv0-line4', code: 'ASSIST', severity: 'warning', category: 'valuation', title: 'Buyer-supplied fabric (assist) USD 4,180',
      detail: 'Added to line 4.', evidence: ev('sample-ci', 'value USD 4,180.00', 2), action: 'Confirm the apportionment.', lineId: 'inv0-line4',
    },
    {
      id: 'NCV_VALUE:inv0-line5', code: 'NCV_VALUE', severity: 'warning', category: 'valuation', title: 'Samples at USD 1.00/pc',
      detail: 'Nominal value.', evidence: [], action: 'Confirm the value reflects the real value.', lineId: 'inv0-line5',
    },
  ];
}

function cls(
  lineId: string,
  htsNumber: string,
  path: string,
  rate: number,
  category: string,
  extra: Partial<LineClassification> = {},
): LineClassification {
  const d = htsNumber;
  return {
    lineId,
    htsNumber,
    htsFormatted: `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8, 10)}`,
    description: path,
    generalRate: `${rate}%`,
    adValoremPct: rate,
    units: ['DOZ', 'KG'],
    textileCategory: category,
    confidence: 'high',
    rationale: 'Stub classification for tests.',
    alternatives: [],
    basis: 'declared',
    ...extra,
  };
}

export function sampleClassifications(): Record<string, LineClassification> {
  return {
    'inv0-line1': cls('inv0-line1', '6109100012', "T-shirts, singlets, tank tops and similar garments, knitted or crocheted › Of cotton › Men's or boys' › Other T-shirts › Men's (338)", 16.5, '338'),
    'inv0-line2': cls('inv0-line2', '6110202079', "Sweaters, pullovers, sweatshirts › Of cotton › Other › Other › Women's or girls' (339)", 16.5, '339', {
      confidence: 'medium',
      alternatives: [
        {
          htsNumber: '6110303059',
          htsFormatted: '6110.30.30.59',
          description: "Of man-made fibers › Other › Other › Women's or girls' (639)",
          generalRate: '32%',
          adValoremPct: 32,
          units: ['DOZ', 'KG'],
          reason: 'Packing list composition (65% polyester)',
        },
      ],
    }),
    'inv0-line3': cls('inv0-line3', '6203424511', "Men's or boys' suits, ensembles, trousers › Trousers, bib and brace overalls, breeches and shorts › Of cotton › Other › Trousers and breeches › Men's (347)", 16.6, '347'),
    'inv0-line4': cls('inv0-line4', '6206403030', "Women's or girls' blouses, shirts and shirt-blouses › Of man-made fibers › Other › Blouses and shirts › Women's (641)", 26.9, '641'),
    'inv0-line5': cls('inv0-line5', '6106100010', "Women's or girls' blouses and shirts, knitted › Of cotton › Women's (339)", 19.7, '339'),
  };
}

export function sampleAltClassifications(): Record<string, LineClassification> {
  return {
    'inv0-line2': cls('inv0-line2', '6110303059', "Sweaters, pullovers, sweatshirts › Of man-made fibers › Other › Other › Women's or girls' (639)", 32, '639'),
  };
}

const COUNTRY_NAMES: Record<string, string> = {
  VIETNAM: 'VN',
  'VIET NAM': 'VN',
  'HONG KONG': 'HK',
  BANGLADESH: 'BD',
  USA: 'US',
  'U.S.A.': 'US',
  'UNITED STATES': 'US',
  GERMANY: 'DE',
  CHINA: 'CN',
};

const STOP = new Set(['THE', 'AND', 'OF', 'A', 'AN', 'LTD', 'LIMITED', 'CO', 'COMPANY', 'JSC', 'JOINT', 'STOCK', 'INC', 'CORP', 'LLC']);

/** Simplified CBP MID builder, good enough for tests (the real one lives in T4's reference module). */
export function stubBuildMid(m: Address): MidResult | null {
  if (!m.country || !m.city) return null;
  const words = m.name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  const nums = m.lines.join(' ').match(/\d+/g)?.map(Number) ?? [];
  const street = nums.length ? String(Math.max(...nums)).slice(0, 4) : '';
  const city = m.city.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const mid = `${m.country}${(words[0] ?? '').slice(0, 3)}${(words[1] ?? '').slice(0, 3)}${street}${city}`.slice(0, 15);
  const ambiguous = /\blot\b/i.test(m.lines.join(' '));
  return { mid, needsVerification: ambiguous, notes: ambiguous ? ['Address uses a lot number; the street number is ambiguous.'] : [] };
}

export const FEES: FeeConfig = {
  fiscalYear: 'FY2026',
  mpfRate: 0.003464,
  mpfMin: 33.58,
  mpfMax: 651.5,
  hmfRate: 0.00125,
  note: 'test stub',
};

/** Stub ReferenceLookups: Tacoma/Seattle ports, no Schedule K data, simple MID builder. */
export function stubLookups(overrides: Partial<ReferenceLookups> = {}): ReferenceLookups {
  return {
    usPortCode: (text) => (/TACOMA/i.test(text) ? { code: '3002', name: 'Tacoma, WA' } : /SEATTLE/i.test(text) ? { code: '3001', name: 'Seattle, WA' } : null),
    foreignPortCode: () => null,
    countryCode: (text) => {
      const t = text.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(t)) return t;
      return COUNTRY_NAMES[t] ?? null;
    },
    usStateCode: (text) => {
      const t = text.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(t)) return t;
      return /\b([A-Z]{2})\s+\d{5}\b/.exec(t)?.[1] ?? /,\s*([A-Z]{2})\b/.exec(t)?.[1] ?? null;
    },
    buildMid: stubBuildMid,
    feeConfig: () => FEES,
    ...overrides,
  };
}
