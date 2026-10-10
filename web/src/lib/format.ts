import type { DocType, IssueCategory, IssueSeverity, SourceStatus } from '@app/shared';

/** Display helpers shared by the result tabs. Pure functions, locale fixed to en-US for stable output. */

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$27,439" (whole) or "$5,100.22" (cents). */
export function formatUsd(value: number | undefined, cents = false): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  return (cents ? usd2 : usd0).format(value);
}

/** Signed money for valuation steps: "+$360.00", "−$177.60", "$0.00". */
export function formatSignedUsd(value: number): string {
  const abs = usd2.format(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

/** Number with thousands separators and up to `maxDecimals` decimals. */
export function formatNumber(value: number | undefined, maxDecimals = 2): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxDecimals }).format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | undefined, digits = 1): string {
  if (value === undefined) return '—';
  return `${value.toFixed(digits).replace(/\.0+$/, '')}%`;
}

const DOC_TYPE_LABELS: Record<DocType, string> = {
  commercial_invoice: 'Commercial invoice',
  packing_list: 'Packing list',
  invoice_packing_list: 'Invoice + packing list',
  bill_of_lading: 'Bill of lading',
  air_waybill: 'Air waybill',
  arrival_notice: 'Arrival notice',
  other: 'Unrecognized',
};

export const docTypeLabel = (type: DocType) => DOC_TYPE_LABELS[type] ?? type;

const SEVERITY_LABELS: Record<IssueSeverity, { one: string; many: string }> = {
  blocker: { one: 'Blocker', many: 'Blockers' },
  warning: { one: 'Warning', many: 'Warnings' },
  info: { one: 'Info', many: 'Info' },
};

export const severityLabel = (severity: IssueSeverity, plural = false) =>
  plural ? SEVERITY_LABELS[severity].many : SEVERITY_LABELS[severity].one;

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  missing_data: 'Missing information',
  discrepancy: 'Document conflicts',
  valuation: 'Valuation',
  classification: 'Classification',
  compliance: 'Compliance',
  assumption: 'Assumptions',
  ocr: 'OCR / verify against original',
  format: 'Formatting',
};

export const categoryLabel = (category: IssueCategory) => CATEGORY_LABELS[category] ?? category;

const STATUS_LABELS: Record<SourceStatus, string> = {
  extracted: 'extracted',
  derived: 'derived',
  corrected: 'corrected',
  assumed: 'assumed',
  user: 'user',
};

export const statusLabel = (status: SourceStatus) => STATUS_LABELS[status] ?? status;

/** Confidence below this is flagged "verify" in the UI. */
export const LOW_CONFIDENCE = 70;

/** "6110202046" → "6110.20.20.46"; leaves other shapes untouched. */
export function formatHts(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8)}`;
  if (d.length === 8) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
  if (d.length === 6) return `${d.slice(0, 4)}.${d.slice(4)}`;
  return digits;
}

/** File name for the XML download, derived from the invoice number. */
export function xmlFileName(invoiceNo: string | undefined): string {
  const base = (invoiceNo ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'entry'}.entry.xml`;
}
