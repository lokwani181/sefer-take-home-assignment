/** One ShipmentInvoice per commercial invoice (or combined invoice + packing list) document. */
import type { CommercialInvoiceData, ExtractedDocument, InvoiceLine, Sourced, ShipmentInvoice, ShipmentLine } from '@app/shared';
import type { InvoiceSource } from '../context';
import { normalizeCharges } from '../lib/charges';
import { assessFobBasis } from '../lib/fob';
import { normIncoterm } from '../lib/incoterms';
import { isNum, round2 } from '../lib/num';
import { discountsDeducted } from '../lib/totals';
import { sourced } from './sourced';

const NCV_RE = /(?<![A-Z])(F\.?\s?O\.?\s?C|N\.?\s?C\.?\s?V)(?![A-Z])|free of charge|no commercial value|without commercial value|not for (?:re)?sale|no charge/i;
const BUYER_SUPPLIED_RE = /\b(supplied|provided|furnished|consigned)\b/i;

/** FOC / no-commercial-value line, flagged by the parser or by its own text (not "fabric supplied free of charge by buyer"). */
export function isNcvLine(li: InvoiceLine): boolean {
  if (li.noCommercialValue) return true;
  return [li.description, ...(li.details ?? [])].some((t) => !!t && NCV_RE.test(t) && !BUYER_SUPPLIED_RE.test(t));
}

const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'CNY', 'RMB', 'JPY', 'HKD', 'TWD', 'KRW', 'INR', 'VND', 'THB', 'IDR', 'MYR', 'SGD', 'AUD', 'CAD', 'CHF', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'TRY', 'PKR', 'BDT', 'LKR', 'PHP', 'KHR', 'NZD'];
const CURRENCY_RE = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`);

/** Currency named in totals/charges/notes when the header field wasn't read. */
export function inferCurrency(data: CommercialInvoiceData): string | undefined {
  const texts = [...(data.totals ?? []).map((t) => t.label), ...(data.charges ?? []).map((c) => c.description), ...(data.notes ?? [])];
  for (const t of texts) {
    const up = (t ?? '').toUpperCase();
    const m = CURRENCY_RE.exec(up);
    if (m) return m[1] === 'RMB' ? 'CNY' : m[1];
    if (/\bU\.?S\.?\s*DOLLARS?\b|\bUS\$/.test(up)) return 'USD';
    if (/\bEUROS?\b/.test(up)) return 'EUR';
  }
  return undefined;
}

const REL_NEG = /\b(?:not|non|un)[\s-]?(?:related|affiliated)\b|\bno relationship\b|\brelated part(?:y|ies)\s*[:-]?\s*(?:no|n)\b/i;
const REL_POS = /\brelated part(?:y|ies)\s*[:-]?\s*(?:yes|y)\b|\b(?:buyer|seller|importer|exporter|vendor|parties)\b[^.]{0,60}\b(?:are|is)\s+(?:related|affiliated)\b|\brelated[- ]party transaction\b/i;

/** Related-party status: printed flag, else a note that says so, else assumed false. */
export function resolveRelatedParty(doc: ExtractedDocument, data: CommercialInvoiceData): Sourced<boolean> {
  if (typeof data.relatedParty === 'boolean') return sourced(data.relatedParty, 'extracted', doc, ['relatedParty']);
  const notes = data.notes ?? [];
  const neg = notes.findIndex((n) => REL_NEG.test(n));
  if (neg >= 0) return sourced(false, 'extracted', doc, [`notes[${neg}]`], 'Invoice note states the parties are not related.');
  const pos = notes.findIndex((n) => REL_POS.test(n));
  if (pos >= 0) return sourced(true, 'extracted', doc, [`notes[${pos}]`], 'Invoice note states the parties are related.');
  return sourced(false, 'assumed', undefined, [], 'No document states whether buyer and seller are related; assumed not related.');
}

function lineNumbers(lines: InvoiceLine[]): number[] {
  const nos = lines.map((l, j) => (isNum(l.lineNo) && l.lineNo > 0 ? Math.round(l.lineNo) : j + 1));
  return new Set(nos).size === nos.length ? nos : lines.map((_, j) => j + 1);
}

function buildLine(doc: ExtractedDocument, data: CommercialInvoiceData, invIndex: number, j: number, lineNo: number): ShipmentLine {
  const li = data.lines[j];
  const p = `lines[${j}]`;
  const ncv = isNcvLine(li);
  const qty = isNum(li.quantity) && li.quantity > 0 ? li.quantity : undefined;
  const price = isNum(li.unitPrice) ? li.unitPrice : undefined;

  let amount: Sourced<number>;
  // NCV amounts are often printed in parentheses; credits keep their sign.
  if (isNum(li.amount)) amount = sourced(ncv ? Math.abs(li.amount) : li.amount, 'extracted', doc, [`${p}.amount`]);
  else if (qty !== undefined && price !== undefined) amount = sourced(round2(qty * price), 'derived', doc, [`${p}.quantity`, `${p}.unitPrice`], 'Amount not printed; quantity × unit price.');
  else if (isNum(li.customsValue)) amount = sourced(li.customsValue, 'derived', doc, [`${p}.customsValue`], 'Amount not printed; stated customs value.');
  else amount = sourced(0, 'assumed', undefined, [], 'No amount, unit price or value found for this line.');

  let customsValue = isNum(li.customsValue) ? Math.abs(li.customsValue) : undefined;
  if (ncv && customsValue === undefined && amount.value > 0) customsValue = amount.value;

  const line: ShipmentLine = {
    id: `inv${invIndex}-line${lineNo}`,
    invoiceIndex: invIndex,
    invoiceLineNo: lineNo,
    description: li.description ?? '',
    details: li.details ?? [],
    attributes: {},
    countryOfOrigin: sourced('', 'assumed', undefined),
    quantity: qty !== undefined ? sourced(qty, 'extracted', doc, [`${p}.quantity`]) : sourced(0, 'assumed', undefined, [], 'Quantity not found on the invoice.'),
    unit: (li.unit ?? '').toUpperCase(),
    amount,
    noCommercialValue: ncv,
    assists: [],
  };
  if (li.styleNo) line.styleNo = li.styleNo;
  if (li.hsCode) line.hsCodeDeclared = li.hsCode;
  if (price !== undefined) line.unitPrice = price;
  if (customsValue !== undefined) line.customsValue = customsValue;
  if (li.composition?.length) {
    line.attributes.composition = li.composition;
    line.attributes.compositionSource = 'invoice';
  }
  if (li.construction) line.attributes.construction = li.construction;
  if (li.gender) line.attributes.gender = li.gender;
  if (li.garmentType) line.attributes.garmentType = li.garmentType;
  if (data.poNumbers?.length === 1) line.poNumber = data.poNumbers[0];
  return line;
}

/** Build the ShipmentInvoice (lines without packing-list enrichment; see merge/lines). */
export function buildInvoiceSource(doc: ExtractedDocument, data: CommercialInvoiceData, index: number): InvoiceSource {
  const lines = data.lines ?? [];
  const nos = lineNumbers(lines);
  const shipLines = lines.map((_, j) => buildLine(doc, data, index, j, nos[j]));
  const printedCurrency = data.currency?.toUpperCase().trim();
  const inferred = printedCurrency ? undefined : inferCurrency(data);
  const currency = printedCurrency || inferred || 'USD';
  const code = normIncoterm(data.incoterm?.code);
  const fob = assessFobBasis(data, shipLines.map((l) => l.amount.value), shipLines.map((l) => l.noCommercialValue), currency);

  const invoice: ShipmentInvoice = {
    docId: doc.docId,
    invoiceNumber: sourced(data.invoiceNumber ?? '', data.invoiceNumber ? 'extracted' : 'assumed', doc, ['invoiceNumber']),
    currency,
    // 'other' charges typed from their description so the assembler deducts e.g. "US duties & fees".
    charges: normalizeCharges(data.charges),
    linesAreFob: fob.linesAreFob,
    printedTotals: data.totals ?? [],
    poNumbers: data.poNumbers ?? [],
    relatedParty: resolveRelatedParty(doc, data),
    lines: shipLines,
  };
  if (discountsDeducted(invoice.charges, invoice.printedTotals, shipLines.map((l) => l.amount.value), shipLines.map((l) => l.noCommercialValue))) invoice.discountsDeducted = true;
  if (data.invoiceDate) invoice.invoiceDate = sourced(data.invoiceDate, 'extracted', doc, ['invoiceDate']);
  if (data.incoterm && code) invoice.incoterm = { ...data.incoterm, code };
  if (data.seller) invoice.seller = data.seller;
  if (data.buyer) invoice.buyer = data.buyer;
  if (data.shipTo) invoice.shipTo = data.shipTo;

  // Per-line packing data makes it a packing list too; footer weight totals alone do not.
  const combined = doc.docType === 'invoice_packing_list' || lines.some((l) => isNum(l.cartons) || isNum(l.grossWeightKg) || isNum(l.netWeightKg));
  const src: InvoiceSource = { doc, data, index, combined, invoice };
  if (!printedCurrency) src.currencyInferred = inferred ? 'text' : 'assumed';
  return src;
}
