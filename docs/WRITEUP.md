# Approach: Shipment Documents to NetCHB Entry XML

## Overview
I built a web application that accepts commercial invoices, packing lists, and bills of lading (PDFs or images), extracts shipment information, reconciles it across documents, and generates NetCHB entry XML. Alongside the XML, it presents prioritized action items with supporting evidence and suggested next steps, so a broker can review conflicts, assumptions, and missing filing information.

## Design
The pipeline uses deterministic extraction rather than an external LLM or API key. For digital PDFs, it reads the text layer and layout; for scanned documents and images, it uses Tesseract OCR with image preprocessing. Layout-aware parsers identify fields, parties, line items, tables, and footnotes. Normalization and cross-document checks then reconcile the extracted data. Arithmetic relationships and the ISO 6346 container check digit help detect or correct likely OCR errors; uncertain or conflicting values are surfaced for human review rather than silently guessed.

The implementation is organized into separate ingestion, parsing, normalization/reconciliation, validation, and XML-generation stages. This keeps document-specific extraction separate from the output format and makes the pipeline easier to test and extend. The interface lets users inspect the generated entry and action items, resolve decisions, and regenerate the XML.

## Validation and decisions
The generated XML is validated against the vendored NetCHB XSD schemas. Schema validity is not the same as filing readiness: some broker/CBP-required information may be missing even when the XML conforms to the schema, and the application flags such gaps. The sample shipment also demonstrates why document reconciliation matters: the invoice and packing list disagree on hoodie quantity, the hoodie fibre composition differs across documents, the bill of lading and packing list disagree on gross weight, and the free samples have a different stated country of origin. These are surfaced as review items instead of being hidden by matching grand totals.

The app applies conservative rules, records corrections, and avoids inventing missing broker-only values. Tariff classification and some NetCHB field semantics rely on rules or interpretations documented in the repository; these should be reviewed by a customs professional before real filing.

## Limitations and next steps
I did not have access to a NetCHB account or sandbox, so I could validate against the schema but could not verify acceptance through NetCHB's upload service. Rule-based parsing may also be less reliable on unfamiliar document layouts. With more time, I would test against a NetCHB sandbox, expand evaluation on genuinely unseen shipments, improve low-confidence table extraction, and extend support for additional duty/remedy checks.

## AI assistance
I used Claude Code and ChatGPT during development for research, planning, implementation support, and debugging. I reviewed and integrated the generated work, and the submitted AI conversation histories provide the interaction record.
