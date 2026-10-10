/**
 * Failure paths: missing binaries (paths injected to simulate), missing OCR language data,
 * unsupported or corrupt uploads, and the health probe.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOcrTools, createIngest, IngestError, MissingLanguageError, MissingToolError } from '../../src/ingest/index.js';

const SAMPLES = join(import.meta.dirname, '..', '..', '..', 'samples');
const pdf = (name: string) => ({ name, mime: 'application/pdf', bytes: new Uint8Array(readFileSync(join(SAMPLES, name))) });
const INVOICE = 'KBAS-NB-26-0912_Commercial_Invoice.pdf';
const SCAN = 'SPG-PL-2609-117_Packing_List.pdf';
const NOWHERE = '/nonexistent/bin';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-errors-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function failure(p: Promise<unknown>): Promise<IngestError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IngestError);
    return e as IngestError;
  }
  throw new Error('expected the ingest to fail');
}

function expectInstallHint(err: IngestError, tool: string) {
  expect(err).toBeInstanceOf(MissingToolError);
  expect(err.code).toBe('TOOL_MISSING');
  expect((err as MissingToolError).tool).toBe(tool);
  expect(err.message).toContain(`'${tool}'`);
  expect(err.message).toContain('brew install tesseract poppler');
  expect(err.message).toContain('apt-get install tesseract-ocr poppler-utils');
  expect(err.hint).toContain('brew install tesseract poppler');
}

describe('missing binaries', () => {
  it('names tesseract when a scanned page needs OCR', async () => {
    const ingest = createIngest({ cache: false, cacheDir: dir, tools: { tesseract: `${NOWHERE}/tesseract` } });
    expectInstallHint(await failure(ingest(pdf(SCAN))), 'tesseract');
  });

  it('names pdftotext for any PDF', async () => {
    const ingest = createIngest({ cache: false, cacheDir: dir, tools: { pdftotext: `${NOWHERE}/pdftotext` } });
    expectInstallHint(await failure(ingest(pdf(INVOICE))), 'pdftotext');
  });

  it('names pdftoppm when a page must be rasterized', async () => {
    const ingest = createIngest({ cache: false, cacheDir: dir, tools: { pdftoppm: `${NOWHERE}/pdftoppm` } });
    expectInstallHint(await failure(ingest(pdf(SCAN))), 'pdftoppm');
  });

  it('still ingests a text-layer PDF when only tesseract is missing', async () => {
    const ingest = createIngest({ cache: false, cacheDir: dir, tools: { tesseract: `${NOWHERE}/tesseract` } });
    const layout = await ingest(pdf(INVOICE));
    expect(layout.pages.every((p) => p.source === 'text')).toBe(true);
  });

  it('needs neither tesseract nor pdftoppm for a text PDF when page images are off', async () => {
    const ingest = createIngest({
      cache: false,
      cacheDir: dir,
      renderTextPages: false,
      tools: { tesseract: `${NOWHERE}/tesseract`, pdftoppm: `${NOWHERE}/pdftoppm` },
    });
    const layout = await ingest(pdf(INVOICE));
    expect(layout.pages.map((p) => p.imagePath)).toEqual([undefined, undefined]);
  });
});

describe('missing OCR language data', () => {
  it('raises a typed error with an install hint', async () => {
    const ingest = createIngest({ cache: false, cacheDir: dir, lang: 'zzz', stamps: false, secondPass: false });
    const err = await failure(ingest(pdf(SCAN)));
    expect(err).toBeInstanceOf(MissingLanguageError);
    expect(err.code).toBe('OCR_LANGUAGE_MISSING');
    expect(err.message).toContain("'zzz'");
  });
});

describe('bad uploads', () => {
  const ingest = () => createIngest({ cache: false, cacheDir: dir });

  it('rejects unsupported content regardless of the claimed type', async () => {
    const err = await failure(ingest()({ name: 'notes.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('just text') }));
    expect(err.code).toBe('UNSUPPORTED_FILE');
  });

  it('rejects empty files', async () => {
    const err = await failure(ingest()({ name: 'empty.png', mime: 'image/png', bytes: new Uint8Array() }));
    expect(err.code).toBe('BAD_INPUT');
  });

  it('reports a corrupt PDF as bad input, not a server failure', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj garbage\n%%EOF\n');
    const err = await failure(ingest()({ name: 'broken.pdf', mime: 'application/pdf', bytes }));
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain('broken.pdf');
  });

  it('reports an undecodable image as bad input', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const err = await failure(ingest()({ name: 'broken.png', mime: 'image/png', bytes }));
    expect(err.code).toBe('BAD_INPUT');
  });
});

describe('checkOcrTools', () => {
  it('reports installed tools with versions', async () => {
    const status = await checkOcrTools();
    expect(status.ok).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.tesseract).toMatch(/^\d+\.\d+/);
    expect(status.pdftoppm).toMatch(/^\d+\.\d+/);
    expect(status.pdftotext).toMatch(/^\d+\.\d+/);
  });

  it('lists what is missing without throwing', async () => {
    const status = await checkOcrTools({ tesseract: `${NOWHERE}/tesseract`, pdftoppm: `${NOWHERE}/pdftoppm` });
    expect(status.ok).toBe(false);
    expect(status.missing).toEqual(['tesseract', 'pdftoppm']);
    expect(status.tesseract).toBeUndefined();
    expect(status.pdftotext).toMatch(/^\d+\.\d+/);
  });
});
