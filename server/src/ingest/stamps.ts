/**
 * Stamp / handwriting text from a colour ink layer (e.g. red ink only, everything else white).
 *
 * Stamps are rotated, framed, and printed over other text, so OCRing the whole layer reads junk.
 * Instead: erase long ruling lines (pre-printed form boxes often share the ink colour), cluster the
 * remaining strong ink into regions, estimate each region's own text angle from projection
 * profiles, rotate that crop upright, remove its (now axis-aligned) frame, and OCR it.
 */
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import sharp from 'sharp';
import type { Word } from '@app/shared';
import { groupLines } from './lines.js';
import { mergeWords } from './merge.js';
import type { InkLayer } from './preprocess.js';
import { encodePnm } from './raster.js';
import { runTesseract, type OcrWord } from './tesseract.js';
import type { ToolPaths } from './tools.js';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface InkRegion extends Box {
  /** Strong-ink pixels inside the region (after ruling-line removal). */
  ink: number;
}

export interface StampLine {
  text: string;
  /** Mean word confidence. */
  conf: number;
  /** Median word height in page pixels (stamp lettering is usually larger than form labels). */
  textHeight: number;
  /** The words, mapped back to page pixel coordinates (before page deskew). */
  words: Word[];
  /** Region the line came from, in page coordinates (before page deskew). */
  region: Box;
  /** Rotation of the region's text relative to the image axes (degrees, clockwise positive). */
  angleDeg: number;
}

export interface StampOptions {
  lang: string;
  dpi: number;
  /** Runs of ink at least this long (px) are treated as ruling lines and erased. */
  minRuleLength: number;
  /** Grid cell (px) for region clustering, and the closing radius in cells. */
  cell: number;
  closeCells: number;
  /** Minimum strong-ink pixels / size for a region to be considered. */
  minInk: number;
  minRegionHeight: number;
  /** Search range for the region text angle (degrees). */
  maxAngle: number;
  /** Words below this confidence are dropped from stamp lines. */
  minWordConf: number;
}

export const DEFAULT_STAMP_OPTIONS: StampOptions = {
  lang: 'eng',
  dpi: 300,
  minRuleLength: 150,
  cell: 8,
  closeCells: 2,
  minInk: 600,
  minRegionHeight: 24,
  maxAngle: 30,
  minWordConf: 45,
};

const ROWS_PER_CHUNK = 256;
const PAD = 20;

/** 1 where the gray image is darker than `level` (ink), else 0. */
export function inkMask(gray: Uint8Array, level = 128): Uint8Array {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] < level ? 1 : 0;
  return m;
}

/**
 * Erase long thin horizontal and vertical strokes (form rules, box borders, strike-through lines)
 * from a 0/1 mask, in place. Runs are measured on a mask smeared by ±1 px across the run so a
 * slightly skewed rule stays one run; only pixels where the stroke is thin (<= maxThickness across
 * the run) are erased, so text that crosses a rule keeps its strokes. Returns the erased count.
 */
export async function removeRules(mask: Uint8Array, width: number, height: number, minLen: number, maxThickness = 10): Promise<number> {
  const erase = new Uint8Array(mask.length);
  for (let y0 = 0; y0 < height; y0 += ROWS_PER_CHUNK) {
    const yEnd = Math.min(height, y0 + ROWS_PER_CHUNK);
    for (let y = y0; y < yEnd; y++) {
      let runStart = -1;
      for (let x = 0; x <= width; x++) {
        const on =
          x < width &&
          (mask[y * width + x] === 1 || (y > 0 && mask[(y - 1) * width + x] === 1) || (y + 1 < height && mask[(y + 1) * width + x] === 1));
        if (on && runStart < 0) runStart = x;
        if (!on && runStart >= 0) {
          if (x - runStart >= minLen) for (let k = runStart; k < x; k++) erase[y * width + k] |= 1;
          runStart = -1;
        }
      }
    }
    await yieldToLoop();
  }
  for (let x0 = 0; x0 < width; x0 += ROWS_PER_CHUNK) {
    const xEnd = Math.min(width, x0 + ROWS_PER_CHUNK);
    for (let x = x0; x < xEnd; x++) {
      let runStart = -1;
      for (let y = 0; y <= height; y++) {
        const on =
          y < height &&
          (mask[y * width + x] === 1 || (x > 0 && mask[y * width + x - 1] === 1) || (x + 1 < width && mask[y * width + x + 1] === 1));
        if (on && runStart < 0) runStart = y;
        if (!on && runStart >= 0) {
          if (y - runStart >= minLen) for (let k = runStart; k < y; k++) erase[k * width + x] |= 2;
          runStart = -1;
        }
      }
    }
    await yieldToLoop();
  }
  let erased = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i] || !erase[i]) continue;
      let thin = false;
      if (erase[i] & 1) {
        let t = 1;
        for (let k = y - 1; k >= 0 && mask[k * width + x] && t <= maxThickness; k--) t++;
        for (let k = y + 1; k < height && mask[k * width + x] && t <= maxThickness; k++) t++;
        thin ||= t <= maxThickness;
      }
      if (erase[i] & 2) {
        let t = 1;
        for (let k = x - 1; k >= 0 && mask[y * width + k] && t <= maxThickness; k--) t++;
        for (let k = x + 1; k < width && mask[y * width + k] && t <= maxThickness; k++) t++;
        thin ||= t <= maxThickness;
      }
      if (thin) {
        mask[i] = 0;
        erased++;
      }
    }
    if (y % ROWS_PER_CHUNK === 0) await yieldToLoop();
  }
  return erased;
}

/**
 * Cluster ink into regions: mark grid cells holding ink, grow them by `closeCells` cells (joins
 * letters into words and the lines of one stamp into a block), then take connected components.
 */
export function findInkRegions(mask: Uint8Array, width: number, height: number, opts: StampOptions = DEFAULT_STAMP_OPTIONS): InkRegion[] {
  const c = opts.cell;
  const gw = Math.ceil(width / c);
  const gh = Math.ceil(height / c);
  const count = new Uint16Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = ((y / c) | 0) * gw;
    for (let x = 0; x < width; x++) if (mask[y * width + x]) count[row + ((x / c) | 0)]++;
  }
  const minCellInk = Math.max(2, Math.round((c * c) / 32));
  const inked = new Uint8Array(gw * gh);
  for (let i = 0; i < inked.length; i++) inked[i] = count[i] >= minCellInk ? 1 : 0;
  const r = opts.closeCells;
  const grown = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!inked[gy * gw + gx]) continue;
      for (let yy = Math.max(0, gy - r); yy <= Math.min(gh - 1, gy + r); yy++) {
        for (let xx = Math.max(0, gx - r); xx <= Math.min(gw - 1, gx + r); xx++) grown[yy * gw + xx] = 1;
      }
    }
  }
  const label = new Int32Array(gw * gh).fill(-1);
  const regions: InkRegion[] = [];
  const stack: number[] = [];
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    const id = regions.length;
    const reg: InkRegion = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, ink: 0 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop() as number;
      const gx = i % gw;
      const gy = (i / gw) | 0;
      if (inked[i]) {
        reg.ink += count[i];
        reg.x0 = Math.min(reg.x0, gx * c);
        reg.y0 = Math.min(reg.y0, gy * c);
        reg.x1 = Math.max(reg.x1, Math.min(width, (gx + 1) * c));
        reg.y1 = Math.max(reg.y1, Math.min(height, (gy + 1) * c));
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (grown[j] && label[j] < 0) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    regions.push(reg);
  }
  return regions.filter((g) => g.ink >= opts.minInk && g.y1 - g.y0 >= opts.minRegionHeight && g.x1 - g.x0 >= opts.minRegionHeight);
}

/**
 * Text angle of a region by projection profile: rotate ink points by candidate angles and keep the
 * angle whose row histogram is most peaked (text lines and frame edges become sharp rows).
 * Returns degrees, clockwise positive (text descending to the right).
 */
export function estimateTextAngle(mask: Uint8Array, width: number, region: Box, maxAngle = 30): number {
  const pts: number[] = [];
  const area = (region.x1 - region.x0) * (region.y1 - region.y0);
  const step = Math.max(1, Math.round(Math.sqrt(area / 40_000)));
  const cx = (region.x0 + region.x1) / 2;
  const cy = (region.y0 + region.y1) / 2;
  for (let y = region.y0; y < region.y1; y += step) {
    for (let x = region.x0; x < region.x1; x += step) if (mask[y * width + x]) pts.push(x - cx, y - cy);
  }
  if (pts.length < 40) return 0;
  const diag = Math.ceil(Math.hypot(region.x1 - region.x0, region.y1 - region.y0)) + 4;
  const bin = 3;
  const bins = new Float64Array(Math.ceil((2 * diag) / bin) + 1);
  const score = (deg: number) => {
    const th = (deg * Math.PI) / 180;
    const s = Math.sin(th);
    const co = Math.cos(th);
    bins.fill(0);
    // Row coordinate after rotating by -deg (undoing the text slope).
    for (let i = 0; i < pts.length; i += 2) bins[((-pts[i] * s + pts[i + 1] * co + diag) / bin) | 0]++;
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i] * bins[i];
    return sum;
  };
  let best = 0;
  let bestScore = -1;
  const consider = (deg: number) => {
    const sc = score(deg);
    if (sc > bestScore) {
      bestScore = sc;
      best = deg;
    }
  };
  for (let deg = -maxAngle; deg <= maxAngle; deg += 1) consider(deg);
  const coarse = best;
  for (let deg = coarse - 0.9; deg <= coarse + 0.9; deg += 0.1) consider(deg);
  return Math.round(best * 10) / 10;
}

/** An upright, frame-free crop ready for OCR, plus the mapping back to page coordinates. */
export interface UprightCrop {
  /** PNM at 1x and 2x. */
  image: Buffer;
  image2x: Buffer;
  /** Map a point of the 1x crop image back to page coordinates. */
  toPage: (u: number, v: number) => [number, number];
}

/**
 * Crop a region (with margin) out of a gray layer, rotate it upright, stretch contrast, erase the
 * stamp frame (axis-aligned after rotation, so run-length rule removal catches it) and pad it.
 */
export async function uprightCrop(gray: Uint8Array, width: number, height: number, region: Box, angleDeg: number, minRuleLength: number): Promise<UprightCrop> {
  const m = 24;
  const left = Math.max(0, region.x0 - m);
  const top = Math.max(0, region.y0 - m);
  const w = Math.min(width, region.x1 + m) - left;
  const h = Math.min(height, region.y1 + m) - top;
  const src = Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength);
  let crop = await sharp(src, { raw: { width, height, channels: 1 } })
    .extract({ left, top, width: w, height: h })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rotated = Math.abs(angleDeg) >= 0.5;
  if (rotated) {
    // sharp rotates clockwise for positive angles and grows the canvas around the same centre.
    crop = await sharp(crop.data, { raw: { width: crop.info.width, height: crop.info.height, channels: 1 } })
      .rotate(-angleDeg, { background: { r: 255, g: 255, b: 255 } })
      .extractChannel(0)
      .raw()
      .toBuffer({ resolveWithObject: true });
  }
  const cw = crop.info.width;
  const ch = crop.info.height;
  const pixels = new Uint8Array(crop.data);
  // Stretch contrast: faded stamp ink is mid-gray; tesseract binarizes better on near-black.
  const hist = new Uint32Array(256);
  for (const v of pixels) hist[v]++;
  let dark = 0;
  for (let acc = 0; dark < 255 && acc < pixels.length * 0.005; dark++) acc += hist[dark];
  if (dark < 200) {
    for (let i = 0; i < pixels.length; i++) pixels[i] = Math.max(0, Math.min(255, Math.round(((pixels[i] - dark) * 255) / (255 - dark))));
  }
  // Stamp frames are thicker than form rules.
  const mask = inkMask(pixels, 200);
  const before = mask.slice();
  await removeRules(mask, cw, ch, Math.min(minRuleLength, Math.round(0.5 * Math.max(cw, ch))), 24);
  for (let i = 0; i < mask.length; i++) if (before[i] && !mask[i]) pixels[i] = 255;
  const padded = sharp(Buffer.from(pixels.buffer), { raw: { width: cw, height: ch, channels: 1 } }).extend({
    top: PAD,
    bottom: PAD,
    left: PAD,
    right: PAD,
    background: { r: 255, g: 255, b: 255 },
  });
  const one = await padded.clone().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const two = await sharp(one.data, { raw: { width: one.info.width, height: one.info.height, channels: 1 } })
    .resize({ width: one.info.width * 2, height: one.info.height * 2, kernel: 'lanczos3' })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const th = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const toPage = (u: number, v: number): [number, number] => {
    let x = u - PAD;
    let y = v - PAD;
    if (rotated) {
      // Undo the -angle rotation: rotate clockwise by angle about the canvas centre.
      const dx = x - cw / 2;
      const dy = y - ch / 2;
      x = w / 2 + dx * cos - dy * sin;
      y = h / 2 + dx * sin + dy * cos;
    }
    return [left + x, top + y];
  };
  return {
    image: encodePnm(one.data, one.info.width, one.info.height, 1),
    image2x: encodePnm(two.data, two.info.width, two.info.height, 1),
    toPage,
  };
}

const ALNUM = /[\p{L}\p{N}]/gu;

/** Keep words that look like text, and lines that still have real content after that. */
function cleanLine(words: Word[], minWordConf: number): Word[] {
  const kept = words.filter((w) => w.conf >= minWordConf && (w.text.match(ALNUM)?.length ?? 0) >= 1);
  const alnum = kept.reduce((n, w) => n + (w.text.match(ALNUM)?.length ?? 0), 0);
  return alnum >= 4 ? kept : [];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** One decimal, rounding the exact binary value like Python round() (fixture compatibility). */
const r1 = (v: number) => Number(v.toFixed(1));

/** Decides, from geometry alone, whether a region is worth OCRing. */
export type RegionFilter = (region: InkRegion, angleDeg: number) => boolean;

/**
 * Read the text of the ink regions of a colour layer. Each selected region is OCRed upright three
 * ways and merged: psm 11 (sparse: big isolated words), psm 6 (block: lines touching the frame) and
 * psm 11 at 2x (small faded lettering). Lines come back top to bottom with page-space word boxes,
 * so the caller can decide which are stamps, handwriting, or coloured print.
 */
export async function readInkLayer(
  paths: ToolPaths,
  layer: InkLayer,
  width: number,
  height: number,
  opts: StampOptions = DEFAULT_STAMP_OPTIONS,
  select: RegionFilter = () => true,
  run: <T>(task: () => Promise<T>) => Promise<T> = (t) => t(),
): Promise<StampLine[]> {
  const mask = layer.strong.slice();
  await removeRules(mask, width, height, opts.minRuleLength);
  const regions = findInkRegions(mask, width, height, opts).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const perRegion = await Promise.all(
    regions.map(async (region) => {
      const angleDeg = estimateTextAngle(mask, width, region, opts.maxAngle);
      if (!select(region, angleDeg)) return [];
      const crop = await uprightCrop(layer.image, width, height, region, angleDeg, opts.minRuleLength);
      const base = { lang: opts.lang, dpi: opts.dpi };
      const [sparse, block, big] = await Promise.all([
        run(() => runTesseract(paths, crop.image, { ...base, psm: 11 })),
        run(() => runTesseract(paths, crop.image, { ...base, psm: 6 })),
        run(() => runTesseract(paths, crop.image2x, { ...base, psm: 11, dpi: opts.dpi * 2 })),
      ]);
      const half = big.words.map((w): OcrWord => ({ ...w, x0: w.x0 / 2, y0: w.y0 / 2, x1: w.x1 / 2, y1: w.y1 / 2 }));
      const merged = mergeWords(mergeWords(sparse.words, block.words), half);
      const lines: StampLine[] = [];
      for (const line of groupLines(merged)) {
        const words = cleanLine(line.words, opts.minWordConf);
        if (!words.length) continue;
        const pageWords = words.map((w): Word => {
          const [cx, cy] = crop.toPage((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2);
          const hw = (w.x1 - w.x0) / 2;
          const hh = (w.y1 - w.y0) / 2;
          return { text: w.text, x0: r1(cx - hw), y0: r1(cy - hh), x1: r1(cx + hw), y1: r1(cy + hh), conf: w.conf };
        });
        lines.push({
          text: words.map((w) => w.text).join(' '),
          conf: Math.round(words.reduce((a, w) => a + w.conf, 0) / words.length),
          textHeight: median(words.map((w) => w.y1 - w.y0)),
          words: pageWords,
          region: { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 },
          angleDeg,
        });
      }
      return lines;
    }),
  );
  return perRegion.flat();
}
