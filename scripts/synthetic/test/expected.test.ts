import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isValidAwb, isValidContainer, singleConfusionVariants } from '../checks.js';
import { checkConsistency, computeEnteredValues } from '../consistency.js';
import { validateExpected, type ExpectedShipment } from '../expected-schema.js';
import { buildExpected } from '../generate.js';
import { SHIPMENTS } from '../shipments/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SYNTH = join(REPO, 'samples/synthetic');
const REFERENCE = join(HERE, '../reference');

const loadCommitted = (id: string): unknown => JSON.parse(readFileSync(join(SYNTH, id, 'expected.json'), 'utf8'));

describe('committed expected.json files', () => {
  it('exist for every shipment and nothing else', () => {
    const dirs = readdirSync(SYNTH, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(SHIPMENTS.map((s) => s.id).sort());
  });

  for (const spec of SHIPMENTS) {
    describe(spec.id, () => {
      it('validates against the zod schema', () => {
        const r = validateExpected(loadCommitted(spec.id));
        if (!r.ok) throw new Error(r.errors.join('\n'));
        expect(r.ok).toBe(true);
      });

      it('is up to date with the spec (regenerate with npx tsx scripts/make-synthetic.ts)', () => {
        const built = buildExpected(spec);
        expect(built.errors).toEqual([]);
        expect(loadCommitted(spec.id)).toEqual(built.value);
      });

      it('passes the consistency rules (hand-computed values = recomputed policy)', () => {
        const r = validateExpected(loadCommitted(spec.id));
        if (!r.ok) throw new Error(r.errors.join('\n'));
        expect(checkConsistency(spec, r.value)).toEqual([]);
      });

      it('lists every document file that is on disk', () => {
        const r = validateExpected(loadCommitted(spec.id)) as { ok: true; value: ExpectedShipment };
        const docs = readdirSync(join(SYNTH, spec.id)).filter((f) => /\.(pdf|jpe?g|png)$/i.test(f)).sort();
        expect(r.value.files.map((f) => f.file).sort()).toEqual(docs);
      });
    });
  }
});

describe('the zod schema rejects broken ground truth', () => {
  const base = (): ExpectedShipment => {
    const r = validateExpected(loadCommitted('s1-air-eur-fca'));
    if (!r.ok) throw new Error('fixture invalid');
    return structuredClone(r.value);
  };
  const fails = (mutate: (e: ExpectedShipment) => void): string[] => {
    const e = base();
    mutate(e);
    const r = validateExpected(e);
    return r.ok ? [] : r.errors;
  };

  it('unknown issue codes', () => {
    expect(fails((e) => ((e.expect.issuesInclude as string[]).push('NOT_A_CODE')))).not.toEqual([]);
  });
  it('total ≠ sum of lines', () => {
    expect(fails((e) => (e.expect.totalEnteredValue += 1)).join()).toMatch(/totalEnteredValue/);
  });
  it('a code both included and excluded', () => {
    expect(fails((e) => e.expect.issuesExclude.push('MISSING_DOCUMENT')).join()).toMatch(/both included and excluded/);
  });
  it('a malformed hs6', () => {
    expect(fails((e) => (e.expect.lines[0].hs6 = '82119'))).not.toEqual([]);
  });
  it('hs6 that disagrees with the printed code', () => {
    expect(fails((e) => (e.expect.lines[0].hs6 = '821192')).join()).toMatch(/does not match hsPrinted/);
  });
  it('a foreign currency without CURRENCY_CONVERSION', () => {
    expect(fails((e) => (e.expect.issuesInclude = ['MISSING_DOCUMENT'])).join()).toMatch(/CURRENCY_CONVERSION/);
  });
  it('containers on an air shipment', () => {
    expect(fails((e) => (e.expect.transport.containers = ['CSQU3054383'])).join()).toMatch(/air shipments/);
  });
  it('an invoice number the XSD would reject as "normalized"', () => {
    expect(fails((e) => (e.expect.invoiceNumberNormalized = 'RW/26/10387'))).not.toEqual([]);
  });
  it('a non-alphanumeric bill number', () => {
    expect(fails((e) => (e.expect.transport.bills = [{ masterBill: '020-12345675' }]))).not.toEqual([]);
  });
  it('an image file that claims a text layer, or has several pages', () => {
    expect(fails((e) => (e.files[0] = { ...e.files[0], file: 'IMG_0001.jpg', source: 'text' })).join()).toMatch(/source must be 'ocr'/);
    expect(fails((e) => (e.files[0] = { ...e.files[0], file: 'IMG_0001.jpg', source: 'ocr', pages: 2 })).join()).toMatch(/single page/);
  });
  it('a document that is neither PDF nor image', () => {
    expect(fails((e) => (e.files[0] = { ...e.files[0], file: 'invoice.docx' }))).not.toEqual([]);
  });
});

describe('planted defects are real and unambiguous', () => {
  const exp = (id: string): ExpectedShipment => {
    const r = validateExpected(loadCommitted(id));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return r.value;
  };

  it('S1 master AWB passes the modulus-7 check and there are no containers', () => {
    const e = exp('s1-air-eur-fca');
    expect(isValidAwb(e.expect.transport.bills?.[0].masterBill ?? '')).toBe(true);
    expect(e.expect.transport.containers ?? []).toEqual([]);
  });

  it('S2 container passes ISO 6346; exactly one line has qty × price ≠ printed amount, and the printed total corroborates the computed amounts', () => {
    const e = exp('s2-scan-cn-ddp');
    expect(e.expect.transport.containers?.every(isValidContainer)).toBe(true);
    const bad = e.expect.lines.filter((l) => Math.abs(l.quantity * l.unitPrice - l.printedAmount) > 0.005);
    expect(bad.map((l) => l.lineNo)).toEqual([3]);
    const computedSum = e.expect.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPrice * 100) / 100, 0);
    const printedSum = e.expect.lines.reduce((s, l) => s + l.printedAmount, 0);
    expect(computedSum).toBe(20920);
    expect(printedSum).not.toBe(20920);
  });

  it('S3 container fails ISO 6346 and no single OCR-confusion swap can "repair" it', () => {
    const e = exp('s3-messy-minimal');
    const [c] = e.expect.transport.containers ?? [];
    expect(isValidContainer(c)).toBe(false);
    expect(singleConfusionVariants(c).filter(isValidContainer)).toEqual([]);
  });

  it('S3 has two origins and no printed HS codes', () => {
    const e = exp('s3-messy-minimal');
    expect(new Set(e.expect.lines.map((l) => l.countryOfOrigin))).toEqual(new Set(['IN', 'LK']));
    expect(e.expect.lines.every((l) => l.hs6 === null && l.hs6Truth)).toBe(true);
  });

  it('S4 has two valid containers, a master bill only, and the 3% discount apportioned by value', () => {
    const e = exp('s4-kr-fob-multi-container');
    expect(e.expect.transport.containers).toHaveLength(2);
    expect(e.expect.transport.containers?.every(isValidContainer)).toBe(true);
    expect(e.expect.transport.bills).toEqual([{ masterScac: 'HNRL', masterBill: 'PUSA26091742' }]);
    expect(e.expect.issuesExclude).toContain('HOUSE_MASTER_BILL');
    const amounts = e.expect.lines.map((l) => l.printedAmount);
    const subtotal = Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
    expect(subtotal).toBe(176654.4);
    const discount = Math.round(subtotal * 3) / 100; // 3% to the cent, as printed
    expect(discount).toBe(5299.63);
    expect(computeEnteredValues({ lineAmounts: amounts, includedNonDutiableCharges: 0, discount })).toEqual(e.expect.lines.map((l) => l.enteredValue));
    // Entered total is the net invoice total (171,354.77) up to per-line rounding.
    expect(Math.abs(e.expect.totalEnteredValue - (subtotal - discount))).toBeLessThan(e.expect.lines.length * 0.5);
    expect(new Set(e.expect.lines.map((l) => l.unit))).toEqual(new Set(['SETS', 'PCS']));
  });

  it('S5 deducts the itemized CFR freight, has ID + VN origins, a house and a master bill, and a JPEG photo packing list', async () => {
    const e = exp('s5-id-footwear-cfr');
    expect(e.expect.incoterm.code).toBe('CFR');
    expect(e.expect.totalEnteredValue).toBe(109950); // = printed FOB value (114,300.00 − 4,350.00 freight)
    expect(new Set(e.expect.lines.map((l) => l.countryOfOrigin))).toEqual(new Set(['ID', 'VN']));
    expect(e.expect.lines.every((l) => l.unit === 'PRS')).toBe(true);
    expect(e.expect.transport.containers?.every(isValidContainer)).toBe(true);
    const [bill] = e.expect.transport.bills ?? [];
    expect(bill.houseScac && bill.houseBill && bill.masterScac && bill.masterBill).toBeTruthy();
    const photo = e.files.find((f) => /\.jpe?g$/i.test(f.file));
    expect(photo).toMatchObject({ docType: 'packing_list', source: 'ocr', pages: 1 });
    const meta = await sharp(join(SYNTH, 's5-id-footwear-cfr', photo?.file ?? '')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1600);
  });
});

describe('HS codes are real 2026 HTSUS numbers (cached USITC subtrees)', () => {
  const htsnos = new Set<string>();
  for (const f of readdirSync(REFERENCE).filter((n) => n.startsWith('hts-') && n.endsWith('.json'))) {
    for (const row of JSON.parse(readFileSync(join(REFERENCE, f), 'utf8')) as { htsno?: string }[]) {
      if (row.htsno) htsnos.add(row.htsno.replace(/\./g, ''));
    }
  }
  const digits = [...htsnos];

  for (const spec of SHIPMENTS) {
    it(spec.id, () => {
      const r = validateExpected(loadCommitted(spec.id));
      if (!r.ok) throw new Error(r.errors.join('\n'));
      for (const l of r.value.expect.lines) {
        if (l.hsPrinted) {
          const d = l.hsPrinted.replace(/\./g, '');
          expect(d).toHaveLength(8);
          expect(digits.some((h) => h.startsWith(d)), `${l.hsPrinted} not in HTSUS cache`).toBe(true);
        }
        if (l.hs6Truth) expect(digits.some((h) => h.startsWith(l.hs6Truth as string)), `${l.hs6Truth} not in cache`).toBe(true);
      }
    });
  }
});

describe('templates are independent of the reference sample', () => {
  // Strings that only exist in the sample shipment: a synthetic doc containing them would let a
  // sample-hardcoded parser pass by accident.
  const SAMPLE_ONLY = ['KOWLOON', 'NORTHBOUND', 'CASCADE FULFILLMENT', 'SAIGON PHOENIX', 'BLUE MERIDIAN', 'OPLU', 'BMLV', 'PACIFIC ARGOS', 'TACOMA', 'KBAS'];
  for (const spec of SHIPMENTS) {
    for (const doc of spec.docs) {
      it(`${spec.id}/${doc.file}`, () => {
        const html = doc.html.toUpperCase();
        for (const s of SAMPLE_ONLY) expect(html.includes(s), s).toBe(false);
      });
    }
  }

  it('uses the varied vocabulary and column orders the cases promise', () => {
    const [s1, s2, s3] = SHIPMENTS;
    const inv1 = s1.docs[0].html;
    for (const label of ['Inv #', 'Unit Value', 'Ext. Value', 'Rechnung / Invoice']) expect(inv1).toContain(label);
    const headers = [...s2.docs[0].html.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1].replace(/<br>.*$/, ''));
    expect(headers).toEqual(['Item', 'HS Code', 'Description', 'Ctns', 'Qty', 'Unit', 'Unit Price', 'Amount', 'N.W.', 'G.W.']);
    expect(s2.docs[0].html).toContain('COMMERCIAL INVOICE &amp; PACKING LIST');
    const s3Headers = [...s3.docs[0].html.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(s3Headers.slice(-6)).toEqual(['QTY', 'U/M', 'ITEM CODE', 'DESCRIPTION', 'RATE', 'AMOUNT']);
    expect(s3.docs[0].html).not.toMatch(/HS CODE/i);
  });

  it('S4 uses the Korean trade-form labels and its item table continues on page 2 without a header row', () => {
    const s4 = SHIPMENTS.find((s) => s.id === 's4-kr-fob-multi-container');
    const html = s4?.docs[0].html ?? '';
    for (const label of ['Messrs.', 'Invoice No. &amp; Date', 'L/C No.', 'Terms of Price', 'Shipped per', 'Sailing on or about', 'From / To', 'Model No.', 'H.S. Code', 'VOLUME DISCOUNT']) {
      expect(html).toContain(label);
    }
    const pages = html.split('<div class="sheet">').slice(1);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatch(/<th>/);
    expect(pages[1]).not.toMatch(/<th>/);
    expect(pages[1]).toContain('MRE-PR0610'); // line 4 exists only on page 2
    expect(s4?.docs[1].html).toContain('CONTAINER / SEAL');
  });

  it('S5 prints YYYY.MM.DD dates, PRS units, the HTS code as the last column and an itemized freight breakdown', () => {
    const s5 = SHIPMENTS.find((s) => s.id === 's5-id-footwear-cfr');
    const html = s5?.docs[0].html ?? '';
    const headers = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual(['Description of Goods', 'Article', 'Unit', 'Quantity', 'Price (USD)', 'Amount (USD)', 'HTS (US)']);
    expect(html).toMatch(/2026\.09\.11/);
    expect(html).toContain('Ocean freight');
    expect(html).toContain('NUSANTARA FOOTWEAR VIETNAM');
    expect(s5?.docs[1].variant).toBe('photo');
  });
});
