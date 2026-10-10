/**
 * Party roles. Importer = buyer (fallback: notify party, then consignee). Ultimate consignee = the
 * buyer when the ship-to is a logistics provider or holds the goods "for account of" the buyer;
 * otherwise the ship-to. Manufacturers = stated producers (letterhead, per-line, notes).
 */
import type { Address, Sourced, SourceRef } from '@app/shared';
import type { ReconcileContext } from '../context';
import { countriesInText } from '../lib/countries';
import { accountOfParty, logisticsKeyword, sameParty } from '../lib/parties';
import { clean, sameCompany } from '../lib/text';
import { refOf, sourced } from './sourced';

export type ImporterBasis = 'buyer' | 'notify_party' | 'consignee' | 'none';
export type UcBasis = 'same_as_buyer' | 'buyer_logistics' | 'buyer_account_of' | 'ship_to' | 'buyer_no_ship_to' | 'buyer_to_order' | 'none';

export interface PartyResolution {
  importer?: Sourced<Address>;
  importerBasis: ImporterBasis;
  importerRef?: SourceRef;
  ultimateConsignee?: Sourced<Address>;
  ucBasis: UcBasis;
  shipTo?: Address;
  shipToRef?: SourceRef;
  /** Logistics keyword found in the ship-to name, e.g. "FULFILLMENT". */
  logisticsKeyword?: string;
  /** Party named in a "for account of" clause on the ship-to. */
  accountOf?: string;
  /** A transport document consigned "to the order of" a party (negotiable bill), as printed. */
  toOrder?: string;
}

/** "TO ORDER", "TO THE ORDER OF <bank>", "UNTO ORDER OF <shipper>": a negotiable bill's order clause. */
const ORDER_CLAUSE_RE = /^(?:UN)?TO\s+(?:THE\s+)?ORDER\b|^ORDER\s+OF\b/i;

/** Not a candidate importer/ship-to: empty, "to order"/"TBA" placeholders, or a customs broker. */
const isBrokerPlaceholder = (a: Address | undefined) =>
  !a?.name || ORDER_CLAUSE_RE.test(a.name.trim()) || /\b(TBA|TO BE ADVISED|SAME AS CONSIGNEE|TO ORDER|CUSTOMS|BROKER(?:AGE|S)?|CHB)\b/i.test(a.name);

/** Pure resolution of importer / ultimate consignee / ship-to from the grouped documents. */
export function resolveParties(ctx: ReconcileContext): PartyResolution {
  const out: PartyResolution = { importerBasis: 'none', ucBasis: 'none' };

  const buyerInv = ctx.invoices.find((i) => i.data.buyer?.name);
  if (buyerInv?.data.buyer) {
    out.importer = sourced(buyerInv.data.buyer, 'derived', buyerInv.doc, ['buyer'], 'Buyer (sold-to) on the commercial invoice.');
    out.importerBasis = 'buyer';
    out.importerRef = refOf(buyerInv.doc, 'buyer');
  } else {
    const notify = [
      ...ctx.bills.map((b) => ({ a: b.data.notifyParty, doc: b.doc })),
      ...ctx.airWaybills.map((w) => ({ a: w.data.notifyParty, doc: w.doc })),
    ].find((x) => x.a?.name && !isBrokerPlaceholder(x.a) && !logisticsKeyword(x.a));
    const consignee = [
      ...ctx.packingLists.map((p) => ({ a: p.data.consignee, doc: p.doc })),
      ...ctx.bills.map((b) => ({ a: b.data.consignee, doc: b.doc })),
      ...ctx.airWaybills.map((w) => ({ a: w.data.consignee, doc: w.doc })),
    ].find((x) => x.a?.name && !isBrokerPlaceholder(x.a) && !logisticsKeyword(x.a));
    if (notify?.a) {
      out.importer = sourced(notify.a, 'assumed', notify.doc, ['notifyParty'], 'No buyer on an invoice; notify party used as importer.');
      out.importerBasis = 'notify_party';
      out.importerRef = refOf(notify.doc, 'notifyParty');
    } else if (consignee?.a) {
      out.importer = sourced(consignee.a, 'assumed', consignee.doc, ['consignee'], 'No buyer on an invoice; consignee used as importer.');
      out.importerBasis = 'consignee';
      out.importerRef = refOf(consignee.doc, 'consignee');
    }
  }

  const shipTo = [
    ...ctx.invoices.map((i) => ({ a: i.data.shipTo, doc: i.doc, field: 'shipTo' })),
    ...ctx.packingLists.map((p) => ({ a: p.data.deliverTo, doc: p.doc, field: 'deliverTo' })),
    ...ctx.bills.map((b) => ({ a: b.data.consignee, doc: b.doc, field: 'consignee' })),
    ...ctx.airWaybills.map((w) => ({ a: w.data.consignee, doc: w.doc, field: 'consignee' })),
  ].find((x) => x.a?.name && !isBrokerPlaceholder(x.a));
  if (shipTo?.a) {
    out.shipTo = shipTo.a;
    out.shipToRef = refOf(shipTo.doc, shipTo.field);
  }

  const order = [...ctx.bills.map((b) => b.data.consignee), ...ctx.airWaybills.map((w) => w.data.consignee)].find((a) => a?.name && ORDER_CLAUSE_RE.test(a.name.trim()));
  if (order) out.toOrder = clean(order.name);

  const importer = out.importer?.value;
  if (!importer) {
    if (out.shipTo) {
      out.ultimateConsignee = sourced(out.shipTo, 'assumed', undefined, [], 'No importer identified; ship-to used as ultimate consignee.');
      out.ultimateConsignee.sources = out.shipToRef ? [out.shipToRef] : [];
      out.ucBasis = 'ship_to';
    }
    return out;
  }
  const impSources = out.importer?.sources ?? [];
  if (!out.shipTo) {
    if (out.toOrder) {
      out.ultimateConsignee = {
        value: importer,
        status: 'assumed',
        sources: impSources,
        note: `The bill is consigned "${out.toOrder}" (negotiable, e.g. under a letter of credit); the order party holds title as security, the buyer is the ultimate consignee.`,
      };
      out.ucBasis = 'buyer_to_order';
      return out;
    }
    out.ultimateConsignee = { value: importer, status: 'assumed', sources: impSources, note: 'No ship-to or consignee printed; the importer is the ultimate consignee.' };
    out.ucBasis = 'buyer_no_ship_to';
    return out;
  }
  if (sameParty(out.shipTo, importer)) {
    out.ultimateConsignee = { value: importer, status: 'derived', sources: [...impSources, ...(out.shipToRef ? [out.shipToRef] : [])] };
    out.ucBasis = 'same_as_buyer';
    return out;
  }
  // Any ship-to/consignee block naming the buyer "for account of" counts, not only the first one found.
  const blocks = [
    ...ctx.invoices.map((i) => i.data.shipTo),
    ...ctx.packingLists.map((p) => p.data.deliverTo),
    ...ctx.bills.map((b) => b.data.consignee),
    ...ctx.airWaybills.map((w) => w.data.consignee),
  ];
  const accountOf = blocks.map(accountOfParty).find((p) => p && sameCompany(p, importer.name));
  out.logisticsKeyword = logisticsKeyword(out.shipTo);
  if (accountOf) out.accountOf = accountOf;
  if (out.logisticsKeyword || accountOf) {
    out.ultimateConsignee = {
      value: importer,
      status: 'assumed',
      sources: impSources,
      note: `Ship-to ${clean(out.shipTo.name)} is a logistics provider / holds the goods for the buyer's account; the buyer is the ultimate consignee.`,
    };
    out.ucBasis = out.logisticsKeyword ? 'buyer_logistics' : 'buyer_account_of';
  } else {
    out.ultimateConsignee = { value: out.shipTo, status: 'derived', sources: out.shipToRef ? [out.shipToRef] : [], note: 'Ship-to party used as ultimate consignee.' };
    out.ucBasis = 'ship_to';
  }
  return out;
}

const LEGAL_SUFFIX = String.raw`(?:Joint Stock Company|Co\.?,?\s*Ltd\.?|Company Limited|Pvt\.?\s*Ltd\.?|Pte\.?\s*Ltd\.?|Sdn\.?\s*Bhd\.?|Ltd\.?|Limited|LLC|Inc\.?|JSC|GmbH|Corp\.?|Corporation|Company|S\.A\.?|S\.R\.L\.?|PLC|PT\b)`;
const MAKER_CUE = /\b(?:manufactured|produced|made|sewn|knitted|woven|assembled)\b[^.;]*?\b(?:by|at)\b/gi;
const NAME_AFTER_CUE = new RegExp(String.raw`^\s*(?:our\s+)?(?:(?:contracted|sister|subcontracted?|affiliated|partner)\s+)?(?:factory|unit|mill|plant|manufacturer|supplier)?\s*[:,]?\s*([A-Z][A-Za-z0-9&'\-. ]{1,80}?\s${LEGAL_SUFFIX})`);

/** Named producers in free-text notes ("produced at our sister unit X Garments Ltd., …, Bangladesh"). */
export function manufacturersInNotes(notes: string[]): Address[] {
  const out: Address[] = [];
  for (const note of notes) {
    for (const m of note.matchAll(MAKER_CUE)) {
      const rest = note.slice((m.index ?? 0) + m[0].length);
      const n = NAME_AFTER_CUE.exec(rest);
      if (!n) continue;
      const name = clean(n[1]).replace(/,$/, '');
      const tail = rest.slice(n[0].length).split(/[.;](?:\s|$)/)[0];
      const countries = countriesInText(tail);
      const addr: Address = { name, lines: [], raw: clean(`${name}${tail}`) };
      if (countries.length) addr.country = countries[countries.length - 1];
      out.push(addr);
    }
  }
  return out;
}

/** Unique manufacturers: per-line (stated or assumed) first, then document-level and notes. */
export function collectManufacturers(ctx: ReconcileContext): Address[] {
  const out: Address[] = [];
  const add = (a: Address | undefined) => {
    if (a?.name && !out.some((x) => sameParty(x, a))) out.push(a);
  };
  for (const l of ctx.links) add(l.line.manufacturer);
  for (const i of ctx.invoices) add(i.data.manufacturer);
  for (const p of ctx.packingLists) add(p.data.manufacturer);
  for (const p of ctx.packingLists) for (const l of p.data.lines ?? []) add(l.manufacturer);
  for (const i of ctx.invoices) for (const a of manufacturersInNotes(i.data.notes ?? [])) add(a);
  for (const p of ctx.packingLists) for (const a of manufacturersInNotes(p.data.remarks ?? [])) add(a);
  return out;
}
