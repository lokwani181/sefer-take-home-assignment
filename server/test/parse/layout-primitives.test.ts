import { describe, expect, it } from 'vitest';
import { layoutFromText } from './helpers';
import { prepareLayout } from '../../src/parse/layout';
import { findLabelValue, findLabelValues } from '../../src/parse/labels';
import { cellText, extractTable, matchColumnField, type TableRow } from '../../src/parse/table';

const doc = (text: string, opts = {}) => prepareLayout(layoutFromText(text, opts));
const val = (text: string, field: Parameters<typeof findLabelValue>[1], opts: Parameters<typeof findLabelValue>[2] = {}) => findLabelValue(doc(text), field, opts)?.text;

describe('findLabelValue', () => {
  it('value to the right of a colon label, stopping at the next label', () => {
    const t = `
      Invoice No.: KBAS/NB/26-0912        Incoterms: CIF TACOMA, WA
      Invoice Date: 12/09/2026            Payment Terms: T/T 30 DAYS
    `;
    expect(val(t, 'invoiceNumber')).toBe('KBAS/NB/26-0912');
    expect(val(t, 'incoterms')).toBe('CIF TACOMA, WA');
    expect(val(t, 'invoiceDate')).toBe('12/09/2026');
    expect(val(t, 'paymentTerms')).toBe('T/T 30 DAYS');
  });

  it('variant wordings: "Inv #", "Your Ref", inline labels on one line', () => {
    const t = `
      Inv #     2026-0042
      Date: 04/03/2026 Buyer: ACME LLC P.O.: 778812 Terms: Net 30
    `;
    expect(val(t, 'invoiceNumber')).toBe('2026-0042');
    expect(val(t, 'date')).toBe('04/03/2026');
    expect(val(t, 'buyer')).toBe('ACME LLC');
    expect(val(t, 'poNumber')).toBe('778812');
  });

  it('bilingual labels ("Datum / Date", "Inv # / Rechnungs-Nr.")', () => {
    const t = `
      Inv # / Rechnungs-Nr.       RW-26-10387
      Datum / Date                18.09.2026
      Ihre Bestellung / Your PO   LCS-PO-55120
    `;
    expect(val(t, 'invoiceNumber')).toBe('RW-26-10387');
    expect(val(t, 'date')).toBe('18.09.2026');
    expect(val(t, 'poNumber')).toBe('LCS-PO-55120');
  });

  it('a label glued to its value is split', () => {
    expect(val('P/L No.: PL-77   Date:20-Sep-2026', 'date')).toBe('20-Sep-2026');
  });

  it('boxed form: value below the label inside its column box', () => {
    const t = `
      Port of Discharge        Place of Delivery        Type of Move
      TACOMA, WA, USA          KENT, WA (DOOR)          CFS / DOOR
    `;
    expect(val(t, 'portOfDischarge')).toBe('TACOMA, WA, USA');
    expect(val(t, 'placeOfDelivery')).toBe('KENT, WA (DOOR)');
    expect(val(t, 'moveType')).toBe('CFS / DOOR');
  });

  it('a row of column headers takes its values from the next line', () => {
    const t = `
      P.O. NO.     TERMS          SHIP VIA     F.O.B.       PORT OF DISCHARGE
      BW-26-0193   D/A 60 DAYS    SEA          CHENNAI      NEWARK, NJ
    `;
    expect(val(t, 'poNumber')).toBe('BW-26-0193');
    expect(val(t, 'paymentTerms')).toBe('D/A 60 DAYS');
    expect(val(t, 'incotermPoint')).toBe('CHENNAI');
    expect(val(t, 'portOfDischarge')).toBe('NEWARK, NJ');
  });

  it('numbered form fields "(11) Ocean vessel / Voy."', () => {
    const t = `
      (9) Pre-carriage by     (11) Ocean vessel / Voy.     (12) Port of loading
      TRUCK                   SEA ORCHID / 611W            CHENNAI, INDIA
    `;
    expect(val(t, 'vesselVoyage', { mode: 'belowFirst' })).toBe('SEA ORCHID / 611W');
    expect(val(t, 'portOfLoading', { mode: 'belowFirst' })).toBe('CHENNAI, INDIA');
    expect(val(t, 'preCarriage', { mode: 'belowFirst' })).toBe('TRUCK');
  });

  it('OCR reading "/" as a letter ("BiL No.") still matches B/L No.', () => {
    const t = `
      BiL No.                   Booking No.
      BMLVHCM26090418           BKG-0377
    `;
    expect(val(t, 'blNumber', { mode: 'belowFirst' })).toBe('BMLVHCM26090418');
  });

  it('party blocks: lines below, left-aligned segment only, stop at the next label', () => {
    const t = `
      SOLD TO / BILL TO:                     SHIP TO / DELIVER TO:
      NORTHBOUND OUTFITTERS, INC.            CASCADE FULFILLMENT LLC
      2150 NW Raleigh Street                 21820 76th Avenue South
      Portland, OR 97210, USA                Kent, WA 98032, USA

      Invoice No.: 1234
    `;
    expect(findLabelValue(doc(t), 'buyer', { mode: 'block', maxLines: 8 })?.lines).toEqual(['NORTHBOUND OUTFITTERS, INC.', '2150 NW Raleigh Street', 'Portland, OR 97210, USA']);
    expect(findLabelValue(doc(t), 'shipTo', { mode: 'block', maxLines: 8 })?.lines).toEqual(['CASCADE FULFILLMENT LLC', '21820 76th Avenue South', 'Kent, WA 98032, USA']);
  });

  it('words inside prose are not labels', () => {
    const t = `
      Terms: payment 30 days after the date of the bill of lading
    `;
    expect(val(t, 'date')).toBeUndefined();
    expect(findLabelValues(doc(t), 'blNumber')).toEqual([]);
  });
});

describe('matchColumnField', () => {
  it.each([
    ['Unit Price USD', 'unitPrice'],
    ['Unit', 'unit'],
    ['Amount USD', 'amount'],
    ['Ext. Value EUR', 'amount'],
    ['Total N.W. (kg)', 'netWeight'],
    ['N.W./Ctn (kg)', 'netWeightPerCarton'],
    ['Pcs/ Ctn', 'pcsPerCarton'],
    ['Total Pcs', 'quantity'],
    ['Carton No.', 'cartonRange'],
    ['Ctns', 'cartons'],
    ['Ctn Meas. (cm)', 'dimensions'],
    ['Menge Qty', 'quantity'],
    ['Zolltarif-Nr. HS Code', 'hsCode'],
    ['Colour / Size Assortment', 'colourSize'],
    ['Description of Goods', 'description'],
    ['No.', 'lineNo'],
    ['⑮ Unit Price (USD)', 'unitPrice'],
    ['⑫ Marks & Numbers of PKGS', 'marks'],
    ['Shipping Marks', 'marks'],
    ['Total Weight', 'grossWeight'],
  ])('%s → %s', (text, field) => {
    expect(matchColumnField(text)?.field).toBe(field);
  });

  // a short synonym inside a longer word is not a header ("GOLDLINE" ⊃ LINE, "BEACH" ⊃ EACH, "PRICELIST")
  it.each(['GOLDLINE', 'LONG BEACH', 'HOUSEHOLD ELECTRIC FOB', 'APPLIANCES BUSAN'])('%s → no column', (text) => {
    expect(matchColumnField(text)).toBeNull();
  });
});

describe('circled field numbers (Korean / Japanese trade forms)', () => {
  const t = `
    ① Shipper / Exporter                        ⑧ Invoice No. & Date
    MIRAEON HOME ELECTRIC CO., LTD.             MRH-260914-07      SEP. 14, 2026
    88, Namdongseo-ro, Incheon, Korea

    ② For Account & Risk of Messrs.             ⑩ L/C Issuing Bank
    GOLDLINE HOUSEWARES CORP.                   CORONADO TRUST BANK
    2455 E. 37th Street, Los Angeles, CA        LOS ANGELES MAIN OFFICE
  `;
  it('a circled number before a label starts the field like "(8)" does', () => {
    expect(val(t, 'invoiceNumber')).toMatch(/^MRH-260914-07\b/);
    expect(val(t, 'seller', { mode: 'block', maxLines: 3 })).toMatch(/^MIRAEON HOME ELECTRIC/);
  });
  it('"Invoice No. & Date" carries the date, "For Account & Risk of Messrs." is the buyer', () => {
    expect(val(t, 'invoiceDate')).toMatch(/SEP\. 14, 2026/);
    expect(val(t, 'buyer', { mode: 'block', maxLines: 3 })).toMatch(/^GOLDLINE HOUSEWARES CORP\./);
  });
});

function rowsOf(text: string, anchors: Parameters<typeof extractTable>[1]['anchors'], opts = {}) {
  const t = extractTable(doc(text, opts), { anchors, minFields: 3 });
  return { t, get: (r: TableRow, f: Parameters<typeof cellText>[1]) => cellText(r, f) };
}

describe('extractTable', () => {
  it('single header line, continuation lines, totals stop', () => {
    const { t, get } = rowsOf(
      `
      No.  Style No.  Description of Goods            HS Code   Quantity  Unit  Unit Price    Amount
      1    NB-T101    MEN'S CREW NECK T-SHIRT         6109.10      2,400  PCS         2.85  6,480.00
                      100% Cotton single jersey
                      Colours: Black / White
      2    NB-H205    WOMEN'S HOODIE                  6110.20      1,200  PCS         7.40  8,880.00
                      60% Cotton 40% Polyester
      TOTAL                                                        3,600                  15,360.00
      NOTES: something else
    `,
      ['lineNo', 'style'],
    );
    expect(t.rows).toHaveLength(2);
    expect(get(t.rows[0], 'style')).toBe('NB-T101');
    expect(get(t.rows[0], 'quantity')).toBe('2,400');
    expect(get(t.rows[1], 'amount')).toBe('8,880.00');
    expect(t.rows[0].lines).toHaveLength(3);
    expect(t.pages[0].stopLine?.text).toMatch(/^TOTAL/);
  });

  it('different column order with a two-line header (Unit / Price stacked)', () => {
    const { t, get } = rowsOf(
      `
                                                          Unit
      Item        HS Code      Description        Qty     Price     Amount     Ctns
      HY-ST2201   9403.60.80   SIDE TABLE         240     18.50   4,440.00      120
                               acacia wood
      HY-BS4410   9403.60.80   BOOKSHELF          150     32.40   4,860.00      150
      TOTAL:                                      390               9,300.00      270
    `,
      ['lineNo', 'style'],
    );
    const fields = t.pages[0].columns.map((c) => c.field);
    expect(fields).toEqual(['style', 'hsCode', 'description', 'quantity', 'unitPrice', 'amount', 'cartons']);
    expect(t.rows.map((r) => get(r, 'style'))).toEqual(['HY-ST2201', 'HY-BS4410']);
    expect(get(t.rows[0], 'unitPrice')).toBe('18.50');
    expect(get(t.rows[1], 'cartons')).toBe('150');
  });

  it('infers an unlabeled column from arithmetic (cartons × pcs/ctn = total pcs)', () => {
    const { t, get } = rowsOf(
      `
      Carton No.   Style      Description          Pcs/Ctn   Total Pcs   N.W./Ctn   Total N.W.
      1-48         NB-T101    TEE            48         50       2,400       9.00       432.00
      49-97        NB-H205    HOODIE         49         24       1,176      14.60       715.40
      GRAND TOTAL                            97                  3,576                1,147.40
    `,
      ['cartonRange', 'style'],
      { source: 'ocr' },
    );
    const cartons = t.pages[0].columns.find((c) => c.field === 'cartons');
    expect(cartons?.inferred).toBe(true);
    expect(get(t.rows[0], 'cartons')).toBe('48');
    expect(get(t.rows[1], 'pcsPerCarton')).toBe('24');
    expect(get(t.rows[1], 'quantity')).toBe('1,176');
  });

  it('tables across pages: repeated header and brought-forward line', () => {
    const { t, get } = rowsOf(
      `
      No.  Description          Qty     Price     Amount
      1    BLUE WIDGET           10      1.00      10.00
      2    RED WIDGET            20      2.00      40.00
      SUB-TOTAL CARRIED FORWARD                    50.00
      === PAGE ===
      No.  Description          Qty     Price     Amount
                                   BROUGHT FORWARD 50.00
      3    GREEN WIDGET          30      3.00      90.00
      TOTAL                                       140.00
    `,
      ['lineNo'],
    );
    expect(t.rows.map((r) => [r.page, get(r, 'description')])).toEqual([
      [1, 'BLUE WIDGET'],
      [1, 'RED WIDGET'],
      [2, 'GREEN WIDGET'],
    ]);
    expect(t.pages[1].broughtForward).toHaveLength(1);
  });

  it('continues on a page without a header after a "continued" footer', () => {
    const { t } = rowsOf(
      `
      Line  Description          Qty     Price     Amount
      1     BLUE WIDGET           10      1.00      10.00
      Continued on next page
      === PAGE ===
      2     RED WIDGET            20      2.00      40.00
      TOTAL                                        50.00
    `,
      ['lineNo'],
    );
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1].page).toBe(2);
  });

  it('quantity-first layout without line numbers', () => {
    const { t, get } = rowsOf(
      `
      QTY     U/M   ITEM CODE   DESCRIPTION                     RATE      AMOUNT
      3,000   PCS   KK-M1042    MEN'S CREW NECK T-SHIRT         2.40    7,200.00
                                100% cotton single jersey knit
      1,200   PCS   LW-W2210    WOMEN'S STRAIGHT LEG TROUSERS   7.15    8,580.00
                                MADE IN SRI LANKA
                                                 TOTAL US$             15,780.00
    `,
      ['lineNo', 'style', 'description'],
    );
    expect(t.rows.map((r) => get(r, 'style'))).toEqual(['KK-M1042', 'LW-W2210']);
    expect(get(t.rows[1], 'quantity')).toBe('1,200');
    expect(get(t.rows[0], 'unitPrice')).toBe('2.40');
  });

  it('a row whose anchor was lost by OCR is still a new row when it repeats the value columns', () => {
    const { t } = rowsOf(
      `
      Item        Description        Ctns     Qty     Price      Amount
      HY-ST2201   SIDE TABLE          120     240     18.50    4,440.00
                  LAPTOP BACKPACK      60   1,200      6.85    8,280.00
      HY-BP3090   KIDS BACKPACK        40     800      4.25    3,400.00
    `,
      ['lineNo', 'style'],
    );
    expect(t.rows).toHaveLength(3);
  });

  it('reports a missing header', () => {
    const t = extractTable(doc('just some text\nwithout any table'), { anchors: ['lineNo'] });
    expect(t.found).toBe(false);
    expect(t.warnings).toContain('item table header not found');
  });
});
