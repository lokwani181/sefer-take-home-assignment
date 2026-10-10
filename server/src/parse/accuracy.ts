/**
 * Field-level accuracy harness: compares an extracted document with a ground-truth one.
 *
 * Why: parser quality has to be measured, not eyeballed — on the sample fixtures here and
 * on full pipeline runs later (end-to-end tests reuse this). Rules:
 *   numbers exact (±0.01); strings case/space-normalized; descriptions by similarity ≥ 0.85;
 *   addresses by name + country + postal code (or city) only; arrays as sets;
 *   lines aligned by line number (invoice) or style (packing list).
 * Critical fields are the ones that change the entry (values, quantities, origin, HS,
 * transport identifiers); a missing or wrong critical field counts against accuracy.
 */
import type { ExtractedDocument } from '@app/shared';
import { normalizePunct, similarity, squash } from './text';

export interface FieldComparison {
  field: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
  critical: boolean;
}

const DESCRIPTION_KEYS = new Set(['description', 'details', 'notes', 'remarks', 'cargoDescription', 'goodsDescription', 'raw', 'shippingMarks', 'text', 'title', 'issuerName', 'carrierName', 'alsoNotify', 'paymentTerms', 'containerSummary']);
const ADDRESS_KEYS = new Set(['seller', 'buyer', 'shipTo', 'manufacturer', 'shipper', 'consignee', 'notifyParty', 'deliverTo']);
const IGNORE_KEYS = new Set(['kind', 'raw', 'lines.raw']);

const CRITICAL: Record<string, RegExp[]> = {
  commercial_invoice: [
    /^invoiceNumber$/,
    /^lines\[\d+\]\.(styleNo|quantity|unit|unitPrice|amount|hsCode|countryOfOrigin|noCommercialValue|composition)$/,
    /^assists\[\d+\]\.(value|styleRefs)$/,
    /^charges\[\d+\]\.(type|amount)$/,
  ],
  packing_list: [/^lines\[\d+\]\.(cartons|pcsPerCarton|totalPcs|netWeightKg|grossWeightKg|netWeightPerCartonKg|grossWeightPerCartonKg|compositionRaw)$/, /^totals\./],
  bill_of_lading: [
    /^(blNumber|masterBlNumber|issuerScac|carrierScac|grossWeightKg|volumeCbm|vessel|voyage|portOfLoading|portOfDischarge|onBoardDate|releaseType)$/,
    /^packages\./,
    /^containers\[\d+\]\.(number|sealNumbers)$/,
  ],
  air_waybill: [/^(awbNumber|masterAwbNumber|grossWeightKg|pieces|airportOfDeparture|airportOfDestination|flight)$/],
  other: [],
};

/** Line fields that are compared even when the ground truth omits them (absence must be extracted as absence). */
const LINE_PRESENCE_KEYS: Record<string, string[]> = {
  commercial_invoice: ['countryOfOrigin', 'noCommercialValue'],
  packing_list: [],
};

function normStr(s: string): string {
  return squash(normalizePunct(s))
    .toUpperCase()
    .replace(/\s*([/,:;.\-()])\s*/g, '$1');
}

const LEGAL = /\b(?:LTD|LIMITED|INC|LLC|CO|COMPANY|CORP|CORPORATION|JSC|JOINT STOCK COMPANY|GMBH|PLC|PTE|PVT|SDN BHD)\b\.?/g;
function normName(s: string): string {
  return squash(normalizePunct(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(LEGAL, ' '));
}

function eqPrimitive(key: string, e: unknown, a: unknown): boolean {
  if (typeof e === 'number') return typeof a === 'number' && Math.abs(a - e) <= 0.01 + 1e-9;
  if (typeof e === 'boolean') return e ? a === true : !a;
  if (typeof e === 'string') {
    if (typeof a !== 'string') return false;
    if (DESCRIPTION_KEYS.has(key)) return similarity(normStr(e), normStr(a)) >= 0.85;
    return normStr(e) === normStr(a);
  }
  return JSON.stringify(e) === JSON.stringify(a);
}

function isCritical(kind: string, path: string): boolean {
  return (CRITICAL[kind] ?? []).some((re) => re.test(path));
}

function lastKey(path: string): string {
  const m = /([A-Za-z]+)(?:\[\d+\])?$/.exec(path);
  return m ? m[1] : path;
}

/** Compares two documents field by field. */
export function compareExtraction(actual: ExtractedDocument, expected: ExtractedDocument): FieldComparison[] {
  const rows: FieldComparison[] = [];
  const kind = expected.data.kind;
  const push = (field: string, e: unknown, a: unknown, ok: boolean, criticalOverride?: boolean) =>
    rows.push({ field, expected: e, actual: a, ok, critical: criticalOverride ?? isCritical(kind, field) });

  push('docType', expected.docType, actual.docType, expected.docType === actual.docType, true);
  if (actual.data.kind !== kind) {
    push('data.kind', kind, actual.data.kind, false, true);
    return rows;
  }

  const compareAddress = (path: string, e: Record<string, unknown>, a: Record<string, unknown> | undefined) => {
    const crit = isCritical(kind, path);
    const nameOk = !!a && typeof a.name === 'string' && similarity(normName(String(e.name)), normName(String(a.name))) >= 0.85;
    push(`${path}.name`, e.name, a?.name, nameOk, crit);
    push(`${path}.country`, e.country, a?.country, eqPrimitive('country', e.country, a?.country), crit);
    if (e.postalCode !== undefined) push(`${path}.postalCode`, e.postalCode, a?.postalCode, eqPrimitive('postalCode', e.postalCode, a?.postalCode), crit);
    else if (e.city !== undefined) {
      const ok = typeof a?.city === 'string' && similarity(normStr(String(e.city)), normStr(String(a.city))) >= 0.85;
      push(`${path}.city`, e.city, a?.city, ok, crit);
    }
  };

  const compareSet = (path: string, e: unknown[], a: unknown) => {
    const key = lastKey(path);
    const arr = Array.isArray(a) ? a : [];
    const asStr = (x: unknown) => (typeof x === 'object' ? JSON.stringify(x) : String(x));
    const match = (x: unknown, y: unknown) =>
      typeof x === 'object' && x !== null && 'fiber' in (x as object)
        ? (x as { fiber: string }).fiber === (y as { fiber?: string })?.fiber && Math.abs((x as { pct: number }).pct - ((y as { pct?: number })?.pct ?? NaN)) <= 0.01
        : typeof x === 'string' && typeof y === 'string'
          ? eqPrimitive(key, x, y)
          : asStr(x) === asStr(y);
    const allExpected = e.every((x) => arr.some((y) => match(x, y)));
    const noExtra = arr.every((y) => e.some((x) => match(x, y)));
    push(path, e, arr, allExpected && noExtra);
  };

  const walk = (path: string, e: unknown, a: unknown) => {
    const key = lastKey(path);
    if (IGNORE_KEYS.has(key) && path !== '') return;
    if (e === undefined) return;
    if (ADDRESS_KEYS.has(key) && e && typeof e === 'object' && !Array.isArray(e)) {
      compareAddress(path, e as Record<string, unknown>, a as Record<string, unknown> | undefined);
      return;
    }
    if (Array.isArray(e)) {
      if (key === 'lines') return compareLines(path, e, a);
      if (key === 'charges' && kind !== 'bill_of_lading' && kind !== 'air_waybill') return compareCharges(path, e, a);
      if (key === 'totals' && kind === 'commercial_invoice') return compareTotals(path, e, a);
      if (e.length && e.every((x) => x && typeof x === 'object' && !('fiber' in (x as object)))) {
        // arrays of objects: index alignment (containers, assists, candidates handled as sets)
        if (key === 'candidates') return compareSet(path, e.map((x) => `${(x as { checkDigitValid: boolean }).checkDigitValid}|${(x as { source: string }).source}|${(x as { number: string }).number}`), Array.isArray(a) ? a.map((x) => `${x.checkDigitValid}|${x.source}|${x.number}`) : []);
        e.forEach((x, i) => walk(`${path}[${i}]`, x, Array.isArray(a) ? a[i] : undefined));
        return;
      }
      return compareSet(path, e, a);
    }
    if (e && typeof e === 'object') {
      for (const [k, v] of Object.entries(e)) walk(path ? `${path}.${k}` : k, v, a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined);
      return;
    }
    push(path, e, a, eqPrimitive(key, e, a));
  };

  const compareLines = (path: string, e: unknown[], a: unknown) => {
    const act = Array.isArray(a) ? (a as Array<Record<string, unknown>>) : [];
    const used = new Set<number>();
    e.forEach((el, i) => {
      const exp = el as Record<string, unknown>;
      let j = -1;
      if (kind === 'commercial_invoice') j = act.findIndex((x, k) => !used.has(k) && x.lineNo === exp.lineNo);
      if (j < 0 && exp.styleNo) j = act.findIndex((x, k) => !used.has(k) && typeof x.styleNo === 'string' && normStr(x.styleNo) === normStr(String(exp.styleNo)));
      if (j < 0 && exp.cartonRange) j = act.findIndex((x, k) => !used.has(k) && x.cartonRange === exp.cartonRange);
      if (j < 0 && i < act.length && !used.has(i)) j = i;
      if (j >= 0) used.add(j);
      const actual = j >= 0 ? act[j] : undefined;
      const p = `${path}[${i}]`;
      if (!actual) push(p, exp.styleNo ?? exp.lineNo, undefined, false, true);
      walk(p, exp, actual);
      for (const k of LINE_PRESENCE_KEYS[kind] ?? []) {
        if (exp[k] === undefined) {
          const v = actual?.[k];
          push(`${p}.${k}`, undefined, v, v === undefined || v === false);
        }
      }
    });
    if (act.length > e.length) push(`${path}.length`, e.length, act.length, false, true);
  };

  const compareCharges = (path: string, e: unknown[], a: unknown) => {
    const act = Array.isArray(a) ? (a as Array<Record<string, unknown>>) : [];
    e.forEach((el, i) => {
      const exp = el as Record<string, unknown>;
      const m = act.find((x) => x.type === exp.type && Math.abs(Number(x.amount) - Number(exp.amount)) <= 0.01) ?? act.find((x) => x.type === exp.type);
      push(`${path}[${i}].type`, exp.type, m?.type, !!m);
      push(`${path}[${i}].amount`, exp.amount, m?.amount, !!m && eqPrimitive('amount', exp.amount, m.amount));
      push(`${path}[${i}].description`, exp.description, m?.description, !!m && eqPrimitive('description', exp.description, m.description));
    });
    if (act.length > e.length) push(`${path}.length`, e.length, act.length, false, (CRITICAL[kind] ?? []).some((re) => re.test(`${path}[0].amount`)));
  };

  const compareTotals = (path: string, e: unknown[], a: unknown) => {
    const act = Array.isArray(a) ? (a as Array<{ label: string; amount: number }>) : [];
    e.forEach((el, i) => {
      const exp = el as { label: string; amount: number };
      const m = act.find((x) => similarity(normStr(x.label), normStr(exp.label)) >= 0.85);
      push(`${path}[${i}]`, exp, m, !!m && Math.abs(m.amount - exp.amount) <= 0.01);
    });
  };

  walk('', expected.data, actual.data);
  return rows;
}

export interface AccuracySummary {
  total: number;
  ok: number;
  criticalTotal: number;
  criticalOk: number;
  /** 0–1 */
  criticalAccuracy: number;
  /** 0–1 */
  overallAccuracy: number;
  failures: FieldComparison[];
}

/** Aggregates comparison rows into accuracy figures. */
export function accuracySummary(rows: FieldComparison[]): AccuracySummary {
  const crit = rows.filter((r) => r.critical);
  const ok = rows.filter((r) => r.ok).length;
  const criticalOk = crit.filter((r) => r.ok).length;
  return {
    total: rows.length,
    ok,
    criticalTotal: crit.length,
    criticalOk,
    criticalAccuracy: crit.length ? criticalOk / crit.length : 1,
    overallAccuracy: rows.length ? ok / rows.length : 1,
    failures: rows.filter((r) => !r.ok),
  };
}
