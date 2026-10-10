/**
 * Colour-aware preprocessing for OCR.
 *
 * Scanned shipping documents carry coloured ink on top of the black print: red "TELEX RELEASED"
 * stamps, blue "SHIPPED ON BOARD" stamps, blue handwriting, sometimes blue pre-printed form labels.
 * We white-balance against the paper colour, measure per pixel how strongly red or blue dominates
 * (d = channel - max(other channels)), and produce:
 *   main  — grayscale with the chosen ink colours pushed to paper white (what the main OCR pass reads)
 *   red / blue ink layers — only that ink (its luminance, everything else white) for the stamp pass,
 *           plus a mask of strongly coloured pixels used to locate stamp regions.
 */
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { Raster } from './raster.js';

export interface PreprocessConfig {
  /** Push red-dominant pixels (stamp ink) to white in the main layer. */
  suppressRed: boolean;
  /** Push blue-dominant pixels to white in the main layer. */
  suppressBlue: boolean;
  /**
   * How suppression works. 'channel' views the page through a colour filter (gray = max(luminance,
   * ink channel)): smooth and threshold-free, lifts the faint JPEG chroma halos around strokes.
   * 'mask' ramps pixels to white by colour dominance (dominanceLow → dominanceHigh), which clears
   * stroke interiors. 'both' takes the lighter of the two.
   */
  suppressMethod: 'channel' | 'mask' | 'both';
  /** Divide by the estimated paper colour so cream/grey paper becomes white (a light normalization). */
  whiteBalance: boolean;
  /** Additional linear contrast stretch between the 1st and 99th luminance percentiles. */
  normalize: boolean;
  /** Dominance (0–255 scale) where mask suppression starts, and where it is complete. */
  dominanceLow: number;
  dominanceHigh: number;
  /** Build the red/blue ink layers for the stamp pass. */
  inkLayers: boolean;
  /**
   * Dominance from which a pixel belongs to an ink layer (soft edge from layerLow to layerHigh).
   * Low on purpose: stamp ink is often faded. Measured on a scanned B/L: blue stamp p10 = 10,
   * median = 34; blue handwriting median 32; blue form labels ~22; black print <= 6.
   */
  layerLow: number;
  layerHigh: number;
  /** Dominance from which a pixel is "strong" ink, used to locate stamp regions. */
  strongDominance: number;
}

export const DEFAULT_PREPROCESS: PreprocessConfig = {
  suppressRed: true,
  suppressBlue: false,
  suppressMethod: 'both',
  whiteBalance: true,
  normalize: false,
  dominanceLow: 20,
  dominanceHigh: 60,
  inkLayers: true,
  layerLow: 8,
  layerHigh: 16,
  strongDominance: 30,
};

export interface InkLayer {
  /** Luminance of this ink's pixels, everything else white: the stamp pass OCRs crops of this. */
  image: Uint8Array;
  /** 1 where the colour is strong (dominance >= strongDominance), else 0. */
  strong: Uint8Array;
  /** Fraction of the page that is strong ink of this colour. */
  fraction: number;
}

export interface PreprocessResult {
  width: number;
  height: number;
  main: Uint8Array;
  /** Present when the page has enough strong ink of that colour to be worth a stamp pass. */
  red?: InkLayer;
  blue?: InkLayer;
  redFraction: number;
  blueFraction: number;
  paper: { r: number; g: number; b: number };
}

/** A colour layer is OCRed only when at least this fraction of the page is strong ink of that colour. */
export const MIN_INK_FRACTION = 0.0005;

const ROWS_PER_CHUNK = 192;

/**
 * Estimate the paper colour as the per-channel median of a pixel sample: documents are mostly
 * paper. Falls back to pure white when the median is dark (photo, inverted scan).
 */
export function estimatePaper(raster: Raster): { r: number; g: number; b: number } {
  if (raster.channels !== 3) return { r: 255, g: 255, b: 255 };
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const { data } = raster;
  const n = raster.width * raster.height;
  const step = Math.max(1, Math.floor(n / 400_000));
  let count = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 3;
    hist[0][data[i]]++;
    hist[1][data[i + 1]]++;
    hist[2][data[i + 2]]++;
    count++;
  }
  const median = (h: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc * 2 >= count) return v;
    }
    return 255;
  };
  const r = median(hist[0]);
  const g = median(hist[1]);
  const b = median(hist[2]);
  if (0.299 * r + 0.587 * g + 0.114 * b < 128) return { r: 255, g: 255, b: 255 };
  return { r: Math.max(r, 128), g: Math.max(g, 128), b: Math.max(b, 128) };
}

/** Percentile of an 8-bit histogram. */
function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/** Fractions of strongly red / blue pixels on a 1-in-16 sample (white-balanced). */
function sampleInkFractions(raster: Raster, paper: { r: number; g: number; b: number }, strong: number): { red: number; blue: number } {
  const { data } = raster;
  const n = raster.width * raster.height;
  let red = 0;
  let blue = 0;
  let count = 0;
  for (let p = 0; p < n; p += 16) {
    const i = p * 3;
    const r = Math.min(255, (data[i] * 255) / paper.r);
    const g = Math.min(255, (data[i + 1] * 255) / paper.g);
    const b = Math.min(255, (data[i + 2] * 255) / paper.b);
    if (r - Math.max(g, b) >= strong) red++;
    if (b - Math.max(r, g) >= strong) blue++;
    count++;
  }
  return { red: red / count, blue: blue / count };
}

const ramp = (d: number, low: number, width: number) => (d <= low ? 0 : d >= low + width ? 1 : (d - low) / width);

/**
 * Build the OCR layers for one page. Processes the image in row chunks and yields to the event
 * loop between them, so a 9-megapixel page never blocks the server for more than a few ms.
 */
export async function preprocess(raster: Raster, cfg: PreprocessConfig = DEFAULT_PREPROCESS): Promise<PreprocessResult> {
  const { width, height, data } = raster;
  const n = width * height;
  const color = raster.channels === 3;
  const layers = cfg.inkLayers && color;
  const main = new Uint8Array(n);
  const paper = cfg.whiteBalance ? estimatePaper(raster) : { r: 255, g: 255, b: 255 };
  // Cheap colour pre-scan so grayscale pages never allocate the (large) ink layers.
  const sample = layers ? sampleInkFractions(raster, paper, cfg.strongDominance) : { red: 0, blue: 0 };
  const red = layers && sample.red >= MIN_INK_FRACTION / 2 ? { image: new Uint8Array(n), strong: new Uint8Array(n) } : null;
  const blue = layers && sample.blue >= MIN_INK_FRACTION / 2 ? { image: new Uint8Array(n), strong: new Uint8Array(n) } : null;
  const fr = 255 / paper.r;
  const fg = 255 / paper.g;
  const fb = 255 / paper.b;
  const lo = cfg.dominanceLow;
  const span = Math.max(1, cfg.dominanceHigh - cfg.dominanceLow);
  const llo = cfg.layerLow;
  const lspan = Math.max(1, cfg.layerHigh - cfg.layerLow);
  const strong = cfg.strongDominance;
  const hist = new Uint32Array(256);
  let redInk = 0;
  let blueInk = 0;

  for (let y0 = 0; y0 < height; y0 += ROWS_PER_CHUNK) {
    const end = Math.min(height, y0 + ROWS_PER_CHUNK) * width;
    for (let p = y0 * width; p < end; p++) {
      let r: number;
      let g: number;
      let b: number;
      if (color) {
        const i = p * 3;
        r = Math.min(255, data[i] * fr);
        g = Math.min(255, data[i + 1] * fg);
        b = Math.min(255, data[i + 2] * fb);
      } else {
        r = g = b = data[p];
      }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const dRed = r - (g > b ? g : b);
      const dBlue = b - (r > g ? r : g);
      let v = lum;
      if (cfg.suppressMethod !== 'mask') {
        if (cfg.suppressRed && r > v) v = r;
        if (cfg.suppressBlue && b > v) v = b;
      }
      if (cfg.suppressMethod !== 'channel') {
        const s = Math.max(cfg.suppressRed ? ramp(dRed, lo, span) : 0, cfg.suppressBlue ? ramp(dBlue, lo, span) : 0);
        if (s > 0) v = Math.max(v, lum + (255 - lum) * s);
      }
      const gray = v > 255 ? 255 : v | 0;
      main[p] = gray;
      hist[gray]++;
      // Ink layers: colour only selects pixels; the value is their luminance. JPEG stores colour at
      // half resolution, so a pure colour mask has fat blurry strokes; and faint ink stays readable.
      if (red) {
        red.image[p] = 255 - (((255 - lum) * ramp(dRed, llo, lspan)) | 0);
        if (dRed >= strong) {
          red.strong[p] = 1;
          redInk++;
        }
      }
      if (blue) {
        blue.image[p] = 255 - (((255 - lum) * ramp(dBlue, llo, lspan)) | 0);
        if (dBlue >= strong) {
          blue.strong[p] = 1;
          blueInk++;
        }
      }
    }
    await yieldToLoop();
  }

  if (cfg.normalize) {
    const low = percentile(hist, n, 0.01);
    const high = percentile(hist, n, 0.99);
    if (high - low >= 32 && (low > 0 || high < 255)) {
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - low) * 255) / (high - low))));
      for (let p0 = 0; p0 < n; p0 += ROWS_PER_CHUNK * width) {
        const end = Math.min(n, p0 + ROWS_PER_CHUNK * width);
        for (let p = p0; p < end; p++) main[p] = lut[main[p]];
        await yieldToLoop();
      }
    }
  }

  const redFraction = redInk / n;
  const blueFraction = blueInk / n;
  return {
    width,
    height,
    main,
    red: red && redFraction >= MIN_INK_FRACTION ? { ...red, fraction: redFraction } : undefined,
    blue: blue && blueFraction >= MIN_INK_FRACTION ? { ...blue, fraction: blueFraction } : undefined,
    redFraction,
    blueFraction,
    paper,
  };
}
