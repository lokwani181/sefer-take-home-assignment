/**
 * S5 — ocean, USD, CFR Savannah, triangular trade. A Singapore trading company invoices a
 * Columbus, OH retailer for footwear made by its Indonesian supplier (Tangerang, Banten); one
 * article was made at a sister factory in Vietnam (footnoted with that factory's address). The
 * invoice itemizes the ocean freight included in the CFR price, uses PRS units, YYYY.MM.DD dates
 * and puts the HTS code in the LAST column. The factory's packing list arrives as a JPEG phone
 * photo (≈2° rotation, uneven light, slight blur, ~1600 px wide). The NVOCC house B/L (text) prints
 * its SCAC separately from the house number and references the carrier's SCAC-prefixed master
 * B/L; Tanjung Priok → Singapore (transhipment) → Savannah, 1 x 40' GP, freight prepaid, ORIGINAL.
 */
import { fmtInt, fmtMoney, fmtNum, roundCents } from '../format.js';
import { esc, htmlDocument } from '../html/base.js';
import type { ShipmentSpec } from '../spec.js';
import { moneyWords } from '../words.js';

const SELLER = {
  name: 'STRAITSBRIDGE SOURCING PTE. LTD.',
  street: '80 Robinson Road, #17-02',
  city: 'Singapore 068898',
  ids: 'UEN 201734567K',
  contact: 'T +65 6221 4870 &nbsp;·&nbsp; orders@straitsbridge.com.sg',
};
const MAKER = {
  name: 'PT SEPATU NUSANTARA ABADI',
  street: 'Jl. Raya Serang Km. 12,5, Desa Bitung Jaya, Kec. Cikupa',
  city: 'Kab. Tangerang, Banten 15710, Indonesia',
  npwp: 'NPWP 02.417.336.5-451.000',
  phone: 'Telp. +62 21 5940 3318',
};
const SISTER = {
  name: 'NUSANTARA FOOTWEAR VIETNAM CO., LTD.',
  address: 'Lot C-7, Nhon Trach 3 Industrial Park, Hiep Phuoc Town, Nhon Trach District, Dong Nai Province, Vietnam',
};
const BUYER = {
  name: 'OLENTANGY RETAIL GROUP, INC.',
  street: '1850 Polaris Parkway',
  city: 'Columbus, OH 43240, USA',
  dc: 'Distribution Center, 4100 Alum Creek Drive, Columbus, OH 43207, USA',
  phone: '+1 614 555 0187',
};
const NVOCC = {
  brand: 'TRISAMUDRA',
  name: 'PT TRISAMUDRA GLOBAL LOGISTIK',
  address: 'Jl. Yos Sudarso Kav. 30, Sunter, Jakarta Utara 14350, Indonesia',
  scac: 'TSGL',
  oti: '029113N',
};

const INVOICE_NO = 'SB-2609-0233';
const INVOICE_DATE = '2026.09.11';
const ETD = '2026.09.19';
const ON_BOARD = '19 SEP 2026';
const PO = 'ORG-PO-55127';
const SC = 'SBS-SC-26-114';
const HBL = 'JKSAV260917';
const MBL = 'KRMLJKT260944718';
const CONTAINER = 'KRMU7182948';
const SEAL = 'KS2260917';
const FEEDER = { vessel: 'SELAT JAYA', voyage: '2638N' };
const MOTHER = { vessel: 'KARIMATA HORIZON', voyage: '112W' };
const FREIGHT = 4350;

interface S5Line {
  art: string;
  title: string;
  details: string[];
  hs: string;
  qty: number;
  price: number;
  origin: 'ID' | 'VN';
  match: string;
  sizes: string;
  /** Per-carton size assortment printed under the packing list. */
  assortment: string;
}

const LINES: S5Line[] = [
  {
    art: 'SNA-RN2208',
    title: "MEN'S RUNNING SHOE",
    details: ['Upper: engineered polyester mesh (textile); outsole: rubber; midsole: EVA', 'US sizes 7-12; colours Black/White, Navy/Grey'],
    hs: '6404.11.90',
    qty: 3600,
    price: 14.85,
    origin: 'ID',
    match: 'RUNNING SHOE',
    sizes: 'US 7-12',
    assortment: 'US 7(1) 8(2) 9(3) 10(3) 11(2) 12(1)',
  },
  {
    art: 'SNA-LW3105',
    title: "WOMEN'S LEATHER LOAFER",
    details: ['Upper: full-grain cow leather; outsole: rubber; does not cover the ankle', 'US sizes 5-10; colour Tan'],
    hs: '6403.99.90',
    qty: 1800,
    price: 21.4,
    origin: 'VN',
    match: 'LEATHER LOAFER',
    sizes: 'US 5-10',
    assortment: 'US 5(1) 6(2) 7(3) 8(3) 9(2) 10(1)',
  },
  {
    art: 'SNA-SL0410',
    title: 'UNISEX POOL SLIDE SANDAL',
    details: ['Strap: PVC (over 90% plastics); footbed: EVA; outsole: rubber', 'Sizes S-XL; colours Black, Pink'],
    hs: '6402.99.31',
    qty: 4800,
    price: 4.65,
    origin: 'ID',
    match: 'SLIDE SANDAL',
    sizes: 'S-XL',
    assortment: 'S(4) M(8) L(8) XL(4)',
  },
];

const AMOUNTS = LINES.map((l) => roundCents(l.qty * l.price));
const TOTAL = roundCents(AMOUNTS.reduce((s, a) => s + a, 0));
const FOB_VALUE = roundCents(TOTAL - FREIGHT);
const PAIRS = LINES.reduce((s, l) => s + l.qty, 0);

/** Packing-list rows: one per article colour, cartons numbered in this order. */
interface PackRow {
  line: number;
  colour: string;
  ctns: number;
  prsCtn: number;
  nwCtn: number;
  gwCtn: number;
  cbmCtn: number;
}
const PACK_ROWS: PackRow[] = [
  { line: 0, colour: 'BLACK/WHITE', ctns: 150, prsCtn: 12, nwCtn: 9.6, gwCtn: 11.2, cbmCtn: 0.098 },
  { line: 0, colour: 'NAVY/GREY', ctns: 150, prsCtn: 12, nwCtn: 9.6, gwCtn: 11.2, cbmCtn: 0.098 },
  { line: 1, colour: 'TAN', ctns: 150, prsCtn: 12, nwCtn: 10.8, gwCtn: 12.4, cbmCtn: 0.088 },
  { line: 2, colour: 'BLACK', ctns: 100, prsCtn: 24, nwCtn: 7.2, gwCtn: 8.3, cbmCtn: 0.072 },
  { line: 2, colour: 'PINK', ctns: 100, prsCtn: 24, nwCtn: 7.2, gwCtn: 8.3, cbmCtn: 0.072 },
];
const PACK = (() => {
  let next = 1;
  return PACK_ROWS.map((r) => {
    const from = next;
    next += r.ctns;
    return {
      ...r,
      from,
      to: next - 1,
      prs: r.ctns * r.prsCtn,
      nw: Math.round(r.ctns * r.nwCtn * 10) / 10,
      gw: Math.round(r.ctns * r.gwCtn * 10) / 10,
      cbm: Math.round(r.ctns * r.cbmCtn * 100) / 100,
    };
  });
})();
const CTNS = PACK.reduce((s, p) => s + p.ctns, 0);
const NW = Math.round(PACK.reduce((s, p) => s + p.nw, 0) * 10) / 10;
const GW = Math.round(PACK.reduce((s, p) => s + p.gw, 0) * 10) / 10;
const CBM = Math.round(PACK.reduce((s, p) => s + p.cbm, 0) * 100) / 100;
const VN_ROWS = PACK.filter((p) => LINES[p.line].origin === 'VN');
const VN_CTNS = `${VN_ROWS[0].from}-${VN_ROWS[VN_ROWS.length - 1].to}`;

function invoiceHtml(): string {
  const ink = '#1d3b53';
  const css = `
body { font-family: 'Gill Sans', 'Gill Sans MT', Calibri, sans-serif; font-size: 9.6pt; color: #1a1a1a; }
.pad { padding: 11mm 13mm 0 13mm; }
.hd { display: flex; justify-content: space-between; align-items: flex-start; }
.logo { display: flex; align-items: center; gap: 3mm; }
.mark { width: 13mm; height: 13mm; border: 0.8mm solid ${ink}; color: ${ink}; font-size: 15pt; font-weight: 600; display: flex; align-items: center; justify-content: center; transform: rotate(45deg); }
.mark span { transform: rotate(-45deg); }
.nm { font-size: 19pt; font-weight: 600; letter-spacing: 2.5pt; color: ${ink}; line-height: 1; }
.sub { font-size: 8.6pt; letter-spacing: 3.2pt; color: #555; margin-top: 1mm; }
.addr { text-align: right; font-size: 8.4pt; line-height: 1.4; color: #333; }
.tr { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 7mm; border-bottom: 0.5mm solid ${ink}; padding-bottom: 2mm; }
h1 { font-size: 21pt; font-weight: 400; letter-spacing: 1pt; color: ${ink}; }
table.ref td { padding: 0.3mm 0 0.3mm 4mm; font-size: 9pt; }
table.ref td.k { color: #666; text-align: right; }
table.ref td.v { font-weight: 600; }
.parties { display: flex; gap: 4mm; margin-top: 4mm; }
.pty { flex: 1; font-size: 8.9pt; line-height: 1.38; }
.pty .k { font-size: 7.6pt; letter-spacing: 1pt; text-transform: uppercase; color: ${ink}; border-bottom: 0.2mm solid #999; margin-bottom: 1mm; padding-bottom: 0.3mm; }
table.ship { width: 100%; margin-top: 4mm; table-layout: fixed; background: #f1f4f6; }
table.ship td { padding: 1.2mm 2mm; vertical-align: top; font-size: 8.9pt; line-height: 1.3; }
table.ship .k { display: block; font-size: 7.4pt; color: #5a6a77; letter-spacing: 0.5pt; }
table.it { width: 100%; margin-top: 4.5mm; table-layout: fixed; }
table.it th { font-size: 8pt; font-weight: 600; color: #fff; background: ${ink}; padding: 1.4mm 1.4mm; text-align: left; letter-spacing: 0.3pt; }
table.it th.r, table.it td.r { text-align: right; }
table.it td { padding: 2mm 1.4mm 2.4mm; vertical-align: top; border-bottom: 0.2mm solid #b9c3cb; line-height: 1.32; }
table.it td .t { font-weight: 600; }
table.it td .d { font-size: 8.4pt; color: #333; }
table.it td.nw { white-space: nowrap; }
.totals { display: flex; justify-content: space-between; margin-top: 3mm; }
.bk { width: 104mm; font-size: 8.8pt; border: 0.25mm solid #9aa7b1; padding: 1.6mm 2.4mm; line-height: 1.45; }
.bk .k { font-size: 7.6pt; letter-spacing: 0.8pt; color: ${ink}; text-transform: uppercase; }
.bk table { width: 100%; }
.bk td.r { text-align: right; white-space: nowrap; }
.bk tr.t td { border-top: 0.2mm solid #666; font-weight: 600; }
.gt { text-align: right; font-size: 10pt; }
.gt .amt { font-size: 15pt; font-weight: 600; color: ${ink}; }
.note { margin-top: 3.5mm; font-size: 8.5pt; line-height: 1.42; }
.note p { margin-bottom: 1.2mm; }
.sig { position: absolute; right: 14mm; bottom: 20mm; width: 72mm; font-size: 8.8pt; line-height: 1.4; }
.sig .hand { font-family: 'Bradley Hand', 'Apple Chancery', cursive; font-size: 17pt; color: #213a8f; margin: 1mm 0 -0.5mm 4mm; }
.sig .line { border-top: 0.25mm solid #333; padding-top: 0.8mm; }
.ft { position: absolute; left: 13mm; right: 13mm; bottom: 9mm; font-size: 7.4pt; color: #666; border-top: 0.2mm solid #bbb; padding-top: 1mm; }
`;
  const rows = LINES.map(
    (l, i) => `<tr>
      <td><div class="t">${esc(l.title)}${l.origin === 'VN' ? ' *' : ''}</div><div class="d">${l.details.map(esc).join('<br>')}</div></td>
      <td class="nw">${esc(l.art)}</td><td>PRS</td><td class="r nw">${fmtInt(l.qty)}</td>
      <td class="r nw">${fmtMoney(l.price)}</td><td class="r nw">${fmtMoney(AMOUNTS[i])}</td><td class="nw">${l.hs}</td></tr>`,
  ).join('');
  const body = `<div class="pad">
  <div class="hd">
    <div class="logo"><div class="mark"><span>SB</span></div><div><div class="nm">STRAITSBRIDGE</div><div class="sub">SOURCING PTE. LTD.</div></div></div>
    <div class="addr">${esc(SELLER.street)}<br>${esc(SELLER.city)}<br>${SELLER.ids}<br>${SELLER.contact}</div>
  </div>
  <div class="tr"><h1>Commercial Invoice</h1>
    <table class="ref">
      <tr><td class="k">Inv. Ref.</td><td class="v">${INVOICE_NO}</td><td class="k">Dated</td><td class="v">${INVOICE_DATE}</td></tr>
      <tr><td class="k">Your Order</td><td class="v">${PO}</td><td class="k">Our S/C</td><td class="v">${SC}</td></tr>
    </table></div>
  <div class="parties">
    <div class="pty"><div class="k">Invoiced to</div><b>${esc(BUYER.name)}</b><br>${esc(BUYER.street)}<br>${esc(BUYER.city)}<br>Tel ${BUYER.phone}</div>
    <div class="pty"><div class="k">Deliver to</div><b>${esc(BUYER.name)}</b><br>${esc(BUYER.dc)}</div>
    <div class="pty"><div class="k">Goods made &amp; shipped by</div><b>${esc(MAKER.name)}</b><br>${esc(MAKER.street)}<br>${esc(MAKER.city)}</div>
  </div>
  <table class="ship">
    <tr><td><span class="k">Delivery terms</span>CFR SAVANNAH, GA, USA<br>(Incoterms® 2020)</td><td><span class="k">Payment</span>T/T 60 days from B/L date</td>
      <td><span class="k">Port of loading</span>TANJUNG PRIOK, JAKARTA</td><td><span class="k">Transhipment</span>SINGAPORE</td></tr>
    <tr><td><span class="k">Port of discharge</span>SAVANNAH, GA, USA</td><td><span class="k">Vessel / voyage</span>${MOTHER.vessel} ${MOTHER.voyage}<br>(feeder ${FEEDER.vessel} ${FEEDER.voyage})</td>
      <td><span class="k">ETD Jakarta</span>${ETD}</td><td><span class="k">House B/L</span>${HBL}</td></tr>
  </table>
  <table class="it">
    <colgroup><col><col style="width:24mm"><col style="width:11mm"><col style="width:17mm"><col style="width:18mm"><col style="width:24mm"><col style="width:21mm"></colgroup>
    <tr><th>Description of Goods</th><th>Article</th><th>Unit</th><th class="r">Quantity</th><th class="r">Price (USD)</th><th class="r">Amount (USD)</th><th>HTS (US)</th></tr>
    ${rows}
  </table>
  <div class="totals">
    <div class="bk"><div class="k">Value breakdown (included in the CFR prices above)</div>
      <table>
        <tr><td>FOB value, Tanjung Priok</td><td class="r">USD ${fmtMoney(FOB_VALUE)}</td></tr>
        <tr><td>Ocean freight Tanjung Priok – Savannah via Singapore, 1 x 40' GP, prepaid</td><td class="r">USD ${fmtMoney(FREIGHT)}</td></tr>
        <tr class="t"><td>CFR value, Savannah</td><td class="r">USD ${fmtMoney(TOTAL)}</td></tr>
      </table></div>
    <div class="gt">Total ${fmtInt(PAIRS)} PRS<br>Total CFR Savannah<br><span class="amt">USD ${fmtMoney(TOTAL)}</span></div>
  </div>
  <div class="note">
    <p>Say: US Dollars ${moneyWords(TOTAL, { and: false }).toLowerCase()} only.</p>
    <p>* Article ${LINES[1].art} was manufactured at our supplier's sister factory ${SISTER.name}, ${esc(SISTER.address)}, and consolidated at Tangerang for this shipment. Country of origin of this article: VIETNAM.</p>
    <p>Country of origin: INDONESIA, except the article marked *. Packing: ${CTNS} cartons, N.W. ${fmtNum(NW, 1)} kg, G.W. ${fmtNum(GW, 1)} kg, ${fmtNum(CBM, 2)} m³, 1 x 40' GP.</p>
    <p>Remit to: Straits Commerce Bank Ltd, Raffles Place Branch, A/C 017-338204-1 (USD), SWIFT STCBSGSG.</p>
  </div>
  <div class="sig">For and on behalf of<br><b>${esc(SELLER.name)}</b><div class="hand">Tan Wei Ling</div><div class="line">Tan Wei Ling, Director</div></div>
  <div class="ft">${esc(SELLER.name)} · Registered in Singapore · ${SELLER.ids} · This invoice is computer generated and valid with the signature of an authorised officer.</div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

function packingListHtml(): string {
  const css = `
body { font-family: Tahoma, Verdana, sans-serif; font-size: 10pt; color: #111; }
.pad { padding: 12mm 12mm 0 13mm; }
.hd { display: flex; align-items: center; gap: 4mm; border-bottom: 0.7mm solid #111; padding-bottom: 2.5mm; }
.lg { width: 17mm; height: 17mm; border-radius: 50%; border: 0.8mm solid #8a1c1c; color: #8a1c1c; font-weight: bold; font-size: 14pt; display: flex; align-items: center; justify-content: center; }
.co b { font-size: 15pt; letter-spacing: 0.4pt; }
.co { font-size: 8.8pt; line-height: 1.35; }
h1 { text-align: center; font-size: 17pt; letter-spacing: 3pt; margin: 4mm 0 3mm; }
table.inf { width: 100%; font-size: 9.6pt; table-layout: fixed; }
table.inf td { padding: 0.8mm 1mm; vertical-align: top; }
table.inf td.k { width: 33mm; font-weight: bold; }
table.pk { width: 100%; margin-top: 4mm; table-layout: fixed; font-size: 9.4pt; }
table.pk th { border: 0.35mm solid #111; padding: 1.3mm 0.8mm; background: #e9e9e9; font-size: 8.4pt; text-align: center; line-height: 1.2; }
table.pk td { border: 0.3mm solid #111; padding: 1.6mm 1.2mm; text-align: center; }
table.pk td.l { text-align: left; }
table.pk td.r { text-align: right; }
table.pk tr.tot td { font-weight: bold; border-top: 0.6mm solid #111; }
.sm { margin-top: 3.5mm; font-size: 9pt; line-height: 1.45; }
.box { display: flex; gap: 6mm; margin-top: 4mm; }
.marks { border: 0.3mm solid #111; padding: 2mm 3mm; font-size: 9.4pt; line-height: 1.4; width: 70mm; }
.sig { margin-left: auto; width: 70mm; text-align: center; font-size: 9pt; }
.sig .hand { font-family: 'Noteworthy', 'Bradley Hand', cursive; font-size: 15pt; margin-top: 7mm; }
.sig .ln { border-top: 0.3mm solid #111; padding-top: 1mm; }
`;
  const rows = PACK.map((p) => {
    const l = LINES[p.line];
    return `<tr><td>${p.from} - ${p.to}</td><td class="l">${esc(l.art)}${l.origin === 'VN' ? ' *' : ''}</td><td class="l">${p.colour}</td><td>${l.sizes}</td>
      <td>${p.ctns}</td><td>${p.prsCtn}</td><td class="r">${fmtInt(p.prs)}</td><td class="r">${fmtNum(p.nw, 1)}</td><td class="r">${fmtNum(p.gw, 1)}</td><td class="r">${fmtNum(p.cbm, 2)}</td></tr>`;
  }).join('');
  const body = `<div class="pad">
  <div class="hd"><div class="lg">SNA</div>
    <div class="co"><b>${MAKER.name}</b><br>FOOTWEAR MANUFACTURER &amp; EXPORTER<br>${esc(MAKER.street)}, ${esc(MAKER.city)}<br>${MAKER.npwp} &nbsp; ${MAKER.phone}</div></div>
  <h1>PACKING LIST</h1>
  <table class="inf">
    <tr><td class="k">PL No.</td><td>SNA/PL/2609/087</td><td class="k">Date</td><td>${INVOICE_DATE}</td></tr>
    <tr><td class="k">Invoice Ref.</td><td>${INVOICE_NO}<br>(${esc(SELLER.name)})</td><td class="k">Buyer PO</td><td>${PO}</td></tr>
    <tr><td class="k">Buyer</td><td colspan="3">${esc(BUYER.name)}, ${esc(BUYER.street)}, ${esc(BUYER.city)}</td></tr>
    <tr><td class="k">Vessel</td><td>${MOTHER.vessel} ${MOTHER.voyage}</td><td class="k">From / To</td><td>TANJUNG PRIOK / SAVANNAH, GA</td></tr>
    <tr><td class="k">Container / Seal</td><td>${CONTAINER} / ${SEAL}</td><td class="k">Type</td><td>1 x 40' GP</td></tr>
  </table>
  <table class="pk">
    <colgroup><col style="width:19mm"><col style="width:26mm"><col><col style="width:17mm"><col style="width:12mm"><col style="width:13mm"><col style="width:17mm"><col style="width:18mm"><col style="width:18mm"><col style="width:14mm"></colgroup>
    <tr><th>C/No.</th><th>Article</th><th>Colour</th><th>Size</th><th>Ctns</th><th>Prs /<br>Ctn</th><th>Total<br>Prs</th><th>N.W.<br>(kg)</th><th>G.W.<br>(kg)</th><th>CBM</th></tr>
    ${rows}
    <tr class="tot"><td colspan="4">TOTAL</td><td>${CTNS}</td><td></td><td class="r">${fmtInt(PAIRS)}</td><td class="r">${fmtNum(NW, 1)}</td><td class="r">${fmtNum(GW, 1)}</td><td class="r">${fmtNum(CBM, 2)}</td></tr>
  </table>
  <div class="sm">Size assortment per carton:<br>${LINES.map((l) => `${esc(l.art)}: ${l.assortment}`).join('<br>')}<br>
    * C/No. ${VN_CTNS} (${esc(LINES[1].art)}) made in VIETNAM by ${SISTER.name}; cartons side-marked MADE IN VIETNAM.</div>
  <div class="box">
    <div class="marks"><b>SHIPPING MARKS</b><br>OLENTANGY<br>PO ${PO}<br>SAVANNAH, GA<br>ART. NO. / COLOUR / SIZE<br>C/NO. 1-${CTNS}<br>MADE IN INDONESIA</div>
    <div class="sig">${MAKER.name}<div class="hand">Rina Wulandari</div><div class="ln">Rina Wulandari<br>Export Supervisor</div></div>
  </div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

function houseBlHtml(): string {
  const plum = '#5a2a64';
  const css = `
body { font-family: 'Lucida Grande', 'Lucida Sans Unicode', sans-serif; font-size: 8.6pt; }
.pad { padding: 9mm 10mm 0 10mm; }
.lab { font-family: 'Avenir Next Condensed', 'Arial Narrow', sans-serif; font-size: 7pt; color: ${plum}; text-transform: uppercase; letter-spacing: 0.4pt; display: block; margin-bottom: 0.6mm; }
.top { display: flex; justify-content: space-between; align-items: flex-start; }
.br { display: flex; gap: 3mm; align-items: center; }
.waves { width: 16mm; height: 12mm; display: flex; flex-direction: column; justify-content: space-between; }
.waves i { display: block; height: 2.2mm; background: ${plum}; border-radius: 2mm; }
.waves i:nth-child(2) { margin-left: 2.5mm; }
.waves i:nth-child(3) { margin-left: 5mm; }
.bn { font-family: 'Avenir Next Condensed', 'Arial Narrow', sans-serif; font-weight: 700; font-size: 21pt; color: ${plum}; letter-spacing: 1.5pt; line-height: 1; }
.bs { font-size: 7.4pt; color: #333; line-height: 1.35; margin-top: 0.8mm; }
.rt { text-align: right; }
.rt .t { font-size: 13.5pt; font-weight: bold; letter-spacing: 0.5pt; }
.rt .s { font-size: 7pt; color: #444; }
.orig { font-family: 'Avenir Next Condensed', 'Arial Narrow', sans-serif; font-size: 22pt; font-weight: 700; letter-spacing: 6pt; color: transparent; -webkit-text-stroke: 0.35mm #111; margin-top: 1mm; }
table.g { width: 100%; table-layout: fixed; margin-top: 2.5mm; }
table.g td { border: 0.3mm solid ${plum}; padding: 1.2mm 1.6mm; vertical-align: top; line-height: 1.32; }
.hb { font-size: 12.5pt; font-weight: bold; letter-spacing: 0.4pt; }
table.cg { width: 100%; table-layout: fixed; margin-top: -0.3mm; }
table.cg th { border: 0.3mm solid ${plum}; padding: 1mm 1.4mm; text-align: left; vertical-align: top; font-weight: normal; }
table.cg td { border-left: 0.3mm solid ${plum}; border-right: 0.3mm solid ${plum}; border-bottom: 0.3mm solid ${plum}; padding: 1.8mm 1.6mm; vertical-align: top; line-height: 1.38; height: 72mm; }
table.cg td.r { text-align: right; }
.hdr { background: #efe7f1; text-align: center; font-size: 7.4pt; padding: 0.9mm; border: 0.3mm solid ${plum}; border-bottom: none; margin-top: 2mm; letter-spacing: 0.4pt; }
.legal { font-size: 6.2pt; color: #333; line-height: 1.3; }
.hand { font-family: 'SignPainter', 'Snell Roundhand', cursive; font-size: 17pt; color: #22306e; }
`;
  const body = `<div class="pad">
  <div class="top">
    <div class="br"><div class="waves"><i></i><i></i><i></i></div>
      <div><div class="bn">${NVOCC.brand}</div><div class="bs">${NVOCC.name}<br>${esc(NVOCC.address)}<br>NVOCC · FMC OTI No. ${NVOCC.oti} · SCAC ${NVOCC.scac}</div></div></div>
    <div class="rt"><div class="t">HOUSE BILL OF LADING</div><div class="s">MULTIMODAL TRANSPORT OR PORT TO PORT SHIPMENT · NOT NEGOTIABLE UNLESS CONSIGNED "TO ORDER"</div><div class="orig">ORIGINAL</div></div>
  </div>
  <table class="g">
    <colgroup><col style="width:50%"><col style="width:25%"><col style="width:25%"></colgroup>
    <tr><td rowspan="2" style="height:25mm"><span class="lab">Shipper</span>${MAKER.name}<br>JL. RAYA SERANG KM. 12,5, CIKUPA, TANGERANG<br>BANTEN 15710, INDONESIA<br>O/B ${SELLER.name}, SINGAPORE</td>
      <td colspan="2"><span class="lab">HB/L No.</span><span class="hb">${HBL}</span></td></tr>
    <tr><td><span class="lab">Shipper's Reference</span>INV ${INVOICE_NO}<br>PO ${PO}</td><td><span class="lab">Number of Original HB/L</span>3 (THREE)</td></tr>
    <tr><td rowspan="2" style="height:22mm"><span class="lab">Consignee</span>${BUYER.name}<br>${BUYER.street.toUpperCase()}<br>COLUMBUS, OH 43240, USA<br>TEL ${BUYER.phone}</td>
      <td colspan="2"><span class="lab">Ocean Carrier / Master B/L No.</span>KARIMATA LINES (SCAC KRML)<br>${MBL}</td></tr>
    <tr><td colspan="2"><span class="lab">Delivery Agent at Destination</span>COASTAL EMPIRE CARGO SERVICES LLC<br>1 DIAMOND CAUSEWAY, SAVANNAH, GA 31406, USA</td></tr>
    <tr><td style="height:17mm"><span class="lab">Notify Party</span>SAME AS CONSIGNEE<br>ATTN: IMPORT DEPT., ${BUYER.phone}</td>
      <td colspan="2"><span class="lab">Freight Payable at / Terms</span>JAKARTA — FREIGHT PREPAID<br>MOVE TYPE: CY / CY</td></tr>
  </table>
  <table class="g" style="margin-top:-0.3mm">
    <colgroup><col style="width:18%"><col style="width:15%"><col style="width:19%"><col style="width:14%"><col style="width:18%"><col style="width:16%"></colgroup>
    <tr><td><span class="lab">Pre-carriage (feeder)</span>${FEEDER.vessel}<br>V. ${FEEDER.voyage}</td><td><span class="lab">Place of Receipt</span>JAKARTA CY</td>
      <td><span class="lab">Port of Loading</span>JAKARTA (TANJUNG PRIOK), INDONESIA</td><td><span class="lab">Port of Transhipment</span>SINGAPORE</td>
      <td><span class="lab">Ocean Vessel / Voy.</span>${MOTHER.vessel}<br>V. ${MOTHER.voyage}</td><td><span class="lab">Port of Discharge</span>SAVANNAH, GA, USA</td></tr>
    <tr><td colspan="2"><span class="lab">Place of Delivery</span>SAVANNAH, GA, USA (CY)</td><td colspan="2"><span class="lab">Final Destination (for information)</span>COLUMBUS, OH, USA</td>
      <td colspan="2"><span class="lab">Shipped on Board Date</span>${ON_BOARD}</td></tr>
  </table>
  <div class="hdr">PARTICULARS DECLARED BY THE SHIPPER — NOT CHECKED BY THE CARRIER</div>
  <table class="cg">
    <colgroup><col style="width:27%"><col style="width:12%"><col style="width:37%"><col style="width:12%"><col style="width:12%"></colgroup>
    <tr><th><span class="lab">Marks &amp; Nos. / Container &amp; Seal</span></th><th><span class="lab">Packages</span></th><th><span class="lab">Description of Goods (said to contain)</span></th><th><span class="lab">Gross Weight (kg)</span></th><th><span class="lab">Measurement (m³)</span></th></tr>
    <tr><td>CONTAINER: ${CONTAINER}<br>SEAL: ${SEAL}<br>SIZE/TYPE: 40' GP<br><br>OLENTANGY<br>PO ${PO}<br>SAVANNAH, GA<br>C/NO. 1-${CTNS}<br>MADE IN INDONESIA<br>MADE IN VIETNAM</td>
      <td>${CTNS} CARTONS</td>
      <td>1 X 40' GP FCL, SHIPPER'S LOAD, STOW, WEIGHT AND COUNT<br>SAID TO CONTAIN:<br>${CTNS} CARTONS (${fmtInt(PAIRS)} PAIRS) OF FOOTWEAR<br>MEN'S RUNNING SHOES (TEXTILE UPPERS)<br>WOMEN'S LEATHER LOAFERS<br>UNISEX SLIDE SANDALS<br>HS 6404.11 / 6403.99 / 6402.99<br>INVOICE ${INVOICE_NO}<br><br>FREIGHT PREPAID<br>ORIGINAL B/L REQUIRED FOR RELEASE</td>
      <td class="r">${fmtNum(GW, 3)}</td><td class="r">${fmtNum(CBM, 3)}</td></tr>
  </table>
  <table class="g" style="margin-top:2mm">
    <colgroup><col style="width:34%"><col style="width:33%"><col style="width:33%"></colgroup>
    <tr><td><span class="lab">Total No. of Containers / Packages (in words)</span>ONE (1) CONTAINER ONLY — SIX HUNDRED FIFTY (${CTNS}) CARTONS</td>
      <td><span class="lab">Freight &amp; Charges</span>OCEAN FREIGHT: PREPAID<br>ORIGIN THC: PREPAID<br>DESTINATION CHARGES: AS PER TARIFF</td>
      <td><span class="lab">Place and Date of Issue</span>JAKARTA, ${ON_BOARD}</td></tr>
    <tr><td colspan="2" class="legal">RECEIVED by the Carrier in apparent good order and condition, unless otherwise noted, the total number of containers or packages stated above, for carriage from the place of receipt or port of loading to the port of discharge or place of delivery, subject to the terms and conditions of the Carrier's standard house bill of lading. In witness whereof the number of original bills of lading stated above have been signed, one of which being accomplished, the others to stand void. One original bill of lading, duly endorsed, must be surrendered in exchange for the goods.</td>
      <td style="height:24mm"><span class="lab">Signed as Carrier</span>${NVOCC.name}<br><span class="hand">Hendra S.</span></td></tr>
  </table>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

/** Entered values: CFR line amount − itemized ocean freight prorated by value (see notes). */
const ENTERED = [51425, 37054, 21471];

export const s5: ShipmentSpec = {
  id: 's5-id-footwear-cfr',
  valuation: { lineAmounts: AMOUNTS, includedNonDutiableCharges: FREIGHT },
  docs: [
    {
      file: `Invoice_${INVOICE_NO}.pdf`,
      docType: 'commercial_invoice',
      variant: 'text',
      format: 'A4',
      pages: 1,
      html: invoiceHtml(),
      meta: { title: `Commercial Invoice ${INVOICE_NO}`, author: SELLER.name },
      keyTokens: [
        INVOICE_NO,
        INVOICE_DATE,
        PO,
        'CFR SAVANNAH',
        ...LINES.map((l) => l.art),
        ...LINES.map((l) => l.hs),
        ...LINES.map((l) => fmtInt(l.qty)),
        ...LINES.map((l) => fmtMoney(l.price)),
        ...AMOUNTS.map((a) => fmtMoney(a)),
        fmtMoney(TOTAL),
        fmtMoney(FREIGHT),
        fmtMoney(FOB_VALUE),
        'NUSANTARA FOOTWEAR VIETNAM',
        'VIETNAM',
        HBL,
      ],
    },
    {
      file: 'IMG_20260912_101734.jpg',
      docType: 'packing_list',
      variant: 'photo',
      format: 'A4',
      pages: 1,
      html: packingListHtml(),
      meta: { title: 'Packing list photo', author: MAKER.name },
      keyTokens: [
        'PACKING LIST',
        INVOICE_NO,
        INVOICE_DATE,
        PO,
        CONTAINER,
        SEAL,
        ...LINES.map((l) => l.art),
        ...PACK.map((p) => fmtInt(p.prs)),
        ...PACK.map((p) => fmtNum(p.gw, 1)),
        fmtInt(PAIRS),
        String(CTNS),
        fmtNum(NW, 1),
        fmtNum(GW, 1),
        fmtNum(CBM, 2),
        'VIETNAM',
        'OLENTANGY',
        'SAVANNAH',
      ],
      photo: {
        seed: 's5-pl-photo',
        dpi: 200,
        frameWidth: 1600,
        frameHeight: 2133,
        paperWidth: 1440,
        rotateDeg: 2.1,
        offset: [10, -8],
        paper: [251, 249, 243],
        desk: [124, 101, 78],
        gradient: 0.16,
        vignette: 0.22,
        tint: [1.0, 0.975, 0.92],
        blurSigma: 0.8,
        noiseSigma: 4,
        jpegQuality: 80,
        density: 72,
        stamps: [
          {
            cxMm: 160,
            cyMm: 236,
            wMm: 34,
            hMm: 34,
            angleDeg: -14,
            frame: 'round',
            arcText: 'PT SEPATU NUSANTARA ABADI',
            color: '#3b3fa8',
            opacity: 0.7,
            lines: [{ text: 'TANGERANG', sizeMm: 3, bold: true }],
          },
        ],
      },
    },
    {
      file: `HBL_${HBL}.pdf`,
      docType: 'bill_of_lading',
      variant: 'text',
      format: 'A4',
      pages: 1,
      html: houseBlHtml(),
      meta: { title: `House B/L ${HBL}`, author: NVOCC.name },
      keyTokens: [
        HBL,
        NVOCC.scac,
        MBL,
        CONTAINER,
        SEAL,
        fmtNum(GW, 3),
        fmtNum(CBM, 3),
        `${CTNS} CARTONS`,
        MOTHER.vessel,
        MOTHER.voyage,
        FEEDER.vessel,
        'TANJUNG',
        'SINGAPORE',
        'SAVANNAH, GA',
        ON_BOARD,
        INVOICE_NO,
        'FREIGHT PREPAID',
        'ORIGINAL',
      ],
    },
  ],
  expected: {
    id: 's5-id-footwear-cfr',
    description:
      'Footwear made in Tangerang, Indonesia (one article at a sister factory in Vietnam), sold by a Singapore trading company to a Columbus, OH retailer, CFR Savannah. Text invoice (Gill Sans, YYYY.MM.DD dates, PRS units, HTS in the last column, itemized ocean freight inside the CFR price, footnoted Vietnam-origin line); the factory packing list is a JPEG phone photo (2.1° rotation, uneven light, slight blur, 1600 px wide, per-colour rows); NVOCC house B/L (text) with its SCAC printed apart from the house number and an SCAC-prefixed master B/L, Tanjung Priok via Singapore to Savannah, 1 x 40\' GP, freight prepaid, ORIGINAL.',
    notes: [
      `Valuation policy: CFR Savannah — the line prices include ocean freight to Savannah, which the invoice itemizes ("Value breakdown (included in the CFR prices above)": FOB value ${fmtMoney(FOB_VALUE)} + ocean freight ${fmtMoney(FREIGHT)} = CFR ${fmtMoney(TOTAL)}). International freight is non-dutiable and is deducted, prorated by line value. No insurance (CFR), no assists, no NCV lines.`,
      `Line amounts: 3,600 PRS × 14.85 = 53,460.00; 1,800 PRS × 21.40 = 38,520.00; 4,800 PRS × 4.65 = 22,320.00. Sum ${fmtMoney(TOTAL)} = printed total. All lines reconcile.`,
      `Each line: amount − ${fmtMoney(FREIGHT)} × amount / ${fmtMoney(TOTAL)}.`,
      'Line 1: 53,460.00 − 2,034.57 = 51,425.43 → 51,425.',
      'Line 2: 38,520.00 − 1,465.98 = 37,054.02 → 37,054.',
      'Line 3: 22,320.00 − 849.45 = 21,470.55 → 21,471.',
      `Total entered value: 51,425 + 37,054 + 21,471 = 109,950 (= FOB value ${fmtMoney(FOB_VALUE)} printed in the breakdown). USD, no conversion.`,
      'HTS (real 2026 HTSUS 8-digit codes, cached in scripts/synthetic/reference/): 6404.11.90 sports footwear with rubber soles and textile uppers valued over $12/pair (20%) — the entered value per pair is 51,425.43 / 3,600 = 14.28, still over $12 after the freight deduction; 6403.99.90 leather-upper footwear not covering the ankle, for persons other than men, valued over $2.50/pair (10%); 6402.99.31 rubber/plastic-upper footwear (uppers over 90% plastics), not one-piece molded, other (6%).',
      `Origin: header says INDONESIA "except the article marked *"; line 2 (${LINES[1].art}, women's leather loafer) is footnoted as made by ${SISTER.name}, ${SISTER.address} → line 2 COO VN, ORIGIN_DIFFERS; its MID must come from the Vietnamese factory. Lines 1 and 3 COO ID (manufacturer ${MAKER.name}, Tangerang). Country of export is Indonesia for all lines.`,
      `Seller ${SELLER.name} (Singapore) is a trading company, not the manufacturer (invoice box "Goods made & shipped by" = ${MAKER.name}; the B/L shipper is the factory "O/B" the trader) → SELLER_NOT_MANUFACTURER. A FIRST_SALE_OPPORTUNITY advisory is plausible but not asserted.`,
      `Packing list (JPEG photo, factory-issued) rows are per colour: SNA-RN2208 1,800 + 1,800 PRS, SNA-LW3105 1,800 PRS, SNA-SL0410 2,400 + 2,400 PRS; per-article sums equal the invoice quantities, so QTY_MISMATCH must not fire. Totals ${CTNS} cartons, ${fmtInt(PAIRS)} PRS, N.W. ${fmtNum(NW, 1)} kg, G.W. ${fmtNum(GW, 1)} kg, ${fmtNum(CBM, 2)} m³; the B/L agrees (${CTNS} CARTONS, ${fmtNum(GW, 3)} kg, ${fmtNum(CBM, 3)} m³).`,
      `House B/L: the house number ${HBL} is printed without a prefix and the NVOCC SCAC ${NVOCC.scac} is printed separately in the letterhead → houseScac ${NVOCC.scac} + houseBill ${HBL}. Master ${MBL} → master SCAC KRML + bill ${MBL.slice(4)}. Both bills present → HOUSE_MASTER_BILL.`,
      `Container ${CONTAINER} passes ISO 6346 (check digit 8), seal ${SEAL}, 40' GP. Routing Jakarta (Tanjung Priok) → Singapore (transhipment) → Savannah; discharge SAVANNAH, GA → Schedule D 1703, containerized vessel → mode 11. The final destination COLUMBUS, OH is for information only.`,
      `Dates: invoice ${INVOICE_DATE} and ETD ${ETD} are year-first YYYY.MM.DD (unambiguous: no one writes YYYY.DD.MM), so DATE_AMBIGUOUS must not fire. B/L shipped on board ${ON_BOARD}.`,
      'Freight PREPAID and an ORIGINAL house B/L (3 originals, "ORIGINAL B/L REQUIRED FOR RELEASE"); no telex release, so TELEX_RELEASE must not fire. Consignee = invoice buyer (OLENTANGY RETAIL GROUP, INC.).',
    ],
    expect: {
      invoiceNumber: INVOICE_NO,
      invoiceNumberNormalized: INVOICE_NO,
      invoiceDate: '2026-09-11',
      currency: 'USD',
      incoterm: { code: 'CFR', place: 'Savannah, GA' },
      sellerName: SELLER.name,
      buyerName: BUYER.name,
      importerName: BUYER.name,
      ultimateConsigneeName: BUYER.name,
      transport: {
        mode: 'ocean',
        modeTransportation: '11',
        entryPort: '1703',
        containers: [CONTAINER],
        bills: [{ masterScac: 'KRML', masterBill: MBL.slice(4), houseScac: NVOCC.scac, houseBill: HBL }],
        grossWeightKg: GW,
      },
      lines: LINES.map((l, i) => ({
        lineNo: i + 1,
        styleNo: l.art,
        descriptionContains: l.match,
        quantity: l.qty,
        unit: 'PRS',
        unitPrice: l.price,
        printedAmount: AMOUNTS[i],
        countryOfOrigin: l.origin,
        hs6: l.hs.replace(/\./g, '').slice(0, 6),
        hsPrinted: l.hs,
        enteredValue: ENTERED[i],
      })),
      totalEnteredValue: ENTERED.reduce((s, v) => s + v, 0),
      issuesInclude: ['NON_DUTIABLE_CHARGES', 'ORIGIN_DIFFERS', 'SELLER_NOT_MANUFACTURER', 'HOUSE_MASTER_BILL'],
      issuesExclude: [
        'MISSING_DOCUMENT',
        'CHARGES_NOT_ITEMIZED',
        'LINE_AMOUNT_MISMATCH',
        'TOTALS_MISMATCH',
        'CONTAINER_NUMBER_INVALID',
        'CONTAINER_NUMBER_CORRECTED',
        'HTS_NOT_DECLARED',
        'DATE_AMBIGUOUS',
        'CURRENCY_CONVERSION',
        'INVOICE_NO_NORMALIZED',
        'BILL_NO_NORMALIZED',
        'NCV_VALUE',
        'ASSIST',
        'QTY_MISMATCH',
        'GROSS_WEIGHT_MISMATCH',
        'PACKAGE_COUNT_MISMATCH',
        'TELEX_RELEASE',
        'COLLECT_CHARGES',
        'ULTIMATE_CONSIGNEE_ASSUMED',
      ],
    },
  },
};
