/**
 * Ingest orchestration: uploaded file → DocumentLayout.
 *
 *   PDF   : pdftotext -bbox-layout for every page; pages with a usable text layer use it directly
 *           (conf 100), the others are rasterized at 300 DPI and OCRed (mixed PDFs are fine).
 *   image : decoded with sharp (EXIF orientation, multi-page TIFF), upscaled toward 300 DPI when
 *           small, then OCRed.
 * Pages run concurrently on a shared pool; results are cached by content hash.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentLayout, IngestFn, PageLayout, UploadedFile } from '@app/shared';
import { cacheEnabledByEnv, defaultCacheDir, docDir, PIPELINE_VERSION, readCachedLayout, writeCachedLayout } from './cache.js';
import { detectKind, KIND_MIME } from './detect.js';
import { IngestError, ToolFailedError } from './errors.js';
import { groupLines } from './lines.js';
import { createLimiter, defaultPoolSize, type Limiter } from './limiter.js';
import { DEFAULT_OCR_PAGE, ocrPage, type OcrPageContext, type OcrPageOptions } from './ocrPage.js';
import { DEFAULT_PREPROCESS, type PreprocessConfig } from './preprocess.js';
import { imagePageCount, loadImagePage, renderPdfPage, savePng } from './raster.js';
import { DPI, hasUsableTextLayer, readTextLayer } from './textLayer.js';
import { defaultToolPaths, type ToolPaths } from './tools.js';

export interface IngestOptions {
  /** Override binary paths (tests inject bogus paths to exercise the missing-tool errors). */
  tools?: Partial<ToolPaths>;
  /** Reuse/write layout.json in the cache. Default: on, unless INGEST_CACHE=0. */
  cache?: boolean;
  /** Cache root. Default: INGEST_CACHE_DIR or server/.cache/ocr. */
  cacheDir?: string;
  /** Max pages processed at once (and tesseract processes). Default: INGEST_CONCURRENCY or cpus/2. */
  concurrency?: number;
  /** Tesseract language. Default 'eng'. */
  lang?: string;
  preprocess?: Partial<PreprocessConfig>;
  /** Merge a psm 6 pass into the psm 11 pass (measured to help on form-like scans). Default true. */
  secondPass?: boolean;
  /** Run the colour-ink (stamp) passes; off also disables colour suppression. Default true. */
  stamps?: boolean;
  /** Also render text-layer pages to PNG for the UI (coordinates match). Default true. */
  renderTextPages?: boolean;
  /** Refuse documents with more pages than this. Default 200. */
  maxPages?: number;
}

interface ResolvedOptions {
  tools: ToolPaths;
  cache: boolean;
  cacheDir: string;
  ocr: OcrPageOptions;
  renderTextPages: boolean;
  maxPages: number;
  pages: Limiter;
  procs: Limiter;
}

let sharedPools: { pages: Limiter; procs: Limiter } | null = null;

/** Pools shared by every ingest instance using the default concurrency. */
function defaultPools(): { pages: Limiter; procs: Limiter } {
  if (!sharedPools) {
    const n = defaultPoolSize();
    sharedPools = { pages: createLimiter(n), procs: createLimiter(n) };
  }
  return sharedPools;
}

function resolveOptions(opts: IngestOptions): ResolvedOptions {
  const pools = opts.concurrency ? { pages: createLimiter(opts.concurrency), procs: createLimiter(opts.concurrency) } : defaultPools();
  return {
    tools: { ...defaultToolPaths(), ...opts.tools },
    cache: opts.cache ?? cacheEnabledByEnv(),
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    ocr: {
      lang: opts.lang ?? DEFAULT_OCR_PAGE.lang,
      preprocess: { ...DEFAULT_PREPROCESS, ...opts.preprocess },
      secondPass: opts.secondPass ?? DEFAULT_OCR_PAGE.secondPass,
      stamps: opts.stamps ?? DEFAULT_OCR_PAGE.stamps,
    },
    renderTextPages: opts.renderTextPages ?? true,
    maxPages: opts.maxPages ?? 200,
    ...pools,
  };
}

/** Everything that changes the output for the same bytes goes into the cache key. */
function optionsKey(o: ResolvedOptions): string {
  const relevant = { v: PIPELINE_VERSION, ocr: o.ocr, renderTextPages: o.renderTextPages };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/** Like Promise.all, but waits for every task before rethrowing the first failure (temp files stay valid). */
async function allSettledOrThrow<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

async function ingestPdf(file: UploadedFile, o: ResolvedOptions, ctx: OcrPageContext): Promise<PageLayout[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'ingest-'));
  try {
    const pdfPath = join(tmp, 'input.pdf');
    await writeFile(pdfPath, file.bytes);
    const textPages = await o.procs(() => readTextLayer(o.tools, pdfPath)).catch((err: unknown) => {
      // A PDF poppler cannot parse (corrupt, truncated, encrypted) is bad input, not a server fault.
      if (err instanceof ToolFailedError) {
        throw new IngestError('BAD_INPUT', `'${file.name}' could not be read as a PDF: ${err.stderr.trim().split('\n')[0] || err.message}`, undefined, { cause: err });
      }
      throw err;
    });
    if (textPages.length === 0) throw new IngestError('BAD_INPUT', `'${file.name}' has no pages`);
    if (textPages.length > o.maxPages) throw new IngestError('BAD_INPUT', `'${file.name}' has ${textPages.length} pages (limit ${o.maxPages})`);
    return await allSettledOrThrow(
      textPages.map((tp) =>
        o.pages(async (): Promise<PageLayout> => {
          if (hasUsableTextLayer(tp)) {
            const page: PageLayout = {
              page: tp.page,
              width: tp.width,
              height: tp.height,
              source: 'text',
              skewDeg: 0,
              words: tp.words,
              lines: groupLines(tp.words),
            };
            if (o.renderTextPages) {
              const raster = await o.procs(() => renderPdfPage(o.tools, pdfPath, tp.page, DPI));
              page.imagePath = join(ctx.imageDir, `page-${tp.page}.png`);
              await savePng(raster, page.imagePath);
            }
            return page;
          }
          const raster = await o.procs(() => renderPdfPage(o.tools, pdfPath, tp.page, DPI));
          return ocrPage(raster, tp.page, DPI, ctx, o.ocr);
        }),
      ),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function ingestImage(file: UploadedFile, o: ResolvedOptions, ctx: OcrPageContext): Promise<PageLayout[]> {
  const count = await imagePageCount(file.bytes);
  if (count > o.maxPages) throw new IngestError('BAD_INPUT', `'${file.name}' has ${count} pages (limit ${o.maxPages})`);
  return allSettledOrThrow(
    Array.from({ length: count }, (_, i) =>
      o.pages(async () => {
        const { raster, dpi } = await loadImagePage(file.bytes, i);
        return ocrPage(raster, i + 1, dpi, ctx, o.ocr);
      }),
    ),
  );
}

async function run(file: UploadedFile, sha: string, key: string, o: ResolvedOptions): Promise<DocumentLayout> {
  const kind = detectKind(file.bytes, file.name, file.mime);
  if (o.cache) {
    const cached = await readCachedLayout(o.cacheDir, sha, key);
    if (cached) return cached;
  }
  const imageDir = docDir(o.cacheDir, sha);
  await mkdir(imageDir, { recursive: true });
  const ctx: OcrPageContext = { tools: o.tools, procs: o.procs, imageDir };
  const pages = kind === 'pdf' ? await ingestPdf(file, o, ctx) : await ingestImage(file, o, ctx);
  const layout: DocumentLayout = {
    docId: `doc-${sha.slice(0, 12)}`,
    fileName: file.name,
    sha256: sha,
    mime: KIND_MIME[kind],
    pages: pages.sort((a, b) => a.page - b.page),
  };
  if (o.cache) await writeCachedLayout(o.cacheDir, layout, key);
  return layout;
}

/**
 * Build an ingest function with explicit options (tests, CLI flags). The default `ingest` export
 * uses environment-driven defaults. Concurrent calls for the same bytes share one computation.
 */
export function createIngest(options: IngestOptions = {}): IngestFn {
  const o = resolveOptions(options);
  const key = optionsKey(o);
  const inflight = new Map<string, Promise<DocumentLayout>>();
  return async (file: UploadedFile): Promise<DocumentLayout> => {
    if (!file || !(file.bytes instanceof Uint8Array)) throw new IngestError('BAD_INPUT', 'No file bytes');
    const sha = createHash('sha256').update(file.bytes).digest('hex');
    let job = inflight.get(sha);
    if (!job) {
      job = run(file, sha, key, o).finally(() => inflight.delete(sha));
      inflight.set(sha, job);
    }
    const layout = await job;
    // Same bytes may arrive under another name; the layout itself is content-addressed.
    return { ...layout, fileName: file.name, pages: layout.pages };
  };
}
