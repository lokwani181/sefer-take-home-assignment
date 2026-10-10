import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DocumentLayout, Word } from '@app/shared';
import { cacheEnabledByEnv, defaultCacheDir, readCachedLayout, writeCachedLayout } from '../../src/ingest/cache.js';
import { deskewWords, estimateSkew } from '../../src/ingest/deskew.js';
import { detectKind } from '../../src/ingest/detect.js';
import { IngestError } from '../../src/ingest/errors.js';
import { groupLines } from '../../src/ingest/lines.js';
import { createLimiter } from '../../src/ingest/limiter.js';
import { iou, mergeWords } from '../../src/ingest/merge.js';
import { DEFAULT_PREPROCESS, estimatePaper, preprocess } from '../../src/ingest/preprocess.js';
import { chooseUpscale, encodePnm, parsePnm } from '../../src/ingest/raster.js';
import { estimateTextAngle, findInkRegions, removeRules } from '../../src/ingest/stamps.js';
import { parseTsv, type OcrWord } from '../../src/ingest/tesseract.js';
import { hasUsableTextLayer, parseBboxLayout } from '../../src/ingest/textLayer.js';

const w = (text: string, x0: number, y0: number, x1: number, y1: number, conf = 90, lineKey = '1.1.1'): OcrWord => ({ text, x0, y0, x1, y1, conf, lineKey });

describe('parseBboxLayout (pdftotext -bbox-layout)', () => {
  const xhtml = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><doc>
  <page width="595.276000" height="841.890000">
    <flow><block><line>
      <word xMin="72.000000" yMin="100.000000" xMax="144.000000" yMax="112.000000">Invoice&amp;Co</word>
      <word xMin="150.000000" yMin="100.000000" xMax="200.000000" yMax="112.000000">&#8364;12</word>
    </line></block></flow>
  </page>
  <page width="612.000000" height="792.000000">
  </page>
</doc></body></html>`;

  it('scales points to 300 DPI pixels, decodes entities, conf 100', () => {
    const pages = parseBboxLayout(xhtml);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ page: 1, width: 2480, height: 3508 });
    expect(pages[0].words[0]).toEqual({ text: 'Invoice&Co', x0: 300, y0: 416.7, x1: 600, y1: 466.7, conf: 100 });
    expect(pages[0].words[1].text).toBe('€12');
    expect(pages[1]).toMatchObject({ page: 2, width: 2550, height: 3300, words: [], chars: 0 });
  });

  it('needs >= 50 meaningful characters for a usable text layer', () => {
    const [p] = parseBboxLayout(xhtml);
    expect(hasUsableTextLayer(p)).toBe(false);
    expect(hasUsableTextLayer({ ...p, chars: 50, junkChars: 0 })).toBe(true);
    expect(hasUsableTextLayer({ ...p, chars: 400, junkChars: 200 })).toBe(false);
  });
});

describe('parseTsv (tesseract TSV)', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t2480\t3508\t-1\t',
    '4\t1\t1\t1\t1\t0\t10\t20\t300\t40\t-1\t',
    '5\t1\t1\t1\t1\t1\t10\t20\t100\t40\t96.4\tHELLO',
    '5\t1\t1\t1\t1\t2\t120\t22\t90\t38\t-1\t ',
    '5\t1\t1\t1\t1\t3\t220\t22\t90\t38\t0\tx',
    '5\t1\t2\t1\t1\t1\t10\t200\t50\t40\t55.5\tWORLD',
  ].join('\n');

  it('keeps level-5 words with conf >= 0 and text, with page size and line ids', () => {
    const r = parseTsv(tsv);
    expect(r.width).toBe(2480);
    expect(r.height).toBe(3508);
    expect(r.words.map((x) => x.text)).toEqual(['HELLO', 'x', 'WORLD']);
    expect(r.words[0]).toMatchObject({ x0: 10, y0: 20, x1: 110, y1: 60, conf: 96, lineKey: '1.1.1' });
    expect(r.words[2].lineKey).toBe('2.1.1');
  });
});

describe('skew estimation and deskew', () => {
  /** Lines of words along a known slope, plus an outlier line, rotated about the page centre. */
  function slantedPage(deg: number): OcrWord[][] {
    const slope = Math.tan((deg * Math.PI) / 180);
    const lines: OcrWord[][] = [];
    for (let row = 0; row < 12; row++) {
      const words: OcrWord[] = [];
      for (let k = 0; k < 8; k++) {
        const x = 200 + k * 260;
        const y = 300 + row * 120 + slope * x;
        words.push(w(`w${k}`, x, y - 15, x + 200, y + 15, 90, `${row}`));
      }
      lines.push(words);
    }
    lines.push([w('a', 100, 100, 150, 130), w('b', 500, 400, 550, 430), w('c', 900, 100, 950, 130)]); // zig-zag outlier
    return lines;
  }

  it.each([-0.78, 0.99, 2.5, 0])('recovers %s° within 0.05°', (deg) => {
    const est = estimateSkew(slantedPage(deg));
    expect(Math.abs(est.deg - deg)).toBeLessThan(0.05);
  });

  it('returns 0 when there are no usable lines', () => {
    expect(estimateSkew([[w('a', 0, 0, 10, 10)]])).toEqual({ slope: 0, deg: 0, samples: 0 });
  });

  it('rotating the coordinates makes a slanted row horizontal and keeps box sizes', () => {
    const row = slantedPage(1)[0];
    const slope = Math.tan(Math.PI / 180);
    const out = deskewWords(row, 2480, 3508, slope);
    const ys = out.map((x) => (x.y0 + x.y1) / 2);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
    expect(out[0].x1 - out[0].x0).toBeCloseTo(200, 0);
    expect(Object.keys(out[0]).sort()).toEqual(['conf', 'text', 'x0', 'x1', 'y0', 'y1']);
  });
});

describe('groupLines', () => {
  it('clusters by y-centre, sorts words left to right and lines top to bottom', () => {
    const words: Word[] = [
      { text: 'B', x0: 300, y0: 102, x1: 340, y1: 132, conf: 90 },
      { text: 'A', x0: 100, y0: 100, x1: 140, y1: 130, conf: 90 },
      { text: 'C', x0: 100, y0: 200, x1: 140, y1: 230, conf: 90 },
    ];
    const lines = groupLines(words);
    expect(lines.map((l) => l.text)).toEqual(['A B', 'C']);
    expect(lines[0]).toMatchObject({ x0: 100, y0: 100, x1: 340, y1: 132 });
  });

  it('returns no lines for no words', () => {
    expect(groupLines([])).toEqual([]);
  });

  // Text-layer fonts with large ascent/descent (CJK families, Gill Sans) give word boxes taller than
  // the line pitch, so neighbouring lines' y-centres fall within half a box height of each other.
  it('never stacks two words of the same column on one line (inflated text-layer boxes)', () => {
    const words: Word[] = [
      // description column, pitch 47 px, box height 78 px
      { text: 'cups', x0: 527, y0: 1786.9, x1: 595, y1: 1864.7, conf: 100 },
      { text: 'per', x0: 604, y0: 1786.9, x1: 652, y1: 1864.7, conf: 100 },
      { text: '8-speed', x0: 527, y0: 1833.8, x1: 649, y1: 1911.6, conf: 100 },
      { text: 'dial', x0: 658, y0: 1833.8, x1: 709, y1: 1911.6, conf: 100 },
      // marks column, half a pitch lower than the description lines
      { text: 'C/T', x0: 161, y0: 1815.7, x1: 213, y1: 1892.6, conf: 100 },
      { text: '1-2,004', x0: 288, y0: 1815.7, x1: 403, y1: 1892.6, conf: 100 },
    ];
    const texts = groupLines(words).map((l) => l.text);
    const cups = texts.find((t) => t.includes('cups'));
    expect(cups).toMatch(/cups per$/);
    expect(cups).not.toContain('8-speed');
    expect(texts.find((t) => t.includes('8-speed'))).toMatch(/^8-speed dial$/);
  });

  it('keeps a bold name line apart from the taller address line below it', () => {
    const words: Word[] = [
      { text: 'OLENTANGY', x0: 154, y0: 649.2, x1: 413, y1: 697.3, conf: 100 },
      { text: 'RETAIL', x0: 424, y0: 649.2, x1: 569, y1: 697.3, conf: 100 },
      { text: 'PT', x0: 1634, y0: 649.2, x1: 1688, y1: 697.3, conf: 100 },
      { text: '1850', x0: 154, y0: 664, x1: 228, y1: 760.3, conf: 100 },
      { text: 'Polaris', x0: 238, y0: 664, x1: 337, y1: 760.3, conf: 100 },
      { text: 'Jl.', x0: 1634, y0: 664, x1: 1659, y1: 760.3, conf: 100 },
      { text: 'Columbus,', x0: 154, y0: 714, x1: 315, y1: 810.3, conf: 100 },
    ];
    expect(groupLines(words).map((l) => l.text)).toEqual(['OLENTANGY RETAIL PT', '1850 Polaris Jl.', 'Columbus,']);
  });

  // boxes ~2x taller than the 50 px line pitch: the tolerance must follow the pitch, not the box height
  it('separates neighbouring lines by the measured line pitch when boxes are taller than the pitch', () => {
    const box = (text: string, x0: number, x1: number, yc: number, h: number): Word => ({ text, x0, x1, y0: yc - h / 2, y1: yc + h / 2, conf: 100 });
    const words: Word[] = [
      // a form grid: label + value on one baseline (different fonts), the next label 50 px lower
      box('Inv.', 1433, 1483, 424.4, 97.5),
      box('Ref.', 1489, 1547, 424.4, 97.5),
      box('SB-2609-0233', 1595, 1821, 433.9, 44.7),
      box('Your', 1368, 1440, 474.4, 97.5),
      box('Order', 1450, 1547, 474.4, 97.5),
      box('ORG-PO-55127', 1595, 1821, 483.9, 44.7),
      // an address column with the same pitch
      box('1850', 154, 228, 712, 96),
      box('Columbus,', 154, 315, 762, 96),
      box('Tel', 154, 200, 812, 96),
      box('USA', 154, 220, 862, 96),
    ];
    expect(groupLines(words).map((l) => l.text)).toEqual(['Inv. Ref. SB-2609-0233', 'Your Order ORG-PO-55127', '1850', 'Columbus,', 'Tel', 'USA']);
  });

  it('still joins words of one line whose boxes overlap a little (OCR phrase boxes, kerning)', () => {
    const words: Word[] = [
      { text: 'TOTAL', x0: 100, y0: 100, x1: 260, y1: 130, conf: 90 },
      { text: 'USD', x0: 250, y0: 101, x1: 320, y1: 131, conf: 90 },
    ];
    expect(groupLines(words).map((l) => l.text)).toEqual(['TOTAL USD']);
  });
});

describe('mergeWords', () => {
  it('keeps the primary reading unless the secondary is clearly better', () => {
    const p = [w('HELL0', 0, 0, 100, 30, 60), w('WORLD', 120, 0, 220, 30, 95)];
    const s = [w('HELLO', 2, 1, 101, 31, 92), w('W0RLD', 121, 0, 220, 30, 90)];
    expect(mergeWords(p, s).map((x) => x.text).sort()).toEqual(['HELLO', 'WORLD']);
  });

  it('adds confident words the primary pass missed, never duplicates', () => {
    const p = [w('ALSO', 0, 0, 80, 30, 96)];
    const s = [w('ALSO', 1, 0, 80, 30, 97), w('CUSTOMS', 300, 0, 450, 30, 97), w('~', 500, 0, 520, 30, 90), w('xx', 600, 0, 640, 30, 30)];
    expect(mergeWords(p, s).map((x) => x.text)).toEqual(['ALSO', 'CUSTOMS']);
  });

  it('replaces a junk box covering several good secondary words as one group', () => {
    const p = [w('y-——', 0, 0, 400, 40, 0)];
    const s = [w('CUSTOMS', 10, 5, 190, 35, 97), w('BROKER', 210, 5, 390, 35, 96)];
    expect(mergeWords(p, s).map((x) => x.text)).toEqual(['CUSTOMS', 'BROKER']);
  });

  it('iou is 1 for identical boxes and 0 for disjoint ones', () => {
    expect(iou(w('a', 0, 0, 10, 10), w('b', 0, 0, 10, 10))).toBe(1);
    expect(iou(w('a', 0, 0, 10, 10), w('b', 20, 20, 30, 30))).toBe(0);
  });
});

describe('detectKind', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n...');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const tif = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it('trusts magic bytes over names and mime types', () => {
    expect(detectKind(pdf, 'scan.png', 'image/png')).toBe('pdf');
    expect(detectKind(png, 'x.pdf', 'application/pdf')).toBe('png');
    expect(detectKind(jpg, 'x', '')).toBe('jpeg');
    expect(detectKind(tif, 'x', '')).toBe('tiff');
    expect(detectKind(webp, 'x', '')).toBe('webp');
  });

  it('rejects empty and unsupported files with typed errors', () => {
    expect(() => detectKind(new Uint8Array(), 'a.pdf', 'application/pdf')).toThrow(IngestError);
    try {
      detectKind(new TextEncoder().encode('hello'), 'notes.pdf', 'application/pdf');
      expect.unreachable();
    } catch (e) {
      expect((e as IngestError).code).toBe('UNSUPPORTED_FILE');
      expect((e as Error).message).toMatch(/notes\.pdf/);
    }
  });
});

describe('chooseUpscale', () => {
  it('leaves large images alone', () => {
    expect(chooseUpscale(2480, 3508, 300)).toEqual({ scale: 1, dpi: 300 });
    expect(chooseUpscale(2480, 3508)).toEqual({ scale: 1, dpi: 300 });
  });

  it('uses a plausible embedded density to reach 300 DPI', () => {
    expect(chooseUpscale(1240, 1754, 150)).toEqual({ scale: 2, dpi: 300 });
  });

  it('assumes a Letter/A4 page when the density is missing or implausible, capped at 4x', () => {
    const r = chooseUpscale(1100, 1650, 72);
    expect(r.scale).toBeCloseTo(3300 / 1650, 5);
    expect(r.dpi).toBe(300);
    expect(chooseUpscale(300, 400).scale).toBe(4);
  });

  // a phone photo of a sheet: 1600 x 2133 px with a 72 dpi EXIF tag; the page fills only part of the frame,
  // so the text is ~12 px high unless it is brought toward 300 DPI like any other small page image
  it('upscales a page image below the 300 DPI page size even when it is over 2000 px', () => {
    const r = chooseUpscale(1600, 2133, 72);
    expect(r.scale).toBeCloseTo(3300 / 2133, 5);
    expect(chooseUpscale(2000, 2800, 240)).toEqual({ scale: 1.25, dpi: 300 });
    expect(chooseUpscale(2550, 3300, 300)).toEqual({ scale: 1, dpi: 300 });
  });

  it('caps huge images at 7000 px on the long side', () => {
    const r = chooseUpscale(6000, 8000, 72);
    expect(r.scale).toBeCloseTo(7000 / 8000, 5);
    expect(r.dpi).toBe(300);
  });
});

describe('PNM encode/parse round trip', () => {
  it('round-trips gray and RGB', () => {
    const gray = new Uint8Array([0, 128, 255, 7, 8, 9]);
    expect(parsePnm(encodePnm(gray, 3, 2, 1))).toMatchObject({ width: 3, height: 2, channels: 1 });
    expect([...parsePnm(encodePnm(gray, 3, 2, 1)).data]).toEqual([...gray]);
    const rgb = new Uint8Array(2 * 1 * 3).fill(200);
    expect(parsePnm(encodePnm(rgb, 2, 1, 3))).toMatchObject({ width: 2, height: 1, channels: 3 });
  });

  it('skips header comments', () => {
    const buf = Buffer.concat([Buffer.from('P5\n# made by test\n2 1\n255\n'), Buffer.from([1, 2])]);
    expect([...parsePnm(buf).data]).toEqual([1, 2]);
  });
});

describe('createLimiter', () => {
  it('never runs more than `size` tasks at once and preserves results', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return n * 2;
        }),
      ),
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  it('propagates rejections without stalling the queue', async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('colour preprocessing (synthetic page)', () => {
  /** Cream paper, a black bar, a red bar, and a blue bar. */
  function page() {
    const width = 400;
    const height = 300;
    const data = Buffer.alloc(width * height * 3);
    for (let p = 0; p < width * height; p++) data.set([245, 239, 222], p * 3);
    const fill = (y0: number, y1: number, rgb: number[]) => {
      for (let y = y0; y < y1; y++) for (let x = 50; x < 350; x++) data.set(rgb, (y * width + x) * 3);
    };
    fill(40, 60, [30, 30, 30]);
    fill(120, 140, [210, 60, 60]);
    fill(200, 220, [50, 60, 150]);
    return { width, height, channels: 3 as const, data };
  }
  const at = (a: Uint8Array, x: number, y: number) => a[y * 400 + x];

  it('estimates the paper colour', () => {
    expect(estimatePaper(page())).toEqual({ r: 245, g: 239, b: 222 });
  });

  it('whitens red ink in the main layer, keeps black and blue, and builds ink layers', async () => {
    const r = await preprocess(page(), DEFAULT_PREPROCESS);
    expect(at(r.main, 100, 10)).toBe(255); // paper is white after white balance
    expect(at(r.main, 100, 50)).toBeLessThan(60); // black stays black
    expect(at(r.main, 100, 130)).toBeGreaterThan(245); // red stamp ink suppressed
    expect(at(r.main, 100, 210)).toBeLessThan(110); // blue ink kept (labels, handwriting)
    expect(r.red && at(r.red.image, 100, 130)).toBeLessThan(160);
    expect(r.red && at(r.red.image, 100, 50)).toBe(255); // black print is not red ink
    expect(r.blue && at(r.blue.image, 100, 210)).toBeLessThan(120);
    expect(r.red?.strong[130 * 400 + 100]).toBe(1);
  });

  it('can suppress blue too, or nothing', async () => {
    const both = await preprocess(page(), { ...DEFAULT_PREPROCESS, suppressBlue: true });
    expect(at(both.main, 100, 210)).toBeGreaterThan(240);
    const none = await preprocess(page(), { ...DEFAULT_PREPROCESS, suppressRed: false });
    expect(at(none.main, 100, 130)).toBeLessThan(150);
  });

  it('skips ink layers on grayscale pages', async () => {
    const g = page();
    for (let p = 0; p < g.width * g.height; p++) {
      const v = g.data[p * 3 + 1];
      g.data.set([v, v, v], p * 3);
    }
    const r = await preprocess(g);
    expect(r.red).toBeUndefined();
    expect(r.blue).toBeUndefined();
  });
});

describe('stamp geometry', () => {
  /** A 0/1 mask with a long rule, plus a block of short "text" strokes rotated by `deg`. */
  function maskWithStamp(deg: number) {
    const width = 800;
    const height = 600;
    const m = new Uint8Array(width * height);
    for (let x = 20; x < 780; x++) for (let y = 20; y < 23; y++) m[y * width + x] = 1; // form rule
    const th = (deg * Math.PI) / 180;
    const cx = 400;
    const cy = 350;
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 14; k++) {
        // 'letters': 10x24 blocks along a text line
        for (let dx = 0; dx < 10; dx++) {
          for (let dy = 0; dy < 24; dy++) {
            const u = -200 + k * 30 + dx;
            const v = -60 + row * 50 + dy;
            const x = Math.round(cx + u * Math.cos(th) - v * Math.sin(th));
            const y = Math.round(cy + u * Math.sin(th) + v * Math.cos(th));
            m[y * width + x] = 1;
          }
        }
      }
    }
    return { m, width, height };
  }

  it('removes long thin rules but keeps short strokes', async () => {
    const { m, width, height } = maskWithStamp(0);
    const before = m.reduce((a, b) => a + b, 0);
    const erased = await removeRules(m, width, height, 150);
    expect(erased).toBeGreaterThanOrEqual(760 * 3 - 10);
    expect(m.reduce((a, b) => a + b, 0)).toBe(before - erased);
    expect(m[21 * width + 400]).toBe(0);
    expect(m[350 * width + 412]).toBe(1); // inside a letter stroke
  });

  it('finds the text block as one region and measures its rotation', async () => {
    for (const deg of [-10, 0, 5.2]) {
      const { m, width, height } = maskWithStamp(deg);
      await removeRules(m, width, height, 150);
      const regions = findInkRegions(m, width, height, { lang: 'eng', dpi: 300, minRuleLength: 150, cell: 8, closeCells: 2, minInk: 600, minRegionHeight: 24, maxAngle: 30, minWordConf: 45 });
      expect(regions).toHaveLength(1);
      expect(Math.abs(estimateTextAngle(m, width, regions[0]) - deg)).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('layout cache', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('round-trips a layout and rejects other option keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-cache-'));
    dirs.push(dir);
    const layout: DocumentLayout = { docId: 'doc-abc', fileName: 'a.pdf', sha256: 'abc', mime: 'application/pdf', pages: [] };
    await writeCachedLayout(dir, layout, 'k1');
    expect(await readCachedLayout(dir, 'abc', 'k1')).toEqual(layout);
    expect(await readCachedLayout(dir, 'abc', 'k2')).toBeNull();
    expect(await readCachedLayout(dir, 'nope', 'k1')).toBeNull();
  });

  it('is invalid when a referenced page image is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-cache-'));
    dirs.push(dir);
    const page = { page: 1, width: 1, height: 1, source: 'ocr' as const, skewDeg: 0, words: [], lines: [], imagePath: join(dir, 'gone.png') };
    await writeCachedLayout(dir, { docId: 'd', fileName: 'f', sha256: 'abc', mime: 'image/png', pages: [page] }, 'k');
    expect(await readCachedLayout(dir, 'abc', 'k')).toBeNull();
  });

  it('defaults to server/.cache/ocr and honours INGEST_CACHE / INGEST_CACHE_DIR', () => {
    expect(defaultCacheDir({})).toMatch(/server[\\/]\.cache[\\/]ocr$/);
    expect(defaultCacheDir({ INGEST_CACHE_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(cacheEnabledByEnv({})).toBe(true);
    expect(cacheEnabledByEnv({ INGEST_CACHE: '0' })).toBe(false);
    expect(cacheEnabledByEnv({ INGEST_CACHE: 'false' })).toBe(false);
  });
});
