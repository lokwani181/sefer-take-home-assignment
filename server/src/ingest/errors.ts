/**
 * Typed ingest errors. The API layer maps `code` to an HTTP status
 * (TOOL_MISSING / OCR_LANGUAGE_MISSING → 503, UNSUPPORTED_FILE / BAD_INPUT → 415/400).
 */

export type IngestErrorCode =
  | 'TOOL_MISSING'
  | 'OCR_LANGUAGE_MISSING'
  | 'TOOL_FAILED'
  | 'UNSUPPORTED_FILE'
  | 'BAD_INPUT';

/** Install hint shown to the user whenever a system dependency is missing. */
export const INSTALL_HINT =
  "Install Tesseract and Poppler: macOS 'brew install tesseract poppler'; " +
  "Debian/Ubuntu 'apt-get install tesseract-ocr poppler-utils'.";

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  readonly hint?: string;

  constructor(code: IngestErrorCode, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IngestError';
    this.code = code;
    this.hint = hint;
  }
}

/** A required binary (tesseract, pdftoppm, pdftotext) could not be executed. */
export class MissingToolError extends IngestError {
  readonly tool: string;
  readonly path: string;

  constructor(tool: string, path: string, options?: { cause?: unknown }) {
    super(
      'TOOL_MISSING',
      `Required tool '${tool}' was not found (tried '${path}'). ${INSTALL_HINT}`,
      INSTALL_HINT,
      options,
    );
    this.name = 'MissingToolError';
    this.tool = tool;
    this.path = path;
  }
}

/** Tesseract runs but the requested language data (e.g. eng.traineddata) is not installed. */
export class MissingLanguageError extends IngestError {
  readonly lang: string;

  constructor(lang: string, stderr: string) {
    const hint =
      `Install the '${lang}' language data: macOS 'brew install tesseract' (includes eng); ` +
      `Debian/Ubuntu 'apt-get install tesseract-ocr-${lang}'.`;
    super('OCR_LANGUAGE_MISSING', `Tesseract language '${lang}' is not available. ${hint} (${stderr.trim()})`, hint);
    this.name = 'MissingLanguageError';
    this.lang = lang;
  }
}

/** A tool ran but exited with an error (corrupt PDF, unreadable image, …). */
export class ToolFailedError extends IngestError {
  readonly tool: string;
  readonly stderr: string;

  constructor(tool: string, detail: string, stderr: string, options?: { cause?: unknown }) {
    super('TOOL_FAILED', `'${tool}' failed: ${detail}${stderr ? ` (${stderr.trim().slice(0, 400)})` : ''}`, undefined, options);
    this.name = 'ToolFailedError';
    this.tool = tool;
    this.stderr = stderr;
  }
}
