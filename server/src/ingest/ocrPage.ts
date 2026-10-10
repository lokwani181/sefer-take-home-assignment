/**
 * One raster page → PageLayout: preprocess, OCR (two merged passes), stamp passes, deskew, lines.
 */
import { join } from 'node:path';
import type { PageLayout, Word } from '@app/shared';
import { deskewWords, estimateSkew } from './deskew.js';
import { groupLines } from './lines.js';
import type { Limiter } from './limiter.js';
import { mergeWords } from './merge.js';
import { DEFAULT_PREPROCESS, preprocess, type PreprocessConfig } from './preprocess.js';
import { encodePnm, rotateRaster, savePng, type Raster } from './raster.js';
import { DEFAULT_STAMP_OPTIONS, readInkLayer, type InkRegion, type StampLine } from './stamps.js';
import { groupByTessLine, runTesseract, type OcrWord } from './tesseract.js';
import type { ToolPaths } from './tools.js';

export interface OcrPageOptions {
  lang: string;
  preprocess: PreprocessConfig;
  /** Merge a psm 6 (uniform block) pass into the psm 11 (sparse) pass. */
  secondPass: boolean;
  /**
   * Colour-ink pass: read red/blue stamp layers into PageLayout.stamps and give axis-aligned
   * coloured print back to the page. When off, colour suppression is off too, because suppressed
   * coloured print (e.g. a red letterhead) could not be recovered.
   */
  stamps: boolean;
}

export const DEFAULT_OCR_PAGE: OcrPageOptions = {
  lang: 'eng',
  preprocess: DEFAULT_PREPROCESS,
  secondPass: true,
  stamps: true,
};

export interface OcrPageContext {
  tools: ToolPaths;
  /** Limits concurrent tesseract processes across all pages and uploads. */
  procs: Limiter;
  /** Directory for the page image (page-<n>.png). */
  imageDir: string;
}

/** A coloured region counts as "rotated" (a stamp) when its text angle differs from the page by this much. */
const STAMP_ANGLE_DEG = 1.5;
/** Blue regions are only read when rotated, or when the main pass read them poorly. */
const POOR_MAIN_CONF = 70;
/** Prefix for stamp lines read from the blue layer (parsers decide what to do with them). */
export const BLUE_PREFIX = 'BLUE: ';

function meanConfInside(words: Word[], r: InkRegion): number {
  const inside = words.filter((w) => {
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
  });
  return inside.length ? inside.reduce((a, w) => a + w.conf, 0) / inside.length : 0;
}

/**
 * OCR one page image. Coordinates stay in the raster's pixel space (300 DPI for PDF pages);
 * words are deskewed by rotating coordinates, and the saved page image is rotated the same way
 * so word boxes line up with it in the UI.
 */
export async function ocrPage(raster: Raster, pageNo: number, dpi: number, ctx: OcrPageContext, opts: OcrPageOptions = DEFAULT_OCR_PAGE): Promise<PageLayout> {
  const { tools, procs } = ctx;
  const pre = await preprocess(
    raster,
    opts.stamps ? { ...opts.preprocess, inkLayers: true } : { ...opts.preprocess, inkLayers: false, suppressRed: false, suppressBlue: false },
  );
  const mainImage = encodePnm(pre.main, pre.width, pre.height, 1);
  const tess = (psm: number) => procs(() => runTesseract(tools, mainImage, { psm, lang: opts.lang, dpi }));
  const stampOpts = { ...DEFAULT_STAMP_OPTIONS, lang: opts.lang, dpi };

  const [sparse, block, redLines] = await Promise.all([
    tess(11),
    opts.secondPass ? tess(6) : Promise.resolve(null),
    pre.red ? readInkLayer(tools, pre.red, pre.width, pre.height, stampOpts, () => true, procs) : Promise.resolve([] as StampLine[]),
  ]);

  // Skew from the line groups of both passes (block mode contributes long full-width lines).
  const groups: Word[][] = groupByTessLine(sparse.words);
  if (block) groups.push(...groupByTessLine(block.words));
  const skew = estimateSkew(groups, dpi);

  let words: OcrWord[] = block ? mergeWords(sparse.words, block.words) : sparse.words;

  let blueLines: StampLine[] = [];
  if (pre.blue) {
    const mainWords = words;
    blueLines = await readInkLayer(
      tools,
      pre.blue,
      pre.width,
      pre.height,
      stampOpts,
      (region, angle) => Math.abs(angle - skew.deg) >= STAMP_ANGLE_DEG || meanConfInside(mainWords, region) < POOR_MAIN_CONF,
      procs,
    );
  }

  // Coloured text aligned with the page is print (e.g. a red letterhead), not a stamp: give its
  // words back to the page, where nothing else was read in that spot (suppression may have erased it).
  const printed = [...redLines, ...blueLines].filter((l) => Math.abs(l.angleDeg - skew.deg) < STAMP_ANGLE_DEG);
  if (printed.length) {
    const extra = printed.flatMap((l) => l.words.map((w): OcrWord => ({ ...w, lineKey: 'ink' })));
    words = mergeWords(words, extra);
  }

  const deskewed = deskewWords(words, pre.width, pre.height, skew.slope);
  const stamps = [...redLines.map((l) => l.text), ...blueLines.map((l) => BLUE_PREFIX + l.text)];

  // Page image for the UI, rotated like the coordinates (sharp: positive = clockwise).
  const imagePath = join(ctx.imageDir, `page-${pageNo}.png`);
  const image = Math.abs(skew.deg) >= 0.05 ? await rotateRaster(raster, -skew.deg) : raster;
  await savePng(image, imagePath);

  // Words in reading order (lines top to bottom, words left to right): merged passes have no order.
  const lines = groupLines(deskewed);
  const page: PageLayout = {
    page: pageNo,
    width: pre.width,
    height: pre.height,
    source: 'ocr',
    skewDeg: Math.round(skew.deg * 1000) / 1000,
    words: lines.flatMap((l) => l.words),
    lines,
    imagePath,
  };
  if (opts.stamps) page.stamps = stamps;
  return page;
}
