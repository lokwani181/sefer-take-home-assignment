/**
 * zod schema for samples/synthetic/<id>/expected.json: the hand-checked ground truth for one
 * synthetic shipment. The generator validates every file with it and exits non-zero on failure,
 * and the T9 generalization run compares pipeline output against it.
 */
import { z } from 'zod';
import type { DocType, IssueCode } from '@app/shared';

/** Runtime copy of the IssueCode union (types.ts only exports the type). Kept exhaustive below. */
export const ISSUE_CODES = [
  'LINE_AMOUNT_MISMATCH',
  'TOTALS_MISMATCH',
  'QTY_MISMATCH',
  'COMPOSITION_CONFLICT',
  'PACKAGE_COUNT_MISMATCH',
  'GROSS_WEIGHT_MISMATCH',
  'CONTAINER_NUMBER_CORRECTED',
  'CONTAINER_NUMBER_INVALID',
  'ORIGIN_DIFFERS',
  'DECLARATION_CONFLICT',
  'NCV_VALUE',
  'ASSIST',
  'NON_DUTIABLE_CHARGES',
  'CHARGES_NOT_ITEMIZED',
  'DATE_AMBIGUOUS',
  'SELLER_NOT_MANUFACTURER',
  'FIRST_SALE_OPPORTUNITY',
  'ULTIMATE_CONSIGNEE_ASSUMED',
  'IMPORTER_ASSUMED',
  'HOUSE_MASTER_BILL',
  'ARRIVAL_ESTIMATED',
  'RELATED_PARTY_ASSUMED',
  'OCR_VERIFY',
  'MISSING_DOCUMENT',
  'MISSING_FIELD',
  'UNRECOGNIZED_DOCUMENT',
  'UFLPA',
  'ISF',
  'TELEX_RELEASE',
  'COLLECT_CHARGES',
  'HTS_RESOLVED',
  'HTS_LOW_CONFIDENCE',
  'HTS_NOT_DECLARED',
  'CHAPTER_MISMATCH',
  'MISSING_IMPORTER_ID',
  'MISSING_CONSIGNEE_ID',
  'MISSING_BOND',
  'MISSING_SURETY',
  'MISSING_LOCATION_OF_GOODS',
  'MID_VERIFY',
  'PORT_UNKNOWN',
  'LADING_PORT_UNKNOWN',
  'INVOICE_NO_NORMALIZED',
  'BILL_NO_NORMALIZED',
  'CHAPTER_99_NOT_COMPUTED',
  'AUTO_REMEDIES',
  'CURRENCY_CONVERSION',
  'WEIGHT_PRORATED',
  'ENTRY_DATE_DEFAULTED',
  'BROKER_INPUT_INVALID',
  'MANIFEST_QUANTITY_UNKNOWN',
  'XSD_INVALID',
  'FIELD_OMITTED',
] as const satisfies readonly IssueCode[];

export const DOC_TYPES = [
  'commercial_invoice',
  'packing_list',
  'invoice_packing_list',
  'bill_of_lading',
  'air_waybill',
  'arrival_notice',
  'other',
] as const satisfies readonly DocType[];

// Compile-time guards: fail typecheck if types.ts gains a code/doc type this list lacks.
type MissingIssueCodes = Exclude<IssueCode, (typeof ISSUE_CODES)[number]>;
type MissingDocTypes = Exclude<DocType, (typeof DOC_TYPES)[number]>;
export const ISSUE_CODES_EXHAUSTIVE: [MissingIssueCodes] extends [never] ? true : MissingIssueCodes = true;
export const DOC_TYPES_EXHAUSTIVE: [MissingDocTypes] extends [never] ? true : MissingDocTypes = true;

const INCOTERMS_2020 = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date YYYY-MM-DD');
const Iso2 = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');
/** XSD billNoType is alphanumeric only. */
const BillNo = z.string().regex(/^[A-Za-z0-9]+$/, 'alphanumeric bill number (XSD billNoType)');
/** XSD carrierCodeType: 2 (IATA) or 4 (SCAC) characters. */
const CarrierCode = z.string().regex(/^[A-Z0-9]{2}([A-Z0-9]{2})?$/, '2-char IATA or 4-char SCAC');

export const ExpectedFileSchema = z
  .object({
    /** File name inside the shipment folder: a PDF, or a photo/scan image (JPEG/PNG, always source 'ocr'). */
    file: z.string().regex(/\.(pdf|jpe?g|png)$/i),
    docType: z.enum(DOC_TYPES),
    /** 'text' = real PDF text layer; 'ocr' = image-only scan that must go through Tesseract. */
    source: z.enum(['text', 'ocr']),
    pages: z.number().int().min(1).max(2),
    /** Key values printed on this document; used to measure OCR token recall on scans. */
    keyTokens: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (!/\.pdf$/i.test(f.file) && f.source !== 'ocr') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `image file ${f.file} has no text layer: source must be 'ocr'` });
    }
    if (!/\.pdf$/i.test(f.file) && f.pages !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `image file ${f.file} is a single page` });
    }
  });

export const ExpectedLineSchema = z
  .object({
    /** 1-based position of the line on the invoice (ShipmentLine id = inv0-line<lineNo>). */
    lineNo: z.number().int().positive(),
    styleNo: z.string().optional(),
    /** Case-insensitive substring of the line's title description. */
    descriptionContains: z.string().min(3),
    quantity: z.number().positive(),
    /** Unit as printed (PCS, SETS…). */
    unit: z.string().min(1),
    unitPrice: z.number().nonnegative(),
    /** Line amount exactly as printed (may disagree with quantity × unitPrice on purpose). */
    printedAmount: z.number().nonnegative(),
    countryOfOrigin: Iso2,
    /** First 6 digits of the HS code printed on the document; null when none is printed. */
    hs6: z.string().regex(/^\d{6}$/).nullable(),
    /** HS code exactly as printed (dotted), when printed. */
    hsPrinted: z.string().regex(/^\d{4}\.\d{2}(\.\d{2}){0,2}$/).optional(),
    /** Correct 6-digit heading per the description, for lines with no printed HS (classifier check). */
    hs6Truth: z.string().regex(/^\d{6}$/).optional(),
    /** Whole number, invoice currency, after the valuation policy (see notes for the arithmetic). */
    enteredValue: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.hs6 !== null && l.hsPrinted && l.hsPrinted.replace(/\./g, '').slice(0, 6) !== l.hs6) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `hs6 ${l.hs6} does not match hsPrinted ${l.hsPrinted}` });
    }
    if (l.hs6 === null && !l.hs6Truth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'lines without a printed HS code need hs6Truth' });
    }
  });

export const ExpectedBillSchema = z
  .object({
    masterScac: CarrierCode.optional(),
    masterBill: BillNo.optional(),
    houseScac: CarrierCode.optional(),
    houseBill: BillNo.optional(),
  })
  .strict();

export const ExpectedTransportSchema = z
  .object({
    mode: z.enum(['ocean', 'air']),
    /** NetCHB mode-transportation: 11 vessel containerized, 10 vessel non-containerized, 40 air. */
    modeTransportation: z.string().regex(/^\d{2}$/),
    /** CBP Schedule D 4-digit port of entry. */
    entryPort: z.string().regex(/^\d{4}$/).optional(),
    /** Container numbers as printed (no spaces). */
    containers: z.array(z.string().regex(/^[A-Z]{4}\d{7}$/)).optional(),
    bills: z.array(ExpectedBillSchema).optional(),
    grossWeightKg: z.number().positive(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.mode === 'air' && t.containers && t.containers.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'air shipments carry no containers' });
    }
  });

export const ExpectSchema = z
  .object({
    invoiceNumber: z.string().min(1),
    /** XSD invoiceNoType. */
    invoiceNumberNormalized: z.string().regex(/^[A-Za-z0-9-]{1,17}$/),
    /** ISO date after resolving any day/month ambiguity. */
    invoiceDate: IsoDate.optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    incoterm: z.object({ code: z.enum(INCOTERMS_2020), place: z.string().min(2) }).strict(),
    sellerName: z.string().min(2),
    buyerName: z.string().min(2),
    importerName: z.string().min(2),
    ultimateConsigneeName: z.string().min(2).optional(),
    transport: ExpectedTransportSchema,
    lines: z.array(ExpectedLineSchema).min(1),
    totalEnteredValue: z.number().int().nonnegative(),
    issuesInclude: z.array(z.enum(ISSUE_CODES)),
    issuesExclude: z.array(z.enum(ISSUE_CODES)),
  })
  .strict()
  .superRefine((e, ctx) => {
    const sum = e.lines.reduce((s, l) => s + l.enteredValue, 0);
    if (sum !== e.totalEnteredValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalEnteredValue'],
        message: `totalEnteredValue ${e.totalEnteredValue} ≠ sum of line enteredValue ${sum}`,
      });
    }
    const nos = e.lines.map((l) => l.lineNo);
    if (new Set(nos).size !== nos.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'duplicate lineNo' });
    }
    const both = e.issuesInclude.filter((c) => e.issuesExclude.includes(c));
    if (both.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `codes both included and excluded: ${both.join(', ')}` });
    }
    if (e.currency !== 'USD' && !e.issuesInclude.includes('CURRENCY_CONVERSION')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'non-USD shipments must expect CURRENCY_CONVERSION' });
    }
  });

export const ExpectedShipmentSchema = z
  .object({
    id: z.string().regex(/^s\d+-[a-z0-9-]+$/),
    description: z.string().min(10),
    files: z.array(ExpectedFileSchema).min(1),
    /** Human-readable reasoning, including the hand-computed valuation arithmetic. */
    notes: z.array(z.string()).min(1),
    expect: ExpectSchema,
  })
  .strict();

export type ExpectedShipment = z.infer<typeof ExpectedShipmentSchema>;
export type ExpectedShipmentInput = z.input<typeof ExpectedShipmentSchema>;
export type ExpectedLine = z.infer<typeof ExpectedLineSchema>;

/** Validates parsed JSON; returns the typed value or a list of readable error strings. */
export function validateExpected(
  json: unknown,
): { ok: true; value: ExpectedShipment } | { ok: false; errors: string[] } {
  const r = ExpectedShipmentSchema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
