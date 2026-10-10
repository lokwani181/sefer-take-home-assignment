/**
 * Generalization report (no assertions): runs the full pipeline (real ingest/OCR) over every
 * synthetic shipment in samples/synthetic/<id>/ and prints a pass/fail matrix against its
 * expected.json (validated with scripts/synthetic/expected-schema.ts).
 *
 *   cd server && npx tsx test/integration/synthetic-report.ts [--json out.json] [id ...]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineResult, UploadedFile } from '@app/shared';
import { validateExpected, type ExpectedShipment } from '../../../scripts/synthetic/expected-schema';
import { ShipmentStore, runPipeline } from '../../src/pipeline';
import { configureHtsClient } from '../../src/reference';
import { ROOT } from './golden';

export interface Check {
  group: string;
  name: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

const SYNTH_DIR = join(ROOT, 'samples', 'synthetic');

const norm = (s: unknown) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
/** Names match when one normalized form contains the other (legal suffix / punctuation differences). */
const nameMatch = (a: unknown, b: unknown) => {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function compareShipment(exp: ExpectedShipment, r: PipelineResult): Check[] {
  const e = exp.expect;
  const checks: Check[] = [];
  const add = (group: string, name: string, expected: unknown, actual: unknown, pass: boolean) => checks.push({ group, name, expected, actual, pass });
  const inv = r.shipment.invoices[0];
  const h = r.entryModel.header;
  const t = r.shipment.transport;

  // Documents
  for (const f of exp.files) {
    const d = r.documents.find((x) => x.fileName === f.file);
    add('docs', `${f.file} type`, f.docType, d?.docType, d?.docType === f.docType);
    add('docs', `${f.file} source`, f.source, d?.source, d?.source === f.source);
  }

  // Header
  add('header', 'invoiceNumber', e.invoiceNumber, inv?.invoiceNumber.value, inv?.invoiceNumber.value === e.invoiceNumber);
  const invNo = r.entryModel.invoices[0]?.invoiceNo;
  add('header', 'invoiceNumberNormalized', e.invoiceNumberNormalized, invNo, invNo === e.invoiceNumberNormalized);
  if (e.invoiceDate) add('header', 'invoiceDate', e.invoiceDate, inv?.invoiceDate?.value, inv?.invoiceDate?.value === e.invoiceDate);
  add('header', 'currency', e.currency, inv?.currency, (inv?.currency ?? '').toUpperCase() === e.currency);
  add('header', 'incoterm.code', e.incoterm.code, inv?.incoterm?.code, inv?.incoterm?.code === e.incoterm.code);
  add('header', 'incoterm.place', e.incoterm.place, inv?.incoterm?.place, nameMatch(inv?.incoterm?.place, e.incoterm.place));
  const seller = r.shipment.seller?.name ?? inv?.seller?.name;
  add('header', 'sellerName', e.sellerName, seller, nameMatch(seller, e.sellerName));
  add('header', 'buyerName', e.buyerName, inv?.buyer?.name, nameMatch(inv?.buyer?.name, e.buyerName));
  add('header', 'importerName', e.importerName, h.importerName, nameMatch(h.importerName, e.importerName));
  if (e.ultimateConsigneeName) {
    const uc = h.ultimateConsignee?.consigneeName ?? r.shipment.ultimateConsignee?.value.name;
    add('header', 'ultimateConsigneeName', e.ultimateConsigneeName, uc, nameMatch(uc, e.ultimateConsigneeName));
  }
  add('header', 'transport.mode', e.transport.mode, t.mode, t.mode === e.transport.mode);
  add('header', 'modeTransportation', e.transport.modeTransportation, h.modeTransportation, h.modeTransportation === e.transport.modeTransportation);
  if (e.transport.entryPort) add('header', 'entryPort', e.transport.entryPort, h.entryPort, h.entryPort === e.transport.entryPort);
  if (e.transport.containers) {
    const got = r.entryModel.containers.map((c) => c.containerNumber);
    add('header', 'containers', e.transport.containers, got, eq(got, e.transport.containers));
  }
  if (e.transport.bills) {
    const got = r.entryModel.manifest.billsOfLading.map((b) => ({
      ...(b.masterScac ? { masterScac: b.masterScac } : {}),
      ...(b.masterBill ? { masterBill: b.masterBill } : {}),
      ...(b.houseScac ? { houseScac: b.houseScac } : {}),
      ...(b.houseBill ? { houseBill: b.houseBill } : {}),
    }));
    e.transport.bills.forEach((b, i) => {
      for (const [k, v] of Object.entries(b)) {
        const actual = (got[i] as Record<string, string> | undefined)?.[k];
        add('header', `bills[${i}].${k}`, v, actual, actual === v);
      }
    });
  }
  add('header', 'grossWeightKg', e.transport.grossWeightKg, h.grossWeight, h.grossWeight === Math.round(e.transport.grossWeightKg));

  // Lines
  const items = r.entryModel.invoices.flatMap((i) => i.lineItems);
  const shipLines = r.shipment.invoices.flatMap((i) => i.lines);
  add('lines', 'line count', e.lines.length, shipLines.length, shipLines.length === e.lines.length);
  for (const l of e.lines) {
    const id = `inv0-line${l.lineNo}`;
    const sl = shipLines.find((x) => x.id === id);
    const li = items.find((x) => x.lineId === id);
    const val = r.valuations.find((v) => v.lineId === id)?.enteredValue;
    add(`line ${l.lineNo}`, 'value', l.enteredValue, val, val === l.enteredValue);
    add(`line ${l.lineNo}`, 'origin', l.countryOfOrigin, li?.countryOrigin, li?.countryOrigin === l.countryOfOrigin);
    const hs6 = l.hs6 ?? l.hs6Truth;
    const tariff = li?.tariffs[0]?.tariffNo;
    add(`line ${l.lineNo}`, l.hs6 ? 'hs6' : 'hs6 (truth, not printed)', hs6, tariff, !!tariff && tariff.slice(0, 6) === hs6);
    add(`line ${l.lineNo}`, 'quantity', l.quantity, sl?.quantity.value, sl?.quantity.value === l.quantity);
    add(`line ${l.lineNo}`, 'unitPrice', l.unitPrice, sl?.unitPrice, sl?.unitPrice === l.unitPrice);
    const printed = sl?.printedAmount ?? sl?.amount.value;
    add(`line ${l.lineNo}`, 'printedAmount', l.printedAmount, printed, printed === l.printedAmount);
    const desc = [sl?.description ?? '', ...(sl?.details ?? [])].join(' ');
    add(`line ${l.lineNo}`, 'descriptionContains', l.descriptionContains, sl?.description, desc.toUpperCase().includes(l.descriptionContains.toUpperCase()));
  }
  const total = r.valuations.reduce((s, v) => s + v.enteredValue, 0);
  add('lines', 'totalEnteredValue', e.totalEnteredValue, total, total === e.totalEnteredValue);

  // Issues
  const codes = new Set(r.issues.map((i) => i.code));
  for (const c of e.issuesInclude) add('issuesInclude', c, true, codes.has(c), codes.has(c));
  for (const c of e.issuesExclude) {
    const hits = r.issues.filter((i) => i.code === c).map((i) => i.id);
    add('issuesExclude', c, [], hits, hits.length === 0);
  }
  add('xsd', 'XSD valid', true, r.xsdValidation.valid, r.xsdValidation.valid);
  return checks;
}

/** The mime a browser would send for this file name (ingest still sniffs the bytes). */
export function mimeFor(file: string): string {
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg';
  if (/\.png$/i.test(file)) return 'image/png';
  return 'application/pdf';
}

async function runOne(id: string): Promise<{ id: string; checks: Check[]; result: PipelineResult; ms: number }> {
  const dir = join(SYNTH_DIR, id);
  const parsed = validateExpected(JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')));
  if (!parsed.ok) throw new Error(`${id}/expected.json invalid: ${parsed.errors.join('; ')}`);
  const exp = parsed.value;
  const files: UploadedFile[] = await Promise.all(
    exp.files.map(async (f) => ({ name: f.file, mime: mimeFor(f.file), bytes: new Uint8Array(await readFile(join(dir, f.file))) })),
  );
  const t0 = performance.now();
  const result = await runPipeline(files, {}, { store: new ShipmentStore(1) });
  return { id, checks: compareShipment(exp, result), result, ms: Math.round(performance.now() - t0) };
}

async function main(): Promise<void> {
  configureHtsClient({ offline: process.env.HTS_OFFLINE !== '0' });
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args.splice(jsonIdx, 2)[1] : undefined;
  const ids = args.length ? args : (await readdir(SYNTH_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const all = [];
  for (const id of ids) {
    const run = await runOne(id);
    all.push(run);
    const failed = run.checks.filter((c) => !c.pass);
    console.log(`\n=== ${id}: ${run.checks.length - failed.length}/${run.checks.length} pass (${run.ms} ms)`);
    const groups = [...new Set(run.checks.map((c) => c.group))];
    for (const g of groups) {
      const cs = run.checks.filter((c) => c.group === g);
      const bad = cs.filter((c) => !c.pass);
      console.log(`  ${bad.length ? 'FAIL' : 'pass'}  ${g}: ${cs.length - bad.length}/${cs.length}`);
      for (const c of bad) console.log(`        ✗ ${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
    }
    console.log(`  issues: ${run.result.issues.map((i) => `${i.id}[${i.severity[0]}]`).join(' ')}`);
  }
  if (jsonOut) await writeFile(jsonOut, JSON.stringify(all.map(({ id, checks, ms }) => ({ id, ms, checks })), null, 2));
  const resultsDir = process.env.SYNTH_RESULTS_DIR;
  if (resultsDir) for (const run of all) await writeFile(join(resultsDir, `${run.id}.result.json`), JSON.stringify(run.result, null, 2));
}

if (process.argv[1] && /synthetic-report\.ts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
