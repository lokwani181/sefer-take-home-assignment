/**
 * Layout patterns found by the blind generalization run (s4/s5, docs/GENERALIZATION.md), rebuilt as
 * small page-art documents with invented content so each generic rule is pinned independently of
 * the synthetic files: Korean/Japanese trade-form invoices (circled box numbers, "Invoice No. & Date",
 * caption rows, header-less continuation pages, SUB TOTAL with quantities, signed discounts).
 */
import { describe, expect, it } from 'vitest';
import type { BillOfLadingData, CommercialInvoiceData, PackingListData } from '@app/shared';
import { layoutFromText } from './helpers';
import { parseDocument, prepareLayout } from '../../src/parse';
import { scanLabelledAmounts } from '../../src/parse/docs/invoice';
import { findLabelValue } from '../../src/parse/labels';

describe('trade-form invoice: circled box numbers, caption row, continuation page, discount', () => {
  const layout = layoutFromText(`
                         HANBIT KITCHENWARE CO., LTD.
                              COMMERCIAL INVOICE
    ① Shipper / Exporter                           ⑧ Invoice No. & Date
    HANBIT KITCHENWARE CO., LTD.                   HKW-2611-03                          NOV. 03, 2026
    12, Gongdan-ro, Gimhae 50969, Korea
    ② For Account & Risk of Messrs.                ⑪ Remarks
    PINECREST HOME SUPPLY LLC                      Terms of Price : FOB BUSAN, KOREA
    77 Harbor Blvd, Oakland, CA 94607, U.S.A.      P/O No. : PHS-4471
    ⑥ Shipped per       ⑦ Sailing on or about       TEL +82-55-123-4567
    HANNURI STAR        NOV. 08, 2026

    ⑫ Marks & Nos.   Description of Goods        Model No.    Quantity     Unit Price    Amount
                     KITCHEN APPLIANCES                                    FOB BUSAN
    PINECREST        ELECTRIC KETTLE 1.7L        HK-EK17      600 PCS          12.50     7,500.00
    OAKLAND          Stainless steel body
                     TOASTER 2-SLICE             HK-TS02      400 PCS          15.00     6,000.00
                     Bread warming rack
    === PAGE ===
                     HAND MIXER 5-SPEED          HK-HM05      300 PCS          10.00     3,000.00
                     Chrome beaters
                     SUB TOTAL                                1,300 PCS                 16,500.00
                     LESS : 2% VOLUME DISCOUNT                                  -USD      330.00
                     TOTAL AMOUNT : FOB BUSAN                                   USD    16,170.00
  `);
  const doc = parseDocument(layout);
  const d = doc.data as CommercialInvoiceData;

  it('reads labels that follow circled box numbers, incl. a combined "Invoice No. & Date" box', () => {
    expect(d.invoiceNumber).toBe('HKW-2611-03');
    expect(d.invoiceDate).toBe('2026-11-03');
    expect(d.seller?.name).toBe('HANBIT KITCHENWARE CO., LTD.');
    expect(d.buyer?.name).toBe('PINECREST HOME SUPPLY LLC');
    // the party blocks stop at the next numbered label
    expect(d.seller?.raw).not.toMatch(/PINECREST|For Account/);
  });

  it('reads a value below its label when the text to its right is another box ("Sailing on or about   TEL …")', () => {
    expect(d.etd).toBe('2026-11-08');
    expect(d.vessel).toBe('HANNURI STAR');
  });

  it('a remarks box above the item table does not swallow the table (its labelled fields stay readable)', () => {
    expect(d.poNumbers).toEqual(['PHS-4471']);
    expect(d.notes.join(' ')).not.toMatch(/ELECTRIC KETTLE|Model No/);
  });

  it('skips the caption row and continues the table on a page without a header', () => {
    expect(d.lines.map((l) => l.styleNo)).toEqual(['HK-EK17', 'HK-TS02', 'HK-HM05']);
    expect(d.lines[0].description).toBe('ELECTRIC KETTLE 1.7L');
    expect(d.lines.map((l) => [l.quantity, l.unit, l.amount])).toEqual([
      [600, 'PCS', 7500],
      [400, 'PCS', 6000],
      [300, 'PCS', 3000],
    ]);
  });

  it('reads SUB TOTAL past a quantity total and the signed discount as a charge', () => {
    expect(d.totals).toEqual(
      expect.arrayContaining([
        { label: 'SUB TOTAL', amount: 16500 },
        expect.objectContaining({ amount: 16170 }),
      ]),
    );
    expect(d.charges).toEqual([{ type: 'discount', amount: -330, description: 'LESS : 2% VOLUME DISCOUNT' }]);
  });
});

describe('labelled amounts outside the item table', () => {
  const scan = (art: string) => scanLabelledAmounts(prepareLayout(layoutFromText(art)), new Set()).map((m) => [m.label, m.amount.value, m.amount.negative]);
  it('a totals row with several money columns is not a "label: amount" pair', () => {
    expect(scan(`
      TOTAL:     370     2,390 PCS     20,920.00 4,830.00 5,335.00
      TOTAL AMOUNT DDP SAVANNAH, GA:  USD 20,920.00
    `)).toEqual([['TOTAL AMOUNT DDP SAVANNAH, GA', 20920, false]]);
  });
  it('skips quantity totals and keeps the sign of "-USD"', () => {
    expect(scan(`
      SUB TOTAL            1,440 SETS          176,654.40
      LESS : 3% VOLUME DISCOUNT       -USD 5,299.63
    `)).toEqual([
      ['SUB TOTAL', 176654.4, false],
      ['LESS : 3% VOLUME DISCOUNT', 5299.63, true],
    ]);
  });
});

describe('packing list: stacked "Model No. / Description" column, C/T No., Package, CBM, mixed-unit totals', () => {
  const layout = layoutFromText(`
                                       PACKING LIST
    Model No. / Description       C/T No.        Quantity      Package      Net Weight   Gross Weight   Measurement
                                                                               (KGS)        (KGS)          (CBM)
    HK-EK17                       1 - 150        600 PCS       150 CTNS       1,200.00     1,350.00      9.000
    ELECTRIC KETTLE 1.7L
    4 PCS/CTN
    HK-TS02                       151 - 350      400 SETS      200 CTNS         800.00       900.00     10.000
    2-SLICE TOASTER WITH
    12-SETTING DIAL
    TOTAL                         1 - 350        400 SETS      350 CTNS       2,000.00     2,250.00     19.000
                                                 600 PCS
  `);
  const doc = parseDocument(layout);
  const d = doc.data as PackingListData;

  it('reads the code on the first line of a combined code/description cell as the style', () => {
    expect(doc.docType).toBe('packing_list');
    expect(d.lines.map((l) => l.styleNo)).toEqual(['HK-EK17', 'HK-TS02']);
    expect(d.lines.map((l) => l.description)).toEqual(['ELECTRIC KETTLE 1.7L', '2-SLICE TOASTER WITH']);
    expect(d.lines.map((l) => l.cartonRange)).toEqual(['1-150', '151-350']);
  });

  it('maps "Package" to cartons and a CBM "Measurement" column to volume', () => {
    expect(d.lines.map((l) => [l.cartons, l.totalPcs, l.volumeCbm])).toEqual([
      [150, 600, 9],
      [200, 400, 10],
    ]);
    expect(d.totals).toMatchObject({ cartons: 350, netWeightKg: 2000, grossWeightKg: 2250, volumeCbm: 19 });
  });

  it('does not read a quantity total split over units ("400 SETS / 600 PCS") as one piece total', () => {
    expect(d.totals.pcs).toBeUndefined();
  });

  it('per-carton values derived for columns the document does not print are not OCR readings to verify', () => {
    expect(d.lines[0]).toMatchObject({ pcsPerCarton: 4, netWeightPerCartonKg: 8 });
    expect(Object.entries(doc.fieldMeta).filter(([, m]) => m.repaired).map(([k]) => k)).toEqual([]);
    expect(doc.observations.filter((o) => o.kind === 'ocr_repair')).toEqual([]);
  });
});

describe('carrier B/L: to-order consignee, per-container rows with a TOTAL row', () => {
  const layout = layoutFromText(
    `
                                   BILL OF LADING
    PACIFIC CREST LINE CO., LTD.                        SCAC: PCMU
    Shipper / Exporter                                  Bill of Lading No.
    HANBIT KITCHENWARE CO., LTD.                        PCMUPUS26110301
    12, Gongdan-ro, Gimhae 50969, Korea

    Consignee (complete name and address)
    TO THE ORDER OF
    PACIFIC MERCHANTS BANK
    OAKLAND MAIN OFFICE, CA, U.S.A.

    Notify Party (complete name and address)
    PINECREST HOME SUPPLY LLC
    77 Harbor Blvd, Oakland, CA 94607, U.S.A.

    Ocean Vessel / Voy. No.        Port of Loading       Port of Discharge
    HANNURI STAR 031E              BUSAN, KOREA          OAKLAND, CA

    Container No. / Seal No.   No. of Containers or Packages   Description of Goods        Gross Weight      Measurement
    PCMU3124507 /' PS204417    150 CTNS                        SHIPPER'S LOAD, COUNT       1,350.000 KGS     9.000 CBM
    40' HC                     2 X 40' HC CONTAINERS           & SEAL
    PCMU3988171 / PS204418     200 CTNS                        KITCHEN APPLIANCES            900.000 KGS    10.000 CBM
    40' HC
                               TOTAL:                                                    TOTAL:
                               350 CTNS                                                  2,250.000 KGS     19.000 CBM
    FREIGHT PREPAID
  `,
    { source: 'ocr' },
  );
  const doc = parseDocument(layout);
  const d = doc.data as BillOfLadingData;

  it('keeps "TO THE ORDER OF <bank>" together as the consignee name', () => {
    expect(doc.docType).toBe('bill_of_lading');
    expect(d.consignee?.name).toBe('TO THE ORDER OF PACIFIC MERCHANTS BANK');
    expect(d.notifyParty?.name).toBe('PINECREST HOME SUPPLY LLC');
  });

  it('uses the TOTAL row (= sum of the container rows) for weight, volume and packages', () => {
    expect(d.containers.map((c) => c.number)).toEqual(['PCMU3124507', 'PCMU3988171']);
    // "Container No. / Seal No." grid: the code after the slash is the container's seal
    expect(d.containers.map((c) => c.sealNumbers)).toEqual([['PS204417'], ['PS204418']]);
    expect(d.grossWeightKg).toBe(2250);
    expect(d.volumeCbm).toBe(19);
    expect(d.packages).toEqual({ count: 350, unit: 'CTNS' });
  });
});

describe('letter-spaced letterhead', () => {
  // "S O U R C I N G  P T E .  LT D.": letters ~13 px apart, words ~35 px apart (CSS letter-spacing)
  const letters = (text: string, x: number, y: number) => {
    const out: { text: string; x0: number; x1: number; y0: number; y1: number; conf: number }[] = [];
    for (const word of text.split(' ')) {
      for (const ch of word.match(/LT|./g)!) {
        const w = ch.length * 22;
        out.push({ text: ch, x0: x, x1: x + w, y0: y, y1: y + 40, conf: 100 });
        x += w + 13;
      }
      x += 22;
    }
    return out;
  };
  it('joins letter-spaced capitals into words', () => {
    const ws = letters('SOURCING PTE. LTD.', 342, 200);
    const layout = layoutFromText('\n    COMMERCIAL INVOICE\n');
    layout.pages[0].words.push(...ws);
    layout.pages[0].lines.unshift({ text: ws.map((w) => w.text).join(' '), words: ws, x0: 342, y0: 200, x1: ws[ws.length - 1].x1, y1: 240 });
    const page = prepareLayout(layout).pages[0];
    expect(page.lines.map((l) => l.text)).toContain('SOURCING PTE. LTD.');
  });

  it('completes a letterhead name split over a logo line from the full name printed elsewhere', () => {
    const doc = parseDocument(
      layoutFromText(`
        HARBOURLINE                                   12 Marina View, #08-01
        TRADING PTE. LTD.                             Singapore 018961
                                COMMERCIAL INVOICE
        Invoice No.: HL-2611-07        Date: 2026-11-07
        Item   Description            Qty    Unit Price    Amount
        1      COTTON TOWELS          100         2.00     200.00
        TOTAL                                              200.00
                                      For and on behalf of
                                      HARBOURLINE TRADING PTE. LTD.
      `),
    );
    expect((doc.data as CommercialInvoiceData).seller?.name).toBe('HARBOURLINE TRADING PTE. LTD.');
    // the address block printed beside the logo belongs to the letterhead party
    expect((doc.data as CommercialInvoiceData).seller).toMatchObject({ country: 'SG', lines: ['12 Marina View, #08-01'] });
  });
});

describe('trader invoice: header grid, tight party columns, value breakdown, unlabeled footnote', () => {
  const doc = parseDocument(
    layoutFromText(`
                                              STRAITSLINK TRADING PTE. LTD.
                                              5 Harbour Front, Singapore 099253
      Commercial Invoice                                  Inv. Ref.   SL-2611-0042    Dated     2026.11.02
                                                          Your Order  OLY-PO-7781     Our S/C   SLT-SC-26-9

      INVOICED TO                  DELIVER TO                   GOODS MADE & SHIPPED BY
      MAPLEWOOD RETAIL CO., INC.   MAPLEWOOD RETAIL CO., INC.   PT KARYA SEPATU MAKMUR
      200 Elm Street               DC 4, 90 River Road          Jl. Industri 5, Serang
      Columbus, OH 43215, USA      Columbus, OH 43207, USA      Banten 42111, Indonesia

      Delivery terms          Payment
      CFR SAVANNAH, GA, USA   T/T 60 days

      Description of Goods       Article     Unit  Quantity   Price   Amount      HTS (US)
      MEN'S CANVAS SNEAKER       KSM-1001    PRS     1,000    10.00   10,000.00   6404.19.90
      Upper: cotton canvas
      WOMEN'S LEATHER MULE *     KSM-2002    PRS       500    20.00   10,000.00   6403.99.90
      Upper: cow leather
      VALUE BREAKDOWN (INCLUDED IN THE CFR PRICES ABOVE)      Total   1,500 PRS
      FOB value, Tanjung Priok          USD 19,000.00
      Ocean freight, 1 x 20' GP         USD  1,000.00
      CFR value, Savannah               USD 20,000.00
      * Article KSM-2002 was manufactured at our sister factory KARYA FOOTWEAR VIETNAM CO., LTD., Lot 5,
      Long Hau Industrial Park, Long An Province, Vietnam. Country of origin of this article: VIETNAM.
      Country of origin: INDONESIA, except the article marked *.
    `),
  );
  const d = doc.data as CommercialInvoiceData;

  it('reads "Inv. Ref." and keeps narrow party columns apart', () => {
    expect(d.invoiceNumber).toBe('SL-2611-0042');
    expect(d.buyer?.name).toBe('MAPLEWOOD RETAIL CO., INC.');
    expect(d.shipTo?.name).toBe('MAPLEWOOD RETAIL CO., INC.');
    expect(d.shipTo?.postalCode).toBe('43207');
    expect(d.manufacturer?.name).toBe('PT KARYA SEPATU MAKMUR');
    expect(d.incoterm).toMatchObject({ code: 'CFR', place: 'SAVANNAH, GA, USA' });
  });

  it('ends the item table at the value breakdown and reads its totals and charges', () => {
    expect(d.lines.map((l) => l.styleNo)).toEqual(['KSM-1001', 'KSM-2002']);
    expect(d.lines[1].details.join(' ')).not.toMatch(/BREAKDOWN|FOB value/);
    expect(d.charges).toEqual([{ type: 'freight', amount: 1000, description: "Ocean freight, 1 x 20' GP" }]);
    expect(d.totals).toEqual(expect.arrayContaining([expect.objectContaining({ amount: 19000 }), expect.objectContaining({ amount: 20000 })]));
  });

  it('links a "*" marker on the description to the unlabeled footnote below the table', () => {
    expect(d.lines[1].footnoteRefs).toEqual(['*']);
    expect(d.lines[1].description).toBe("WOMEN'S LEATHER MULE");
    expect(d.lines[1].countryOfOrigin).toBe('VN');
    expect(d.lines[1].manufacturer?.name).toMatch(/^KARYA FOOTWEAR VIETNAM CO\., LTD\.?$/);
    expect(d.lines[0].countryOfOrigin).toBeUndefined();
    expect(d.countryOfOrigin).toBe('ID');
  });
});

describe('value breakdown boxes: stacked labels and vertically centred amounts', () => {
  const scan = (art: string) => scanLabelledAmounts(prepareLayout(layoutFromText(art)), new Set()).map((m) => [m.label, m.amount.value]);
  it('pairs an amount with the label stacked above it, and a centred amount with the two-line label beside it', () => {
    expect(
      scan(`
        VALUE BREAKDOWN (INCLUDED IN THE CFR PRICES ABOVE)
        FOB value, Tanjung Priok                       USD 19,000.00           Total CFR Savannah
        Ocean freight Tanjung Priok - Savannah,                                USD 20,000.00
                                                       USD 1,000.00
        1 x 20' GP, prepaid
        CFR value, Savannah                            USD 20,000.00
        Dated 2026.09.11
      `),
    ).toEqual([
      ['FOB value, Tanjung Priok', 19000],
      ['Total CFR Savannah', 20000],
      ['Ocean freight Tanjung Priok - Savannah', 1000],
      ['CFR value, Savannah', 20000],
    ]);
  });

  it('does not glue text-layer words whose boxes are much taller than the glyphs', () => {
    const tall = (text: string, x0: number, x1: number) => ({ text, x0, x1, y0: 100, y1: 196, conf: 100 });
    const layout = layoutFromText('\n    COMMERCIAL INVOICE\n');
    const ws = [tall('Ocean', 185, 283), tall('freight', 293, 384), tall('Tanjung', 393, 505), tall('FOOTWEAR', 1418, 1612), tall('VIETNAM', 1616, 1764)];
    layout.pages[0].words.push(...ws);
    layout.pages[0].lines.push({ text: 'Ocean freight Tanjung FOOTWEAR VIETNAM', words: ws, x0: 185, y0: 100, x1: 1764, y1: 196 });
    expect(prepareLayout(layout).pages[0].lines.map((l) => l.text)).toContain('Ocean freight Tanjung FOOTWEAR VIETNAM');
  });
});

describe('page model on inflated text-layer boxes', () => {
  // boxes 96 px tall on a 50 px line pitch (fonts with huge ascent/descent): every distance threshold
  // is in units of medH, so it is measured from the pitch instead
  it('derives the unit height from the line pitch when boxes are taller than the pitch', () => {
    const layout = layoutFromText('\n    x\n');
    const words = Array.from({ length: 8 }, (_, i) => ({ text: `Line${i}`, x0: 154, x1: 260, y0: 664 + 50 * i - 23, y1: 664 + 50 * i + 73, conf: 100 }));
    layout.pages[0] = { ...layout.pages[0], words, lines: words.map((w) => ({ text: w.text, words: [w], x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })) };
    expect(prepareLayout(layout).pages[0].medH).toBeCloseTo(35, 5);
  });

  it('a value never runs into an excluded region below its label (a prose remarks box over the item table)', () => {
    const d = prepareLayout(
      layoutFromText(`
        Remarks
        PARTIAL SHIPMENT NOT ALLOWED
        Description of Goods       Model No.     Quantity     Amount
        ELECTRIC KETTLE            HK-EK17       600 PCS      7,500.00
      `),
    );
    const table = d.pages[0].lines.find((l) => /^Description/.test(l.text))!;
    const v = findLabelValue(d, 'notes', { mode: 'block', maxLines: 30, stopAtLabels: false, exclude: [{ page: 1, y0: table.y0, y1: 10_000 }] });
    expect(v?.lines).toEqual(['PARTIAL SHIPMENT NOT ALLOWED']);
  });
});
