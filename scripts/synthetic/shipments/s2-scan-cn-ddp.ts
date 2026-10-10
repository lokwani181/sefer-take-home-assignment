/**
 * S2 — ocean, USD, DDP. Scanned combined "Commercial Invoice & Packing List" from a Ningbo
 * maker (Times font, stacked header rows, re-ordered columns, itemized DDP charges, one line
 * whose printed amount is wrong) + a 2-page text-layer house B/L (terms on page 2).
 */
import { fmtInt, fmtMoney, fmtNum, roundCents } from '../format.js';
import { esc, htmlDocument } from '../html/base.js';
import type { ShipmentSpec } from '../spec.js';

const SELLER = {
  name: 'NINGBO HAOYU HOME & TRAVEL GOODS CO., LTD.',
  cn: '宁波浩宇家居旅行用品有限公司',
  address: 'No. 88 Jinyuan Road, Yinzhou District, Ningbo, Zhejiang 315100, China',
  contact: 'Tel: +86 574 8826 4410 &nbsp; Fax: +86 574 8826 4411 &nbsp; E-mail: export@haoyu-home.cn',
};
const BUYER = {
  name: 'TYBEE TRADING COMPANY LLC',
  address: '415 East Bay Street, Savannah, GA 31401, U.S.A.',
  phone: '+1 912 555 0148',
};

const INVOICE_NO = 'NBHY-260917';
const INVOICE_DATE = 'SEP. 08, 2026';
const PO = 'TTC-PO-8841';
const HBL = 'CXSVNGB26091187';
const MBL = 'ZSPLNGB2609180';
const CONTAINER = 'ZSPU4182074';
const SEAL = 'ZP0915447';
const VESSEL = 'ZHOUSHAN PIONEER';
const VOYAGE = '0926E';

interface S2Line {
  item: string;
  hs: string;
  title: string;
  details: string[];
  ctns: number;
  qty: number;
  unit: string;
  price: number;
  /** As printed; deliberately wrong on one line. */
  printed: number;
  nw: number;
  gw: number;
}

const LINES: S2Line[] = [
  {
    item: 'HY-ST2201',
    hs: '9403.60.80',
    title: 'SOLID ACACIA WOOD SIDE TABLE',
    details: ['50 x 50 x 55 cm, natural oil finish', 'Knock-down, 2 pcs per carton'],
    ctns: 120,
    qty: 240,
    unit: 'PCS',
    price: 18.5,
    printed: 4440,
    nw: 1440,
    gw: 1620,
  },
  {
    item: 'HY-BS4410',
    hs: '9403.60.80',
    title: 'PINE WOOD 4-TIER BOOKSHELF',
    details: ['80 x 30 x 150 cm, white-wash finish', 'Flat-packed with hardware kit'],
    ctns: 150,
    qty: 150,
    unit: 'PCS',
    price: 32.4,
    printed: 4860,
    nw: 2250,
    gw: 2475,
  },
  {
    item: 'HY-BP3080',
    hs: '4202.92.31',
    title: 'LAPTOP BACKPACK 15.6 INCH',
    details: ['Outer: 600D polyester, PU coated', 'Padded laptop sleeve, USB port'],
    ctns: 60,
    qty: 1200,
    unit: 'PCS',
    price: 6.85,
    printed: 8280, // 1,200 × 6.85 = 8,220.00 — the printed amount is wrong
    nw: 780,
    gw: 840,
  },
  {
    item: 'HY-BP3090',
    hs: '4202.92.31',
    title: 'KIDS BACKPACK, PRINTED',
    details: ['Outer: 420D nylon', '2 zip pockets, padded straps'],
    ctns: 40,
    qty: 800,
    unit: 'PCS',
    price: 4.25,
    printed: 3400,
    nw: 360,
    gw: 400,
  },
];

const COMPUTED = LINES.map((l) => roundCents(l.qty * l.price));
/** The printed grand total equals the sum of the COMPUTED amounts (it corroborates them). */
const TOTAL = roundCents(COMPUTED.reduce((s, a) => s + a, 0));
const CHARGES = [
  { label: 'Ocean freight Ningbo – Savannah (1 x 40\'HC)', amount: 2850 },
  { label: 'Cargo insurance (110% of invoice value)', amount: 96 },
  { label: 'US import duties &amp; customs fees (estimated)', amount: 1214 },
  { label: 'US inland delivery, Savannah port – buyer\'s warehouse', amount: 420 },
];
const CHARGES_TOTAL = CHARGES.reduce((s, c) => s + c.amount, 0);
const CTNS = LINES.reduce((s, l) => s + l.ctns, 0);
const PCS = LINES.reduce((s, l) => s + l.qty, 0);
const NW = LINES.reduce((s, l) => s + l.nw, 0);
const GW = LINES.reduce((s, l) => s + l.gw, 0);
const CBM = 58.6;

function invoicePackingListHtml(): string {
  const rows = LINES.map(
    (l) => `<tr>
      <td class="nw">${esc(l.item)}</td>
      <td class="nw">${esc(l.hs)}</td>
      <td class="d"><b>${esc(l.title)}</b>${l.details.map((d) => `<br>${esc(d)}`).join('')}</td>
      <td class="r">${l.ctns}</td>
      <td class="r">${fmtInt(l.qty)}</td>
      <td class="c">${l.unit}</td>
      <td class="r">${fmtMoney(l.price)}</td>
      <td class="r">${fmtMoney(l.printed)}</td>
      <td class="r">${fmtMoney(l.nw)}</td>
      <td class="r">${fmtMoney(l.gw)}</td>
    </tr>`,
  ).join('');
  const css = `
body { font-family: 'Times New Roman', Times, serif; font-size: 10.4pt; }
.pad { padding: 11mm 12mm 0 12mm; }
.co { text-align: center; }
.co .en { font-size: 16pt; font-weight: bold; letter-spacing: 0.3pt; }
.co .cn { font-family: 'Songti SC', 'PingFang SC', serif; font-size: 11pt; margin-top: 0.5mm; }
.co .addr { font-size: 9.6pt; margin-top: 1mm; }
hr { border: none; border-top: 0.6mm double #222; margin: 2.5mm 0 3mm; }
h1 { text-align: center; font-size: 15pt; text-decoration: underline; letter-spacing: 0.6pt; margin-bottom: 3.5mm; }
.hdr { width: 100%; font-size: 10.4pt; margin-bottom: 3mm; }
.hdr td { padding: 0.7mm 0; vertical-align: top; }
.hdr td.k { width: 36mm; font-weight: bold; }
.it { width: 100%; font-size: 9.6pt; table-layout: fixed; }
.it th { border: 0.3mm solid #222; padding: 1.2mm 0.8mm; font-weight: bold; text-align: center; vertical-align: middle; background: #f2f2f2; }
.it td { border-left: 0.3mm solid #222; border-right: 0.3mm solid #222; padding: 1.4mm 0.9mm; vertical-align: top; }
.it tbody tr td { border-bottom: 0.15mm solid #999; }
.it tr.tot td { border: 0.3mm solid #222; font-weight: bold; padding: 1.6mm 0.9mm; }
.it .r { text-align: right; }
.it .c { text-align: center; }
.it .nw { white-space: nowrap; }
.it .d { font-size: 9.2pt; line-height: 1.25; }
.charges { margin-top: 3.5mm; width: 120mm; font-size: 10pt; border: 0.3mm solid #222; }
.charges td { padding: 0.8mm 2mm; }
.charges td.r { text-align: right; white-space: nowrap; }
.charges tr.h td { font-weight: bold; border-bottom: 0.2mm solid #222; }
.charges tr.t td { font-weight: bold; border-top: 0.2mm solid #222; }
.grand { margin-top: 3mm; font-size: 11pt; font-weight: bold; }
.small { font-size: 9.8pt; line-height: 1.45; margin-top: 2.5mm; }
.sig { position: absolute; right: 16mm; bottom: 22mm; width: 76mm; text-align: center; font-size: 10pt; }
.sig .line { border-top: 0.25mm solid #222; margin-top: 16mm; padding-top: 1mm; }
`;
  const body = `<div class="pad">
  <div class="co"><div class="en">${esc(SELLER.name)}</div><div class="cn">${SELLER.cn}</div>
    <div class="addr">${esc(SELLER.address)}<br>${SELLER.contact}</div></div>
  <hr>
  <h1>COMMERCIAL INVOICE &amp; PACKING LIST</h1>
  <table class="hdr">
    <tr><td class="k">Messrs.:</td><td>${esc(BUYER.name)}, ${esc(BUYER.address)} &nbsp; Tel: ${BUYER.phone}</td></tr>
    <tr><td class="k">Invoice No.:</td><td>${INVOICE_NO}</td></tr>
    <tr><td class="k">Date:</td><td>${INVOICE_DATE}</td></tr>
    <tr><td class="k">S/C No. / P.O. No.:</td><td>HY-SC-26-0412 / ${PO}</td></tr>
    <tr><td class="k">Shipment:</td><td>From NINGBO, CHINA to SAVANNAH, GA, U.S.A. by sea, per ${VESSEL} V.${VOYAGE}, B/L No. ${HBL}</td></tr>
    <tr><td class="k">Terms of Delivery:</td><td>DDP SAVANNAH, GA (INCOTERMS 2020)</td></tr>
    <tr><td class="k">Payment:</td><td>T/T 30% deposit, balance against copy of B/L</td></tr>
    <tr><td class="k">Country of Origin:</td><td>CHINA</td></tr>
  </table>
  <table class="it">
    <colgroup><col style="width:20.5mm"><col style="width:18.5mm"><col><col style="width:10mm"><col style="width:13mm"><col style="width:10mm"><col style="width:15.5mm"><col style="width:19mm"><col style="width:16.5mm"><col style="width:16.5mm"></colgroup>
    <thead><tr><th>Item</th><th>HS Code</th><th>Description</th><th>Ctns</th><th>Qty</th><th>Unit</th><th>Unit Price<br>(USD)</th><th>Amount<br>(USD)</th><th>N.W.<br>(KG)</th><th>G.W.<br>(KG)</th></tr></thead>
    <tbody>${rows}</tbody>
    <tr class="tot"><td colspan="3">TOTAL:</td><td class="r">${CTNS}</td><td class="r">${fmtInt(PCS)}</td><td class="c">PCS</td><td></td><td class="r">${fmtMoney(TOTAL)}</td><td class="r">${fmtMoney(NW)}</td><td class="r">${fmtMoney(GW)}</td></tr>
  </table>
  <table class="charges">
    <tr class="h"><td colspan="2">PRICE BREAKDOWN (included in the DDP prices above)</td></tr>
    ${CHARGES.map((c) => `<tr><td>${c.label}</td><td class="r">USD ${fmtMoney(c.amount)}</td></tr>`).join('')}
    <tr class="t"><td>Total charges included</td><td class="r">USD ${fmtMoney(CHARGES_TOTAL)}</td></tr>
  </table>
  <div class="grand">TOTAL AMOUNT DDP SAVANNAH, GA: USD ${fmtMoney(TOTAL)}</div>
  <div class="small">SAY TOTAL US DOLLARS TWENTY THOUSAND NINE HUNDRED AND TWENTY ONLY.<br>
    Packing: ${CTNS} cartons in total, measurement ${fmtNum(CBM, 2)} CBM, loaded in 1 x 40'HC.<br>
    Shipping marks: TYBEE / SAVANNAH / ITEM NO. / C/NO. 1-${CTNS} / MADE IN CHINA<br>
    We hereby certify that the above goods are of Chinese origin and the particulars are true and correct.</div>
</div>
<div class="sig">For and on behalf of<br><b>${esc(SELLER.name)}</b><div class="line">Authorized Signature</div></div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

const TERMS = [
  ['DEFINITIONS', '"Carrier" means the party on whose behalf this Bill of Lading has been signed. "Merchant" includes the Shipper, Consignee, Receiver, Holder of this Bill of Lading and any person owning or entitled to the possession of the Goods.'],
  ['CARRIER\'S TARIFF', 'The terms of the Carrier\'s applicable Tariff are incorporated herein. Copies of the relevant provisions are obtainable from the Carrier upon request.'],
  ['WARRANTY', 'The Merchant warrants that in agreeing to these terms he is, or has the authority of, the person owning or entitled to the possession of the Goods and this Bill of Lading.'],
  ['SUB-CONTRACTING', 'The Carrier shall be entitled to sub-contract on any terms the whole or any part of the carriage, loading, unloading, storing, warehousing, handling and any and all duties undertaken by the Carrier in relation to the Goods.'],
  ['CARRIER\'S RESPONSIBILITY', 'Where the stage of carriage where loss or damage occurred is not known, the Carrier shall be liable to the extent prescribed by the applicable rules, not exceeding the limits stated in clause 7.'],
  ['SHIPPER-PACKED CONTAINERS', 'If a Container has not been packed or filled by the Carrier, the Carrier shall not be liable for loss of or damage to the contents caused by the manner in which the Container has been packed, by the unsuitability of the contents for carriage, or by the condition of the Container furnished by the Merchant.'],
  ['LIMITATION', 'Unless the nature and value of the Goods have been declared by the Shipper and inserted in this Bill of Lading, compensation shall not exceed the limits provided by the applicable international convention or national law.'],
  ['NOTICE OF LOSS', 'Unless notice of loss or damage is given in writing to the Carrier at the place of delivery before or at the time of removal of the Goods, such removal shall be prima facie evidence of delivery as described in this Bill of Lading.'],
  ['FREIGHT AND CHARGES', 'Freight shall be deemed fully earned on receipt of the Goods by the Carrier and shall be paid and non-returnable in any event. The Merchant shall be jointly and severally liable for all charges.'],
  ['LIEN', 'The Carrier shall have a lien on the Goods and any documents relating thereto for all sums payable to the Carrier under this contract and for general average contributions.'],
  ['GENERAL AVERAGE', 'General average shall be adjusted at any port or place at the Carrier\'s option according to the York-Antwerp Rules 2016.'],
  ['LAW AND JURISDICTION', 'Any claim or dispute arising under this Bill of Lading shall be governed by the law of the place where the Carrier has its principal place of business.'],
];

function billOfLadingHtml(): string {
  const css = `
body { font-family: Arial, Helvetica, sans-serif; font-size: 9.4pt; }
.pad { padding: 10mm 10mm 0 10mm; }
.lbl { font-family: 'Arial Narrow', Arial, sans-serif; font-size: 7pt; font-weight: bold; color: #0b5d3b; display: block; margin-bottom: 0.8mm; letter-spacing: 0.2pt; }
table.b { width: 100%; table-layout: fixed; }
table.b td { border: 0.3mm solid #0b5d3b; padding: 1.3mm 1.8mm; vertical-align: top; }
.blno { font-size: 13pt; font-weight: bold; }
.logo { font-family: 'Avenir Next Condensed', 'Arial Narrow', sans-serif; font-weight: 700; font-size: 20pt; color: #0b5d3b; letter-spacing: 1pt; margin-top: 3mm; }
.logo small { display: block; font-size: 8pt; letter-spacing: 0.3pt; color: #333; }
.title { font-size: 15pt; font-weight: bold; margin-top: 2.5mm; }
.sub { font-size: 7.6pt; color: #333; }
.band { background: #0b5d3b; color: #fff; text-align: center; font-size: 7.6pt; font-weight: bold; padding: 1mm; letter-spacing: 0.4pt; }
.cargo { width: 100%; table-layout: fixed; }
.cargo th { border: 0.3mm solid #0b5d3b; font-family: 'Arial Narrow', Arial, sans-serif; font-size: 7.2pt; color: #0b5d3b; padding: 1mm; text-align: left; }
.cargo td { border-left: 0.3mm solid #0b5d3b; border-right: 0.3mm solid #0b5d3b; border-bottom: 0.3mm solid #0b5d3b; padding: 2mm 1.6mm; vertical-align: top; height: 78mm; line-height: 1.35; }
.words { font-size: 8.4pt; padding: 1.5mm 0; }
.legal { font-size: 6.4pt; color: #333; line-height: 1.3; }
.p2 h2 { font-size: 10pt; text-align: center; margin-bottom: 3mm; }
.p2 .cols { column-count: 2; column-gap: 7mm; font-size: 7.4pt; line-height: 1.4; text-align: justify; }
.p2 .cols p { margin-bottom: 2mm; }
`;
  const page1 = `<div class="pad">
  <table class="b">
    <colgroup><col style="width:55%"><col style="width:45%"></colgroup>
    <tr><td style="height:27mm"><span class="lbl">SHIPPER / EXPORTER</span>NINGBO HAOYU HOME &amp; TRAVEL GOODS CO., LTD.<br>NO. 88 JINYUAN ROAD, YINZHOU DISTRICT<br>NINGBO, ZHEJIANG 315100, CHINA</td>
      <td rowspan="3"><span class="lbl">HOUSE B/L NO.</span><div class="blno">${HBL}</div>
        <div class="logo">CROSSWAVE<small>LOGISTICS (NINGBO) CO., LTD.</small></div>
        <div class="title">BILL OF LADING</div>
        <div class="sub">FOR COMBINED TRANSPORT OR PORT TO PORT SHIPMENT<br>FMC OTI NO. 028871NF &nbsp; SCAC: CXSV</div>
        <span class="lbl" style="margin-top:3mm">OCEAN CARRIER / MASTER B/L NO.</span>ZHOUSHAN PACIFIC LINES (SCAC ZSPL)<br>${MBL}</td></tr>
    <tr><td style="height:27mm"><span class="lbl">CONSIGNEE (IF "TO ORDER" SO INDICATE)</span>${esc(BUYER.name)}<br>415 EAST BAY STREET<br>SAVANNAH, GA 31401, USA<br>TEL ${BUYER.phone}</td></tr>
    <tr><td style="height:16mm"><span class="lbl">NOTIFY PARTY (NO CLAIM SHALL ATTACH FOR FAILURE TO NOTIFY)</span>SAME AS CONSIGNEE</td></tr>
  </table>
  <table class="b" style="margin-top:-0.3mm">
    <colgroup><col style="width:27.5%"><col style="width:27.5%"><col style="width:25%"><col style="width:20%"></colgroup>
    <tr><td><span class="lbl">PLACE OF RECEIPT</span>NINGBO CY</td><td><span class="lbl">PORT OF LOADING</span>NINGBO, CHINA</td>
      <td colspan="2"><span class="lbl">EXPORT REFERENCES</span>INV ${INVOICE_NO} / PO ${PO}</td></tr>
    <tr><td><span class="lbl">OCEAN VESSEL / VOY. NO.</span>${VESSEL} / ${VOYAGE}</td><td><span class="lbl">PORT OF DISCHARGE</span>SAVANNAH, GA, USA</td>
      <td><span class="lbl">PLACE OF DELIVERY</span>SAVANNAH, GA, USA</td><td><span class="lbl">MOVE TYPE</span>CY / CY</td></tr>
  </table>
  <div class="band">PARTICULARS DECLARED BY SHIPPER BUT NOT ACKNOWLEDGED BY THE CARRIER</div>
  <table class="cargo">
    <colgroup><col style="width:24%"><col style="width:12%"><col style="width:38%"><col style="width:13%"><col style="width:13%"></colgroup>
    <tr><th>CONTAINER NO. / SEAL NO.<br>MARKS &amp; NUMBERS</th><th>NO. OF PKGS</th><th>KIND OF PACKAGES; DESCRIPTION OF GOODS</th><th>GROSS WEIGHT (KGS)</th><th>MEASUREMENT (CBM)</th></tr>
    <tr><td>${CONTAINER} / 40'HC<br>SEAL: ${SEAL}<br><br>TYBEE<br>SAVANNAH<br>C/NO. 1-${CTNS}<br>MADE IN CHINA</td>
      <td>${CTNS} CARTONS</td>
      <td>SHIPPER'S LOAD, COUNT AND SEAL<br>1 X 40'HC CONTAINER SAID TO CONTAIN:<br>${CTNS} CARTONS OF<br>WOODEN FURNITURE (SIDE TABLES, BOOKSHELVES)<br>AND BACKPACKS<br>HS CODE: 9403.60 / 4202.92<br>INVOICE NO. ${INVOICE_NO}<br>P.O. NO. ${PO}<br><br>FREIGHT PREPAID</td>
      <td>${fmtNum(GW, 3)}</td><td>${fmtNum(CBM, 3)}</td></tr>
  </table>
  <div class="words">TOTAL NUMBER OF CONTAINERS OR PACKAGES (IN WORDS): SAY THREE HUNDRED SEVENTY (${CTNS}) CARTONS ONLY</div>
  <table class="b">
    <colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup>
    <tr><td rowspan="2"><span class="lbl">FREIGHT &amp; CHARGES</span>OCEAN FREIGHT &nbsp;&nbsp; PREPAID<br>ORIGIN THC &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; PREPAID<br>DEST. THC &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; PREPAID</td>
      <td><span class="lbl">PREPAID AT</span>NINGBO</td><td><span class="lbl">PAYABLE AT</span>&nbsp;</td><td><span class="lbl">NO. OF ORIGINAL B/L</span>THREE (3)</td></tr>
    <tr><td><span class="lbl">LADEN ON BOARD</span>15-SEP-2026</td><td colspan="2"><span class="lbl">PLACE AND DATE OF ISSUE</span>NINGBO, 15-SEP-2026</td></tr>
  </table>
  <table class="b" style="margin-top:-0.3mm">
    <colgroup><col style="width:56%"><col style="width:44%"></colgroup>
    <tr><td class="legal">RECEIVED by the Carrier from the Shipper in apparent good order and condition unless otherwise noted herein, the total number or quantity of Containers or other packages or units indicated above, to be carried subject to all the terms and conditions hereof (INCLUDING THE TERMS ON THE REVERSE HEREOF) from the Place of Receipt or the Port of Loading to the Port of Discharge or the Place of Delivery. In witness whereof the number of original Bills of Lading stated above have been signed, one of which being accomplished, the others to stand void.</td>
      <td style="height:27mm"><span class="lbl">SIGNED FOR THE CARRIER</span>ZHOUSHAN PACIFIC LINES<br>BY CROSSWAVE LOGISTICS (NINGBO) CO., LTD.<br>AS AGENT<br><br><span style="font-family:'Snell Roundhand','Apple Chancery',cursive;font-size:14pt">Li Wen</span></td></tr>
  </table>
</div>`;
  const page2 = `<div class="pad p2">
  <h2>TERMS AND CONDITIONS OF CARRIAGE — HOUSE BILL OF LADING ${HBL} (PAGE 2 OF 2)</h2>
  <div class="cols">${TERMS.map(([h, t], i) => `<p><b>${i + 1}. ${h}.</b> ${esc(t)}</p>`).join('')}</div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [page1, page2] });
}

const MATCH = ['ACACIA WOOD', 'BOOKSHELF', 'LAPTOP BACKPACK', 'KIDS BACKPACK'];
const ENTERED = [3468, 3796, 6420, 2656];

export const s2: ShipmentSpec = {
  id: 's2-scan-cn-ddp',
  valuation: { lineAmounts: COMPUTED, includedNonDutiableCharges: CHARGES_TOTAL },
  docs: [
    {
      file: 'scan_20260915_0042.pdf',
      docType: 'invoice_packing_list',
      variant: 'scan',
      format: 'A4',
      pages: 1,
      html: invoicePackingListHtml(),
      meta: { title: 'Scanned document', author: 'Tybee Trading Company LLC' },
      keyTokens: [
        INVOICE_NO,
        INVOICE_DATE,
        'DDP',
        'TYBEE',
        'SAVANNAH',
        ...LINES.map((l) => l.item),
        ...LINES.map((l) => l.hs),
        ...LINES.map((l) => fmtMoney(l.price)),
        ...LINES.map((l) => fmtMoney(l.printed)),
        fmtMoney(TOTAL),
        ...CHARGES.map((c) => fmtMoney(c.amount)),
        fmtMoney(CHARGES_TOTAL),
        fmtMoney(NW),
        fmtMoney(GW),
        String(CTNS),
      ],
      scan: {
        seed: 's2-ci-pl',
        dpi: 200,
        rotateDeg: -1.1,
        noiseSigma: 8,
        blurSigma: 0.6,
        paper: [246, 243, 233],
        bed: [208, 206, 200],
        specklesPerMp: 25,
        jpegQuality: 78,
        stamps: [
          {
            cxMm: 150,
            cyMm: 255,
            wMm: 40,
            hMm: 40,
            angleDeg: 12,
            frame: 'round',
            arcText: 'NINGBO HAOYU HOME & TRAVEL GOODS CO., LTD.',
            color: '#d0142c',
            opacity: 0.72,
            lines: [{ text: 'EXPORT DEPT.', sizeMm: 3.4, bold: true }],
          },
        ],
      },
    },
    {
      file: `${HBL}_BL.pdf`,
      docType: 'bill_of_lading',
      variant: 'text',
      format: 'A4',
      pages: 2,
      html: billOfLadingHtml(),
      meta: { title: `House B/L ${HBL}`, author: 'Crosswave Logistics (Ningbo) Co., Ltd.' },
      keyTokens: [HBL, MBL, CONTAINER, SEAL, fmtNum(GW, 3), fmtNum(CBM, 3), `${CTNS} CARTONS`, VESSEL, VOYAGE, 'NINGBO, CHINA', 'SAVANNAH, GA', '15-SEP-2026'],
    },
  ],
  expected: {
    id: 's2-scan-cn-ddp',
    description:
      'Ningbo maker → Savannah retailer by sea, DDP. Scanned combined COMMERCIAL INVOICE & PACKING LIST (Times font, stacked header, columns Item | HS Code | Description | Ctns | Qty | Unit | Unit Price | Amount | N.W. | G.W.) with itemized DDP charges and one wrong line amount, red round company chop; 2-page text house B/L (terms on page 2).',
    notes: [
      'Valuation policy: DDP Savannah — the line prices INCLUDE ocean freight, insurance, US duties & customs fees and US inland delivery; the invoice itemizes them under "PRICE BREAKDOWN (included in the DDP prices above)". All four are non-dutiable and are deducted, prorated by line value.',
      'Line 3 arithmetic: 1,200 PCS × USD 6.85 = 8,220.00 but 8,280.00 is printed. The printed grand total 20,920.00 = 4,440 + 4,860 + 8,220 + 3,400 (computed amounts), while the printed amounts would sum to 20,980.00, so the printed line amount is the error → use 8,220 (decision amount:inv0-line3 default "computed"). Expect LINE_AMOUNT_MISMATCH on that line and no TOTALS_MISMATCH.',
      'Charges: 2,850 (ocean freight) + 96 (insurance) + 1,214 (US duties/fees, estimate) + 420 (US inland) = 4,580. Base = 20,920. Each line: amount − 4,580 × amount / 20,920.',
      'Line 1: 4,440.00 − 972.05 = 3,467.95 → 3,468.',
      'Line 2: 4,860.00 − 1,064.00 = 3,796.00 → 3,796.',
      'Line 3: 8,220.00 − 1,799.60 = 6,420.40 → 6,420.',
      'Line 4: 3,400.00 − 744.36 = 2,655.64 → 2,656.',
      'Total entered value: 3,468 + 3,796 + 6,420 + 2,656 = 16,340 (= 20,920 − 4,580). USD, no conversion.',
      'Packing totals agree with the B/L: cartons 120 + 150 + 60 + 40 = 370; G.W. 1,620 + 2,475 + 840 + 400 = 5,335 kg (B/L 5,335.000 KGS); N.W. 4,830 kg; 58.60 CBM. The combined document is the packing list, so MISSING_DOCUMENT must not fire.',
      'Container ZSPU4182074 passes ISO 6346 (check digit 4). House B/L CXSVNGB26091187 → house SCAC CXSV + bill NGB26091187; master ZSPLNGB2609180 → master SCAC ZSPL + bill NGB2609180.',
      'Savannah = Schedule D port 1703; containerized vessel → mode 11. Invoice date SEP. 08, 2026 is unambiguous (month name); laden on board 15-SEP-2026.',
      'HTS 9403.60.80 (other wooden furniture, Free) and 4202.92.31 (travel/sports bags incl. backpacks, outer surface of man-made fibers, 17.6%) are real 2026 HTSUS 8-digit codes (cached in scripts/synthetic/reference/).',
      'Consignee on the B/L = buyer on the invoice, so ULTIMATE_CONSIGNEE_ASSUMED should not fire.',
    ],
    expect: {
      invoiceNumber: INVOICE_NO,
      invoiceNumberNormalized: INVOICE_NO,
      invoiceDate: '2026-09-08',
      currency: 'USD',
      incoterm: { code: 'DDP', place: 'Savannah, GA' },
      sellerName: SELLER.name,
      buyerName: BUYER.name,
      importerName: BUYER.name,
      transport: {
        mode: 'ocean',
        modeTransportation: '11',
        entryPort: '1703',
        containers: [CONTAINER],
        bills: [{ masterScac: 'ZSPL', masterBill: MBL.slice(4), houseScac: 'CXSV', houseBill: HBL.slice(4) }],
        grossWeightKg: GW,
      },
      lines: LINES.map((l, i) => ({
        lineNo: i + 1,
        styleNo: l.item,
        descriptionContains: MATCH[i],
        quantity: l.qty,
        unit: l.unit,
        unitPrice: l.price,
        printedAmount: l.printed,
        countryOfOrigin: 'CN',
        hs6: l.hs.replace(/\./g, '').slice(0, 6),
        hsPrinted: l.hs,
        enteredValue: ENTERED[i],
      })),
      totalEnteredValue: 16340,
      issuesInclude: ['LINE_AMOUNT_MISMATCH', 'NON_DUTIABLE_CHARGES'],
      issuesExclude: [
        'MISSING_DOCUMENT',
        'CHARGES_NOT_ITEMIZED',
        'TOTALS_MISMATCH',
        'CONTAINER_NUMBER_INVALID',
        'CONTAINER_NUMBER_CORRECTED',
        'HTS_NOT_DECLARED',
        'DATE_AMBIGUOUS',
        'GROSS_WEIGHT_MISMATCH',
        'PACKAGE_COUNT_MISMATCH',
        'ORIGIN_DIFFERS',
        'CURRENCY_CONVERSION',
        'INVOICE_NO_NORMALIZED',
        'NCV_VALUE',
        'ASSIST',
        'QTY_MISMATCH',
        'TELEX_RELEASE',
        'ULTIMATE_CONSIGNEE_ASSUMED',
      ],
    },
  },
};
