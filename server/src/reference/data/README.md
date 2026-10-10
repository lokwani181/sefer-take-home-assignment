# Reference data (T4)

Everything here is committed so classification and lookups work offline and deterministically.
Snapshots were taken on **2026-10-10**. Nothing in this folder is specific to the sample shipment.

## HTS (USITC)

| What | Source |
|---|---|
| `hts/<heading>.json` | `GET https://hts.usitc.gov/reststop/exportList?from=<hhhh>&to=<hhhh+1>&format=JSON&styles=false` — the whole 4-digit heading **including unnumbered parent rows** ("Men's or boys':", "Recreational performance outerwear:"). The range is inclusive of the next heading's first row, which the tree builder drops. |
| `hts-search/<slug>.json` | `GET https://hts.usitc.gov/reststop/search?keyword=<text>` (omits unnumbered parents; candidate discovery only). Slug = lowercase keyword with non-alphanumerics → `-`. |

Rows are stored verbatim except that always-null fields (`quotaQuantity`, `additionalDuties`, …) are dropped.
Whole headings are cached (not just the 6-digit subheading) so sibling subheadings (6110.30 when 6110.20 was
declared, 6106 for a knit line declared in 6206) and the heading text are always available.

Committed headings:
- sample lines + alternatives: 6109, 6110, 6203, 6206, 6106
- synthetic shipments: 8211, 7323, 9403, 4202, 6302, 6204, 6105, 3924
- candidate headings the committed searches rank in their top 6 (so offline search results equal online ones):
  3926 4420 4803 5802 5806 6103 6104 6111 6117 6209 6210 6211 6307 6912 7013 7114 7204 7218 7324 8201 8208 8214 8215 8452 9402 9619

Committed searches: `trousers cotton`, `t-shirts cotton`, `kitchen knives`, `stainless steel kitchenware`,
`wooden furniture`, `backpacks`, `cotton towels`.

Refresh / add: `npx tsx server/src/reference/prefetch.ts [heading|keyword ...]` (no arguments = the default list).
At runtime, unknown headings/keywords are fetched once and cached under `server/.cache/hts/{headings,search}/`
(`HTS_CACHE_DIR` overrides; `HTS_OFFLINE=1` disables the network).

## US ports — `us-ports.json` (CBP Schedule D, 4-digit)

- Census Schedule D district/port list (produced April 2025): https://www.census.gov/foreign-trade/schedules/d/dist.txt
- CBP port directory (per-state pages): https://www.cbp.gov/about/contact/ports

Merged by code; the CBP name wins where both exist (the Census name is kept as an alias). CBP codes are used for
entries, which matters in New York: CBP lists **4601 New York/Newark** and **4701 JFK** while the Census statistical
list uses 1003/1012 — both are kept, and the curated alias table in `ports.ts` maps "NEWARK"→4601, "JFK"→4701,
"NEW YORK"→1001. Codes with no CBP page (1001 New York, 2709 Long Beach, 2811 Oakland, 3029 Seattle-Tacoma airport)
come from the Census list. Kinds (`port`/`air`/`courier`) are derived from the names.

## Foreign ports — `schedule-k.json` (Schedule K, 5-digit, sea ports)

- USACE Schedule K, 2nd Quarter 2026 (xlsx, "All Current Schedule K Codes" sheet):
  https://ndclibrary.sec.usace.army.mil/resource?documentId=8c90a43a-eaa8-4e2c-ad13-13a9f3ed2b92
- CBP CAMIR Appendix F (points to the same Army Corps spreadsheet): https://www.cbp.gov/document/guidance/ace-ocean-camir-appendix-f-schedule-k

Columns `[code, name, iso2, official]`; official names and aliases are both kept. Dropped: `Military-*` and
`All Other … Ports` catch-alls (a catch-all is a filing choice for the broker, not a lookup result).
Schedule K country codes are Census Schedule C codes, mapped to ISO via
https://www.census.gov/foreign-trade/schedules/c/country.txt plus four codes missing from that 2014 file
(2775 BQ, 2776 MF, 7320 SD, 7720 NA, checked by country name).

Notes: **Cat Lai** is not listed by name. "CAT LAI, HO CHI MINH CITY" resolves to **55224 Saigon / Ho Chi Minh City**
through the official alias; "CAT LAI" alone returns null (Cat Lai is a Saigon Newport/Tan Cang terminal and Schedule K
also has 55225 Tan Cang, so the broker must choose). **Shenzhen** alone is null (Yantian 57078, Shekou 57018,
Chiwan 57067, Da Chan Bay 57045 are separate codes). Airports always return null.
Extra spellings in `ports.ts` (`HO CHI MINH`, `HCMC`, `JNPT`, `CHATTOGRAM`, `HAI PHONG`) only point to the code
Schedule K itself gives that city.

## Cargo airports — `../airports.ts` (country of an airport, not a lading-port code)

Schedule K has no airports, and CBP Form 7501 Block 19 (rev. 02/26,
https://www.cbp.gov/sites/default/files/2026-02/cbp_form_7501.pdf) says to leave the foreign port of lading
blank for non-vessel shipments, so airports never yield a lading-port code. `airports.ts` maps ~145 major
international cargo airports (IATA code + unambiguous city/airport names) to their ISO country, only so
`portCountry("FRANKFURT/MAIN (FRA)")` → DE can give an air shipment its country of export. Every code/country pair
was checked on 2026-10-10 against OurAirports (https://davidmegginson.github.io/ourairports-data/airports.csv,
public domain): exactly one non-closed airport per code, in the listed country (BSL excluded: EuroAirport
Basel-Mulhouse is in France).

## Countries — `countries.json`

ISO 3166-1 alpha-2/alpha-3 and names from https://raw.githubusercontent.com/datasets/country-codes/main/data/country-codes.csv
(ISO + UN M49 derived), plus Census Schedule C names. Trade-document variants ("U.S.A.", "VIET NAM", "P.R. CHINA",
"KOREA, REPUBLIC OF", "UK", …) are in `countries.ts`.

## Fees — `fees.json` (FY2027: Oct 1 2026 – Sep 30 2027)

- MPF: 0.3464% ad valorem, **minimum $34.58, maximum $670.86** — Federal Register 2026-15530, 91 FR 48398
  (July 31, 2026), Table 2: https://www.federalregister.gov/documents/2026/07/31/2026-15530/customs-user-fees-to-be-adjusted-for-inflation-in-fiscal-year-2027
- HMF: 0.125% of the value of commercial cargo loaded/unloaded from a commercial vessel — 19 CFR 24.24(a)
  (https://www.ecfr.gov/current/title-19/chapter-I/part-24/section-24.24; verified via https://www.law.cornell.edu/cfr/text/19/24.24).

## MID rules (implemented in `mid.ts`, no data file)

- CBP ACE Entry Summary Instructions v2.4, "Rules for constructing the Manufacturer Identification Code"
  (pp. 43-45, with the worked examples used in the tests): https://www.cbp.gov/sites/default/files/documents/ace_es_instructions_3.pdf
- Original: Customs Directive 3550-055 (1986), Attachment A: https://www.cbp.gov/sites/default/files/documents/3550-055_3.pdf
  (its N. MINAMI example reads 268; the current ACE instructions read 26 because a space delimits numbers — the code follows ACE).

## Rebuilding ports / Schedule K / countries

`python3 server/src/reference/data/sources/build_reference_data.py [download_dir]` (stdlib only) downloads the
sources above and rewrites `us-ports.json`, `schedule-k.json` and `countries.json`.
