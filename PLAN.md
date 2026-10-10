# Sefer Take-Home — Shipment Docs → NetCHB Entry XML

**Input:** shipment documents (PDF or image), e.g. commercial invoice, packing list, bill of lading.
**Output:** (1) NetCHB entry XML, shown and downloadable, and (2) action items: missing info and steps the broker must take to complete the entry.

**Constraint:** no LLM APIs and no API keys. Extraction is deterministic: PDF text layer + Tesseract OCR + layout-aware rule-based parsing + arithmetic/check-digit repair.

Execution plan designed for fan-out: **T0 contracts + fixtures (main session) → 7 parallel tasks (Wave 1) → T8 integration → T9 end-to-end + deliverables**.
Every task owns a disjoint set of files, has its own tests, and must pass `typecheck` + its tests before reporting done.

---

## 0. Research findings (already verified — don't re-research)

### NetCHB XML web service
| Artifact | URL | Notes |
|---|---|---|
| Entry XSD | https://www.netchb.com/xml/entry/entry.xsd | 6,679 lines, ns `http://www.netchb.com/xml/entry`, root `<entry>`, **children must appear in XSD order** |
| Data types XSD | https://www.netchb.com/xml/data/data_type.xsd | imported by entry.xsd (ns `http://www.netchb.com/xml/data`) |
| SOAP WSDL | https://www.netchb.com/main/services/entry/EntryUploadService?wsdl | ops: `uploadEntry(username,password,entryXml)`, `amendEntry`, `queryEntryStatus`, `deleteEntry`, `updateBol` … (rpc, all strings) |
| Upload responses | https://www.netchb.com/xml/entry/entryUploadResponse.html | `<accepted><entry-no>ABC-0000001-1</entry-no></accepted>`; accepted ≠ accepted by CBP |

Local validation works: `sed 's#https://www.netchb.com/xml/data/data_type.xsd#data_type.xsd#' entry.xsd > entry.local.xsd && xmllint --noout --schema entry.local.xsd file.xml`

**Skeleton (required = \*)**
```
entry
 *entry-no            (choice: user-specified{filer-code,entry-no} | system-generated)   → use <system-generated/>
  … optional flags (precalculated, transmit, auto-apply-remedies, external-reference-number, disclaim-cotton-fee …)
 *header              importer-tax-id, importer-name, ultimate-consignee{tax-id,consignee-name},
                      *processing-port(\d{4}) *entry-port(\d{4}) *entry-date(xsd:date) *entry-type(01…)
                      bond-type, payment-type, charges(long), gross-weight(long), total-entry-value(long),
                      description, surety-code, state-destination, vessel-name, mode-transportation(10,11,…40…),
                      unlading-port, import-date, arrival-date, carrier-code(SCAC), voyage-no, location-of-goods(≤4) …
 *manifest            bill-of-lading* { master-scac, master-bill, house-scac, house-bill, *quantity(int), *unit(≤5) }
  containers          container { container-number, container-size, container-type, seal-numbers, … }
  ace-cargo-release-parties  entity{entity-code SE|BY|ST|LG|CS|MF|CN, entity-name, entity-information(choice id|address|selling-party-mid)}
 *invoices            invoice* { *invoice-no, related-party, foreign-currency{currency-code,exchange-rate},
                        *line-items/line-item* { export-date, *country-origin(ISO2), manufacturer-id(≤15),
                           *tariffs/tariff+ { *tariff-no(\d{5,10}), *value(long, whole USD), quantity1/unit-of-measure1,
                                              quantity2/unit-of-measure2, special-program, value-adjustment … },
                           country-export, lading-port(\d{5} Schedule K), gross-weight(long),
                           commercial-description, invoice-quantity, invoice-unit-value(choice user-specified|system-auto-calculate),
                           po-number, category-no(\d{0,3}) … } }
```
**Gotchas found in the XSD**
- `invoiceNoType` = `[A-Za-z0-9-]{1,17}`. The sample's invoice `KBAS/NB/26-0912` is **invalid as written**, so normalize it to `KBAS-NB-26-0912` and flag the change.
- `billNoType` is alphanumeric only. `carrierCodeType` is a 4-char SCAC.
- Tariff `value`, header `charges`/`gross-weight`/`total-entry-value` are `xsd:long`, so they take **whole numbers**.
- `importer-tax-id` is XSD-optional but CBP-required for type 01. **Passing XSD validation does not make an entry fileable**, so the UI must say so.
- Never emit `<transmit/>`. We generate entries for broker review and don't auto-file.

### OCR spike results (tesseract 5.5.1 + poppler, run locally on the sample)
| Doc | Text layer? | Result |
|---|---|---|
| Commercial invoice | **Yes** (3.5k chars) | Use the PDF text layer with word boxes (`pdftotext -bbox-layout`). No OCR needed. |
| Packing list | **No** (scan) | `--psm 6` (block) **drops table cells**. `--psm 11` (sparse) + TSV word boxes recovers **almost every cell at 91–96% confidence**. One misread: `14,60` for `14.60`, repairable because 49 × 14.60 = 715.40. The page is **skewed ~0.8°** (row y drifts ~40px across the width), so deskew coordinates before grouping rows. |
| Bill of lading | **No** (scan) | psm 11 reads HBL `BMLVHCM26090418`, MBL `OPLUSGN260917735`, seal `OPL7731482`, `1,930.000` kg, `13.580` CBM, all at c≥88. **Container is the weak spot**: the struck-through typed number OCRs as `OPLU3041228` (c1), the handwriting as `OPLKU 304/72 2`. OCR-confusion normalization (`/`→`1`, `K` dropped) plus the **ISO 6346 check digit** yields `OPLU3041722`, the only valid candidate. Red/blue stamps overlap the consignee/notify blocks, so suppress stamp-colored pixels before OCR. |

Other facts:
- USITC HTS REST API works without auth. **Use `GET https://hts.usitc.gov/reststop/exportList?from=6203.42&to=6203.43&format=JSON&styles=false`** for classification: it returns the FULL subtree including unnumbered parent rows (e.g. "Recreational performance outerwear:" vs "Other:", "Men's trousers and breeches:", "Boys', sizes 2-7:") that `search?keyword=` omits. The 2026 HTS restructured 6203.42 (men's cotton trousers → `6203.42.45.xx`, not the old .40). `search?keyword=6110.30` It returns rows with `htsno` (10-digit leaves look like `6110.30.10.10`), `statisticalSuffix`, `description` (textile category in parens, e.g. `Women's or girls' (646)`), `general` (rate on the 8-digit parent), `units` (`["doz.","kg"]`, may contain `<u>` html), and `indent` (tree depth).
- Installed locally: Node 22, npm 10, `tesseract` 5.5.1 (eng), `pdftoppm`/`pdftotext` (poppler), `xmllint`. No Python image libs, so image work is done in Node with `sharp`.

---

## 1. Sample shipment analysis = acceptance criteria

**Decision policy** (applies to all shipments; goes in the writeup):
1. When documents conflict, **default to the commercial invoice** because it is the seller-certified document. The exception is when arithmetic or physical evidence proves the invoice wrong.
2. **Never invent data.** Anything only the broker can know (EIN, bond, surety, FIRMS) becomes a broker input. Missing optional XML elements are omitted and listed.
3. **Conservative on value.** Don't under-declare when ambiguous, since undervaluation is the penalty risk.
4. Every correction, assumption, OCR repair, and conflict becomes an **Issue** with evidence, a severity, and a concrete action. Ambiguous ones expose a **decision** the broker can flip, which regenerates the XML.
5. **OCR confidence is surfaced.** Low-confidence or repaired fields are badged in the UI and listed as "verify against original".

| # | Finding in the docs | Expected app behavior |
|---|---|---|
| 1 | CI line 1: 2,400 × 2.85 = **6,840**, printed **6,480**; printed subtotal 21,975 only reconciles with 6,840 | Correct to 6,840 (evidence-backed). Severity: warning |
| 2 | Hoodie NB-H205: CI 1,200 pcs vs PL **1,176** (49 ctns × 24). Grand totals both read 5,100 only because of the 24 samples | Default to invoice quantity and value (conservative). Decision: packed qty, giving $8,702. Blocker: confirm short-ship or get a credit note |
| 3 | Hoodie composition: CI "60% cotton 40% poly" vs PL "TC 65/35" (T/C = **polyester**/cotton). Changes heading 6110.20 (cotton) vs 6110.30 (MMF), with a big duty swing | Blocker. Default to the invoice heading and show the alternative HTS plus duty impact. Action: get fiber-content spec or lab test |
| 4 | W-B220 blouse: CMT price only; buyer supplied fabric worth **USD 4,180** (note \*) | **Assist**: add to line value (1,260 + 4,180 = **5,440**). Cite 19 USC 1401a(h). Warning: confirm the apportionment |
| 5 | Item 5 samples: FOC/NCV, $1/pc "for customs", **origin Bangladesh**, made by SP Garments Dhaka (Gazipur). Invoice declaration says "Vietnam origin" | Separate line with COO **BD**, its own MID, value $24. Warning: $1/pc looks nominal and must reflect real value. Flag the declaration conflict |
| 6 | Incoterm **CIF Tacoma**; freight 3,850 + insurance 185 itemized; line amounts are FOB | Entered value excludes freight/insurance. Header `charges` = **4,035** |
| 7 | Seller = KB Kowloon Bay (HK middleman); manufacturer = Saigon Phoenix Garment JSC (VN) | MID from the **manufacturer**, not the seller. Seller goes in SE entity. Info: first-sale opportunity if the factory invoice exists |
| 8 | B/L container typed `OPLU3041728` crossed out, handwritten `OPLU3041722` | Gather all container-like candidates, normalize OCR confusions, keep only check-digit-valid ones: **OPLU3041722**. Warning: "handwritten/low-confidence, verify against arrival notice" |
| 9 | Gross weight: B/L **1,930 kg** vs PL **1,888 kg** (palletized: NO) | Header uses the B/L weight (matches manifest). Lines use PL per-style weights. Warning |
| 10 | Invoice date `12/09/2026` is ambiguous | HK uses DD/MM, so 2026-09-12. That's consistent with PL 20-Sep and on-board 24-Sep. Info |
| 11 | Invoice no. contains `/` | Normalize to `KBAS-NB-26-0912` (XSD pattern). Info |
| 12 | Bill to Northbound Outfitters (Portland); ship to Cascade Fulfillment (3PL, Kent WA) | Importer and ultimate consignee = Northbound. Ship-to (ST) = Cascade. `state-destination` = WA |
| 13 | HBL `BMLVHCM26090418` (NVOCC SCAC BMLV); MBL `OPLUSGN260917735`, carrier OPLU | `house-scac BMLV / house-bill HCM26090418`, `master-scac OPLU / master-bill SGN260917735`, 138 CTN |
| 14 | Only 6-digit HS on CI | Resolve to 10-digit via the USITC API tree plus rule-based attribute matching (gender / knit-woven / fiber) |
| 15 | No IOR number, bond, surety, FIRMS code; ETA is an estimate; Chapter 99 measures for VN/BD as of entry date unknown | Blockers or warnings plus a broker-inputs form. `auto-apply-remedies` toggle. Be honest that the app doesn't compute Ch.99 |
| 16 | Advisories | UFLPA (cotton apparel from VN is high scrutiny), ISF "filed by importer/agent", telex release, destination charges collect are non-dutiable |

**Golden header values:** entry-type `01` · entry/processing/unlading port `3002` (Tacoma) · mode `11` (vessel, containerized) · carrier `OPLU` · vessel `PACIFIC ARGOS` voy `041E` · export date `2026-09-24` · arrival `2026-10-14` (estimated) · gross-weight `1930` · charges `4035` · container `OPLU3041722`, seal `OPL7731482`, 20' GP.

**Golden lines** (default decisions):
| Line | Style | Heading | COO | Value (USD) | qty1 DOZ | qty2 KG (PL net) |
|---|---|---|---|---|---|---|
| 1 | NB-T101 men's cotton knit tee | 6109.10.00xx | VN | 6,840 | 200 | 432 |
| 2 | NB-H205 women's hoodie | 6110.20.20xx (alt 6110.30.30xx) | VN | 8,880 | 100 | 715.4 |
| 3 | NB-C330 men's cotton woven trousers | 6203.42.45xx | VN | 6,255 | 75 | 486 |
| 4 | W-B220 women's polyester woven blouse | 6206.40.30xx | VN | 5,440 | 50 | 96 |
| 5 | NB-P118S women's cotton knit polo samples | 6106.10.00xx | **BD** | 24 | 2 | 5.1 |
**total-entry-value = 27,439**. Stat suffixes are resolved by T4 from the HTS API, not hardcoded.

---

## 2. Architecture

```
temp-proj/
  package.json                 npm workspaces: packages/shared, server, web
  packages/shared/src/         ← T0  contracts (types.ts) — single source of truth
  server/src/
    ingest/                    ← T1  PDF text layer / rasterize / preprocess / deskew / Tesseract → DocumentLayout
    parse/                     ← T2  DocumentLayout → doc type + ExtractedDocument (rule-based, layout-aware)
    reconcile/                 ← T3  ExtractedDocument[] → Shipment + Issue[] (rule engine)
    reference/                 ← T4  HTS API client + rule-based 10-digit resolver, ports, countries, MID, fees/duty
    netchb/                    ← T5  Shipment → EntryModel (valuation, entities, units) → XML → XSD validation
    api/, pipeline.ts, cli.ts  ← T8  Express API + orchestration + CLI
  server/test/fixtures/sample/ ← T0  *.layout.json (raw OCR/text-layer word boxes) + *.expected.json (ground-truth ExtractedDocument)
  server/test/golden/          ← T0  sample-expected.json (§1)
  web/                         ← T6  React + Vite UI
  samples/                     ← T0  the 3 PDFs;  samples/synthetic/* ← T7
  e2e/                         ← T9  Playwright + API e2e over sample + synthetic shipments
  output/                      ← T9  generated entry XML + result JSON for the sample
  docs/                        NETCHB_NOTES.md (T5), WRITEUP.md + README.md (T9)
  Dockerfile                   ← T9  node:22 + apt tesseract-ocr poppler-utils (for later deployment)
```

**Pipeline**
```
upload
 → ingest   per page: text layer? → pdftotext -bbox-layout : pdftoppm 300dpi → sharp (grayscale, stamp-color suppression)
            → tesseract TSV --psm 11 → words{text,bbox,conf} → deskew (fit baseline slope) → lines (y-clustering)
 → parse    classify doc (title/keyword scoring) → generic primitives (label→value, header-driven table extraction,
            party blocks, footnotes) → domain extractors (containers, bills, HS, incoterms, dates, money, composition…)
            → constraint repair (qty×price=amount, ctns×per=total, column sums) → ExtractedDocument (+ per-field confidence)
 → reconcile  cross-doc rules → Shipment + Issues
 → classify   USITC tree walk + attribute rules → 10-digit + alternatives
 → assemble   valuation + broker inputs + decisions → EntryModel → XML → XSD validate
 → respond  PipelineResult (xml, issues, shipment, provenance, estimates)
```

**Stack:** TypeScript everywhere. Express + multer + zod; **system `tesseract` + poppler via `child_process`** (proven in the spike; best accuracy and speed; Dockerfile handles deployment); `sharp` for image preprocessing; `xmllint-wasm` for XSD validation (fallback: system `xmllint`); Vitest; React + Vite; Playwright. **No LLM, no API keys.** Optional network: USITC HTS API, cached to disk with committed fixtures so tests run offline.
`npm run dev` starts server :3001 and web :5173 (proxy `/api`). `npm run cli -- samples/*.pdf --out output/` runs the full pipeline headless.

**API**
- `POST /api/shipments` (multipart `files[]`, optional `brokerInputs` JSON) → `PipelineResult`
- `POST /api/shipments/:id/regenerate` `{ brokerInputs, decisions }` → `PipelineResult` (no re-OCR; in-memory store)
- `GET /api/health` (also reports whether tesseract and poppler are found, with versions)

---

## 3. T0 — Scaffold + contracts + fixtures (main session, before fan-out)

Done by the orchestrator, not a subagent, so that every Wave-1 agent builds against the same contract.
1. `git init`, `.gitignore`, npm workspaces, `tsconfig.base.json`, Vitest config, root scripts (`dev`, `build`, `test`, `typecheck`, `cli`, `e2e`).
2. `packages/shared/src/types.ts` (agents may add **optional** fields only):
   - **Layout:** `Word { text; x0; y0; x1; y1; conf (0–100); page }`, `Line { words[]; text; y; page }`, `PageLayout { page; width; height; source: 'text'|'ocr'; skewDeg; words[]; lines[]; stamps?: string[] }`, `DocumentLayout { docId; fileName; sha256; pages[] }`
   - **Extraction:** `DocType`, `Address`, `Observation` (kinds: handwritten/strikethrough/stamp/footnote/ocr_repair/low_confidence/other), `Extracted<T> { value; conf; repaired?; evidence?: { page; bbox; text } }`, `InvoiceLine`, `CommercialInvoiceData`, `PackingListLine`, `PackingListData`, `BillOfLadingData`, `ExtractedDocument`
   - `Sourced<T> { value; sources[]; status: 'extracted'|'derived'|'corrected'|'assumed'|'user'; conf?; note? }`, `ShipmentLine`, `Shipment`
   - `Issue { id; severity: 'blocker'|'warning'|'info'; category; title; detail; evidence[]; action; field?; decision?: { key; options[]; chosen } }`
   - `LineClassification { lineId; htsNumber(10 digits); description; generalRate?; adValoremPct?; units[]; textileCategory?; confidence; rationale; alternatives[] }`
   - `BrokerInputs { importerTaxId?; ultimateConsigneeTaxId?; bondType?; suretyCode?; paymentType?; entryType?; entryPort?; locationOfGoods?; entryDate?; autoApplyRemedies?; decisions?: Record<string,string> }`
   - `EntryModel` is a typed mirror of the XSD subset in §0 (camelCase of XSD tags).
   - `PipelineResult { shipmentId; documents; shipment; issues; classifications; entryModel; xml; xsdValidation: { valid; errors[] }; estimates: { dutyByLine; mpf; hmf; notes[] }; timingsMs }`
3. Copy the 3 PDFs to `samples/`. Vendor `entry.xsd` + `data_type.xsd` to `server/src/netchb/schema/` with a local import path.
4. **Layout fixtures:** run the spike commands (`pdftotext -bbox-layout` for the CI; `pdftoppm -r 300` + `tesseract --psm 11 tsv` for PL and B/L) and convert them to `server/test/fixtures/sample/*.layout.json` (raw, un-deskewed, no preprocessing = worst case). This lets T2 start in parallel with T1.
5. **Ground truth:** hand-author `*.expected.json` (`ExtractedDocument`) for the 3 docs, faithful to the PDFs including observations (crossed-out container, notes \*/(1)/(2)/(3), PL remarks, stamps).
6. Write `server/test/golden/sample-expected.json` from §1.
7. Gate: `npm install && npm run typecheck` passes.

---

## 4. Wave 1 — seven parallel tasks

Shared rules for every agent: touch only your owned paths (plus deps in your workspace's package.json); import contracts from `@app/shared`; only add **optional** fields to `types.ts` and report them; **no LLM or API-key services**; **never hardcode sample-specific strings, positions, or values** (graders use unseen documents; use synonym dictionaries and general rules); finish with `npm run typecheck` and your tests green; report assumptions and unverified items.

### T1 — Ingest & OCR  (owns `server/src/ingest/**`, `server/test/ingest/**`)
- `ingest(file: {name, bytes, mime}): Promise<DocumentLayout>` handles PDF (multi-page) and PNG/JPG/TIFF.
- Per page, use the text layer when it has meaningful text (`pdftotext -bbox-layout`, parse XHTML word boxes). Otherwise rasterize with `pdftoppm -r 300`.
- Preprocessing (`sharp`): grayscale, contrast normalize, and **stamp suppression**: whiten strongly red- and blue-saturated pixels for the main pass. Keep a second **stamp pass** on the red layer to read stamp text ("TELEX RELEASED", "SURRENDERED", "SHIPPED ON BOARD … DATE") into `stamps[]`. Compare OCR quality with and without suppression on the B/L and keep whichever is measurably better.
- OCR: `tesseract <img> - --psm 11 -l eng tsv` → words (drop conf<0 and empty). Optionally a `--psm 6` pass when sparse mode fragments long text.
- **Deskew:** estimate the page angle from the slopes of words grouped by tesseract line ids (robust median), rotate coordinates, then build `lines` by y-clustering.
- Pages run in parallel (pool = CPU/2). Cache by SHA-256 in `server/.cache/ocr/`. Clear errors if binaries are missing.
- **Tests:** CI uses the text layer; PL/B/L use OCR; skew estimate for the PL is ~0.8° (±0.3); the spike's key tokens are all recognized (per §0 table) with conf ≥ 80; stamp pass finds "TELEX RELEASED"; full sample ingest takes < 45 s. Report a token-recall table before/after preprocessing.

### T2 — Document parsers  (owns `server/src/parse/**`, `server/test/parse/**`)
- `classifyDocument(layout) → { docType, score }` from title/keyword scoring (commercial invoice, packing list, bill of lading (house/master), air waybill, arrival notice, combined "invoice & packing list", other).
- `parseDocument(layout) → ExtractedDocument`, built from **generic primitives**, each unit-tested on its own:
  - `vocab.ts`: synonym dictionaries per field ("Invoice No./Inv #/Invoice Number", "Consignee/Ship To/Deliver To", "Qty/Quantity/Pcs", "Unit Price/Unit Value/Price", "N.W./Net Wt", …)
  - `findLabelValue(layout, synonyms)`: value to the right on the same line, or below in the same column/box
  - `extractTable(layout, headerSynonyms)`: find the header row (multi-line headers), derive column x-ranges, assign words, group rows by the anchor column, merge continuation lines (description/composition/colour lines), detect subtotal/total/"brought forward" rows
  - `parseNumber`: `1,234.56`, `1.234,56`, `(24.00)` NCV/negative, OCR confusions in numeric context (O→0, l/I→1, S→5, `,`↔`.` decimal)
  - `parseParty(blockLines)`: name / address lines / city / state / ZIP / country; US address regex plus a country list
  - `parseFootnotes`: markers `*`, `**`, `(1)` linked to lines
- Domain extractors: container numbers (ISO 6346 regex plus confusion-aware candidate generation, check-digit validation, strikethrough/low-conf candidates kept as observations), SCAC + bill split, HS codes, Incoterms 2020 + place, dates (many formats, ambiguity flag), currency, weights/volumes, fiber composition (% parsing plus abbreviations TC/T/C/CVC/poly/spandex=elastane), gender/knit-woven/garment-type keywords, FOC/NCV/"value for customs purpose", line-level "Origin:/Made in", assists ("supplied free of charge by buyer … value").
- **Constraint repair:** qty×price vs amount, ctns×per-ctn vs total, row sums vs grand totals. A unique single-cell fix is applied with `repaired=true` + an observation. If the printed value disagrees but the subtotal corroborates the computed value (sample line 1), keep the printed value and leave the decision to T3.
- **Tests:** parse the T0 `*.layout.json` fixtures and diff against `*.expected.json`, reporting **field-level accuracy**. Target ≥ 95% of critical fields: all line qty/price/amount/HS, PL per-style pcs/weights incl. 1,176 and "TC 65/35", B/L numbers, container OPLU3041722, 1,930 kg, assist 4,180, line-5 origin BD. Add unit tests with small synthetic layouts (different label wording, column order, MM/DD dates) to prove nothing is sample-hardcoded. When T7 lands, also run its docs.

### T3 — Reconciliation + rules engine  (owns `server/src/reconcile/**`, `server/test/reconcile/**`)
- `reconcile(docs: ExtractedDocument[]): { shipment: Shipment; issues: Issue[] }`: merge by matching style/PO/invoice refs across docs, with `Sourced` provenance + confidence on every material field.
- Generic, individually unit-tested rules (one file each under `rules/`), each with a passing case and a firing case:
  line arithmetic and subtotal corroboration · totals/charges reconciliation · CI↔PL qty per style · CI↔PL fiber/composition conflict · CI↔PL↔BL package count · PL↔BL gross weight (1% tolerance) · container check digit + handwritten/strikethrough candidates · line origin ≠ header origin / declaration conflict · FOC/NCV lines (value required, nominal-value warning) · assists · incoterm and itemized non-dutiable charges (blocker if D-terms aren't itemized) · date ambiguity resolved by chronology · seller ≠ manufacturer (MID source, first-sale info) · importer/UC vs 3PL ship-to · house vs master B/L · estimated arrival · related party unknown (assume N) · **low-confidence/repaired OCR fields → "verify" warnings** · advisories (UFLPA for cotton, ISF, telex release, collect charges).
- Ambiguous rules emit `decision` with a default per the §1 policy.
- **Tests:** on the T0 `*.expected.json` fixtures, every reconciliation row of §1 is produced with the right severity, and there are no false positives on consistent fields. Add 3–4 small synthetic fixtures (clean shipment with zero blockers, DDP unitemized, MM/DD US invoice, air shipment).

### T4 — Reference data, rule-based HTS classification, fees  (owns `server/src/reference/**`, `server/test/reference/**`)
- HTS client for the USITC API with an on-disk cache and committed fixtures for the sample headings plus T7's. `getSubtree(code)` returns the tree with inherited general rate, units (html stripped, mapped to NetCHB UOM: `doz.`→`DOZ`, `kg`→`KG`, `No.`→`NO` …), and textile category parsed from the description.
- `classifyLine(attrs, declaredHs?)` is **deterministic**: walk the subtree under the declared code. At each level, score child descriptions against the line attributes (gender "Men's or boys'" / "Women's or girls'", garment-type keywords, fiber thresholds such as "containing 36 percent or more by weight of flax", knit vs woven via Ch.61/62), and fall back to "Other" when nothing matches.
  - Output `confidence` plus `alternatives`, e.g. the MMF leaf when composition conflicts, using predominant fiber by weight.
  - With no declared code, keyword-search the API and return candidates with confidence `low`, which T3/T8 turn into a broker decision.
  - Also flag Ch.61 (knit) vs Ch.62 (woven) mismatches between the declared HS and the description.
- Ports: US Schedule D (curated JSON of major ports incl. 3002 Tacoma, 3001 Seattle, 2704 LA, 2709 Long Beach, 1001 NY/NJ, 4601 Newark, 5301 Houston, 1601 Charleston, 1703 Savannah, 2720 LAX…, plus fuzzy name match). Foreign Schedule K (curated; find the official code for Cat Lai/HCMC; **if not verifiable, return null and the caller emits an issue**). ISO country names → alpha-2. US state from address.
- `buildMid(manufacturer)` implements CBP MID rules (ISO2 + first 3 letters of the first two name words, skipping stop-words and legal suffixes + first 4 digits of the largest street number + first 3 letters of city, ≤15 chars). Test against CBP's published examples. Returns `needsVerification` for ambiguous addresses ("Lot C7-C8, Road No. 9").
- Fees/duty estimate: duty = ad valorem general rate × line value. MPF 0.3464% with FY min/max and HMF 0.125% (vessel only) go in `fees.config.json` with an "effective FY / verify" note. No Chapter 99 computation; that's an explicit note.
- **Tests:** leaf resolution for all 5 sample lines (incl. alternative for hoodie), unit mapping, category extraction, Ch.61/62 mismatch, MID examples, fee clamping, port lookups.

### T5 — Entry assembly + NetCHB XML  (owns `server/src/netchb/**`, `server/test/netchb/**`, `docs/NETCHB_NOTES.md`)
- `assembleEntry(shipment, classifications, brokerInputs, issues) → { entryModel; issues; estimates }`
  - Valuation per line: (corrected) amount, minus non-dutiable charges per incoterm (prorate only if line prices aren't already FOB), plus assists to the related line, stated customs value for NCV lines, then decisions (qty/composition). Round to whole USD and keep a computation trail.
  - Non-USD invoices: set `foreignCurrency` and log the assumption.
  - Units: PCS → DOZ ÷12 (2 decimals); KG from PL net weight per style, falling back to gross proration with an issue.
  - Header/manifest/containers/entities: ports, mode, SCAC/bill split, cargo-release parties (SE, BY, ST, MF, CS), `system-generated` entry no, `autoApplyRemedies` (default on, with a warning).
  - Every CBP-required field still missing after broker inputs gets a blocker.
  - Lookups (ports, MID, classification) are injected as parameters so T5 isn't blocked on T4.
- `buildEntryXml(model)`: **exact XSD sequence order**, namespace, escaping, omitted empty optionals, whole numbers for `long`, `YYYY-MM-DD`. `validateEntryXml(xml)` uses `xmllint-wasm` with both XSDs preloaded, falling back to system `xmllint`. `normalizeInvoiceNo/BillNo` follow the XSD patterns. `buildUploadEnvelope(xml)` is a SOAP preview for display only.
- `docs/NETCHB_NOTES.md`: element semantics, split into **confirmed by XSD** vs **inferred**, plus enumerations (bond-type, payment-type, container size/type, related-party).
- **Tests:** the sample fixture through stub reconcile/classify asserts every golden value in §1 (total 27,439, charges 4,035, line 4 = 5,440, line 5 COO BD); decisions flip values (hoodie qty → 8,702); CIF/FOB/EXW/DDP valuation table; XML passes XSD; element order asserted; a deliberately mis-ordered XML fails (proves the validator works).

### T6 — Frontend  (owns `web/**`)
- React + Vite + TS, typed against `@app/shared`, developed against a `mock` adapter that returns a realistic `PipelineResult` (hand-built from §1).
- **Upload:** drag-drop multiple PDFs/images, file list with detected doc type and OCR/text-layer badge, progress, error state (e.g. "tesseract not installed").
- **Results tabs:**
  1. **Action items:** grouped and counted, evidence quotes, action, decision radio → regenerate
  2. **Entry XML:** highlighted, copy/download, XSD-valid badge, "XSD-valid ≠ CBP-ready" note, SOAP preview
  3. **Shipment data:** lines table with provenance + **confidence badges** (extracted/repaired/corrected/assumed/low-confidence)
  4. **Valuation & duties:** per-line computation trail with caveats
  5. **Broker inputs:** form → regenerate
  6. Optional: an **OCR view** that shows the page image with word boxes for low-confidence fields.
- **Tests:** Vitest + Testing Library for issue grouping, decision → regenerate call, and broker form validation (EIN `\d{2}-\d{7}..`). `npm run build -w web` passes.

### T7 — Synthetic test shipments  (owns `samples/synthetic/**`, `scripts/make-synthetic.ts`)
Proves the parsers generalize. **Different layouts and wording from the sample on purpose.** Build 3 shipments from HTML templates rendered to PDF with Playwright. "Scanned" variants are rasterized and then given ~1° rotation, noise/blur, and a red stamp (sharp), then wrapped as an image-only PDF (pdf-lib). Each has `expected.json` (key header fields; lines with value/COO/heading-6; expected issue keywords).
- **S1 Air / EUR / FCA:** German kitchen tools, CI (text PDF) + air waybill (scan), no PL. Covers mode 40, foreign currency, missing PL, different label vocabulary ("Inv #", "Unit Value").
- **S2 Scanned combined "Invoice & Packing List" / China / DDP:** itemized duty+freight+US delivery, 8-digit HS, one line where qty×price ≠ amount, columns in a different order.
- **S3 Messy minimal:** US-style MM/DD date, no HS codes, two origins (IN/LK), FOB, B/L with a container whose check digit is wrong, consignee ≠ buyer.
- **Tests:** the script regenerates deterministically, and every `expected.json` validates against a zod schema.

---

## 5. T8 — Integration  (after Wave 1; owns `server/src/api/**`, `server/src/pipeline.ts`, `server/src/cli.ts`, `server/test/integration/**`, `web/src/api/real.ts`)
- `runPipeline(files, brokerInputs)`: ingest (parallel) → parse → reconcile → classify → assemble → XML → validate → estimates. Results go in an in-memory store for `/regenerate`. Record timings.
- Express routes with zod validation, a 20 MB/file limit, mime checks, clear errors (missing tesseract/poppler → 503 with an install hint). Switch the web adapter from mock to real.
- CLI writes `output/<invoice>.entry.xml` + `output/<invoice>.result.json`.
- Fix interface mismatches between T1–T6 (list every cross-module change).
- **Tests:** supertest on the 3 sample PDFs through the **real OCR path**. XML passes XSD; golden values from §1 hold; every §1 issue is present. Regenerate with decisions and broker inputs (adding EIN removes that blocker). Also run the same through the fixture-layout path to separate OCR errors from parser errors.

## 6. T9 — End-to-end, generalization, deliverables  (after T8; owns `e2e/**`, `output/**`, `README.md`, `docs/WRITEUP.md`, `Dockerfile`)
1. **Sample E2E:** CLI over `samples/*.pdf`, diff against golden, record an extraction-accuracy table. Write `output/KBAS-NB-26-0912.entry.xml`, which must pass XSD validation.
2. **Playwright UI E2E:** upload 3 PDFs, assert blockers (hoodie composition, quantity mismatch, missing importer EIN), XSD-valid badge, fill EIN → regenerate → blocker gone, download XML.
3. **Generalization run** over T7 S1–S3: pass/fail matrix against `expected.json`. Fix **generic** bugs in a loop and never special-case a test doc. Leftovers go in the writeup.
4. **Dockerfile** (node:22 + tesseract-ocr + poppler-utils) and verify `docker build` + run.
5. **README:** prerequisites (`brew install tesseract poppler` or Docker), install/run/test/CLI, architecture, how to read the output, limitations.
6. **docs/WRITEUP.md (≤1 page):**
   - how NetCHB was tracked down (XSD, WSDL, response docs)
   - the extraction approach and why deterministic OCR + rules, with measured accuracy
   - the decision policy and the sample's judgment calls
   - unknowns: no NetCHB sandbox; inferred field semantics; Schedule K; FY2027 fees; Ch.99 for VN/BD; MID ambiguity; handwriting/strikethrough limits of OCR
   - more time: NetCHB sandbox round-trip, table-structure models, layout templates learned from broker corrections, ISF cross-check, more doc types, deployment

---

## 7. Execution order and gates

```
T0 (main session) ──► Wave 1 in parallel: T1 T2 T3 T4 T5 T6 T7 ──► T8 ──► T9
gate: typecheck        gate per task: typecheck + own tests green      gate: integ tests   gate: e2e + golden + XSD
```
- 9 subagents total (7 + 2), within the medium workflow size.
- After Wave 1: the orchestrator runs `npm run typecheck && npm test` at the root and resolves `types.ts` additions before T8.
- Each agent's final report covers files changed, tests run (with counts), assumptions, unverified items, and follow-ups. These summaries feed the writeup.

## 8. Inputs needed from the user
- None for building. tesseract 5.5.1 and poppler are already installed on this machine. Reviewers need `brew install tesseract poppler` or Docker.
- At the end, export the AI chat history: run `/export` for this session. Subagent transcripts live under `~/.claude/projects/-Users-aaashish-Projects-temp-proj/`.
- Commits and GitHub push happen only on your go-ahead.
