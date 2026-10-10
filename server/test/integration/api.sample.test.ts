/**
 * End-to-end through the HTTP API with the three real sample PDFs and the REAL ingest path
 * (pdftotext / pdftoppm / tesseract). The ingest cache points at a fresh temp directory, so every
 * run exercises the cold OCR path; HTS lookups use the committed data only (offline).
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrokerInputs, HealthResponse, PipelineResult } from '@app/shared';
import { createApp } from '../../src/api/app';
import { createIngest } from '../../src/ingest';
import { ShipmentStore } from '../../src/pipeline';
import { configureHtsClient } from '../../src/reference';
import { golden, goldenSuite, issueById, SAMPLE_PDFS, SAMPLES_DIR } from './golden';

let cacheTmp: string;
let cacheDir: string;
let app: ReturnType<typeof createApp>;
let store: ShipmentStore;
let result: PipelineResult;
let uploadMs = 0;

async function sampleFiles(): Promise<{ name: string; bytes: Buffer }[]> {
  return Promise.all(SAMPLE_PDFS.map(async (name) => ({ name, bytes: await readFile(join(SAMPLES_DIR, name)) })));
}

beforeAll(async () => {
  configureHtsClient({ offline: true });
  cacheTmp = await mkdtemp(join(tmpdir(), 'integ-ocr-'));
  // A dot-directory like the default server/.cache/ocr (page images must still be served from it).
  cacheDir = join(cacheTmp, '.cache', 'ocr');
  store = new ShipmentStore(50);
  app = createApp({ ingest: createIngest({ cacheDir }), store, webDist: null });

  let req = request(app).post('/api/shipments');
  for (const f of await sampleFiles()) req = req.attach('files', f.bytes, { filename: f.name, contentType: 'application/pdf' });
  const t0 = performance.now();
  const res = await req;
  uploadMs = performance.now() - t0;
  if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  result = res.body as PipelineResult;
}, 180_000);

afterAll(async () => {
  if (cacheTmp) await rm(cacheTmp, { recursive: true, force: true });
});

async function regenerateVia(inputs: BrokerInputs): Promise<PipelineResult> {
  const res = await request(app).post(`/api/shipments/${result.shipmentId}/regenerate`).send({ brokerInputs: inputs });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as PipelineResult;
}

describe('POST /api/shipments with the sample PDFs (real OCR, cold cache)', () => {
  it('returns a complete PipelineResult', () => {
    expect(result.shipmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);
    expect(result.documents).toHaveLength(3);
    expect(result.extracted).toHaveLength(3);
    for (const k of ['ingest', 'parse', 'reconcile', 'classify', 'assemble', 'xml', 'validate', 'total']) {
      expect(typeof result.timingsMs[k], k).toBe('number');
    }
    const sources = Object.fromEntries(result.documents.map((d) => [d.docType, d.source]));
    expect(sources).toEqual({ commercial_invoice: 'text', packing_list: 'ocr', bill_of_lading: 'ocr' });
    console.log(`[integration] cold upload of 3 sample PDFs: ${Math.round(uploadMs)} ms; stages ${JSON.stringify(result.timingsMs)}`);
  });

  goldenSuite(() => result, regenerateVia);
});

describe('regenerate / stored results', () => {
  it('regenerate keeps the shipment id and runs well under 300 ms', async () => {
    await regenerateVia({}); // warm
    const t0 = performance.now();
    const r = await regenerateVia({ importerTaxId: '93-1234567', decisions: { 'quantity:inv0-line2': 'packed' } });
    const ms = performance.now() - t0;
    expect(r.shipmentId).toBe(result.shipmentId);
    expect(r.timingsMs.regenerate).toBeLessThan(300);
    expect(ms).toBeLessThan(300);
    console.log(`[integration] regenerate round trip: ${Math.round(ms)} ms (server ${r.timingsMs.regenerate} ms)`);
  });

  it('decisions sent next to brokerInputs are merged into them', async () => {
    const res = await request(app)
      .post(`/api/shipments/${result.shipmentId}/regenerate`)
      .send({ brokerInputs: {}, decisions: { 'amount:inv0-line1': 'printed' } });
    expect(res.status).toBe(200);
    const r = res.body as PipelineResult;
    expect(r.brokerInputs.decisions).toEqual({ 'amount:inv0-line1': 'printed' });
    expect(issueById(r, 'LINE_AMOUNT_MISMATCH:inv0-line1')?.decision?.chosen).toBe('printed');
  });

  it('an invalid broker input becomes a blocker, not a request error', async () => {
    const r = await regenerateVia({ importerTaxId: 'not-an-ein', paymentType: '4' });
    expect(issueById(r, 'MISSING_IMPORTER_ID')?.severity).toBe('blocker');
    expect(issueById(r, 'BROKER_INPUT_INVALID:paymentType')?.severity).toBe('blocker');
    expect(r.xsdValidation.valid).toBe(true);
  });

  it('a broker-entered arrival date clears ARRIVAL_ESTIMATED', async () => {
    expect(issueById(result, 'ARRIVAL_ESTIMATED')).toBeDefined();
    const r = await regenerateVia({ arrivalDate: '2026-10-15' });
    expect(issueById(r, 'ARRIVAL_ESTIMATED')).toBeUndefined();
    expect(r.entryModel.header.arrivalDate).toBe('2026-10-15');
  });

  it('GET /api/shipments/:id returns the latest stored result', async () => {
    const r = await regenerateVia(golden.brokerInputsClearBlockers.inputs);
    const res = await request(app).get(`/api/shipments/${result.shipmentId}`);
    expect(res.status).toBe(200);
    expect(res.body.shipmentId).toBe(result.shipmentId);
    expect(res.body.xml).toBe(r.xml);
  });

  it('serves page images for every page of every document', async () => {
    for (const doc of result.documents) {
      for (let page = 1; page <= doc.pageCount; page++) {
        const res = await request(app).get(`/api/shipments/${result.shipmentId}/documents/${doc.docId}/pages/${page}/image`);
        expect(res.status, `${doc.fileName} p${page}`).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/png/);
        expect((res.body as Buffer).subarray(1, 4).toString('latin1')).toBe('PNG');
      }
    }
  });

  it('?w=<px> serves a downscaled PNG (cached next to the page image); bad widths are 400s', async () => {
    const doc = result.documents.find((d) => d.source === 'ocr')!;
    const url = `/api/shipments/${result.shipmentId}/documents/${doc.docId}/pages/1/image`;
    const full = await request(app).get(url);
    const fullMeta = await sharp(full.body as Buffer).metadata();
    const small = await request(app).get(`${url}?w=800`);
    expect(small.status).toBe(200);
    expect(small.headers['content-type']).toMatch(/image\/png/);
    const meta = await sharp(small.body as Buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(Math.round((fullMeta.height! * 800) / fullMeta.width!));
    expect((small.body as Buffer).length).toBeLessThan((full.body as Buffer).length / 4);
    // the scaled copy is cached on disk and reused
    const cached = (await readdir(cacheDir, { recursive: true })).filter((f) => /\.w800\.png$/.test(String(f)));
    expect(cached).toHaveLength(1);
    const again = await request(app).get(`${url}?w=800`);
    expect(Buffer.compare(again.body as Buffer, small.body as Buffer)).toBe(0);
    // a width at or above the page width serves the original
    const big = await request(app).get(`${url}?w=${fullMeta.width! + 100}`);
    expect((await sharp(big.body as Buffer).metadata()).width).toBe(fullMeta.width);
    for (const w of ['abc', '0', '-5', '12.5', '99999']) {
      const bad = await request(app).get(`${url}?w=${w}`);
      expect(bad.status, w).toBe(400);
      expect(typeof bad.body.error).toBe('string');
    }
  });

  it('404s for unknown shipments, documents and pages', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const res of [
      await request(app).get(`/api/shipments/${unknown}`),
      await request(app).post(`/api/shipments/${unknown}/regenerate`).send({ brokerInputs: {} }),
      await request(app).get(`/api/shipments/${unknown}/documents/x/pages/1/image`),
      await request(app).get(`/api/shipments/${result.shipmentId}/documents/nope/pages/1/image`),
      await request(app).get(`/api/shipments/${result.shipmentId}/documents/${result.documents[0].docId}/pages/99/image`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('rejects malformed regenerate bodies with 400', async () => {
    const bad = await request(app).post(`/api/shipments/${result.shipmentId}/regenerate`).send({ brokerInputs: { bondType: { x: 1 } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Invalid request body');
    const notJson = await request(app).post(`/api/shipments/${result.shipmentId}/regenerate`).set('Content-Type', 'application/json').send('{oops');
    expect(notJson.status).toBe(400);
    expect(typeof notJson.body.error).toBe('string');
  });
});

describe('API errors', () => {
  it('GET /api/health reports the OCR tools', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    const body = res.body as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.missing).toEqual([]);
    expect(body.tools?.tesseract).toMatch(/^\d+\.\d+/);
    expect(body.tools?.pdftotext).toBeDefined();
    expect(body.tools?.pdftoppm).toBeDefined();
  });

  it('400 when no files are uploaded', async () => {
    const res = await request(app).post('/api/shipments').field('brokerInputs', '{}');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No files uploaded');
  });

  it('415 for a .txt upload', async () => {
    const res = await request(app).post('/api/shipments').attach('files', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body.hint).toMatch(/PDF/);
  });

  it('415 when the content is not what the extension claims', async () => {
    const res = await request(app).post('/api/shipments').attach('files', Buffer.from('not really a pdf'), { filename: 'fake.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('Unsupported file');
  });

  it('400 for invalid brokerInputs JSON', async () => {
    const bytes = await readFile(join(SAMPLES_DIR, SAMPLE_PDFS[0]));
    const res = await request(app).post('/api/shipments').field('brokerInputs', '{not json').attach('files', bytes, SAMPLE_PDFS[0]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid brokerInputs');
  });

  it('applies brokerInputs sent with the upload', async () => {
    const bytes = await readFile(join(SAMPLES_DIR, SAMPLE_PDFS[0]));
    const res = await request(app)
      .post('/api/shipments')
      .field('brokerInputs', JSON.stringify({ importerTaxId: '93-1234567' }))
      .attach('files', bytes, SAMPLE_PDFS[0]);
    expect(res.status).toBe(200);
    const r = res.body as PipelineResult;
    expect(r.brokerInputs.importerTaxId).toBe('93-1234567');
    expect(issueById(r, 'MISSING_IMPORTER_ID')).toBeUndefined();
  });

  describe('with the OCR tools missing', () => {
    const bogus = { tesseract: '/nonexistent/bin/tesseract', pdftoppm: '/nonexistent/bin/pdftoppm', pdftotext: '/nonexistent/bin/pdftotext' };
    const broken = () => createApp({ tools: bogus, ingest: createIngest({ tools: bogus, cache: false }), store: new ShipmentStore(), webDist: null });

    it('health reports ok:false with the missing tools', async () => {
      const res = await request(broken()).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.missing).toEqual(expect.arrayContaining(['tesseract', 'pdftoppm', 'pdftotext']));
    });

    it('upload answers 503 with an install hint', async () => {
      const bytes = await readFile(join(SAMPLES_DIR, SAMPLE_PDFS[1]));
      const res = await request(broken()).post('/api/shipments').attach('files', bytes, SAMPLE_PDFS[1]);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/OCR tools/);
      expect(res.body.hint).toMatch(/brew install tesseract poppler/);
    });
  });

  it('unknown /api routes are JSON 404s', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
