/**
 * Packing list parser.
 *
 * Rows come from the header-driven table; per-row arithmetic (cartons × per-carton =
 * totals) and column sums vs the grand total are used to derive missing cells and to
 * confirm OCR repairs. Remarks are linked to rows by footnote marker, style or carton number.
 */
import type { PackingListData, PackingListLine } from '@app/shared';
import type { ParseContext } from '../context';
import { joinWords, type PDoc, type PWord } from '../layout';
import { extractTable, cellLines, colIndex, rowText, type TableResult, type TableRow } from '../table';
import { detectDecimalSep, parseNumber, type ParsedNumber } from '../numbers';
import { isMonthFirstCountry, parseDate } from '../dates';
import { parseComposition } from '../domain/composition';
import { parseSizeType } from '../domain/container';
import { volumeToCbm, weightToKg } from '../domain/codes';
import { findMarkers, markersInNote, splitNotes } from '../footnotes';
import { findLabelValue, findLabelValues } from '../labels';
import { countryCode, findCountry } from '../countries';
import { firstCode, labelText, labelTexts, letterhead, letterheadParty, lineFactsFromNote, looksLikeManufacturer, noteMentions, partyBlock, splitLeadingCode, tableRegions } from './common';
import { splitVesselVoyage } from './invoice';
import { squash } from '../text';

type NumField = 'cartons' | 'pcsPerCarton' | 'totalPcs' | 'netWeightPerCartonKg' | 'grossWeightPerCartonKg' | 'netWeightKg' | 'grossWeightKg';

const COLUMN_OF: Record<NumField, Parameters<typeof colIndex>[1]> = {
  cartons: 'cartons',
  pcsPerCarton: 'pcsPerCarton',
  totalPcs: 'quantity',
  netWeightPerCartonKg: 'netWeightPerCarton',
  grossWeightPerCartonKg: 'grossWeightPerCarton',
  netWeightKg: 'netWeight',
  grossWeightKg: 'grossWeight',
};

interface CellRead {
  value?: number;
  parsed?: ParsedNumber;
  words: PWord[];
  /** Text read in the cell when it was not a number (OCR garbage). */
  garbage?: string;
  /** The table has no column for this field: a value can only be derived, never misread. */
  noColumn?: boolean;
}

function readCell(row: TableRow, field: NumField, dec?: '.' | ','): CellRead {
  const ci = colIndex(row, COLUMN_OF[field]);
  if (ci < 0) return { words: [], noColumn: true };
  for (const { words } of cellLines(row, ci)) {
    const ws = words.filter((w) => !/^\*+$/.test(w.text));
    if (!ws.length) continue;
    const p = parseNumber(ws[0].text, { decimalSep: dec }) ?? parseNumber(joinWords(ws).replace(/\s+/g, ''), { decimalSep: dec });
    if (p) {
      const unit = row.columns[ci].unit;
      const isWeight = field.includes('Weight');
      return { value: isWeight ? weightToKg(p.value, unit) : p.value, parsed: p, words: [ws[0]] };
    }
    return { words: ws, garbage: joinWords(ws) };
  }
  return { words: [] };
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0005);
const r2 = (n: number) => Math.round(n * 1000) / 1000;

/** Count of cartons in a range "1-48" → 48, "138" → 1. */
export function rangeCount(range: string | undefined): number | undefined {
  if (!range) return undefined;
  const m = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return b >= a ? b - a + 1 : undefined;
}

/**
 * Per-row constraint repair: derive missing cells (cartons = pcs ÷ pcs/ctn, totals = cartons × per-carton),
 * confirm separator repairs, and record every derivation.
 */
export function repairPackingLine(ctx: ParseContext, line: PackingListLine, i: number, reads: Partial<Record<NumField, CellRead>>, page?: number): void {
  const path = `lines[${i}]`;
  const label = line.styleNo ?? line.cartonRange ?? `row ${i + 1}`;
  const set = (f: NumField, v: number, why: string, conf = 50) => {
    (line as unknown as Record<string, number>)[f] = r2(v);
    const read = reads[f];
    if (read?.noColumn) {
      // not printed on this document: plain arithmetic, nothing the broker could check against the original
      ctx.observe('note', `${label}: ${f} is not printed; derived ${why}.`, `${path}.${f}`, page);
      return;
    }
    ctx.meta(`${path}.${f}`, read?.words.length ? read.words : undefined, { conf, repaired: true, originalText: read?.garbage ?? '' });
    ctx.observe('ocr_repair', `${label}: ${f} ${read?.garbage ? `read as "${read.garbage}"` : 'not read'}; derived ${why}.`, `${path}.${f}`, page);
  };
  const rc = rangeCount(line.cartonRange);
  // cartons
  if (line.cartons === undefined) {
    const cands: Array<[number, string]> = [];
    if (line.totalPcs !== undefined && line.pcsPerCarton) cands.push([line.totalPcs / line.pcsPerCarton, `${line.totalPcs} pcs ÷ ${line.pcsPerCarton} pcs/ctn`]);
    if (line.netWeightKg !== undefined && line.netWeightPerCartonKg) cands.push([line.netWeightKg / line.netWeightPerCartonKg, `${line.netWeightKg} kg ÷ ${line.netWeightPerCartonKg} kg/ctn`]);
    if (line.grossWeightKg !== undefined && line.grossWeightPerCartonKg) cands.push([line.grossWeightKg / line.grossWeightPerCartonKg, `${line.grossWeightKg} kg ÷ ${line.grossWeightPerCartonKg} kg/ctn`]);
    if (rc !== undefined) cands.push([rc, `carton range '${line.cartonRange}'`]);
    const ints = cands.filter(([v]) => Math.abs(v - Math.round(v)) < 0.02).map(([v, w]) => [Math.round(v), w] as [number, string]);
    if (ints.length && ints.every(([v]) => v === ints[0][0])) set('cartons', ints[0][0], `from ${ints.map(([, w]) => w).join(' and ')} = ${ints[0][0]}`);
  }
  const c = line.cartons;
  if (c) {
    if (line.totalPcs === undefined && line.pcsPerCarton !== undefined) set('totalPcs', c * line.pcsPerCarton, `${c} ctns × ${line.pcsPerCarton} pcs/ctn`, 60);
    if (line.pcsPerCarton === undefined && line.totalPcs !== undefined && Number.isInteger(line.totalPcs / c)) set('pcsPerCarton', line.totalPcs / c, `${line.totalPcs} pcs ÷ ${c} ctns`, 60);
    for (const [per, tot] of [['netWeightPerCartonKg', 'netWeightKg'], ['grossWeightPerCartonKg', 'grossWeightKg']] as const) {
      if (line[tot] === undefined && line[per] !== undefined) set(tot, c * line[per]!, `${c} ctns × ${line[per]} kg/ctn`, 60);
      else if (line[per] === undefined && line[tot] !== undefined) set(per, line[tot]! / c, `${line[tot]} kg ÷ ${c} ctns`, 60);
    }
  }
  // confirm or question values that needed an OCR/separator repair
  const checks: Array<[NumField, () => boolean | undefined, string]> = [
    ['netWeightPerCartonKg', () => (c && line.netWeightKg !== undefined && line.netWeightPerCartonKg !== undefined ? close(c * line.netWeightPerCartonKg, line.netWeightKg) : undefined), 'N.W./ctn'],
    ['grossWeightPerCartonKg', () => (c && line.grossWeightKg !== undefined && line.grossWeightPerCartonKg !== undefined ? close(c * line.grossWeightPerCartonKg, line.grossWeightKg) : undefined), 'G.W./ctn'],
    ['netWeightKg', () => (c && line.netWeightKg !== undefined && line.netWeightPerCartonKg !== undefined ? close(c * line.netWeightPerCartonKg, line.netWeightKg) : undefined), 'total N.W.'],
    ['grossWeightKg', () => (c && line.grossWeightKg !== undefined && line.grossWeightPerCartonKg !== undefined ? close(c * line.grossWeightPerCartonKg, line.grossWeightKg) : undefined), 'total G.W.'],
    ['pcsPerCarton', () => (c && line.totalPcs !== undefined && line.pcsPerCarton !== undefined ? close(c * line.pcsPerCarton, line.totalPcs) : undefined), 'pcs/ctn'],
    ['totalPcs', () => (c && line.totalPcs !== undefined && line.pcsPerCarton !== undefined ? close(c * line.pcsPerCarton, line.totalPcs) : undefined), 'total pcs'],
    ['cartons', () => (c && line.totalPcs !== undefined && line.pcsPerCarton !== undefined ? close(c * line.pcsPerCarton, line.totalPcs) : undefined), 'cartons'],
  ];
  for (const [f, check, name] of checks) {
    const read = reads[f];
    if (!read?.parsed?.repaired) continue;
    const ok = check();
    const path2 = `${path}.${f}`;
    if (ok) {
      ctx.observe('ocr_repair', `${name} for ${label} read as '${read.parsed.original}'; repaired to ${line[f]} (arithmetic confirms: ${describeCheck(line, f)}).`, path2, page);
    } else {
      ctx.meta(path2, read.words, { conf: Math.min(read.words[0]?.conf ?? 50, 50), repaired: true, originalText: read.parsed.original });
      ctx.observe('low_confidence', `${name} for ${label} read as '${read.parsed.original}' and interpreted as ${line[f]}; arithmetic does not confirm it.`, path2, page);
    }
  }
  if (rc !== undefined && c !== undefined && rc !== c) ctx.observe('other', `${label}: carton range '${line.cartonRange}' covers ${rc} cartons but ${c} are listed.`, `${path}.cartons`);
}

/** Digits OCR commonly confuses with each other. */
const DIGIT_CONFUSIONS: Record<string, string> = { '0': '689', '1': '74', '2': '7', '3': '85', '4': '19', '5': '63', '6': '508', '7': '12', '8': '0369', '9': '84' };

/** Values reachable from a read number by one confusable-digit substitution. */
export function confusionVariants(text: string, dec?: '.' | ','): number[] {
  const out = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    for (const d of DIGIT_CONFUSIONS[text[i]] ?? '') {
      const v = parseNumber(text.slice(0, i) + d + text.slice(i + 1), { decimalSep: dec });
      if (v) out.add(v.value);
    }
  }
  return [...out];
}

type Constraint = { per: NumField; total: NumField; sum?: keyof PackingListData['totals'] };
const CONSTRAINTS: Constraint[] = [
  { per: 'pcsPerCarton', total: 'totalPcs', sum: 'pcs' },
  { per: 'netWeightPerCartonKg', total: 'netWeightKg', sum: 'netWeightKg' },
  { per: 'grossWeightPerCartonKg', total: 'grossWeightKg', sum: 'grossWeightKg' },
];

/**
 * Single-cell OCR repair: when a row breaks cartons × per-carton = total with every cell read,
 * try one confusable-digit change per cell. The fix is applied only when it is the unique change
 * that satisfies the row (and the column total, when printed), and it never breaks a constraint
 * that held before.
 */
export function confusionRepair(
  ctx: ParseContext,
  lines: PackingListLine[],
  reads: Array<Partial<Record<NumField, CellRead>>>,
  totals: PackingListData['totals'],
  dec?: '.' | ',',
): void {
  lines.forEach((line, i) => {
    for (const c of CONSTRAINTS) {
      const k = line.cartons;
      const per = line[c.per];
      const tot = line[c.total];
      if (k === undefined || per === undefined || tot === undefined || close(k * per, tot)) continue;
      const fixes: Array<{ field: NumField; value: number }> = [];
      const holdsWith = (field: NumField, value: number) => {
        const probe = { ...line, [field]: value } as PackingListLine;
        if (!close((probe.cartons ?? 0) * (probe[c.per] ?? 0), probe[c.total] ?? NaN)) return false;
        // must not break another row constraint that currently holds
        for (const o of CONSTRAINTS) {
          if (o === c) continue;
          const [a, b] = [line[o.per], line[o.total]];
          if (a === undefined || b === undefined || line.cartons === undefined) continue;
          if (close(line.cartons * a, b) && !close((probe.cartons ?? 0) * (probe[o.per] ?? 0), probe[o.total] ?? NaN)) return false;
        }
        return true;
      };
      for (const field of ['cartons', c.per, c.total] as NumField[]) {
        const read = reads[i]?.[field];
        if (!read?.parsed || read.parsed.repaired) continue;
        for (const v of confusionVariants(read.parsed.original.trim(), dec)) if (holdsWith(field, v)) fixes.push({ field, value: v });
      }
      // column total as a second witness
      const sumOk = (f: { field: NumField; value: number }) => {
        if (!c.sum || totals[c.sum] === undefined || (f.field !== c.total && f.field !== 'cartons')) return undefined;
        const col = f.field === 'cartons' ? 'cartons' : c.sum;
        const lineKey: NumField = f.field === 'cartons' ? 'cartons' : c.total;
        const target = totals[col];
        if (target === undefined) return undefined;
        const sum = lines.reduce((s, l, j) => s + (j === i ? f.value : (l[lineKey] ?? NaN)), 0);
        return close(sum, target);
      };
      const witnessed = fixes.filter((f) => sumOk(f) !== false);
      const pick = witnessed.length === 1 ? witnessed[0] : undefined;
      if (!pick) {
        ctx.observe('other', `${line.styleNo ?? `row ${i + 1}`}: ${k} × ${per} ≠ ${tot}; no unique OCR repair (${fixes.length} candidates), kept as read.`, `lines[${i}].${c.total}`);
        continue;
      }
      const read = reads[i][pick.field]!;
      (line as unknown as Record<string, number>)[pick.field] = pick.value;
      ctx.meta(`lines[${i}].${pick.field}`, read.words, { conf: Math.min(read.words[0]?.conf ?? 60, 60), repaired: true, originalText: read.parsed!.original });
      ctx.observe('ocr_repair', `${line.styleNo ?? `row ${i + 1}`}: ${pick.field} read as '${read.parsed!.original}'; ${pick.value} is the only single-digit reading that satisfies ${describeCheck(line, c.total)}.`, `lines[${i}].${pick.field}`);
    }
  });
}

function describeCheck(line: PackingListLine, f: NumField): string {
  const c = line.cartons;
  if (f.startsWith('net')) return `${c} × ${line.netWeightPerCartonKg} = ${line.netWeightKg}`;
  if (f.startsWith('gross')) return `${c} × ${line.grossWeightPerCartonKg} = ${line.grossWeightKg}`;
  return `${c} × ${line.pcsPerCarton} = ${line.totalPcs}`;
}

const QTY_UNIT_WORD_RE = /^(?:PCS?|PIECES|SETS?|PRS|PAIRS?|DOZ(?:EN)?S?|UNITS?|NOS?|EA|KGS?|M|MTRS?|YDS?|ROLLS?)\.?$/i;

/** The totals row's quantity cell continues on the next line with another unit ("1,440 SETS" / "3,864 PCS"). */
function quantityTotalSplitByUnit(doc: PDoc, tp: TableResult['pages'][number]): boolean {
  const qi = tp.columns.findIndex((c) => c.field === 'quantity');
  const stop = tp.stopLine;
  const page = doc.pages.find((p) => p.page === tp.page);
  if (qi < 0 || !stop || !page) return false;
  const col = tp.columns[qi];
  const unitOf = (ws: PWord[]) => ws.find((w) => QTY_UNIT_WORD_RE.test(w.text))?.text.replace(/\.$/, '').toUpperCase();
  const inCol = (ws: PWord[]) => ws.filter((w) => !w.noise && (w.x0 + w.x1) / 2 >= col.x0 && (w.x0 + w.x1) / 2 < col.x1);
  const first = unitOf(inCol(stop.words));
  const next = page.lines[stop.index + 1];
  if (!first || !next || next.y0 - stop.y1 > 1.5 * page.medH) return false;
  const nextWords = inCol(next.words);
  const second = unitOf(nextWords);
  return !!second && second !== first && nextWords.some((w) => /\d/.test(w.text));
}

/** Parses a packing list document. */
export function parsePackingList(doc: PDoc, ctx: ParseContext): { data: PackingListData; table: TableResult } {
  const table = extractTable(doc, {
    anchors: ['cartonRange', 'style', 'lineNo', 'description'],
    requireAny: ['cartons', 'pcsPerCarton', 'netWeight', 'grossWeight', 'netWeightPerCarton', 'grossWeightPerCarton', 'cartonRange', 'quantity'],
    minFields: 3,
  });
  for (const w of table.warnings) ctx.warn(w);
  const ex = { exclude: tableRegions(table) };

  // ── parties ──
  const shipper = partyBlock(doc, ['shipper', 'seller'], ex)?.address;
  const consignee = (partyBlock(doc, 'consignee', ex) ?? partyBlock(doc, 'buyer', ex))?.address;
  const deliverTo = partyBlock(doc, 'shipTo', ex)?.address;
  const lh = letterhead(doc);
  const mfrBlock = partyBlock(doc, 'manufacturer', ex);
  let manufacturer = mfrBlock?.address;
  if (!manufacturer && lh && looksLikeManufacturer(lh.name)) manufacturer = letterheadParty(lh);
  if (!manufacturer && shipper && looksLikeManufacturer(shipper.name)) manufacturer = shipper;

  // ── header fields ──
  const pl = labelText(doc, 'plNumber', { ...ex, validate: (t) => /\d/.test(firstCode(t)) });
  const issuerCountry = (lh ? letterheadParty(lh).country : undefined) ?? shipper?.country;
  const dateV = labelText(doc, 'date', { ...ex, validate: (t) => !!parseDate(t) });
  const date = dateV ? parseDate(dateV.text, { monthFirst: isMonthFirstCountry(issuerCountry) }) : null;
  const invoiceRefs: string[] = [];
  for (const v of labelTexts(doc, 'invoiceRef', { ...ex, validate: (t) => /\d/.test(firstCode(t)) })) {
    const c = firstCode(v.text);
    if (!invoiceRefs.includes(c)) invoiceRefs.push(c);
  }
  const poNumbers: string[] = [];
  for (const v of labelTexts(doc, 'poNumber', { ...ex, validate: (t) => /\d/.test(firstCode(t)) })) {
    const c = firstCode(v.text);
    if (!poNumbers.includes(c) && !invoiceRefs.includes(c)) poNumbers.push(c);
  }
  let vessel: string | undefined;
  let voyage: string | undefined;
  const vv = labelText(doc, ['vesselVoyage', 'vessel'], ex);
  if (vv) ({ vessel, voyage } = splitVesselVoyage(vv.text));
  voyage ??= labelText(doc, 'voyage', ex)?.text;
  const cntr = labelText(doc, 'containerNo', { ...ex, validate: (t) => !!parseSizeType(t) || /[A-Z]{4}\s?\d{6,7}/i.test(t) });
  const pol = labelText(doc, 'portOfLoading', ex);
  const pod = labelText(doc, 'portOfDischarge', ex);

  // ── remarks + shipping marks ──
  const remarks: string[] = [];
  const remarkParas = findLabelValues(doc, 'notes', { mode: 'block', maxLines: 25, stopAtLabels: false, ...ex }).flatMap((v) => splitNotes(v.lines).map((p) => ({ ...p, page: v.page })));
  for (const p of remarkParas) remarks.push(p.text);
  const marksV = findLabelValue(doc, 'shippingMarks', { mode: 'block', maxLines: 14, stopAtLabels: false, ...ex });
  const shippingMarks = marksV?.lines.map((l) => squash(l));

  // ── lines ──
  const numericTexts = table.rows.flatMap((r) => r.columns.flatMap((c, i) => (c.field && c.field !== 'cartonRange' && c.field !== 'style' && c.field !== 'description' && c.field !== 'colourSize' && c.field !== 'dimensions' ? r.cells[i].flatMap((ws) => ws.map((w) => w.text)) : [])));
  const dec = detectDecimalSep(numericTexts);
  const allReads: Array<Partial<Record<NumField, CellRead>>> = [];
  const lines: PackingListLine[] = table.rows.map((row, i) => {
    const path = `lines[${i}]`;
    const descIdx = colIndex(row, 'description');
    let descLines = descIdx >= 0 ? cellLines(row, descIdx).map((c) => c.text) : [];
    const extra = row.columns
      .map((c, ci) => ({ c, ci }))
      .filter(({ c }) => c.field === 'colourSize' || (c.field === null && !c.inferred) || c.field === 'origin' || c.field === 'po')
      .flatMap(({ ci }) => cellLines(row, ci).map((x) => x.text));
    const rangeCi = colIndex(row, 'cartonRange');
    const cartonRange = rangeCi >= 0 ? cellLines(row, rangeCi)[0]?.text.replace(/\s*[-–~]\s*/g, '-').replace(/\s*TO\s*/i, '-') : undefined;
    const styleCi = colIndex(row, 'style');
    let styleNo = styleCi >= 0 ? cellLines(row, styleCi)[0]?.text.replace(/\s*-\s*/g, '-').split(/\s+/)[0] : undefined;
    if (!styleNo) {
      const sc = splitLeadingCode(descLines);
      if (sc.code) [styleNo, descLines] = [sc.code, sc.lines];
    }
    const line: PackingListLine = { description: descLines[0] ?? '', details: [...descLines.slice(1), ...extra] };
    if (cartonRange) line.cartonRange = cartonRange;
    if (styleNo) line.styleNo = styleNo;
    const reads: Partial<Record<NumField, CellRead>> = {};
    for (const f of Object.keys(COLUMN_OF) as NumField[]) {
      const r = readCell(row, f, dec);
      reads[f] = r;
      if (r.value !== undefined) {
        (line as unknown as Record<string, number>)[f] = r.value;
        ctx.meta(`${path}.${f}`, r.words, r.parsed?.repaired ? { repaired: true, originalText: r.parsed.original } : {});
      }
    }
    const volCi = colIndex(row, 'volume');
    const volText = volCi >= 0 ? cellLines(row, volCi)[0]?.text : undefined;
    const vol = volText ? parseNumber(volText.split(/\s+/)[0], { decimalSep: dec }) : null;
    if (vol) line.volumeCbm = volumeToCbm(vol.value, row.columns[volCi].unit ?? volText);
    const dimCi = colIndex(row, 'dimensions');
    const dims = dimCi >= 0 ? cellLines(row, dimCi)[0]?.text : undefined;
    if (dims && /\d/.test(dims) && !/CBM|M3/i.test(dims)) line.dimensions = dims.replace(/\s*[xX×*]\s*/g, 'x').replace(/\s+/g, '');
    const all = [line.description, ...line.details].join(' ');
    const comp = parseComposition(line.description) ?? parseComposition(line.details.join(' \n '));
    if (comp) {
      line.composition = comp.fibers;
      line.compositionRaw = comp.raw;
    }
    const markers = findMarkers(rowText(row));
    if (markers.length) line.footnoteRefs = markers;
    const coo = /\b(?:ORIGIN|COUNTRY\s+OF\s+ORIGIN|C\/O|COO|MADE\s+IN)\s*[:-]?\s*([A-Za-z][A-Za-z .'-]{2,40})/i.exec(all);
    if (coo) {
      const c = countryCode(coo[1].split(/[),;]/)[0]) ?? findCountry(coo[1].split(/[),;]/)[0])?.iso;
      if (c) line.countryOfOrigin = c;
    }
    repairPackingLine(ctx, line, i, reads, row.page);
    allReads.push(reads);
    return line;
  });

  // remarks → lines
  lines.forEach((line, i) => {
    for (const p of remarkParas) {
      const byMarker = (line.footnoteRefs ?? []).some((m) => markersInNote(p).includes(m));
      if (!byMarker && !noteMentions(p.text, { styleNo: line.styleNo, cartonRange: line.cartonRange })) continue;
      const facts = lineFactsFromNote(p.text);
      if (facts.countryOfOrigin && !line.countryOfOrigin) line.countryOfOrigin = facts.countryOfOrigin;
      if (facts.manufacturer && !line.manufacturer) line.manufacturer = facts.manufacturer;
      if (byMarker || facts.countryOfOrigin || facts.manufacturer) ctx.observe('footnote', p.text, `lines[${i}]`, p.page);
    }
  });

  // ── totals ──
  const totals: PackingListData['totals'] = {};
  const last = [...table.pages].reverse().find((p) => p.stopCells);
  if (last?.stopCells) {
    last.columns.forEach((c, ci) => {
      const ws = last.stopCells![ci];
      const t = joinWords(ws);
      const p = parseNumber((ws[0]?.text ?? '').trim(), { decimalSep: dec });
      if (!p) return;
      if (/CBM|M3|CFT/i.test(t) || c.field === 'volume') totals.volumeCbm = volumeToCbm(p.value, t);
      else if (c.field === 'cartons') totals.cartons = p.value;
      else if (c.field === 'quantity') totals.pcs = p.value;
      else if (c.field === 'netWeight') totals.netWeightKg = weightToKg(p.value, c.unit);
      else if (c.field === 'grossWeight') totals.grossWeightKg = weightToKg(p.value, c.unit);
      ctx.meta(`totals.${c.field === 'quantity' ? 'pcs' : c.field === 'netWeight' ? 'netWeightKg' : c.field === 'grossWeight' ? 'grossWeightKg' : /CBM/i.test(t) ? 'volumeCbm' : c.field}`, [ws[0]]);
    });
  }
  const qtySplitByUnit = !!last && quantityTotalSplitByUnit(doc, last);
  if (totals.pcs !== undefined && qtySplitByUnit) {
    // "1,440 SETS" over "3,864 PCS": per-unit totals, not one piece count
    delete totals.pcs;
    ctx.observe('other', 'The quantity total is printed per unit of measure (several lines in the total row); no single piece total is used.', 'totals.pcs');
  }
  const labelled = (field: 'netWeight' | 'grossWeight' | 'measurement') =>
    findLabelValue(doc, field, { validate: (t) => /\d/.test(t), exclude: ex.exclude, mode: 'right' });
  const numIn = (t: string) => parseNumber((/\d[\d.,]*/.exec(t) ?? [''])[0], { decimalSep: dec });
  if (totals.netWeightKg === undefined) {
    const v = labelled('netWeight');
    const n = v && numIn(v.text);
    if (n) totals.netWeightKg = weightToKg(n.value, v!.text);
  }
  if (totals.grossWeightKg === undefined) {
    const v = labelled('grossWeight');
    const n = v && numIn(v.text);
    if (n) totals.grossWeightKg = weightToKg(n.value, v!.text);
  }
  if (totals.volumeCbm === undefined) {
    const v = labelled('measurement');
    const n = v && numIn(v.text);
    if (n) totals.volumeCbm = volumeToCbm(n.value, v!.text);
  }
  if (totals.cartons === undefined) {
    const t = doc.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
    const m = /\((\d{1,6})\)\s*(?:CARTONS|CTNS|PACKAGES|PKGS)\b/i.exec(t) ?? /\bTOTAL\s*(?:CARTONS|CTNS|PACKAGES|PKGS)\s*[:.]?\s*(\d{1,6})/i.exec(t);
    if (m) totals.cartons = Number(m[1]);
  }
  confusionRepair(ctx, lines, allReads, totals, dec);
  // column sums: fill gaps, report disagreements
  const sums: Array<[keyof PackingListData['totals'], keyof PackingListLine]> = [
    ['cartons', 'cartons'],
    ['pcs', 'totalPcs'],
    ['netWeightKg', 'netWeightKg'],
    ['grossWeightKg', 'grossWeightKg'],
  ];
  for (const [tk, lk] of sums) {
    if (tk === 'pcs' && qtySplitByUnit) continue;
    const vals = lines.map((l) => l[lk] as number | undefined);
    if (!vals.length || vals.some((v) => v === undefined)) continue;
    const sum = r2(vals.reduce((s: number, v) => s + (v as number), 0));
    if (totals[tk] === undefined) {
      totals[tk] = sum;
      ctx.meta(`totals.${tk}`, undefined, { conf: 70, repaired: true, originalText: '' });
      ctx.observe('ocr_repair', `Total ${tk} not read; derived as the sum of the lines (${sum}).`, `totals.${tk}`);
    } else if (!close(sum, totals[tk]!)) {
      ctx.observe('other', `Sum of line ${lk} is ${sum} but the printed total is ${totals[tk]}.`, `totals.${tk}`);
    }
  }

  const data: PackingListData = { kind: 'packing_list', invoiceRefs, poNumbers, lines, totals, remarks };
  if (pl) data.plNumber = firstCode(pl.text);
  if (date) data.date = date.iso;
  if (shipper) data.shipper = shipper;
  if (consignee) data.consignee = consignee;
  if (deliverTo) data.deliverTo = deliverTo;
  if (manufacturer) data.manufacturer = manufacturer;
  if (vessel) data.vessel = vessel;
  if (voyage) data.voyage = voyage;
  if (cntr) data.containerSummary = cntr.text;
  if (pol) data.portOfLoading = pol.text;
  if (pod) data.portOfDischarge = pod.text;
  if (shippingMarks?.length) data.shippingMarks = shippingMarks;
  return { data, table };
}
