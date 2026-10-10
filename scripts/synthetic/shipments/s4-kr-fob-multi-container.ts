/**
 * S4 — ocean, USD, FOB Busan, two 40' HC containers, master B/L only. A Korean small-appliance
 * maker (Incheon) sells to a Los Angeles importer under a letter of credit. The invoice uses the
 * Korean trade-form layout (circled box numbers, "For Account & Risk of Messrs.", "Invoice No. &
 * Date", "L/C No.", "Terms of Price", "Shipped per", "Sailing on or about", "From / To"), a
 * marks column, a group caption row, Model No. and H.S. Code columns, quantity and unit in one
 * cell, and a 3 % volume discount. Its item table runs onto page 2 WITHOUT a repeated header.
 * A separate text packing list carries a Container/Seal table; the carrier's master B/L is a scan
 * (consigned "to the order of" the L/C bank) with a blue SHIPPED ON BOARD stamp.
 */
import { fmtInt, fmtMoney, fmtNum, roundCents } from '../format.js';
import { esc, htmlDocument } from '../html/base.js';
import type { ShipmentSpec } from '../spec.js';
import { moneyWords } from '../words.js';

const SELLER = {
  name: 'MIRAEON HOME ELECTRIC CO., LTD.',
  ko: '미래온홈일렉트릭 주식회사',
  street: '88, Namdongseo-ro 236beon-gil, Namdong-gu',
  city: 'Incheon 21633, Republic of Korea',
  contact: 'TEL +82-32-818-4470 &nbsp; FAX +82-32-818-4471 &nbsp; export@miraeon-he.co.kr',
  bizNo: 'Business Reg. No. 131-86-40217',
};
const BUYER = {
  name: 'GOLDLINE HOUSEWARES CORP.',
  street: '2455 E. 37th Street',
  city: 'Los Angeles, CA 90058, U.S.A.',
  phone: 'TEL +1 323 555 0172',
};
const BANK = { name: 'CORONADO TRUST BANK', branch: 'LOS ANGELES MAIN OFFICE, CA, U.S.A.' };

const INVOICE_NO = 'MRH-260914-07';
const INVOICE_DATE = 'SEP. 14, 2026';
const LC_NO = 'ILC-2608-04417';
const LC_DATE = 'AUG. 21, 2026';
const PO = 'GL-PO-26-0388';
const VESSEL = 'HANNURI PROSPERITY';
const VOYAGE = '026E';
const SAILING = 'SEP. 19, 2026';
const MBL = 'HNRLPUSA26091742';
const BOOKING = 'PUSA2609174';
const DISCOUNT_PCT = 3;

interface S4Line {
  model: string;
  title: string;
  details: string[];
  hs: string;
  qty: number;
  unit: 'SETS' | 'PCS';
  price: number;
  match: string;
  /** Packing: units per carton and per-carton weights/volume. */
  perCtn: number;
  nwCtn: number;
  gwCtn: number;
  cbmCtn: number;
  ctnSize: string;
}

const LINES: S4Line[] = [
  {
    model: 'MRE-BL1500',
    title: 'HIGH-SPEED BLENDER 1500W',
    details: ['2.0 L Tritan jar + two 600 ml to-go cups per set', '8-speed dial with pulse, 120V / 60Hz, UL listed', 'Colour: matte black, colour gift box'],
    hs: '8509.40.00',
    qty: 1440,
    unit: 'SETS',
    price: 31.8,
    match: 'HIGH-SPEED BLENDER',
    perCtn: 4,
    nwCtn: 16.4,
    gwCtn: 18.2,
    cbmCtn: 0.072,
    ctnSize: '62 x 40 x 29 cm',
  },
  {
    model: 'MRE-CV2510',
    title: 'COUNTERTOP CONVECTION OVEN 25L',
    details: ['4 heating elements, convection fan, rotisserie spit', '60-min timer, 1700W, 120V / 60Hz, ETL listed', 'Stainless steel housing, colour gift box'],
    hs: '8516.60.40',
    qty: 720,
    unit: 'PCS',
    price: 54.2,
    match: 'CONVECTION OVEN',
    perCtn: 1,
    nwCtn: 8.6,
    gwCtn: 10.1,
    cbmCtn: 0.068,
    ctnSize: '56 x 44 x 27.6 cm',
  },
  {
    model: 'MRE-CM1200',
    title: '12-CUP PROGRAMMABLE DRIP COFFEE MAKER',
    details: ['Glass carafe, keep-warm plate, 24-hour timer', '900W, 120V / 60Hz, UL listed', 'Colour: black / silver, colour gift box'],
    hs: '8516.71.00',
    qty: 1944,
    unit: 'PCS',
    price: 18.6,
    match: 'DRIP COFFEE MAKER',
    perCtn: 6,
    nwCtn: 13.8,
    gwCtn: 15.6,
    cbmCtn: 0.061,
    ctnSize: '58 x 42 x 25 cm',
  },
  {
    model: 'MRE-PR0610',
    title: 'ELECTRIC PRESSURE RICE COOKER 6-CUP',
    details: ['Induction heating, non-stick inner pot', 'English voice guide, 1090W, 120V / 60Hz, UL listed', 'Colour: white / rose gold, colour gift box'],
    hs: '8516.79.00',
    qty: 1200,
    unit: 'PCS',
    price: 46.4,
    match: 'RICE COOKER',
    perCtn: 2,
    nwCtn: 10.4,
    gwCtn: 12.0,
    cbmCtn: 0.054,
    ctnSize: '50 x 36 x 30 cm',
  },
];

const AMOUNTS = LINES.map((l) => roundCents(l.qty * l.price));
const SUBTOTAL = roundCents(AMOUNTS.reduce((s, a) => s + a, 0));
const DISCOUNT = roundCents((SUBTOTAL * DISCOUNT_PCT) / 100);
const NET_TOTAL = roundCents(SUBTOTAL - DISCOUNT);
const SETS = LINES.filter((l) => l.unit === 'SETS').reduce((s, l) => s + l.qty, 0);
const PCS = LINES.filter((l) => l.unit === 'PCS').reduce((s, l) => s + l.qty, 0);

/** Packing per model: carton numbers run consecutively in invoice order. */
const PACK = (() => {
  let next = 1;
  return LINES.map((l) => {
    const ctns = l.qty / l.perCtn;
    if (!Number.isInteger(ctns)) throw new Error(`${l.model}: qty not a multiple of units per carton`);
    const from = next;
    next += ctns;
    return {
      ctns,
      from,
      to: next - 1,
      nw: Math.round(ctns * l.nwCtn * 100) / 100,
      gw: Math.round(ctns * l.gwCtn * 100) / 100,
      cbm: Math.round(ctns * l.cbmCtn * 1000) / 1000,
    };
  });
})();
const CTNS = PACK.reduce((s, p) => s + p.ctns, 0);
const NW = Math.round(PACK.reduce((s, p) => s + p.nw, 0) * 100) / 100;
const GW = Math.round(PACK.reduce((s, p) => s + p.gw, 0) * 100) / 100;
const CBM = Math.round(PACK.reduce((s, p) => s + p.cbm, 0) * 1000) / 1000;

/**
 * Container stuffing: blenders are split across both boxes so each 40' HC holds ~63 CBM.
 * Each entry: [line index, number of cartons], cartons taken in carton-number order.
 */
const STUFFING: [number, number][][] = [
  [
    [0, 200],
    [1, 720],
  ],
  [
    [0, 160],
    [2, 324],
    [3, 600],
  ],
];
const CONTAINERS = [
  { no: 'HNRU4120679', seal: 'HN6204417' },
  { no: 'HNRU4188534', seal: 'HN6204418' },
].map((c, ci) => {
  const used = new Map<number, number>();
  for (const box of STUFFING.slice(0, ci)) for (const [li, n] of box) used.set(li, (used.get(li) ?? 0) + n);
  const ranges: string[] = [];
  let ctns = 0;
  let nw = 0;
  let gw = 0;
  let cbm = 0;
  let open: [number, number] | undefined;
  for (const [li, n] of STUFFING[ci]) {
    const start = PACK[li].from + (used.get(li) ?? 0);
    if (open && open[1] + 1 === start) open[1] = start + n - 1;
    else {
      if (open) ranges.push(`${open[0]}-${open[1]}`);
      open = [start, start + n - 1];
    }
    ctns += n;
    nw += n * LINES[li].nwCtn;
    gw += n * LINES[li].gwCtn;
    cbm += n * LINES[li].cbmCtn;
  }
  if (open) ranges.push(`${open[0]}-${open[1]}`);
  return { ...c, ranges, ctns, nw: Math.round(nw * 100) / 100, gw: Math.round(gw * 100) / 100, cbm: Math.round(cbm * 1000) / 1000 };
});

const MARKS = ['GOLDLINE', 'LONG BEACH', `P/O NO. ${PO}`, 'MODEL NO.:', `C/T NO. 1-${fmtInt(CTNS)}`, 'MADE IN KOREA'];

const FORM_CSS = `
body { font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', Arial, sans-serif; font-size: 9pt; }
.pad { padding: 10mm 11mm 0 12mm; }
.co { text-align: center; line-height: 1.3; }
.co .en { font-size: 15pt; font-weight: 800; letter-spacing: 0.4pt; }
.co .ko { font-size: 10pt; font-weight: 600; color: #333; }
.co .ad { font-size: 8pt; color: #222; }
.ttl { text-align: center; font-size: 17pt; font-weight: 800; letter-spacing: 5pt; margin: 3mm 0 2.5mm; }
table.form { width: 100%; table-layout: fixed; }
table.form td { border: 0.35mm solid #111; padding: 1mm 1.8mm 1.4mm; vertical-align: top; line-height: 1.32; }
.lbl { display: block; font-size: 7.3pt; color: #333; margin-bottom: 0.6mm; }
.val { font-size: 9pt; }
.pair { display: flex; justify-content: space-between; padding-right: 4mm; }
table.kv td { border: none; padding: 0.4mm 0; font-size: 8.8pt; }
table.kv td.k { width: 31mm; color: #222; }
.foot { position: absolute; bottom: 8mm; left: 0; right: 0; text-align: center; font-size: 7.5pt; color: #444; }
`;

function headerForm(kind: 'invoice' | 'packing'): string {
  const remarks =
    kind === 'invoice'
      ? `<table class="kv">
          <tr><td class="k">Terms of Price :</td><td>FOB BUSAN, KOREA (INCOTERMS 2020)</td></tr>
          <tr><td class="k">Terms of Payment :</td><td>IRREVOCABLE L/C AT SIGHT</td></tr>
          <tr><td class="k">Country of Origin :</td><td>REPUBLIC OF KOREA</td></tr>
          <tr><td class="k">P/O No. :</td><td>${PO}</td></tr>
          <tr><td class="k">Currency :</td><td>US DOLLARS</td></tr>
        </table>`
      : `<table class="kv">
          <tr><td class="k">L/C No. :</td><td>${LC_NO}</td></tr>
          <tr><td class="k">P/O No. :</td><td>${PO}</td></tr>
          <tr><td class="k">Country of Origin :</td><td>REPUBLIC OF KOREA</td></tr>
          <tr><td class="k">Packing :</td><td>EXPORT CARTON, ${fmtInt(CTNS)} CTNS</td></tr>
          <tr><td class="k">Loading :</td><td>2 X 40' HC (FCL)</td></tr>
        </table>`;
  const contact = `<div class="val" style="font-size:7.6pt;color:#333;margin-top:2.5mm">${SELLER.bizNo}<br>${SELLER.contact}</div>`;
  const right2and3 =
    kind === 'invoice'
      ? {
          r2: `<td><span class="lbl">⑨ L/C No. &amp; Date</span><div class="val pair"><span>${LC_NO}</span><span>${LC_DATE}</span></div></td>`,
          r3: `<td><span class="lbl">⑩ L/C Issuing Bank</span><div class="val">${BANK.name}<br>${BANK.branch}</div></td>`,
          remarksNo: '⑪',
        }
      : {
          r2: `<td rowspan="2"><span class="lbl">⑨ Shipping Marks</span><div class="val">${MARKS.map(esc).join('<br>')}</div></td>`,
          r3: '',
          remarksNo: '⑩',
        };
  return `<table class="form">
    <colgroup><col style="width:24%"><col style="width:24%"><col style="width:52%"></colgroup>
    <tr><td colspan="2" rowspan="2" style="height:24mm"><span class="lbl">① Shipper / Exporter</span><div class="val">${esc(SELLER.name)}<br>${esc(SELLER.street)}<br>${esc(SELLER.city)}</div></td>
      <td><span class="lbl">⑧ Invoice No. &amp; Date</span><div class="val pair"><span>${INVOICE_NO}</span><span>${INVOICE_DATE}</span></div></td></tr>
    <tr>${right2and3.r2}</tr>
    <tr><td colspan="2" rowspan="2" style="height:24mm"><span class="lbl">② For Account &amp; Risk of Messrs.</span><div class="val">${esc(BUYER.name)}<br>${esc(BUYER.street)}<br>${esc(BUYER.city)}<br>${BUYER.phone}</div></td>
      ${right2and3.r3}</tr>
    <tr><td rowspan="4"><span class="lbl">${right2and3.remarksNo} Remarks</span>${remarks}${contact}</td></tr>
    <tr><td colspan="2"><span class="lbl">③ Notify Party</span><div class="val">SAME AS ABOVE</div></td></tr>
    <tr><td><span class="lbl">④ From / To</span><div class="val">BUSAN, KOREA /<br>LONG BEACH, CA, U.S.A.</div></td>
      <td><span class="lbl">⑤ Final Destination</span><div class="val">LOS ANGELES, CA, U.S.A.</div></td></tr>
    <tr><td><span class="lbl">⑥ Shipped per</span><div class="val">${VESSEL}<br>V. ${VOYAGE}</div></td>
      <td><span class="lbl">⑦ Sailing on or about</span><div class="val">${SAILING}</div></td></tr>
  </table>`;
}

/** Items on the first invoice page; the rest continue on page 2 with no column header. */
const PAGE1_LINES = 3;
/** Height of the empty form area under the last item on page 1 (the ruled box runs to the page foot). */
const PAGE1_FILL_MM = 52;

function invoiceHtml(): string {
  const css = `${FORM_CSS}
table.it { width: 100%; table-layout: fixed; margin-top: -0.35mm; }
table.it th { border: 0.35mm solid #111; font-weight: 600; font-size: 7.8pt; padding: 1.2mm 0.8mm; text-align: center; vertical-align: middle; line-height: 1.25; }
table.it td { border-left: 0.35mm solid #111; border-right: 0.35mm solid #111; padding: 1.2mm 1.4mm; vertical-align: top; line-height: 1.32; }
table.it td.r { text-align: right; white-space: nowrap; }
table.it td.c { text-align: center; white-space: nowrap; }
table.it tr.cap td { padding-top: 2mm; font-weight: 700; }
table.it tr.last td { border-bottom: 0.35mm solid #111; }
table.it tr.fill td { height: 100%; }
table.it .t { font-weight: 700; }
table.it .d { font-size: 8.3pt; color: #222; }
table.it tr.sum td { border-top: 0.35mm solid #111; padding-top: 1.6mm; }
table.it tr.cont td { border-top: 0.35mm solid #111; }
table.it tr.grand td { border-top: 0.6mm double #111; border-bottom: 0.35mm solid #111; font-weight: 800; padding: 1.8mm 1.4mm; }
.say { margin-top: 3mm; font-size: 8.8pt; line-height: 1.5; }
.sig { position: absolute; right: 14mm; top: 168mm; width: 80mm; font-size: 8.8pt; line-height: 1.4; }
.sig .co2 { font-weight: 700; }
.sig .hand { font-family: 'Snell Roundhand', 'Apple Chancery', cursive; font-size: 19pt; color: #1b2a6b; margin: 2mm 0 -1mm 6mm; }
.sig .line { border-top: 0.3mm solid #111; padding-top: 1mm; }
`;
  const colgroup = `<colgroup><col style="width:31mm"><col><col style="width:22mm"><col style="width:19.5mm"><col style="width:22mm"><col style="width:17mm"><col style="width:24mm"></colgroup>`;
  const row = (l: S4Line, i: number, marksCell: string, last: boolean): string => `<tr${last ? ' class="last"' : ''}>${marksCell}
      <td><div class="t">${esc(l.title)}</div><div class="d">${l.details.map(esc).join('<br>')}</div></td>
      <td class="c">${esc(l.model)}</td><td class="c">${l.hs}</td>
      <td class="r">${fmtInt(l.qty)} ${l.unit}</td><td class="r">${fmtMoney(l.price)}</td><td class="r">${fmtMoney(AMOUNTS[i])}</td></tr>`;
  const p1 = LINES.slice(0, PAGE1_LINES);
  const p2 = LINES.slice(PAGE1_LINES);
  const marks = `<td rowspan="${p1.length + 1}" style="font-size:8.2pt;line-height:1.45;padding-top:2mm">${MARKS.map(esc).join('<br>')}</td>`;
  const page1 = `<div class="pad">
  <div class="co"><div class="en">${esc(SELLER.name)}</div><div class="ko">${SELLER.ko}</div></div>
  <div class="ttl">COMMERCIAL INVOICE</div>
  ${headerForm('invoice')}
  <table class="it">${colgroup}
    <tr><th>⑫ Marks &amp; Numbers<br>of PKGS</th><th>⑬ Description of Goods</th><th>Model No.</th><th>H.S. Code</th><th>⑭ Quantity</th><th>⑮ Unit Price<br>(USD)</th><th>⑯ Amount<br>(USD)</th></tr>
    <tr class="cap">${marks}<td>HOUSEHOLD ELECTRIC APPLIANCES</td><td></td><td></td><td></td><td style="text-align:center;font-size:7.6pt">FOB<br>BUSAN</td><td></td></tr>
    ${p1.map((l, i) => row(l, i, '', false)).join('')}
    <tr class="last"><td style="height:${PAGE1_FILL_MM}mm"></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  </table>
  <div class="foot">Page 1 of 2</div>
</div>`;
  const p2rows = p2.map((l, k) => row(l, PAGE1_LINES + k, '<td></td>', false).replace('<tr>', k === 0 ? '<tr class="cont">' : '<tr>')).join('');
  const page2 = `<div class="pad" style="padding-top:12mm">
  <table class="it">${colgroup}
    ${p2rows}
    <tr class="sum"><td></td><td class="t">SUB TOTAL</td><td></td><td></td><td class="r">${fmtInt(SETS)} SETS<br>${fmtInt(PCS)} PCS</td><td></td><td class="r">${fmtMoney(SUBTOTAL)}</td></tr>
    <tr><td></td><td>LESS : ${DISCOUNT_PCT}% VOLUME DISCOUNT<br><span class="d">(per annual volume agreement GL-VA-2026, deducted from this invoice)</span></td><td></td><td></td><td></td><td></td><td class="r">-USD ${fmtMoney(DISCOUNT)}</td></tr>
    <tr class="grand"><td></td><td colspan="4">TOTAL AMOUNT : FOB BUSAN, KOREA</td><td></td><td class="r">USD ${fmtMoney(NET_TOTAL)}</td></tr>
  </table>
  <div class="say">SAY : U.S. DOLLARS ${moneyWords(NET_TOTAL)} ONLY.<br>
    PACKING : ${fmtInt(CTNS)} CARTONS IN TWO (2) 40' HIGH CUBE CONTAINERS.<br>
    DRAWN UNDER ${BANK.name}, LOS ANGELES, L/C NO. ${LC_NO} DATED ${LC_DATE}.<br>
    WE HEREBY CERTIFY THAT THE GOODS ARE OF KOREAN ORIGIN AND THAT THIS INVOICE IS TRUE AND CORRECT.</div>
  <div class="sig"><div class="co2">${esc(SELLER.name)}</div><div class="hand">Do-hyun Kim</div>
    <div class="line">KIM DO-HYUN<br>Managing Director, Overseas Sales Division</div></div>
  <div class="foot">Page 2 of 2</div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [page1, page2], lang: 'en' });
}

function packingListHtml(): string {
  const css = `${FORM_CSS}
table.pk { width: 100%; table-layout: fixed; margin-top: -0.35mm; }
table.pk th { border: 0.35mm solid #111; font-weight: 600; font-size: 7.6pt; padding: 1.1mm 0.6mm; text-align: center; vertical-align: middle; line-height: 1.22; }
table.pk td { border: 0.25mm solid #111; padding: 1.2mm 1.2mm; vertical-align: top; line-height: 1.3; font-size: 8.6pt; }
table.pk td.r { text-align: right; white-space: nowrap; }
table.pk td.c { text-align: center; white-space: nowrap; }
table.pk tr.tot td { font-weight: 800; border-top: 0.6mm double #111; }
h3 { font-size: 9.6pt; margin: 4.5mm 0 1.2mm; letter-spacing: 0.8pt; }
.sig { position: absolute; right: 14mm; bottom: 26mm; width: 80mm; font-size: 8.8pt; line-height: 1.4; }
.sig .co2 { font-weight: 700; }
.sig .hand { font-family: 'Snell Roundhand', 'Apple Chancery', cursive; font-size: 19pt; color: #1b2a6b; margin: 2mm 0 -1mm 6mm; }
.sig .line { border-top: 0.3mm solid #111; padding-top: 1mm; }
`;
  const rows = LINES.map((l, i) => {
    const p = PACK[i];
    return `<tr><td><b>${esc(l.model)}</b><br>${esc(l.title)}<br><span style="font-size:7.8pt">${l.perCtn} ${l.unit}/CTN, ${l.ctnSize}</span></td>
      <td class="c">${p.from} - ${p.to}</td><td class="r">${fmtInt(l.qty)} ${l.unit}</td><td class="r">${fmtInt(p.ctns)} CTNS</td>
      <td class="r">${fmtNum(p.nw, 2)}</td><td class="r">${fmtNum(p.gw, 2)}</td><td class="r">${fmtNum(p.cbm, 3)}</td></tr>`;
  }).join('');
  const crow = CONTAINERS.map(
    (c, i) => `<tr><td class="c">${i + 1}</td><td class="c">${c.no}</td><td class="c">${c.seal}</td><td class="c">40' HC</td><td style="text-align:center">${c.ranges.join(', ')}</td>
      <td class="r">${fmtInt(c.ctns)} CTNS</td><td class="r">${fmtNum(c.nw, 2)}</td><td class="r">${fmtNum(c.gw, 2)}</td><td class="r">${fmtNum(c.cbm, 3)}</td></tr>`,
  ).join('');
  const body = `<div class="pad">
  <div class="co"><div class="en">${esc(SELLER.name)}</div><div class="ko">${SELLER.ko}</div></div>
  <div class="ttl">PACKING LIST</div>
  ${headerForm('packing')}
  <table class="pk">
    <colgroup><col><col style="width:22mm"><col style="width:23mm"><col style="width:21mm"><col style="width:22mm"><col style="width:22mm"><col style="width:20mm"></colgroup>
    <tr><th>Model No. / Description</th><th>C/T No.</th><th>Quantity</th><th>Package</th><th>Net Weight<br>(KGS)</th><th>Gross Weight<br>(KGS)</th><th>Measurement<br>(CBM)</th></tr>
    ${rows}
    <tr class="tot"><td>TOTAL</td><td class="c">1 - ${fmtInt(CTNS)}</td><td class="r">${fmtInt(SETS)} SETS<br>${fmtInt(PCS)} PCS</td><td class="r">${fmtInt(CTNS)} CTNS</td>
      <td class="r">${fmtNum(NW, 2)}</td><td class="r">${fmtNum(GW, 2)}</td><td class="r">${fmtNum(CBM, 3)}</td></tr>
  </table>
  <h3>CONTAINER / SEAL</h3>
  <table class="pk">
    <colgroup><col style="width:8mm"><col style="width:27mm"><col style="width:22mm"><col style="width:16mm"><col><col style="width:22mm"><col style="width:21mm"><col style="width:21mm"><col style="width:17mm"></colgroup>
    <tr><th>No.</th><th>Container No.</th><th>Seal No.</th><th>Size / Type</th><th>C/T No.</th><th>Package</th><th>N.W. (KGS)</th><th>G.W. (KGS)</th><th>CBM</th></tr>
    ${crow}
    <tr class="tot"><td></td><td colspan="3">2 X 40' HC</td><td></td><td class="r">${fmtInt(CTNS)} CTNS</td><td class="r">${fmtNum(NW, 2)}</td><td class="r">${fmtNum(GW, 2)}</td><td class="r">${fmtNum(CBM, 3)}</td></tr>
  </table>
  <div class="sig"><div class="co2">${esc(SELLER.name)}</div><div class="hand">Do-hyun Kim</div>
    <div class="line">KIM DO-HYUN<br>Managing Director, Overseas Sales Division</div></div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

function masterBlHtml(): string {
  const blue = '#163f86';
  const css = `
body { font-family: 'Trebuchet MS', 'Lucida Grande', sans-serif; font-size: 8.8pt; }
.pad { padding: 9mm 10mm 0 11mm; }
.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 0.8mm solid ${blue}; padding-bottom: 2mm; }
.brand { display: flex; align-items: center; gap: 3mm; }
.wave { width: 15mm; height: 15mm; border-radius: 50%; background: ${blue}; color: #fff; font-weight: bold; font-size: 15pt; display: flex; align-items: center; justify-content: center; letter-spacing: -0.5pt; }
.bn { font-size: 17pt; font-weight: bold; color: ${blue}; letter-spacing: 0.6pt; line-height: 1.05; }
.bn small { display: block; font-size: 7.6pt; font-weight: normal; color: #333; letter-spacing: 0.2pt; }
.doc { text-align: right; }
.doc .t { font-size: 15pt; font-weight: bold; letter-spacing: 1pt; }
.doc .s { font-size: 7pt; color: #333; }
.doc .orig { display: inline-block; margin-top: 1mm; border: 0.5mm solid #111; padding: 0.4mm 3mm; font-weight: bold; letter-spacing: 3pt; font-size: 11pt; }
table.g { width: 100%; table-layout: fixed; margin-top: 2mm; }
table.g td { border: 0.3mm solid ${blue}; padding: 1.1mm 1.6mm; vertical-align: top; line-height: 1.32; }
.l { display: block; font-size: 6.9pt; color: ${blue}; margin-bottom: 0.6mm; }
.big { font-size: 11.5pt; font-weight: bold; letter-spacing: 0.4pt; }
.band { background: ${blue}; color: #fff; text-align: center; font-size: 7.4pt; padding: 0.9mm; letter-spacing: 0.4pt; margin-top: -0.3mm; }
table.c { width: 100%; table-layout: fixed; }
table.c th { border: 0.3mm solid ${blue}; font-size: 6.9pt; color: ${blue}; font-weight: normal; padding: 1mm; text-align: left; vertical-align: top; }
table.c td { border-left: 0.3mm solid ${blue}; border-right: 0.3mm solid ${blue}; padding: 1.2mm 1.6mm; vertical-align: top; line-height: 1.36; }
table.c tr.end td { border-bottom: 0.3mm solid ${blue}; }
table.c td.r { text-align: right; white-space: nowrap; }
.words { font-size: 8.2pt; padding: 1.3mm 0; }
table.f { width: 100%; table-layout: fixed; }
table.f td, table.f th { border: 0.3mm solid ${blue}; padding: 1mm 1.6mm; vertical-align: top; }
table.f th { font-size: 6.9pt; color: ${blue}; font-weight: normal; text-align: left; }
.legal { font-size: 6.2pt; color: #333; line-height: 1.3; }
.hand { font-family: 'Snell Roundhand', 'Apple Chancery', cursive; font-size: 15pt; color: #1b2a6b; }
`;
  const c1 = CONTAINERS[0];
  const c2 = CONTAINERS[1];
  const body = `<div class="pad">
  <div class="top">
    <div class="brand"><div class="wave">HN</div><div class="bn">HANNURI MERCHANT LINE<small>HANNURI MERCHANT LINE CO., LTD. · SEOUL · BUSAN &nbsp;|&nbsp; SCAC: HNRL</small></div></div>
    <div class="doc"><div class="t">BILL OF LADING</div><div class="s">FOR PORT-TO-PORT OR COMBINED TRANSPORT SHIPMENT</div><div class="orig">ORIGINAL</div></div>
  </div>
  <table class="g">
    <colgroup><col style="width:52%"><col style="width:24%"><col style="width:24%"></colgroup>
    <tr><td rowspan="2" style="height:24mm"><span class="l">Shipper / Exporter</span>${esc(SELLER.name)}<br>88, NAMDONGSEO-RO 236BEON-GIL, NAMDONG-GU<br>INCHEON 21633, KOREA</td>
      <td><span class="l">Booking No.</span>${BOOKING}</td><td><span class="l">Bill of Lading No.</span><span class="big">${MBL}</span></td></tr>
    <tr><td colspan="2"><span class="l">Export References</span>INVOICE NO. ${INVOICE_NO}<br>L/C NO. ${LC_NO}</td></tr>
    <tr><td rowspan="2" style="height:22mm"><span class="l">Consignee (complete name and address)</span>TO THE ORDER OF<br>${BANK.name}<br>${BANK.branch}</td>
      <td colspan="2"><span class="l">Forwarding Agent - References</span>-</td></tr>
    <tr><td colspan="2"><span class="l">Point and Country of Origin</span>INCHEON, KOREA</td></tr>
    <tr><td style="height:24mm"><span class="l">Notify Party (complete name and address)</span>${esc(BUYER.name)}<br>${esc(BUYER.street).toUpperCase()}<br>LOS ANGELES, CA 90058, U.S.A.<br>${BUYER.phone}</td>
      <td colspan="2"><span class="l">Domestic Routing / Export Instructions</span>CARGO TO BE RELEASED AGAINST ONE ORIGINAL B/L DULY ENDORSED BY THE CONSIGNEE BANK</td></tr>
  </table>
  <table class="g" style="margin-top:-0.3mm">
    <colgroup><col style="width:24%"><col style="width:24%"><col style="width:28%"><col style="width:24%"></colgroup>
    <tr><td><span class="l">Pre-carriage by</span>-</td><td><span class="l">Place of Receipt</span>BUSAN CY</td>
      <td><span class="l">Ocean Vessel / Voy. No.</span>${VESSEL} ${VOYAGE}</td><td><span class="l">Port of Loading</span>BUSAN, KOREA</td></tr>
    <tr><td><span class="l">Port of Discharge</span>LONG BEACH, CA</td><td><span class="l">Place of Delivery</span>LONG BEACH, CA CY</td>
      <td><span class="l">Final Destination (for the Merchant's ref. only)</span>LOS ANGELES, CA</td><td><span class="l">Type of Movement</span>FCL / FCL &nbsp; CY / CY</td></tr>
  </table>
  <div class="band">PARTICULARS FURNISHED BY THE SHIPPER — CARRIER NOT RESPONSIBLE</div>
  <table class="c">
    <colgroup><col style="width:26%"><col style="width:13%"><col style="width:35%"><col style="width:13.5%"><col style="width:12.5%"></colgroup>
    <tr><th>Container No. / Seal No.<br>Marks and Numbers</th><th>No. of Containers<br>or Packages</th><th>Kind of Packages; Description of Goods</th><th>Gross Weight</th><th>Measurement</th></tr>
    <tr><td>${c1.no} / ${c1.seal}<br>40' HC</td><td>${fmtInt(c1.ctns)} CTNS</td><td rowspan="3">SHIPPER'S LOAD, COUNT &amp; SEAL<br>2 X 40' HC CONTAINERS SAID TO CONTAIN<br>${fmtInt(CTNS)} CARTONS OF<br>HOUSEHOLD ELECTRIC APPLIANCES<br>(BLENDERS, CONVECTION OVENS,<br>COFFEE MAKERS, RICE COOKERS)<br>HS CODE: 8509.40, 8516.60, 8516.71, 8516.79<br>INVOICE NO. ${INVOICE_NO}<br>L/C NO. ${LC_NO}<br><br>FREIGHT PREPAID</td>
      <td class="r">${fmtNum(c1.gw, 3)} KGS</td><td class="r">${fmtNum(c1.cbm, 3)} CBM</td></tr>
    <tr><td>${c2.no} / ${c2.seal}<br>40' HC</td><td>${fmtInt(c2.ctns)} CTNS</td><td class="r">${fmtNum(c2.gw, 3)} KGS</td><td class="r">${fmtNum(c2.cbm, 3)} CBM</td></tr>
    <tr class="end"><td style="height:40mm">${MARKS.map(esc).join('<br>')}</td><td><br>TOTAL:<br>${fmtInt(CTNS)} CTNS</td>
      <td class="r"><br>TOTAL:<br>${fmtNum(GW, 3)} KGS</td><td class="r"><br><br>${fmtNum(CBM, 3)} CBM</td></tr>
  </table>
  <div class="words">TOTAL NUMBER OF CONTAINERS OR PACKAGES (IN WORDS): SAY TWO (2) CONTAINERS ONLY</div>
  <table class="f">
    <colgroup><col style="width:30%"><col style="width:16%"><col style="width:14%"><col style="width:10%"><col style="width:15%"><col style="width:15%"></colgroup>
    <tr><th>Freight &amp; Charges</th><th>Revenue Tons</th><th>Rate</th><th>Per</th><th>Prepaid</th><th>Collect</th></tr>
    <tr><td>OCEAN FREIGHT<br>BUNKER ADJUSTMENT FACTOR<br>ORIGIN TERMINAL HANDLING</td><td>2 X 40HC</td><td>AS ARRANGED</td><td>CNTR</td><td>PREPAID<br>PREPAID<br>PREPAID</td><td></td></tr>
  </table>
  <table class="f" style="margin-top:-0.3mm">
    <colgroup><col style="width:25%"><col style="width:25%"><col style="width:22%"><col style="width:28%"></colgroup>
    <tr><td><span class="l">Freight Prepaid at</span>BUSAN, KOREA</td><td><span class="l">Freight Payable at</span>-</td>
      <td><span class="l">No. of Original B/L</span>THREE (3)</td><td><span class="l">Place and Date of Issue</span>BUSAN, ${SAILING}</td></tr>
    <tr><td colspan="2" style="height:27mm"><span class="l">Laden on Board the Vessel</span>DATE: ${SAILING}<br>VESSEL: ${VESSEL} ${VOYAGE}<br>PORT OF LOADING: BUSAN, KOREA</td>
      <td colspan="2"><span class="l">Signed for the Carrier</span>HANNURI MERCHANT LINE CO., LTD.<br>AS CARRIER<br><span class="hand">J. S. Park</span></td></tr>
  </table>
  <div class="legal" style="margin-top:1.5mm">RECEIVED by the Carrier the Goods as specified above in apparent good order and condition unless otherwise stated, to be transported to such place as agreed, authorized or permitted herein and subject to all the terms and conditions appearing on the front and reverse of this Bill of Lading. One of the original Bills of Lading must be surrendered duly endorsed in exchange for the Goods or delivery order; the others to stand void.</div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

/** Entered values: line amount − 3 % discount prorated by value (see notes). */
const ENTERED = [44418, 37853, 35074, 54010];

export const s4: ShipmentSpec = {
  id: 's4-kr-fob-multi-container',
  valuation: { lineAmounts: AMOUNTS, includedNonDutiableCharges: 0, discount: DISCOUNT },
  docs: [
    {
      file: `CI_${INVOICE_NO}.pdf`,
      docType: 'commercial_invoice',
      variant: 'text',
      format: 'A4',
      pages: 2,
      html: invoiceHtml(),
      meta: { title: `COMMERCIAL INVOICE ${INVOICE_NO}`, author: SELLER.name },
      keyTokens: [
        INVOICE_NO,
        INVOICE_DATE,
        LC_NO,
        'FOB BUSAN',
        ...LINES.map((l) => l.model),
        ...LINES.map((l) => l.hs),
        ...LINES.map((l) => `${fmtInt(l.qty)} ${l.unit}`),
        ...AMOUNTS.map((a) => fmtMoney(a)),
        fmtMoney(SUBTOTAL),
        fmtMoney(DISCOUNT),
        fmtMoney(NET_TOTAL),
        SAILING,
        VESSEL,
      ],
    },
    {
      file: `PL_${INVOICE_NO}.pdf`,
      docType: 'packing_list',
      variant: 'text',
      format: 'A4',
      pages: 1,
      html: packingListHtml(),
      meta: { title: `PACKING LIST ${INVOICE_NO}`, author: SELLER.name },
      keyTokens: [
        INVOICE_NO,
        ...LINES.map((l) => l.model),
        ...PACK.map((p) => `${fmtInt(p.ctns)} CTNS`),
        `${fmtInt(CTNS)} CTNS`,
        fmtNum(NW, 2),
        fmtNum(GW, 2),
        fmtNum(CBM, 3),
        ...CONTAINERS.map((c) => c.no),
        ...CONTAINERS.map((c) => c.seal),
        ...CONTAINERS.map((c) => fmtNum(c.gw, 2)),
      ],
    },
    {
      file: `${MBL}_scan.pdf`,
      docType: 'bill_of_lading',
      variant: 'scan',
      format: 'A4',
      pages: 1,
      html: masterBlHtml(),
      meta: { title: 'Scanned image', author: 'Goldline Housewares Corp.' },
      keyTokens: [
        MBL,
        ...CONTAINERS.map((c) => c.no),
        ...CONTAINERS.map((c) => c.seal),
        ...CONTAINERS.map((c) => fmtNum(c.gw, 3)),
        fmtNum(GW, 3),
        fmtNum(CBM, 3),
        `${fmtInt(CTNS)} CARTONS`,
        VESSEL,
        VOYAGE,
        'BUSAN',
        'LONG BEACH',
        'GOLDLINE',
        'MIRAEON',
        'CORONADO',
        INVOICE_NO,
        SAILING,
        'PREPAID',
      ],
      scan: {
        seed: 's4-mbl',
        dpi: 200,
        rotateDeg: -0.9,
        noiseSigma: 7,
        blurSigma: 0.55,
        paper: [246, 244, 238],
        bed: [210, 208, 204],
        specklesPerMp: 22,
        jpegQuality: 80,
        stamps: [
          {
            cxMm: 82,
            cyMm: 246,
            wMm: 62,
            hMm: 25,
            angleDeg: 6,
            frame: 'double',
            color: '#2a3f9e',
            opacity: 0.78,
            lines: [
              { text: 'SHIPPED ON BOARD', sizeMm: 5.6, bold: true, fit: true },
              { text: SAILING, sizeMm: 4.4, bold: true, font: "'Courier New', monospace" },
              { text: 'BUSAN, KOREA', sizeMm: 3.2, bold: true },
            ],
          },
        ],
      },
    },
  ],
  expected: {
    id: 's4-kr-fob-multi-container',
    description:
      "Korean small-appliance maker (Incheon) → Los Angeles importer by sea, FOB Busan, L/C at sight. Text invoice in the Korean trade-form layout (circled box numbers, 'For Account & Risk of Messrs.', 'Invoice No. & Date', 'L/C No.', 'Terms of Price', 'Shipped per', 'Sailing on or about', 'From / To'), marks column, group caption row, Model No. + H.S. Code columns, quantity and unit in one cell, 3% volume discount; the item table continues on page 2 without a repeated header. Separate text packing list with a Container/Seal table (2 x 40' HC). Scanned carrier master B/L (no house bill), consigned to the order of the L/C bank, blue SHIPPED ON BOARD stamp.",
    notes: [
      'Valuation policy: FOB Busan. The price ends on board at Busan, so the invoice price contains no international freight or insurance and nothing is deducted for charges. The master B/L says FREIGHT PREPAID / AS ARRANGED; under FOB that freight is paid for the buyer\'s account outside the invoice price (no amount is shown on any document), so it neither reduces nor increases the entered value. No assists, no NCV lines.',
      `Discount (judgment call): page 2 prints SUB TOTAL ${fmtMoney(SUBTOTAL)}, "LESS : 3% VOLUME DISCOUNT ... deducted from this invoice" -USD ${fmtMoney(DISCOUNT)} and TOTAL AMOUNT USD ${fmtMoney(NET_TOTAL)}, and the L/C is drawn for that net total. A trade/volume discount that is shown on the invoice and actually granted on this sale lowers the price actually paid or payable (19 USC 1401a(b); 19 CFR 152.103(a)), so it is apportioned to the lines by value. A broker who reads it as a retroactive rebate on past purchases (not deductible) would enter the undiscounted amounts (total 176,654); that alternative is NOT what this file expects.`,
      `Discount check: 3% × ${fmtMoney(SUBTOTAL)} = 5,299.632 → printed ${fmtMoney(DISCOUNT)} (rounded to the cent). ${fmtMoney(SUBTOTAL)} − ${fmtMoney(DISCOUNT)} = ${fmtMoney(NET_TOTAL)} = printed total, so TOTALS_MISMATCH must not fire. The discount row has no model, HS code or quantity and must not become an invoice line (4 lines expected).`,
      'Line amounts: 1,440 SETS × 31.80 = 45,792.00; 720 PCS × 54.20 = 39,024.00; 1,944 PCS × 18.60 = 36,158.40; 1,200 PCS × 46.40 = 55,680.00. Sum 176,654.40 = printed SUB TOTAL. All lines reconcile.',
      'Each line: amount − 5,299.63 × amount / 176,654.40.',
      'Line 1: 45,792.00 − 1,373.76 = 44,418.24 → 44,418.',
      'Line 2: 39,024.00 − 1,170.72 = 37,853.28 → 37,853.',
      'Line 3: 36,158.40 − 1,084.75 = 35,073.65 → 35,074.',
      'Line 4: 55,680.00 − 1,670.40 = 54,009.60 → 54,010.',
      'Total entered value: 44,418 + 37,853 + 35,074 + 54,010 = 171,355 (net invoice total 171,354.77; the 0.23 difference is per-line rounding). USD, no conversion.',
      'Layout traps: (a) the item table on page 2 has no column header, and line 4 (MRE-PR0610 rice cooker) is only on page 2, so parsing must carry the column layout over from page 1; (b) a caption row "HOUSEHOLD ELECTRIC APPLIANCES ... FOB BUSAN" precedes line 1 and is not a line; (c) the Marks & Numbers column on page 1 holds shipping-mark text in the same rows as lines 1–3; (d) quantity and unit share one cell ("1,440 SETS").',
      'HTS printed as 8-digit codes in their own column; all are real 2026 HTSUS numbers (cached in scripts/synthetic/reference/): 8509.40.00 food mixers/blenders (4.2%), 8516.60.40 cooking stoves, ranges and ovens (Free), 8516.71.00 coffee or tea makers (3.7%), 8516.79.00 other electrothermic appliances, here a rice cooker (2.7%).',
      'Packing list = invoice quantities: 360 + 720 + 324 + 600 = 2,004 cartons; N.W. 22,807.20 kg; G.W. 26,078.40 kg; 127.044 CBM. B/L totals agree (2,004 CTNS, 26,078.400 KGS, 127.044 CBM).',
      'Containers (both pass ISO 6346): HNRU4120679 (check digit 9, seal HN6204417, 920 CTNS, 10,912.000 kg) and HNRU4188534 (check digit 4, seal HN6204418, 1,084 CTNS, 15,166.400 kg); both 40\' HC. Order as printed.',
      'Transport document: the carrier\'s own (master) B/L HNRLPUSA26091742 → master SCAC HNRL + bill PUSA26091742; there is NO house bill and no NVOCC, so HOUSE_MASTER_BILL must not fire.',
      'B/L consignee is "TO THE ORDER OF CORONADO TRUST BANK" (L/C issuing bank); notify party and invoice buyer ("For Account & Risk of Messrs.") is GOLDLINE HOUSEWARES CORP. The bank is not the importer: importer and ultimate consignee = Goldline. Flagging that assumption (IMPORTER_ASSUMED or ULTIMATE_CONSIGNEE_ASSUMED) is reasonable but not asserted, because which code applies is a judgment call.',
      'Port of discharge LONG BEACH, CA → Schedule D 2709 (not 2704 Los Angeles, which is only the final destination / buyer city). Containerized vessel → mode 11. On board SEP. 19, 2026 (form box and blue stamp). Invoice date SEP. 14, 2026 (month name, unambiguous).',
      'Seller = manufacturer (MIRAEON HOME ELECTRIC CO., LTD., Incheon); all lines origin KR, no line-level origin notes.',
    ],
    expect: {
      invoiceNumber: INVOICE_NO,
      invoiceNumberNormalized: INVOICE_NO,
      invoiceDate: '2026-09-14',
      currency: 'USD',
      incoterm: { code: 'FOB', place: 'Busan' },
      sellerName: SELLER.name,
      buyerName: BUYER.name,
      importerName: BUYER.name,
      ultimateConsigneeName: BUYER.name,
      transport: {
        mode: 'ocean',
        modeTransportation: '11',
        entryPort: '2709',
        containers: CONTAINERS.map((c) => c.no),
        bills: [{ masterScac: 'HNRL', masterBill: MBL.slice(4) }],
        grossWeightKg: GW,
      },
      lines: LINES.map((l, i) => ({
        lineNo: i + 1,
        styleNo: l.model,
        descriptionContains: l.match,
        quantity: l.qty,
        unit: l.unit,
        unitPrice: l.price,
        printedAmount: AMOUNTS[i],
        countryOfOrigin: 'KR',
        hs6: l.hs.replace(/\./g, '').slice(0, 6),
        hsPrinted: l.hs,
        enteredValue: ENTERED[i],
      })),
      totalEnteredValue: ENTERED.reduce((s, v) => s + v, 0),
      issuesInclude: [],
      issuesExclude: [
        'HOUSE_MASTER_BILL',
        'MISSING_DOCUMENT',
        'NON_DUTIABLE_CHARGES',
        'CHARGES_NOT_ITEMIZED',
        'LINE_AMOUNT_MISMATCH',
        'TOTALS_MISMATCH',
        'CONTAINER_NUMBER_INVALID',
        'CONTAINER_NUMBER_CORRECTED',
        'HTS_NOT_DECLARED',
        'DATE_AMBIGUOUS',
        'ORIGIN_DIFFERS',
        'SELLER_NOT_MANUFACTURER',
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
      ],
    },
  },
};
