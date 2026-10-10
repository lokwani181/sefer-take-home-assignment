/**
 * Test helper: builds a DocumentLayout from ASCII "page art" on a monospace grid.
 *
 *   layoutFromText(`
 *     COMMERCIAL INVOICE
 *     Invoice No.: A-1        Date: 03/04/2026
 *   `)
 *
 * Every non-space run is a word at x = MARGIN + col × CHAR_W, y = MARGIN + row × LINE_H.
 * One space between words is normal word spacing; several spaces make a column gap.
 * Pages are separated by a line containing only "\f" or "=== PAGE ===".
 * `conf` overrides per word text (e.g. { '14,60': 74 }) simulate OCR confidence.
 */
import type { DocumentLayout, Line, PageLayout, Word } from '@app/shared';

export const CHAR_W = 25;
export const LINE_H = 60;
export const WORD_H = 30;
const MARGIN = 100;

export interface TextLayoutOptions {
  docId?: string;
  fileName?: string;
  source?: 'text' | 'ocr';
  conf?: Record<string, number>;
  stamps?: string[];
}

function dedent(s: string): string[] {
  const lines = s.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent));
}

function buildPage(rows: string[], page: number, opts: TextLayoutOptions): PageLayout {
  const words: Word[] = [];
  const lines: Line[] = [];
  rows.forEach((row, r) => {
    const lw: Word[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(row))) {
      const x0 = MARGIN + m.index * CHAR_W;
      const y0 = MARGIN + r * LINE_H;
      const w: Word = { text: m[0], x0, y0, x1: x0 + m[0].length * CHAR_W, y1: y0 + WORD_H, conf: opts.conf?.[m[0]] ?? (opts.source === 'ocr' ? 95 : 100) };
      lw.push(w);
      words.push(w);
    }
    if (lw.length) {
      lines.push({
        text: lw.map((w) => w.text).join(' '),
        words: lw,
        x0: lw[0].x0,
        y0: lw[0].y0,
        x1: lw[lw.length - 1].x1,
        y1: lw[0].y1,
      });
    }
  });
  const width = Math.max(2480, ...words.map((w) => w.x1 + MARGIN));
  const out: PageLayout = { page, width, height: Math.max(3508, MARGIN * 2 + rows.length * LINE_H), source: opts.source ?? 'text', skewDeg: 0, words, lines };
  if (opts.stamps && page === 1) out.stamps = opts.stamps;
  return out;
}

/** Builds a layout from page art (see module doc). */
export function layoutFromText(text: string, opts: TextLayoutOptions = {}): DocumentLayout {
  const all = dedent(text);
  const pages: string[][] = [[]];
  for (const l of all) {
    if (l.trim() === '\f' || l.trim() === '=== PAGE ===') pages.push([]);
    else pages[pages.length - 1].push(l);
  }
  return {
    docId: opts.docId ?? 'test-doc',
    fileName: opts.fileName ?? 'test.pdf',
    sha256: '0'.repeat(64),
    mime: 'application/pdf',
    pages: pages.map((rows, i) => buildPage(rows, i + 1, opts)),
  };
}
