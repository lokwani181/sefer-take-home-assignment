/**
 * Express API (no listen; index.ts starts it, supertest drives it directly).
 *
 *   GET  /api/health                                         HealthResponse (OCR tools found?)
 *   POST /api/shipments                                      multipart files[] (+ brokerInputs JSON) → PipelineResult
 *   GET  /api/shipments/:id                                  stored PipelineResult
 *   POST /api/shipments/:id/regenerate                       { brokerInputs } → PipelineResult (no re-OCR)
 *   GET  /api/shipments/:id/documents/:docId/pages/:page/image   rendered page PNG (?w=<px> downscaled, cached)
 *
 * Every error is an ApiError { error, detail?, hint? }. In production the built web app (web/dist)
 * is served from the same origin with an SPA fallback.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import type { ApiError, BrokerInputs, HealthResponse, IngestFn, UploadedFile } from '@app/shared';
import { checkOcrTools, createIngest, IngestError, INSTALL_HINT, type IngestErrorCode, type ToolPaths } from '../ingest/index.js';
import { defaultStore, regenerate, runPipeline, ShipmentNotFoundError, type ShipmentStore } from '../pipeline.js';
import { brokerInputsSchema, regenerateBodySchema, zodMessage } from './schemas.js';

export interface AppOptions {
  /** Ingest implementation; defaults to one built from `tools` (or the environment defaults). */
  ingest?: IngestFn;
  /** Tool paths for both the health check and the default ingest (tests pass bogus paths). */
  tools?: Partial<ToolPaths>;
  store?: ShipmentStore;
  /** Directory of the built web app; served when it exists. Default: web/dist. Pass null to disable. */
  webDist?: string | null;
}

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const ACCEPTED_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp']);
const ACCEPTED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/tiff', 'image/webp']);
const ACCEPTED_TEXT = 'PDF, PNG, JPEG, TIFF or WebP';

const INGEST_STATUS: Record<IngestErrorCode, number> = {
  TOOL_MISSING: 503,
  OCR_LANGUAGE_MISSING: 503,
  TOOL_FAILED: 500,
  UNSUPPORTED_FILE: 415,
  BAD_INPUT: 422,
};

/** An error that already knows its HTTP status and ApiError body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
    this.name = 'HttpError';
  }
}

/** Accepted ?w= range for page images (pixels). */
export const PAGE_IMAGE_MIN_WIDTH = 50;
export const PAGE_IMAGE_MAX_WIDTH = 10_000;

/** Parses ?w=: undefined when absent, a positive integer in range, or an HttpError. */
function pageImageWidth(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const text = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const w = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(w) || w < PAGE_IMAGE_MIN_WIDTH || w > PAGE_IMAGE_MAX_WIDTH) {
    throw new HttpError(400, {
      error: 'Invalid image width',
      detail: `w must be a whole number of pixels between ${PAGE_IMAGE_MIN_WIDTH} and ${PAGE_IMAGE_MAX_WIDTH} (got "${text}").`,
    });
  }
  return w;
}

/** In-flight resizes, so concurrent requests for the same size share one sharp run. */
const scaling = new Map<string, Promise<string | Buffer>>();

/**
 * A page image scaled to `width` (aspect kept), written once next to the original as
 * `page-<n>.w<width>.png` (atomic rename) and reused. Returns the original path when the page is not
 * wider than `width`, or the PNG bytes when the cache directory is not writable.
 */
export async function scaledPageImage(src: string, width: number): Promise<{ file: string } | { buffer: Buffer }> {
  const meta = await sharp(src).metadata();
  if (!meta.width || width >= meta.width) return { file: src };
  const target = `${src.replace(/\.png$/i, '')}.w${width}.png`;
  if (existsSync(target)) return { file: target };
  let job = scaling.get(target);
  if (!job) {
    job = (async () => {
      const png = await sharp(src).resize({ width, withoutEnlargement: true }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      const tmp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, png);
        await rename(tmp, target);
        return target;
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined);
        return png;
      }
    })().finally(() => scaling.delete(target));
    scaling.set(target, job);
  }
  const out = await job;
  return typeof out === 'string' ? { file: out } : { buffer: out };
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIST = resolve(here, '..', '..', '..', 'web', 'dist');

function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

function isAccepted(file: Express.Multer.File): boolean {
  return ACCEPTED_EXT.has(extensionOf(file.originalname)) || ACCEPTED_MIME.has(file.mimetype.toLowerCase());
}

/** multer gives latin1-decoded names; browsers send UTF-8. */
function decodeName(name: string): string {
  try {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    return utf8.includes('�') ? name : utf8;
  } catch {
    return name;
  }
}

function parseBrokerInputsField(raw: unknown): BrokerInputs | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new HttpError(400, { error: 'Invalid brokerInputs', detail: 'brokerInputs must be a JSON string field' });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new HttpError(400, { error: 'Invalid brokerInputs', detail: `brokerInputs is not valid JSON: ${(err as Error).message}` });
  }
  const parsed = brokerInputsSchema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, { error: 'Invalid brokerInputs', detail: zodMessage(parsed.error) });
  return parsed.data;
}

/** Maps anything thrown by a route to an HTTP status + ApiError. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ShipmentNotFoundError) {
    return new HttpError(404, { error: 'Shipment not found', detail: err.message, hint: 'Upload the documents again.' });
  }
  if (err instanceof IngestError) {
    return new HttpError(INGEST_STATUS[err.code] ?? 500, {
      error:
        err.code === 'TOOL_MISSING' || err.code === 'OCR_LANGUAGE_MISSING'
          ? 'OCR tools are not installed on the server'
          : err.code === 'UNSUPPORTED_FILE'
            ? 'Unsupported file'
            : err.code === 'BAD_INPUT'
              ? 'Document could not be read'
              : 'Document processing failed',
      detail: err.message,
      hint: err.hint ?? (err.code === 'UNSUPPORTED_FILE' ? `Upload ${ACCEPTED_TEXT} files.` : undefined),
    });
  }
  if (err instanceof multer.MulterError) {
    const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new HttpError(413, { error: 'File too large', detail: `Each file may be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
    }
    return new HttpError(400, {
      error: tooMany ? 'Too many files or unexpected field' : 'Upload rejected',
      detail: `${err.message}${err.field ? ` (field '${err.field}')` : ''}. Send up to ${MAX_FILES} files in the multipart field 'files'.`,
    });
  }
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  if (status && status >= 400 && status < 500) {
    // e.g. express.json() body parse errors
    return new HttpError(status, { error: 'Bad request', detail: err instanceof Error ? err.message : String(err) });
  }
  return new HttpError(500, { error: 'Internal server error', detail: err instanceof Error ? err.message : String(err) });
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const wrap =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

export function createApp(options: AppOptions = {}): express.Express {
  const store = options.store ?? defaultStore;
  const ingest = options.ingest ?? (options.tools ? createIngest({ tools: options.tools }) : undefined);
  const app = express();
  app.disable('x-powered-by');

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 10, fieldSize: 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (isAccepted(file)) cb(null, true);
      else
        cb(
          new HttpError(415, {
            error: 'Unsupported file type',
            detail: `'${decodeName(file.originalname)}' (${file.mimetype || 'unknown type'}) is not a supported document.`,
            hint: `Upload ${ACCEPTED_TEXT} files.`,
          }),
        );
    },
  });

  app.get(
    '/api/health',
    wrap(async (_req, res) => {
      const status = await checkOcrTools(options.tools);
      const tools: Record<string, string> = {};
      for (const name of ['tesseract', 'pdftoppm', 'pdftotext'] as const) {
        const v = status[name];
        if (v) tools[name] = v;
      }
      tools.xmllint = 'xmllint-wasm';
      const body: HealthResponse & { hint?: string } = { ok: status.ok && status.missing.length === 0, tools, missing: status.missing };
      if (!body.ok) body.hint = INSTALL_HINT;
      res.json(body);
    }),
  );

  app.post(
    '/api/shipments',
    upload.array('files', MAX_FILES),
    wrap(async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        throw new HttpError(400, { error: 'No files uploaded', detail: "Send the documents in the multipart field 'files'.", hint: `Add at least one ${ACCEPTED_TEXT} document.` });
      }
      const brokerInputs = parseBrokerInputsField((req.body as Record<string, unknown> | undefined)?.brokerInputs);
      const uploaded: UploadedFile[] = files.map((f) => ({
        name: decodeName(f.originalname),
        mime: f.mimetype,
        bytes: new Uint8Array(f.buffer.buffer, f.buffer.byteOffset, f.buffer.byteLength),
      }));
      const result = await runPipeline(uploaded, brokerInputs ?? {}, { ingest, store });
      res.json(result);
    }),
  );

  app.get(
    '/api/shipments/:id',
    wrap(async (req, res) => {
      const stored = store.get(String(req.params.id));
      if (!stored) throw new ShipmentNotFoundError(String(req.params.id));
      res.json(stored.result);
    }),
  );

  app.post(
    '/api/shipments/:id/regenerate',
    express.json({ limit: '1mb' }),
    wrap(async (req, res) => {
      const parsed = regenerateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new HttpError(400, { error: 'Invalid request body', detail: zodMessage(parsed.error) });
      const { brokerInputs = {}, decisions } = parsed.data;
      const inputs: BrokerInputs = decisions ? { ...brokerInputs, decisions: { ...brokerInputs.decisions, ...decisions } } : brokerInputs;
      const result = await regenerate(String(req.params.id), inputs, { store });
      res.json(result);
    }),
  );

  app.get(
    '/api/shipments/:id/documents/:docId/pages/:page/image',
    wrap(async (req, res) => {
      const stored = store.get(String(req.params.id));
      if (!stored) throw new ShipmentNotFoundError(String(req.params.id));
      const layout = stored.layouts.find((l) => l.docId === req.params.docId);
      const pageNo = Number(req.params.page);
      const page = layout?.pages.find((p) => p.page === pageNo);
      if (!layout || !page) throw new HttpError(404, { error: 'Page not found', detail: `No page ${req.params.page} in document ${req.params.docId}.` });
      if (!page.imagePath || !existsSync(page.imagePath)) {
        throw new HttpError(404, { error: 'Page image not available', detail: `No rendered image is stored for page ${pageNo} of ${layout.fileName}.` });
      }
      const width = pageImageWidth(req.query.w);
      const headers = { 'Cache-Control': 'private, max-age=3600' };
      const image = width === undefined ? { file: page.imagePath } : await scaledPageImage(page.imagePath, width);
      if ('buffer' in image) {
        res.set({ ...headers, 'Content-Type': 'image/png' }).send(image.buffer);
        return;
      }
      // The OCR cache lives under server/.cache, so dot-segments in the path must be allowed.
      await new Promise<void>((ok, fail) => res.sendFile(image.file, { dotfiles: 'allow', headers }, (err) => (err ? fail(err) : ok())));
    }),
  );

  // Unknown API routes are JSON 404s, never the SPA.
  app.use('/api', (req, _res, next) => {
    next(new HttpError(404, { error: 'Not found', detail: `${req.method} ${req.originalUrl}` }));
  });

  const webDist = options.webDist === undefined ? DEFAULT_WEB_DIST : options.webDist;
  if (webDist && existsSync(join(webDist, 'index.html')) && statSync(webDist).isDirectory()) {
    app.use(express.static(webDist, { index: 'index.html', maxAge: '1h' }));
    // SPA fallback: any other GET that looks like a page navigation gets index.html.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) console.error('[api]', err);
    if (res.headersSent) return;
    res.status(httpErr.status).json(httpErr.body);
  };
  app.use(onError);
  return app;
}
