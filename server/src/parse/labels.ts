/**
 * Label → value primitive for form-style documents.
 *
 * Why: invoices, packing lists and transport documents are grids of labelled fields.
 * A value is either to the right of its label on the same line ("Invoice No.: 123") or
 * below it inside the label's column box (B/L style boxes). Both are handled with the
 * same synonym-driven matcher, so new wording only needs a vocab entry.
 */
import { LABELS, WEAK_LABEL_WORDS, type LabelField } from './vocab';
import { bboxOf, joinWords, minConf, realWords, segmentsOf, xCenter, type PDoc, type PLine, type PPage, type PWord } from './layout';
import { compactKey, levenshtein } from './text';

export interface LabelHit {
  field: LabelField;
  synonym: string;
  page: number;
  /** Line index of the first label word. */
  line: number;
  words: PWord[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Ends with ':' (or ';' misread). */
  colon: boolean;
  /** First word of its line or preceded by a clear gap. */
  segStart: boolean;
  /** Plausibly a real label (not a word inside prose). */
  credible: boolean;
  /** Matched with OCR tolerance. */
  fuzzy: boolean;
  /** x0 of a field number printed before the label ("(11) Ocean vessel"), which is where the box starts. */
  numX0?: number;
}

export interface LabelValue {
  hit: LabelHit;
  /** All value text joined with single spaces (lines joined with spaces). */
  text: string;
  /** Value text per visual line. */
  lines: string[];
  lineWords: PWord[][];
  words: PWord[];
  page: number;
  /** Minimum word confidence of the value words (0–100). */
  conf: number;
  bbox: [number, number, number, number];
  mode: 'right' | 'below';
}

export interface FindLabelOptions {
  /** 'auto' (default): right when present, else below. 'block': inline value + lines below (parties, notes).
   *  'belowFirst': boxed forms (B/L, AWB) — the line below, unless the label has a colon and an inline value. */
  mode?: 'auto' | 'right' | 'below' | 'block' | 'belowFirst';
  /** Max lines taken below the label (default 1, or 8 in block mode). */
  maxLines?: number;
  /** Reject a candidate value (the next hit is tried). */
  validate?: (text: string, v: LabelValue) => boolean;
  /** Only consider these pages (1-based). */
  pages?: number[];
  /** Include non-credible hits (label words inside prose). Default false. */
  includeWeak?: boolean;
  /** Ignore labels inside these regions (e.g. item-table bodies). */
  exclude?: Region[];
  /** Below-values end at the next label (default true). Off for free-text blocks (marks, remarks). */
  stopAtLabels?: boolean;
}

/** A vertical band of a page. */
export interface Region {
  page: number;
  y0: number;
  y1: number;
}

interface SynEntry {
  field: LabelField;
  synonym: string;
  key: string;
  fuzzy: boolean;
}

const SYN_INDEX = new Map<string, SynEntry[]>();
const LONG_SYNS: SynEntry[] = [];
/** Proper prefixes of multi-word synonyms, to continue a label stacked over two lines ("Chargeable / Weight"). */
const SYN_PREFIXES = new Set<string>();
let MAX_KEY = 0;

function addSyn(e: SynEntry) {
  const list = SYN_INDEX.get(e.key) ?? [];
  if (!list.some((x) => x.field === e.field)) list.push(e);
  SYN_INDEX.set(e.key, list);
  MAX_KEY = Math.max(MAX_KEY, e.key.length);
  const words = e.synonym.split(/\s+/);
  for (let i = 1; i < words.length; i++) SYN_PREFIXES.add(compactKey(words.slice(0, i).join(' ')));
}

for (const [field, syns] of Object.entries(LABELS) as Array<[LabelField, readonly string[]]>) {
  for (const synonym of syns) {
    const key = compactKey(synonym);
    if (!key) continue;
    addSyn({ field, synonym, key, fuzzy: false });
    if (key.length >= 8 && !key.includes('#')) LONG_SYNS.push({ field, synonym, key, fuzzy: true });
    // OCR reads "/" as I, l, 1 or J ("BiL No." for "B/L No.").
    if (synonym.includes('/')) {
      const parts = synonym.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        for (const sub of ['I', 'L', '1', 'J']) {
          const variant = compactKey(parts.slice(0, i + 1).join('/') + sub + parts.slice(i + 1).join('/'));
          addSyn({ field, synonym, key: variant, fuzzy: true });
        }
      }
    }
  }
}

/**
 * A box number printed before a form label: "(11)", "12.", "7)", or an enclosed number as used on
 * Korean / Japanese / Chinese trade forms (①–⑳, ⑴–⒇, ⒈–⒛, ❶–➓, ㉑–㊿, ⓫–⓾).
 */
export const FIELD_NUMBER_RE = /^(?:\(?\d{1,2}[).]|\(\d{1,2}\)|[\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u3251-\u325F\u32B1-\u32BF])$/u;
/** Enclosed box numbers (①, ⑴, ❶ …) never occur inside a value: one always starts the next box. */
export const ENCLOSED_NUMBER_RE = /^[\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u3251-\u325F\u32B1-\u32BF]$/u;

const hitCache = new WeakMap<PDoc, LabelHit[]>();

/** The word directly below (stacked header text), if it starts within the word's horizontal span. */
function wordBelow(page: PPage, w: PWord): PWord | undefined {
  const h = w.y1 - w.y0;
  for (let li = w.line + 1; li < page.lines.length && li <= w.line + 2; li++) {
    for (const c of realWords(page.lines[li])) {
      const gap = c.y0 - w.y1;
      if (gap < -0.3 * h || gap > 0.7 * h) continue;
      if (Math.abs(c.x0 - w.x0) <= 0.6 * h) return c;
    }
  }
  return undefined;
}

/** Next word to the right, allowing a label to continue on an adjacent visual line (OCR line splits). */
function nextWord(page: PPage, w: PWord, sameLineNext: PWord | undefined): PWord | undefined {
  if (sameLineNext && sameLineNext.x0 - w.x1 < 2 * page.medH) return sameLineNext;
  const h = w.y1 - w.y0;
  let best: PWord | undefined;
  for (const li of [w.line - 1, w.line + 1]) {
    const line = page.lines[li];
    if (!line) continue;
    for (const c of realWords(line)) {
      const gap = c.x0 - w.x1;
      if (gap < -3 || gap > 1.5 * page.medH) continue;
      const ov = Math.min(c.y1, w.y1) - Math.max(c.y0, w.y0);
      if (ov < 0.5 * Math.min(h, c.y1 - c.y0)) continue;
      if (!best || c.x0 < best.x0) best = c;
    }
  }
  return best ?? sameLineNext;
}

function endsWithColon(w: PWord): boolean {
  return /[:;]$/.test(w.raw.trim()) || /[:;]$/.test(w.text);
}

/** Finds every label occurrence in the document (cached per document). */
export function findLabels(doc: PDoc): LabelHit[] {
  const cached = hitCache.get(doc);
  if (cached) return cached;
  const hits: LabelHit[] = [];
  for (const page of doc.pages) {
    const used = new Set<PWord>();
    for (const line of page.lines) {
      const words = realWords(line);
      let i = 0;
      while (i < words.length) {
        const start = words[i];
        if (!start.key || used.has(start)) {
          i++;
          continue;
        }
        let acc = '';
        let best: { entries: SynEntry[]; chain: PWord[] } | undefined;
        const chain: PWord[] = [];
        let cur: PWord | undefined = start;
        let idx = i;
        while (cur && chain.length < 10) {
          chain.push(cur);
          acc += cur.key;
          if (acc.length > MAX_KEY + 1) break;
          const exact = SYN_INDEX.get(acc);
          if (exact) best = { entries: exact, chain: [...chain] };
          else if (acc.length >= 8 && Math.min(...chain.map((w) => w.conf)) < 90) {
            // OCR tolerance only for OCR text: a clean text layer must match exactly
            // substitution-only: a missing trailing token ("NO", "#") must not be forgiven
            const fz = LONG_SYNS.filter((s) => s.key.length === acc.length && levenshtein(s.key, acc) <= 1);
            if (fz.length) best = { entries: fz, chain: [...chain] };
          }
          if (endsWithColon(cur)) break;
          const sameNext: PWord | undefined = cur.line === line.index ? words[idx + 1] : undefined;
          let nxt = nextWord(page, cur, sameNext);
          // a label stacked over two lines: continue below when the text so far is a known label prefix
          if (SYN_PREFIXES.has(acc) && (!nxt || (!SYN_PREFIXES.has(acc + nxt.key) && !SYN_INDEX.has(acc + nxt.key)))) {
            const below = wordBelow(page, cur);
            if (below && (SYN_INDEX.has(acc + below.key) || SYN_PREFIXES.has(acc + below.key))) nxt = below;
          }
          if (cur.line === line.index) idx++;
          cur = nxt;
        }
        if (!best) {
          i++;
          continue;
        }
        const lw = best.chain;
        // separators picked up at the end of the chain ("Inv # /") belong to what follows
        while (lw.length > 1 && !lw[lw.length - 1].key) lw.pop();
        const last = lw[lw.length - 1];
        const prev = words[i - 1];
        // a table rule between the previous word and the label, or a bilingual "Datum / Date" label, also starts a cell
        const ruleBefore = line.words.some((w) => w.noise && /[|¦]/.test(w.text) && w.x0 >= (prev?.x1 ?? -1) - 2 && w.x1 <= start.x0 + 2);
        const slashBefore = !!prev && prev.text === '/' && start.x0 - prev.x1 < 1.2 * page.medH;
        // numbered form fields: "(11) Ocean vessel / Voy.", "12. Port of loading", "⑧ Invoice No. & Date"
        const prevPrev = words[i - 2];
        const numbered = !!prev && FIELD_NUMBER_RE.test(prev.text) && (!prevPrev || prev.x0 - prevPrev.x1 > 1.2 * page.medH);
        const segStart = !prev || start.x0 - prev.x1 > 1.2 * page.medH || ruleBefore || slashBefore || numbered;
        const colon = endsWithColon(last) || (() => {
          const after = words.find((w) => w.x0 >= last.x1 - 1 && w !== last && w.line === last.line);
          return !!after && /^[:;]$/.test(after.raw.trim());
        })();
        for (const w of lw) used.add(w);
        // bilingual tail: "Inv # / Rechnungs-Nr.   RW-26-10387" — look past "/ <alt label>"
        let after = words.filter((w) => w.x0 > last.x1 - 1 && !lw.includes(w));
        if (after[0]?.text === '/') {
          let j = 1;
          while (j < after.length && !/\d/.test(after[j].text) && after[j].x0 - after[j - 1].x1 < 1.2 * page.medH && j <= 4) j++;
          if (j > 1 && (j >= after.length || after[j].x0 - after[j - 1].x1 >= 1.2 * page.medH)) after = after.slice(j);
        }
        for (const e of best.entries) {
          const weak = e.key.length <= 4 || WEAK_LABEL_WORDS.has(e.key);
          const following = after[0];
          const prevOfFollowing = following ? words[words.indexOf(following) - 1] ?? last : last;
          const isolated = !following || following.x0 - Math.max(last.x1, prevOfFollowing.x1) > 1.5 * page.medH || /^\(/.test(following.text);
          // "AWB 020-12345675", "PO 4500123": a short label directly followed by a code-like value
          const codeAfter = !!following && /\d/.test(following.text) && /[A-Z]/.test(start.text);
          const credible = colon || (segStart && (!weak || isolated || codeAfter));
          hits.push({
            field: e.field,
            synonym: e.synonym,
            page: page.page,
            line: line.index,
            words: lw,
            x0: Math.min(...lw.map((w) => w.x0)),
            y0: Math.min(...lw.map((w) => w.y0)),
            x1: Math.max(...lw.map((w) => w.x1)),
            y1: Math.max(...lw.map((w) => w.y1)),
            colon,
            segStart,
            credible,
            fuzzy: e.fuzzy,
            ...(numbered ? { numX0: prev.x0 } : {}),
          });
        }
        // continue after the label words that are on this line
        const lastOnLine = lw.filter((w) => w.line === line.index).pop() ?? start;
        i = Math.max(i + 1, words.indexOf(lastOnLine) + 1);
      }
    }
  }
  hitCache.set(doc, hits);
  return hits;
}

/** Credible hits for one or more fields, in reading order (page, then top-to-bottom, left-to-right). */
export function labelHits(
  doc: PDoc,
  field: LabelField | readonly LabelField[],
  opts: { includeWeak?: boolean; pages?: number[]; exclude?: Region[] } = {},
): LabelHit[] {
  const fields = new Set(Array.isArray(field) ? field : [field as LabelField]);
  const inExcluded = (h: LabelHit) => (opts.exclude ?? []).some((r) => r.page === h.page && (h.y0 + h.y1) / 2 >= r.y0 && (h.y0 + h.y1) / 2 <= r.y1);
  return findLabels(doc)
    .filter((h) => fields.has(h.field) && (opts.includeWeak || h.credible) && (!opts.pages || opts.pages.includes(h.page)) && !inExcluded(h))
    .sort((a, b) => a.page - b.page || a.line - b.line || a.x0 - b.x0);
}

/** Credible label hits on the same visual line (any field), left to right. */
function hitsOnLine(doc: PDoc, page: number, line: number): LabelHit[] {
  const seen = new Set<string>();
  return findLabels(doc)
    .filter((h) => h.page === page && h.line === line && h.credible)
    .filter((h) => {
      const k = `${h.x0}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.x0 - b.x0);
}

function makeValue(hit: LabelHit, lineWords: PWord[][], mode: 'right' | 'below'): LabelValue | null {
  const lw = lineWords.filter((l) => l.length);
  const words = lw.flat();
  if (!words.length) return null;
  const lines = lw.map((l) => joinWords(l));
  return { hit, text: lines.join(' '), lines, lineWords: lw, words, page: hit.page, conf: minConf(words), bbox: bboxOf(words), mode };
}

/** Value on the same line, to the right of the label, up to the next label. */
export function valueRight(doc: PDoc, hit: LabelHit): LabelValue | null {
  const page = doc.pages.find((p) => p.page === hit.page)!;
  const last = hit.words[hit.words.length - 1];
  const line = page.lines[last.line];
  const words = realWords(line).filter((w) => w.x0 >= last.x1 - 2 && !hit.words.includes(w));
  const others = hitsOnLine(doc, hit.page, last.line).filter((h) => h.x0 > last.x1 - 2 && h.words[0] !== hit.words[0]);
  const boxNo = words.find((w) => ENCLOSED_NUMBER_RE.test(w.text));
  const stopX = Math.min(others.length ? Math.min(others[0].x0, others[0].numX0 ?? Infinity) : Infinity, boxNo?.x0 ?? Infinity);
  const out: PWord[] = [];
  let i = 0;
  // skip separators and a parenthesised qualifier that belongs to the label: "Destination (for merchant ref.)"
  while (i < words.length && /^[:;#.\-–]$/.test(words[i].text)) i++;
  // bilingual label: "Inv # / Rechnungs-Nr.   RW-26-10387" — skip "/ <other-language label>" up to a clear gap
  if (words[i]?.text === '/') {
    let j = i + 1;
    while (j < words.length && !/\d/.test(words[j].text) && words[j].x0 - words[j - 1].x1 < 1.2 * page.medH && j - i <= 4) j++;
    if (j > i + 1 && j < words.length && words[j].x0 - words[j - 1].x1 >= 1.2 * page.medH) i = j;
  }
  if (!hit.colon && words[i] && /^\(/.test(words[i].text) && !/\d/.test(words[i].text)) {
    while (i < words.length && !/\)$/.test(words[i].text)) i++;
    i++;
  }
  let prevX1 = last.x1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w.x0 >= stopX - 2) break;
    if (out.length && w.x0 - prevX1 > Math.max(4 * page.medH, 110)) break;
    if (out.length && /[A-Za-z][:;]$/.test(w.text)) {
      // a new inline label ("NB-26-0918 Factory Order: ...") — drop its leading words
      let next = w;
      while (out.length && /^[A-Za-z.'/&]+$/.test(out[out.length - 1].text) && next.x0 - out[out.length - 1].x1 < 2 * page.medH) next = out.pop()!;
      break;
    }
    out.push(w);
    prevX1 = w.x1;
  }
  return makeValue(hit, [out], 'right');
}

/**
 * True when a segment has a gap at x (between the last word left of x and the first word right of it)
 * that is clearly wider than its usual word spacing: two columns that sit close together.
 */
function gapAt(sg: PWord[], x: number): boolean {
  const k = sg.findIndex((w) => xCenter(w) >= x);
  if (k <= 0) return false;
  if (sg[k - 1].x1 > x + 2) return false;
  const gap = sg[k].x0 - sg[k - 1].x1;
  const gaps = sg.slice(1).map((w, i) => w.x0 - sg[i].x1).filter((g) => g > 0).sort((a, b) => a - b);
  const typical = gaps[gaps.length >> 1] ?? 0;
  return gap > Math.max(2 * typical, 4);
}

/**
 * Lines below the label within its column box. In block mode only the left-aligned
 * segment of each line is kept, which drops stamp fragments and neighbouring columns.
 */
export function valueBelow(
  doc: PDoc,
  hit: LabelHit,
  maxLines: number,
  block = false,
  stopAtLabels = true,
  boundAfterX?: number,
  exclude: Region[] = [],
): LabelValue | null {
  const page = doc.pages.find((p) => p.page === hit.page)!;
  const H = page.medH;
  const labelLines = [...new Set(hit.words.map((w) => w.line))];
  const firstLine = Math.min(...labelLines);
  const lastLine = Math.max(...labelLines);
  const lineHitsAll = labelLines.flatMap((li) => hitsOnLine(doc, hit.page, li)).sort((a, b) => a.x0 - b.x0);
  // "OCEAN CARRIER / MASTER B/L NO.": labels joined by a slash share one box (values stacked below)
  const joined = (a: LabelHit, b: LabelHit) => {
    const lw = page.lines[a.words[a.words.length - 1].line];
    return realWords(lw).some((w) => w.text === '/' && w.x0 >= a.x1 - 2 && w.x1 <= b.x0 + 2) && b.x0 - a.x1 < 3 * H;
  };
  let first = hit;
  for (;;) {
    const left = lineHitsAll.filter((h) => h.x1 <= first.x0 + 2 && h !== first).pop();
    if (left && joined(left, first)) first = left;
    else break;
  }
  let lastJoined = hit;
  for (;;) {
    const right = lineHitsAll.find((h) => h.x0 >= lastJoined.x1 - 2 && h !== lastJoined && h.words[0] !== lastJoined.words[0]);
    if (right && joined(lastJoined, right)) lastJoined = right;
    else break;
  }
  const nextLabel = lineHitsAll.filter((h) => h.x0 > lastJoined.x1 + H * 0.5).sort((a, b) => a.x0 - b.x0)[0];
  let boxX1 = nextLabel ? Math.min(nextLabel.x0, nextLabel.numX0 ?? Infinity) - 4 : page.width;
  // an enclosed box number to the right starts the next box even when its label is not a known one
  const nextBoxNo = labelLines.flatMap((li) => realWords(page.lines[li])).filter((w) => ENCLOSED_NUMBER_RE.test(w.text) && w.x0 > lastJoined.x1 + H * 0.5);
  if (nextBoxNo.length) boxX1 = Math.min(boxX1, Math.min(...nextBoxNo.map((w) => w.x0)) - 4);
  // a solid text segment to the right on the label line (e.g. a title, a signature block) also bounds the box;
  // for blocks only beyond an inline value, because label qualifiers ("(complete name and address)") follow the label
  if (!block || boundAfterX !== undefined) {
    const after = boundAfterX ?? hit.x1;
    for (const seg of segmentsOf(page.lines[firstLine], page.segGap)) {
      if (seg[0].x0 <= after || seg.some((w) => hit.words.includes(w))) continue;
      if (seg.length >= 2 && seg.reduce((s, w) => s + w.conf, 0) / seg.length >= 70) boxX1 = Math.min(boxX1, seg[0].x0 - 4);
      break;
    }
  }
  const boxX0 = Math.min(first.x0, first.numX0 ?? Infinity) - 1.5 * H;
  if (block && nextLabel && boxX1 < page.width) {
    // an in-box sub-label ("Shipper's Account Number: ...") is not a column edge when the lines below run across it
    // with ordinary word spacing; a gap at the edge clearly wider than the line's word spacing is the column gap
    const crossing = page.lines
      .slice(lastLine + 1, lastLine + 4)
      .flatMap((l) => segmentsOf(l, page.segGap))
      .some((sg) => sg[0].x0 < boxX1 - 2 * H && sg[0].x0 >= boxX0 && Math.max(...sg.map((w) => w.x1)) > boxX1 + 2 * H && !gapAt(sg, boxX1));
    if (crossing) {
      const further = lineHitsAll.filter((h) => h.x0 > boxX1 + 4 * H)[0];
      boxX1 = further ? Math.min(further.x0, further.numX0 ?? Infinity) - 4 : page.width;
    }
  }
  const width = boxX1 - boxX0;
  const out: PWord[][] = [];
  let lastY1 = hit.y1;
  const minYc = (hit.y0 + hit.y1) / 2 + 0.5 * H;
  // a value never runs into an excluded region below it (e.g. a remarks box above the item table)
  const stopY = Math.min(...exclude.filter((r) => r.page === hit.page && r.y0 > hit.y1 - 1).map((r) => r.y0));
  for (let li = lastLine + 1; li < page.lines.length && out.length < maxLines; li++) {
    const line = page.lines[li];
    if ((line.y0 + line.y1) / 2 >= stopY) break;
    let inBox = realWords(line).filter(
      (w) =>
        !hit.words.includes(w) &&
        (w.y0 + w.y1) / 2 > minYc &&
        ((xCenter(w) >= boxX0 && xCenter(w) < boxX1) ||
          // right-aligned value directly under a right-aligned label
          (!out.length && !block && Math.min(w.x1, hit.x1) - Math.max(w.x0, hit.x0) > 0.3 * (w.x1 - w.x0))),
    );
    if (!inBox.length) {
      if (line.y0 - lastY1 > (out.length ? 2.4 : 4) * H) break;
      continue;
    }
    const top = Math.min(...inBox.map((w) => w.y0));
    const gapLimit = (out.length ? 2.4 : 4) * H;
    if (top - lastY1 > gapLimit) break;
    // another label at the left of the box ends the value
    const lineHits = stopAtLabels ? hitsOnLine(doc, hit.page, li).filter((h) => xCenter(h) >= boxX0 && xCenter(h) < boxX1) : [];
    if (lineHits.some((h) => h.x0 < boxX0 + Math.max(0.35 * width, 6 * H) && (h.colon || h.segStart))) {
      const first = lineHits[0];
      // a numbered label ("② For Account of", "(3) Notify") starts at its box number
      if (Math.min(first.x0, first.numX0 ?? Infinity) <= inBox[0].x0 + 2 || first.colon) break;
    }
    if (block || inBox.length > 1) {
      // keep the left-aligned block; a later segment only when it is close (two columns inside one box)
      const lineSeg = { ...line, words: inBox } as PLine;
      const segs = segmentsOf(lineSeg, page.segGap).filter((sg) => sg.some((w) => w.conf >= 40));
      const start = segs.findIndex((sg) => sg[0].x0 <= boxX0 + Math.max(0.35 * width, 4 * H));
      if (start < 0) continue;
      const kept = [segs[start]];
      for (let k = start + 1; k < segs.length; k++) {
        const prev = kept[kept.length - 1];
        if (segs[k][0].x0 - prev[prev.length - 1].x1 > Math.max(page.segGap, 0.12 * page.width)) break;
        kept.push(segs[k]);
      }
      inBox = kept.flat();
    }
    // skip junk-only lines (stamp fragments, specks)
    const alnum = inBox.map((w) => w.text).join('').replace(/[^A-Za-z0-9]/g, '').length;
    if (alnum < 2 || inBox.every((w) => w.conf < 40)) continue;
    out.push(inBox);
    lastY1 = Math.max(...inBox.map((w) => w.y1));
  }
  return makeValue(hit, out, 'below');
}

/**
 * A same-line value only counts when the label is clearly terminated (colon or a gap),
 * or the value is code-like; otherwise the words are more likely the label's own
 * continuation ("Pre-carriage by", "Notify Party (complete name ...)").
 */
function rightIsValue(doc: PDoc, hit: LabelHit, v: LabelValue | null, allowDigits: boolean): boolean {
  if (!v || !/[A-Za-z0-9]/.test(v.text)) return false;
  if (hit.colon) return true;
  const page = doc.pages.find((p) => p.page === hit.page)!;
  const gap = v.words[0].x0 - hit.x1;
  // far to the right without a colon: more likely the next column's header than this label's value
  if (gap > 0.2 * page.width && !/\d/.test(v.text)) return false;
  if (gap > 1.5 * page.medH) return true;
  return allowDigits && /\d/.test(v.words[0].text);
}

/** Value of one label occurrence according to the mode. */
export function valueFor(doc: PDoc, hit: LabelHit, opts: FindLabelOptions = {}): LabelValue | null {
  const mode = opts.mode ?? 'auto';
  if (mode === 'right') return valueRight(doc, hit);
  const stop = opts.stopAtLabels ?? true;
  const ex = opts.exclude ?? [];
  if (mode === 'below') return valueBelow(doc, hit, opts.maxLines ?? 1, false, stop, undefined, ex);
  if (mode === 'block') {
    const right = valueRight(doc, hit);
    const inline = rightIsValue(doc, hit, right, false);
    const below = valueBelow(doc, hit, opts.maxLines ?? 8, true, stop, inline ? Math.max(...right!.words.map((w) => w.x1)) : undefined, ex);
    if (!inline) return below;
    if (!below) return right;
    return makeValue(hit, [...right!.lineWords, ...below.lineWords], 'below');
  }
  if (mode === 'belowFirst') {
    const right = valueRight(doc, hit);
    if (hit.colon && right && /[A-Za-z0-9]/.test(right.text)) return right;
    return valueBelow(doc, hit, opts.maxLines ?? 1, false, stop, undefined, ex) ?? (right && rightIsValue(doc, hit, right, true) ? right : null);
  }
  const right = valueRight(doc, hit);
  // a row of column headers ("P.O. NO.  TERMS  SHIP VIA  PORT OF DISCHARGE"): values are below
  const labelRow = !hit.colon && hitsOnLine(doc, hit.page, hit.line).length >= 3;
  if (!labelRow && rightIsValue(doc, hit, right, true)) return right;
  const below = valueBelow(doc, hit, opts.maxLines ?? 1, false, stop, undefined, ex);
  if (below) return below;
  return right && /[A-Za-z0-9]/.test(right.text) ? right : null;
}

/**
 * Finds the value of the first credible label for `field` (synonyms from vocab.ts).
 * Candidates are tried in reading order until one passes `validate`.
 */
export function findLabelValue(doc: PDoc, field: LabelField | readonly LabelField[], opts: FindLabelOptions = {}): LabelValue | null {
  return findLabelValues(doc, field, { ...opts }, 1)[0] ?? null;
}

/** All values for a field in reading order (one per label occurrence). */
export function findLabelValues(doc: PDoc, field: LabelField | readonly LabelField[], opts: FindLabelOptions = {}, limit = Infinity): LabelValue[] {
  const out: LabelValue[] = [];
  const hits = labelHits(doc, field, { includeWeak: opts.includeWeak, pages: opts.pages, exclude: opts.exclude });
  // prefer labels with a colon or at the start of a block over the rest, keep reading order otherwise
  const ordered = [...hits.filter((h) => h.colon || h.segStart), ...hits.filter((h) => !(h.colon || h.segStart))];
  for (const hit of ordered) {
    let v = valueFor(doc, hit, opts);
    if (!v || !v.text) continue;
    if (opts.validate && !opts.validate(v.text, v)) {
      // auto mode chose the text to the right (often the next box: "Sailing on or about   TEL +82 …");
      // the value may still be below the label
      const below =
        (opts.mode ?? 'auto') === 'auto' && v.mode === 'right'
          ? valueBelow(doc, hit, opts.maxLines ?? 1, false, opts.stopAtLabels ?? true, undefined, opts.exclude ?? [])
          : null;
      if (!below?.text || !opts.validate(below.text, below)) continue;
      v = below;
    }
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}
