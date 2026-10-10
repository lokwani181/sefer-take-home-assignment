/**
 * Tesseract CLI wrapper: image file → TSV → word boxes (level-5 rows).
 */
import type { Word } from '@app/shared';
import { runTool, type ToolPaths } from './tools.js';

/** A word plus tesseract's own block/paragraph/line ids (used for skew estimation and stamp lines). */
export interface OcrWord extends Word {
  lineKey: string;
}

export interface OcrResult {
  width: number;
  height: number;
  words: OcrWord[];
}

export interface TesseractOptions {
  /** Page segmentation mode. 11 = sparse text: finds isolated table cells that block modes drop. */
  psm: number;
  lang: string;
  /** Resolution hint; without it tesseract guesses from glyph sizes. */
  dpi?: number;
  /** Extra `-c name=value` settings. */
  config?: Record<string, string>;
}

export const DEFAULT_TESSERACT: TesseractOptions = { psm: 11, lang: 'eng' };

/**
 * Parse tesseract TSV output. Keeps level-5 (word) rows with conf >= 0 and non-empty text,
 * and reads the page size from the level-1 row.
 */

export function parseTsv(tsv: string): OcrResult {
  const rows = tsv.split(/\r?\n/);
  const header = (rows[0] ?? '')
    .replace(/^\uFEFF/, '')
    .split('\t')
    .map((name) => name.trim());

  const col = (name: string) => header.indexOf(name);
  const iLevel = col('level');
  const iBlock = col('block_num');
  const iPar = col('par_num');
  const iLine = col('line_num');
  const iLeft = col('left');
  const iTop = col('top');
  const iWidth = col('width');
  const iHeight = col('height');
  const iConf = col('conf');
  const iText = col('text');

  const required = [
    ['level', iLevel],
    ['block_num', iBlock],
    ['par_num', iPar],
    ['line_num', iLine],
    ['left', iLeft],
    ['top', iTop],
    ['width', iWidth],
    ['height', iHeight],
    ['conf', iConf],
    ['text', iText],
  ] as const;

  const missing = required
    .filter(([, index]) => index < 0)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Invalid Tesseract TSV: missing columns: ${missing.join(', ')}`,
    );
  }

  let width = 0;
  let height = 0;
  const words: OcrWord[] = [];

  for (let r = 1; r < rows.length; r++) {
    if (!rows[r]) continue;

    const c = rows[r].split('\t');
    if (c.length < header.length) continue;

    const level = c[iLevel];

    if (level === '1') {
      width = Number(c[iWidth]);
      height = Number(c[iHeight]);
      continue;
    }

    if (level !== '5') continue;

    const text = (c[iText] ?? '').trim();
    const conf = Number(c[iConf]);

    if (!text || !Number.isFinite(conf) || conf < 0) continue;

    const x0 = Number(c[iLeft]);
    const y0 = Number(c[iTop]);
    const wordWidth = Number(c[iWidth]);
    const wordHeight = Number(c[iHeight]);

    if (
      ![x0, y0, wordWidth, wordHeight].every(Number.isFinite)
    ) {
      continue;
    }

    words.push({
      text,
      x0,
      y0,
      x1: x0 + wordWidth,
      y1: y0 + wordHeight,
      conf: Math.round(conf),
      lineKey: `${c[iBlock]}.${c[iPar]}.${c[iLine]}`,
    });
  }

  return { width, height, words };
}

// export function parseTsv(tsv: string): OcrResult {
//   const rows = tsv.split('\n');
//   const header = (rows[0] ?? '').split('\t');
//   const col = (name: string) => header.indexOf(name);
//   const iLevel = col('level');
//   const iBlock = col('block_num');
//   const iPar = col('par_num');
//   const iLine = col('line_num');
//   const iLeft = col('left');
//   const iTop = col('top');
//   const iWidth = col('width');
//   const iHeight = col('height');
//   const iConf = col('conf');
//   const iText = col('text');
//   let width = 0;
//   let height = 0;
//   const words: OcrWord[] = [];
//   for (let r = 1; r < rows.length; r++) {
//     const c = rows[r].split('\t');
//     if (c.length < header.length) continue;
//     const level = c[iLevel];
//     if (level === '1') {
//       width = Number(c[iWidth]);
//       height = Number(c[iHeight]);
//       continue;
//     }
//     if (level !== '5') continue;
//     const text = c[iText].trim();
//     const conf = Number(c[iConf]);
//     if (!text || !(conf >= 0)) continue;
//     const x0 = Number(c[iLeft]);
//     const y0 = Number(c[iTop]);
//     words.push({
//       text,
//       x0,
//       y0,
//       x1: x0 + Number(c[iWidth]),
//       y1: y0 + Number(c[iHeight]),
//       conf: Math.round(conf),
//       lineKey: `${c[iBlock]}.${c[iPar]}.${c[iLine]}`,
//     });
//   }
//   return { width, height, words };
// }

/**
 * OCR one encoded image (PNM/PNG/TIFF bytes), piped through stdin: no temp files, and no
 * dependence on leptonica's path handling (it rewrites '/tmp/...' paths to $TMPDIR on macOS).
 * OMP_THREAD_LIMIT=1 because we parallelise across pages instead.
 */
export async function runTesseract(paths: ToolPaths, image: Uint8Array, opts: TesseractOptions = DEFAULT_TESSERACT): Promise<OcrResult> {
  const args = ['stdin', 'stdout', '--psm', String(opts.psm), '-l', opts.lang];
  if (opts.dpi) args.push('--dpi', String(Math.round(opts.dpi)));
  for (const [k, v] of Object.entries(opts.config ?? {})) args.push('-c', `${k}=${v}`);
  args.push('tsv');
  const { stdout } = await runTool(paths, 'tesseract', args, {
    input: image,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseTsv(stdout.toString('utf8'));
}

/** Group words by tesseract's (block, paragraph, line) ids, preserving reading order. */
export function groupByTessLine<T extends OcrWord>(words: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const w of words) {
    const list = map.get(w.lineKey);
    if (list) list.push(w);
    else map.set(w.lineKey, [w]);
  }
  return [...map.values()];
}
