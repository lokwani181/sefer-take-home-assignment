# Writeup: shipment documents → NetCHB entry

**What it does.** Upload a shipment's documents (commercial invoice, packing list, B/L or air waybill, as PDF or image). You get back a NetCHB entry XML that validates against NetCHB's schema, plus a ranked list of action items: conflicts, assumptions and missing broker-only data. Each item comes with evidence and a concrete next step. Judgment calls are presented as decisions the broker can flip, and the entry regenerates in about 35 ms.

## Finding out what NetCHB expects
NetCHB publishes its integration surface:
- [`entry.xsd`](https://www.netchb.com/xml/entry/entry.xsd), which imports [`data_type.xsd`](https://www.netchb.com/xml/data/data_type.xsd)
- a SOAP [`EntryUploadService` WSDL](https://www.netchb.com/main/services/entry/EntryUploadService?wsdl) with `uploadEntry(username, password, entryXml)`
- a page explaining [upload responses](https://www.netchb.com/xml/entry/entryUploadResponse.html)

I vendored the schemas and validate every generated entry against them, in-process with xmllint-wasm. Reading the schema surfaced several traps:
- Elements must follow a strict sequence.
- Money and weight fields take whole numbers.
- `invoice-no` only allows `[A-Za-z0-9-]{1,17}`, so the sample's `KBAS/NB/26-0912` is invalid as printed and is normalized (and flagged).
- `importer-tax-id` is optional in the schema but required by CBP for a type 01 entry. A schema-valid XML is therefore not necessarily fileable, and the UI says so.

Field semantics are in `docs/NETCHB_NOTES.md`, split into *confirmed by XSD* and *inferred*.

## Extraction
No LLMs and no API keys; extraction is deterministic.
- **Digital PDFs:** the text layer with word positions.
- **Scans and photos:** Tesseract on sparse-text mode, after deskewing coordinates and separating red/blue stamp ink. This recovers stamp text and the handwritten container correction.
- **Parsing:** layout-aware rules: label synonym dictionaries, tables located from their headers, party blocks and footnote linking.
- **Self-checks:** OCR errors are repaired from constraints, never guessed:
  - cartons × per-carton = total (fixes `14,60` → 14.60)
  - qty × price = amount
  - the ISO 6346 container check digit (picks the handwritten `OPLU3041722` over the crossed-out typed number)

**Accuracy and speed:**
- 100% of the 116 critical fields across the 3 sample documents.
- About 4 s end to end on a cold cache.

**Tariff codes:** classification walks the live USITC tariff tree (the `exportList` endpoint, cached offline) using gender, knit/woven and the fibre that predominates by weight. The 6-digit codes on the invoice resolve to 10 digits, e.g. `6109.10.00.12`.

## Judgment on the sample
Policy:
- When documents disagree, trust the invoice, unless arithmetic or physical evidence proves it wrong.
- Never invent data.
- Be conservative on value.
- Surface every correction.

What the app did:
- **Line 1:** printed $6,480, but 2,400 × 2.85 = $6,840, and the printed subtotal only reconciles with $6,840. Corrected.
- **Hoodie quantity:** invoice 1,200 vs packed 1,176 (blocker). This is hidden in the grand totals by the 24 samples.
- **Hoodie fabric:** "60/40 cotton" vs "TC 65/35", which means mostly polyester (blocker). That changes the tariff from 6110.20 at 16.5% to 6110.30 at 32%, about $1,400 more duty.
- **Buyer-supplied fabric:** $4,180 added to the blouse line.
- **Free samples:** entered as their own line, origin **Bangladesh**, valued at $24 and flagged as nominal. The invoice's "Vietnam origin" declaration is flagged as contradicting it.
- **Shipping terms:** the price includes freight and insurance (CIF), so $3,850 + $185 is excluded from value.
- **Manufacturer ID:** built from the Vietnamese factory, not the Hong Kong seller (first-sale noted).
- **Weight:** the B/L's 1,930 kg is used over the packing list's 1,888 kg (flagged).
- **Date:** `12/09/2026` resolved by chronology to 12 September.
- **Ultimate consignee:** the buyer, not the 3PL warehouse.

Result: entered value **$27,439** and 5 blockers. Two are document conflicts; three are data only the broker has (importer number, bond, surety).

## What I don't know
- I had no NetCHB account, so the XML is schema-valid but has never been accepted by NetCHB.
- Some field meanings are inferred, e.g. foreign-currency conversion and cargo-release parties.
- Chapter 99 additional duties are not computed. The entry enables NetCHB's `auto-apply-remedies`, and an issue tells the broker to verify them.
- Manufacturer-ID rules are ambiguous for addresses like "Lot C7-C8, Road No. 9", so that ID is flagged.
- **Generalization, honestly measured:** on two blind shipments generated without looking at the parser, a cold first run passed **50%** and **74%** of their checks. After general fixes, all 5 synthetic shipments pass 100%, but those two are no longer blind (`docs/GENERALIZATION.md`). Rule-based parsing stays the main risk on very different layouts.

## How AI was used
I used Claude Code throughout:
1. Researching NetCHB and running an OCR spike that decided the no-LLM design.
2. Writing a plan and shared contracts, plus hand-checked ground truth for the sample.
3. Fanning out 7 agents in parallel, each owning one module with its own tests.
4. Then integration, blind generalization tests, and a final verification round.

Agents were never allowed to special-case the sample. About 1,280 tests (unit, integration, real-OCR golden, and Playwright end-to-end) back the claims above.

## With more time
- A NetCHB sandbox round trip, so the app could use `uploadEntry` responses.
- A table-structure model, or a local vision model, as a fallback for low-confidence fields only.
- Per-supplier layout memory learned from broker corrections.
- ISF and arrival-notice cross-checks.
- A Chapter 99 / remedies engine.
- Deployment from the existing Dockerfile.
