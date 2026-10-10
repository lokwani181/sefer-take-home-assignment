/**
 * Core of the synthetic-shipment generator: renders every document, simulates scans,
 * validates and writes expected.json, and records a SHA-256 manifest so reruns can be compared.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { checkConsistency } from './consistency.js';
import { validateExpected, type ExpectedShipment } from './expected-schema.js';
import { photographPdf } from './photo.js';
import { countPdfPages, normalizePdf, renderHtmlToPdf } from './render-pdf.js';
import { scanPdf } from './scan.js';
import { SHIPMENTS } from './shipments/index.js';
import type { ShipmentSpec } from './spec.js';

export const MANIFEST_FILE = 'SHA256SUMS';

export interface GeneratedFile {
  /** Path relative to the output directory, e.g. "s1-air-eur-fca/expected.json". */
  path: string;
  sha256: string;
  bytes: number;
}

export interface GenerateResult {
  files: GeneratedFile[];
  errors: string[];
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Builds expected.json for a spec (files derived from the docs) and validates it with zod + consistency rules. */
export function buildExpected(spec: ShipmentSpec): { value?: ExpectedShipment; errors: string[] } {
  const raw = {
    ...spec.expected,
    files: spec.docs.map((d) => ({
      file: d.file,
      docType: d.docType,
      source: d.variant === 'text' ? 'text' : 'ocr',
      pages: d.pages,
      keyTokens: [...new Set(d.keyTokens)],
    })),
  };
  // Put `files` right after `description` for readability.
  const ordered = { id: raw.id, description: raw.description, files: raw.files, notes: raw.notes, expect: raw.expect };
  const r = validateExpected(ordered);
  if (!r.ok) return { errors: r.errors.map((m) => `${spec.id}/expected.json: ${m}`) };
  const consistency = checkConsistency(spec, r.value).map((m) => `${spec.id}: ${m}`);
  return { value: r.value, errors: consistency };
}

/** Removes previously generated PDFs/photos/expected.json from a shipment folder (keeps anything else). */
async function cleanShipmentDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) {
    if (/\.(pdf|jpe?g|png)$/i.test(f) || f === 'expected.json') await rm(join(dir, f), { force: true });
  }
}

/**
 * Generates all (or selected) shipments into `outDir`. Validation errors are collected and
 * returned rather than thrown so the CLI can print all of them before exiting non-zero.
 */
export async function generate(opts: { outDir: string; only?: string[]; log?: (msg: string) => void }): Promise<GenerateResult> {
  const log = opts.log ?? (() => {});
  const specs = SHIPMENTS.filter((s) => !opts.only || opts.only.includes(s.id));
  const files: GeneratedFile[] = [];
  const errors: string[] = [];

  // Validate everything first: never write PDFs for a spec whose ground truth is wrong.
  const expectedById = new Map<string, ExpectedShipment>();
  for (const spec of specs) {
    const { value, errors: errs } = buildExpected(spec);
    errors.push(...errs);
    if (value) expectedById.set(spec.id, value);
  }
  if (errors.length > 0) return { files, errors };

  const browser = await chromium.launch();
  try {
    for (const spec of specs) {
      const dir = join(opts.outDir, spec.id);
      await cleanShipmentDir(dir);
      for (const doc of spec.docs) {
        const t0 = Date.now();
        const clean = await renderHtmlToPdf(browser, doc.html, doc.format);
        const pages = await countPdfPages(clean);
        if (pages !== doc.pages) errors.push(`${spec.id}/${doc.file}: rendered ${pages} page(s), spec says ${doc.pages}`);
        const meta = {
          title: doc.meta.title,
          author: doc.meta.author,
          creator: doc.variant === 'scan' ? 'make-synthetic.ts (simulated scan)' : 'make-synthetic.ts (HTML template)',
        };
        let bytes: Uint8Array;
        if (doc.variant === 'photo') {
          if (!doc.photo) throw new Error(`${spec.id}/${doc.file}: photo variant without photo options`);
          if (!/\.jpe?g$/i.test(doc.file)) throw new Error(`${spec.id}/${doc.file}: photo variant must be written as .jpg`);
          bytes = await photographPdf(clean, doc.photo);
        } else {
          bytes = doc.variant === 'scan' && doc.scan ? await scanPdf(clean, doc.scan, meta) : await normalizePdf(clean, meta);
        }
        await writeFile(join(dir, doc.file), bytes);
        files.push({ path: `${spec.id}/${doc.file}`, sha256: sha256(bytes), bytes: bytes.length });
        log(`  ${spec.id}/${doc.file}  ${doc.variant}  ${pages}p  ${(bytes.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`);
      }
      const json = `${JSON.stringify(expectedById.get(spec.id), null, 2)}\n`;
      await writeFile(join(dir, 'expected.json'), json);
      files.push({ path: `${spec.id}/expected.json`, sha256: sha256(json), bytes: Buffer.byteLength(json) });
    }
  } finally {
    await browser.close();
  }

  if (!opts.only) {
    const manifest = [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `${f.sha256}  ${f.path}`)
      .join('\n');
    await writeFile(join(opts.outDir, MANIFEST_FILE), `${manifest}\n`);
  }
  return { files, errors };
}
