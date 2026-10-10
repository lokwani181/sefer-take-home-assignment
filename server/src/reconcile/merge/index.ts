/** buildContext: group documents, build the draft Shipment, and link lines across documents. */
import type { AirWaybillData, ExtractedDocument, OtherDocData, PackingListData, Shipment } from '@app/shared';
import type { BillSource, DocSource, InvoiceSource, LineLink, ReconcileContext } from '../context';
import { allocateAssists } from './assists';
import { buildInvoiceSource } from './invoices';
import { enrichLines } from './lines';
import { matchPackingLists } from './matchLines';
import { collectManufacturers, resolveParties } from './parties';
import { buildTransport, chooseTransport } from './transport';

/** Group documents by their parsed data kind (docType only refines arrival notices / combined docs). */
function group(docs: ExtractedDocument[]) {
  const invoices: InvoiceSource[] = [];
  const packingLists: DocSource<PackingListData>[] = [];
  const bills: BillSource[] = [];
  const airWaybills: DocSource<AirWaybillData>[] = [];
  const arrivalNotices: DocSource<OtherDocData>[] = [];
  const others: DocSource<OtherDocData>[] = [];
  for (const doc of docs) {
    const d = doc?.data;
    if (!d) continue;
    switch (d.kind) {
      case 'commercial_invoice':
        invoices.push(buildInvoiceSource(doc, d, invoices.length));
        break;
      case 'packing_list':
        packingLists.push({ doc, data: d });
        break;
      case 'bill_of_lading':
        bills.push({ doc, data: d, arrivalNotice: doc.docType === 'arrival_notice' });
        break;
      case 'air_waybill':
        airWaybills.push({ doc, data: d });
        break;
      case 'other':
        (doc.docType === 'arrival_notice' ? arrivalNotices : others).push({ doc, data: d });
        break;
    }
  }
  return { invoices, packingLists, bills, airWaybills, arrivalNotices, others };
}

/** Merge all documents into a draft Shipment plus the links rules need. Never throws on partial data. */
export function buildContext(docs: ExtractedDocument[]): ReconcileContext {
  const g = group(docs ?? []);
  const links: LineLink[] = g.invoices.flatMap((inv) =>
    inv.invoice.lines.map((line, index) => ({ line, inv, index, invLine: inv.data.lines[index], pl: [] })),
  );
  const shipment: Shipment = {
    invoices: g.invoices.map((i) => i.invoice),
    manufacturers: [],
    transport: { mode: 'unknown', containerized: false, arrivalDateEstimated: false },
    bills: [],
    containers: [],
  };
  const ctx: ReconcileContext = {
    docs: docs ?? [],
    ...g,
    shipment,
    links,
    linkById: new Map(links.map((l) => [l.line.id, l])),
    unmatchedPl: [],
    manufacturerAssumed: new Map(),
    assistAllocations: [],
  };
  ctx.transport = chooseTransport(ctx);
  ctx.unmatchedPl = matchPackingLists(links, g.invoices, g.packingLists);
  enrichLines(ctx);
  ctx.assistAllocations = allocateAssists(ctx);

  const parties = resolveParties(ctx);
  if (parties.importer) shipment.importer = parties.importer;
  if (parties.ultimateConsignee) shipment.ultimateConsignee = parties.ultimateConsignee;
  if (parties.shipTo) shipment.shipTo = parties.shipTo;
  const seller = g.invoices.find((i) => i.data.seller?.name)?.data.seller;
  if (seller) shipment.seller = seller;
  shipment.manufacturers = collectManufacturers(ctx);

  const t = buildTransport(ctx, parties.shipTo);
  shipment.transport = t.transport;
  shipment.bills = t.bills;
  shipment.containers = t.containers;
  if (t.packages) shipment.packages = t.packages;
  if (t.grossWeightKg) shipment.grossWeightKg = t.grossWeightKg;
  if (t.volumeCbm !== undefined) shipment.volumeCbm = t.volumeCbm;
  if (t.releaseType) shipment.releaseType = t.releaseType;
  if (t.countryOfExport) shipment.countryOfExport = t.countryOfExport;
  if (t.consolidator) shipment.consolidator = t.consolidator;
  if (t.notifyParty) shipment.notifyParty = t.notifyParty;
  return ctx;
}
