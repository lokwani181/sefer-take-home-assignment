/**
 * Enrich invoice lines with packing-list data (weights, cartons, origin, manufacturer, composition
 * fallback) and resolve each line's origin and manufacturer by the documented priority.
 */
import type { Address, PackingListLine, Sourced } from '@app/shared';
import type { LineLink, ReconcileContext } from '../context';
import { countriesInText, countryFromText, isIso2Country } from '../lib/countries';
import { isNum, round3 } from '../lib/num';
import { logisticsKeyword } from '../lib/parties';
import { piecesPerUnit } from '../lib/units';
import { plPieces } from './matchLines';
import { sourced, sourcedMulti } from './sourced';

/** ISO2 from a parsed origin that may be a code or a country name. */
export function toIso2(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toUpperCase();
  if (isIso2Country(t)) return t;
  return countryFromText(t);
}

const ORIGIN_CUE = /\b(?:made in|country of origin|origin|produced in|manufactured in)\b\s*[:\-]?\s*/gi;
const MATERIAL_ORIGIN = /\b(?:fabric|yarn|cotton|fib(?:re|er)|material|component|trim|leather)s?\b[^.;]{0,15}$/i;

/** Origin stated in a line's own text ("(Origin: Bangladesh)", "MADE IN SRI LANKA"), ignoring material origins. */
export function originFromText(texts: (string | undefined)[]): { country: string; index: number } | undefined {
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (!t) continue;
    for (const m of t.matchAll(ORIGIN_CUE)) {
      const at = m.index ?? 0;
      if (MATERIAL_ORIGIN.test(t.slice(Math.max(0, at - 30), at))) continue;
      const c = countriesInText(t.slice(at + m[0].length, at + m[0].length + 40))[0];
      if (c) return { country: c, index: i };
    }
  }
  return undefined;
}

type WeightField = 'netWeightKg' | 'grossWeightKg';
const PER_CARTON: Record<WeightField, 'netWeightPerCartonKg' | 'grossWeightPerCartonKg'> = {
  netWeightKg: 'netWeightPerCartonKg',
  grossWeightKg: 'grossWeightPerCartonKg',
};

function plWeight(link: LineLink, field: WeightField): Sourced<number> | undefined {
  if (!link.pl.length) return undefined;
  let total = 0;
  let derived = link.pl.length > 1;
  const refs: { doc: LineLink['pl'][number]['pl']['doc']; field: string }[] = [];
  for (const r of link.pl) {
    const l: PackingListLine = r.line;
    const base = `lines[${r.index}]`;
    if (isNum(l[field])) {
      total += l[field] as number;
      refs.push({ doc: r.pl.doc, field: `${base}.${field}` });
    } else if (isNum(l[PER_CARTON[field]]) && isNum(l.cartons)) {
      total += (l[PER_CARTON[field]] as number) * (l.cartons as number);
      derived = true;
      refs.push({ doc: r.pl.doc, field: `${base}.${PER_CARTON[field]}` }, { doc: r.pl.doc, field: `${base}.cartons` });
    } else return undefined;
  }
  return sourcedMulti(round3(total), derived ? 'derived' : 'extracted', refs);
}

function enrichFromPackingList(link: LineLink): void {
  const { line, invLine, inv } = link;
  const p = `lines[${link.index}]`;
  for (const field of ['netWeightKg', 'grossWeightKg'] as const) {
    const w = plWeight(link, field);
    if (w) line[field] = w;
    else if (isNum(invLine[field])) line[field] = sourced(invLine[field] as number, 'extracted', inv.doc, [`${p}.${field}`]);
  }
  const ctns = link.pl.map((r) => r.line.cartons);
  if (link.pl.length && ctns.every(isNum)) line.cartons = ctns.reduce((a, b) => a + b, 0);
  else if (isNum(invLine.cartons)) line.cartons = invLine.cartons;

  if (!line.attributes.composition?.length) {
    const withComp = link.pl.find((r) => r.line.composition?.length);
    if (withComp) {
      line.attributes.composition = withComp.line.composition;
      line.attributes.compositionSource = 'packing_list';
    }
  }

  // Quantity missing on the invoice: take the packed pieces (converted to the invoice unit).
  if (line.quantity.status === 'assumed' && link.pl.length) {
    const pcs = link.pl.map((r) => plPieces(r.line));
    const factor = piecesPerUnit(line.unit) ?? 1;
    if (pcs.every(isNum)) {
      const q = (pcs as number[]).reduce((a, b) => a + b, 0) / factor;
      line.quantity = sourcedMulti(q, 'derived', link.pl.map((r) => ({ doc: r.pl.doc, field: `lines[${r.index}].totalPcs` })), 'Quantity not on the invoice; taken from the packing list.');
      if (!line.unit) line.unit = 'PCS';
    }
  }
}

/** Origin priority: invoice line > PL line > invoice header > B/L point of origin > manufacturer country (assumed). */
function resolveOrigin(link: LineLink, ctx: ReconcileContext): Sourced<string> {
  const { inv, invLine } = link;
  const lineCoo = toIso2(invLine.countryOfOrigin);
  if (lineCoo) return sourced(lineCoo, 'extracted', inv.doc, [`lines[${link.index}].countryOfOrigin`]);
  const invText = originFromText([invLine.description, ...(invLine.details ?? [])]);
  if (invText) {
    const field = invText.index === 0 ? 'description' : `details[${invText.index - 1}]`;
    return sourced(invText.country, 'extracted', inv.doc, [`lines[${link.index}].${field}`], 'Origin stated in the line description.');
  }
  for (const r of link.pl) {
    const c = toIso2(r.line.countryOfOrigin);
    if (c) return sourced(c, 'extracted', r.pl.doc, [`lines[${r.index}].countryOfOrigin`]);
  }
  for (const r of link.pl) {
    const t = originFromText([r.line.description, ...(r.line.details ?? [])]);
    if (t) return sourced(t.country, 'extracted', r.pl.doc, [`lines[${r.index}].details`], 'Origin stated in the packing-list line.');
  }
  const header = toIso2(inv.data.countryOfOrigin);
  if (header) return sourced(header, 'derived', inv.doc, ['countryOfOrigin'], 'Invoice header country of origin applied to the line.');
  for (const b of ctx.bills) {
    const c = toIso2(b.data.countryOfOrigin);
    if (c) return sourced(c, 'derived', b.doc, ['countryOfOrigin'], 'Point/country of origin from the bill of lading.');
  }
  const mfr = link.line.manufacturer;
  if (mfr?.country) return sourced(mfr.country, 'assumed', undefined, [], `No origin stated on any document; assumed from the manufacturer's country (${mfr.name}).`);
  return sourced('', 'assumed', undefined, [], 'No country of origin found on any document.');
}

/** Stated manufacturer for the line, most specific first. */
function statedManufacturer(link: LineLink, ctx: ReconcileContext): Address | undefined {
  if (link.invLine.manufacturer?.name) return link.invLine.manufacturer;
  const plLine = link.pl.find((r) => r.line.manufacturer?.name);
  if (plLine) return plLine.line.manufacturer;
  if (link.inv.data.manufacturer?.name) return link.inv.data.manufacturer;
  const plDoc = link.pl.find((r) => r.pl.data.manufacturer?.name);
  if (plDoc) return plDoc.pl.data.manufacturer;
  const pls = ctx.packingLists.filter((p) => p.data.manufacturer?.name);
  if (pls.length === 1) return pls[0].data.manufacturer;
  return undefined;
}

/**
 * When no manufacturer is stated, the transport-doc shipper / PL shipper / seller located in the
 * country of origin is the most likely producer. Recorded in ctx.manufacturerAssumed for an issue.
 */
function assumedManufacturer(link: LineLink, ctx: ReconcileContext, origin: string | undefined): { addr: Address; role: string } | undefined {
  const cands: { addr: Address | undefined; role: string }[] = [
    ...ctx.bills.map((b) => ({ addr: b.data.shipper, role: 'bill of lading shipper' })),
    ...ctx.airWaybills.map((a) => ({ addr: a.data.shipper, role: 'air waybill shipper' })),
    ...ctx.packingLists.map((p) => ({ addr: p.data.shipper, role: 'packing list shipper' })),
    { addr: link.inv.data.seller, role: 'seller' },
  ];
  for (const c of cands) {
    if (!c.addr?.name || logisticsKeyword(c.addr)) continue;
    if (origin && c.addr.country && c.addr.country === origin) return { addr: c.addr, role: c.role };
  }
  return undefined;
}

/** Fill packing-list data, manufacturer and origin on every linked line. */
export function enrichLines(ctx: ReconcileContext): void {
  for (const link of ctx.links) {
    enrichFromPackingList(link);
    const stated = statedManufacturer(link, ctx);
    if (stated) link.line.manufacturer = stated;
    link.line.countryOfOrigin = resolveOrigin(link, ctx);
    if (!stated) {
      const guess = assumedManufacturer(link, ctx, link.line.countryOfOrigin.value || undefined);
      if (guess) {
        link.line.manufacturer = guess.addr;
        ctx.manufacturerAssumed.set(link.line.id, guess.role);
      }
    }
  }
}
