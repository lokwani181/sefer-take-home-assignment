/**
 * Preprocessing / OCR-pass benchmark (not a vitest file). Prints a token-recall table for the
 * scanned sample pages: the raw fixture, each preprocessing configuration (single psm 11 pass),
 * second-pass merges on top of the chosen configuration, and the full ingest() output.
 *
 *   cd server && npx tsx test/ingest/bench-preprocess.ts
 *
 * Token lists are read off the sample PDFs by hand (test-only data; nothing here is used by src/).
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentLayout, Word } from '@app/shared';
import { createIngest } from '../../src/ingest/index.js';
import { mergeWords } from '../../src/ingest/merge.js';
import { DEFAULT_PREPROCESS, preprocess, type PreprocessConfig } from '../../src/ingest/preprocess.js';
import { encodePnm, renderPdfPage, type Raster } from '../../src/ingest/raster.js';
import { runTesseract, type OcrWord } from '../../src/ingest/tesseract.js';
import { defaultToolPaths } from '../../src/ingest/tools.js';
import { BL_TOKENS, PL_TOKENS, recall, type TokenSet } from './tokens.js';

const SAMPLES = join(import.meta.dirname, '..', '..', '..', 'samples');
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'sample');
const tools = defaultToolPaths();

const PAGES = [
  { tag: 'PL', file: 'SPG-PL-2609-117_Packing_List.pdf', fixture: 'packing-list', sets: PL_TOKENS },
  { tag: 'BL', file: 'BMLVHCM26090418_House_BL.pdf', fixture: 'bill-of-lading', sets: BL_TOKENS },
];

const none: PreprocessConfig = { ...DEFAULT_PREPROCESS, suppressRed: false, suppressBlue: false, inkLayers: false };
const chosen: PreprocessConfig = { ...DEFAULT_PREPROCESS, inkLayers: false };

type Source = (raster: Raster, page: (typeof PAGES)[number]) => Promise<Word[]>;

async function pass(raster: Raster, cfg: PreprocessConfig | null, psm: number): Promise<OcrWord[]> {
  const opts = { psm, lang: 'eng', dpi: 300 };
  if (!cfg) return (await runTesseract(tools, encodePnm(raster.data, raster.width, raster.height, raster.channels), opts)).words;
  const pre = await preprocess(raster, cfg);
  return (await runTesseract(tools, encodePnm(pre.main, pre.width, pre.height, 1), opts)).words;
}

const single = (cfg: PreprocessConfig | null): Source => (r) => pass(r, cfg, 11);
const merged = (cfg: PreprocessConfig, second: PreprocessConfig, psm: number): Source => async (r) => {
  const [a, b] = await Promise.all([pass(r, cfg, 11), pass(r, second, psm)]);
  return mergeWords(a, b);
};

async function main() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ingest-bench-'));
  const ingest = createIngest({ cache: false, cacheDir });
  const full: Record<string, DocumentLayout> = {};
  const rows: [string, Source][] = [
    ['fixture (raw PNG, psm 11, no preprocessing)', async (_r, p) => (JSON.parse(readFileSync(join(FIXTURES, `${p.fixture}.layout.json`), 'utf8')) as DocumentLayout).pages[0].words],
    ['raw RGB, psm 11', single(null)],
    ['gray (Rec.601)', single({ ...none, whiteBalance: false })],
    ['gray + white balance', single(none)],
    ['gray + white balance + contrast stretch', single({ ...none, normalize: true })],
    ['+ red suppression (channel filter)', single({ ...none, suppressRed: true, suppressMethod: 'channel' })],
    ['+ red suppression (dominance mask)', single({ ...none, suppressRed: true, suppressMethod: 'mask' })],
    ['+ red suppression (both) = CHOSEN main layer', single(chosen)],
    ['+ blue suppression (both)', single({ ...none, suppressBlue: true })],
    ['+ red + blue suppression (both)', single({ ...chosen, suppressBlue: true })],
    ['chosen psm 11 + psm 6 merged = CHOSEN passes', merged(chosen, chosen, 6)],
    ['chosen psm 11 + psm 4 merged', merged(chosen, chosen, 4)],
    ['chosen psm 11 + blue-suppressed psm 11 merged', merged(chosen, { ...chosen, suppressBlue: true }, 11)],
    ['full ingest() output', async (_r, p) => (full[p.tag] ??= await ingest({ name: p.file, mime: 'application/pdf', bytes: new Uint8Array(readFileSync(join(SAMPLES, p.file))) })).pages[0].words],
  ];
  try {
    const rasters = await Promise.all(PAGES.map((p) => renderPdfPage(tools, join(SAMPLES, p.file), 1)));
    const header = ['configuration', ...PAGES.flatMap((p) => p.sets.map((s: TokenSet) => `${p.tag} ${s.name} (${s.tokens.length})`))];
    console.log('Cells: tokens found at any confidence / at conf >= 80.\n');
    console.log(`| ${header.join(' | ')} |`);
    console.log(`|${header.map(() => '---').join('|')}|`);
    for (const [name, source] of rows) {
      const words = await Promise.all(PAGES.map((p, i) => source(rasters[i], p)));
      const cells = PAGES.flatMap((p, i) => p.sets.map((s) => `${recall(words[i], s.tokens, 0).found} / ${recall(words[i], s.tokens, 80).found}`));
      console.log(`| ${name} | ${cells.join(' | ')} |`);
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

await main();
