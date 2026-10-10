/**
 * Visual line building: words → lines by y-centre clustering (same rule as the fixture generator,
 * so parsers developed against the fixtures see the same structure from live ingest), plus one
 * physical constraint: a visual line never holds two words stacked on top of each other.
 */
import type { Line, Word } from '@app/shared';

const yc = (w: Word) => (w.y0 + w.y1) / 2;

/**
 * True when `w` sits above or below a word of the cluster (same column, different line).
 *
 * Why: some text-layer fonts (CJK families, Gill Sans) report ascent/descent much larger than the
 * glyphs, so word boxes are taller than the line pitch and the y-centres of two consecutive lines
 * of one paragraph fall within the clustering tolerance. Two words that overlap horizontally with
 * clearly different y-centres can only be on different lines, whatever the box heights say.
 * Boxes that overlap at nearly the same height (OCR phrase boxes, kerning) are not stacked.
 */
function stacked(cluster: Word[], w: Word): boolean {
  const ww = w.x1 - w.x0;
  const wh = w.y1 - w.y0;
  return cluster.some((o) => {
    const ov = Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0);
    if (ov <= 0.3 * Math.min(o.x1 - o.x0, ww)) return false;
    return Math.abs(yc(o) - yc(w)) > 0.25 * Math.min(o.y1 - o.y0, wh);
  });
}

/**
 * Typical distance between the y-centres of consecutive lines of one column: for each word, the
 * nearest word below it that overlaps it horizontally; the lower quartile of those distances (gaps
 * between blocks and single-line cells make the upper part much larger than the line spacing).
 * Undefined when the page has too few stacked words to tell.
 */
export function linePitch(words: Word[]): number | undefined {
  const dys: number[] = [];
  for (const w of words) {
    const ww = w.x1 - w.x0;
    let best = Infinity;
    for (const o of words) {
      const dy = yc(o) - yc(w);
      if (dy <= 2 || dy >= best) continue;
      const ov = Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0);
      if (ov > 0.3 * Math.min(o.x1 - o.x0, ww)) best = dy;
    }
    if (Number.isFinite(best)) dys.push(best);
  }
  if (dys.length < 5) return undefined;
  dys.sort((a, b) => a - b);
  return dys[dys.length >> 2];
}

/**
 * Cluster words into lines: sort by y-centre and put each word on the nearest line whose running
 * mean centre is within tol = max(4, 0.5 × median word height) and that has no word stacked above
 * or below it; otherwise start a new line. Without stacked words this is exactly "compare with the
 * last line" (older lines are always further away). Words in a line are sorted left to right;
 * lines come out top to bottom.
 *
 * Boxes taller than the line pitch (inflated text-layer font metrics) would make half a box height
 * reach the next line, so then the tolerance is 0.4 × the measured pitch instead.
 */
export function groupLines(words: Word[]): Line[] {
  if (words.length === 0) return [];
  const heights = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1];
  const pitch = linePitch(words);
  const tol = Math.max(4, pitch !== undefined && medH > pitch ? Math.min(0.5 * medH, 0.4 * pitch) : 0.5 * medH);
  const clusters: { yc: number; sum: number; words: Word[] }[] = [];
  for (const w of [...words].sort((a, b) => yc(a) - yc(b))) {
    const c = yc(w);
    let best: (typeof clusters)[number] | undefined;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const cl = clusters[i];
      // cluster means only grow with the sorted input, so everything further back is out of reach
      if (c - cl.yc > 3 * tol) break;
      const d = Math.abs(c - cl.yc);
      if (d > tol || stacked(cl.words, w)) continue;
      if (!best || d < Math.abs(c - best.yc)) best = cl;
    }
    if (best) {
      best.words.push(w);
      best.sum += c;
      best.yc = best.sum / best.words.length;
    } else {
      clusters.push({ yc: c, sum: c, words: [w] });
    }
  }
  clusters.sort((a, b) => a.yc - b.yc);
  return clusters.map(({ words: ws }) => {
    const sorted = [...ws].sort((a, b) => a.x0 - b.x0);
    return {
      text: sorted.map((w) => w.text).join(' '),
      words: sorted,
      x0: Math.min(...sorted.map((w) => w.x0)),
      y0: Math.min(...sorted.map((w) => w.y0)),
      x1: Math.max(...sorted.map((w) => w.x1)),
      y1: Math.max(...sorted.map((w) => w.y1)),
    };
  });
}
