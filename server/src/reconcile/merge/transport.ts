/** Transport header, bills, containers, packages and weights from the B/L or air waybill. */
import type { Address, BillRef, Container, OtherDocData, ShipmentTransport, Shipment, Sourced } from '@app/shared';
import type { BillSource, DocSource, ReconcileContext, TransportSource } from '../context';
import { countryFromText } from '../lib/countries';
// The only reference lookup reconcile uses: port / airport → country (Schedule K + IATA cargo airports).
import { portCountry } from '../../reference/ports.js';
import { isIsoDate, parseDateText } from '../lib/dates';
import { isNum, round3 } from '../lib/num';
import { isUsState, usStateFromText } from '../lib/usStates';
import { sourced, sourcedMulti } from './sourced';

/** House bill first (it describes this shipment), then any bill, then arrival notices, then air waybills. */
export function chooseTransport(ctx: Pick<ReconcileContext, 'bills' | 'airWaybills'>): TransportSource | undefined {
  const real = ctx.bills.filter((b) => !b.arrivalNotice);
  const bl = real.find((b) => b.data.blType === 'house') ?? real[0] ?? ctx.bills[0];
  if (bl) return { kind: 'bl', src: bl };
  const awb = ctx.airWaybills.find((a) => a.data.awbType === 'house') ?? ctx.airWaybills[0];
  return awb ? { kind: 'awb', src: awb } : undefined;
}

/**
 * Split a bill number into SCAC + number. With a known SCAC, strip it when printed as a prefix;
 * without one, a leading 4-letter block followed by a digit is taken as the SCAC.
 */
export function splitBill(raw: string, scac?: string): BillRef {
  const n = raw.replace(/\s+/g, '').toUpperCase();
  const s = scac?.toUpperCase().replace(/[^A-Z]/g, '');
  if (s && s.length === 4) {
    if (n.startsWith(s) && n.length > s.length) return { scac: s, number: n.slice(s.length).replace(/^[-/]/, '') };
    return { scac: s, number: n };
  }
  const m = /^([A-Z]{4})(\d[A-Z0-9]{5,})$/.exec(n);
  if (m) return { scac: m[1], number: m[2] };
  return { number: n };
}

function billPair(b: BillSource): { master?: BillRef; house?: BillRef } | undefined {
  const d = b.data;
  if (!d.blNumber && !d.masterBlNumber) return undefined;
  const isHouse = d.blType === 'house' || (d.blType === 'unknown' && !!d.masterBlNumber);
  if (isHouse) {
    const pair: { master?: BillRef; house?: BillRef } = {};
    if (d.blNumber) pair.house = splitBill(d.blNumber, d.issuerScac);
    if (d.masterBlNumber) pair.master = splitBill(d.masterBlNumber, d.carrierScac);
    return pair;
  }
  return { master: splitBill(d.blNumber || d.masterBlNumber || '', d.issuerScac ?? d.carrierScac) };
}

const awbDigits = (s: string) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
/** 2-character IATA airline designator ("LH", "5X"); a 3-digit AWB prefix ("020") is not a carrier code. */
const airlineCode = (c: string | undefined) => (c && /^(?=.*[A-Z])[A-Z0-9]{2}$/i.test(c.trim()) ? c.trim().toUpperCase() : undefined);

/** Bills of lading / air waybills as {master, house} pairs, de-duplicated across documents. */
export function buildBills(ctx: Pick<ReconcileContext, 'bills' | 'airWaybills'>): Shipment['bills'] {
  const pairs: { master?: BillRef; house?: BillRef }[] = [];
  for (const b of ctx.bills) {
    const p = billPair(b);
    if (p) pairs.push(p);
  }
  for (const a of ctx.airWaybills) {
    const d = a.data;
    if (!d.awbNumber) continue;
    const scac = airlineCode(d.carrierIata) ?? airlineCode(d.carrierCode);
    if (d.awbType === 'house' || (d.awbType === 'unknown' && d.masterAwbNumber)) {
      const pair: { master?: BillRef; house?: BillRef } = { house: { number: awbDigits(d.awbNumber) } };
      if (d.masterAwbNumber) pair.master = { ...(scac ? { scac } : {}), number: awbDigits(d.masterAwbNumber) };
      pairs.push(pair);
    } else pairs.push({ master: { ...(scac ? { scac } : {}), number: awbDigits(d.awbNumber) } });
  }
  const key = (r?: BillRef) => r?.number ?? '';
  const out: { master?: BillRef; house?: BillRef }[] = [];
  for (const p of pairs) {
    const dupe = out.find((o) => key(o.house) === key(p.house) && (key(o.master) === key(p.master) || !p.master || !o.master));
    if (dupe) {
      dupe.master ??= p.master;
      continue;
    }
    // A master-only pair already represented by a house pair adds nothing.
    if (!p.house && p.master && out.some((o) => key(o.master) === key(p.master))) continue;
    if (p.house && p.master) {
      const masterOnly = out.findIndex((o) => !o.house && key(o.master) === key(p.master));
      if (masterOnly >= 0) out.splice(masterOnly, 1);
    }
    out.push(p);
  }
  return out;
}

const CONTAINER_TEXT = /\b(20|40|45)\s*'?\s*(GP|HC|HQ|DV|DC|RF|OT|FR|ST|STD)\b|\bCONTAINER\b|\bFCL\b/i;
const ARRIVAL_ACTUAL = /\b(?:actual arrival|arrival date|date of arrival|arrived(?: on)?|ATA)\b\s*[:\-]?\s*([^\n]{6,30})/i;
const ARRIVAL_ETA = /\b(?:ETA|estimated (?:time of )?arrival)\b\s*[:\-]?\s*([^\n]{6,30})/i;

/** Arrival date from an unparsed arrival notice (US carrier notices write month-first dates). */
export function arrivalFromNotice(n: DocSource<OtherDocData>): { date: string; estimated: boolean; text: string } | undefined {
  const text = n.data.text ?? '';
  for (const [re, estimated] of [[ARRIVAL_ACTUAL, false], [ARRIVAL_ETA, true]] as const) {
    const m = re.exec(text);
    const date = m ? parseDateText(m[1], 'mdy') : undefined;
    if (m && date) return { date, estimated, text: m[0].trim() };
  }
  return undefined;
}

function exportDate(ctx: ReconcileContext, t: TransportSource | undefined): Sourced<string> | undefined {
  if (t?.kind === 'bl') {
    const d = t.src.data;
    if (isIsoDate(d.onBoardDate)) return sourced(d.onBoardDate, 'extracted', t.src.doc, ['onBoardDate'], 'Shipped-on-board date on the bill of lading.');
    if (isIsoDate(d.issueDate)) return sourced(d.issueDate, 'derived', t.src.doc, ['issueDate'], 'No on-board date; bill of lading issue date used.');
  }
  if (t?.kind === 'awb' && isIsoDate(t.src.data.flightDate)) return sourced(t.src.data.flightDate, 'extracted', t.src.doc, ['flightDate'], 'Flight date on the air waybill.');
  const inv = ctx.invoices.find((i) => isIsoDate(i.data.etd));
  if (inv?.data.etd) return sourced(inv.data.etd, 'assumed', inv.doc, ['etd'], 'No transport-document date; invoice ETD used.');
  return undefined;
}

function arrivalDate(ctx: ReconcileContext): { date?: Sourced<string>; estimated: boolean } {
  for (const n of ctx.arrivalNotices) {
    const a = arrivalFromNotice(n);
    if (a) return { date: sourced(a.date, a.estimated ? 'assumed' : 'extracted', n.doc, ['text'], `Arrival notice: "${a.text}"`), estimated: a.estimated };
  }
  const inv = ctx.invoices.find((i) => isIsoDate(i.data.eta));
  if (inv?.data.eta) return { date: sourced(inv.data.eta, 'assumed', inv.doc, ['eta'], 'Estimated time of arrival (ETA) printed on the invoice.'), estimated: true };
  return { estimated: false };
}

function stateOf(a: Address | undefined): string | undefined {
  if (!a) return undefined;
  if (a.country && a.country !== 'US') return undefined;
  if (a.stateProvince && isUsState(a.stateProvince)) return a.stateProvince.toUpperCase();
  return usStateFromText(a.raw);
}

export interface TransportMerge {
  transport: ShipmentTransport;
  bills: Shipment['bills'];
  containers: Container[];
  packages?: Sourced<{ count: number; unit: string }>;
  grossWeightKg?: Sourced<number>;
  volumeCbm?: number;
  releaseType?: string;
  countryOfExport?: string;
  consolidator?: Address;
  notifyParty?: Address;
}

/** Build the transport section. `shipTo` is used as a fallback for the destination state. */
export function buildTransport(ctx: ReconcileContext, shipTo: Address | undefined): TransportMerge {
  const t = ctx.transport;
  const bl = t?.kind === 'bl' ? t.src.data : undefined;
  const awb = t?.kind === 'awb' ? t.src.data : undefined;
  const inv = ctx.invoices[0]?.data;
  const pl = ctx.packingLists[0]?.data;

  const containers: Container[] = (bl?.containers ?? []).map((c) => ({
    ...c,
    sealNumbers: [...(c.sealNumbers ?? [])],
    ...(c.candidates ? { candidates: c.candidates.map((x) => ({ ...x })) } : {}),
  }));
  const containerText = [...(bl?.cargoDescription ?? []), pl?.containerSummary ?? ''].join(' ');
  const mode = bl ? 'ocean' : awb ? 'air' : inv?.vessel || pl?.vessel ? 'ocean' : 'unknown';

  const transport: ShipmentTransport = {
    mode,
    containerized: mode === 'ocean' && (containers.length > 0 || CONTAINER_TEXT.test(containerText)),
    arrivalDateEstimated: false,
  };
  const set = <K extends keyof ShipmentTransport>(k: K, v: ShipmentTransport[K] | undefined) => {
    if (v !== undefined && v !== '') transport[k] = v;
  };
  set('vessel', bl?.vessel ?? inv?.vessel ?? pl?.vessel);
  set('voyage', bl?.voyage ?? inv?.voyage ?? pl?.voyage);
  if (bl) {
    const isMasterDoc = bl.blType === 'master';
    set('carrierName', bl.carrierName ?? (isMasterDoc ? bl.issuerName : undefined));
    const prefix = bl.masterBlNumber ? splitBill(bl.masterBlNumber).scac : undefined;
    set('carrierScac', bl.carrierScac ?? (isMasterDoc ? bl.issuerScac : undefined) ?? prefix);
  }
  if (awb) {
    set('carrierName', awb.carrierName);
    set('carrierScac', airlineCode(awb.carrierIata) ?? airlineCode(awb.carrierCode));
    set('flight', awb.flight);
  }
  set('portOfLading', bl?.portOfLoading ?? awb?.airportOfDeparture ?? inv?.portOfLoading ?? pl?.portOfLoading);
  set('portOfUnlading', bl?.portOfDischarge ?? awb?.airportOfDestination ?? inv?.portOfDischarge ?? pl?.portOfDischarge);
  set('placeOfDelivery', bl?.placeOfDelivery ?? bl?.finalDestination);

  const exp = exportDate(ctx, t);
  if (exp) transport.exportDate = exp;
  const arr = arrivalDate(ctx);
  if (arr.date) transport.arrivalDate = arr.date;
  transport.arrivalDateEstimated = arr.estimated;

  set(
    'destinationState',
    usStateFromText(bl?.placeOfDelivery) ??
      usStateFromText(bl?.finalDestination) ??
      stateOf(shipTo) ??
      stateOf(bl?.consignee ?? awb?.consignee) ??
      usStateFromText(transport.portOfUnlading),
  );

  const out: TransportMerge = { transport, bills: buildBills(ctx), containers };

  // Packages: transport document (manifest) > packing list > invoice.
  if (bl?.packages && isNum(bl.packages.count) && t) out.packages = sourced({ ...bl.packages }, 'extracted', t.src.doc, ['packages']);
  else if (awb && isNum(awb.pieces) && t) out.packages = sourced({ count: awb.pieces, unit: 'PCS' }, 'extracted', t.src.doc, ['pieces']);
  else {
    const plWithCtns = ctx.packingLists.find((p) => isNum(p.data.totals?.cartons));
    const invPk = ctx.invoices.find((i) => i.data.totalPackages && isNum(i.data.totalPackages.count));
    const invCombined = ctx.invoices.find((i) => isNum(i.data.packingTotals?.cartons));
    if (plWithCtns) out.packages = sourced({ count: plWithCtns.data.totals.cartons as number, unit: 'CARTONS' }, 'extracted', plWithCtns.doc, ['totals.cartons']);
    else if (invPk?.data.totalPackages) out.packages = sourced({ ...invPk.data.totalPackages }, 'extracted', invPk.doc, ['totalPackages']);
    else if (invCombined) out.packages = sourced({ count: invCombined.data.packingTotals?.cartons as number, unit: 'CARTONS' }, 'extracted', invCombined.doc, ['packingTotals.cartons']);
  }

  // Gross weight: transport document > packing list total (or sum of lines) > combined invoice.
  const docGross = bl?.grossWeightKg ?? awb?.grossWeightKg;
  if (isNum(docGross) && t) out.grossWeightKg = sourced(docGross, 'extracted', t.src.doc, ['grossWeightKg']);
  else {
    const plG = packingGross(ctx);
    if (plG) out.grossWeightKg = plG;
  }

  const vol = bl?.volumeCbm ?? ctx.packingLists.find((p) => isNum(p.data.totals?.volumeCbm))?.data.totals.volumeCbm ?? ctx.invoices.find((i) => isNum(i.data.packingTotals?.volumeCbm))?.data.packingTotals?.volumeCbm;
  if (isNum(vol)) out.volumeCbm = vol;

  const stampTelex = ctx.bills.some((b) => b.doc.observations?.some((o) => o.kind === 'stamp' && /TELEX|SURRENDER/i.test(o.text)));
  const rel = bl?.releaseType && bl.releaseType !== 'unknown' ? bl.releaseType : stampTelex ? 'telex' : undefined;
  if (rel) out.releaseType = rel;

  // Country of export (CBP: the country the goods were last part of the commerce of and shipped from):
  // the port of lading, by a printed country name or through the reference lookups (sea ports,
  // IATA airport codes such as "FRANKFURT/MAIN (FRA)"); then the shipper on the transport document;
  // then the invoice seller; then the packing-list manufacturer; finally the invoice header origin.
  const portOf = (text: string | undefined) => (text ? countryFromText(text) ?? portCountry(text) ?? undefined : undefined);
  const exportCountry =
    portOf(transport.portOfLading) ??
    portOf(inv?.portOfLoading) ??
    (bl?.shipper?.country || awb?.shipper?.country || undefined) ??
    ctx.invoices.find((i) => i.data.seller?.country)?.data.seller?.country ??
    ctx.packingLists.find((p) => p.data.manufacturer?.country)?.data.manufacturer?.country ??
    ctx.invoices.find((i) => i.data.countryOfOrigin)?.data.countryOfOrigin;
  if (exportCountry) out.countryOfExport = exportCountry;

  if (bl?.blType === 'house' && bl.issuerName) out.consolidator = { name: bl.issuerName, lines: [], raw: bl.issuerName };
  const notify = bl?.notifyParty ?? awb?.notifyParty;
  if (notify?.name) out.notifyParty = notify;
  return out;
}

/** Gross weight per the packing documents: PL grand total, else sum of PL lines, else combined invoice total. */
export function packingGross(ctx: ReconcileContext): Sourced<number> | undefined {
  const pl = ctx.packingLists.find((p) => isNum(p.data.totals?.grossWeightKg));
  if (pl) return sourced(pl.data.totals.grossWeightKg as number, 'extracted', pl.doc, ['totals.grossWeightKg']);
  for (const p of ctx.packingLists) {
    const ls = p.data.lines ?? [];
    if (ls.length && ls.every((l) => isNum(l.grossWeightKg))) {
      return sourcedMulti(round3(ls.reduce((s, l) => s + (l.grossWeightKg as number), 0)), 'derived', ls.map((_, i) => ({ doc: p.doc, field: `lines[${i}].grossWeightKg` })));
    }
  }
  const inv = ctx.invoices.find((i) => isNum(i.data.packingTotals?.grossWeightKg));
  if (inv) return sourced(inv.data.packingTotals?.grossWeightKg as number, 'extracted', inv.doc, ['packingTotals.grossWeightKg']);
  return undefined;
}
