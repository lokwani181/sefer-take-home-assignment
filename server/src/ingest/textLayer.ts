/**
 * PDF text layer → word boxes via `pdftotext -bbox-layout` (poppler's XHTML word boxes).
 */
import type { Word } from '@app/shared';
import { runTool, type ToolPaths } from './tools.js';

/** Layout coordinates are 300 DPI pixels; PDF user space is 72 points per inch. */
export const DPI = 300;
export const PT_TO_PX = DPI / 72;

/** A page "has a text layer" when it carries at least this many non-space characters. */
export const MIN_TEXT_CHARS = 50;

export interface TextLayerPage {
  /** 1-based page number */
  page: number;
  width: number;
  height: number;
  words: Word[];
  /** Non-space characters on the page. */
  chars: number;
  /** Characters that indicate a broken font encoding (U+FFFD, controls, private use). */
  junkChars: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/** One decimal, rounding the exact binary value like Python round() (fixture compatibility). */
const r1 = (v: number) => Number(v.toFixed(1));
// Replacement char, C0/C1 controls (minus whitespace) and the BMP private-use area.
const JUNK_RE = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/gu;

/**
 * Parse the XHTML written by `pdftotext -bbox-layout` into pages of words in 300 DPI pixels.
 * Regex-based on purpose: the format is machine-generated and flat, and this avoids a DOM dependency.
 */
export function parseBboxLayout(xhtml: string): TextLayerPage[] {
  const pages: TextLayerPage[] = [];
  const pageRe = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"\s*>([\s\S]*?)<\/page>/g;
  const wordRe = /<word\s+xMin="(-?[\d.]+)"\s+yMin="(-?[\d.]+)"\s+xMax="(-?[\d.]+)"\s+yMax="(-?[\d.]+)"\s*>([\s\S]*?)<\/word>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pageRe.exec(xhtml))) {
    const words: Word[] = [];
    let chars = 0;
    let junkChars = 0;
    let wm: RegExpExecArray | null;
    wordRe.lastIndex = 0;
    while ((wm = wordRe.exec(pm[3]))) {
      const text = decodeEntities(wm[5]).trim();
      if (!text) continue;
      const nonSpace = text.replace(/\s+/g, '');
      chars += nonSpace.length;
      junkChars += nonSpace.match(JUNK_RE)?.length ?? 0;
      words.push({
        text,
        x0: r1(Number(wm[1]) * PT_TO_PX),
        y0: r1(Number(wm[2]) * PT_TO_PX),
        x1: r1(Number(wm[3]) * PT_TO_PX),
        y1: r1(Number(wm[4]) * PT_TO_PX),
        conf: 100,
      });
    }
    pages.push({
      page: pages.length + 1,
      width: Math.round(Number(pm[1]) * PT_TO_PX),
      height: Math.round(Number(pm[2]) * PT_TO_PX),
      words,
      chars,
      junkChars,
    });
  }
  return pages;
}

/**
 * Decide per page whether the text layer is usable: enough characters, and not mostly garbage
 * from a font without a Unicode mapping (in which case OCR is the better source).
 */
export function hasUsableTextLayer(page: TextLayerPage): boolean {
  return page.chars - page.junkChars >= MIN_TEXT_CHARS && page.junkChars <= 0.1 * page.chars;
}

/** Run pdftotext on a PDF file and return every page (also tells us the page count and sizes). */
export async function readTextLayer(paths: ToolPaths, pdfPath: string): Promise<TextLayerPage[]> {
  const { stdout } = await runTool(paths, 'pdftotext', ['-bbox-layout', '-enc', 'UTF-8', pdfPath, '-']);
  return parseBboxLayout(stdout.toString('utf8'));
}
