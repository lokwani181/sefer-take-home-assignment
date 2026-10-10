# Shipment documents → NetCHB entry XML

A customs broker uploads the documents for one shipment and gets back what they need to file it in NetCHB:

| In | Out |
|---|---|
| Commercial invoice, packing list, bill of lading or air waybill (or a combined invoice + packing list). PDF with a text layer, scanned PDF, PNG, JPEG, TIFF or WebP; up to 10 files. | **1. A NetCHB entry XML** (`<entry xmlns="http://www.netchb.com/xml/entry">`), validated against NetCHB's own `entry.xsd`, shown in the browser and downloadable. |
| Optional **broker inputs**: importer tax ID, bond type, surety code, FIRMS code, entry date… | **2. Action items**: blockers, warnings and info, each with the evidence quoted from the documents, a concrete action, and (when the documents are ambiguous) a **decision** the broker can flip. Flipping it regenerates the XML. |

**No LLMs and no API keys.** Extraction is deterministic: PDF text layer + Tesseract OCR + layout-aware, rule-based parsing, with arithmetic and check-digit repair. Every value in the XML can be traced to a document, a rule, or a broker input.

> XSD-valid is not the same as CBP-ready. The app never transmits anything: it prepares an entry for broker review and never emits `<transmit/>`.

Design write-up: [docs/WRITEUP.md](docs/WRITEUP.md) · NetCHB field mapping: [docs/NETCHB_NOTES.md](docs/NETCHB_NOTES.md) · Build plan and sample analysis: [PLAN.md](PLAN.md)

---

## Contents
- [Quick start](#quick-start)
- [Using the web app](#using-the-web-app)
- [CLI](#cli)
- [HTTP API](#http-api)
- [Tests](#tests)
- [Architecture](#architecture)
- [How NetCHB was researched](#how-netchb-was-researched)
- [Design decisions](#design-decisions)
- [Limitations and known gaps](#limitations-and-known-gaps)
- [Configuration](#configuration)
- [Project layout](#project-layout)

---

## Quick start

### Prerequisites
- **Node.js 22+** (npm 10+)
- **Tesseract** (with English data) and **poppler** (`pdftotext`, `pdftoppm`) on the `PATH`:
  - macOS: `brew install tesseract poppler`
  - Debian/Ubuntu: `sudo apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils`
- Optional: `xmllint` (`libxml2-utils`; preinstalled on macOS). XSD validation uses the bundled `xmllint-wasm` and falls back to the system binary.
- Or just **Docker** (see below), which bundles all of the above.

The header of the web app shows whether the server found these tools (hover the status dot for versions). `GET /api/health` reports the same.

### Install and run
```bash
npm install

# Development (hot reload): API on :3001, Vite on :5173 proxying /api
npm run dev                     # open http://localhost:5173

# Production: build the web app, then one Express process serves the UI and the API
npm run build && npm start      # open http://localhost:3001
```

### Docker
```bash
docker build -t netchb-entry .
docker run --rm -p 3001:3001 netchb-entry        # open http://localhost:3001
```
- Multi-stage `node:22-bookworm-slim` image with `tesseract-ocr`, `tesseract-ocr-eng`, `poppler-utils` and `libxml2-utils`. It runs as the non-root `node` user and has a `HEALTHCHECK` on `/api/health`. The image is about 860 MB.
- **Tesseract version:** Debian bookworm ships **Tesseract 5.3.0**, while development used **5.5.1** (Homebrew). OCR confidences, and occasionally a marginal reading, can differ slightly. On the sample shipment the container's entry XML was byte-identical to the macOS run (total entered value 27,439, container OPLU3041722, XSD-valid), with the same five blockers.
- Try the CLI inside the container (the sample PDFs are included):
  `docker run --rm netchb-entry sh -c 'cd /app && npm run cli -- samples/*.pdf --out /tmp/out'`
- Point the browser tests at a running container: `E2E_BASE_URL=http://localhost:3001 npm run e2e`.

---

## Using the web app

1. **Upload.** Drag the three sample PDFs from [`samples/`](samples/) onto the drop zone, or use *choose files*. Then click **Generate entry**.
   - The sample has a text-layer commercial invoice plus a scanned packing list and a scanned house bill of lading.
   - The whole pipeline takes about 4 s on an Apple-silicon Mac.
   - Unsupported or unreadable files get an error banner with a "How to fix" hint.
2. **Summary strip.** Invoice number (normalized to the XSD pattern), importer, entry type and port, total entered value, line count, an **✓ XSD-valid** badge, and blocker/warning/info counts.
3. **Tabs:**

   | Tab | What it shows |
   |---|---|
   | **Action items** | Issues grouped by severity (blockers first), then by category. Each card has the issue code, the affected line, the detail, **What to do**, and evidence quotes with file and page. Ambiguous issues carry a **decision** (radio buttons, with the app's recommendation marked). Changing one regenerates the entry in well under a second, without re-running OCR. |
   | **Entry XML** | The highlighted XML with copy and **Download XML** (`<invoice>.entry.xml`), the XSD status, any schema errors, and a display-only preview of the SOAP `uploadEntry` envelope. |
   | **Shipment data** | The merged shipment: documents (type, text layer vs OCR, classification score, rendered page images), parties, transport, bills, containers (with the candidates considered), and lines. Every value has provenance and confidence badges (*extracted / derived / corrected / assumed / user*, plus *verify* for low-confidence OCR). |
   | **Valuation & duties** | Per-line computation trail (amount → deductions/additions such as assists → rounding), plus indicative duty, MPF and HMF with caveats. |
   | **Broker inputs** | Fields only the broker knows: importer tax ID, ultimate consignee tax ID, bond type, surety, payment type, entry type, port override, FIRMS code, entry and arrival dates, broker reference, and auto-apply remedies. Each field says which open issue it clears. **Regenerate entry** applies them. |

4. **Try it on the sample.**
   - **Decision:** in *Action items*, set the NB-H205 quantity decision to *Packed quantity 1,176 PCS*. Line 2 becomes 8,702 and the total drops from 27,439 to 27,261.
   - **Broker inputs:** enter importer tax ID `93-1234567`, bond `08 · Continuous`, surety `036` and FIRMS `W123`, then click **Regenerate entry**. The importer, bond and surety blockers disappear.
   - **What remains:** the fibre-content conflict stays a blocker until the broker gets the fibre spec or a lab test and explicitly picks a composition. An explicitly chosen decision drops its issue to a warning that records the choice, so the quantity issue becomes a warning once *packed* is chosen.

**Demo mode:** open `/?mock=1` to explore the UI with built-in sample data and no server round trip. Production builds can also set `VITE_API_MODE=mock`.

---

## CLI

```bash
npm run cli -- samples/*.pdf --out output
```
- **Output files:**
  - `output/<invoice-no>.entry.xml` is the NetCHB entry. For the sample, **[`output/KBAS-NB-26-0912.entry.xml`](output/KBAS-NB-26-0912.entry.xml) is the submission XML**.
  - `output/<invoice-no>.result.json` is the full `PipelineResult`: extracted documents, shipment, issues, classifications, valuations, XML, XSD result and timings.
- **Console:** prints a summary with issues by severity, the XSD status, the per-line values and the timings.
- **Exit code:** 0 even when the entry has blockers, because blockers are expected output. Non-zero only when the pipeline itself cannot run.
- **Broker inputs and decisions:**
  ```bash
  echo '{ "importerTaxId": "93-1234567", "bondType": "08", "suretyCode": "036", "locationOfGoods": "W123" }' > inputs.json
  npm run cli -- samples/*.pdf --out output --inputs inputs.json --decision quantity:inv0-line2=packed
  ```
  Decision keys are shown in `result.json` (`issues[].decision.key`), e.g. `quantity:<lineId>`, `composition:<lineId>`, `amount:<lineId>`, `grossWeight`, `hts:<lineId>`.

## HTTP API

| Method and path | Purpose |
|---|---|
| `GET /api/health` | `{ ok, tools: { tesseract, pdftoppm, pdftotext, xmllint }, missing[] }` |
| `POST /api/shipments` | multipart `files` (≤ 10, ≤ 25 MB each) + optional `brokerInputs` JSON field → `PipelineResult` |
| `POST /api/shipments/:id/regenerate` | `{ brokerInputs?, decisions? }` → `PipelineResult` (no re-OCR) |
| `GET /api/shipments/:id` | the stored result |
| `GET /api/shipments/:id/documents/:docId/pages/:page/image` | rendered page PNG (scanned pages) |

- **Errors:** every error is `{ error, detail?, hint? }`, e.g. 415 for an unsupported file and 503 with an install hint when Tesseract or poppler is missing.
- **Result storage:** results live in an in-memory LRU, so `/regenerate` works while the server process is up.
- **Contracts:** the types are in [`packages/shared/src/types.ts`](packages/shared/src/types.ts).

---

## Tests

| Command | What it covers | Count* |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` for shared, server, web and e2e | n/a |
| `cd server && npx vitest run` | **ingest** (real Tesseract and poppler on the sample: text layer vs OCR, skew, token recall, stamps) · **parse** (field-level accuracy against hand-authored ground truth, plus small synthetic layouts with other wording and column orders) · **reconcile** (rules with passing and firing cases, sample and scenario fixtures) · **reference** (HTS tree walk on committed USITC data, units, MID, fees, ports) · **netchb** (golden values, valuation table, element order, XSD validation) · **integration** (API via supertest through real OCR, golden values, regenerate, synthetic shipments) | ≈ 1,000 (ingest ≈ 70, parse ≈ 160, reconcile ≈ 190, reference ≈ 240, netchb ≈ 175, integration ≈ 180) |
| `cd web && npx vitest run` | React components and UI logic: issue grouping, decision → regenerate, broker form validation, XML view, API client errors | ≈ 70 |
| `npm run test:synthetic` | the synthetic-shipment generator: deterministic output, `expected.json` schema and arithmetic consistency | ≈ 45 |
| `npm run e2e` | Playwright + Chromium against the production build (`npm run build && npm start`, real OCR). See below | 7 |
| `npm test` | server + web | |
| `npm run test:all` | typecheck + server + web + synthetic | |
| `cd server && npx tsx test/integration/synthetic-report.ts` | pass/fail matrix of the pipeline on the three synthetic shipments against their `expected.json` (report only, no assertions) | |

\* Approximate counts at the time of writing; together about 1,120 unit and integration tests. Server tests need Tesseract and poppler. HTS lookups in tests are offline (committed data).

**E2E specs** (`e2e/`; about 15 s including the build):
- `sample-flow.spec.ts` covers the whole flow on `samples/*.pdf`:
  - upload, then a summary with invoice KBAS-NB-26-0912, $27,439 and ✓ XSD-valid
  - blockers for the NB-H205 quantity mismatch, the NB-H205 composition conflict and the missing importer ID, bond and surety
  - the XML contains `<total-entry-value>27439</total-entry-value>` and `<container-number>OPLU3041722</container-number>`
  - flipping the quantity decision to *packed* gives line value 8702 and a total of 27,261, while the untouched composition conflict stays a blocker
  - broker inputs, then regenerate: the importer, bond, surety and FIRMS issues are gone
  - **Download XML** gives a `.xml` file that contains the NetCHB `<entry>` root
- `errors.spec.ts`: a fake PDF shows an error banner with a hint; a `.docx` is rejected client-side; the API returns 415 with a hint.
- `health.spec.ts`: the header indicator shows *Server ready* and the tool versions; `/api/health` returns ok.
- `mock.spec.ts`: `?mock=1` renders a full result with zero `/api` requests.

The E2E server runs with the OCR cache disabled, so scans are really OCR'd on every run. Use `E2E_OCR_CACHE=1` to reuse the cache.

---

## Architecture

```
 upload (PDF / image)
   │
   ▼
 ingest      text layer?  yes → pdftotext -bbox-layout word boxes
             (per page)   no  → pdftoppm 300 dpi → sharp (grayscale, red/blue stamp suppression)
                                → tesseract --psm 11 TSV → deskew → lines;  stamp pass → "TELEX RELEASED"…
   │  DocumentLayout (words + boxes + confidence)
   ▼
 parse       classify doc type → generic primitives (label→value, header-driven tables, parties,
             numbers, dates, footnotes) → domain extractors (containers, bills, HS, incoterms,
             composition, FOC/NCV, assists) → constraint repair (qty×price=amount, ctns×per=total)
   │  ExtractedDocument[] (+ per-field confidence and evidence)
   ▼
 reconcile   merge into one Shipment with provenance → 27 cross-document rules → Issues + decisions
   │
   ▼
 classify    USITC HTS tree walk under the declared code + attribute rules (gender, knit/woven,
             fibre %) → 10-digit HTS + alternatives (e.g. other composition)
   │
   ▼
 assemble    valuation (incoterm, charges, assists, NCV) + broker inputs + decisions → EntryModel
   │
   ▼
 XML         exact XSD element order → xmllint-wasm validation against entry.xsd
   │
   ▼
 PipelineResult { xml, xsdValidation, issues, shipment, classifications, valuations, estimates, timings }
   └─ kept in memory: decisions and broker inputs regenerate from "assemble" on (no re-OCR)
```

| Module | Responsibility |
|---|---|
| [`server/src/ingest/`](server/src/ingest) | File → `DocumentLayout`. Magic-byte detection, text layer vs rasterize, sharp preprocessing and stamp suppression, Tesseract TSV, deskew, line grouping, stamp text, page pool, SHA-256 cache in `server/.cache/ocr` |
| [`server/src/parse/`](server/src/parse) | Layout → `ExtractedDocument`. Document classification, synonym vocabularies, label/table/party/number/date primitives, per-document parsers (invoice, packing list, B/L, air waybill), domain extractors, constraint repair |
| [`server/src/reconcile/`](server/src/reconcile) | Documents → `Shipment` + `Issue[]`. Cross-document merge with `Sourced` provenance, one rule per file in `rules/` (quantities, composition, line arithmetic, totals, weights, containers, origins, NCV, assists, incoterm charges, dates, parties, house/master bills, OCR verify, advisories) |
| [`server/src/reference/`](server/src/reference) | USITC HTS client and deterministic classifier, CBP Schedule D/K ports, ISO countries, US states, MID builder, MPF/HMF fees. Data is committed in `reference/data/` |
| [`server/src/netchb/`](server/src/netchb) | `Shipment` → `EntryModel` (valuation, parties, units, broker inputs, decisions) → XML → XSD validation, plus the SOAP preview. The vendored XSDs are in `netchb/schema/` |
| [`server/src/pipeline.ts`](server/src/pipeline.ts) | Orchestration, timings, in-memory store, regenerate |
| [`server/src/api/`](server/src/api) | Express routes, zod validation, error → HTTP mapping, serves `web/dist` in production |
| [`server/src/cli.ts`](server/src/cli.ts) | Headless runs that write `output/` |
| [`packages/shared/`](packages/shared) | TypeScript contracts shared by server and web (`types.ts`) |
| [`web/`](web) | React 19 + Vite UI: upload, summary, five result tabs, mock mode |

---

## How NetCHB was researched

NetCHB publishes its XML interface. The key pieces:

| Artifact | Link | Used for |
|---|---|---|
| Entry XSD | https://www.netchb.com/xml/entry/entry.xsd | The schema every generated entry is validated against. The root `<entry>` children are an ordered sequence; required header fields; patterns such as `invoiceNoType [A-Za-z0-9-]{1,17}` |
| Data types XSD | https://www.netchb.com/xml/data/data_type.xsd | Imported by entry.xsd: enumerations for bond type, payment type, entry type, mode of transport, units… |
| SOAP WSDL | https://www.netchb.com/main/services/entry/EntryUploadService?wsdl | `uploadEntry(username, password, entryXml)` and related operations. The app renders a display-only envelope |
| Upload responses | https://www.netchb.com/xml/entry/entryUploadResponse.html | `<accepted><entry-no>…` means the entry was loaded into NetCHB, *not* accepted by CBP. Rejections carry `cvc-…` validation errors |

- **Vendored copies:** all four are in [`server/src/netchb/schema/`](server/src/netchb/schema), so validation runs offline.
- **Element mapping:** [docs/NETCHB_NOTES.md](docs/NETCHB_NOTES.md) maps every emitted element to its source and separates what the XSD **confirms** from what is **inferred**.
- **Manual check:** `xmllint --noout --schema server/src/netchb/schema/entry.xsd output/KBAS-NB-26-0912.entry.xml`

---

## Design decisions

- **No LLM, deterministic extraction.**
  - **Why:** a broker signs off on every value, so each one must be explainable and reproducible. The same input gives the same XML, nothing leaves the machine, and there are no keys or usage costs.
  - **Accuracy:** OCR quality comes from engineering: Tesseract sparse mode (`--psm 11`) with word boxes, stamp-colour suppression, deskew, and layout-aware table extraction. Then constraints repair what OCR gets wrong: qty × price = amount, cartons × per-carton = total, column sums, and ISO 6346 container check digits (the sample's handwritten `OPLU3041722` is the only valid candidate).
- **Generic, not sample-specific.**
  - **How:** parsers use synonym vocabularies and layout rules, never sample positions or strings.
  - **Proof:** three synthetic shipments with deliberately different layouts check generalization ([samples/synthetic/README.md](samples/synthetic/README.md)): German air/EUR/FCA, a scanned Chinese combined invoice-and-packing-list under DDP, and a messy US-style FOB invoice with a bad container check digit.
- **Decision policy** (from [PLAN.md §1](PLAN.md)):
  1. When documents conflict, **default to the commercial invoice**, the seller-certified document. The exception is when arithmetic or physical evidence proves it wrong.
  2. **Never invent data.** Anything only the broker can know (importer number, bond, surety, FIRMS) becomes a broker input. Missing optional elements are omitted and listed.
  3. **Be conservative on value.** Don't under-declare when it is ambiguous, because undervaluation is the penalty risk.
  4. Every correction, assumption, OCR repair and conflict becomes an **issue** with evidence, a severity and an action. Ambiguous ones expose a **decision** the broker can flip, which regenerates the XML.
  5. **Surface OCR confidence.** Low-confidence or repaired fields are badged and listed as "verify against original".
- **One contract.** `packages/shared/src/types.ts` is the single source of truth for both server and UI. `EntryModel` mirrors the XSD subset, and the XML builder emits elements in the exact XSD order.
- **Regeneration is cheap.** OCR, parsing, reconciliation and classification are kept per shipment. Decisions and broker inputs re-run only valuation, assembly and XML generation.

---

## Limitations and known gaps

- **No NetCHB sandbox round-trip.** The XML passes `entry.xsd`, but NetCHB business rules (importer on file, bond on file, ACE edits) were not tested. Some field semantics are inferred: see [NETCHB_NOTES §5](docs/NETCHB_NOTES.md#5-inferred-unverified).
- **Broker-only data.** The documents cannot provide the importer of record number, bond, surety or FIRMS code. They stay blockers or warnings until the broker enters them. The arrival date is usually an ETA, and the entry date defaults to it.
- **Chapter 99 is not computed.** Section 301/232 and other Chapter 99 measures, AD/CVD and PGA (FDA, CPSC…) are not generated. The `auto-apply-remedies` flag (on by default, with a warning) delegates single-tariff lines to NetCHB. Duty, MPF and HMF figures are indicative estimates, with fee parameters in `server/src/reference/data/fees.json`.
- **Classification is rule-based.** It starts from the declared HS code. With no declared code it searches USITC and returns low-confidence candidates as a blocker decision. It does not replace a licensed broker's classification.
  - Headings that aren't in the committed data are fetched from the USITC API on first use.
  - Offline, such a code is passed through unverified with a low-confidence warning.
- **Reference data gaps.**
  - The Schedule K foreign lading port comes from curated data and is omitted when unknown.
  - Exchange rates are not looked up, so non-USD totals need a broker rate.
  - The MID is built by CBP rules and flagged for verification when the address is ambiguous.
- **One tariff per line.** There are no special program indicators (GSP/FTA). Line-level cargo release parties are not generated, and the consignee (CN) party is omitted because the XSD requires a tax ID for it.
- **OCR limits.**
  - Handwriting, strikethroughs and stamps over text are the weak spots. They are handled with candidates, check digits and "verify" warnings, not certainty.
  - OCR runs in English only (`eng`). Labels in other languages work only where the vocabulary covers them.
  - Debian's Tesseract 5.3 may differ slightly from 5.5.1.
- **Document types.** Supported: commercial invoices, packing lists, combined invoice + packing list, house/master bills of lading and air waybills. Arrival notices are recognized but not mined.
- **Not production infrastructure.**
  - Results live in memory, so a server restart drops regenerate state.
  - There is no authentication and no database. Uploaded PDFs are written to a temp dir only while poppler reads them. Layouts and rendered pages are cached on disk under `server/.cache/ocr`, keyed by SHA-256.

---

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3001` | API (and, after `npm run build`, web) port |
| `TESSERACT_PATH`, `PDFTOPPM_PATH`, `PDFTOTEXT_PATH` | from `PATH` | explicit tool locations |
| `INGEST_CACHE` | on | `0` disables the OCR layout cache |
| `INGEST_CACHE_DIR` | `server/.cache/ocr` | OCR cache and rendered page images |
| `INGEST_CONCURRENCY` | CPUs / 2 | parallel OCR pages |
| `HTS_OFFLINE` | off | `1` never calls the USITC API (committed data only) |
| `HTS_CACHE_DIR` | `server/.cache/hts` | runtime cache for fetched HTS headings |
| `VITE_API_MODE` | `http` | `mock` builds the UI against the demo data (also `?mock=1`) |
| `E2E_BASE_URL` | unset | run the Playwright suite against an existing deployment instead of starting one |
| `E2E_OCR_CACHE` | unset | `1` lets the E2E server reuse its OCR cache (`e2e/.cache`) |

---

## Project layout

```
.
├── packages/shared/src/types.ts   contracts shared by server and web
├── server/
│   ├── src/
│   │   ├── ingest/                PDF text layer, rasterize, preprocess, Tesseract, deskew
│   │   ├── parse/                 doc classification, primitives, per-doc parsers, domain extractors
│   │   ├── reconcile/             merge + rules/ (one rule per file) → Shipment + Issues
│   │   ├── reference/             HTS client/classifier, ports, countries, MID, fees, data/
│   │   ├── netchb/                valuation, entry model, XML, XSD validation, schema/
│   │   ├── api/                   Express app + zod schemas
│   │   ├── pipeline.ts            orchestration + regenerate store
│   │   ├── cli.ts                 headless runs
│   │   └── index.ts               server entry (PORT, serves web/dist)
│   └── test/                      unit, golden, integration (fixtures/, golden/sample-expected.json)
├── web/src/                       React UI (App, components/, hooks/, api/ incl. mock, lib/)
├── e2e/                           Playwright config + specs (production build, real OCR)
├── samples/                       the reference shipment (3 PDFs)
│   └── synthetic/                 s1–s3 generalization shipments + expected.json
├── scripts/                       synthetic-shipment generator (make-synthetic.ts, synthetic/)
├── output/                        CLI output: KBAS-NB-26-0912.entry.xml / .result.json
├── docs/                          NETCHB_NOTES.md, WRITEUP.md
├── PLAN.md                        build plan, research notes, sample acceptance criteria
├── Dockerfile, .dockerignore
└── package.json                   npm workspaces + root scripts
```
