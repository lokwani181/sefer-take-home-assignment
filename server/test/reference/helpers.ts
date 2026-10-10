/** Test helpers: ShipmentLines built from the sample fixture and ad-hoc lines. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvoiceLine, LineAttributes, ShipmentLine } from '@app/shared';
import { configureHtsClient } from '../../src/reference/index.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'sample', 'invoice.expected.json');

/** Offline client reading only committed data (plus an empty temp runtime cache). */
export function useOfflineHts(): void {
  configureHtsClient({ offline: true, cacheDir: mkdtempSync(join(tmpdir(), 'hts-cache-')) });
}

export function lineFromInvoice(l: InvoiceLine, invoiceIndex = 0): ShipmentLine {
  return {
    id: `inv${invoiceIndex}-line${l.lineNo}`,
    invoiceIndex,
    invoiceLineNo: l.lineNo,
    styleNo: l.styleNo,
    description: l.description,
    details: l.details,
    hsCodeDeclared: l.hsCode,
    attributes: {
      composition: l.composition,
      compositionSource: 'invoice',
      construction: l.construction,
      gender: l.gender,
      garmentType: l.garmentType,
    },
    countryOfOrigin: { value: l.countryOfOrigin ?? 'VN', status: 'extracted', sources: [] },
    quantity: { value: l.quantity, status: 'extracted', sources: [] },
    unit: l.unit,
    unitPrice: l.unitPrice,
    amount: { value: l.amount ?? 0, status: 'extracted', sources: [] },
    noCommercialValue: !!l.noCommercialValue,
    customsValue: l.customsValue,
    assists: [],
  };
}

/** The five sample invoice lines keyed by style number. */
export function sampleLines(): Record<string, ShipmentLine> {
  const doc = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: { lines: InvoiceLine[] } };
  return Object.fromEntries(doc.data.lines.map((l) => [l.styleNo!, lineFromInvoice(l)]));
}

let n = 0;
/** A minimal line for rule tests. */
export function makeLine(description: string, hsCodeDeclared?: string, attributes: LineAttributes = {}, details: string[] = [], extra: Partial<ShipmentLine> = {}): ShipmentLine {
  n++;
  return {
    id: `test-line${n}`,
    invoiceIndex: 0,
    invoiceLineNo: n,
    description,
    details,
    hsCodeDeclared,
    attributes,
    countryOfOrigin: { value: 'CN', status: 'extracted', sources: [] },
    quantity: { value: 100, status: 'extracted', sources: [] },
    unit: 'PCS',
    amount: { value: 1000, status: 'extracted', sources: [] },
    noCommercialValue: false,
    assists: [],
    ...extra,
  };
}
