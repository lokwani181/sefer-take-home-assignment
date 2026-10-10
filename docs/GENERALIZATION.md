# Generalization run: blind shipments s4 and s5

This file records how the pipeline did on two shipments it had never seen, what was fixed, and
what is still open. The pipeline was run on `samples/synthetic/s4-kr-fob-multi-container` and
`samples/synthetic/s5-id-footwear-cfr` **before any code change**, with a cold OCR cache
(`INGEST_CACHE_DIR` pointed at an empty temp directory). That first run is the honest "unseen
documents" number. Every later number comes after fixes that were driven by these two shipments,
so s4 and s5 are no longer blind.

How it was measured:

```bash
cd server
INGEST_CACHE_DIR=$(mktemp -d) SYNTH_RESULTS_DIR=/tmp/out npx tsx test/integration/synthetic-report.ts --json /tmp/out/checks.json
npx vitest run test/integration/synthetic.test.ts    # the same checks, asserted (cold cache, offline HTS)
```

The checks are the ones in `server/test/integration/synthetic-report.ts`:
- `docs`: document type and source.
- `header`: invoice number and date, currency, incoterm, the parties, transport mode and port, containers, bills, gross weight.
- `lines`: line count and total entered value.
- `per-line`: value, origin, HS-6, quantity, unit price, printed amount and description for each line.
- `issuesInclude` and `issuesExclude`: issues that must and must not be raised.
- `xsd`: XSD validity.

## 1. Pre-fix result (cold cache, verbatim)

s1–s3 passed fully (69/69, 72/72, 63/63). The real sample (`samples/*.pdf`) was XSD-valid and
totalled USD 27,439. The two blind shipments:

```
=== s4-kr-fob-multi-container: 38/76 pass (3318 ms)
  pass  docs: 6/6
  FAIL  header: 11/17
        ✗ invoiceNumber: expected "MRH-260914-07", got ""
        ✗ invoiceNumberNormalized: expected "MRH-260914-07", got ""
        ✗ invoiceDate: expected "2026-09-14", got undefined
        ✗ buyerName: expected "GOLDLINE HOUSEWARES CORP.", got undefined
        ✗ ultimateConsigneeName: expected "GOLDLINE HOUSEWARES CORP.", got "TO THE ORDER OF"
        ✗ grossWeightKg: expected 26078.4, got 10912
  FAIL  lines: 0/2
        ✗ line count: expected 4, got 0
        ✗ totalEnteredValue: expected 171355, got 0
  FAIL  line 1: 0/7   (value, origin, hs6, quantity, unitPrice, printedAmount, description all undefined)
  FAIL  line 2: 0/7   (same)
  FAIL  line 3: 0/7   (same)
  FAIL  line 4: 0/7   (same)
  FAIL  issuesExclude: 21/22
        ✗ QTY_MISMATCH: expected [], got ["QTY_MISMATCH:pl:doc-bcb7619b72a2:line1", … "line5"]
  FAIL  xsd: 0/1
        ✗ XSD valid: expected true, got false
  issues: MISSING_FIELD:invoiceNumber[b] MISSING_FIELD:lines[b] MISSING_IMPORTER_ID[b] MISSING_BOND[b] MISSING_SURETY[b]
          XSD_INVALID:invoices[0].invoiceNo[b] XSD_INVALID[b] QTY_MISMATCH:pl:…:line1..5[w] MISSING_FIELD:arrivalDate[w]
          OCR_VERIFY:doc-277146b35afc[w] MISSING_CONSIGNEE_ID[w] MISSING_LOCATION_OF_GOODS[w] FIELD_OMITTED:cargoReleaseParties[w]
          CHAPTER_99_NOT_COMPUTED[w] IMPORTER_ASSUMED[i] ULTIMATE_CONSIGNEE_ASSUMED[i] RELATED_PARTY_ASSUMED[i] ISF[i]
          ENTRY_DATE_DEFAULTED[i] AUTO_REMEDIES[i]

=== s5-id-footwear-cfr: 53/72 pass (1216 ms)
  pass  docs: 6/6
  FAIL  header: 12/19
        ✗ invoiceNumber: expected "SB-2609-0233", got ""
        ✗ invoiceNumberNormalized: expected "SB-2609-0233", got ""
        ✗ invoiceDate: expected "2026-09-11", got undefined
        ✗ incoterm.place: expected "Savannah, GA", got "SAVANNAH, terms GA, USA Payment T/T 60 days from B/L date Port TANJUNG of loading PRIOK, JAKARTA Transhipment SINGAPORE"
        ✗ buyerName / importerName / ultimateConsigneeName: expected "OLENTANGY RETAIL GROUP, INC.", got "OLENTANGY 1850 Polaris Parkway RETAIL GROUP, INC. OLENTANGY Distribution Center, RETAIL 4100 Alum GROUP, Creek Drive, INC. PT Jl. Raya SEPATU Serang Km. NUSANTARA 12,5, Desa Bitung ABADI Jaya, Kec."
  FAIL  lines: 1/2
        ✗ totalEnteredValue: expected 109950, got 114300
  FAIL  line 1: 6/7   ✗ value: expected 51425, got 53460
  FAIL  line 2: 4/7   ✗ value: expected 37054, got 38520   ✗ origin: expected "VN", got "ID"
                      ✗ descriptionContains: expected "LEATHER LOAFER", got "WOMEN'S Upper: full-grain LEATHER cow leather; LOAFER outsole: rubber; * does not"
  FAIL  line 3: 5/7   ✗ value: expected 21471, got 22320
                      ✗ descriptionContains: expected "SLIDE SANDAL", got "UNISEX Strap: PVC POOL (over 90% SLIDE plastics); SANDAL footbed: EVA; outsole:"
  FAIL  issuesInclude: 1/4
        ✗ NON_DUTIABLE_CHARGES, ORIGIN_DIFFERS, SELLER_NOT_MANUFACTURER: expected true, got false
  FAIL  issuesExclude: 18/19
        ✗ CHARGES_NOT_ITEMIZED: expected [], got ["CHARGES_NOT_ITEMIZED"]
  FAIL  xsd: 0/1
        ✗ XSD valid: expected true, got false
  issues: CHARGES_NOT_ITEMIZED[b] MISSING_FIELD:invoiceNumber[b] MISSING_IMPORTER_ID[b] MISSING_BOND[b] MISSING_SURETY[b]
          XSD_INVALID:invoices[0].invoiceNo[b] XSD_INVALID[b] MISSING_FIELD:arrivalDate[w] OCR_VERIFY:doc-244ca14ad2e6[w]
          MISSING_LOCATION_OF_GOODS[w] FIELD_OMITTED:cargoReleaseParties[w] CHAPTER_99_NOT_COMPUTED[w] HOUSE_MASTER_BILL[i]
          RELATED_PARTY_ASSUMED[i] MISSING_FIELD:manufacturer-assumed[i] ISF[i] ENTRY_DATE_DEFAULTED[i]
          WEIGHT_PRORATED:inv0-line1..3[i] HTS_RESOLVED:inv0-line1..3[i] AUTO_REMEDIES[i]
```

(The four s4 line groups each repeat 7 "got undefined" checks. They are folded into one line here.)

### Field-level extraction problems in the pre-fix result JSON

**s4: Korean trade-form invoice, text PDF (2 pages); text packing list; scanned carrier B/L**
- Invoice: the invoice number and date were empty. The label is "⑧ Invoice No. & Date", and the circled box number made it non-credible. No invoice lines were read: no item table was found, `lines: []`.
- Invoice: no buyer was found. "② For Account & Risk of Messrs." was an unknown label. The port of discharge was read as "⑤ Final Destination" (the next box's label).
- Invoice: SUB TOTAL and the "LESS : 3% VOLUME DISCOUNT -USD 5,299.63" line were not read. Only the TOTAL AMOUNT line was.
- B/L: the consignee name was "TO THE ORDER OF" (the order clause), so the ultimate consignee was "TO THE ORDER OF".
- B/L: gross weight was 10,912 kg and volume 63.36 CBM, both from the first of two container rows. Packages were "40" (from "40' HC"). Seals were missing.
- Packing list: 5 lines, including a phantom "12-CUP" line, with descriptions split across two columns. That caused 5 false QTY_MISMATCH warnings.
- XML was XSD-invalid (no invoice-no). Once the lines were read, headings 8509 and 8516 were missing from the offline HTS data, giving 4 HTS_LOW_CONFIDENCE blockers.

**s5: Singapore trader invoice, text PDF; packing list as a JPEG phone photo; NVOCC house B/L, text PDF**
- Invoice: the invoice number was empty. "Inv. Ref." was an unknown label, and "Your" from "Your Order" was grouped into the "Inv. Ref." line.
- Invoice: the incoterm place, buyer, ship-to and manufacturer were interleaved across columns and lines (see the strings above). The seller was just "STRAITSBRIDGE", with no address. The "SOURCING PTE. LTD." part of the logo is letter-spaced.
- Invoice: no charges or totals. The itemized "Ocean freight 4,350" inside the CFR price was not read, so the freight was not deducted, CHARGES_NOT_ITEMIZED fired as a blocker, and NON_DUTIABLE_CHARGES was missing.
- Invoice: line 2's "*" footnote (made in Vietnam at a sister factory) was not linked. That left origin ID and no ORIGIN_DIFFERS. "Goods made & shipped by" was unknown, so SELLER_NOT_MANUFACTURER was missing.
- Photo packing list: OCR ran at native 1600×2133 px, and the item table was mostly lost (one garbage row). A "total N.W. 1,440" was derived from that row.
- MID city piece was "BAN" (Banten, the province) for the Indonesian factory: MID IDSEPNUS125BAN.
- XML was XSD-invalid (no invoice-no).

## 2. Fixes

Every fix is generic, sits in the module where the root cause lives, and has a unit test that fails
without the fix. Tests written after their fix were checked by disabling the fix and re-running
them. Most of the new parse tests are in `server/test/parse/generalization.test.ts`, which uses
invented page-art documents with the same layout patterns, not the synthetic files.

### Ingest

1. **Visual lines merged across lines: the main s4/s5 root cause.**
   - Cause: pdftotext reports word boxes 2–3× taller than the glyphs for some fonts (Apple SD Gothic Neo; Gill Sans as embedded by Chromium). For example, boxes are 77–97 px high for 8–9 pt text on a 50 px line pitch. The line clustering tolerance (0.5 × median box height) therefore reached the neighbouring line, and the running mean chained lines through columns printed at offset baselines.
   - Change (`server/src/ingest/lines.ts`), part (a): a word never joins a line that already holds a word stacked directly above or below it, i.e. horizontal overlap with a clearly different y-centre. Each word goes to the nearest compatible line.
   - Part (b): when the median box height is larger than the measured line pitch (lower quartile of y-centre distances between horizontally overlapping words), the tolerance becomes 0.4 × pitch.
   - Pages with normal boxes behave as before. On the real sample, only page 2 of the invoice changes: the circular company chop text and the signature "Raymond Chan" are no longer glued into the "Bank:" line. `server/test/fixtures/sample/invoice.layout.json` lines were regenerated from its unchanged words, and `PIPELINE_VERSION` was bumped.
   - Tests: `test/ingest/units.test.ts` › groupLines (4 new).
2. **Photo of a sheet OCR'd too small.**
   - Cause: images with a long side of 2000 px or more were never upscaled. In a 1600×2133 phone photo the sheet fills only part of the frame (about 175 DPI), and the text is about 12 px high.
   - Change (`ingest/raster.ts`): images are upscaled toward the 300 DPI page size (3300 px long side) whenever they are smaller. All five per-colour rows, the totals and the footnote now read correctly.
   - Test: `units.test.ts` › chooseUpscale.

### Parse: page model (`parse/layout.ts`)

3. **`medH` calibration.** `medH`, the unit of every parse distance threshold, is now 0.7 × line pitch when boxes are taller than the pitch. Before, value boxes started about 140 px left of their label, blocks did not end at blank lines, and below-values were rejected as "not below".
4. **No gluing of text-layer words.** The OCR-split repair ("a t" → "at") glued text-layer words whose gap was under 10% of the inflated box height, producing "freightTanjung" and "FOOTWEARVIETNAM". Two text-layer words are now never glued, and the glyph size is capped at 3 character widths.
5. **Letter-spaced text** ("S O U R C I N G  P T E .  LT D.") is joined into words. Words break where the gap is clearly wider than the letter spacing. At least 4 consecutive single letters are required, so size lists like "S M L XL" are untouched.

### Parse: labels and forms (`parse/labels.ts`, `parse/vocab.ts`, `parse/dates.ts`, `parse/docs/*`)

6. **Circled box numbers** (①–⑳, ⑴–⒇, ⒈–⒛, ❶–➓, ㉑–㊿) are treated as field numbers, like "(11)". The label after one starts a field. An enclosed number also ends a right-hand value and bounds a value box, and party blocks stop at the next numbered label.
7. **Vocabulary additions:**
   - "Invoice No. & Date" counts as a label of both fields.
   - "For Account & Risk of Messrs." is a buyer label.
   - "Inv. Ref." is an invoice-number label.
   - "Goods made & shipped by" (and variants) is a manufacturer label.
   - "Shipped per" is a vessel label.
   - Table columns: "Package" maps to cartons, "C/T No." to a carton range, and there is a new `marks` column field ("Marks & Numbers"), so shipping marks are no longer read as cartons or line numbers.
8. **Dates.** "MRH-260914-07 SEP. 14, 2026" was read as 7 Sep 2014. Now a day number glued to a code by "-" is not a day, and a 2-digit year followed by a 4-digit year is the day of a month-first date. A combined "Invoice No. & Date" box also gives the date printed far right on the number's line.
9. **Value-below fallback.** When the text to the right of a label fails validation (e.g. "Sailing on or about   TEL +82 …", which belongs to the next box), the value below the label is tried before the label is abandoned.
10. **Party columns 63 px apart.** A gap at the box edge that is clearly wider than the line's word spacing is a column edge. Before, the "lines below run across the sub-label" rule erased it, which interleaved the invoiced-to, deliver-to and made-by columns.
11. **Remarks boxes.** A remarks block ends at its first "Label :" form-field line, so the P/O, payment terms and origin fields stay readable. Values never run into an excluded region such as the item table.
12. **Letterhead:**
    - A logo name split over two lines ("STRAITSBRIDGE" / "SOURCING PTE. LTD.") is joined when the full name is printed elsewhere on one line (signature block, footer).
    - An address block printed beside the logo is attached.
    - "Singapore 018961" (country followed by a postal code) is read as a locality.

### Parse: item tables (`parse/table.ts`, `docs/invoice.ts`, `docs/packingList.ts`)

13. **Short synonyms inside other words.** Synonyms of 5 characters or fewer only match inside a longer header as whole words. Before, "GOLDLINE" ⊃ LINE and "LONG BEACH" ⊃ EACH turned the caption row under the header into header lines.
14. **Caption rows.** A row-less line with words in a quantity, price or amount column ("HOUSEHOLD ELECTRIC APPLIANCES … FOB BUSAN") is a caption, not part of the first row. The header-less continuation page (s4 line 4) then works with the existing column carry-over.
15. **Combined code/description column.** "Model No. / Description" is one stacked column: the code alone on the first cell line becomes the style number. A "Measurement (CBM)" column is a volume (the per-row CBM is read), not carton dimensions.
16. **End of the item table.** The table ends at a totals or breakdown heading with a figure in a value column ("VALUE BREAKDOWN … Total 10,200 PRS"). Before, the CFR breakdown was swallowed into line 3.
17. **Packing-list totals.**
    - A quantity total split by unit ("1,440 SETS" over "3,864 PCS") is not used as one piece total.
    - Per-carton values derived for columns the document does not print are notes, not "OCR readings to verify". Before, a text PDF raised OCR_VERIFY for 12 values it never printed.

### Parse: money lines (`docs/invoice.ts` `scanLabelledAmounts`)

18. **How amounts are paired with labels:**
    - Quantity totals between a label and its amount are skipped ("SUB TOTAL  1,440 SETS  176,654.40").
    - A "-USD" before the amount is a sign.
    - A segment holding several money figures is a multi-column totals row and is skipped. This was found as a regression on s2's "TOTAL: 370 2,390 PCS 20,920.00 4,830.00 5,335.00".
    - Year-first dates are not money.
    - A label stacked in its own box above an amount ("Total CFR Savannah" over "USD 114,300.00") wins over text far to the left.
    - An amount alone on its line, vertically centred in a two-line cell, takes the label beside it.
    - "3% VOLUME DISCOUNT" is a charge, not a volume total.
    - "<incoterm> value" and "goods value" lines are printed totals.

### Parse: B/L, parties, footnotes

19. **To-order consignee.** "TO THE ORDER OF" on its own line is joined with the order party on the next line, so the consignee name is the whole clause (`parse/party.ts`).
20. **Multi-container bills.** When a reading is one container row and another printed figure equals the sum of the rows, that sum (the TOTAL row) is used for gross weight, volume and packages. "40' HC" and "2 X 40' HC" are no longer package counts. In "Container No. / Seal No." grids, the code after "<container> /" is that container's seal (`docs/billOfLading.ts`).
21. **Footnotes and line-level origin.**
    - A "*" on the description line is a footnote reference, and it is stripped from the description.
    - Unlabeled "*" footnote paragraphs below the table are note paragraphs.
    - "Country of origin of this article: VIETNAM" is read, and so are possessive intros ("at our supplier's sister factory …").
    - A country inside a company name ("NUSANTARA FOOTWEAR VIETNAM CO., LTD.") does not end the address.
    - "CO., LTD." stays one legal form.

### Reconcile and valuation

22. **To-order bills.**
    - Change (`reconcile/merge/parties.ts`, `rules/parties.ts`): a "TO (THE) ORDER (OF …)" consignee is never the ship-to or the ultimate consignee.
    - The buyer is the ultimate consignee, and ULTIMATE_CONSIGNEE_ASSUMED (info) explains the to-order bill: under an L/C, the order bank holds title only as security.
23. **CFR lines that already include the freight.**
    - Bug: `linesAreFob` was true because "printed FOB value + itemized freight = CFR total". That only proves the breakdown adds up.
    - Fix (`reconcile/lib/fob.ts`): line amounts that themselves equal the C/D total include the charges, and that test now runs first. s5's freight is deducted again (51,425 / 37,054 / 21,471).
24. **Discounts deducted on the invoice.**
    - Change: when a printed money total equals goods minus the itemized discount, `ShipmentInvoice.discountsDeducted` is set. This is a new optional field in `packages/shared/src/types.ts` (additive).
    - Valuation (`netchb/valuation.ts`) then apportions the discount by line value. The trail step cites 19 USC 1401a(b)(1), and notes that a rebate granted after importation would not be deductible (19 USC 1401a(b)(4)(B)).
    - Result: s4 is now 44,418 / 37,853 / 35,074 / 54,010 = 171,355.
    - A discount that no printed total deducts is still ignored, which is the conservative choice.
    - Tests: `test/netchb/valuation.test.ts` and `test/reconcile/lib.test.ts`.

### Reference data

25. **MID city piece** (`reference/mid.ts`): administrative-division prefixes are dropped. These are "Kab." / "Kabupaten" / "Kec." (Indonesia), "TP." / "Thanh Pho" / "Huyen" / "Tinh" (Vietnam), and "Amphoe" / "Changwat" (Thailand). "Kota" is kept because of names like Kota Kinabalu. The s5 factory MID is now IDSEPNUS125TAN (Tangerang).
26. **Offline HTS data.** Headings 8509, 8516, 6402, 6403 and 6404 were prefetched with `npx tsx server/src/reference/prefetch.ts 8509 8516 6402 6403 6404`. They are committed in `server/src/reference/data/hts/` and added to `DEFAULT_HEADINGS`.

### Harness

- `server/test/integration/synthetic-report.ts` now sends each file with its real mime type (image/jpeg for the photo; ingest also sniffs the bytes). `SYNTH_RESULTS_DIR` writes every PipelineResult.
- **New `server/test/integration/synthetic.test.ts`.** It runs every `samples/synthetic/*/expected.json` through the real pipeline (cold OCR cache, offline HTS) and asserts documents, header, lines, each line, issuesInclude, issuesExclude and XSD validity: 48 tests, about 15 s.
- It has a `KNOWN_FAILURES` map that turns a group into `it.fails` with a reason. The map is empty: no expectation still fails.

## 3. Post-fix result

Pre-fix → post-fix. Both runs used a cold cache. `per-line` adds up the 7 checks of every line.

| Case | docs | header | lines | per-line | issuesInclude | issuesExclude | xsd | Total |
|---|---|---|---|---|---|---|---|---|
| s1-air-eur-fca | 4/4 → 4/4 | 16/16 → 16/16 | 2/2 → 2/2 | 28/28 → 28/28 | 2/2 → 2/2 | 16/16 → 16/16 | 1/1 → 1/1 | 69/69 → 69/69 |
| s2-scan-cn-ddp | 4/4 → 4/4 | 18/18 → 18/18 | 2/2 → 2/2 | 28/28 → 28/28 | 2/2 → 2/2 | 17/17 → 17/17 | 1/1 → 1/1 | 72/72 → 72/72 |
| s3-messy-minimal | 4/4 → 4/4 | 17/17 → 17/17 | 2/2 → 2/2 | 21/21 → 21/21 | 8/8 → 8/8 | 10/10 → 10/10 | 1/1 → 1/1 | 63/63 → 63/63 |
| **s4-kr-fob-multi-container** (blind) | 6/6 → 6/6 | 11/17 → 17/17 | 0/2 → 2/2 | 0/28 → 28/28 | – (none asserted) | 21/22 → 22/22 | 0/1 → 1/1 | **38/76 → 76/76** |
| **s5-id-footwear-cfr** (blind) | 6/6 → 6/6 | 12/19 → 19/19 | 1/2 → 2/2 | 15/21 → 21/21 | 1/4 → 4/4 | 18/19 → 19/19 | 0/1 → 1/1 | **53/72 → 72/72** |
| Real sample (`samples/*.pdf`) | 3 docs OK | – | 5 lines | – | – | – | valid → valid | 27,439 → 27,439. Entry XML byte-identical, same issues |

Issues the expectations do not assert, after the fixes:
- **s4.** Broker-input blockers (importer ID, bond, surety). Warnings: missing arrival date, missing FIRMS, MID_VERIFY for KRMIRHOM236INC (the street "236beon-gil" mixes letters and digits), Chapter 99 not computed. Info items: ULTIMATE_CONSIGNEE_ASSUMED (to-order bill), RELATED_PARTY_ASSUMED, manufacturer assumed (seller = B/L shipper), ISF, ENTRY_DATE_DEFAULTED, HTS_RESOLVED ×4, AUTO_REMEDIES. Containers carry their seals (HN6204417 / HN6204418), and the bill shows 2,004 CTN.
- **s5.** Same broker-input blockers, and ORIGIN_DIFFERS for line 2. DECLARATION_CONFLICT (warning): see §4. Info items: NON_DUTIABLE_CHARGES, SELLER_NOT_MANUFACTURER, FIRST_SALE_OPPORTUNITY, HOUSE_MASTER_BILL, plus the standard ones. MIDs: IDSEPNUS125TAN (lines 1 and 3) and VNNUSFOO7DON (line 2, the Vietnamese factory). The seller is sent as the SE party with its Singapore address. The photo's OCR_VERIFY warning and the FIELD_OMITTED warning are gone.

## 4. Judgment calls on the expectations

I found no expectation to be wrong.

- **s4 discount.** I agree with `expected.json`. The 3% volume discount is deducted on this invoice before importation: the net total is what the L/C pays. 19 USC 1401a(b)(4)(B) disregards only decreases made *after* importation. The app now deducts a discount only when a printed total proves it is deducted on the invoice.
  - Follow-up for the owner of `docs/NETCHB_NOTES.md` (not my path): §8 "Discounts … are neither deducted nor added" and §4 should describe this rule.
  - There is no dedicated issue code for it (see §5.1).
- **s4 to-order bill.** ULTIMATE_CONSIGNEE_ASSUMED (info) now fires with a to-order explanation. IMPORTER_ASSUMED does not fire, because the invoice names the buyer. Neither is asserted, as intended.
- **s5 DECLARATION_CONFLICT.** It fires because the photo packing list's shipping marks read "MADE IN INDONESIA / C/NO. 1-650", and cartons 301–450 hold the Vietnam-made article. The packing-list footnote says those cartons are side-marked MADE IN VIETNAM, which the rule does not read.
  - It is not in `issuesExclude`. I kept it as a defensible marking advisory, but a broker may find it noisy.

## 5. Known remaining limitations and root causes

1. **Discount has no issue or decision.**
   - Gap: the apportioned discount appears only in the valuation trail. There is no issue code for it, so a broker cannot flip it to "retroactive rebate, keep the undiscounted price".
   - Root cause: adding an `IssueCode` also needs `ISSUE_CODES` in `scripts/synthetic/expected-schema.ts` (its exhaustive guard fails the typecheck otherwise) and the web labels. Neither is in my paths.
2. **e2e `sample-flow` fails** (1 of 7). This is pre-existing, not caused by these changes: the sample's entry XML and issues are identical before and after.
   - Root cause: `web/src/lib/broker-inputs.ts` (`inputsFromResult` / `decisionDefaults`) sends every decision default on regenerate. `server/src/netchb/decisions.ts` deliberately treats any decision key that is present as an explicit broker choice, which a server test pins ("explicitly confirming the default option also resolves the blocker"). So flipping the quantity decision also "resolves" the untouched composition blocker.
   - Fix belongs in web/: send only the keys the broker set.
3. **Photo OCR is still imperfect.**
   - "SNA-SL0410" reads as "SNA-SLO410" (O for 0), so the per-colour rows of line 3 do not match the invoice style.
   - The header cells "Prs / Ctn", "Total Prs" and "G.W. (kg)" are partly lost, so the per-row piece counts and gross weights are not used. Line weights are prorated (WEIGHT_PRORATED, info), and the packing list contributes no quantity cross-check for s5.
4. **Invoice-only transport fields in label rows can be wrong** when a weak label sits in the row: s5 invoice vessel "ETD Jakarta", s4 invoice port "BUSAN, KOREA /" from "④ From / To". The B/L values win in reconcile, but a shipment without a B/L would carry them.
5. **Wrapped item titles.** Only the first line of a wrapped title is the title. s4's "COUNTERTOP CONVECTION" + "OVEN 25L" gives the commercial description "COUNTERTOP CONVECTION". `descriptionContains` passes because the details are also checked.
6. **MID city for an ambiguous Vietnamese address.** Line 2's MID VNNUSFOO7DON takes its city piece from "Dong Nai Province". The address lists town, district and province but no city line. MID_VERIFY is not raised for it.
7. **Fixture generator out of date.**
   - `scripts/make-layout-fixtures.py` (not my path) still implements the old line grouping. The committed fixtures match live ingest because their `lines` were regenerated from the unchanged `words`. Regenerating them with the Python script would revert the sample invoice's page-2 chop and signature lines. It should get the stacked-word and pitch rule.
   - `server/test/parse/fixtures/synthetic/` (s1–s3 parse snapshots) predates the change too. Only one stamp fragment ("fe") differs on the s2 scan. These snapshots feed parse tests and are not compared with live ingest.
8. **Coverage.** These are 5 synthetic shipments plus the real sample. s4 and s5 drove the fixes, so their 100% scores are not blind numbers any more. The blind numbers are the pre-fix ones: **38/76 and 53/72**.

## 6. Final verification

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `cd server && npx vitest run` | 35 files, **1131 passed** (1039 before this run; 92 new, including the 48-test synthetic integration suite) |
| `cd web && npx vitest run` | 10 files, 68 passed |
| `npx vitest run --config scripts/synthetic/vitest.config.ts` | 3 files, 69 passed |
| `npx playwright test -c e2e/playwright.config.ts` | 6 passed, **1 failed** (`sample-flow`, the pre-existing web decision bug in §5.2; the spec was not changed) |
| `npm run cli -- samples/*.pdf --out output/` | XSD valid, total entered value USD 27,439, 5 blockers / 14 warnings / 19 info (unchanged) |
