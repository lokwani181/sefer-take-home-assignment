/**
 * Skew estimation and coordinate deskew.
 *
 * We never rotate the image for OCR (tesseract copes with ~1° fine and rotation resamples the
 * pixels); instead we measure the slope of text lines and rotate the word boxes, so rows of a
 * table end up at the same y and the y-clustering into lines works across the full page width.
 */
import type { Word } from '@app/shared';

export interface SkewEstimate {
  /** dy/dx of text lines in image coordinates (y down); positive = text runs downhill = clockwise. */
  slope: number;
  /** Same, in degrees. */
  deg: number;
  /** Number of lines that contributed. */
  samples: number;
}

const MAX_ABS_SLOPE = 0.1; // ~5.7°: beyond that the line ids are not trustworthy for this method

interface Fit {
  slope: number;
  weight: number;
}

function fitLine(ws: Word[], minSpan: number): Fit | null {
  if (ws.length < 3) return null;
  const xs = ws.map((w) => (w.x0 + w.x1) / 2);
  const ys = ws.map((w) => (w.y0 + w.y1) / 2);
  const span = Math.max(...xs) - Math.min(...xs);
  if (span < minSpan) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  if (Math.abs(slope) >= MAX_ABS_SLOPE) return null;
  // Reject lines whose words do not sit on one straight line (sparse mode sometimes merges rows).
  const heights = ws.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1] || 1;
  let sse = 0;
  for (let i = 0; i < xs.length; i++) sse += (ys[i] - (my + slope * (xs[i] - mx))) ** 2;
  if (Math.sqrt(sse / xs.length) > 0.35 * medH) return null;
  return { slope, weight: span };
}

/**
 * Robust page skew from tesseract line groups: least-squares slope of word centres per line
 * (>= 3 words spanning >= minSpan px), outlier lines rejected by residual, then the span-weighted
 * median so long table rows dominate short label fragments.
 */
export function estimateSkew(lineGroups: Word[][], minSpan = 300): SkewEstimate {
  const fits = lineGroups.map((g) => fitLine(g, minSpan)).filter((f): f is Fit => f !== null);
  if (fits.length === 0) return { slope: 0, deg: 0, samples: 0 };
  fits.sort((a, b) => a.slope - b.slope);
  const total = fits.reduce((a, f) => a + f.weight, 0);
  let acc = 0;
  let slope = fits[fits.length - 1].slope;
  for (const f of fits) {
    acc += f.weight;
    if (acc * 2 >= total) {
      slope = f.slope;
      break;
    }
  }
  return { slope, deg: (Math.atan(slope) * 180) / Math.PI, samples: fits.length };
}

/** One decimal, rounding the exact binary value like Python round() (fixture compatibility). */
const r1 = (v: number) => Number(v.toFixed(1));

/**
 * Rotate word boxes about the page centre so lines with the given slope become horizontal.
 * Box sizes are kept (they are axis-aligned and the angle is small); output is plain Word objects.
 */
export function deskewWords(words: Word[], width: number, height: number, slope: number): Word[] {
  const plain = (w: Word, x0: number, y0: number, x1: number, y1: number): Word => ({ text: w.text, x0, y0, x1, y1, conf: w.conf });
  if (slope === 0) return words.map((w) => plain(w, w.x0, w.y0, w.x1, w.y1));
  const th = Math.atan(slope);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const cx = width / 2;
  const cy = height / 2;
  return words.map((w) => {
    const mx = (w.x0 + w.x1) / 2;
    const my = (w.y0 + w.y1) / 2;
    const hw = (w.x1 - w.x0) / 2;
    const hh = (w.y1 - w.y0) / 2;
    const nx = cx + (mx - cx) * cos + (my - cy) * sin;
    const ny = cy - (mx - cx) * sin + (my - cy) * cos;
    return plain(w, r1(nx - hw), r1(ny - hh), r1(nx + hw), r1(ny + hh));
  });
}
