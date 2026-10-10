/**
 * Merge a secondary OCR pass into a primary one without double counting.
 *
 * Words of both passes are linked when their boxes overlap (intersection / smaller box >= sameBox).
 * Each connected group is one piece of page content read twice; we keep whichever side reads it
 * with the higher character-weighted confidence (the secondary side must win by a margin), so
 * segmentation differences ("SUITE 300" vs "SUITE300") and junk boxes are resolved as a unit.
 * Secondary words with no counterpart are added when confident: usually text the primary pass
 * lost (sparse mode skips some lines; stamps break others).
 */
import type { OcrWord } from './tesseract.js';

export interface MergeOptions {
  /** Overlap (intersection / smaller area) above which two boxes cover the same content. */
  sameBox: number;
  /** The secondary reading must beat the primary group's confidence by this margin. */
  replaceMargin: number;
  /** Minimum confidence for a secondary word that has no counterpart in the primary pass. */
  minNewConf: number;
}

export const DEFAULT_MERGE: MergeOptions = { sameBox: 0.5, replaceMargin: 8, minNewConf: 75 };

function area(w: OcrWord): number {
  return Math.max(0, w.x1 - w.x0) * Math.max(0, w.y1 - w.y0);
}

function intersection(a: OcrWord, b: OcrWord): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Intersection over union of two word boxes. */
export function iou(a: OcrWord, b: OcrWord): number {
  const i = intersection(a, b);
  return i === 0 ? 0 : i / (area(a) + area(b) - i);
}

/** Intersection over the smaller box: 1 when one box contains the other. */
export function overlapMin(a: OcrWord, b: OcrWord): number {
  const i = intersection(a, b);
  return i === 0 ? 0 : i / Math.max(1, Math.min(area(a), area(b)));
}

const ALNUM = /[\p{L}\p{N}]/gu;
const alnumCount = (s: string) => s.match(ALNUM)?.length ?? 0;

/** Character-weighted mean confidence; punctuation-only words count as one char at conf/2. */
function groupScore(words: OcrWord[]): number {
  let num = 0;
  let den = 0;
  for (const w of words) {
    const n = alnumCount(w.text);
    const weight = n > 0 ? n : 1;
    num += (n > 0 ? w.conf : w.conf / 2) * weight;
    den += weight;
  }
  return den ? num / den : 0;
}

/** Combine two passes over the same page (same pixel space). Returns a new array; inputs untouched. */
export function mergeWords(primary: OcrWord[], secondary: OcrWord[], opts: MergeOptions = DEFAULT_MERGE): OcrWord[] {
  const np = primary.length;
  const all = [...primary, ...secondary];
  // Union-find over primary ∪ secondary, linking cross-pass overlaps only.
  const parent = all.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  // Sort-and-sweep on y to avoid the O(n·m) all-pairs test on dense pages.
  const order = secondary.map((_, j) => j).sort((a, b) => secondary[a].y0 - secondary[b].y0);
  const prim = primary.map((_, i) => i).sort((a, b) => primary[a].y0 - primary[b].y0);
  let start = 0;
  for (const j of order) {
    const s = secondary[j];
    while (start < prim.length && primary[prim[start]].y1 < s.y0 - 200) start++;
    for (let k = start; k < prim.length; k++) {
      const p = primary[prim[k]];
      if (p.y0 > s.y1) break;
      if (overlapMin(p, s) >= opts.sameBox) parent[find(np + j)] = find(prim[k]);
    }
  }
  const groups = new Map<number, { p: OcrWord[]; s: OcrWord[] }>();
  all.forEach((w, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { p: [], s: [] }));
    (i < np ? g.p : g.s).push(w);
  });
  const out: OcrWord[] = [];
  for (const g of groups.values()) {
    if (g.s.length === 0) {
      out.push(...g.p.map((w) => ({ ...w })));
    } else if (g.p.length === 0) {
      for (const w of g.s) if (w.conf >= opts.minNewConf && alnumCount(w.text) > 0) out.push({ ...w });
    } else if (groupScore(g.s) >= groupScore(g.p) + opts.replaceMargin && g.s.some((w) => w.conf >= opts.minNewConf)) {
      out.push(...g.s.map((w) => ({ ...w })));
    } else {
      out.push(...g.p.map((w) => ({ ...w })));
    }
  }
  return out;
}
