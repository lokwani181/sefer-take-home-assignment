/**
 * Locating and running the external OCR / PDF binaries (no shell, argv arrays only).
 */
import { execFile } from 'node:child_process';
import { MissingLanguageError, MissingToolError, ToolFailedError } from './errors.js';

export type ToolName = 'tesseract' | 'pdftoppm' | 'pdftotext';

/** Executable path (or bare name resolved via PATH) for each tool. Injectable for tests and odd installs. */
export interface ToolPaths {
  tesseract: string;
  pdftoppm: string;
  pdftotext: string;
}

/** Defaults come from PATH, overridable per tool with TESSERACT_PATH / PDFTOPPM_PATH / PDFTOTEXT_PATH. */
export function defaultToolPaths(env: NodeJS.ProcessEnv = process.env): ToolPaths {
  return {
    tesseract: env.TESSERACT_PATH || 'tesseract',
    pdftoppm: env.PDFTOPPM_PATH || 'pdftoppm',
    pdftotext: env.PDFTOTEXT_PATH || 'pdftotext',
  };
}

export interface RunOptions {
  /** Max bytes of stdout (a 300 DPI A3 PPM is ~50 MB). */
  maxBuffer?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Resolve (instead of throwing) on a non-zero exit; used by version probes. */
  allowFailure?: boolean;
  /** Bytes written to the child's stdin (e.g. an image for `tesseract stdin`). */
  input?: Uint8Array;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Run a tool asynchronously and return raw stdout. A missing binary becomes a MissingToolError
 * (naming the tool and the install command) so the API can answer 503 with a useful hint.
 */
export function runTool(paths: ToolPaths, tool: ToolName, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const file = paths[tool];
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: 'buffer',
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: opts.env ?? process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const stderrText = stderr ? stderr.toString('utf8') : '';
        if (!err) {
          resolve({ stdout, stderr: stderrText, exitCode: 0 });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
          reject(new MissingToolError(tool, file, { cause: err }));
          return;
        }
        if (tool === 'tesseract') {
          const lang = /Failed loading language '([^']+)'/.exec(stderrText);
          if (lang) {
            reject(new MissingLanguageError(lang[1], stderrText));
            return;
          }
        }
        if (opts.allowFailure && typeof code === 'number') {
          resolve({ stdout, stderr: stderrText, exitCode: code });
          return;
        }
        const detail = (err as { killed?: boolean }).killed
          ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
          : `exit code ${String(code ?? 'unknown')}`;
        reject(new ToolFailedError(tool, detail, stderrText, { cause: err }));
      },
    );
    if (child.stdin) {
      // EPIPE when the binary is missing or exits early is reported through the exec callback.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input ? Buffer.from(opts.input.buffer, opts.input.byteOffset, opts.input.byteLength) : undefined);
    }
  });
}

export interface OcrToolsStatus {
  ok: boolean;
  tesseract?: string;
  pdftoppm?: string;
  pdftotext?: string;
  missing: string[];
}

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

async function probeVersion(paths: ToolPaths, tool: ToolName, args: string[]): Promise<string | undefined> {
  try {
    const r = await runTool(paths, tool, args, { allowFailure: true, timeoutMs: 15_000 });
    // tesseract prints the version on stdout (5.x) or stderr (3.x/4.x); poppler prints on stderr.
    const text = `${r.stdout.toString('utf8')}\n${r.stderr}`;
    const firstRelevant = text.split('\n').find((l) => l.toLowerCase().includes(tool)) ?? text;
    return VERSION_RE.exec(firstRelevant)?.[1] ?? VERSION_RE.exec(text)?.[1] ?? 'unknown';
  } catch {
    return undefined;
  }
}

/**
 * Report which OCR/PDF binaries are installed, with versions (used by /api/health).
 * Also verifies tesseract has the language data we OCR with. Never throws.
 */
export async function checkOcrTools(paths: ToolPaths = defaultToolPaths(), lang = 'eng'): Promise<OcrToolsStatus> {
  const [tesseract, pdftoppm, pdftotext] = await Promise.all([
    probeVersion(paths, 'tesseract', ['--version']),
    probeVersion(paths, 'pdftoppm', ['-v']),
    probeVersion(paths, 'pdftotext', ['-v']),
  ]);
  const missing: string[] = [];
  if (!tesseract) missing.push('tesseract');
  if (!pdftoppm) missing.push('pdftoppm');
  if (!pdftotext) missing.push('pdftotext');
  if (tesseract) {
    try {
      const r = await runTool(paths, 'tesseract', ['--list-langs'], { allowFailure: true, timeoutMs: 15_000 });
      const langs = `${r.stdout.toString('utf8')}\n${r.stderr}`.split(/\s+/);
      if (!langs.includes(lang)) missing.push(`tesseract language data '${lang}'`);
    } catch {
      missing.push(`tesseract language data '${lang}'`);
    }
  }
  return { ok: missing.length === 0, tesseract, pdftoppm, pdftotext, missing };
}
