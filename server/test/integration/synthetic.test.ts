/**
 * Generalization, asserted: every synthetic shipment in samples/synthetic/<id>/ (expected.json
 * validated by scripts/synthetic/expected-schema.ts) goes through the full pipeline with the REAL
 * ingest path (pdftotext / pdftoppm / tesseract, cold OCR cache in a temp dir) and offline HTS data,
 * and is compared with its hand-checked expectations using the same checks as the report script
 * (test/integration/synthetic-report.ts): documents, header fields, every line (value, origin, HS-6,
 * quantity, unit price, printed amount, description), issues that must / must not be raised, and
 * XSD validity of the generated entry.
 *
 * s4 and s5 were blind shipments: their pre-fix scores and the fixes are in docs/GENERALIZATION.md.
 * An expectation that still fails after an honest fix attempt goes into KNOWN_FAILURES (its group then
 * runs as it.fails with the reason), and is listed in docs/GENERALIZATION.md.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineResult, UploadedFile } from '@app/shared';
import { validateExpected, type ExpectedShipment } from '../../../scripts/synthetic/expected-schema';
import { createIngest } from '../../src/ingest';
import { ShipmentStore, runPipeline } from '../../src/pipeline';
import { configureHtsClient } from '../../src/reference';
import { ROOT } from './golden';
import { compareShipment, mimeFor, type Check } from './synthetic-report';

const SYNTH_DIR = join(ROOT, 'samples', 'synthetic');

/**
 * `${caseId} ${group}` → why the group still fails. Empty: every synthetic expectation passes.
 * Keep entries honest: only after a generic fix was attempted, never to hide a regression.
 */
const KNOWN_FAILURES: Record<string, string> = {};

const CASES = readdirSync(SYNTH_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SYNTH_DIR, d.name, 'expected.json')))
  .map((d) => d.name)
  .sort();

function loadExpected(id: string): ExpectedShipment {
  const parsed = validateExpected(JSON.parse(readFileSync(join(SYNTH_DIR, id, 'expected.json'), 'utf8')));
  if (!parsed.ok) throw new Error(`${id}/expected.json is invalid: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

const fmt = (c: Check) => `${c.group} / ${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`;

let cacheTmp: string;
let ingest: ReturnType<typeof createIngest>;

beforeAll(async () => {
  configureHtsClient({ offline: true });
  cacheTmp = await mkdtemp(join(tmpdir(), 'synthetic-ocr-'));
  ingest = createIngest({ cacheDir: cacheTmp });
});

afterAll(async () => {
  if (cacheTmp) await rm(cacheTmp, { recursive: true, force: true });
});

it('finds the synthetic shipments', () => {
  expect(CASES.length).toBeGreaterThanOrEqual(5);
});

describe.each(CASES)('%s', (id) => {
  const exp = loadExpected(id);
  let result: PipelineResult;
  let checks: Check[] = [];

  beforeAll(async () => {
    const files: UploadedFile[] = await Promise.all(
      exp.files.map(async (f) => ({ name: f.file, mime: mimeFor(f.file), bytes: new Uint8Array(await readFile(join(SYNTH_DIR, id, f.file))) })),
    );
    result = await runPipeline(files, {}, { ingest, store: new ShipmentStore(1) });
    checks = compareShipment(exp, result);
  }, 300_000);

  const groupTest = (group: string, title = group) => {
    const known = KNOWN_FAILURES[`${id} ${group}`];
    const body = () => {
      const mine = checks.filter((c) => c.group === group);
      expect(mine.length, `no checks ran for ${group}`).toBeGreaterThan(0);
      expect(mine.filter((c) => !c.pass).map(fmt)).toEqual([]);
    };
    if (known) it.fails(`${title} (known failure: ${known})`, body);
    else it(title, body);
  };

  groupTest('docs', 'documents: type and source (text layer vs OCR)');
  groupTest('header', 'header: invoice, parties, incoterm, transport, bills, gross weight');
  groupTest('lines', `lines: count ${exp.expect.lines.length} and total entered value ${exp.expect.totalEnteredValue}`);
  for (const l of exp.expect.lines) groupTest(`line ${l.lineNo}`, `line ${l.lineNo} (${l.styleNo ?? l.descriptionContains}): value, origin, HS-6, quantity, price, amount, description`);
  if (exp.expect.issuesInclude.length) groupTest('issuesInclude', `raises ${exp.expect.issuesInclude.join(', ')}`);
  groupTest('issuesExclude', 'raises none of the excluded issue codes');
  groupTest('xsd', 'entry XML is valid against entry.xsd');
});
