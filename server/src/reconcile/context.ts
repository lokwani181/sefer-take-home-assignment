/**
 * Reconcile context: the documents grouped by kind, the draft Shipment built by merge, and the
 * cross-document links (invoice line ↔ packing-list lines) that rules need for their evidence.
 * Rules read it, may refine the shipment (e.g. corrected amounts), and return Issues.
 */
import type {
  AirWaybillData,
  Assist,
  BillOfLadingData,
  CommercialInvoiceData,
  ExtractedDocument,
  InvoiceLine,
  Issue,
  IssueCode,
  OtherDocData,
  PackingListData,
  PackingListLine,
  Shipment,
  ShipmentInvoice,
  ShipmentLine,
} from '@app/shared';

export interface DocSource<T> {
  doc: ExtractedDocument;
  data: T;
}

export interface InvoiceSource extends DocSource<CommercialInvoiceData> {
  /** Position among invoices, the `inv<index>` part of line ids. */
  index: number;
  /** True for a combined invoice + packing list document. */
  combined: boolean;
  invoice: ShipmentInvoice;
  /** Currency was not printed and had to be assumed/inferred. */
  currencyInferred?: 'text' | 'assumed';
}

export interface BillSource extends DocSource<BillOfLadingData> {
  /** An arrival notice parsed with the bill-of-lading schema. */
  arrivalNotice: boolean;
}

export type MatchMethod = 'style' | 'style_ocr' | 'style_partial' | 'description';

export interface PlLineRef {
  pl: DocSource<PackingListData>;
  index: number;
  line: PackingListLine;
  method?: MatchMethod;
  /** Description similarity score when matched by description. */
  score?: number;
}

export interface LineLink {
  line: ShipmentLine;
  inv: InvoiceSource;
  /** Index into inv.data.lines (paths are `lines[${index}]`). */
  index: number;
  invLine: InvoiceLine;
  pl: PlLineRef[];
}

/** How one invoice assist was apportioned to lines (explained by the ASSIST rule). */
export interface AssistAllocation {
  inv: InvoiceSource;
  /** Index into inv.data.assists. */
  index: number;
  assist: Assist;
  /** How the target lines were found. */
  basis: 'style' | 'line_text' | 'all_lines';
  /** How the value was split over several lines. */
  split: 'single' | 'quantity' | 'amount';
  shares: { lineId: string; value: number }[];
}

export type TransportSource = { kind: 'bl'; src: BillSource } | { kind: 'awb'; src: DocSource<AirWaybillData> };

export interface ReconcileContext {
  docs: ExtractedDocument[];
  invoices: InvoiceSource[];
  packingLists: DocSource<PackingListData>[];
  bills: BillSource[];
  airWaybills: DocSource<AirWaybillData>[];
  /** Unparsed arrival notices (docType arrival_notice with free text). */
  arrivalNotices: DocSource<OtherDocData>[];
  others: DocSource<OtherDocData>[];
  /** The transport document the header data comes from (house bill preferred). */
  transport?: TransportSource;
  shipment: Shipment;
  links: LineLink[];
  linkById: Map<string, LineLink>;
  /** Packing-list lines that match no invoice line. */
  unmatchedPl: PlLineRef[];
  /** Lines whose manufacturer was assumed from the seller/shipper rather than stated. */
  manufacturerAssumed: Map<string, string>;
  assistAllocations: AssistAllocation[];
}

/** A reconciliation rule: one concern, its own issue code(s), optionally refining the shipment. */
export interface Rule {
  name: string;
  codes: IssueCode[];
  run(ctx: ReconcileContext): Issue[];
}

/** Issue key for invoice-scoped issues: plain code with one invoice, `inv<i>` suffix with several. */
export function invoiceKey(ctx: ReconcileContext, inv: InvoiceSource): string | undefined {
  return ctx.invoices.length > 1 ? `inv${inv.index}` : undefined;
}

/** Shipment path of a line, for Issue.field. */
export const linePath = (link: LineLink, field?: string): string =>
  `invoices[${link.inv.index}].lines[${link.inv.invoice.lines.indexOf(link.line)}]${field ? `.${field}` : ''}`;
