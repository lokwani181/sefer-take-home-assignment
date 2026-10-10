/**
 * Image uploads: a 300 DPI PNG of the packing list (rendered inside the test with pdftoppm) and a
 * low-resolution JPEG that must be upscaled toward 300 DPI before OCR.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngest } from '../../src/ingest/index.js';
import { PL_KEY, recall } from './tokens.js';

const run = promisify(execFile);
const PL_PDF = join(import.meta.dirname, '..', '..', '..', 'samples', 'SPG-PL-2609-117_Packing_List.pdf');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-image-'));
  await Promise.all([
    run('pdftoppm', ['-r', '300', '-png', '-singlefile', PL_PDF, join(dir, 'pl300')]),
    run('pdftoppm', ['-r', '150', '-jpeg', '-singlefile', PL_PDF, join(dir, 'pl150')]),
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('image input', () => {
  it('OCRs a 300 DPI PNG directly, in its own pixel space', async () => {
    const bytes = new Uint8Array(readFileSync(join(dir, 'pl300.png')));
    const layout = await createIngest({ cache: false, cacheDir: dir })({ name: 'packing-list.png', mime: 'image/png', bytes });
    expect(layout.mime).toBe('image/png');
    expect(layout.pages).toHaveLength(1);
    const [p] = layout.pages;
    expect(p.source).toBe('ocr');
    expect([p.width, p.height]).toEqual([3510, 2482]);
    expect(Math.abs(p.skewDeg - -0.78)).toBeLessThanOrEqual(0.3);
    expect(recall(p.words, PL_KEY, 80).missing).toEqual([]);
    expect(p.imagePath && existsSync(p.imagePath)).toBe(true);
    const meta = await sharp(p.imagePath!).metadata();
    expect([meta.width, meta.height]).toEqual([p.width, p.height]);
  });

  it('upscales a low-resolution JPEG toward 300 DPI and keeps coordinates in that space', async () => {
    const bytes = new Uint8Array(readFileSync(join(dir, 'pl150.jpg')));
    const meta = await sharp(bytes).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThan(2000);
    // Declared mime is wrong on purpose: content sniffing decides.
    const layout = await createIngest({ cache: false, cacheDir: dir })({ name: 'scan.jpg', mime: 'application/octet-stream', bytes });
    expect(layout.mime).toBe('image/jpeg');
    const [p] = layout.pages;
    expect(Math.max(p.width, p.height)).toBeGreaterThanOrEqual(3300);
    expect(Math.max(...p.words.map((w) => w.x1))).toBeLessThanOrEqual(p.width + 1);
    expect(recall(p.words, PL_KEY, 0).missing).toEqual([]);
    expect(recall(p.words, PL_KEY, 80).found).toBeGreaterThanOrEqual(16);
  });

  it('OCRs every frame of a multi-page TIFF as its own page', async () => {
    const jpg = readFileSync(join(dir, 'pl150.jpg'));
    const tiff = await sharp([jpg, jpg], { join: { animated: true } }).tiff({ compression: 'lzw' }).toBuffer();
    expect((await sharp(tiff).metadata()).pages).toBe(2);
    const layout = await createIngest({ cache: false, cacheDir: dir, stamps: false, secondPass: false })({ name: 'fax.tif', mime: 'image/tiff', bytes: new Uint8Array(tiff) });
    expect(layout.mime).toBe('image/tiff');
    expect(layout.pages.map((p) => p.page)).toEqual([1, 2]);
    for (const p of layout.pages) {
      expect(p.source).toBe('ocr');
      expect(recall(p.words, PL_KEY, 0).found).toBeGreaterThanOrEqual(16);
      expect(p.imagePath).toMatch(new RegExp(`page-${p.page}\\.png$`));
    }
  });

  it('honours EXIF orientation (a rotated phone photo reads upright)', async () => {
    // Store the page rotated 90° with an EXIF tag saying "rotate back": readers must apply it.
    const upright = readFileSync(join(dir, 'pl150.jpg'));
    const stored = await sharp(upright).rotate(-90).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer();
    const layout = await createIngest({ cache: false, cacheDir: dir, stamps: false })({ name: 'photo.jpg', mime: 'image/jpeg', bytes: new Uint8Array(stored) });
    const [p] = layout.pages;
    expect(p.width).toBeGreaterThan(p.height); // landscape page, as printed
    expect(recall(p.words, PL_KEY, 0).found).toBeGreaterThanOrEqual(16);
  });
});
