/**
 * The same pipeline over the committed layout fixtures (server/test/fixtures/sample/*.layout.json,
 * raw un-deskewed OCR/text-layer word boxes) instead of live OCR. If a golden value fails here
 * too, the bug is in parse/reconcile/classify/assemble; if it fails only in api.sample.test.ts,
 * it is an OCR/ingest difference.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { BrokerInputs, Issue, PipelineResult } from '@app/shared';
import { regenerate, runPipeline, runPipelineOnLayouts, ShipmentNotFoundError, ShipmentStore, sortIssues } from '../../src/pipeline';
import { configureHtsClient } from '../../src/reference';
import { fixtureLayouts, goldenSuite } from './golden';

let store: ShipmentStore;
let result: PipelineResult;

beforeAll(async () => {
  configureHtsClient({ offline: true });
  store = new ShipmentStore(50);
  result = await runPipelineOnLayouts(fixtureLayouts(), {}, { store });
});

const regen = (inputs: BrokerInputs) => regenerate(result.shipmentId, inputs, { store });

describe('pipeline on the committed layout fixtures', () => {
  goldenSuite(() => result, regen);

  it('stores the layouts for page images and the result for regenerate', () => {
    const stored = store.get(result.shipmentId);
    expect(stored?.layouts.map((l) => l.docId)).toEqual(result.documents.map((d) => d.docId));
    expect(stored?.result.shipmentId).toBe(result.shipmentId);
  });

  it('regenerate reuses the stored extraction (same shipment object, no re-parse)', async () => {
    const r = await regen({ bondType: '08' });
    expect(r.extracted).toBe(result.extracted);
    expect(r.shipment).toBe(result.shipment);
    expect(r.classifications).toBe(result.classifications);
    expect(r.timingsMs.regenerate).toBeLessThan(300);
  });
});

describe('pipeline mechanics', () => {
  it('sortIssues orders blocker > warning > info and is stable', () => {
    const mk = (id: string, severity: Issue['severity']): Issue => ({ id, code: 'ISF', severity, category: 'compliance', title: id, detail: '', evidence: [], action: '' });
    const sorted = sortIssues([mk('a', 'info'), mk('b', 'warning'), mk('c', 'blocker'), mk('d', 'warning'), mk('e', 'blocker')]);
    expect(sorted.map((i) => i.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
  });

  it('ShipmentStore is an LRU of the most recent entries', () => {
    const s = new ShipmentStore(2);
    const item = { result } as unknown as Parameters<ShipmentStore['set']>[1];
    s.set('a', item);
    s.set('b', item);
    s.get('a'); // a is now the most recent
    s.set('c', item);
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
    expect(s.has('c')).toBe(true);
    expect(s.size).toBe(2);
  });

  it('regenerate of an unknown id throws ShipmentNotFoundError', async () => {
    await expect(regenerate('missing', {}, { store: new ShipmentStore() })).rejects.toBeInstanceOf(ShipmentNotFoundError);
  });

  it('the same document uploaded twice is processed once', async () => {
    const [invoice] = fixtureLayouts();
    const ingest = async () => invoice;
    const file = { name: 'a.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) };
    const r = await runPipeline([file, file], {}, { ingest, store: new ShipmentStore() });
    expect(r.documents).toHaveLength(1);
  });

  it('a classifier failure on one line leaves that line unclassified with a blocker, the rest continue', async () => {
    const { classifyLine } = await import('../../src/reference');
    const r = await runPipelineOnLayouts(fixtureLayouts(), {}, {
      store: new ShipmentStore(),
      classify: async (line, opts) => {
        if (line.id === 'inv0-line3') throw new Error('boom');
        return classifyLine(line, opts);
      },
    });
    expect(r.classifications['inv0-line3']).toBeUndefined();
    expect(r.issues.find((i) => i.id === 'HTS_LOW_CONFIDENCE:inv0-line3')?.severity).toBe('blocker');
    expect(r.classifications['inv0-line1']).toBeDefined();
  });

  it('adds an overall XSD_INVALID blocker when the XML fails validation', async () => {
    // Broker inputs are checked before use, so break the stored shipment instead: with no invoice
    // number, invoice-no is empty and the XML fails the schema.
    const store2 = new ShipmentStore();
    const r = await runPipelineOnLayouts(fixtureLayouts(), {}, { store: store2 });
    const stored = store2.get(r.shipmentId)!;
    const broken = structuredClone(r.shipment);
    broken.invoices[0].invoiceNumber.value = '';
    stored.result = { ...stored.result, shipment: broken };
    const r2 = await regenerate(r.shipmentId, {}, { store: store2 });
    expect(r2.xsdValidation.valid).toBe(false);
    const issue = r2.issues.find((i) => i.id === 'XSD_INVALID');
    expect(issue).toMatchObject({ code: 'XSD_INVALID', severity: 'blocker', category: 'format' });
    expect(issue?.detail).toMatch(/invoice-no/);
    expect(r2.issues[0].severity).toBe('blocker');
  });
});
