/**
 * S1 — air shipment, EUR, FCA. German exporter (DIN-5008 style letter invoice, German number
 * format, bilingual labels) + a scanned house air waybill. No packing list on purpose.
 */
import { fmtMoney, fmtNum, roundCents } from '../format.js';
import { esc, htmlDocument } from '../html/base.js';
import type { ShipmentSpec } from '../spec.js';

const SELLER = {
  name: 'Rheinwerk Kuechentechnik GmbH',
  street: 'Klingenstraße 42',
  city: '42651 Solingen',
  country: 'Deutschland / Germany',
  phone: '+49 212 2264-0',
  email: 'export@rheinwerk-kt.de',
};
const BUYER = {
  name: 'Lakeshore Culinary Supply Co.',
  attn: 'Attn: Dana Whitfield, Purchasing',
  street: '1450 W Fulton Market, Suite 210',
  city: 'Chicago, IL 60607',
  country: 'USA',
};

const INVOICE_NO = 'RW-26-10387';
const MAWB = '020-12345675';
const HAWB = 'MSA2604417';

interface S1Line {
  art: string;
  /** Substring used as expected.descriptionContains. */
  match: string;
  de: string;
  en: string;
  detail?: string;
  hs: string;
  qty: number;
  unit: string;
  price: number;
}

const LINES: S1Line[] = [
  {
    art: 'RW-4012-SS',
    match: 'Steak knife, 12 cm',
    de: 'Steakmesser 12 cm, Wellenschliff, Edelstahlgriff',
    en: 'Steak knife, 12 cm serrated fixed blade, one-piece stainless steel handle',
    detail: 'Klinge / blade X50CrMoV15 · spülmaschinenfest / dishwasher safe',
    hs: '8211.91.40',
    qty: 2400,
    unit: 'PCS',
    price: 3.85,
  },
  {
    art: 'RW-4020-PM',
    match: 'Steak knife, 11 cm',
    de: 'Steakmesser 11 cm, Kunststoffgriff (POM), genietet',
    en: 'Steak knife, 11 cm fixed blade, black POM plastic handle, riveted',
    hs: '8211.91.50',
    qty: 1800,
    unit: 'PCS',
    price: 2.15,
  },
  {
    art: 'RW-7310-B3',
    match: 'Mixing bowl set',
    de: 'Rührschüssel-Set 3-tlg., Edelstahl 18/10',
    en: 'Mixing bowl set of 3 (1.5 / 3.0 / 5.0 L), stainless steel 18/10, nesting',
    hs: '7323.93.00',
    qty: 400,
    unit: 'SETS',
    price: 11.6,
  },
  {
    art: 'RW-7324-SB',
    match: 'Colander 24 cm',
    de: 'Küchensieb 24 cm, Edelstahl, mit zwei Griffen',
    en: 'Colander 24 cm, perforated stainless steel, two handles, footed base',
    hs: '7323.93.00',
    qty: 640,
    unit: 'PCS',
    price: 6.45,
  },
];

const AMOUNTS = LINES.map((l) => roundCents(l.qty * l.price));
const TOTAL = roundCents(AMOUNTS.reduce((s, a) => s + a, 0));
const PACKAGES = 46;
const NET_KG = 1186.4;
const GROSS_KG = 1342.0;
const VOLUME_CBM = 8.97;
const CHARGEABLE_KG = 1498.0;

function invoiceHtml(): string {
  const de = (n: number): string => fmtMoney(n, 'de');
  const rows = LINES.map(
    (l, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td class="nw">${esc(l.art)}</td>
      <td class="desc"><b>${esc(l.de)}</b><br><span class="en">${esc(l.en)}</span>${l.detail ? `<br><span class="det">${esc(l.detail)}</span>` : ''}</td>
      <td class="nw">${esc(l.hs)}</td>
      <td class="c">DE</td>
      <td class="r">${l.qty}</td>
      <td class="c">${esc(l.unit)}</td>
      <td class="r">${de(l.price)}</td>
      <td class="r">${de(AMOUNTS[i])}</td>
    </tr>`,
  ).join('');
  const css = `
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 8.6pt; }
.pad { padding: 14mm 16mm 0 20mm; }
.lh { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 0.4mm solid #7a1f1f; padding-bottom: 3mm; }
.brand { font-family: Futura, 'Avenir Next', sans-serif; font-size: 20pt; letter-spacing: 1.5pt; color: #7a1f1f; }
.brand small { display: block; font-size: 8pt; letter-spacing: 0.5pt; color: #555; }
.lh-addr { text-align: right; font-size: 7.8pt; line-height: 1.35; color: #333; }
.top { display: flex; justify-content: space-between; margin-top: 9mm; }
.window { width: 85mm; height: 40mm; }
.sender { font-size: 6.5pt; color: #555; border-bottom: 0.2mm solid #999; padding-bottom: 0.8mm; margin-bottom: 2.5mm; }
.recipient { font-size: 9.5pt; line-height: 1.35; }
.info td { padding: 0.7mm 0; vertical-align: top; font-size: 8.2pt; }
.info td:first-child { color: #555; padding-right: 4mm; white-space: nowrap; }
h1 { font-family: Futura, 'Avenir Next', sans-serif; font-weight: 500; font-size: 15pt; margin: 4mm 0 2mm; }
.intro { margin-bottom: 3mm; }
.items { width: 100%; font-size: 7.9pt; }
.items th { background: #f1e9e6; border-top: 0.35mm solid #7a1f1f; border-bottom: 0.35mm solid #7a1f1f; padding: 1.5mm 1.2mm; text-align: left; font-weight: 600; vertical-align: bottom; }
.items td { border-bottom: 0.2mm solid #ccc; padding: 2mm 1.2mm; vertical-align: top; }
.items .r { text-align: right; white-space: nowrap; }
.items th.r { text-align: right; }
.items .c { text-align: center; }
.items .nw { white-space: nowrap; }
.desc .en { color: #333; font-style: italic; }
.desc .det { color: #666; font-size: 7.2pt; }
.sum { margin: 4mm 0 0 auto; font-size: 8.6pt; }
.sum td { padding: 0.9mm 0 0.9mm 6mm; }
.sum td.r { text-align: right; white-space: nowrap; }
.sum tr.total td { border-top: 0.35mm solid #111; font-weight: 700; font-size: 9.6pt; padding-top: 1.6mm; }
.notes { margin-top: 6mm; font-size: 8pt; line-height: 1.5; }
.weights { position: absolute; left: 20mm; right: 16mm; bottom: 27mm; border-top: 0.3mm solid #7a1f1f; border-bottom: 0.3mm solid #7a1f1f; padding: 1.4mm 0; display: grid; grid-template-columns: 1fr 1fr; row-gap: 1mm; font-size: 8pt; white-space: nowrap; }
.foot { position: absolute; left: 20mm; right: 16mm; bottom: 10mm; display: flex; justify-content: space-between; font-size: 6.6pt; color: #555; line-height: 1.4; }
`;
  const body = `<div class="pad">
  <div class="lh">
    <div class="brand">RHEINWERK<small>Küchentechnik aus Solingen</small></div>
    <div class="lh-addr">${esc(SELLER.name)}<br>${esc(SELLER.street)}<br>${esc(SELLER.city)}<br>${esc(SELLER.country)}<br>Tel. ${esc(SELLER.phone)}<br>${esc(SELLER.email)}</div>
  </div>
  <div class="top">
    <div class="window">
      <div class="sender">${esc(SELLER.name)} · ${esc(SELLER.street)} · ${esc(SELLER.city)} · Germany</div>
      <div class="recipient">${esc(BUYER.name)}<br>${esc(BUYER.attn)}<br>${esc(BUYER.street)}<br>${esc(BUYER.city)}<br>${esc(BUYER.country)}</div>
    </div>
    <table class="info">
      <tr><td>Inv # / Rechnungs-Nr.</td><td><b>${INVOICE_NO}</b></td></tr>
      <tr><td>Datum / Date</td><td>18.09.2026</td></tr>
      <tr><td>Kunden-Nr. / Customer No.</td><td>30418</td></tr>
      <tr><td>Ihre Bestellung / Your PO</td><td>LCS-PO-55120</td></tr>
      <tr><td>Lieferbedingung / Incoterm</td><td>FCA Frankfurt Airport (FRA), Incoterms® 2020</td></tr>
      <tr><td>Währung / Currency</td><td>EUR</td></tr>
      <tr><td>Versand / Shipment</td><td>Luftfracht / air freight<br>AWB ${MAWB} · HAWB ${HAWB}</td></tr>
    </table>
  </div>
  <h1>Rechnung / Invoice</h1>
  <p class="intro">Wir berechnen Ihnen für folgende Lieferung: / We invoice the following delivery:</p>
  <table class="items">
    <thead><tr>
      <th class="c">Pos.</th><th>Art.-Nr.</th><th>Bezeichnung / Description</th><th class="nw">Zolltarif-Nr.<br>HS Code</th><th class="c">Ursprung<br>Origin</th>
      <th class="r">Menge<br>Qty</th><th class="c">ME<br>Unit</th><th class="r">Unit Value<br>EUR</th><th class="r">Ext. Value<br>EUR</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="sum">
    <tr><td>Warenwert / Goods value</td><td class="r">${de(TOTAL)}</td></tr>
    <tr><td>Verpackung / Packing</td><td class="r">inklusive / included</td></tr>
    <tr><td>Fracht ab FRA / Freight from FRA</td><td class="r">zu Lasten Käufer / for buyer's account</td></tr>
    <tr class="total"><td>Rechnungsbetrag / Invoice total EUR</td><td class="r">${de(TOTAL)}</td></tr>
  </table>
  <div class="notes">
    Steuerfreie Ausfuhrlieferung gem. § 4 Nr. 1a i.V.m. § 6 UStG / VAT-exempt export supply.<br>
    Zahlungsbedingungen / Payment terms: 30 Tage netto / net 30 days.<br>
    Ursprungsland der Waren / Country of origin of goods: Deutschland / Germany.<br>
    Ausfuhr-MRN / Export MRN: 26DE512300004417A1
  </div>
</div>
<div class="weights">
  <span>Packstücke / Packages: ${PACKAGES} Kartons / cartons</span>
  <span>Nettogewicht / Net weight: ${fmtNum(NET_KG, 1, 'de')} kg</span>
  <span>Volumen / Volume: ${fmtNum(VOLUME_CBM, 2, 'de')} m³</span>
  <span>Bruttogewicht / Gross weight: ${fmtNum(GROSS_KG, 1, 'de')} kg</span>
</div>
<div class="foot">
  <div>${esc(SELLER.name)}<br>Sitz: Solingen · Amtsgericht Wuppertal HRB 24417<br>Geschäftsführer: Katrin Vollmer</div>
  <div>USt-IdNr. / VAT No. DE298417553<br>EORI DE4417738</div>
  <div>Stadtsparkasse Solingen<br>IBAN DE47 3425 0000 0004 4177 38<br>BIC SOLSDE33XXX</div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body], lang: 'de' });
}

function awbHtml(): string {
  const css = `
body { font-family: Tahoma, Verdana, sans-serif; font-size: 9.6pt; }
.pad { padding: 9mm 9mm 0 9mm; }
.lbl { font-family: Arial, Helvetica, sans-serif; font-size: 7.2pt; color: #1b3a6b; display: block; margin-bottom: 0.8mm; }
.top { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1.5mm; }
.awbno { display: flex; gap: 0; border: 0.35mm solid #1b3a6b; }
.awbno div { padding: 1.2mm 3mm; border-right: 0.35mm solid #1b3a6b; font-size: 12pt; font-weight: bold; }
.awbno div:last-child { border-right: none; }
.hawb { font-size: 13pt; font-weight: bold; text-align: right; }
table.g { width: 100%; table-layout: fixed; }
table.g td { border: 0.3mm solid #1b3a6b; padding: 1.2mm 1.6mm; vertical-align: top; }
.issuer { font-size: 8.5pt; line-height: 1.35; }
.issuer .t { font-family: Arial, sans-serif; font-size: 15pt; font-weight: bold; color: #1b3a6b; letter-spacing: 0.5pt; }
.small { font-family: Arial, sans-serif; font-size: 6.4pt; color: #333; line-height: 1.3; }
.rate th { font-family: Arial, sans-serif; font-size: 7pt; color: #1b3a6b; font-weight: normal; border: 0.3mm solid #1b3a6b; padding: 1mm; text-align: left; vertical-align: top; }
.rate td { border-left: 0.3mm solid #1b3a6b; border-right: 0.3mm solid #1b3a6b; padding: 1.5mm 1.2mm; vertical-align: top; }
.rate tr.tot td { border-top: 0.3mm solid #1b3a6b; border-bottom: 0.3mm solid #1b3a6b; }
.foot { display: flex; justify-content: space-between; margin-top: 2mm; font-family: Arial, sans-serif; font-size: 9pt; font-weight: bold; color: #1b3a6b; }
`;
  const body = `<div class="pad">
  <div class="top">
    <div><span class="lbl">MAWB No.</span><div class="awbno"><div>020</div><div>FRA</div><div>1234 5675</div></div></div>
    <div class="hawb"><span class="lbl">House Air Waybill No.</span>${HAWB}</div>
  </div>
  <table class="g">
    <colgroup><col style="width:50%"><col style="width:50%"></colgroup>
    <tr>
      <td style="height:30mm"><span class="lbl">Shipper's Name and Address &nbsp;&nbsp;&nbsp; Shipper's Account Number: RW-0412</span>
        RHEINWERK KUECHENTECHNIK GMBH<br>KLINGENSTRASSE 42<br>42651 SOLINGEN<br>GERMANY<br>TEL +49 212 2264-0</td>
      <td rowspan="2" class="issuer"><span class="lbl">Not Negotiable</span>
        <div class="t">HOUSE AIR WAYBILL</div>
        Issued by<br><b>MAINSPEED AIR LOGISTIK GMBH</b><br>Cargo City Süd, Gebäude 571<br>60549 Frankfurt am Main, Germany<br><br>
        <span class="small">Copies 1, 2 and 3 of this Air Waybill are originals and have the same validity. It is agreed that the goods described herein are accepted in apparent good order and condition (except as noted) for carriage SUBJECT TO THE CONDITIONS OF CONTRACT ON THE REVERSE HEREOF. THE SHIPPER'S ATTENTION IS DRAWN TO THE NOTICE CONCERNING CARRIER'S LIMITATION OF LIABILITY.</span></td>
    </tr>
    <tr>
      <td style="height:31mm"><span class="lbl">Consignee's Name and Address &nbsp;&nbsp;&nbsp; Consignee's Account Number</span>
        LAKESHORE CULINARY SUPPLY CO.<br>1450 W FULTON MARKET STE 210<br>CHICAGO IL 60607<br>UNITED STATES<br>TEL +1 312 555 0176</td>
    </tr>
    <tr>
      <td><span class="lbl">Issuing Carrier's Agent Name and City</span>MAINSPEED AIR LOGISTIK GMBH<br>FRANKFURT AM MAIN</td>
      <td rowspan="2"><span class="lbl">Accounting Information</span>MAWB ${MAWB}<br>FREIGHT PREPAID<br>NOTIFY: PRAIRIE GATEWAY CUSTOMS<br>BROKERS INC, ELK GROVE VILLAGE IL</td>
    </tr>
    <tr>
      <td><table style="width:100%"><tr><td style="border:none;padding:0;width:50%"><span class="lbl">Agent's IATA Code</span>23-4 7781/0012</td><td style="border:none;padding:0"><span class="lbl">Account No.</span>MSA-FRA-0418</td></tr></table></td>
    </tr>
    <tr>
      <td><span class="lbl">Airport of Departure (Addr. of First Carrier) and Requested Routing</span>FRANKFURT/MAIN (FRA)</td>
      <td><table style="width:100%"><tr><td style="border:none;padding:0;width:50%"><span class="lbl">Reference Number</span>${INVOICE_NO}</td><td style="border:none;padding:0"><span class="lbl">Optional Shipping Information</span>PO LCS-PO-55120</td></tr></table></td>
    </tr>
    <tr>
      <td><table style="width:100%"><tr>
        <td style="border:none;padding:0;width:16%"><span class="lbl">To</span>ORD</td>
        <td style="border:none;padding:0;width:52%"><span class="lbl">By First Carrier</span>LUFTHANSA CARGO</td>
        <td style="border:none;padding:0"><span class="lbl">to &nbsp;&nbsp; by &nbsp;&nbsp; to &nbsp;&nbsp; by</span>&nbsp;</td></tr></table></td>
      <td><table style="width:100%"><tr>
        <td style="border:none;padding:0"><span class="lbl">Currency</span>EUR</td>
        <td style="border:none;padding:0"><span class="lbl">CHGS</span>PP</td>
        <td style="border:none;padding:0"><span class="lbl">WT/VAL</span>PPD</td>
        <td style="border:none;padding:0"><span class="lbl">Other</span>PPD</td>
        <td style="border:none;padding:0"><span class="lbl">Decl. Value for Carriage</span>NVD</td>
        <td style="border:none;padding:0"><span class="lbl">Decl. Value for Customs</span>NCV</td></tr></table></td>
    </tr>
    <tr>
      <td><table style="width:100%"><tr>
        <td style="border:none;padding:0;width:55%"><span class="lbl">Airport of Destination</span>CHICAGO O'HARE (ORD)</td>
        <td style="border:none;padding:0"><span class="lbl">Requested Flight/Date</span>LH 8402 / 21 SEP 2026</td></tr></table></td>
      <td><span class="lbl">Amount of Insurance</span>NIL</td>
    </tr>
    <tr><td colspan="2" style="height:13mm"><span class="lbl">Handling Information</span>COMMERCIAL INVOICE ${INVOICE_NO} ATTACHED. KEEP DRY. NOTIFY CONSIGNEE ON ARRIVAL.</td></tr>
  </table>
  <table class="rate" style="width:100%;table-layout:fixed;margin-top:-0.3mm">
    <colgroup><col style="width:9%"><col style="width:11%"><col style="width:5%"><col style="width:7%"><col style="width:12%"><col style="width:11%"><col style="width:11%"><col style="width:34%"></colgroup>
    <tr><th>No. of Pieces RCP</th><th>Gross Weight</th><th>kg lb</th><th>Rate Class</th><th>Chargeable Weight</th><th>Rate / Charge</th><th>Total</th><th>Nature and Quantity of Goods (incl. Dimensions or Volume)</th></tr>
    <tr style="height:52mm">
      <td>${PACKAGES}</td><td>${fmtNum(GROSS_KG, 1)}</td><td>K</td><td>Q</td><td>${fmtNum(CHARGEABLE_KG, 1)}</td><td>AS AGREED</td><td>AS AGREED</td>
      <td>KITCHEN KNIVES (STEAK KNIVES)<br>STAINLESS STEEL KITCHENWARE<br>${PACKAGES} CTNS<br>DIMS: ${PACKAGES} X 60X50X65 CM<br>VOL: ${fmtNum(VOLUME_CBM, 2)} CBM<br>HS: 8211.91 / 7323.93<br>INV ${INVOICE_NO}</td>
    </tr>
    <tr class="tot"><td>${PACKAGES}</td><td>${fmtNum(GROSS_KG, 1)}</td><td></td><td></td><td></td><td></td><td>AS AGREED</td><td></td></tr>
  </table>
  <table class="g" style="margin-top:-0.3mm">
    <colgroup><col style="width:40%"><col style="width:60%"></colgroup>
    <tr>
      <td><span class="lbl">Prepaid &nbsp;&nbsp; Weight Charge &nbsp;&nbsp; Collect</span>AS AGREED<br><span class="lbl" style="margin-top:2mm">Total Other Charges Due Carrier</span>AS AGREED<br><span class="lbl" style="margin-top:2mm">Total Prepaid</span>AS AGREED</td>
      <td><span class="lbl">Other Charges</span>AWC: AS AGREED &nbsp; FSC: AS AGREED &nbsp; SCC: AS AGREED<br>
        <span class="small">Shipper certifies that the particulars on the face hereof are correct and that insofar as any part of the consignment contains dangerous goods, such part is properly described by name and is in proper condition for carriage by air according to the applicable Dangerous Goods Regulations.</span><br>
        <span class="lbl" style="margin-top:2mm">Signature of Shipper or his Agent</span>RHEINWERK KUECHENTECHNIK GMBH</td>
    </tr>
    <tr>
      <td><span class="lbl">Total Collect</span>&nbsp;</td>
      <td><span class="lbl">Executed on (date) &nbsp;&nbsp;&nbsp; at (place) &nbsp;&nbsp;&nbsp; Signature of Issuing Carrier or its Agent</span>20 SEP 2026 &nbsp; FRANKFURT AM MAIN &nbsp; MAINSPEED AIR LOGISTIK GMBH</td>
    </tr>
  </table>
  <div class="foot"><span>ORIGINAL 3 (FOR SHIPPER)</span><span>HAWB ${HAWB}</span></div>
</div>`;
  return htmlDocument({ format: 'A4', css, pages: [body] });
}

const expectedLines = LINES.map((l, i) => ({
  lineNo: i + 1,
  styleNo: l.art,
  descriptionContains: l.match,
  quantity: l.qty,
  unit: l.unit,
  unitPrice: l.price,
  printedAmount: AMOUNTS[i],
  countryOfOrigin: 'DE',
  hs6: l.hs.replace(/\./g, '').slice(0, 6),
  hsPrinted: l.hs,
  enteredValue: [9240, 3870, 4640, 4128][i],
}));

export const s1: ShipmentSpec = {
  id: 's1-air-eur-fca',
  valuation: { lineAmounts: AMOUNTS, includedNonDutiableCharges: 0 },
  docs: [
    {
      file: `${INVOICE_NO}_Rechnung.pdf`,
      docType: 'commercial_invoice',
      variant: 'text',
      format: 'A4',
      pages: 1,
      html: invoiceHtml(),
      meta: { title: `Rechnung ${INVOICE_NO}`, author: SELLER.name },
      keyTokens: [INVOICE_NO, '18.09.2026', 'FCA', ...AMOUNTS.map((a) => fmtMoney(a, 'de')), fmtMoney(TOTAL, 'de'), ...LINES.map((l) => l.hs), '1.342,0'],
    },
    {
      file: `HAWB_${HAWB}_scan.pdf`,
      docType: 'air_waybill',
      variant: 'scan',
      format: 'A4',
      pages: 1,
      html: awbHtml(),
      meta: { title: `Scan HAWB ${HAWB}`, author: 'Mainspeed Air Logistik GmbH' },
      keyTokens: [
        MAWB,
        HAWB,
        'FRA',
        'ORD',
        'LH 8402',
        '21 SEP 2026',
        fmtNum(GROSS_KG, 1),
        fmtNum(CHARGEABLE_KG, 1),
        String(PACKAGES),
        'RHEINWERK',
        'LAKESHORE',
        'CHICAGO',
        'FRANKFURT',
        INVOICE_NO,
        '8211.91',
        '7323.93',
        fmtNum(VOLUME_CBM, 2),
      ],
      scan: {
        seed: 's1-awb',
        dpi: 200,
        rotateDeg: 0.8,
        noiseSigma: 7,
        blurSigma: 0.55,
        paper: [247, 244, 236],
        bed: [214, 211, 204],
        specklesPerMp: 18,
        jpegQuality: 80,
        stamps: [
          {
            cxMm: 150,
            cyMm: 112,
            wMm: 58,
            hMm: 22,
            angleDeg: -7,
            frame: 'double',
            color: '#c8102e',
            opacity: 0.78,
            lines: [
              { text: 'RECEIVED', sizeMm: 8.5, bold: true, fit: true },
              { text: '22 SEP 2026', sizeMm: 4.6, bold: true, font: "'Courier New', monospace" },
            ],
          },
        ],
      },
    },
  ],
  expected: {
    id: 's1-air-eur-fca',
    description:
      'German exporter (Solingen) → Chicago importer by air. Text-layer invoice in EUR with German number format and bilingual labels (Inv #, Unit Value, Ext. Value), FCA Frankfurt Airport, 8-digit HTS codes; scanned house air waybill with a red RECEIVED stamp; no packing list.',
    notes: [
      'Valuation policy: FCA Frankfurt Airport means the price ends when the seller hands the goods to the air carrier at FRA, so the invoice price contains no international freight or insurance. Nothing is deducted; no assists; no NCV lines. Entered value = line amount (EUR, whole number).',
      'Line 1: 2,400 PCS × EUR 3.85 = EUR 9,240.00 → 9,240.',
      'Line 2: 1,800 PCS × EUR 2.15 = EUR 3,870.00 → 3,870.',
      'Line 3: 400 SETS × EUR 11.60 = EUR 4,640.00 → 4,640.',
      'Line 4: 640 PCS × EUR 6.45 = EUR 4,128.00 → 4,128.',
      'Total entered value: 9,240 + 3,870 + 4,640 + 4,128 = 21,878 (EUR), equal to the printed invoice total EUR 21.878,00. USD conversion happens downstream (CURRENCY_CONVERSION); values here stay in EUR.',
      'The invoice prints amounts in German format (9.240,00 = 9240.00) and quantities without thousands separators.',
      'No packing list was supplied → MISSING_DOCUMENT. Packages (46 cartons) and weights come from the invoice footer and the AWB, and they agree (gross 1,342.0 kg).',
      'Chargeable weight 1,498.0 kg is volumetric (8.97 m³ × 167 kg/m³) and must NOT be used as the gross weight.',
      "The AWB box 'Declared Value for Customs: NCV' is the standard carriage-form entry, not a no-commercial-value invoice line, so NCV_VALUE must not fire.",
      'MAWB 020-12345675: prefix 020 = Lufthansa Cargo; serial check 1234567 mod 7 = 5 = last digit (valid). bills[0].masterScac "LH" assumes NetCHB expects the 2-character IATA carrier code for air (XSD carrierCodeType allows 2 or 4 chars) and masterBill the 11-digit AWB number; this mapping is inferred, not confirmed.',
      "Entry port 3901 = Chicago, IL (covers O'Hare air cargo); mode of transportation 40 = air.",
      'All four HTS numbers exist in the 2026 HTSUS (cached USITC subtrees in scripts/synthetic/reference/).',
    ],
    expect: {
      invoiceNumber: INVOICE_NO,
      invoiceNumberNormalized: INVOICE_NO,
      invoiceDate: '2026-09-18',
      currency: 'EUR',
      incoterm: { code: 'FCA', place: 'Frankfurt Airport' },
      sellerName: SELLER.name,
      buyerName: BUYER.name,
      importerName: BUYER.name,
      transport: {
        mode: 'air',
        modeTransportation: '40',
        entryPort: '3901',
        bills: [{ masterScac: 'LH', masterBill: MAWB.replace('-', ''), houseBill: HAWB }],
        grossWeightKg: GROSS_KG,
      },
      lines: expectedLines,
      totalEnteredValue: 21878,
      issuesInclude: ['MISSING_DOCUMENT', 'CURRENCY_CONVERSION'],
      issuesExclude: [
        'NON_DUTIABLE_CHARGES',
        'CHARGES_NOT_ITEMIZED',
        'LINE_AMOUNT_MISMATCH',
        'TOTALS_MISMATCH',
        'CONTAINER_NUMBER_INVALID',
        'CONTAINER_NUMBER_CORRECTED',
        'DATE_AMBIGUOUS',
        'HTS_NOT_DECLARED',
        'ORIGIN_DIFFERS',
        'NCV_VALUE',
        'ASSIST',
        'QTY_MISMATCH',
        'GROSS_WEIGHT_MISMATCH',
        'PACKAGE_COUNT_MISMATCH',
        'INVOICE_NO_NORMALIZED',
        'TELEX_RELEASE',
      ],
    },
  },
};
