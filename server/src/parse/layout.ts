/**
 * Page model used by every parser: a cleaned, indexed view of a DocumentLayout.
 *
 * Why: raw OCR words carry artefacts (vertical table rules read as "|", phrase-wide
 * boxes, curly quotes, strike-through underscores). Normalizing them once here keeps
 * the label/table primitives simple and deterministic.
 */
import type { DocumentLayout, PageLayout, Word } from '@app/shared';
import { compactKey, normalizePunct, squash } from './text';
import { linePitch } from '../ingest/lines';

export interface PWord {
  /** Cleaned display text (quotes normalized, strike/underline artefacts trimmed). */
  text: string;
  /** Text exactly as read. */
  raw: string;
  /** compactKey(text) */
  key: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  conf: number;
  page: number;
  /** Index of the line within its page. */
  line: number;
  /** Table rules, tildes, underscores: kept for text but ignored by tables/labels. */
  noise: boolean;
  /** The right edge was clamped because the OCR box overlapped the next word. */
  clamped?: boolean;
  /** From a PDF text layer: word boundaries are the document's own spaces, never glued back together. */
  textLayer?: boolean;
}

export interface PLine {
  page: number;
  index: number;
  /** Sorted left-to-right; includes noise words. */
  words: PWord[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Text without noise words. */
  text: string;
}

export interface PPage {
  page: number;
  width: number;
  height: number;
  source: 'text' | 'ocr';
  lines: PLine[];
  stamps: string[];
  /** Median word height: the unit for every distance threshold on this page. */
  medH: number;
  /** Horizontal gap that separates blocks/columns on a line. */
  segGap: number;
}

export interface PDoc {
  docId: string;
  fileName: string;
  layout: DocumentLayout;
  pages: PPage[];
}

const NOISE_RE = /^[|¦~_=—–•·^`"']+$/;
/** Lone punctuation read with low confidence is usually a speck. */
const SPECK_RE = /^[.,'`]+$/;

/** Cleans OCR artefacts from a single token without changing its meaning. */
export function cleanToken(raw: string): string {
  let t = normalizePunct(raw).trim();
  // strike-through / underline artefacts and stray quotes around codes
  t = t.replace(/^[_~"]+(?=[A-Za-z0-9(])/, '').replace(/(?<=[A-Za-z0-9).])[_~]+$/, '');
  if (/^"[A-Za-z0-9]/.test(t) && !t.slice(1).includes('"')) t = t.slice(1);
  if (/[A-Za-z0-9]"$/.test(t) && !/\d"$/.test(t) && !t.slice(0, -1).includes('"')) t = t.slice(0, -1);
  return t;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Joins words into text, gluing fragments that touch (OCR sometimes splits "at" into "a t"). */
export function joinWords(words: readonly PWord[]): string {
  let out = '';
  let prev: PWord | undefined;
  for (const w of words) {
    if (!w.text) continue;
    if (prev) {
      // glyph size: the box height, but no more than three character widths (text-layer boxes of some
      // fonts are 2-3x taller than the glyphs, which would glue ordinary word spaces)
      const glyph = (x: PWord) => Math.min(x.y1 - x.y0, (3 * (x.x1 - x.x0)) / Math.max(1, x.text.length));
      const h = Math.max(1, Math.min(glyph(prev), glyph(w)));
      const gap = w.x0 - prev.x1;
      const glue = !prev.clamped && !(prev.textLayer && w.textLayer) && gap >= -1 && gap < Math.max(2.5, h * 0.1) && /[a-z]$/i.test(prev.text) && /^[a-z]/i.test(w.text);
      out += glue ? w.text : ' ' + w.text;
    } else out = w.text;
    prev = w;
  }
  return squash(out);
}

/** Splits tokens where a label is glued to its value ("Date:20-Sep-2026" → "Date:" + "20-Sep-2026"). */
function splitGlued(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const m = /^([A-Za-z][A-Za-z.#/'&-]{0,24}[:;])([A-Za-z0-9(+#$][^:;]*)$/.exec(w.text.trim());
    if (!m || /^https?:$/i.test(m[1])) {
      out.push(w);
      continue;
    }
    const total = m[1].length + m[2].length;
    const cut = w.x0 + ((w.x1 - w.x0) * m[1].length) / total;
    out.push({ ...w, text: m[1], x1: cut - 1 });
    out.push({ ...w, text: m[2], x0: cut + 1 });
  }
  return out;
}

const SHORT_TOKEN_RE = /^[A-Za-z&.]{1,2}$/;
const LETTER_RE = /^[A-Za-z]$/;

/**
 * Joins letter-spaced text ("S O U R C I N G  P T E .  LT D." from CSS letter-spacing or a logo)
 * into words. A run of short tokens counts only when it holds at least 4 consecutive single letters
 * (so "S M L XL" size lists stay as they are); inside it, words break where the gap is clearly wider
 * than the run's letter spacing.
 */
export function joinLetterSpaced(words: Word[], medH: number): Word[] {
  const out: Word[] = [];
  const merge = (ws: Word[]): Word => ({
    text: ws.map((w) => w.text.trim()).join(''),
    x0: ws[0].x0,
    y0: Math.min(...ws.map((w) => w.y0)),
    x1: ws[ws.length - 1].x1,
    y1: Math.max(...ws.map((w) => w.y1)),
    conf: Math.min(...ws.map((w) => w.conf)),
  });
  let i = 0;
  while (i < words.length) {
    if (!SHORT_TOKEN_RE.test(words[i].text.trim())) {
      out.push(words[i++]);
      continue;
    }
    // maximal run of short tokens; the letter spacing is its smallest gap
    let j = i + 1;
    let letterGap = Infinity;
    while (j < words.length && SHORT_TOKEN_RE.test(words[j].text.trim())) {
      const g = words[j].x0 - words[j - 1].x1;
      if (g < -2 || g > 2 * medH || g > 4 * Math.max(1, Math.min(letterGap, g))) break;
      letterGap = Math.min(letterGap, Math.max(1, g));
      j++;
    }
    const run = words.slice(i, j);
    const wordBreak = (k: number) => run[k].x0 - run[k - 1].x1 > Math.max(1.8 * letterGap, letterGap + 0.1 * medH);
    let singles = 0;
    let best = 0;
    run.forEach((w, k) => {
      singles = LETTER_RE.test(w.text.trim()) && (k === 0 || !wordBreak(k)) ? singles + 1 : LETTER_RE.test(w.text.trim()) ? 1 : 0;
      best = Math.max(best, singles);
    });
    if (best < 4) {
      out.push(...run);
    } else {
      let cur: Word[] = [run[0]];
      for (let k = 1; k < run.length; k++) {
        if (wordBreak(k)) {
          out.push(merge(cur));
          cur = [];
        }
        cur.push(run[k]);
      }
      out.push(merge(cur));
    }
    i = j;
  }
  return out;
}

function buildPage(pl: PageLayout): PPage {
  const heights = pl.words.map((w) => w.y1 - w.y0).filter((h) => h > 4);
  let medH = median(heights) || 28;
  // Text-layer fonts with inflated ascent/descent give boxes taller than the line pitch; every distance
  // threshold below is in units of medH, so measure it from the pitch instead (glyphs ≈ 0.7 × pitch).
  const pitch = linePitch(pl.words);
  if (pitch !== undefined && medH > pitch) medH = 0.7 * pitch;
  const lines: PLine[] = [];
  pl.lines.forEach((ln, index) => {
    const sorted = joinLetterSpaced(splitGlued([...ln.words].filter((w) => w.text && w.text.trim())).sort((a, b) => a.x0 - b.x0), medH);
    const words: PWord[] = sorted.map((w: Word) => {
      const text = cleanToken(w.text);
      return {
        text,
        raw: w.text,
        key: compactKey(text),
        x0: w.x0,
        y0: w.y0,
        x1: w.x1,
        y1: w.y1,
        conf: w.conf,
        page: pl.page,
        line: index,
        noise: !text || NOISE_RE.test(text) || (SPECK_RE.test(text) && w.conf < 60),
        ...(pl.source === 'text' ? { textLayer: true } : {}),
      };
    });
    // Tesseract sometimes gives the first word of a phrase the whole phrase's box: clamp.
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i];
      const b = words[i + 1];
      if (a.x1 > b.x0 && b.x0 > a.x0) {
        a.x1 = Math.max(a.x0 + 1, b.x0 - 1);
        a.clamped = true;
      }
    }
    if (!words.length) return;
    const real = words.filter((w) => !w.noise);
    lines.push({
      page: pl.page,
      index: lines.length,
      words,
      x0: Math.min(...words.map((w) => w.x0)),
      y0: Math.min(...words.map((w) => w.y0)),
      x1: Math.max(...words.map((w) => w.x1)),
      y1: Math.max(...words.map((w) => w.y1)),
      text: joinWords(real),
    });
  });
  lines.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  lines.forEach((l, i) => {
    l.index = i;
    for (const w of l.words) w.line = i;
  });
  return {
    page: pl.page,
    width: pl.width,
    height: pl.height,
    source: pl.source,
    lines,
    stamps: pl.stamps ?? [],
    medH,
    segGap: Math.max(3 * medH, 75),
  };
}

/** Builds the page model for a whole document. */
export function prepareLayout(layout: DocumentLayout): PDoc {
  return {
    docId: layout.docId,
    fileName: layout.fileName,
    layout,
    pages: layout.pages.map(buildPage),
  };
}

/** Non-noise words of a line. */
export const realWords = (l: PLine): PWord[] => l.words.filter((w) => !w.noise);

/** Splits a line into horizontal blocks separated by gaps wider than `gap`. */
export function segmentsOf(line: PLine, gap: number): PWord[][] {
  const out: PWord[][] = [];
  let cur: PWord[] = [];
  let lastX1 = -Infinity;
  for (const w of realWords(line)) {
    if (cur.length && w.x0 - lastX1 > gap) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
    lastX1 = Math.max(lastX1 === -Infinity ? w.x1 : lastX1, w.x1);
  }
  if (cur.length) out.push(cur);
  return out;
}

export const minConf = (ws: readonly PWord[]): number => (ws.length ? Math.min(...ws.map((w) => w.conf)) : 0);
export const meanConf = (ws: readonly PWord[]): number => (ws.length ? ws.reduce((s, w) => s + w.conf, 0) / ws.length : 0);

export function bboxOf(ws: readonly PWord[]): [number, number, number, number] {
  return [
    Math.round(Math.min(...ws.map((w) => w.x0))),
    Math.round(Math.min(...ws.map((w) => w.y0))),
    Math.round(Math.max(...ws.map((w) => w.x1))),
    Math.round(Math.max(...ws.map((w) => w.y1))),
  ];
}

export const xCenter = (w: { x0: number; x1: number }): number => (w.x0 + w.x1) / 2;
export const yCenter = (w: { y0: number; y1: number }): number => (w.y0 + w.y1) / 2;

/** All text of a page (one line per visual line) — used for regex scans and classification. */
export function pageText(p: PPage): string {
  return p.lines.map((l) => l.text).join('\n');
}

/** All text of the document, pages separated by blank lines. */
export function docText(d: PDoc): string {
  return d.pages.map(pageText).join('\n\n');
}
