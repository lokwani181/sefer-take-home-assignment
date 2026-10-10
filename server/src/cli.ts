/**
 * Headless pipeline run:
 *
 *   npm run cli -- <files...> [--out output/] [--inputs broker-inputs.json] [--decision key=value ...]
 *
 * Writes <out>/<normalized-invoice-no>.entry.xml and <out>/<normalized-invoice-no>.result.json and
 * prints a short summary. Exits 0 even when the entry has blockers (they are the expected output);
 * exits non-zero only when the pipeline itself cannot run.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { BrokerInputs, IssueSeverity, PipelineResult, UploadedFile } from '@app/shared';
import { IngestError } from './ingest/index.js';
import { normalizeInvoiceNo } from './netchb/index.js';
import { runPipeline } from './pipeline.js';
import { brokerInputsSchema } from './api/schemas.js';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

/** npm runs workspace scripts from server/; resolve user paths against where npm was invoked. */
const BASE_DIR = process.env.INIT_CWD || process.cwd();
const userPath = (p: string) => resolve(BASE_DIR, p);

const USAGE = 'Usage: npm run cli -- <files...> [--out output/] [--inputs broker-inputs.json] [--decision key=value ...]';

export interface CliArgs {
  files: string[];
  out: string;
  inputs?: string;
  decisions: Record<string, string>;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { files: [], out: 'output', decisions: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${USAGE}`);
      return v;
    };
    if (a === '--out' || a === '-o') args.out = value();
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a === '--inputs') args.inputs = value();
    else if (a.startsWith('--inputs=')) args.inputs = a.slice(9);
    else if (a === '--decision' || a.startsWith('--decision=')) {
      const kv = a === '--decision' ? value() : a.slice(11);
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new Error(`--decision expects key=value, got "${kv}"`);
      args.decisions[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--help' || a === '-h') throw new Error(USAGE);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}. ${USAGE}`);
    else args.files.push(a);
  }
  if (args.files.length === 0) throw new Error(USAGE);
  return args;
}

async function loadBrokerInputs(args: CliArgs): Promise<BrokerInputs> {
  let inputs: BrokerInputs = {};
  if (args.inputs) {
    const raw = JSON.parse(await readFile(userPath(args.inputs), 'utf8')) as unknown;
    const parsed = brokerInputsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${args.inputs}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    }
    inputs = parsed.data;
  }
  if (Object.keys(args.decisions).length) inputs = { ...inputs, decisions: { ...inputs.decisions, ...args.decisions } };
  return inputs;
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** Plain-text summary of a pipeline result (also used by the integration tests' report). */
export function formatSummary(result: PipelineResult, written: string[] = []): string {
  const out: string[] = [];
  out.push('Documents:');
  for (const d of result.documents) {
    out.push(`  ${d.fileName}  →  ${d.docType} (${d.source}, ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}, score ${d.classificationScore.toFixed(2)})`);
  }
  const counts: Record<IssueSeverity, number> = { blocker: 0, warning: 0, info: 0 };
  for (const i of result.issues) counts[i.severity]++;
  out.push(`Issues: ${counts.blocker} blocker${counts.blocker === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}, ${counts.info} info`);
  for (const sev of ['blocker', 'warning'] as const) {
    for (const i of result.issues.filter((x) => x.severity === sev)) out.push(`  [${sev.toUpperCase()}] ${i.title}  (${i.id})`);
  }
  const v = result.xsdValidation;
  out.push(`XSD: ${v.valid ? 'valid' : `INVALID (${v.errors.length} error${v.errors.length === 1 ? '' : 's'})`}`);
  if (!v.valid) for (const e of v.errors.slice(0, 5)) out.push(`  ${e}`);
  const total = result.entryModel.header.totalEntryValue;
  const currencies = [...new Set(result.shipment.invoices.map((i) => (i.currency || 'USD').toUpperCase()))];
  out.push(
    `Total entered value: ${total !== undefined ? `USD ${fmtUsd(total)}` : 'n/a'}${
      currencies.some((c) => c !== 'USD') ? ` (invoice currency: ${currencies.join(', ')})` : ''
    }; lines: ${result.valuations.map((l) => `${l.lineId}=${fmtUsd(l.enteredValue)}`).join(', ')}`,
  );
  out.push(`Timing: ${Object.entries(result.timingsMs).map(([k, ms]) => `${k} ${Math.round(ms)} ms`).join(', ')}`);
  if (written.length) out.push(`Wrote: ${written.join(', ')}`);
  return out.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const brokerInputs = await loadBrokerInputs(args);
  const files: UploadedFile[] = await Promise.all(
    args.files.map(async (p) => ({
      name: basename(p),
      mime: MIME_BY_EXT[extname(p).toLowerCase()] ?? 'application/octet-stream',
      bytes: new Uint8Array(await readFile(userPath(p))),
    })),
  );
  const result = await runPipeline(files, brokerInputs);

  const invoiceNo = result.entryModel.invoices[0]?.invoiceNo || normalizeInvoiceNo(result.shipment.invoices[0]?.invoiceNumber.value ?? '').value;
  const stem = invoiceNo || `shipment-${result.shipmentId.slice(0, 8)}`;
  const outDir = userPath(args.out);
  await mkdir(outDir, { recursive: true });
  const xmlPath = resolve(outDir, `${stem}.entry.xml`);
  const jsonPath = resolve(outDir, `${stem}.result.json`);
  await writeFile(xmlPath, result.xml, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(formatSummary(result, [xmlPath, jsonPath]));
}

const isMain = process.argv[1] && /cli\.(t|j)s$/.test(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    if (err instanceof IngestError) {
      console.error(`Error (${err.code}): ${err.message}${err.hint && !err.message.includes(err.hint) ? `\nHint: ${err.hint}` : ''}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  });
}
