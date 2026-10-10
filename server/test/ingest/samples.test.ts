/**
 * Ingest of the three sample documents through the real tools (pdftotext, pdftoppm, tesseract).
 * The first run is cold (cache disabled); a second suite checks the cache.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentLayout } from '@app/shared';
import { BLUE_PREFIX, createIngest, PIPELINE_VERSION } from '../../src/ingest/index.js';
import { BL_DATA, BL_KEY, BL_LABELS, bestConf, PL_EXTENDED, PL_KEY, recall } from './tokens.js';

const SAMPLES = join(import.meta.dirname, '..', '..', '..', 'samples');
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'sample');
const FILES = {
  invoice: 'KBAS-NB-26-0912_Commercial_Invoice.pdf',
  pl: 'SPG-PL-2609-117_Packing_List.pdf',
  bl: 'BMLVHCM26090418_House_BL.pdf',
};
const read = (name: string) => ({ name, mime: 'application/pdf', bytes: new Uint8Array(readFileSync(join(SAMPLES, name))) });
const fixture = (slug: string) => JSON.parse(readFileSync(join(FIXTURES, `${slug}.layout.json`), 'utf8')) as DocumentLayout;

let cacheDir: string;
let invoice: DocumentLayout;
let pl: DocumentLayout;
let bl: DocumentLayout;
let coldMs = 0;
let loopMaxMs = 0;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'ingest-samples-'));
  const ingest = createIngest({ cache: false, cacheDir });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const t0 = performance.now();
  [invoice, pl, bl] = await Promise.all([ingest(read(FILES.invoice)), ingest(read(FILES.pl)), ingest(read(FILES.bl))]);
  coldMs = performance.now() - t0;
  loop.disable();
  loopMaxMs = loop.max / 1e6;
  console.log(`[ingest] cold ingest of 3 samples (cache disabled): ${Math.round(coldMs)} ms; max event-loop delay ${loopMaxMs.toFixed(1)} ms`);
});

afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('cold ingest of the sample shipment', () => {
  it('finishes in under 60 s without blocking the event loop', () => {
    expect(coldMs).toBeLessThan(60_000);
    expect(loopMaxMs).toBeLessThan(250);
  });

  it('identifies documents by content hash', () => {
    for (const [layout, name] of [[invoice, FILES.invoice], [pl, FILES.pl], [bl, FILES.bl]] as const) {
      const sha = createHash('sha256').update(readFileSync(join(SAMPLES, name))).digest('hex');
      expect(layout.sha256).toBe(sha);
      expect(layout.docId).toBe(`doc-${sha.slice(0, 12)}`);
      expect(layout.fileName).toBe(name);
      expect(layout.mime).toBe('application/pdf');
    }
  });

  it('invoice: both pages from the text layer, conf 100, key values present', () => {
    expect(invoice.pages).toHaveLength(2);
    for (const p of invoice.pages) {
      expect(p.source).toBe('text');
      expect(p.skewDeg).toBe(0);
      expect(p.words.every((w) => w.conf === 100)).toBe(true);
    }
    // Whole words, ignoring trailing punctuation ('4,180.00,' in a sentence).
    expect(recall(invoice.pages.flatMap((p) => p.words), ['KBAS/NB/26-0912', '6,480.00', '4,180.00'], 100).missing).toEqual([]);
  });

  it('invoice: matches the text-layer fixture word for word', () => {
    const fx = fixture('invoice');
    invoice.pages.forEach((p, i) => {
      expect(p.width).toBe(fx.pages[i].width);
      expect(p.height).toBe(fx.pages[i].height);
      expect(p.words).toEqual(fx.pages[i].words);
      expect(p.lines.map((l) => l.text)).toEqual(fx.pages[i].lines.map((l) => l.text));
    });
  });

  it('packing list: OCR, skew ~ -0.78°, key tokens at conf >= 80', () => {
    const [p] = pl.pages;
    expect(p.source).toBe('ocr');
    expect(Math.abs(p.skewDeg - -0.78)).toBeLessThanOrEqual(0.3);
    const r = recall(p.words, PL_KEY, 80);
    expect(r.missing).toEqual([]);
    // 'TC 65/35' is one phrase: both words on the same line, adjacent.
    expect(p.lines.some((l) => / TC 65\/35 |^TC 65\/35/.test(` ${l.text} `))).toBe(true);
  });

  it('packing list: the NB-H205 row is one line with its quantity and weight', () => {
    const row = pl.pages[0].lines.find((l) => l.words.some((w) => w.text === 'NB-H205'));
    expect(row).toBeDefined();
    const words = row!.words.map((w) => w.text);
    expect(words).toContain('1,176');
    expect(words).toContain('715.40');
  });

  it('bill of lading: OCR, skew ~ 0.99°, key tokens, telex stamp', () => {
    const [p] = bl.pages;
    expect(p.source).toBe('ocr');
    expect(Math.abs(p.skewDeg - 0.99)).toBeLessThanOrEqual(0.3);
    expect(recall(p.words, BL_KEY, 0).missing).toEqual([]);
    // The spike read these at conf >= 88; they must not regress below 80.
    for (const t of ['BMLVHCM26090418', 'OPLUSGN260917735', 'OPL7731482', '1,930.000', '13.580', 'PACIFIC', 'ARGOS']) {
      expect(bestConf(p.words, t), t).toBeGreaterThanOrEqual(80);
    }
    expect(p.stamps?.some((s) => /telex/i.test(s))).toBe(true);
  });

  it('bill of lading: stamp pass reads the red stamp lines and the blue on-board stamp', () => {
    const stamps = bl.pages[0].stamps ?? [];
    const red = stamps.filter((s) => !s.startsWith(BLUE_PREFIX)).join(' | ');
    expect(red).toMatch(/TELEX RELEASED/);
    expect(red).toMatch(/SURRENDERED/);
    expect(red).toMatch(/25-SEP-2026/);
    expect(stamps.some((s) => s.startsWith(BLUE_PREFIX) && /SHIPPED/.test(s))).toBe(true);
    expect(pl.pages[0].stamps).toEqual([]); // grayscale scan: nothing coloured
  });

  it('OCR recall is at least as good as the raw fixtures (no preprocessing, single pass)', () => {
    const cases = [
      ['packing-list', pl, [PL_KEY, PL_EXTENDED]],
      ['bill-of-lading', bl, [BL_KEY, BL_DATA, BL_LABELS]],
    ] as const;
    const rows: string[] = [];
    for (const [slug, layout, sets] of cases) {
      const fx = fixture(slug).pages[0].words;
      for (const tokens of sets) {
        const ours = recall(layout.pages[0].words, tokens, 80).found;
        const theirs = recall(fx, tokens, 80).found;
        rows.push(`${slug} ${tokens.length} tokens @80: fixture ${theirs}, ingest ${ours}`);
        expect(ours).toBeGreaterThanOrEqual(theirs);
      }
    }
    console.log(`[ingest] recall vs fixture:\n  ${rows.join('\n  ')}`);
  });

  it('emits the fixture layout format: plain words, sorted lines, page images', () => {
    for (const layout of [invoice, pl, bl]) {
      for (const p of layout.pages) {
        expect(Object.keys(p.words[0]).sort()).toEqual(['conf', 'text', 'x0', 'x1', 'y0', 'y1']);
        for (const line of p.lines) {
          expect(line.text).toBe(line.words.map((w) => w.text).join(' '));
          const xs = line.words.map((w) => w.x0);
          expect(xs).toEqual([...xs].sort((a, b) => a - b));
          expect(line.x0).toBe(Math.min(...xs));
        }
        const ys = p.lines.map((l) => (l.y0 + l.y1) / 2);
        expect(ys.length).toBeGreaterThan(10);
        expect(p.lines.reduce((n, l) => n + l.words.length, 0)).toBe(p.words.length);
        expect(p.imagePath && existsSync(p.imagePath)).toBe(true);
        expect(p.imagePath).toContain(join(layout.sha256, `page-${p.page}.png`));
      }
    }
  });
});

describe('layout cache', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ingest-cache-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes layout.json on a miss and serves the identical layout on a hit', async () => {
    const first = await createIngest({ cache: true, cacheDir: dir })(read(FILES.pl));
    const cachePath = join(dir, first.sha256, 'layout.json');
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).pipelineVersion).toBe(PIPELINE_VERSION);

    // Deterministic: same pages as the cold, cache-disabled run (modulo where images live).
    const strip = (l: DocumentLayout) => l.pages.map(({ imagePath: _imagePath, ...rest }) => rest);
    expect(strip(first)).toEqual(strip(pl));

    const t0 = performance.now();
    const renamed = { ...read(FILES.pl), name: 'renamed.pdf' };
    const second = await createIngest({ cache: true, cacheDir: dir })(renamed);
    const hitMs = performance.now() - t0;
    expect(hitMs).toBeLessThan(1500);
    expect(second.pages).toEqual(first.pages);
    expect(second.fileName).toBe('renamed.pdf');
    console.log(`[ingest] cache hit: ${Math.round(hitMs)} ms`);
  });

  it('shares one computation between concurrent calls for the same bytes', async () => {
    const ingest = createIngest({ cache: false, cacheDir: dir, stamps: false, secondPass: false });
    const [a, b] = await Promise.all([ingest(read(FILES.invoice)), ingest({ ...read(FILES.invoice), name: 'copy.pdf' })]);
    expect(a.pages).toBe(b.pages);
    expect(b.fileName).toBe('copy.pdf');
  });
});
