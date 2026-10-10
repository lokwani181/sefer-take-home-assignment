/**
 * Shared contracts between every module of the pipeline:
 *
 *   ingest (T1) → parse (T2) → reconcile (T3) → classify (T4) → assemble + XML (T5) → API/UI (T8/T6)
 *
 * Rules for changing this file: only ADD optional fields. Never rename, remove, or narrow.
 */

// ════════════════════════════════════════════════════════════════════════════
// Layout — output of ingest (T1), input of parse (T2)
// ════════════════════════════════════════════════════════════════════════════

/**
 * All coordinates are pixels at 300 DPI, origin top-left, AFTER deskew.
 * Text-layer PDF coordinates (points) are scaled by 300/72.
 */
export interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0–100. Text-layer words are 100. */
  conf: number;
}

export interface Line {
  text: string;
  words: Word[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageLayout {
  /** 1-based */
  page: number;
  width: number;
  height: number;
  source: 'text' | 'ocr';
  /** Skew that was measured and removed from the coordinates (degrees, positive = clockwise). */
  skewDeg: number;
  words: Word[];
  /** Words grouped into visual lines, sorted top-to-bottom then left-to-right. */
  lines: Line[];
  /** Text read from coloured stamps (e.g. "TELEX RELEASED"), if a stamp pass ran. */
  stamps?: string[];
  /** Absolute path of the rendered page image, already rotated like the coordinates (same pixel space as words). */
  imagePath?: string;
}

export interface DocumentLayout {
  docId: string;
  fileName: string;
  sha256: string;
  mime: string;
  pages: PageLayout[];
}

export interface UploadedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

// ════════════════════════════════════════════════════════════════════════════
// Extraction — output of parse (T2), input of reconcile (T3)
// ════════════════════════════════════════════════════════════════════════════

export type DocType =
  | 'commercial_invoice'
  | 'packing_list'
  /** A single document that is both invoice and packing list. data.kind is 'commercial_invoice'. */
  | 'invoice_packing_list'
  | 'bill_of_lading'
  | 'air_waybill'
  | 'arrival_notice'
  | 'other';

export interface Evidence {
  docId: string;
  /** 1-based page; 0 = unknown. */
  page: number;
  /** Verbatim text as read from the document. */
  text: string;
  /** [x0, y0, x1, y1] in layout coordinates. */
  bbox?: [number, number, number, number];
}

export interface Address {
  name: string;
  /** Street / building lines, verbatim, excluding name, city line and contact lines. */
  lines: string[];
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 */
  country?: string;
  contact?: string;
  phone?: string;
  taxId?: string;
  /** The whole block as read, newline-separated. */
  raw: string;
}

export type ObservationKind =
  | 'handwritten'
  | 'strikethrough'
  | 'stamp'
  | 'footnote'
  | 'ocr_repair'
  | 'low_confidence'
  | 'note'
  | 'other';

export interface Observation {
  kind: ObservationKind;
  text: string;
  /** JSON path into data, e.g. "containers[0].number" */
  field?: string;
  page?: number;
}

export interface Fiber {
  /** Normalized: cotton | polyester | elastane | nylon | wool | viscose | linen | silk | acrylic | other */
  fiber: string;
  pct: number;
}

export type Gender = 'men' | 'women' | 'boys' | 'girls' | 'unisex' | 'infant';
export type Construction = 'knit' | 'woven' | 'other';

export interface InvoiceLine {
  lineNo: number;
  styleNo?: string;
  /** Title line of the description, verbatim. */
  description: string;
  /** Continuation lines verbatim (composition, colours, sizes, notes). */
  details: string[];
  /** As printed (digits and dots). */
  hsCode?: string;
  quantity: number;
  /** As printed: PCS, SETS, KG… */
  unit: string;
  unitPrice?: number;
  /** As printed — may disagree with quantity × unitPrice. */
  amount?: number;
  /** ISO2, only if stated at line level. */
  countryOfOrigin?: string;
  noCommercialValue?: boolean;
  /** Stated value for customs purposes for the whole line (NCV/FOC lines). */
  customsValue?: number;
  /** Footnote markers attached to this line, e.g. ["*"]. */
  footnoteRefs?: string[];
  // Attributes derived from the text when determinable:
  composition?: Fiber[];
  compositionRaw?: string;
  construction?: Construction;
  gender?: Gender;
  /** e.g. t-shirt | hoodie | sweater | trousers | shorts | blouse | shirt | polo | dress | skirt | jacket | other */
  garmentType?: string;
  /** Line-specific manufacturer when stated (e.g. samples made at a different factory). */
  manufacturer?: Address;
  // Present only on combined invoice + packing list documents:
  cartons?: number;
  netWeightKg?: number;
  grossWeightKg?: number;
}

export type ChargeType =
  | 'freight'
  | 'insurance'
  | 'packing'
  | 'commission'
  | 'discount'
  | 'duty'
  | 'inland_freight_foreign'
  | 'inland_freight_us'
  | 'handling'
  | 'other';

export interface Charge {
  type: ChargeType;
  amount: number;
  description: string;
}

export interface PrintedTotal {
  label: string;
  amount: number;
}

/** Buyer-supplied materials/tooling etc. that must be added to dutiable value. */
export interface Assist {
  description: string;
  value: number;
  currency?: string;
  /** Style numbers the assist relates to. */
  styleRefs: string[];
  reference?: string;
}

export interface Incoterm {
  /** EXW | FCA | FAS | FOB | CFR | CIF | CPT | CIP | DAP | DPU | DDP */
  code: string;
  place?: string;
  version?: string;
}

export interface CommercialInvoiceData {
  kind: 'commercial_invoice';
  invoiceNumber: string;
  invoiceDateRaw?: string;
  /** ISO date, best interpretation. */
  invoiceDate?: string;
  invoiceDateAmbiguous?: boolean;
  /** Other ISO interpretations when ambiguous. */
  invoiceDateAlternatives?: string[];
  seller?: Address;
  buyer?: Address;
  shipTo?: Address;
  manufacturer?: Address;
  poNumbers: string[];
  /** ISO 4217 */
  currency?: string;
  incoterm?: Incoterm;
  paymentTerms?: string;
  /** Header-level origin, ISO2. */
  countryOfOrigin?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  vessel?: string;
  voyage?: string;
  /** B/L or AWB number referenced on the invoice. */
  transportRef?: string;
  /** ISO dates */
  etd?: string;
  eta?: string;
  lines: InvoiceLine[];
  charges: Charge[];
  totals: PrintedTotal[];
  totalPackages?: { count: number; unit: string };
  assists: Assist[];
  /** Verbatim notes, footnotes, declarations. */
  notes: string[];
  relatedParty?: boolean;
  /** Present only on combined invoice + packing list documents. */
  packingTotals?: { cartons?: number; netWeightKg?: number; grossWeightKg?: number; volumeCbm?: number };
}

export interface PackingListLine {
  cartonRange?: string;
  styleNo?: string;
  description: string;
  details: string[];
  cartons?: number;
  pcsPerCarton?: number;
  totalPcs?: number;
  netWeightPerCartonKg?: number;
  grossWeightPerCartonKg?: number;
  netWeightKg?: number;
  grossWeightKg?: number;
  dimensions?: string;
  /** Per-row CBM when printed. */
  volumeCbm?: number;
  countryOfOrigin?: string;
  /** Line-specific manufacturer when stated (e.g. in a footnote/remark). */
  manufacturer?: Address;
  composition?: Fiber[];
  compositionRaw?: string;
  footnoteRefs?: string[];
}

export interface PackingListData {
  kind: 'packing_list';
  plNumber?: string;
  /** ISO date */
  date?: string;
  invoiceRefs: string[];
  poNumbers: string[];
  shipper?: Address;
  consignee?: Address;
  deliverTo?: Address;
  manufacturer?: Address;
  vessel?: string;
  voyage?: string;
  containerSummary?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  lines: PackingListLine[];
  totals: { cartons?: number; pcs?: number; netWeightKg?: number; grossWeightKg?: number; volumeCbm?: number };
  shippingMarks?: string[];
  /** Verbatim remarks / notes. */
  remarks: string[];
}

export interface ContainerCandidate {
  number: string;
  checkDigitValid: boolean;
  source: 'typed' | 'handwritten' | 'ocr' | 'strikethrough';
}

export interface Container {
  /** Best number (ISO 6346, no spaces). */
  number: string;
  checkDigitValid: boolean;
  sealNumbers: string[];
  /** e.g. 20GP, 40HC */
  sizeType?: string;
  /** Every candidate seen, when more than one was read. */
  candidates?: ContainerCandidate[];
}

export interface FreightChargeLine {
  description: string;
  terms: 'prepaid' | 'collect' | 'unknown';
}

export interface BillOfLadingData {
  kind: 'bill_of_lading';
  blType: 'house' | 'master' | 'unknown';
  /** As printed, including SCAC prefix if printed that way (e.g. BMLVHCM26090418). */
  blNumber: string;
  issuerName?: string;
  issuerScac?: string;
  /** As printed (e.g. OPLUSGN260917735). */
  masterBlNumber?: string;
  carrierName?: string;
  carrierScac?: string;
  bookingNumber?: string;
  shipper?: Address;
  consignee?: Address;
  notifyParty?: Address;
  alsoNotify?: string;
  exportReferences: string[];
  vessel?: string;
  voyage?: string;
  preCarriage?: string;
  placeOfReceipt?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  placeOfDelivery?: string;
  finalDestination?: string;
  moveType?: string;
  /** ISO dates */
  onBoardDate?: string;
  issueDate?: string;
  issuePlace?: string;
  /** ISO date, when the document prints an ETA. */
  eta?: string;
  containers: Container[];
  packages?: { count: number; unit: string };
  grossWeightKg?: number;
  volumeCbm?: number;
  /** Description of goods block, verbatim lines. */
  cargoDescription: string[];
  hsCodes: string[];
  freightTerms?: string;
  charges: FreightChargeLine[];
  releaseType?: 'telex' | 'original' | 'seaway' | 'unknown';
  originalsCount?: number;
  amsFiledBy?: string;
  isfFiledBy?: string;
  /** ISO2 */
  countryOfOrigin?: string;
}

export interface AirWaybillData {
  kind: 'air_waybill';
  awbNumber: string;
  awbType: 'house' | 'master' | 'unknown';
  masterAwbNumber?: string;
  /** IATA airline prefix or carrier code. */
  carrierCode?: string;
  /** 2-letter IATA airline designator from the flight number (e.g. 'LH'). */
  carrierIata?: string;
  carrierName?: string;
  shipper?: Address;
  consignee?: Address;
  notifyParty?: Address;
  airportOfDeparture?: string;
  airportOfDestination?: string;
  flight?: string;
  /** ISO date */
  flightDate?: string;
  pieces?: number;
  grossWeightKg?: number;
  chargeableWeightKg?: number;
  goodsDescription: string[];
  hsCodes: string[];
  charges: FreightChargeLine[];
}

export interface OtherDocData {
  kind: 'other';
  title?: string;
  /** First ~2000 characters of text. */
  text: string;
}

export type DocData = CommercialInvoiceData | PackingListData | BillOfLadingData | AirWaybillData | OtherDocData;

export interface FieldMeta {
  /** 0–100 */
  conf: number;
  repaired?: boolean;
  /** What was read before repair. */
  originalText?: string;
  evidence?: Evidence;
}

export interface ExtractedDocument {
  docId: string;
  fileName: string;
  docType: DocType;
  /** 0–1 */
  classificationScore: number;
  /** Per-type classification scores, for debugging/UI. */
  classificationScores?: Record<string, number>;
  source: 'text' | 'ocr' | 'mixed';
  pageCount: number;
  data: DocData;
  /** Keyed by JSON path into data, e.g. "lines[1].quantity". Only fields worth flagging need entries. */
  fieldMeta: Record<string, FieldMeta>;
  observations: Observation[];
  /** Parser warnings (e.g. "table header not found"). */
  warnings: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// Shipment — output of reconcile (T3), input of classify (T4) and assemble (T5)
// ════════════════════════════════════════════════════════════════════════════

export type SourceStatus = 'extracted' | 'derived' | 'corrected' | 'assumed' | 'user';

export interface SourceRef {
  docId: string;
  docType: DocType;
  /** JSON path in that document's data. */
  field?: string;
  /** 1-based page, when known. */
  page?: number;
}

export interface Sourced<T> {
  value: T;
  status: SourceStatus;
  sources: SourceRef[];
  /** 0–100, lowest confidence among the sources used. */
  conf?: number;
  note?: string;
}

export interface LineAttributes {
  composition?: Fiber[];
  compositionSource?: 'invoice' | 'packing_list' | 'other';
  construction?: Construction;
  gender?: Gender;
  garmentType?: string;
}

export interface ShipmentLine {
  /** Stable id: `inv${invoiceIndex}-line${invoiceLineNo}`, e.g. "inv0-line2". */
  id: string;
  invoiceIndex: number;
  invoiceLineNo: number;
  styleNo?: string;
  description: string;
  details: string[];
  hsCodeDeclared?: string;
  attributes: LineAttributes;
  /** Conflicting composition found in another document (e.g. the packing list). */
  altComposition?: Fiber[];
  altCompositionSource?: SourceRef;
  /** ISO2 */
  countryOfOrigin: Sourced<string>;
  manufacturer?: Address;
  /** How the manufacturer was determined (e.g. 'assumed' when inferred from the shipper/seller). */
  manufacturerStatus?: SourceStatus;
  /** Invoiced quantity. */
  quantity: Sourced<number>;
  unit: string;
  /** Quantity per packing list, only when it differs from the invoice. */
  packedQuantity?: number;
  unitPrice?: number;
  /** Line amount after arithmetic correction, invoice currency. */
  amount: Sourced<number>;
  /** Amount as printed when it was corrected. */
  printedAmount?: number;
  noCommercialValue: boolean;
  /** Stated customs value for NCV lines (whole line). */
  customsValue?: number;
  /** Assists apportioned to this line. */
  assists: Assist[];
  netWeightKg?: Sourced<number>;
  grossWeightKg?: Sourced<number>;
  cartons?: number;
  poNumber?: string;
}

export interface ShipmentInvoice {
  docId: string;
  /** As printed. Normalization for NetCHB happens in T5. */
  invoiceNumber: Sourced<string>;
  /** ISO date */
  invoiceDate?: Sourced<string>;
  currency: string;
  incoterm?: Incoterm;
  seller?: Address;
  buyer?: Address;
  shipTo?: Address;
  charges: Charge[];
  /** True when line amounts already exclude freight/insurance (e.g. FOB line values with CIF charges listed separately). */
  linesAreFob: boolean;
  /** Why linesAreFob was decided the way it was (for the valuation trail). */
  linesAreFobBasis?: 'incoterm' | 'totals' | 'no_charges' | 'includes_charges' | 'unverified' | 'no_incoterm';
  printedTotals: PrintedTotal[];
  poNumbers: string[];
  relatedParty: Sourced<boolean>;
  lines: ShipmentLine[];
  /**
   * True when the itemized discount charges are deducted on the invoice itself (a printed total is the
   * goods less the discount): the price actually paid is net of them, so valuation apportions them.
   */
  discountsDeducted?: boolean;
}

export interface BillRef {
  /** 4-char SCAC */
  scac?: string;
  /** Bill number WITHOUT the SCAC prefix. */
  number: string;
}

export type TransportMode = 'ocean' | 'air' | 'truck' | 'rail' | 'unknown';

export interface ShipmentTransport {
  mode: TransportMode;
  containerized: boolean;
  vessel?: string;
  voyage?: string;
  carrierName?: string;
  /** SCAC (ocean) or IATA carrier code (air) of the importing carrier. */
  carrierScac?: string;
  flight?: string;
  /** Free text as read, e.g. "CAT LAI, HCMC, VN". */
  portOfLading?: string;
  /** Free text as read, e.g. "TACOMA, WA, USA". */
  portOfUnlading?: string;
  placeOfDelivery?: string;
  /** ISO dates */
  exportDate?: Sourced<string>;
  arrivalDate?: Sourced<string>;
  arrivalDateEstimated: boolean;
  /** US state (2-letter) where the goods are delivered. */
  destinationState?: string;
}

export interface Shipment {
  invoices: ShipmentInvoice[];
  importer?: Sourced<Address>;
  ultimateConsignee?: Sourced<Address>;
  shipTo?: Address;
  notifyParty?: Address;
  seller?: Address;
  manufacturers: Address[];
  consolidator?: Address;
  transport: ShipmentTransport;
  bills: { master?: BillRef; house?: BillRef }[];
  containers: Container[];
  packages?: Sourced<{ count: number; unit: string }>;
  grossWeightKg?: Sourced<number>;
  volumeCbm?: number;
  releaseType?: string;
  /** ISO2 */
  countryOfExport?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Issues — emitted by reconcile (T3) and assemble (T5)
// ════════════════════════════════════════════════════════════════════════════

export type IssueSeverity = 'blocker' | 'warning' | 'info';

export type IssueCategory =
  | 'missing_data'
  | 'discrepancy'
  | 'valuation'
  | 'classification'
  | 'compliance'
  | 'assumption'
  | 'ocr'
  | 'format';

/**
 * Stable issue codes. Issue.id = `${code}` or `${code}:${lineId | other key}`.
 * Owner in brackets — only the owner emits that code.
 */
export type IssueCode =
  // [T3 reconcile]
  | 'LINE_AMOUNT_MISMATCH' // qty × price ≠ printed amount
  | 'TOTALS_MISMATCH' // printed totals don't add up
  | 'QTY_MISMATCH' // invoice qty ≠ packing list qty
  | 'COMPOSITION_CONFLICT' // fibre content differs between docs
  | 'PACKAGE_COUNT_MISMATCH'
  | 'GROSS_WEIGHT_MISMATCH'
  | 'CONTAINER_NUMBER_CORRECTED' // check-digit / handwritten correction applied
  | 'CONTAINER_NUMBER_INVALID' // no candidate passes ISO 6346
  | 'ORIGIN_DIFFERS' // a line's origin differs from the invoice header origin
  | 'DECLARATION_CONFLICT' // printed origin declaration contradicts line origins
  | 'NCV_VALUE' // FOC / no-commercial-value line: value needs confirming
  | 'ASSIST' // buyer-supplied materials to add to value
  | 'NON_DUTIABLE_CHARGES' // freight/insurance etc. deducted per incoterm
  | 'CHARGES_NOT_ITEMIZED' // D-terms or CIF without itemized charges
  | 'DATE_AMBIGUOUS'
  | 'SELLER_NOT_MANUFACTURER'
  | 'FIRST_SALE_OPPORTUNITY'
  | 'ULTIMATE_CONSIGNEE_ASSUMED'
  | 'IMPORTER_ASSUMED'
  | 'HOUSE_MASTER_BILL'
  | 'ARRIVAL_ESTIMATED'
  | 'RELATED_PARTY_ASSUMED'
  | 'OCR_VERIFY' // low-confidence or repaired OCR field
  | 'MISSING_DOCUMENT' // e.g. no transport document uploaded
  | 'MISSING_FIELD' // a field the documents should have carried is absent
  | 'UNRECOGNIZED_DOCUMENT'
  | 'UFLPA'
  | 'ISF'
  | 'TELEX_RELEASE'
  | 'COLLECT_CHARGES'
  // [T5 assemble]
  | 'HTS_RESOLVED'
  | 'HTS_LOW_CONFIDENCE'
  | 'HTS_NOT_DECLARED'
  | 'CHAPTER_MISMATCH' // knit/woven chapter conflicts with description
  | 'MISSING_IMPORTER_ID'
  | 'MISSING_CONSIGNEE_ID'
  | 'MISSING_BOND'
  | 'MISSING_SURETY'
  | 'MISSING_LOCATION_OF_GOODS'
  | 'MID_VERIFY'
  | 'PORT_UNKNOWN'
  | 'LADING_PORT_UNKNOWN'
  | 'INVOICE_NO_NORMALIZED'
  | 'BILL_NO_NORMALIZED'
  | 'CHAPTER_99_NOT_COMPUTED'
  | 'AUTO_REMEDIES'
  | 'CURRENCY_CONVERSION'
  | 'WEIGHT_PRORATED'
  | 'ENTRY_DATE_DEFAULTED'
  | 'BROKER_INPUT_INVALID'
  | 'MANIFEST_QUANTITY_UNKNOWN'
  | 'XSD_INVALID' // the XML fails (or, for a missing required value, will fail) entry.xsd
  | 'FIELD_OMITTED'; // a value left out so the XML stays valid (over the XSD limit, parties without a full address)

export interface DecisionOption {
  value: string;
  label: string;
}

/**
 * A choice the broker can flip. Keys and option values are fixed (see DECISION_KEYS);
 * T3 emits them, T5 applies them via BrokerInputs.decisions[key].
 */
export interface Decision {
  key: string;
  question: string;
  options: DecisionOption[];
  /** Default chosen by the app per the decision policy. */
  chosen: string;
}

export interface Issue {
  /** `${code}` or `${code}:${lineId|key}` — stable across regenerations. */
  id: string;
  code: IssueCode;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  detail: string;
  evidence: Evidence[];
  /** What the broker must do. */
  action: string;
  /** Path into Shipment or EntryModel the issue is about. */
  field?: string;
  lineId?: string;
  decision?: Decision;
}

/**
 * Decision keys and their allowed option values.
 *   quantity:<lineId>     'invoice' (default) | 'packed'
 *   composition:<lineId>  'invoice' (default) | 'other_doc'
 *   amount:<lineId>       'computed' (default when the printed subtotal corroborates it) | 'printed'
 *   grossWeight           'transport_doc' (default) | 'packing_list'
 *   hts:<lineId>          any 10-digit HTS number (overrides classification)
 */
export const DECISION_KEYS = {
  quantity: (lineId: string) => `quantity:${lineId}`,
  composition: (lineId: string) => `composition:${lineId}`,
  amount: (lineId: string) => `amount:${lineId}`,
  grossWeight: 'grossWeight',
  hts: (lineId: string) => `hts:${lineId}`,
} as const;

// ════════════════════════════════════════════════════════════════════════════
// Classification + reference data — T4
// ════════════════════════════════════════════════════════════════════════════

export interface HtsCandidate {
  /** 10 digits, no dots */
  htsNumber: string;
  /** e.g. 6110.30.30.53 */
  htsFormatted: string;
  description: string;
  generalRate?: string;
  adValoremPct?: number;
  units?: string[];
  reason?: string;
}

export interface LineClassification {
  lineId: string;
  /** 10 digits, no dots */
  htsNumber: string;
  /** e.g. 6109.10.00.12 */
  htsFormatted: string;
  /** Full path description joined with " › " from heading to leaf. */
  description: string;
  /** As published, e.g. "16.5%" or "Free". */
  generalRate?: string;
  /** Parsed ad valorem part of generalRate, if purely/partly ad valorem. */
  adValoremPct?: number;
  /** NetCHB unit-of-measure codes in reporting order, e.g. ["DOZ","KG"]. */
  units: string[];
  /** Textile category number, e.g. "338". */
  textileCategory?: string;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  alternatives: HtsCandidate[];
  basis: 'declared' | 'search' | 'user';
  /** Classification warnings for assembly to turn into issues. */
  flags?: ClassificationFlag[];
  /** Specific (non-ad-valorem) part of generalRate, e.g. "56.3¢/kg". */
  specificRate?: string;
  /** Composition the classification was computed for. */
  compositionUsed?: Fiber[];
}

export interface ClassificationFlag {
  code:
    | 'FIBER_CONFLICT'
    | 'CHAPTER_MISMATCH'
    | 'GENDER_CONFLICT'
    | 'GARMENT_CONFLICT'
    | 'DECLARED_CONDITION_UNSUPPORTED'
    | 'DECLARED_CODE_NOT_FOUND'
    | 'RECLASSIFIED_FOR_COMPOSITION'
    | 'ATTRIBUTE_ASSUMED'
    | 'HTS_DATA_UNAVAILABLE'
    | 'NO_CANDIDATE';
  message: string;
}

export interface ClassifyOptions {
  /** Classify using this composition instead of line.attributes.composition. */
  composition?: Fiber[];
}

export type ClassifyLineFn = (line: ShipmentLine, opts?: ClassifyOptions) => Promise<LineClassification>;

export interface FeeConfig {
  fiscalYear: string;
  /** e.g. 0.003464 */
  mpfRate: number;
  mpfMin: number;
  mpfMax: number;
  /** e.g. 0.00125 */
  hmfRate: number;
  note: string;
}

export interface PortRef {
  code: string;
  name: string;
}

export interface MidResult {
  mid: string;
  needsVerification: boolean;
  notes: string[];
}

/** Synchronous reference lookups (T4 implements; T5 consumes via injection). */
export interface ReferenceLookups {
  /** CBP Schedule D 4-digit port from free text like "TACOMA, WA, USA". */
  usPortCode(text: string): PortRef | null;
  /** CBP Schedule K 5-digit foreign port from free text like "CAT LAI, HCMC, VN". */
  foreignPortCode(text: string, countryIso2?: string): PortRef | null;
  /** ISO2 country of a foreign sea port or cargo airport ("FRANKFURT/MAIN (FRA)" → DE); null if unknown. */
  portCountry?(text: string): string | null;
  /** ISO2 from a country name/code ("VIETNAM", "U.S.A.", "VN"). */
  countryCode(text: string): string | null;
  /** 2-letter US state from free text ("Kent, WA 98032"). */
  usStateCode(text: string): string | null;
  buildMid(manufacturer: Address): MidResult | null;
  feeConfig(): FeeConfig;
}

// ════════════════════════════════════════════════════════════════════════════
// Broker inputs — from the UI form (T6) into assemble (T5)
// ════════════════════════════════════════════════════════════════════════════

export interface BrokerInputs {
  /** NN-NNNNNNN[XX] (EIN + suffix), or CBP-assigned / SSN formats per XSD taxIdType. */
  importerTaxId?: string;
  importerName?: string;
  ultimateConsigneeTaxId?: string;
  /** XSD bondType enumeration. */
  bondType?: string;
  suretyCode?: string;
  paymentType?: string;
  /** Default '01'. */
  entryType?: string;
  /** Overrides the port derived from documents. */
  entryPort?: string;
  /** FIRMS code (≤4 chars). */
  locationOfGoods?: string;
  /** ISO date; defaults to the arrival date. */
  entryDate?: string;
  /** ISO date; overrides the estimated arrival date. */
  arrivalDate?: string;
  /** Default true. */
  autoApplyRemedies?: boolean;
  brokerReference?: string;
  /** ISO 4217 code → USD per unit, for non-USD invoices. */
  exchangeRates?: Record<string, number>;
  /** Decision key → chosen option value (see DECISION_KEYS). */
  decisions?: Record<string, string>;
}

// ════════════════════════════════════════════════════════════════════════════
// NetCHB entry model — typed mirror of the entry.xsd subset we populate (T5)
// Field names are camelCase of XSD tags. T5 emits them in XSD order.
// ════════════════════════════════════════════════════════════════════════════

export interface EntryHeader {
  importerTaxId?: string;
  importerName?: string;
  ultimateConsignee?: { taxId?: string; consigneeName?: string };
  processingPort: string;
  entryPort: string;
  /** ISO date */
  entryDate: string;
  entryType: string;
  bondType?: string;
  paymentType?: string;
  charges?: number;
  grossWeight?: number;
  totalEntryValue?: number;
  description?: string;
  suretyCode?: string;
  stateDestination?: string;
  vesselName?: string;
  modeTransportation?: string;
  unladingPort?: string;
  importDate?: string;
  arrivalDate?: string;
  carrierCode?: string;
  brokerReferenceNo?: string;
  customerReferenceNo?: string;
  voyageNo?: string;
  locationOfGoods?: string;
}

export interface EntryBillOfLading {
  masterScac?: string;
  masterBill?: string;
  houseScac?: string;
  houseBill?: string;
  quantity: number;
  unit: string;
}

export interface EntryContainer {
  containerNumber: string;
  containerSize?: string;
  containerType?: string;
  sealNumbers?: string;
  poNumber?: string;
  weight?: number;
  weightUnit?: string;
  quantity?: number;
  quantityUnit?: string;
}

export interface EntryEntity {
  entityCode: 'SE' | 'BY' | 'ST' | 'LG' | 'CS' | 'MF' | 'CN';
  entityName?: string;
  entityId?: string;
  address?: {
    addressComponents: string[];
    city: string;
    stateProvinceCode?: string;
    postalCode?: string;
    /** ISO2 */
    country: string;
  };
  sellingPartyMid?: string;
}

export interface EntryTariff {
  /** 10 digits, no dots */
  tariffNo: string;
  /** Whole USD */
  value: number;
  duty?: number;
  quantity1?: number;
  unitOfMeasure1?: string;
  quantity2?: number;
  unitOfMeasure2?: string;
  specialProgram?: string;
  valueAdjustment?: number;
  adjustmentDescription?: string;
}

export interface EntryLineItem {
  /** Not emitted — links back to ShipmentLine.id. */
  lineId: string;
  exportDate?: string;
  /** ISO2 */
  countryOrigin: string;
  manufacturerId?: string;
  relatedParty?: string;
  /** ISO2 */
  countryExport?: string;
  /** 5-digit Schedule K */
  ladingPort?: string;
  grossWeight?: number;
  commercialDescription?: string;
  invoiceQuantity?: number;
  invoiceUnitValue?: number | 'auto';
  poNumber?: string;
  categoryNo?: string;
  tariffs: EntryTariff[];
}

export interface EntryInvoice {
  invoiceNo: string;
  relatedParty?: boolean;
  foreignCurrency?: { currencyCode: string; exchangeRate?: number; currencyCountryCode?: string };
  ultimateConsigneeTaxId?: string;
  lineItems: EntryLineItem[];
}

export interface EntryModel {
  entryNo: { kind: 'system' } | { kind: 'user'; filerCode: string; entryNo: string };
  autoApplyRemedies?: boolean;
  externalReferenceNumber?: string;
  header: EntryHeader;
  manifest: { billsOfLading: EntryBillOfLading[] };
  containers: EntryContainer[];
  cargoReleaseParties: EntryEntity[];
  invoices: EntryInvoice[];
}

// ════════════════════════════════════════════════════════════════════════════
// Assembly output + pipeline result
// ════════════════════════════════════════════════════════════════════════════

export interface ValuationStep {
  label: string;
  /** Signed amount in USD (deductions negative). */
  amount: number;
  note?: string;
}

export interface LineValuation {
  lineId: string;
  /** Currency of the invoice before conversion. */
  currency: string;
  steps: ValuationStep[];
  /** Whole USD, as emitted in tariff value. */
  enteredValue: number;
}

export interface LineEstimate {
  lineId: string;
  htsNumber: string;
  enteredValue: number;
  ratePct?: number;
  duty?: number;
}

export interface Estimates {
  lines: LineEstimate[];
  totalDuty: number;
  mpf: number;
  hmf: number;
  notes: string[];
}

export interface XsdValidation {
  valid: boolean;
  errors: string[];
}

export interface AssembleInput {
  shipment: Shipment;
  classifications: Record<string, LineClassification>;
  /** Classification under the conflicting composition, keyed by lineId (only lines with altComposition). */
  altClassifications: Record<string, LineClassification>;
  /**
   * Classifications of broker HTS overrides (decision `hts:<lineId>`), resolved before assembly
   * (assembly is synchronous). Used when its htsNumber equals the override; otherwise assembly
   * falls back to what it knows about the code.
   */
  overrideClassifications?: Record<string, LineClassification>;
  brokerInputs: BrokerInputs;
  /** Issues from reconcile; decisions on them are applied using brokerInputs.decisions or their defaults. */
  issues: Issue[];
  lookups: ReferenceLookups;
}

export interface AssembleOutput {
  entryModel: EntryModel;
  /** Input issues (with decision.chosen updated) + issues added by assembly. */
  issues: Issue[];
  valuations: LineValuation[];
  estimates: Estimates;
}

export interface DocumentSummary {
  docId: string;
  fileName: string;
  docType: DocType;
  source: 'text' | 'ocr' | 'mixed';
  pageCount: number;
  classificationScore: number;
}

export interface PipelineResult {
  shipmentId: string;
  /** ISO timestamp */
  createdAt: string;
  documents: DocumentSummary[];
  extracted: ExtractedDocument[];
  shipment: Shipment;
  issues: Issue[];
  classifications: Record<string, LineClassification>;
  altClassifications: Record<string, LineClassification>;
  valuations: LineValuation[];
  entryModel: EntryModel;
  xml: string;
  soapEnvelope?: string;
  xsdValidation: XsdValidation;
  estimates: Estimates;
  brokerInputs: BrokerInputs;
  timingsMs: Record<string, number>;
}

/** Response body for GET /api/health. */
export interface HealthResponse {
  ok: boolean;
  /** tool name → version */
  tools?: Record<string, string>;
  /** required tools not found */
  missing?: string[];
}

/** Response body for API errors. */
export interface ApiError {
  error: string;
  detail?: string;
  hint?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Module entry-point signatures (each module's index.ts exports these names)
// ════════════════════════════════════════════════════════════════════════════

/** server/src/ingest/index.ts → export const ingest: IngestFn */
export type IngestFn = (file: UploadedFile) => Promise<DocumentLayout>;
/** server/src/parse/index.ts → export const parseDocument: ParseFn */
export type ParseFn = (layout: DocumentLayout) => ExtractedDocument;
/** server/src/reconcile/index.ts → export const reconcile: ReconcileFn */
export type ReconcileFn = (docs: ExtractedDocument[]) => { shipment: Shipment; issues: Issue[] };
/** server/src/netchb/index.ts → export const assembleEntry: AssembleFn */
export type AssembleFn = (input: AssembleInput) => AssembleOutput;
/** server/src/netchb/index.ts → export const buildEntryXml: BuildXmlFn */
export type BuildXmlFn = (model: EntryModel) => string;
/** server/src/netchb/index.ts → export const validateEntryXml: ValidateXmlFn */
export type ValidateXmlFn = (xml: string) => Promise<XsdValidation>;
/** server/src/reference/index.ts → export const classifyLine: ClassifyLineFn; export const lookups: ReferenceLookups */
