/**
 * S3 — messy minimal. Indian exporter's US-style (QuickBooks-like) invoice: MM/DD/YYYY date,
 * quantity-first columns, no HS codes, one line made in Sri Lanka, FOB Chennai. Scanned carrier
 * B/L consigned to a 3PL "for account of" the buyer, with a container number whose check digit
 * is wrong (a single-digit typo nobody corrected) and a red TELEX RELEASE stamp.
 */
import { fmtInt, fmtMoney, fmtNum, roundCents } from '../format.js';
import { esc, htmlDocument } from '../html/base.js';
import type { ShipmentSpec } from '../spec.js';

const SELLER = {
  name: 'KAVERI KNIT EXPORTS PVT. LTD.',
  lines: ['S.F. No. 214/2, Kangeyam Road', 'Tiruppur - 641 604, Tamil Nadu, INDIA'],
  ids: 'GSTIN: 33AABCK4417M1Z5 &nbsp; IEC: 0414027715',
  phone: 'Ph: +91 421 2241 770',
};
const BUYER = {
  name: 'BRIGHTWATER APPAREL GROUP, INC.',
  lines: ['1407 Broadway, Suite 2210', 'New York, NY 10018', 'USA'],
};
const INVOICE_NO = 'KKE/1187/25-26';
const INVOICE_DATE = '03/04/2026';
const PO = 'BW-26-0193';
const BL_NO = 'BYXLMAA26031287';
/** Printed container number: a one-digit typo of BYXU5207184, so its check digit (4) is wrong (should be 7). */
const CONTAINER = 'BYXU5209184';
const SEAL = 'BX441207';
const CTNS = 186;
const GROSS_KG = 1986.4;
const CBM = 21.4;

interface S3Line {
  qty: number;
  um: string;
  code: string;
  title: string;
  details: string[];
  rate: number;
  origin: string;
  hs6Truth: string;
  match: string;
}

const LINES: S3Line[] = [
  {
    qty: 3000,
    um: 'PCS',
    code: 'KK-M1042',
    title: "MEN'S CREW NECK T-SHIRT",
    details: ['100% cotton single jersey knit, 180 GSM, short sleeve', 'asstd colours, sizes S-XXL'],
    rate: 2.4,
    origin: 'IN',
    hs6Truth: '610910',
    match: 'CREW NECK T-SHIRT',
  },
  {
    qty: 2400,
    um: 'PCS',
    code: 'KK-M1046',
    title: "MEN'S V-NECK T-SHIRT",
    details: ['100% cotton jersey knit, 160 GSM'],
    rate: 2.25,
    origin: 'IN',
    hs6Truth: '610910',
    match: 'V-NECK T-SHIRT',
  },
  {
    qty: 1200,
    um: 'PCS',
    code: 'LW-W2210',
    title: "WOMEN'S STRAIGHT LEG TROUSERS",
    details: ['100% cotton twill, woven, 240 GSM', 'MADE IN SRI LANKA - Lanka Weave Garments (Pvt) Ltd,', '41 Baseline Road, Colombo 09'],
    rate: 7.15,
    origin: 'LK',
    hs6Truth: '620462',
    match: 'STRAIGHT LEG TROUSERS',
  },
];

const AMOUNTS = LINES.map((l) => roundCents(l.qty * l.rate));
const TOTAL = roundCents(AMOUNTS.reduce((s, a) => s + a, 0));

function invoiceHtml(): string {
  const rows = LINES.map(
    (l, i) => `<tr>
      <td class="r">${fmtInt(l.qty)}</td><td class="c">${l.um}</td><td>${esc(l.code)}</td>
      <td>${esc(l.title)}${l.details.map((d) => `<br>${esc(d)}`).join('')}</td>
      <td class="r">${fmtMoney(l.rate)}</td><td class="r">${fmtMoney(AMOUNTS[i])}</td></tr>`,
  ).join('');
  const css = `
body { font-family: 'Courier New', Courier, monospace; font-size: 9.6pt; }
.pad { padding: 12mm 13mm 0 15mm; }
.top { display: flex; justify-content: space-between; }
.co b { font-size: 13pt; }
.co { line-height: 1.35; }
.inv { text-align: right; }
.inv h1 { font-family: Arial, Helvetica, sans-serif; font-size: 22pt; letter-spacing: 2pt; margin-bottom: 2mm; }
table.box td, table.box th { border: 0.3mm solid #222; padding: 1mm 2mm; }
table.box th { font-family: Arial, sans-serif; font-size: 7.6pt; background: #e8e8e8; text-align: center; }
table.box td { text-align: center; }
.sold { margin-top: 7mm; width: 92mm; }
.sold th { text-align: left !important; }
.sold td { text-align: left !important; line-height: 1.35; height: 22mm; vertical-align: top; }
.terms { width: 100%; margin-top: 6mm; }
.items { width: 100%; margin-top: 4mm; }
.items th { font-family: Arial, sans-serif; font-size: 7.8pt; background: #e8e8e8; border: 0.3mm solid #222; padding: 1.2mm; }
.items td { border-left: 0.3mm solid #222; border-right: 0.3mm solid #222; padding: 1.6mm 1.6mm; vertical-align: top; line-height: 1.3; }
.items tr.fill td { height: 34mm; border-bottom: 0.3mm solid #222; }
.items .r { text-align: right; white-space: nowrap; }
.items .c { text-align: center; }
.items tr.tot td { border: 0.3mm solid #222; font-weight: bold; padding: 1.8mm; }
.misc { margin-top: 4mm; line-height: 1.45; font-size: 9pt; }
.sig { position: absolute; right: 15mm; bottom: 24mm; width: 70mm; text-align: center; }
.sig .l { margin-top: 15mm; border-top: 0.25mm solid #222; padding-top: 1mm; }
`;
  const body = `<div class="pad">
  <div class="top">
    <div class="co"><b>${esc(SELLER.name)}</b><br>${SELLER.lines.map(esc).join('<br>')}<br>${SELLER.ids}<br>${SELLER.phone}</div>
    <div class="inv"><h1>INVOICE</h1>
      <table class="box" style="margin-left:auto"><tr><th>DATE</th><th>INVOICE #</th></tr><tr><td>${INVOICE_DATE}</td><td>${esc(INVOICE_NO)}</td></tr></table></div>
  </div>
  <table class="box sold"><tr><th>SOLD TO</th></tr><tr><td>${esc(BUYER.name)}<br>${BUYER.lines.map(esc).join('<br>')}</td></tr></table>
  <table class="box terms">
    <tr><th>P.O. NO.</th><th>TERMS</th><th>SHIP VIA</th><th>F.O.B.</th><th>PORT OF DISCHARGE</th><th>COUNTRY OF ORIGIN</th></tr>
    <tr><td>${PO}</td><td>D/A 60 DAYS</td><td>SEA</td><td>CHENNAI</td><td>NEWARK, NJ</td><td>INDIA</td></tr>
  </table>
  <table class="items">
    <colgroup><col style="width:17mm"><col style="width:11mm"><col style="width:22mm"><col><col style="width:17mm"><col style="width:25mm"></colgroup>
    <tr><th>QTY</th><th>U/M</th><th>ITEM CODE</th><th>DESCRIPTION</th><th>RATE</th><th>AMOUNT</th></tr>
    ${rows}
    <tr class="fill"><td></td><td></td><td></td><td>${CTNS} CTNS<br>Currency: US$</td><td></td><td></td></tr>
    <tr class="tot"><td colspan="4" style="text-align:right">TOTAL US$</td><td></td><td class="r">${fmtMoney(TOTAL)}</td></tr>
  </table>
  <div class="misc">Amount chargeable (in words): US DOLLARS TWENTY ONE THOUSAND ONE HUNDRED EIGHTY ONLY<br>
    SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF IGST<br>
    Bank: Kongu Commercial Bank Ltd, Tiruppur Main Branch, A/c 4417 0020 1187, SWIFT KCBLINBBTPR<br>
    We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
</div>
<div class="sig">for ${esc(SELLER.name)}<div class="l">Authorised Signatory</div></div>`;
  return htmlDocument({ format: 'Letter', css, pages: [body] });
}

function billOfLadingHtml(): string {
  const css = `
body { font-family: Verdana, Geneva, sans-serif; font-size: 8.9pt; }
.pad { padding: 9mm 10mm 0 10mm; }
.hd { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 0.6mm solid #6b2c00; padding-bottom: 2mm; }
.brand { font-family: Georgia, serif; font-size: 19pt; font-weight: bold; color: #6b2c00; letter-spacing: 0.6pt; }
.brand small { display: block; font-family: Verdana, sans-serif; font-size: 7.5pt; font-weight: normal; color: #333; letter-spacing: 0; }
.blbox { border: 0.4mm solid #6b2c00; padding: 1.5mm 3mm; text-align: right; }
.blbox .t { font-size: 12pt; font-weight: bold; }
.lbl { font-size: 7.2pt; color: #6b2c00; display: block; margin-bottom: 0.7mm; }
table.g { width: 100%; table-layout: fixed; margin-top: 2mm; }
table.g td { border: 0.3mm solid #6b2c00; padding: 1.2mm 1.6mm; vertical-align: top; line-height: 1.32; }
.cargo { width: 100%; table-layout: fixed; margin-top: -0.3mm; }
.cargo th { border: 0.3mm solid #6b2c00; font-size: 7.2pt; color: #6b2c00; font-weight: normal; padding: 1mm; text-align: left; }
.cargo td { border: 0.3mm solid #6b2c00; padding: 2mm 1.6mm; vertical-align: top; height: 70mm; line-height: 1.38; }
.legal { font-size: 6.3pt; color: #333; line-height: 1.3; }
`;
  const body = `<div class="pad">
  <div class="hd">
    <div class="brand">BAYLINE EXPRESS LINES<small>Ocean Transport · Multimodal Transport · SCAC BYXL</small></div>
    <div class="blbox"><span class="lbl">BILL OF LADING No.</span><div class="t">${BL_NO}</div><span class="lbl" style="margin-top:1mm">Booking No. MAA0312874</span></div>
  </div>
  <table class="g">
    <colgroup><col style="width:52%"><col style="width:48%"></colgroup>
    <tr><td style="height:24mm"><span class="lbl">(1) Shipper / Exporter</span>KAVERI KNIT EXPORTS PVT LTD<br>S.F. NO. 214/2, KANGEYAM ROAD<br>TIRUPPUR 641604, TAMIL NADU, INDIA</td>
      <td><span class="lbl">(5) Export references</span>INV NO. ${esc(INVOICE_NO)} DT ${INVOICE_DATE}<br>S/B NO. 4471802 DT 06-MAR-2026</td></tr>
    <tr><td style="height:27mm"><span class="lbl">(2) Consignee</span>RARITAN LOGISTICS SERVICES LLC<br>FOR ACCOUNT OF BRIGHTWATER APPAREL GROUP, INC.<br>75 NATIONAL ROAD<br>EDISON, NJ 08817, USA</td>
      <td><span class="lbl">(6) Point and country of origin of goods</span>TIRUPPUR, INDIA<br><br><span class="lbl">(7) Forwarding agent</span>-</td></tr>
    <tr><td style="height:24mm"><span class="lbl">(3) Notify party</span>BRIGHTWATER APPAREL GROUP, INC.<br>1407 BROADWAY, SUITE 2210<br>NEW YORK, NY 10018, USA<br>TEL +1 212 555 0136</td>
      <td><span class="lbl">(8) Domestic routing / export instructions</span>DELIVER TO CONSIGNEE WAREHOUSE<br>EDISON NJ BY TRUCK</td></tr>
  </table>
  <table class="g" style="margin-top:-0.3mm">
    <colgroup><col style="width:26%"><col style="width:26%"><col style="width:24%"><col style="width:24%"></colgroup>
    <tr><td><span class="lbl">(9) Pre-carriage by</span>TRUCK</td><td><span class="lbl">(10) Place of receipt</span>TIRUPPUR ICD</td>
      <td><span class="lbl">(11) Ocean vessel / Voy.</span>SEA ORCHID / 611W</td><td><span class="lbl">(12) Port of loading</span>CHENNAI, INDIA</td></tr>
    <tr><td colspan="2"><span class="lbl">(13) Port of discharge</span>NEWARK, NJ, USA</td><td colspan="2"><span class="lbl">(14) Place of delivery</span>EDISON, NJ, USA</td></tr>
  </table>
  <table class="cargo">
    <colgroup><col style="width:25%"><col style="width:12%"><col style="width:39%"><col style="width:12%"><col style="width:12%"></colgroup>
    <tr><th>Container No. / Seal No.<br>Marks and Numbers</th><th>No. of pkgs</th><th>Description of packages and goods</th><th>Gross weight</th><th>Measurement</th></tr>
    <tr><td>${CONTAINER.slice(0, 4)} ${CONTAINER.slice(4)}<br>SEAL ${SEAL}<br>1 X 20' GP<br><br>BRIGHTWATER<br>NEW YORK<br>C/NO 1-${CTNS}</td>
      <td>${CTNS} CTNS</td>
      <td>${CTNS} CARTONS<br>READYMADE GARMENTS:<br>MEN'S 100% COTTON KNIT T-SHIRTS<br>WOMEN'S 100% COTTON WOVEN TROUSERS<br><br>SHIPPER'S LOAD, STOW AND COUNT<br>SHIPPED ON BOARD: 14-MAR-2026</td>
      <td>${fmtNum(GROSS_KG, 3)} KGS</td><td>${fmtNum(CBM, 3)} CBM</td></tr>
  </table>
  <table class="g" style="margin-top:-0.3mm">
    <colgroup><col style="width:38%"><col style="width:20%"><col style="width:42%"></colgroup>
    <tr><td rowspan="2"><span class="lbl">Freight and charges</span>OCEAN FREIGHT &nbsp; COLLECT<br>DEST. THC &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; COLLECT<br>FREIGHT PAYABLE AT NEWARK</td>
      <td><span class="lbl">No. of original B/L</span>THREE (3)</td><td><span class="lbl">Place and date of issue</span>CHENNAI, 14-MAR-2026</td></tr>
    <tr><td colspan="2" class="legal">RECEIVED for shipment the goods or packages said to contain goods as specified above in apparent good order and condition unless otherwise stated, to be transported to the place of delivery subject to the terms printed on the reverse. One original Bill of Lading must be surrendered duly endorsed in exchange for the goods or delivery order.<br><br><span class="lbl">Signed for the Carrier: BAYLINE EXPRESS LINES (INDIA) PVT LTD, AS AGENTS</span></td></tr>
  </table>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

export const s3: ShipmentSpec = {
  id: 's3-messy-minimal',
  valuation: { lineAmounts: AMOUNTS, includedNonDutiableCharges: 0 },
  docs: [
    {
      file: 'Invoice_KKE-1187.pdf',
      docType: 'commercial_invoice',
      variant: 'text',
      format: 'Letter',
      pages: 1,
      html: invoiceHtml(),
      meta: { title: 'INVOICE', author: SELLER.name },
      keyTokens: [INVOICE_NO, INVOICE_DATE, PO, 'CHENNAI', ...LINES.map((l) => l.code), ...AMOUNTS.map((a) => fmtMoney(a)), fmtMoney(TOTAL), 'SRI LANKA'],
    },
    {
      file: `BL_${BL_NO}_scan.pdf`,
      docType: 'bill_of_lading',
      variant: 'scan',
      format: 'A4',
      pages: 1,
      html: billOfLadingHtml(),
      meta: { title: 'Scan', author: 'Brightwater Apparel Group, Inc.' },
      keyTokens: [
        BL_NO,
        CONTAINER,
        SEAL,
        fmtNum(GROSS_KG, 3),
        fmtNum(CBM, 3),
        `${CTNS} CTNS`,
        'SEA ORCHID',
        '611W',
        'CHENNAI',
        'NEWARK',
        'EDISON',
        'RARITAN',
        'BRIGHTWATER',
        'KAVERI',
        INVOICE_NO,
        '14-MAR-2026',
      ],
      scan: {
        seed: 's3-bl',
        dpi: 200,
        rotateDeg: 0.65,
        noiseSigma: 8,
        blurSigma: 0.6,
        paper: [245, 241, 230],
        bed: [204, 200, 192],
        specklesPerMp: 30,
        jpegQuality: 78,
        stamps: [
          {
            cxMm: 72,
            cyMm: 86,
            wMm: 70,
            hMm: 17,
            angleDeg: -9,
            frame: 'box',
            color: '#cc1a2a',
            opacity: 0.8,
            lines: [{ text: 'TELEX RELEASE', sizeMm: 8, bold: true, fit: true }],
          },
        ],
      },
    },
  ],
  expected: {
    id: 's3-messy-minimal',
    description:
      'Indian exporter (Tiruppur) → New York buyer by sea, FOB Chennai. Minimal US-style text invoice (MM/DD/YYYY date, QTY-first columns, no HS codes, one line made in Sri Lanka); scanned carrier B/L consigned to an Edison NJ 3PL for account of the buyer, with a container number whose ISO 6346 check digit is wrong and a red TELEX RELEASE stamp; no packing list.',
    notes: [
      'Valuation policy: FOB Chennai — the price ends on board at Chennai and ocean freight is COLLECT on the B/L, so the invoice contains no freight or insurance to deduct. No assists, no NCV lines. Entered value = line amount.',
      'Line 1: 3,000 PCS × USD 2.40 = 7,200.00 → 7,200.',
      'Line 2: 2,400 PCS × USD 2.25 = 5,400.00 → 5,400.',
      'Line 3: 1,200 PCS × USD 7.15 = 8,580.00 → 8,580.',
      'Total entered value: 7,200 + 5,400 + 8,580 = 21,180 = printed TOTAL US$ 21,180.00.',
      'Invoice date 03/04/2026 is ambiguous: MM/DD → 2026-03-04, DD/MM → 2026-04-03. The B/L shows SHIPPED ON BOARD 14-MAR-2026 (shipping bill 06-MAR-2026), and an invoice cannot post-date the shipment, so 2026-03-04 is correct; it also falls inside the Indian fiscal year 25-26 printed in the invoice number (ends 31-Mar-2026). India normally writes DD/MM, so a country-convention rule alone picks the wrong date: chronology must win. Expect DATE_AMBIGUOUS (resolved).',
      'No HS codes are printed → HTS_NOT_DECLARED. Correct 6-digit headings (hs6Truth): 6109.10 for the men\'s cotton knit T-shirts (lines 1–2) and 6204.62 for the women\'s cotton woven trousers (line 3).',
      'Header COUNTRY OF ORIGIN is INDIA but line 3 says MADE IN SRI LANKA (Lanka Weave Garments, Colombo) → ORIGIN_DIFFERS for line 3 with COO LK; that line\'s MID must come from the Sri Lankan maker, not the Indian seller.',
      'Container BYXU 5209184 fails ISO 6346: the check digit computed from BYXU520918 is 7, but 4 is printed. It is a one-digit typo of BYXU5207184 (valid), but nothing on the documents supports that correction and no single OCR-confusable digit swap yields a valid number, so the app must report CONTAINER_NUMBER_INVALID and must NOT invent a correction (CONTAINER_NUMBER_CORRECTED excluded).',
      'B/L consignee is RARITAN LOGISTICS SERVICES LLC (3PL, Edison NJ) "for account of" BRIGHTWATER APPAREL GROUP, INC. → importer and ultimate consignee = Brightwater (the invoice buyer); ULTIMATE_CONSIGNEE_ASSUMED.',
      'Invoice number KKE/1187/25-26 contains "/" (XSD invoiceNoType is [A-Za-z0-9-]{1,17}) → KKE-1187-25-26, INVOICE_NO_NORMALIZED.',
      'No packing list → MISSING_DOCUMENT. Gross weight 1,986.400 KGS and 186 cartons come from the B/L (invoice also says 186 CTNS).',
      'Port of discharge NEWARK, NJ → Schedule D 4601; containerized vessel → mode 11. Carrier B/L BYXLMAA26031287 → master SCAC BYXL + bill MAA26031287; no house bill.',
      'The red TELEX RELEASE stamp is the only release evidence → TELEX_RELEASE advisory. Ocean freight and destination THC are COLLECT (a COLLECT_CHARGES advisory is reasonable but not asserted).',
    ],
    expect: {
      invoiceNumber: INVOICE_NO,
      invoiceNumberNormalized: 'KKE-1187-25-26',
      invoiceDate: '2026-03-04',
      currency: 'USD',
      incoterm: { code: 'FOB', place: 'Chennai' },
      sellerName: SELLER.name,
      buyerName: BUYER.name,
      importerName: BUYER.name,
      ultimateConsigneeName: BUYER.name,
      transport: {
        mode: 'ocean',
        modeTransportation: '11',
        entryPort: '4601',
        containers: [CONTAINER],
        bills: [{ masterScac: 'BYXL', masterBill: BL_NO.slice(4) }],
        grossWeightKg: GROSS_KG,
      },
      lines: LINES.map((l, i) => ({
        lineNo: i + 1,
        styleNo: l.code,
        descriptionContains: l.match,
        quantity: l.qty,
        unit: l.um,
        unitPrice: l.rate,
        printedAmount: AMOUNTS[i],
        countryOfOrigin: l.origin,
        hs6: null,
        hs6Truth: l.hs6Truth,
        enteredValue: [7200, 5400, 8580][i],
      })),
      totalEnteredValue: 21180,
      issuesInclude: [
        'HTS_NOT_DECLARED',
        'ORIGIN_DIFFERS',
        'CONTAINER_NUMBER_INVALID',
        'ULTIMATE_CONSIGNEE_ASSUMED',
        'DATE_AMBIGUOUS',
        'MISSING_DOCUMENT',
        'INVOICE_NO_NORMALIZED',
        'TELEX_RELEASE',
      ],
      issuesExclude: [
        'CONTAINER_NUMBER_CORRECTED',
        'NON_DUTIABLE_CHARGES',
        'CHARGES_NOT_ITEMIZED',
        'LINE_AMOUNT_MISMATCH',
        'TOTALS_MISMATCH',
        'CURRENCY_CONVERSION',
        'NCV_VALUE',
        'ASSIST',
        'QTY_MISMATCH',
        'PACKAGE_COUNT_MISMATCH',
      ],
    },
  },
};
