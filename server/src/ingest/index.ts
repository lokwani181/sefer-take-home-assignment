/**
 * Ingest module (T1): uploaded PDF/image → DocumentLayout (word boxes at 300 DPI, deskewed,
 * grouped into lines, plus stamp text). Deterministic: PDF text layer + Tesseract, no network.
 */
import type { IngestFn } from '@app/shared';
import { createIngest } from './ingest.js';
import { checkOcrTools as probeTools, defaultToolPaths, type OcrToolsStatus, type ToolPaths } from './tools.js';

export { createIngest, type IngestOptions } from './ingest.js';
export { IngestError, MissingLanguageError, MissingToolError, ToolFailedError, INSTALL_HINT, type IngestErrorCode } from './errors.js';
export { PIPELINE_VERSION, defaultCacheDir } from './cache.js';
export { BLUE_PREFIX } from './ocrPage.js';
export type { OcrToolsStatus, ToolPaths } from './tools.js';

let defaultIngest: IngestFn | null = null;

/** Ingest one uploaded file with environment-driven defaults (cache on unless INGEST_CACHE=0). */
export const ingest: IngestFn = (file) => {
  defaultIngest ??= createIngest();
  return defaultIngest(file);
};

/**
 * Report whether tesseract (with 'eng' data), pdftoppm and pdftotext are installed, with versions.
 * Used by /api/health; never throws.
 */
export function checkOcrTools(tools?: Partial<ToolPaths>): Promise<OcrToolsStatus> {
  return probeTools({ ...defaultToolPaths(), ...tools });
}
