/**
 * Self-check for generated shipments: text PDFs must have a text layer, scans must not, and
 * Tesseract (--psm 11, the pipeline's OCR mode) must read most key values on the scans and
 * photos (image files are OCR'd as delivered, at their own resolution).
 *
 * Usage: npx tsx scripts/synthetic/self-check.ts [--dir samples/synthetic] [--only <id>[,<id>…]]
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateExpected } from './expected-schema.js';

const execFileP = promisify(execFile);

/** Minimum OCR token recall on the scanned documents before the scan effects must be made milder. */
export const MIN_OCR_RECALL = 0.7;

/** Non-whitespace characters in the PDF text layer (pdftotext). */
export async function textLayerChars(pdfPath: string): Promise<number> {
  const { stdout } = await execFileP('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.replace(/\s+/g, '').length;
}

/** OCRs every page like the pipeline does: pdftoppm -r 300, then tesseract --psm 11. */
export async function ocrPdf(pdfPath: string, dpi = 300): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-ocr-'));
  try {
    await execFileP('pdftoppm', ['-r', String(dpi), '-png', pdfPath, join(dir, 'p')]);
    const pages = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const texts: string[] = [];
    for (const p of pages) {
      const { stdout } = await execFileP('tesseract', [join(dir, p), '-', '--psm', '11', '-l', 'eng'], {
        maxBuffer: 32 * 1024 * 1024,
      });
      texts.push(stdout);
    }
    return texts.join('\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** True for photo/scan image files (JPEG/PNG) that have no PDF text layer. */
export const isImageFile = (file: string): boolean => /\.(jpe?g|png)$/i.test(file);

/** OCRs an image file as delivered (no re-rasterization): tesseract --psm 11. */
export async function ocrImage(imagePath: string): Promise<string> {
  // Leptonica rewrites paths that start with "/tmp", so hand it the resolved path (/private/tmp on macOS).
  const { stdout } = await execFileP('tesseract', [await realpath(imagePath), '-', '--psm', '11', '-l', 'eng'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Fraction of key values found in OCR/text output. A key counts as found when its
 * punctuation-free form equals one word or 2–4 consecutive words of the output
 * ("020-12345675" matches "020-12345675" and "020 12345675"; "840.00" does not match "$40.00").
 */
export function tokenRecall(keys: string[], text: string): { recall: number; found: string[]; missing: string[] } {
  const words = text.split(/\s+/).map(norm).filter(Boolean);
  const seqs = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    let acc = '';
    for (let k = 0; k < 4 && i + k < words.length; k++) {
      acc += words[i + k];
      seqs.add(acc);
    }
  }
  const unique = [...new Set(keys)];
  const found: string[] = [];
  const missing: string[] = [];
  for (const k of unique) (seqs.has(norm(k)) ? found : missing).push(k);
  return { recall: unique.length === 0 ? 1 : found.length / unique.length, found, missing };
}

export interface FileCheck {
  shipment: string;
  file: string;
  source: 'text' | 'ocr';
  textChars: number;
  recall?: number;
  missing?: string[];
  ok: boolean;
  problems: string[];
}

/** Runs all checks for every shipment folder under `dir`. */
export async function selfCheck(dir: string, only?: string[]): Promise<FileCheck[]> {
  const out: FileCheck[] = [];
  const ids = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!only || only.includes(d.name)))
    .map((d) => d.name)
    .sort();
  for (const id of ids) {
    const parsed = validateExpected(JSON.parse(await readFile(join(dir, id, 'expected.json'), 'utf8')));
    if (!parsed.ok) {
      out.push({ shipment: id, file: 'expected.json', source: 'text', textChars: 0, ok: false, problems: parsed.errors });
      continue;
    }
    for (const f of parsed.value.files) {
      const path = join(dir, id, f.file);
      const problems: string[] = [];
      const image = isImageFile(f.file);
      const textChars = image ? 0 : await textLayerChars(path);
      const check: FileCheck = { shipment: id, file: f.file, source: f.source, textChars, ok: true, problems };
      if (image && f.source !== 'ocr') {
        problems.push('image files have no text layer: source must be ocr');
      } else if (f.source === 'text') {
        if (textChars < 200) problems.push(`text PDF has only ${textChars} text-layer chars`);
        const { stdout } = await execFileP('pdftotext', ['-layout', path, '-'], { maxBuffer: 32 * 1024 * 1024 });
        const r = tokenRecall(f.keyTokens, stdout);
        check.recall = r.recall;
        check.missing = r.missing;
        if (r.recall < 1) problems.push(`text layer misses key values: ${r.missing.join(', ')}`);
      } else {
        if (textChars > 20) problems.push(`scanned PDF unexpectedly has ${textChars} text-layer chars`);
        const r = tokenRecall(f.keyTokens, image ? await ocrImage(path) : await ocrPdf(path));
        check.recall = r.recall;
        check.missing = r.missing;
        if (r.recall < MIN_OCR_RECALL) problems.push(`OCR recall ${(r.recall * 100).toFixed(0)}% < ${MIN_OCR_RECALL * 100}%`);
      }
      check.ok = problems.length === 0;
      out.push(check);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 ? resolve(process.argv[i + 1]) : join(root, 'samples/synthetic');
  const o = process.argv.indexOf('--only');
  const only = o > 0 ? (process.argv[o + 1] ?? '').split(',').filter(Boolean) : undefined;
  const results = await selfCheck(dir, only);
  for (const r of results) {
    const recall = r.recall === undefined ? '' : ` recall ${(r.recall * 100).toFixed(0)}%`;
    const miss = r.missing && r.missing.length > 0 ? ` missing [${r.missing.join(' | ')}]` : '';
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.shipment}/${r.file} (${r.source}) text-layer chars ${r.textChars}${recall}${miss}`);
    for (const p of r.problems) console.log(`       ✗ ${p}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
