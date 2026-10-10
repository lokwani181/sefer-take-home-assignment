import { describe, expect, it } from 'vitest';
import type { BillOfLadingData, CommercialInvoiceData, DocumentLayout, PackingListData } from '@app/shared';
import { layoutFromText } from './helpers';
import { classifyDocument, parseDocument } from '../../src/parse';

describe('invoice with US conventions and different wording', () => {
  const layout = layoutFromText(`
    ACME OUTDOOR GEAR INC.
    400 Industrial Way, Suite 9
    Reno, NV 89502, USA
                                    INVOICE
    Invoice #: 2026-0412                   Date: 03/04/2026
    Customer PO: PO-77812                  Terms: Net 30
    Currency: USD                          Shipping Terms: FOB Oakland, CA

    Bill To:                               Ship To:
    NORTHERN TRAILS LTD                    NORTHERN TRAILS DC
    12 King Street West                    88 Dock Road
    Toronto, ON M5H 1A1, Canada            Mississauga, ON L5T 2N7, Canada

    Item   Qty    UOM   Description                       Origin    Unit Value    Ext. Value
    1      500    PCS   ROLL-TOP BACKPACK 30L             VN             12.00      6,000.00
                        Outer: 600D polyester
    2      200    PRS   TRAIL GLOVES                      CN              4.50        900.00
    3       10    PCS   DISPLAY STANDS - FOC NCV          US             (0.00)       (0.00)

    Freight:                                                                          350.00
    Total Amount Due:                                                               7,250.00
  `);
  const doc = parseDocument(layout);
  const d = doc.data as CommercialInvoiceData;

  it('classifies and reads the header', () => {
    expect(doc.docType).toBe('commercial_invoice');
    expect(d.invoiceNumber).toBe('2026-0412');
    expect(d.poNumbers).toEqual(['PO-77812']);
    expect(d.currency).toBe('USD');
    expect(d.incoterm).toMatchObject({ code: 'FOB', place: 'Oakland, CA' });
    expect(d.seller).toMatchObject({ name: 'ACME OUTDOOR GEAR INC.', country: 'US', stateProvince: 'NV' });
    expect(d.buyer).toMatchObject({ name: 'NORTHERN TRAILS LTD', country: 'CA', postalCode: 'M5H 1A1' });
    expect(d.shipTo?.name).toBe('NORTHERN TRAILS DC');
  });

  it('a US issuer writes MM/DD: 03/04/2026 is March 4, with the other reading kept', () => {
    expect(d.invoiceDate).toBe('2026-03-04');
    expect(d.invoiceDateAmbiguous).toBe(true);
    expect(d.invoiceDateAlternatives).toEqual(['2026-04-03']);
  });

  it('lines with an origin column, different units and an NCV line', () => {
    expect(d.lines.map((l) => [l.lineNo, l.quantity, l.unit, l.unitPrice, l.amount, l.countryOfOrigin])).toEqual([
      [1, 500, 'PCS', 12, 6000, 'VN'],
      [2, 200, 'PRS', 4.5, 900, 'CN'],
      [3, 10, 'PCS', 0, 0, 'US'],
    ]);
    expect(d.lines[2].noCommercialValue).toBe(true);
    expect(d.lines[0].details).toEqual(['Outer: 600D polyester']);
    expect(d.charges).toEqual([{ type: 'freight', amount: 350, description: 'Freight' }]);
    expect(d.totals).toEqual([{ label: 'Total Amount Due', amount: 7250 }]);
  });
});

describe('combined invoice & packing list (weights in LBS)', () => {
  const layout = layoutFromText(`
                    COMMERCIAL INVOICE & PACKING LIST
    Seller: SHENZHEN BRIGHT LAMP CO., LTD.               Invoice No.: SBL-2609-01
    No. 8 Keji Road, Nanshan, Shenzhen, China            Date: 2026-09-01
    Buyer: LUMEN HOME LLC, 55 Pine St, Austin, TX 78701, USA

    No.  Item No.   Description           Ctns   Qty     Unit Price    Amount     N.W.(LBS)   G.W.(LBS)
    1    LMP-100    DESK LAMP              10    200          5.00    1,000.00       220.00      242.00
    2    LMP-200    FLOOR LAMP              5     50         20.00    1,000.00       330.75      352.80
    TOTAL                                  15    250                  2,000.00       550.75      594.80
  `);
  const doc = parseDocument(layout);
  const d = doc.data as CommercialInvoiceData;

  it('is an invoice_packing_list with invoice data', () => {
    expect(doc.docType).toBe('invoice_packing_list');
    expect(d.kind).toBe('commercial_invoice');
    expect(d.invoiceNumber).toBe('SBL-2609-01');
    expect(d.invoiceDate).toBe('2026-09-01');
    expect(d.seller?.country).toBe('CN');
    expect(d.buyer).toMatchObject({ name: 'LUMEN HOME LLC', stateProvince: 'TX', postalCode: '78701' });
  });

  it('per-line cartons and weights converted to kg, plus packing totals', () => {
    const kg = (lb: number) => Math.round(lb * 0.45359237 * 1000) / 1000;
    expect(d.lines.map((l) => [l.styleNo, l.cartons, l.netWeightKg, l.grossWeightKg])).toEqual([
      ['LMP-100', 10, kg(220), kg(242)],
      ['LMP-200', 5, kg(330.75), kg(352.8)],
    ]);
    expect(d.packingTotals).toEqual({ cartons: 15, netWeightKg: kg(550.75), grossWeightKg: kg(594.8) });
  });
});

describe('packing list: derivations and confirmed repairs', () => {
  const layout = layoutFromText(
    `
    PACKING LIST
    Packing List No.: PL-0091                 Date: 05-Aug-2026
    Shipper: DHAKA KNIT WEAR LTD, Plot 4, Gazipur, Bangladesh
    Consignee: BLUE RIVER APPAREL INC, 9 Elm St, Newark, NJ 07102, USA

    Ctn No.    Style     Description              Ctns   Qty/Ctn   Total Qty   NW/Ctn   GW/Ctn   Total NW   Total GW
    1-20       BR-11     GIRLS DRESS 100% COTTON    20        25         500    10.00    11.00     200.00     220.00
    21-30      BR-12     BOYS SHORTS CVC 60/40      10        30         300    12,50    13.50     125.00     135.00
    31         BR-13     SAMPLES                              12          12     4.00     4.50       4.00       4.50
    GRAND TOTAL                                     31                   812                         329.00     359.50
  `,
    { source: 'ocr', conf: { '12,50': 70 } },
  );
  const doc = parseDocument(layout);
  const d = doc.data as PackingListData;

  it('reads the table generically', () => {
    expect(doc.docType).toBe('packing_list');
    expect(d.plNumber).toBe('PL-0091');
    expect(d.date).toBe('2026-08-05');
    expect(d.lines.map((l) => [l.cartonRange, l.styleNo, l.cartons, l.pcsPerCarton, l.totalPcs])).toEqual([
      ['1-20', 'BR-11', 20, 25, 500],
      ['21-30', 'BR-12', 10, 30, 300],
      ['31', 'BR-13', 1, 12, 12],
    ]);
    expect(d.lines[1].composition).toEqual([
      { fiber: 'cotton', pct: 60 },
      { fiber: 'polyester', pct: 40 },
    ]);
    expect(d.totals).toMatchObject({ cartons: 31, pcs: 812, netWeightKg: 329, grossWeightKg: 359.5 });
  });

  it('a decimal comma confirmed by arithmetic is repaired; a missing carton count is derived', () => {
    expect(d.lines[1].netWeightPerCartonKg).toBe(12.5);
    expect(doc.fieldMeta['lines[1].netWeightPerCartonKg']).toMatchObject({ repaired: true, originalText: '12,50', conf: 70 });
    expect(doc.fieldMeta['lines[2].cartons']).toMatchObject({ repaired: true, conf: 50 });
    expect(doc.observations.filter((o) => o.kind === 'ocr_repair').map((o) => o.field)).toEqual(['lines[1].netWeightPerCartonKg', 'lines[2].cartons']);
  });
});

describe('bill of lading with a stamp pass and a typed issue date', () => {
  const layout = layoutFromText(
    `
    Shipper                                   BILL OF LADING
    EAST WIND TEXTILES CO., LTD.              B/L No.: EWTL260911
    18 Harbor Road, Ningbo, China             SCAC: EWTL
    Consignee                                 Ocean Carrier: GREAT OCEAN LINE (GOLU)
    TO ORDER OF WEST BANK                     MBL: GOLU260900123
    Notify Party
    PACIFIC HOME INC, 1 Bay St, Oakland, CA 94607, USA
    Vessel / Voyage          Port of Loading        Port of Discharge
    OCEAN STAR / 112E        NINGBO, CHINA          OAKLAND, CA, USA
    Container / Seal              No. of Pkgs     Gross Weight     Measurement
    CSQU3054383 / SEAL 778812     250 CTNS        4,410.50 KGS     38.200 CBM
    Place and Date of Issue: NINGBO, 2026-09-24
    FREIGHT COLLECT
  `,
    { source: 'ocr', stamps: ['TELEX RELEASED', 'BLUE: SHIPPED ON BOARD', 'BLUE: DATE: 24 SEP 2006'] },
  );
  const doc = parseDocument(layout);
  const d = doc.data as BillOfLadingData;

  it('reads numbers, SCACs and transport facts', () => {
    expect(doc.docType).toBe('bill_of_lading');
    expect(d).toMatchObject({
      blType: 'house',
      blNumber: 'EWTL260911',
      issuerScac: 'EWTL',
      masterBlNumber: 'GOLU260900123',
      carrierScac: 'GOLU',
      carrierName: 'GREAT OCEAN LINE',
      vessel: 'OCEAN STAR',
      voyage: '112E',
      portOfLoading: 'NINGBO, CHINA',
      portOfDischarge: 'OAKLAND, CA, USA',
      grossWeightKg: 4410.5,
      volumeCbm: 38.2,
      packages: { count: 250, unit: 'CTNS' },
      freightTerms: 'FREIGHT COLLECT',
      releaseType: 'telex',
      issueDate: '2026-09-24',
      issuePlace: 'NINGBO',
    });
    expect(d.containers).toEqual([{ number: 'CSQU3054383', checkDigitValid: true, sealNumbers: ['778812'] }]);
    expect(d.notifyParty).toMatchObject({ name: 'PACIFIC HOME INC', stateProvince: 'CA', postalCode: '94607' });
  });

  it('the stamp date is checked against the typed issue date', () => {
    expect(d.onBoardDate).toBe('2026-09-24');
    expect(doc.fieldMeta.onBoardDate).toMatchObject({ repaired: true, originalText: '24 SEP 2006' });
    expect(doc.observations.filter((o) => o.kind === 'stamp').map((o) => o.text)).toEqual(['TELEX RELEASED', 'SHIPPED ON BOARD', 'DATE: 24 SEP 2006']);
  });
});

describe('classification of other document types', () => {
  it('arrival notice is parsed with the transport-document parser', () => {
    const doc = parseDocument(
      layoutFromText(`
        CARGO ARRIVAL NOTICE
        B/L No.: MEDU1234567          ETA: 10/14/2026
        Vessel: MSC ANNA              Free time: 5 days
        Container: CSQU3054383
      `),
    );
    expect(doc.docType).toBe('arrival_notice');
    expect((doc.data as BillOfLadingData).blNumber).toBe('MEDU1234567');
    expect(doc.observations.find((o) => o.field === 'eta')?.text).toMatch(/^ETA 2026-10-14/);
    expect((doc.data as BillOfLadingData).containers[0]?.number).toBe('CSQU3054383');
  });

  it('a document without trade signals is "other"', () => {
    const layout = layoutFromText(`
      MEETING MINUTES
      Attendees: A, B
      The weather was nice.
    `);
    expect(classifyDocument(layout).docType).toBe('other');
    const doc = parseDocument(layout);
    expect(doc.data).toMatchObject({ kind: 'other', title: 'MEETING MINUTES' });
  });

  it('body signals classify a document whose title was not read', () => {
    const c = classifyDocument(
      layoutFromText(`
        Shipper                         Consignee
        A CO                            B CO
        Notify Party                    Port of Loading         Port of Discharge
        Ocean Vessel                    Place of Receipt        Freight Prepaid
        Number of Original B/Ls: 3      Shipped on board
      `),
    );
    expect(c.docType).toBe('bill_of_lading');
  });
});

describe('robustness', () => {
  it('never throws on empty or garbage layouts', () => {
    const empty: DocumentLayout = { docId: 'e', fileName: 'e.pdf', sha256: '', mime: 'application/pdf', pages: [] };
    expect(parseDocument(empty).docType).toBe('other');
    const garbage = layoutFromText(`
      ||| ~~~ ___ ;; .. ,,
      @@@ ### $$$ %%% 0000 1111
      INVOICE INVOICE
      Qty Qty Qty Price Amount
      1 2 3 4 5 6 7 8 9
    `);
    expect(() => parseDocument(garbage)).not.toThrow();
  });
});

describe('packing list: unique single-cell OCR repair', () => {
  const pl = (total: string) =>
    parseDocument(
      layoutFromText(
        `
        PACKING LIST
        Carton No.   Style     Description     Ctns   Pcs/Ctn   Total Pcs   N.W./Ctn   Total N.W.
        1-48         A-1       TEE               48        50       2,400       9.00       432.00
        49-97        B-2       HOODIE            49        24       ${total}      14.60       715.40
        GRAND TOTAL                              97                 3,576                1,147.40
      `,
        { source: 'ocr' },
      ),
    );

  it('"1,776" for 1,176 is repaired: the only one-digit change that satisfies 49 × 24 and the grand total', () => {
    const doc = pl('1,776');
    const d = doc.data as PackingListData;
    expect(d.lines[1].totalPcs).toBe(1176);
    expect(doc.fieldMeta['lines[1].totalPcs']).toMatchObject({ repaired: true, originalText: '1,776' });
    expect(doc.observations.some((o) => o.kind === 'ocr_repair' && o.field === 'lines[1].totalPcs')).toBe(true);
  });

  it('a value with no unique repair is kept as read and reported', () => {
    const doc = pl('1,900');
    expect((doc.data as PackingListData).lines[1].totalPcs).toBe(1900);
    expect(doc.observations.some((o) => o.kind === 'other' && /no unique OCR repair/.test(o.text))).toBe(true);
  });
});

describe('bill of lading with several containers', () => {
  it('returns one container per number, seals assigned by proximity', () => {
    const doc = parseDocument(
      layoutFromText(`
        BILL OF LADING                         B/L No.: COSU6123456780
        Container No. / Seal No.        No. of Pkgs     Description of Goods        Gross Weight
        CSQU3054383 / SEAL A1001        500 CTNS        PLASTIC TOYS                12,000.00 KGS
        TCLU1234568 / SEAL A1002        480 CTNS
        2 X 40'HC
      `),
    );
    const d = doc.data as BillOfLadingData;
    expect(d.containers.map((c) => [c.number, c.checkDigitValid, c.sealNumbers])).toEqual([
      ['CSQU3054383', true, ['A1001']],
      ['TCLU1234568', true, ['A1002']],
    ]);
    expect(d.containers[0].sizeType).toBe('40HC');
    expect(d.grossWeightKg).toBe(12000);
  });
});

describe('more unseen layouts', () => {
  it('description-only table: detail lines stay with their row; "Shipping" is freight', () => {
    const doc = parseDocument(
      layoutFromText(`
        INVOICE
        Invoice Number: 88812
        Invoice Date: October 9, 2026
        Sold To: BIG BOX STORES INC, 100 Main St, Dallas, TX 75201
        Description                      Quantity   Unit Price        Total
        Cotton T-shirts, men's              1,000     $3.00     $3,000.00
          100% cotton jersey
        Denim jeans                           500    $12.00     $6,000.00
          98% cotton 2% elastane, woven
                                                   Subtotal     $9,000.00
                                                   Shipping       $250.00
                                                   Total        $9,250.00
      `),
    );
    const d = doc.data as CommercialInvoiceData;
    expect(d.invoiceNumber).toBe('88812');
    expect(d.invoiceDate).toBe('2026-10-09');
    expect(d.buyer).toMatchObject({ name: 'BIG BOX STORES INC', stateProvince: 'TX' });
    expect(d.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.amount, l.compositionRaw])).toEqual([
      ["Cotton T-shirts, men's", 1000, 3, 3000, '100% cotton'],
      ['Denim jeans', 500, 12, 6000, '98% cotton 2% elastane'],
    ]);
    expect(d.lines[1].construction).toBe('woven');
    expect(d.charges).toEqual([{ type: 'freight', amount: 250, description: 'Shipping' }]);
    expect(d.totals.map((t) => [t.label, t.amount])).toEqual([
      ['Subtotal', 9000],
      ['Total', 9250],
    ]);
  });

  it('"Item No." holding SKUs is the style column; title doubles as the invoice-number label', () => {
    const doc = parseDocument(
      layoutFromText(`
        COMMERCIAL INVOICE No. 2026/77
        Date: 2026-10-01         Country of Origin: CHINA         Terms: EXW Ningbo
        Item No.     Description                 Qty    Unit    Price      Amount
        SKU-1001     LED BULB 9W                 2000   PCS     0.85     1,700.00
        SKU-1002     LED TUBE 18W                1000   PCS     2.10     2,100.00
        TOTAL                                    3000                    3,800.00
      `),
    );
    const d = doc.data as CommercialInvoiceData;
    expect(d.invoiceNumber).toBe('2026/77');
    expect(d.countryOfOrigin).toBe('CN');
    expect(d.incoterm).toMatchObject({ code: 'EXW', place: 'Ningbo' });
    expect(d.lines.map((l) => [l.styleNo, l.description, l.quantity, l.unit, l.unitPrice, l.amount])).toEqual([
      ['SKU-1001', 'LED BULB 9W', 2000, 'PCS', 0.85, 1700],
      ['SKU-1002', 'LED TUBE 18W', 1000, 'PCS', 2.1, 2100],
    ]);
    expect(d.totals).toEqual([{ label: 'TOTAL', amount: 3800 }]);
  });

  it('packing list with totals-only columns derives per-carton values', () => {
    const doc = parseDocument(
      layoutFromText(`
        PACKING LIST
        Invoice No.: INV-5   PO: 4500012345
        Style       Description         Cartons    Qty (pcs)   Net Wt (kg)   Gross Wt (kg)   CBM
        ST-1        WOMEN'S DRESS            10         200         80.00          95.00       0.50
        ST-2        MEN'S SHIRT               5         150         45.00          52.50       0.25
        TOTAL                                15         350        125.00         147.50       0.75
      `),
    );
    const d = doc.data as PackingListData;
    expect(d.invoiceRefs).toEqual(['INV-5']);
    expect(d.poNumbers).toEqual(['4500012345']);
    expect(d.lines.map((l) => [l.styleNo, l.cartons, l.pcsPerCarton, l.totalPcs, l.netWeightPerCartonKg, l.grossWeightKg])).toEqual([
      ['ST-1', 10, 20, 200, 8, 95],
      ['ST-2', 5, 30, 150, 9, 52.5],
    ]);
    expect(d.totals).toEqual({ cartons: 15, pcs: 350, netWeightKg: 125, grossWeightKg: 147.5, volumeCbm: 0.75 });
  });
});

describe('letterhead printed beside the title', () => {
  it('the issuer block continues below the title line (city line shares a line with a DATE / INVOICE # box)', () => {
    const doc = parseDocument(
      layoutFromText(`
        NORDLICHT TEXTIL GMBH                                      INVOICE
        Werkstrasse 12
        70173 Stuttgart, GERMANY                        DATE        INVOICE #
        Tel: +49 711 555 0100                           05/06/2026  NT-2231

        BILL TO
        HARBOR GOODS LLC
        500 Pier Avenue
        Seattle, WA 98101, USA

        QTY    U/M   ITEM CODE   DESCRIPTION                   RATE      AMOUNT
        100    PCS   NT-1        WOOL SCARF                    12.00   1,200.00
                                                     TOTAL EUR         1,200.00
      `),
    );
    const d = doc.data as CommercialInvoiceData;
    expect(d.seller).toMatchObject({
      name: 'NORDLICHT TEXTIL GMBH',
      lines: ['Werkstrasse 12'],
      city: 'Stuttgart',
      postalCode: '70173',
      country: 'DE',
      phone: '+49 711 555 0100',
    });
    expect(d.seller?.raw).not.toMatch(/DATE|INVOICE|NT-2231/);
    expect(d.buyer?.name).toBe('HARBOR GOODS LLC');
  });

  it('the continuation stops at the next party label', () => {
    const doc = parseDocument(
      layoutFromText(`
        SIAM CERAMIC WORKS CO., LTD.                          COMMERCIAL INVOICE
        88 Moo 4, Bangna-Trad Road
        Bang Phli, Samut Prakan 10540, THAILAND
        Bill To: HARBOR GOODS LLC, 500 Pier Avenue, Seattle, WA 98101, USA
        Invoice No.: SCW-0912                                 Date: 2026-09-12

        Description                      Quantity   Unit Price        Amount
        Stoneware mugs                      1,000       2.00        2,000.00
                                                   Total            2,000.00
      `),
    );
    const d = doc.data as CommercialInvoiceData;
    expect(d.seller).toMatchObject({ name: 'SIAM CERAMIC WORKS CO., LTD.', city: 'Bang Phli', postalCode: '10540', country: 'TH' });
    expect(d.seller?.raw).not.toMatch(/HARBOR/);
    expect(d.buyer?.name).toBe('HARBOR GOODS LLC');
  });

  it('the continuation stops at a labelled field in the same column', () => {
    const doc = parseDocument(
      layoutFromText(`
        ANDES KNITWEAR S.A.C.                                       INVOICE
        Av. Argentina 2150
        Lima 15081, PERU
        Invoice No.: AK-3301
        Date: 2026-08-14
        Sold To: HARBOR GOODS LLC, 500 Pier Avenue, Seattle, WA 98101, USA

        Description                      Quantity   Unit Price        Amount
        Alpaca sweaters                       200      40.00        8,000.00
                                                   Total            8,000.00
      `),
    );
    const d = doc.data as CommercialInvoiceData;
    expect(d.seller).toMatchObject({ name: 'ANDES KNITWEAR S.A.C.', lines: ['Av. Argentina 2150'], city: 'Lima', postalCode: '15081', country: 'PE' });
    expect(d.seller?.raw).not.toMatch(/AK-3301|2026-08-14|HARBOR/);
    expect(d.invoiceNumber).toBe('AK-3301');
  });
});

describe('line-level "MADE IN <country> - <maker>" blocks', () => {
  it('stop at a blank line: text after the gap is not part of the maker address', () => {
    const doc = parseDocument(
      layoutFromText(`
        HARBOR TRADING LTD.
        12 Queen's Road Central, Hong Kong
                                     INVOICE
        Invoice No.: HT-77                     Date: 2026-09-01
        QTY    U/M   ITEM CODE   DESCRIPTION                                 RATE      AMOUNT
        500    PCS   AB-1        MEN'S WOVEN SHIRT                           4.00    2,000.00
                                 100% cotton poplin
                                 MADE IN SRI LANKA - Lanka Weave Garments
                                 (Pvt) Ltd, 41 Baseline Road, Colombo 09

                                 Packed flat, 20 per carton
                                                        TOTAL US$              2,000.00
      `),
    );
    const l = (doc.data as CommercialInvoiceData).lines[0];
    expect(l.countryOfOrigin).toBe('LK');
    expect(l.manufacturer).toMatchObject({ name: 'Lanka Weave Garments (Pvt) Ltd', lines: ['41 Baseline Road'], city: 'Colombo', postalCode: '09', country: 'LK' });
  });
});
