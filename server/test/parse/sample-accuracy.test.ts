/**
 * Sample accuracy: parse the three raw sample layouts (worst-case OCR, no preprocessing) and
 * compare with the hand-made ground truth field by field. Prints a per-document table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BillOfLadingData, CommercialInvoiceData, DocumentLayout, ExtractedDocument, PackingListData } from '@app/shared';
import { accuracySummary, classifyDocument, compareExtraction, parseDocument } from '../../src/parse';

const dir = join(import.meta.dirname, '..', 'fixtures', 'sample');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const SLUGS = ['invoice', 'packing-list', 'bill-of-lading'] as const;

const parsed = Object.fromEntries(SLUGS.map((s) => [s, parseDocument(load<DocumentLayout>(`${s}.layout.json`))])) as Record<(typeof SLUGS)[number], ExtractedDocument>;
const expected = Object.fromEntries(SLUGS.map((s) => [s, load<ExtractedDocument>(`${s}.expected.json`)])) as Record<(typeof SLUGS)[number], ExtractedDocument>;

describe('sample documents: field-level accuracy', () => {
  const table: string[] = ['', `${'document'.padEnd(16)}${'critical'.padEnd(18)}${'overall'.padEnd(18)}non-matching fields (! = critical)`];
  for (const slug of SLUGS) {
    it(`${slug}: ≥ 95% of critical fields correct`, () => {
      const rows = compareExtraction(parsed[slug], expected[slug]);
      const s = accuracySummary(rows);
      const pct = (a: number, b: number) => `${a}/${b} (${((100 * a) / b).toFixed(1)}%)`.padEnd(18);
      table.push(`${slug.padEnd(16)}${pct(s.criticalOk, s.criticalTotal)}${pct(s.ok, s.total)}${s.failures.map((f) => `${f.critical ? '!' : ''}${f.field}`).join(', ')}`);
      if (slug === 'bill-of-lading') console.log(table.join('\n'));
      expect(s.criticalTotal).toBeGreaterThan(10);
      expect(s.criticalAccuracy).toBeGreaterThanOrEqual(0.95);
    });
  }
});

describe('sample documents: specific values', () => {
  it('invoice line 1 keeps the printed amount; line 5 is NCV from Bangladesh; assist linked to W-B220', () => {
    const d = parsed.invoice.data as CommercialInvoiceData;
    expect(parsed.invoice.docType).toBe('commercial_invoice');
    expect(d.invoiceNumber).toBe('KBAS/NB/26-0912');
    expect(d.lines[0]).toMatchObject({ lineNo: 1, styleNo: 'NB-T101', quantity: 2400, unitPrice: 2.85, amount: 6480 });
    expect(d.lines[4]).toMatchObject({ lineNo: 5, countryOfOrigin: 'BD', noCommercialValue: true, customsValue: 24 });
    expect(d.assists).toHaveLength(1);
    expect(d.assists[0]).toMatchObject({ value: 4180, styleRefs: ['W-B220'], currency: 'USD' });
    expect(d.lines[3].footnoteRefs).toEqual(['*']);
    expect(d).toMatchObject({ invoiceDate: '2026-09-12', invoiceDateAmbiguous: true, invoiceDateAlternatives: ['2026-12-09'] });
    expect(d.incoterm).toEqual({ code: 'CIF', place: 'TACOMA, WA', version: '2020' });
    expect(d.charges.map((c) => [c.type, c.amount])).toEqual([
      ['freight', 3850],
      ['insurance', 185],
    ]);
    // the arithmetic disagreement is reported, not repaired
    expect(parsed.invoice.observations.some((o) => o.field === 'lines[0].amount' && /6840/.test(o.text))).toBe(true);
  });

  it('packing list: NB-H205 1,176 pcs in TC 65/35 (polyester 65 / cotton 35), repairs recorded', () => {
    const d = parsed['packing-list'].data as PackingListData;
    const hoodie = d.lines.find((l) => l.styleNo === 'NB-H205')!;
    expect(hoodie.totalPcs).toBe(1176);
    expect(hoodie.compositionRaw).toBe('TC 65/35');
    expect(hoodie.composition).toEqual([
      { fiber: 'polyester', pct: 65 },
      { fiber: 'cotton', pct: 35 },
    ]);
    expect(hoodie.netWeightPerCartonKg).toBe(14.6);
    expect(parsed['packing-list'].fieldMeta['lines[1].netWeightPerCartonKg']).toMatchObject({ repaired: true, originalText: '14,60' });
    const samples = d.lines.find((l) => l.styleNo === 'NB-P118S')!;
    expect(samples).toMatchObject({ cartons: 1, countryOfOrigin: 'BD' });
    expect(samples.manufacturer).toMatchObject({ name: 'SP Garments Dhaka Ltd.', country: 'BD' });
    expect(parsed['packing-list'].fieldMeta['lines[4].cartons']).toMatchObject({ repaired: true });
    expect(d.totals).toEqual({ cartons: 138, pcs: 5100, netWeightKg: 1734.5, grossWeightKg: 1888, volumeCbm: 13.58 });
  });

  it('bill of lading: container OPLU3041722 with an invalid strike-through candidate, 1,930 kg', () => {
    const d = parsed['bill-of-lading'].data as BillOfLadingData;
    expect(d.containers[0].number).toBe('OPLU3041722');
    expect(d.containers[0].checkDigitValid).toBe(true);
    const struck = d.containers[0].candidates?.find((c) => c.source === 'strikethrough');
    expect(struck?.checkDigitValid).toBe(false);
    expect(d.containers[0].candidates?.find((c) => c.source === 'handwritten')?.number).toBe('OPLU3041722');
    expect(parsed['bill-of-lading'].fieldMeta['containers[0].number']).toMatchObject({ repaired: true, originalText: 'ORSKU 304/72 2' });
    expect(d.grossWeightKg).toBe(1930);
    expect(d).toMatchObject({ blType: 'house', blNumber: 'BMLVHCM26090418', issuerScac: 'BMLV', masterBlNumber: 'OPLUSGN260917735', carrierScac: 'OPLU', releaseType: 'telex' });
    // stamp date "24 SEP 2006" vs typed issue date 24-SEP-2026: the typed year wins, with a record
    expect(d.onBoardDate).toBe('2026-09-24');
    expect(parsed['bill-of-lading'].fieldMeta.onBoardDate).toMatchObject({ repaired: true, originalText: '24 SEP 2006' });
    // an impossible heading is kept as read but flagged low-confidence
    expect(d.hsCodes).toContain('6263.42');
    expect(parsed['bill-of-lading'].fieldMeta['hsCodes[2]'].conf).toBeLessThan(50);
  });

  it('every flagged field carries confidence, and OCR evidence where available', () => {
    for (const doc of Object.values(parsed)) {
      for (const [path, m] of Object.entries(doc.fieldMeta)) {
        expect(m.conf, path).toBeGreaterThanOrEqual(0);
        expect(m.conf < 90 || m.repaired, path).toBe(true);
      }
    }
    expect(parsed['packing-list'].fieldMeta['lines[1].netWeightPerCartonKg'].evidence).toMatchObject({ docId: 'sample-pl', page: 1, text: '14,60' });
  });
});

describe('classifyDocument on the samples', () => {
  it.each([
    ['invoice', 'commercial_invoice'],
    ['packing-list', 'packing_list'],
    ['bill-of-lading', 'bill_of_lading'],
  ] as const)('%s → %s with score ≥ 0.6', (slug, type) => {
    const c = classifyDocument(load<DocumentLayout>(`${slug}.layout.json`));
    expect(c.docType).toBe(type);
    expect(c.score).toBeGreaterThanOrEqual(0.6);
  });
});
