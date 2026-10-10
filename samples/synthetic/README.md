# Synthetic test shipments

Five fictional shipments that check whether the pipeline generalizes beyond the reference
sample in `samples/*.pdf`. Their layouts, label wording, column orders, fonts, number formats and
document mixes differ from the sample on purpose. A parser that is hardcoded to the sample should
fail on them. All companies, addresses, bill numbers and bank details are invented.

Each folder holds the documents (PDFs, and for s5 a JPEG photo) plus `expected.json`, the hand-checked ground truth. That file is
validated by the zod schema in `scripts/synthetic/expected-schema.ts`.

| Folder | Documents | Mode / terms | What it tests |
|---|---|---|---|
| `s1-air-eur-fca` | `RW-26-10387_Rechnung.pdf` (text, A4), `HAWB_MSA2604417_scan.pdf` (scan) | air (40), EUR, FCA Frankfurt Airport | German DIN-5008 letter layout with an address window and an info block on the right. Bilingual labels (`Rechnung / Invoice`, `Inv #`, `Unit Value`, `Ext. Value`, `Zolltarif-Nr.`). **German number format** (`9.240,00`). 8-digit HTS (8211.91.40, 8211.91.50, 7323.93.00). PCS/SETS units. Weights in a footer. Net 30. IATA-style house air waybill: MAWB 020-12345675 (valid mod-7), HAWB, FRA→ORD, LH 8402. The AWB's chargeable weight is bigger than the gross weight, and its "Decl. Value for Customs: NCV" box is a trap. Red RECEIVED stamp. **No packing list.** |
| `s2-scan-cn-ddp` | `scan_20260915_0042.pdf` (scan, combined CI + PL), `CXSVNGB26091187_BL.pdf` (text, 2 pages) | ocean (11), USD, DDP Savannah | **Scanned** combined `COMMERCIAL INVOICE & PACKING LIST`. Times font, Chinese company name line, full-width header rows (`Messrs.:`, `Terms of Delivery:`). Columns in the order `Item \| HS Code \| Description \| Ctns \| Qty \| Unit \| Unit Price \| Amount \| N.W. \| G.W.`. Multi-line descriptions. **Itemized DDP charges** that are included in the prices (freight, insurance, US duties & fees, US inland delivery). **Line 3 printed amount is wrong** (8,280.00 vs 1,200 × 6.85 = 8,220.00), and the printed total corroborates the computed amounts. Red round company chop. The house B/L has a different grid and label set, SCAC-prefixed house and master numbers, a valid ISO 6346 container, and terms and conditions on page 2. |
| `s3-messy-minimal` | `Invoice_KKE-1187.pdf` (text, Letter), `BL_BYXLMAA26031287_scan.pdf` (scan) | ocean (11), USD, FOB Chennai | QuickBooks-style US invoice in Courier from an Indian exporter. **MM/DD/YYYY date 03/04/2026** that only chronology resolves (India normally writes DD/MM). Quantity-first columns, **no HS codes**, and one line **made in Sri Lanka** while the header origin is India. Invoice number with `/`. The carrier B/L is consigned to a **3PL in Edison NJ "for account of" the buyer**. Its **container check digit is wrong** (a single-digit typo; no single OCR-confusion swap makes it valid, so nothing may "correct" it). Freight collect. Red TELEX RELEASE stamp over the notify block. **No packing list.** |
| `s4-kr-fob-multi-container` | `CI_MRH-260914-07.pdf` (text, **2 pages**), `PL_MRH-260914-07.pdf` (text), `HNRLPUSA26091742_scan.pdf` (scan) | ocean (11), USD, FOB Busan, L/C at sight | Korean small-appliance maker (Incheon) → Los Angeles importer. Korean trade-form invoice in Apple SD Gothic Neo with circled box numbers and a Hangul company line: `For Account & Risk of Messrs.`, `Invoice No. & Date`, `L/C No. & Date`, `L/C Issuing Bank`, `Terms of Price`, `Shipped per`, `Sailing on or about`, `From / To`. Columns `Marks & Numbers \| Description of Goods \| Model No. \| H.S. Code \| Quantity \| Unit Price \| Amount`, with shipping marks in the first column, a caption row (`HOUSEHOLD ELECTRIC APPLIANCES … FOB BUSAN`) and quantity + unit in one cell (`1,440 SETS`). **The item table continues on page 2 without a header row**, and line 4 exists only there. **`LESS : 3% VOLUME DISCOUNT -USD 5,299.63`** between SUB TOTAL and TOTAL. Signed by a named officer. Packing list with a **Container/Seal table: two 40' HC containers** (both valid ISO 6346). The scanned **carrier master B/L** (no house bill, SCAC-prefixed number) is consigned **"TO THE ORDER OF" the L/C bank** with the buyer as notify party. Freight prepaid / as arranged. Blue SHIPPED ON BOARD stamp. |
| `s5-id-footwear-cfr` | `Invoice_SB-2609-0233.pdf` (text), `IMG_20260912_101734.jpg` (**JPEG phone photo**), `HBL_JKSAV260917.pdf` (text) | ocean (11), USD, CFR Savannah | Triangular trade: a Singapore trader invoices a Columbus, OH retailer for footwear made in Tangerang, Indonesia. Gill Sans invoice with **YYYY.MM.DD dates**, `Inv. Ref.`/`Dated`/`Your Order`/`Our S/C`, `Invoiced to`/`Deliver to`/`Goods made & shipped by`, **PRS** units and columns `Description of Goods \| Article \| Unit \| Quantity \| Price \| Amount \| HTS (US)` (HTS last). An **itemized freight breakdown inside the CFR price** (FOB value + ocean freight = CFR value). **Line 2 is footnoted as made in Vietnam** at a sister factory, with its address. The factory's packing list is a **photo**: 1600×2133 px JPEG (q80, 72 dpi EXIF) with the sheet on a desk, rotated 2.1°, a drop shadow, a light gradient, a vignette, a warm cast, blur and noise. It has rows per colour and a blue round factory stamp. The NVOCC **house B/L prints its SCAC (TSGL) apart from the house number** and references the carrier's SCAC-prefixed master B/L. Route: Tanjung Priok → Singapore (transhipment) → Savannah. 1 x 40' GP, freight prepaid, **ORIGINAL** (not telex). |

## Expected issues (codes from `IssueCode` in `packages/shared/src/types.ts`)

| Case | `issuesInclude` | Notable `issuesExclude` (no false positives) |
|---|---|---|
| s1 | MISSING_DOCUMENT, CURRENCY_CONVERSION | NON_DUTIABLE_CHARGES (FCA), NCV_VALUE (AWB "NCV" box), DATE_AMBIGUOUS (18.09.2026), container issues, LINE_AMOUNT_MISMATCH, GROSS_WEIGHT_MISMATCH |
| s2 | LINE_AMOUNT_MISMATCH, NON_DUTIABLE_CHARGES | TOTALS_MISMATCH, CHARGES_NOT_ITEMIZED, MISSING_DOCUMENT (the combined doc *is* the packing list), container issues, ULTIMATE_CONSIGNEE_ASSUMED |
| s3 | HTS_NOT_DECLARED, ORIGIN_DIFFERS, CONTAINER_NUMBER_INVALID, ULTIMATE_CONSIGNEE_ASSUMED, DATE_AMBIGUOUS, MISSING_DOCUMENT, INVOICE_NO_NORMALIZED, TELEX_RELEASE | CONTAINER_NUMBER_CORRECTED (never invent a correction), NON_DUTIABLE_CHARGES, LINE_AMOUNT_MISMATCH |
| s4 | *(none asserted)* | HOUSE_MASTER_BILL (carrier bill only), TOTALS_MISMATCH (subtotal − discount = total), NON_DUTIABLE_CHARGES (FOB), SELLER_NOT_MANUFACTURER, container issues, MISSING_DOCUMENT, COLLECT_CHARGES, QTY/weight/package mismatches |
| s5 | NON_DUTIABLE_CHARGES, ORIGIN_DIFFERS, SELLER_NOT_MANUFACTURER, HOUSE_MASTER_BILL | CHARGES_NOT_ITEMIZED (freight is itemized), DATE_AMBIGUOUS (YYYY.MM.DD), TELEX_RELEASE (original B/L), QTY_MISMATCH (packing list rows are per colour), MISSING_DOCUMENT (the photo *is* the packing list), container issues |

## Valuation policy used for `enteredValue`

Each line's entered value is a whole number in the **invoice currency** (no USD conversion here):
line amount after arithmetic correction, minus the non-dutiable charges included in the price
(international freight and insurance, US duties and fees, US inland freight), prorated by line
value, plus assists. NCV lines use their stated customs value. Each line is rounded half-up, and
`totalEnteredValue` is the sum of the rounded lines.

- s1: FCA, nothing to deduct. Total EUR 21,878.
- s2: DDP. 4,580 of charges are prorated over 20,920, giving lines 3,468 / 3,796 / 6,420 / 2,656 = 16,340.
- s3: FOB, nothing to deduct. Total USD 21,180.
- s4: FOB, so no charges are deducted. The printed **3% volume discount (5,299.63) is apportioned to the lines by value**
  (`ValuationInputs.discount`), giving 44,418 / 37,853 / 35,074 / 54,010 = 171,355. The net invoice total is 171,354.77;
  the difference is per-line rounding. **This is a judgment call:** a discount that is shown on the invoice and actually
  granted lowers the price actually paid. A broker who treats it as a retroactive rebate would enter 176,654 instead.
  `docs/NETCHB_NOTES.md` §8 lists discounts as not handled by the app, so expect a valuation mismatch here.
- s5: CFR. The itemized ocean freight of 4,350 is prorated over 114,300, giving 51,425 / 37,054 / 21,471 = 109,950, which equals the printed FOB value.

The full arithmetic is in each `expected.json` → `notes`. `scripts/synthetic/consistency.ts`
recomputes every value from the template data and fails generation if a hand-entered number
disagrees.

## expected.json shape

```
{ id, description,
  files: [{ file (.pdf, or .jpg/.jpeg/.png → source 'ocr', 1 page), docType, source: 'text'|'ocr', pages, keyTokens[] }],
  notes: string[],
  expect: {
    invoiceNumber, invoiceNumberNormalized, invoiceDate?, currency, incoterm: { code, place },
    sellerName, buyerName, importerName, ultimateConsigneeName?,
    transport: { mode: 'ocean'|'air', modeTransportation, entryPort?, containers?, bills?: [{ masterScac?, masterBill?, houseScac?, houseBill? }], grossWeightKg },
    lines: [{ lineNo, styleNo?, descriptionContains, quantity, unit, unitPrice, printedAmount, countryOfOrigin,
              hs6 (printed, or null), hsPrinted?, hs6Truth? (correct heading when none is printed), enteredValue }],
    totalEnteredValue, issuesInclude: IssueCode[], issuesExclude: IssueCode[] } }
```

- `descriptionContains` is a case-insensitive substring of the line's description text (title plus detail lines).
- `keyTokens` are values printed on the document. They are used to measure text-layer and OCR recall.

## Commands

```bash
npx tsx scripts/make-synthetic.ts             # (re)generate everything here + SHA256SUMS; exits 1 if any expected.json is invalid
npx tsx scripts/make-synthetic.ts --out /tmp/x --only s2-scan-cn-ddp
npx tsx scripts/synthetic/self-check.ts       # text-layer + Tesseract (--psm 11) recall report [--only s5-id-footwear-cfr]
npx vitest run --config scripts/synthetic/vitest.config.ts
```

Generation is deterministic. HTML is rendered by Playwright's Chromium, and the PDF metadata
is then rewritten with pdf-lib: fixed dates, no `/ID`, no XMP. The scans use pdftoppm at 200 dpi,
then sharp adds a stamp, off-white paper, 0.65–1.1° rotation, blur, seeded noise and dust. Each
scan is wrapped as an image-only PDF with pdf-lib. The s5 photo (`scripts/synthetic/photo.ts`) is made from the
same 200 dpi raster: the stamp is added, the page is scaled to 1440 px and given a paper tint and 2.1° rotation, then
placed on a mottled desk with a soft shadow. A light gradient, vignette, warm cast, σ 0.8 blur and seeded noise follow,
and it is saved as a 1600×2133 JPEG at q80. Two runs produce byte-identical files, and
`SHA256SUMS` records them. Fonts come from the local machine (macOS here), so the hashes are only
stable on the same machine and font set.

## Measured self-check (on the committed files)

| File | Text-layer chars | Key-value recall |
|---|---|---|
| s1 invoice (text) | 2,103 | 100% (pdftotext) |
| s1 HAWB (scan) | 0 | 100% (17/17), Tesseract mean conf 93 |
| s2 CI+PL (scan) | 0 | 96% (27/28; misses item `HY-BP3080`), mean conf 84 |
| s2 B/L (text) | 4,177 | 100% |
| s3 invoice (text) | 1,102 | 100% |
| s3 B/L (scan) | 0 | 100% (16/16), mean conf 94 |
| s4 invoice (text, 2 pages) | 2,281 | 100% |
| s4 packing list (text) | 1,675 | 100% |
| s4 master B/L (scan) | 0 | 100% (20/20), mean conf 91 |
| s5 invoice (text) | 2,234 | 100% |
| s5 packing list (JPEG photo, OCR'd as delivered) | 0 | 82% (18/22; misses `SNA-SL0410` → `SNA-SLO410`, `830.0`, `5,940.0`, `57.00`), mean conf 88 |
| s5 house B/L (text) | 2,379 | 100% |

The recall is measured on the raw scans with no stamp suppression. A key counts as found only
when it equals one OCR word or 2–4 consecutive words, ignoring punctuation. The S2 scan also shows
realistic OCR errors such as `240}`, `$40.00` for `840.00`, `20 920.00` and garbage from the table
rules. That is intended.

## Inferred, not confirmed

- s1 `bills[0]`: for air, `masterScac: "LH"` (2-char IATA code, allowed by XSD `carrierCodeType`) and `masterBill` = the 11-digit AWB number. How NetCHB maps air bills is inferred.
- Entry ports: 3901 Chicago (O'Hare air cargo), 1703 Savannah, 4601 Newark, 2709 Long Beach. These are from Schedule D knowledge and should be verified.
- s4 discount treatment (see above) and the importer for a to-order B/L: the consignee is "TO THE ORDER OF CORONADO
  TRUST BANK" and the notify party is the buyer. The expected importer and ultimate consignee is the buyer. Whether the app
  should flag this with IMPORTER_ASSUMED or ULTIMATE_CONSIGNEE_ASSUMED is not asserted.
- s5 bills: the house SCAC `TSGL` is printed only in the NVOCC letterhead, apart from the house number `JKSAV260917`.
  Pairing them as `houseScac` + `houseBill` follows AMS practice.
- All SCACs, container prefixes, company names, bank names and registration numbers in s4/s5 are invented. They were not
  checked against the NMFTA SCAC register.
- The s5 photo is OCR'd here at its native resolution. How the pipeline ingests images (upscaling, deskew) is up to the
  app. `server/test/integration/synthetic-report.ts` currently sends every file as `application/pdf`, so the JPEG needs
  `image/jpeg` there (or content sniffing in ingest).
