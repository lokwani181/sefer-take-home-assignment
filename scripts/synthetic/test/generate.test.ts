import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate, MANIFEST_FILE } from '../generate.js';
import { selfCheck } from '../self-check.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SYNTH = join(REPO, 'samples/synthetic');

describe('generator determinism', () => {
  let dirA = '';
  let dirB = '';
  beforeAll(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'synth-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'synth-b-'));
  });
  afterAll(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('two runs produce byte-identical files, identical to the committed samples', async () => {
    const a = await generate({ outDir: dirA });
    expect(a.errors).toEqual([]);
    const b = await generate({ outDir: dirB });
    expect(b.errors).toEqual([]);
    const manifestA = readFileSync(join(dirA, MANIFEST_FILE), 'utf8');
    expect(readFileSync(join(dirB, MANIFEST_FILE), 'utf8')).toBe(manifestA);
    expect(readFileSync(join(SYNTH, MANIFEST_FILE), 'utf8')).toBe(manifestA);
    // s1–s3: 2 documents + expected.json each; s4, s5: 3 documents + expected.json each.
    expect(manifestA.trim().split('\n')).toHaveLength(17);
  });
});

describe('self-check on the committed samples', () => {
  it('text PDFs have a text layer, scans and photos have none, and OCR reads ≥ 70% of key values', async () => {
    const results = await selfCheck(SYNTH);
    expect(results).toHaveLength(12);
    for (const r of results) {
      expect(r.problems, `${r.shipment}/${r.file}`).toEqual([]);
      if (r.source === 'text') expect(r.textChars).toBeGreaterThan(200);
      else expect(r.textChars).toBeLessThanOrEqual(20);
    }
  });
});
