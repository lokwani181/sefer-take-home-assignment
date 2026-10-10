# NetCHB entry XML: notes (T5)

How the app produces a NetCHB-ready entry XML, what each element is filled with, and which semantics are
**confirmed by the XSD** versus **inferred (unverified)**. Code: `server/src/netchb/`.

## 1. How the service was found

| Artifact | URL | Vendored copy |
|---|---|---|
| Entry XSD (root `<entry>`, ns `http://www.netchb.com/xml/entry`) | https://www.netchb.com/xml/entry/entry.xsd | `server/src/netchb/schema/entry.xsd` |
| Data types XSD (ns `http://www.netchb.com/xml/data`) | https://www.netchb.com/xml/data/data_type.xsd | `server/src/netchb/schema/data_type.xsd` (imported as `schemaLocation="data_type.xsd"`) |
| SOAP WSDL | https://www.netchb.com/main/services/entry/EntryUploadService?wsdl | `server/src/netchb/schema/EntryUploadService.wsdl` |
| Upload response docs | https://www.netchb.com/xml/entry/entryUploadResponse.html | `server/src/netchb/schema/entryUploadResponse.html` |

- **WSDL:** `EntryUploadWebService`, binding `rpc`/`literal`, namespace `http://www.netchb.com/`, endpoint
  `https://www.netchb.com:443/main/services/entry/EntryUploadService`. Operations: `uploadEntry(username,
  password, entryXml)`, `amendEntry`, `queryEntryStatus`, `queryType86EntryStatus`, `updateBol`, `deleteEntry`,
  `deleteType86EntryByMawb`. All parts are `xsd:string`, so the entry XML travels as an escaped string.
  `buildUploadEnvelope(xml)` renders a SOAP 1.1 `uploadEntry` preview with `{username}`/`{password}`
  placeholders. It is display-only and never sent.
- **Responses:** `<accepted><entry-no>ABC-0000001-1</entry-no></accepted>` means the entry was *loaded into
  NetCHB*, not accepted by CBP. Warnings come back as `<warning>`/`<cbp-warnings>`. Rejections come back as
  `<rejected>…</rejected>`, including `<validation-error>Line N: cvc-…</validation-error>` for schema errors and
  "importer not found" when the importer tax ID is not in the user's importer table.
- **Validation:** `validateEntryXml` runs xmllint-wasm with `entry.xsd` as the schema and `data_type.xsd`
  preloaded under that exact file name. If the wasm worker fails, it falls back to the system
  `xmllint --noout --schema`. Errors come back as `Line N: message`.

## 2. Structure and ordering (confirmed by XSD)

- The root `<entry>` children form an **`xsd:sequence`**, so order matters: `entry-no`, `precalculated`,
  `remove-ddp`, `transmit`, `transmit-3461`, `via-ace`, `external-reference-number`, `assign-to`,
  `auto-apply-remedies`, …, `header`, `consolidated-entries`, `manifest`, `containers`,
  `ace-cargo-release-parties`, `invoices`, `email-notifications`, `disclaim-pgas`.
  Test: a document with `<manifest>` before `<header>` fails validation.
- `headerType`, `invoiceType`, `lineItemType`, `tariffType`, `containerType`, `entityType` and the
  bill-of-lading element are **`xsd:all`**, so child order is free. We still emit the XSD declaration order.
- `manifestType` and `address-components` are sequences.
- **Never emitted:** `<transmit/>` and `<transmit-3461/>`, so the app never auto-files. `<precalculated/>` is not
  emitted either, which leaves duties and fees to NetCHB.

## 3. Element-by-element mapping

"Source" names the `Shipment` / `BrokerInputs` field the value comes from (see `packages/shared/src/types.ts`).

### Root
| Element | XSD type / rule | Value | Source |
|---|---|---|---|
| `entry-no` | choice `user-specified{filer-code [A-Za-z0-9]{3}, entry-no \d{7,8}}` \| `system-generated` | `<system-generated/>` | `EntryModel.entryNo` (`user` kind supported by the builder) |
| `auto-apply-remedies` | empty flag | present unless `brokerInputs.autoApplyRemedies === false` | broker input (default on) |

### Header (`headerType`, xsd:all)
| Element | Rule | Value / source |
|---|---|---|
| `importer-tax-id` | `taxIdType` `\d{2}-\d{7}[\dA-Za-z]?[\dA-Za-z]?` \| `\d{6}-\d{5}` \| `\d{3}-\d{2}-\d{4}`; XSD-optional, "required unless entry type 86" | `brokerInputs.importerTaxId`, else a valid `importer.taxId` from the documents. Missing gives `MISSING_IMPORTER_ID` (blocker) |
| `importer-name` | untyped | `brokerInputs.importerName` ?? `shipment.importer.name` |
| `ultimate-consignee{tax-id, consignee-name}` | xsd:all | consignee = `shipment.ultimateConsignee` ?? importer. tax-id = broker input ?? consignee's own ?? importer's (only when the consignee is the importer). If it differs and has no ID: `MISSING_CONSIGNEE_ID` |
| `processing-port`, `entry-port` | `portType \d{4}`, **required** | `brokerInputs.entryPort` ?? `lookups.usPortCode(transport.portOfUnlading)`. Unknown gives `PORT_UNKNOWN` (blocker), the element is omitted and the XML fails XSD |
| `entry-date` | `xsd:date`, **required** | `brokerInputs.entryDate` ?? arrival date ?? generation date (`ENTRY_DATE_DEFAULTED`) |
| `entry-type` | `entryType` enum, **required** | `brokerInputs.entryType` ?? `01` |
| `bond-type` | `bondType` enum `00/08/09` | broker input. Missing gives `MISSING_BOND` (blocker) |
| `payment-type` | `paymentType` enum | broker input (optional) |
| `charges` | `xsd:long` | round(Σ itemized international freight + insurance). Omitted if none, or if any invoice is non-USD without a rate |
| `gross-weight` | `xsd:long` | round(`shipment.grossWeightKg`) (transport document). Decision `grossWeight=packing_list` switches to Σ PL line gross weights |
| `total-entry-value` | `xsd:long ≥ 1` | Σ tariff values (USD). Omitted if a foreign-currency invoice has no rate |
| `description` | token ≤ 70 | chapter label of the lines' HTS numbers (61/62 → `WEARING APPAREL`), else the first line description |
| `surety-code` | ≤ 3 chars | broker input. `MISSING_SURETY` (blocker) when the bond is missing or is 08/09 |
| `state-destination` | `usStateType` enum | `transport.destinationState` ?? ship-to state ?? consignee state |
| `vessel-name` | token ≤ 20 | `transport.vessel` (cut at a word) |
| `mode-transportation` | `modeTransportType` enum | ocean 10/11, rail 20/21, truck 30/31, air 40/41 (non-containerized/containerized) |
| `unlading-port` | `\d{4}` | Schedule D lookup of the port of discharge (falls back to the entry port) |
| `import-date`, `arrival-date` | `xsd:date` | `brokerInputs.arrivalDate` ?? `transport.arrivalDate` |
| `carrier-code` | `carrierCodeType` 2 or 4 word chars | ocean: master-bill SCAC (vessel operator, **not** the NVOCC house SCAC); air: IATA code |
| `broker-reference-no` | token ≤ 9 | `brokerInputs.brokerReference` |
| `customer-reference-no` | token ≤ 50 | first PO number |
| `voyage-no` | token ≤ 5 | voyage, or the flight number without its airline prefix for air; omitted (`FIELD_OMITTED:header.voyageNo` info) if longer |
| `location-of-goods` | token ≤ 4 | broker input (FIRMS). Missing gives `MISSING_LOCATION_OF_GOODS` (warning) |

### Manifest (`manifestType`, sequence)
| Element | Rule | Value |
|---|---|---|
| `bill-of-lading` (one per `shipment.bills[]`) | xsd:all | |
| `master-scac` / `house-scac` | `carrierCodeType` | `BillRef.scac` |
| `master-bill` / `house-bill` | `billNoType [\dA-Za-z]{0,50}` | `BillRef.number`: SCAC prefix stripped if present, non-alphanumerics removed (`BILL_NO_NORMALIZED` info) |
| `quantity` | `xsd:integer ≥ 0`, **required** | `shipment.packages.count` (else Σ line cartons; else 0 plus a `MANIFEST_QUANTITY_UNKNOWN` blocker) |
| `unit` | token ≤ 5, **required** | normalized package unit: CARTONS→CTN, PACKAGES→PKG, PALLETS→PLT, PIECES→PCS, BAGS→BAG, ROLLS→RL, BOXES→BX, CASES→CAS, CRATES→CRT, DRUMS→DR, BALES→BL, BUNDLES→BDL, SKIDS→SKD |

### Containers (`containerType`, xsd:all)
| Element | Rule | Value |
|---|---|---|
| `container-number` | string | `Container.number` (check-digit-selected by reconcile) |
| `container-size` | enum `20 ft`, `20 ft HC`, `40 ft`, `40 ft HC`, `45 ft`, `45 ft HC`, `53 ft`, `53 ft HC` | from `sizeType` (`20GP`, `40HC`, ISO 6346 `22G1`, `45G1`…); omitted if unrecognised |
| `container-type` | enum `Dry`, `Flat Rack`, `Headload`, `Open`, `Reefer`, `LCL`, `Tank` | GP/DV/HC → Dry, RF/RH → Reefer, OT → Open, FR → Flat Rack, TK → Tank |
| `seal-numbers` | string | seals joined with `, ` |

### ACE cargo release parties (header level, max 5 `entity`)
- `entity-code` enum: `SE` seller, `BY` buyer, `ST` ship-to, `LG` stuffing location, `CS` consolidator,
  `MF` manufacturer, `CN` consignee.
- `entity-name` is a token of at most 35 characters. Legal suffixes are abbreviated first (LIMITED→LTD, JOINT
  STOCK COMPANY→JSC…), then the name is cut at a word.
- `entity-information` is a choice of `entity-id` (DUNS, FIRMS for ST, tax ID for CN), `entity-address`
  (`address-components` 1–6 × {`component-type`, `address-information` ≤ 35}, `city` ≤ 35,
  `state-province-code` ≤ 3, `postal-code` ≤ 15, `country`), or `selling-party-mid` (SE only).
- We never know party IDs, so parties are sent with `entity-address`. Each address line uses component type
  `15` (unstructured street address), chunked to 35 characters. **CN is never emitted** because the XSD
  requires a tax-ID `entity-id` for it. A seller without a complete address falls back to `selling-party-mid`.
- Selection: SE, BY, ST (if different from BY) and CS come first, then MF entries fill any remaining room.
  Output order is SE, BY, ST, MF…, CS. Parties without street, city and country are not sent and are listed
  in `FIELD_OMITTED:cargoReleaseParties` (the XML stays valid; this is not a schema failure).

### Invoices (`invoiceType`, xsd:all)
| Element | Rule | Value |
|---|---|---|
| `invoice-no` | `invoiceNoType [A-Za-z\d-]{1,17}`, **required** | invalid characters → `-`, repeats collapsed, edges trimmed, cut to 17 (`INVOICE_NO_NORMALIZED`), e.g. `KBAS/NB/26-0912` → `KBAS-NB-26-0912` |
| `related-party` | empty flag | emitted only when `invoice.relatedParty` is true |
| `foreign-currency{currency-code [A-Z]{3}, exchange-rate float>0, currency-country-code [A-Z]{2}}` | xsd:all | for non-USD invoices: currency code; rate only if the broker supplied one (`exchangeRates` extension); country = first two letters of the ISO 4217 code (GBP → GB). Shared currencies (EUR, XOF, XAF, XCD, XPF): the first of the export country, seller, manufacturers and line origins that uses the currency (EUR from a German seller → DE); omitted only when none does |
| `line-items/line-item` | one per invoice line, invoice order | |

### Line items (`lineItemType`, xsd:all)
| Element | Rule | Value |
|---|---|---|
| `export-date` | `xsd:date` | `transport.exportDate` (on-board date) |
| `country-origin` | `[A-Za-z]{2}`, **required** | `line.countryOfOrigin` (line-level origin, e.g. BD samples) |
| `manufacturer-id` | ≤ 15 | `lookups.buildMid(manufacturer)`. The manufacturer is the line's own, else the shipment manufacturer in the origin country, **never the seller**. `MID_VERIFY` when ambiguous, address incomplete, or none found |
| `related-party` | `Y`/`N` | from `invoice.relatedParty` (reconcile flags when assumed) |
| `tariffs/tariff` | 1..n | one tariff per line (below) |
| `country-export` | 2 letters | `shipment.countryOfExport` (reconcile): the port of lading's country (a printed country name, else `lookups.portCountry`: Schedule K sea-port names and a verified table of major cargo airports by IATA code, so "FRANKFURT/MAIN (FRA)" → DE), else the shipper on the B/L or AWB, else the invoice seller, else the packing-list manufacturer, else the invoice header origin |
| `lading-port` | `foreignPortType \d{5}` (Schedule K) | vessel (and unknown) mode only: `lookups.foreignPortCode(portOfLading)`, omitted with `LADING_PORT_UNKNOWN` (warning) when not verifiable. Air/truck/rail: always omitted with `LADING_PORT_UNKNOWN` (info), see §5 |
| `gross-weight` | `xsd:long ≥ 0` | packing-list line gross kg (rounded, min 1). Otherwise the unallocated header weight is prorated by value (`WEIGHT_PRORATED`) |
| `commercial-description` | `xsd:string` (no XSD limit) | invoice description + fibre content, upper case, ≤ 70 (see §5) |
| `invoice-quantity` | double | invoice quantity (or packed quantity under the `packed` decision) |
| `invoice-unit-value` | choice `user-specified` (double) \| `system-auto-calculate` | invoice unit price (NCV lines: stated value ÷ qty). `system-auto-calculate` only when unknown |
| `po-number` | string | line PO ?? first invoice PO |
| `category-no` | `\d{0,3}` | textile category from the HTS description, e.g. `338` |

### Tariff (`tariffType`, xsd:all)
| Element | Rule | Value |
|---|---|---|
| `tariff-no` | `\d{5,10}` | 10-digit HTS from classification (or the alternative-composition classification, or a broker `hts:<lineId>` override) |
| `value` | `dollarAmountType` (decimal, 2 fraction digits) | **whole** entered value from the valuation (`Math.round` at the end) |
| `quantity1/2` + `unit-of-measure1/2` | decimal ≤ 2 fraction digits; `unitOfMeasureType` enum | from the HTS units: `DOZ` = pieces ÷ 12, `NO`/`PCS` = pieces, `DPR` = pairs ÷ 12, `KG` = PL net weight (fallback: gross × 0.9 with `WEIGHT_PRORATED`) |

## 4. Valuation rules (`valuation.ts`)
1. Start from the line amount after decisions (`computed`/`printed` amount, `invoice`/`packed` quantity). NCV
   lines use the stated customs value.
2. If line prices are **not** already net (`linesAreFob=false`) and the incoterm puts the costs in the price,
   deduct the itemized non-dutiable charges, prorated by value over the commercial lines:
   C-terms (CFR/CPT/CIF/CIP) freight, insurance and US inland freight; D-terms (DAP/DPU) also destination
   handling; DDP also US duty. E/F terms and unknown terms: nothing (conservative).
3. If charges are itemized **on top** of the line prices (`linesAreFob=true`), add the dutiable ones: packing and
   selling commissions (not buying commissions).
4. Add assists (19 USC 1401a(h)): 100% to the line that carries the assist, split by value when several do.
5. Round only at the end. The trail ends with a "Rounded to whole units" step, so the steps sum to the
   entered value.

## 5. Inferred (unverified)
- **Foreign currency.** The XSD annotation says that when `currency-code` + `currency-country-code` are given
  without `exchange-rate`, NetCHB auto-populates the rate from the currency and the **export date** (the
  annotation confirms this part). It is **inferred** that tariff `value` is then read in the invoice currency
  and converted by NetCHB. We send values in the invoice currency, emit `CURRENCY_CONVERSION` (warning), and
  leave `total-entry-value`/`charges` out unless the broker supplied a rate.
- `charges` = international freight + insurance (CBP Form 7501 "charges" semantics). The XSD only says
  `xsd:long`.
- **Foreign port of lading for air shipments (verified, not inferred).** Schedule K (USACE "Classification of
  Foreign Ports by Geographic Trade Area and Country") lists sea ports only; there are no airport codes in it
  (checked against the 2nd-quarter 2026 file in `server/src/reference/data/schedule-k.json`, e.g. no Frankfurt).
  The CBP Form 7501 instructions (rev. 02/26, Block 19 "Foreign Port of Lading",
  https://www.cbp.gov/sites/default/files/2026-02/cbp_form_7501.pdf) say to record the Schedule K code "for
  merchandise arriving in the U.S. by vessel" and: "When merchandise is transported by a mode of
  transportation other than vessel, leave blank." So for air (and truck/rail) `lading-port` is never emitted,
  even when a sea port shares the airport city's name, and `LADING_PORT_UNKNOWN` is an **info** telling the
  broker to leave it blank (unless the goods actually crossed on a vessel, e.g. sea-air). For ocean ports
  missing from Schedule K the same instructions say to use the "all other ports" code of the lading country,
  which the warning's action now says.
- The airport table (`server/src/reference/airports.ts`) is used only to derive the export **country** of an
  air shipment. Each IATA code/country pair was checked against the OurAirports data set
  (https://davidmegginson.github.io/ourairports-data/airports.csv); BSL was left out because EuroAirport
  Basel-Mulhouse is in France. IATA codes are matched before ISO alpha-3 country codes ("FRA" is Frankfurt,
  not France).
- `import-date` = arrival date. Per CBP 7501 practice, not stated in the XSD.
- `commercial-description` is capped at 70 characters (ACE line description width). The XSD has no limit.
- Header-level `ace-cargo-release-parties` sent **without** `<certify-cargo-release-via-ace/>`. The annotation
  says they are used when that tag is present; we assume NetCHB stores them for the broker either way.
- The `entity-address` `component-type 15` (unstructured street address) is accepted for every address line.
- `auto-apply-remedies` applies Chapter 99 remedies only to lines with a single tariff (the annotation says so).
  The app emits one tariff per line, so all lines qualify. Which remedies NetCHB finds is unknown, hence
  `CHAPTER_99_NOT_COMPUTED`.
- `unit` in the manifest: the XSD only limits it to 5 characters. The codes above (CTN, PKG, PLT…) follow
  common AMS/X12 practice.
- Passing XSD validation does **not** make an entry fileable. NetCHB also checks business rules (importer in
  the importer table, bond on file, ACE edits).

## 6. Enumerations (from the XSD)
| Type | Values |
|---|---|
| `bondType` | `00` no bond required, `08` continuous, `09` single transaction |
| `paymentType` | `''`, `1`, `2`, `3`, `5`, `6`, `7`, `8`. The XSD gives no meanings; they are the CBP ACE payment-type indicators (single payment vs daily/periodic-monthly statements). *Inferred*: confirm against the NetCHB/CATAIR code list |
| `entryType` | 01–12, 20–26, 30–34, 38, 40–46, 50–52, 60–66, 86 |
| `modeTransportType` | 10, 11, 12, 20, 21, 30–34, 40, 41, 50, 60, 70 |
| `container-size` | 20 ft, 20 ft HC, 40 ft, 40 ft HC, 45 ft, 45 ft HC, 53 ft, 53 ft HC |
| `container-type` | Dry, Flat Rack, Headload, Open, Reefer, LCL, Tank |
| `entity-code` | SE, BY, ST, LG, CS, MF, CN |
| `component-type` | 01 street number, 02 street name, 05 PO box, 12 building name, 13 apartment, 14 suite, 15 unstructured street address, 28 association, 30 pier, 31 wing, 32 floor, 35 room, 37 unit, 57 cross street, AK building number |
| related party | invoice: empty flag `<related-party/>`; line item: `Y` / `N` |
| `unitOfMeasureType` | CATAIR Appendix C subset (DOZ, KG, NO, PCS, PRS, DPR, M2, L, X …; full list in `enums.ts`) |
| `weight-unit` (container) | KG, LB |

## 7. Issues emitted by assembly
`HTS_RESOLVED` (info, per line) · `HTS_LOW_CONFIDENCE` (warning, decision `hts:<lineId>`) · `HTS_NOT_DECLARED`
(blocker when basis is `search`, decision `hts:<lineId>`) · `CHAPTER_MISMATCH` · `MISSING_IMPORTER_ID` ·
`MISSING_CONSIGNEE_ID` · `MISSING_BOND` · `MISSING_SURETY` · `MISSING_LOCATION_OF_GOODS` · `MID_VERIFY` ·
`PORT_UNKNOWN` · `LADING_PORT_UNKNOWN` · `INVOICE_NO_NORMALIZED` · `BILL_NO_NORMALIZED` ·
`CHAPTER_99_NOT_COMPUTED` · `AUTO_REMEDIES` · `CURRENCY_CONVERSION` · `WEIGHT_PRORATED` ·
`ENTRY_DATE_DEFAULTED` · `BROKER_INPUT_INVALID:<field>` (a broker input that fails the XSD rules and has no
`MISSING_*` code) · `MANIFEST_QUANTITY_UNKNOWN` · `FIELD_OMITTED:<field>`, a value deliberately left out so the
XML stays valid (`header.voyageNo` longer than the XSD allows; `cargoReleaseParties` without a full address) ·
`XSD_INVALID:<field>` (blocker), only for a REQUIRED value that is missing and therefore makes the XML fail
entry.xsd (`invoices[i].invoiceNo`, `…lineItems[j].countryOrigin`). The pipeline adds a plain `XSD_INVALID`
blocker whenever the generated XML actually fails schema validation; a valid XML never carries `XSD_INVALID`.

**Broker decisions.** Issues that carry a decision (`QTY_MISMATCH`, `COMPOSITION_CONFLICT`,
`LINE_AMOUNT_MISMATCH`, `GROSS_WEIGHT_MISMATCH`, …) keep their policy-default severity until the broker picks
an option EXPLICITLY (the key is present in `brokerInputs.decisions` with an accepted value, including the
default one). Then a `blocker` becomes a `warning` (warnings/info keep their severity), the decision stays on the
issue so it can be changed back, and the detail ends with "Resolved by broker choice: <option label>. Keep
supporting documents (e.g. credit note / fibre test report)." A rejected value (not one of the options) resolves
nothing. Clients must therefore send only the keys the broker actually chose: echoing every default back would
mark every decision as resolved.

Broker inputs clear the matching `MISSING_*` issues. Inputs that fail the XSD pattern or enum are not used, and
they keep or raise a **blocker** that quotes the rejected value. Evidence `page: 0` means the page is unknown,
because `Shipment` provenance carries the docId but no page.

## 8. Known gaps
- No NetCHB sandbox round-trip, so business-rule rejections can't be tested.
- Schedule K (foreign lading port) depends on the reference data. When an ocean port is not found, the element
  is omitted (the broker picks the code, or the country's "all other ports" code). Air/truck/rail never get one
  (§5).
- No Chapter 99 / ADD/CVD / PGA (FDA, CPSC…) data is generated. NetCHB's `auto-apply-remedies` and the
  broker handle them.
- One tariff per line, with no special program indicators (GSP/FTA). Line-level cargo release parties and
  `aii-*` elements are not generated.
- Multiple bills of lading all get the total package count, because the shipment does not carry per-bill counts.
- A discount printed on the invoice is deducted only when the printed total equals goods minus the discount (sets `ShipmentInvoice.discountsDeducted`); it is apportioned to lines by value and shown in the valuation trail. Retroactive rebates and "other" charges are neither deducted nor added. Foreign inland freight stays in value. Known gap: there is no broker decision yet to switch a deducted discount back to "not granted at importation".
- Exchange rates are not looked up. Without a broker-supplied rate, totals and estimates exclude non-USD
  invoices.
