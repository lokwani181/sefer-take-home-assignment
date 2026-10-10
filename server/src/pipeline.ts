/**
 * Orchestration (T8): uploaded files → PipelineResult.
 *
 *   ingest (parallel) → parse → reconcile → classify (+ alternative compositions)
 *   → [hts overrides] → assemble → XML → XSD validation → SOAP preview
 *
 * Results are kept in an in-memory LRU so a broker can flip decisions or fill in broker inputs
 * and regenerate the entry without re-running OCR, parsing, reconciliation or classification.
 */
import { randomUUID } from 'node:crypto';
import {
  DECISION_KEYS,
  type BrokerInputs,
  type ClassifyLineFn,
  type DocumentLayout,
  type DocumentSummary,
  type ExtractedDocument,
  type IngestFn,
  type Issue,
  type IssueSeverity,
  type LineClassification,
  type PipelineResult,
  type Shipment,
  type ShipmentLine,
  type UploadedFile,
} from '@app/shared';
import { ingest as defaultIngest } from './ingest/index.js';
import { parseDocument } from './parse/index.js';
import { reconcile } from './reconcile/index.js';
import { classifyAsHts, classifyLine, lookups } from './reference/index.js';
import { assembleEntry, buildEntryXml, buildUploadEnvelope, validateEntryXml } from './netchb/index.js';

export interface PipelineOptions {
  /** Ingest implementation (tests inject one with bogus tool paths, or a fixture loader). */
  ingest?: IngestFn;
  /** Classifier (defaults to the reference module). */
  classify?: ClassifyLineFn;
  /** HTS override classifier for `hts:<lineId>` decisions. */
  classifyOverride?: (line: ShipmentLine, htsNumber: string) => Promise<LineClassification>;
  /** Where to keep the result for regenerate / page images. Defaults to the process-wide store. */
  store?: ShipmentStore;
  now?: () => Date;
}

/** Everything regenerate() needs, plus the layouts for page images. */
export interface StoredShipment {
  result: PipelineResult;
  layouts: DocumentLayout[];
  /** Issues exactly as reconcile emitted them (decisions at their policy defaults). */
  reconcileIssues: Issue[];
  /** hts override classifications already computed, keyed by `${lineId}:${htsNumber}`. */
  overrideCache: Map<string, LineClassification>;
}

// ── Store ──────────────────────────────────────────────────────────────────────

/** Small LRU keyed by shipmentId. Map iteration order = insertion order, so the first key is the oldest. */
export class ShipmentStore {
  private readonly items = new Map<string, StoredShipment>();

  constructor(readonly capacity = 50) {}

  get(id: string): StoredShipment | undefined {
    const item = this.items.get(id);
    if (item) {
      this.items.delete(id);
      this.items.set(id, item);
    }
    return item;
  }

  set(id: string, item: StoredShipment): void {
    this.items.delete(id);
    this.items.set(id, item);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

/** Process-wide store used by the API and CLI unless another one is passed. */
export const defaultStore = new ShipmentStore(50);

export class ShipmentNotFoundError extends Error {
  constructor(readonly shipmentId: string) {
    super(`Shipment ${shipmentId} was not found (results are kept in memory for the last 50 shipments).`);
    this.name = 'ShipmentNotFoundError';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<IssueSeverity, number> = { blocker: 0, warning: 1, info: 2 };

/** Blockers first, then warnings, then info; stable within a severity. */
export function sortIssues(issues: Issue[]): Issue[] {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] || a.index - b.index)
    .map((x) => x.issue);
}

function allLines(shipment: Shipment): ShipmentLine[] {
  return shipment.invoices.flatMap((inv) => inv.lines);
}

function summarize(doc: ExtractedDocument): DocumentSummary {
  return {
    docId: doc.docId,
    fileName: doc.fileName,
    docType: doc.docType,
    source: doc.source,
    pageCount: doc.pageCount,
    classificationScore: doc.classificationScore,
  };
}

const elapsed = (start: number) => Math.round((performance.now() - start) * 10) / 10;

/** Classifies every line, plus each line with a conflicting composition under that composition. */
async function classifyAll(
  shipment: Shipment,
  classify: ClassifyLineFn,
): Promise<{ classifications: Record<string, LineClassification>; altClassifications: Record<string, LineClassification> }> {
  const classifications: Record<string, LineClassification> = {};
  const altClassifications: Record<string, LineClassification> = {};
  const tasks: Promise<void>[] = [];
  for (const line of allLines(shipment)) {
    tasks.push(
      classify(line)
        .then((c) => {
          classifications[line.id] = c;
        })
        .catch((err: unknown) => {
          // Assembly turns a line without a classification into a blocker; one bad line must not sink the entry.
          console.error(`[pipeline] classification of ${line.id} failed:`, err);
        }),
    );
    if (line.altComposition?.length) {
      tasks.push(
        classify(line, { composition: line.altComposition })
          .then((c) => {
            altClassifications[line.id] = c;
          })
          .catch((err: unknown) => {
            console.error(`[pipeline] alternative classification of ${line.id} failed:`, err);
          }),
      );
    }
  }
  await Promise.all(tasks);
  return { classifications, altClassifications };
}

/**
 * Resolves `hts:<lineId>` broker decisions to full classifications (rate, units, category) before
 * assembly, which is synchronous. Unknown lines and malformed numbers are left to assembly to report.
 */
async function resolveOverrides(
  shipment: Shipment,
  decisions: Record<string, string> | undefined,
  cache: Map<string, LineClassification>,
  classifyOverride: NonNullable<PipelineOptions['classifyOverride']>,
): Promise<Record<string, LineClassification>> {
  const out: Record<string, LineClassification> = {};
  const lines = new Map(allLines(shipment).map((l) => [l.id, l]));
  const tasks: Promise<void>[] = [];
  for (const [key, value] of Object.entries(decisions ?? {})) {
    if (!key.startsWith('hts:')) continue;
    const lineId = key.slice('hts:'.length);
    const line = lines.get(lineId);
    const digits = String(value ?? '').replace(/[\s.]/g, '');
    if (!line || key !== DECISION_KEYS.hts(lineId) || !/^\d{10}$/.test(digits)) continue;
    const memoKey = `${lineId}:${digits}`;
    const hit = cache.get(memoKey);
    if (hit) {
      out[lineId] = hit;
      continue;
    }
    tasks.push(
      classifyOverride(line, digits)
        .then((c) => {
          cache.set(memoKey, c);
          out[lineId] = c;
        })
        .catch((err: unknown) => {
          console.error(`[pipeline] override classification ${memoKey} failed:`, err);
        }),
    );
  }
  await Promise.all(tasks);
  return out;
}

function xsdIssue(errors: string[]): Issue {
  const shown = errors.slice(0, 8);
  return {
    id: 'XSD_INVALID',
    code: 'XSD_INVALID',
    severity: 'blocker',
    category: 'format',
    title: 'Entry XML does not pass NetCHB schema validation',
    detail: `xmllint reported ${errors.length} error${errors.length === 1 ? '' : 's'} against entry.xsd: ${shown.join(' | ')}${
      errors.length > shown.length ? ` | … ${errors.length - shown.length} more` : ''
    }`,
    evidence: [],
    action: 'Resolve the blockers above (usually a missing required value such as the port or invoice number) and regenerate; NetCHB rejects XML that fails its schema.',
    field: 'xml',
  };
}

interface AssembleState {
  shipment: Shipment;
  reconcileIssues: Issue[];
  classifications: Record<string, LineClassification>;
  altClassifications: Record<string, LineClassification>;
  overrideCache: Map<string, LineClassification>;
}

type AssembledPart = Pick<
  PipelineResult,
  'issues' | 'valuations' | 'entryModel' | 'xml' | 'soapEnvelope' | 'xsdValidation' | 'estimates' | 'brokerInputs'
>;

/** Override classification → assembly → XML → XSD validation → SOAP preview. Shared by run and regenerate. */
async function assembleAndRender(
  state: AssembleState,
  brokerInputs: BrokerInputs,
  opts: PipelineOptions,
  timings: Record<string, number>,
): Promise<AssembledPart> {
  let t = performance.now();
  const overrideClassifications = await resolveOverrides(
    state.shipment,
    brokerInputs.decisions,
    state.overrideCache,
    opts.classifyOverride ?? classifyAsHts,
  );
  timings.overrides = elapsed(t);

  t = performance.now();
  const assembled = assembleEntry({
    shipment: state.shipment,
    classifications: state.classifications,
    altClassifications: state.altClassifications,
    overrideClassifications,
    brokerInputs,
    issues: state.reconcileIssues,
    lookups,
  });
  timings.assemble = elapsed(t);

  t = performance.now();
  const xml = buildEntryXml(assembled.entryModel);
  timings.xml = elapsed(t);

  t = performance.now();
  const xsdValidation = await validateEntryXml(xml);
  timings.validate = elapsed(t);

  const issues = [...assembled.issues];
  if (!xsdValidation.valid) issues.push(xsdIssue(xsdValidation.errors));

  return {
    issues: sortIssues(issues),
    valuations: assembled.valuations,
    entryModel: assembled.entryModel,
    xml,
    soapEnvelope: buildUploadEnvelope(xml),
    xsdValidation,
    estimates: assembled.estimates,
    brokerInputs,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Runs the whole pipeline over the uploaded documents and stores the result for regenerate(). */
export async function runPipeline(files: UploadedFile[], brokerInputs: BrokerInputs = {}, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const timings: Record<string, number> = {};
  const start = performance.now();
  const ingestFn = opts.ingest ?? defaultIngest;

  let t = performance.now();
  const ingested = await Promise.all(files.map((f) => ingestFn(f)));
  // The same bytes uploaded twice would double every quantity; keep the first copy.
  const seen = new Set<string>();
  const layouts = ingested.filter((l) => (seen.has(l.docId) ? false : (seen.add(l.docId), true)));
  timings.ingest = elapsed(t);

  return processLayouts(layouts, brokerInputs, opts, timings, start);
}

/** Pipeline from already-ingested layouts (fixture path, tests, tooling). Stores the result too. */
export async function runPipelineOnLayouts(
  layouts: DocumentLayout[],
  brokerInputs: BrokerInputs = {},
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  return processLayouts(layouts, brokerInputs, opts, { ingest: 0 }, performance.now());
}

async function processLayouts(
  layouts: DocumentLayout[],
  brokerInputs: BrokerInputs,
  opts: PipelineOptions,
  timings: Record<string, number>,
  start: number,
): Promise<PipelineResult> {
  let t = performance.now();
  const extracted = layouts.map((l) => parseDocument(l));
  timings.parse = elapsed(t);

  t = performance.now();
  const { shipment, issues: reconcileIssues } = reconcile(extracted);
  timings.reconcile = elapsed(t);

  t = performance.now();
  const { classifications, altClassifications } = await classifyAll(shipment, opts.classify ?? classifyLine);
  timings.classify = elapsed(t);

  const state: AssembleState = { shipment, reconcileIssues, classifications, altClassifications, overrideCache: new Map() };
  const part = await assembleAndRender(state, brokerInputs, opts, timings);
  timings.total = elapsed(start);

  const result: PipelineResult = {
    shipmentId: randomUUID(),
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    documents: extracted.map(summarize),
    extracted,
    shipment,
    classifications,
    altClassifications,
    ...part,
    timingsMs: timings,
  };
  (opts.store ?? defaultStore).set(result.shipmentId, { result, layouts, reconcileIssues, overrideCache: state.overrideCache });
  return result;
}

/**
 * Re-assembles a stored shipment with new broker inputs / decisions. Reuses the extracted documents,
 * reconciled shipment, reconcile issues and classifications; only override classification,
 * assembly, XML and validation run again.
 */
export async function regenerate(shipmentId: string, brokerInputs: BrokerInputs = {}, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const store = opts.store ?? defaultStore;
  const stored = store.get(shipmentId);
  if (!stored) throw new ShipmentNotFoundError(shipmentId);
  const start = performance.now();
  const timings: Record<string, number> = {};
  const prev = stored.result;
  const part = await assembleAndRender(
    {
      shipment: prev.shipment,
      reconcileIssues: stored.reconcileIssues,
      classifications: prev.classifications,
      altClassifications: prev.altClassifications,
      overrideCache: stored.overrideCache,
    },
    brokerInputs,
    opts,
    timings,
  );
  timings.total = elapsed(start);
  const result: PipelineResult = { ...prev, ...part, timingsMs: { ...prev.timingsMs, regenerate: timings.total, ...prefixed(timings) } };
  store.set(shipmentId, { ...stored, result });
  return result;
}

function prefixed(timings: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(timings).map(([k, v]) => [`regenerate.${k}`, v]));
}

/** The stored result and layouts for a shipment, if still in memory. */
export function getShipment(shipmentId: string, store: ShipmentStore = defaultStore): StoredShipment | undefined {
  return store.get(shipmentId);
}
