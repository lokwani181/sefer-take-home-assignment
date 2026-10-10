/**
 * Commercial invoice parser (also used for combined invoice + packing list documents).
 *
 * Header fields come from labelled values (vocab synonyms), parties from labelled blocks
 * or the letterhead, lines from the header-driven item table, and totals/charges/notes
 * from the area around the table. Nothing here depends on a specific layout.
 */
import type { Assist, Charge, CommercialInvoiceData, InvoiceLine, PrintedTotal } from '@app/shared';
import type { ParseContext } from '../context';
import { bboxOf, joinWords, segmentsOf, type PDoc, type PLine, type PPage, type PWord } from '../layout';
import { extractTable, cellLines, colIndex, rowText, type TableResult, type TableRow } from '../table';
import { detectDecimalSep, parseNumber, type ParsedNumber } from '../numbers';
import { findDates, isMonthFirstCountry, parseDate } from '../dates';
import { countryCode, findCountry } from '../countries';
import { parseComposition } from '../domain/composition';
import { detectConstruction, detectGarmentType, detectGender } from '../domain/garment';
import { cleanCode, looksLikeBillNumber, normalizeIncotermCode, parseCurrency, parseHsCell, parseIncoterm, weightToKg, volumeToCbm } from '../domain/codes';
import { classifyCharge, findAssist, isNoCommercialValue, statedCustomsValue } from '../domain/value';
import { findMarkers, markersInNote, splitNotes, type NoteParagraph } from '../footnotes';
import { ASSIST_RE, BROUGHT_FORWARD_RE } from '../vocab';
import { ENCLOSED_NUMBER_RE, findLabels, findLabelValue, findLabelValues, type LabelValue, type Region } from '../labels';
import {
  firstCode,
  labelText,
  labelTexts,
  letterhead,
  letterheadParty,
  lineFactsFromNote,
  looksLikeManufacturer,
  noteMentions,
  partyBlock,
  splitLeadingCode,
  tableRegions,
  unlabeledAddresses,
} from './common';
import { squash, trimSeparators } from '../text';

export interface MoneyLine {
  label: string;
  amount: ParsedNumber;
  words: PWord[];
  page: number;
}

const TOTAL_LABEL_RE = /\b(?:TOTAL|TOTALS|SUB-?TOTAL|SUBTOTAL|GRAND|CARRIED\s+FORWARD|BALANCE|AMOUNT\s+DUE|NET\s+AMOUNT|INVOICE\s+(?:TOTAL|VALUE|AMOUNT)|(?:EXW|FCA|FAS|FOB|CFR|C&F|CIF|CPT|CIP|DAP|DPU|DDP|GOODS)\s+VALUE)\b/i;
const QTY_LABEL_RE = /\b(?:QUANTITY|QTY|PACKAGES|CARTONS|CTNS|PCS|PIECES|WEIGHT|KGS?|LBS|CBM|MEAS|VOLUME|N\.?W|G\.?W)\b/i;

/** Unit words printed after a quantity total ("1,440 SETS", "2,004 CTNS"). */
const QTY_UNIT_RE = /^(?:PCS?|PIECES|SETS?|PRS|PAIRS?|CTNS?|CARTONS?|PKGS?|PACKAGES|KGS?|LBS?|DOZ(?:EN)?S?|UNITS?|NOS?|EA|M3|CBM|ROLLS?|BALES?|BOXES|CASES)\.?$/i;

function isMoneyToken(w: PWord): ParsedNumber | null {
  if (/[:;]$/.test(w.text)) return null;
  // dates ("2026.09.11", "11.09.2026") are not amounts
  if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(w.text)) return null;
  const p = parseNumber(w.text, { ocrFix: false });
  if (!p) return null;
  if (p.decimals === 2 || /\d[,.]\d{3}/.test(w.text) || p.parenthesized) return p;
  return null;
}

/** Words of a line inside [x0, x1). */
const wordsIn = (line: PLine, x0: number, x1: number) => line.words.filter((w) => !w.noise && w.x1 > x0 && w.x0 < x1);

/**
 * A label printed directly above an amount in its own box ("Total CFR Savannah" over "USD 114,300.00"):
 * the previous line's words over the amount's extent, when they are text only.
 */
function stackedLabel(page: PPage, line: PLine, x0: number, x1: number): PWord[] | null {
  const yc = (l: PLine) => (l.y0 + l.y1) / 2;
  for (let k = line.index - 1; k >= 0 && k >= line.index - 3; k--) {
    const above = page.lines[k];
    if (yc(line) - yc(above) > 3 * page.medH) return null;
    const ws = wordsIn(above, x0 - page.medH, x1 + page.medH);
    if (!ws.length) continue;
    if (ws.some((w) => /\d/.test(w.text)) || !ws.some((w) => /[A-Za-z]{3,}/.test(w.text))) return null;
    // the whole label must sit over the amount's box, not run in from the left
    const seg = segmentsOf({ ...above, words: above.words.filter((w) => w.x1 > x0 - page.segGap) }, page.segGap).find((sg) => sg.some((w) => ws.includes(w)));
    return seg && seg[0].x0 >= x0 - 2 * page.medH ? seg : null;
  }
  return null;
}

/**
 * An amount alone on its line, vertically centred against a two-line label to its left
 * ("Ocean freight Tanjung Priok – Savannah," / "USD 4,350.00" / "1 x 40' GP, prepaid"): the label
 * line right above (else below) with text ending left of the amount and no amount of its own there.
 */
function centredLabel(page: PPage, line: PLine, x0: number): PWord[] | null {
  for (const other of [page.lines[line.index - 1], page.lines[line.index + 1]]) {
    if (!other) continue;
    const dy = other.index < line.index ? line.y0 - other.y1 : other.y0 - line.y1;
    if (dy > 1.2 * page.medH) continue;
    const left = other.words.filter((w) => !w.noise && w.x1 <= x0);
    if (!left.length || left.some((w) => isMoneyToken(w)) || !left.some((w) => /[A-Za-z]{3,}/.test(w.text))) continue;
    const segs = segmentsOf({ ...other, words: left }, page.segGap);
    return segs[segs.length - 1];
  }
  return null;
}

/** "label: amount" pairs outside the item table (totals, charges). */
export function scanLabelledAmounts(doc: PDoc, skip: Set<PLine>): MoneyLine[] {
  const out: MoneyLine[] = [];
  for (const page of doc.pages) {
    for (const line of page.lines) {
      if (skip.has(line)) continue;
      const segs = segmentsOf(line, page.segGap);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const last = seg[seg.length - 1];
        const amount = isMoneyToken(last);
        if (!amount) continue;
        let labelWords = seg.slice(0, -1);
        const textual = (ws: PWord[]) => ws.some((w) => !/^[-–]?(?:USD|US\$|EUR|€|GBP|£|HKD|CNY|RMB|JPY|\$|[:=])$/i.test(w.text) && /[A-Za-z]{2,}/.test(w.text));
        if (!textual(labelWords)) {
          // a label in its own box above the amount wins over text far to the left on the same line
          const prevSeg = segs[i - 1];
          const farLeft = !prevSeg || seg[0].x0 - prevSeg[prevSeg.length - 1].x1 > 4 * page.medH;
          const above = farLeft ? stackedLabel(page, line, seg[0].x0, last.x1) : null;
          const centred = !above && !prevSeg ? centredLabel(page, line, seg[0].x0) : null;
          if (above || centred) {
            const lw = above ?? centred!;
            const label = trimSeparators(joinWords(lw)).replace(/\s*[:=]$/, '');
            if (/[A-Za-z]{3,}/.test(label)) {
              const neg = labelWords.some((w) => /^[-–]/.test(w.text));
              out.push({ label, amount: neg ? { ...amount, negative: true } : amount, words: [...lw, last], page: page.page });
            }
            continue;
          }
        }
        // several money figures in a row ("TOTAL: 370 2,390 PCS 20,920.00 4,830.00 5,335.00") are the
        // columns of a totals row: which one is money is the table's business, not this scanner's
        if (labelWords.some((w, j) => isMoneyToken(w) && !QTY_UNIT_RE.test(labelWords[j + 1]?.text ?? ''))) continue;
        // a currency code (possibly signed: "-USD 5,299.63") between label and amount
        const CUR = /^[-–]?(?:USD|US\$|U\.S\.\$|EUR|€|GBP|£|HKD|HK\$|CNY|RMB|JPY|\$|[:=])$/i;
        // quantity totals printed between the label and the amount are skipped:
        // "TOTAL  3000  3,800.00", "SUB TOTAL  1,440 SETS  176,654.40"
        const qtySeg = (sg: PWord[]) =>
          sg.some((w) => /\d/.test(w.text)) &&
          sg.every((w) => (/^[\d.,]+$/.test(w.text) && (!isMoneyToken(w) || sg.some((x) => QTY_UNIT_RE.test(x.text)))) || QTY_UNIT_RE.test(w.text));
        let signed = labelWords.some((w) => /^[-–]/.test(w.text) && CUR.test(w.text));
        if (!labelWords.some((w) => !CUR.test(w.text) && /[A-Za-z]{2,}/.test(w.text)) && i > 0) {
          let k = i - 1;
          const curSeg = (sg: PWord[]) => sg.every((w) => CUR.test(w.text));
          while (k > 0 && (qtySeg(segs[k]) || curSeg(segs[k]))) {
            if (curSeg(segs[k]) && segs[k].some((w) => /^[-–]/.test(w.text))) signed = true;
            k--;
          }
          const prev = segs[k];
          if (!isMoneyToken(prev[prev.length - 1]) && !qtySeg(prev) && !curSeg(prev) && prev.some((w) => /[A-Za-z]{2,}/.test(w.text))) labelWords = [...prev, ...labelWords];
        }
        while (labelWords.length && CUR.test(labelWords[labelWords.length - 1].text)) labelWords = labelWords.slice(0, -1);
        const label = trimSeparators(joinWords(labelWords)).replace(/\s*[:=]$/, '').replace(/[\s:]+(?:USD|US\$|EUR|GBP|HKD|CNY|RMB)$/i, '');
        if (!/[A-Za-z]{3,}/.test(label)) continue;
        out.push({ label, amount: signed ? { ...amount, negative: true } : amount, words: [...labelWords, last], page: page.page });
      }
    }
  }
  return out;
}

/**
 * "Invoice No. & Date" boxes print the date on the number's line, often right-aligned far from it:
 * the rest of that line (up to the next box) when the label names both fields.
 */
function dateBesideNumber(doc: PDoc, v: LabelValue): { text: string; words: PWord[]; value: LabelValue } | null {
  if (!/\bDATE\b/i.test(v.hit.synonym)) return null;
  const first = v.words[0];
  const page = doc.pages.find((p) => p.page === v.page);
  if (!first || !page) return null;
  const rest: PWord[] = [];
  for (const w of page.lines[first.line].words) {
    if (w.noise || w.x0 <= v.bbox[2]) continue;
    if (ENCLOSED_NUMBER_RE.test(w.text)) break;
    rest.push(w);
  }
  const text = joinWords(rest);
  return parseDate(text) ? { text, words: rest, value: v } : null;
}

const FOOTNOTE_START_RE = /^(?:\(\*{1,3}\)|\*{1,3})\s+\S/;

/**
 * Footnotes printed without a "Notes" label: a paragraph outside the item rows that starts with an
 * asterisk marker ("* Article X was manufactured at …"). It runs on over the following lines until a
 * blank line, another marker, or a line that starts a labelled field.
 */
export function unlabeledFootnotes(doc: PDoc, rowLines: Set<PLine>): Array<NoteParagraph & { page: number }> {
  const out: Array<NoteParagraph & { page: number }> = [];
  const labelStarts = new Set(findLabels(doc).filter((h) => h.credible).map((h) => h.words[0]));
  for (const page of doc.pages) {
    const gap = typicalLineGap(page);
    for (let i = 0; i < page.lines.length; i++) {
      const first = page.lines[i];
      if (rowLines.has(first) || !FOOTNOTE_START_RE.test(first.text)) continue;
      const lines = [first.text];
      let prev = first;
      for (let j = i + 1; j < page.lines.length; j++) {
        const l = page.lines[j];
        const w0 = l.words.find((w) => !w.noise);
        if (rowLines.has(l) || FOOTNOTE_START_RE.test(l.text) || (w0 && labelStarts.has(w0)) || l.y0 - prev.y1 > gap + 0.7 * page.medH) break;
        if (Math.abs(l.x0 - first.x0) > 3 * page.medH) break;
        lines.push(l.text);
        prev = l;
        i = j;
      }
      for (const p of splitNotes(lines)) out.push({ ...p, page: page.page });
    }
  }
  return out;
}

/** The part of a notes block above its first line that starts with a "Label :" form field. */
function notesBeforeFormFields(doc: PDoc, v: LabelValue): LabelValue {
  const starts = new Set(findLabels(doc).filter((h) => h.colon && h.credible).map((h) => h.words[0]));
  const cut = v.lineWords.findIndex((ws) => starts.has(ws[0]));
  if (cut < 0) return v;
  const lineWords = v.lineWords.slice(0, cut);
  const words = lineWords.flat();
  return { ...v, lineWords, lines: v.lines.slice(0, cut), words, text: v.lines.slice(0, cut).join(' '), bbox: words.length ? bboxOf(words) : v.bbox };
}

/** Splits a "vessel / voyage" value: "PACIFIC ARGOS / 041E" or "PACIFIC ARGOS 041E". */
export function splitVesselVoyage(text: string): { vessel?: string; voyage?: string } {
  const t = squash(text.replace(/\b(?:V\.|VOY\.?|VOYAGE)\s*(?=[A-Z0-9]*\d)/i, ' / '));
  const parts = t.split(/\s+\/\s+|\s*\/\s*(?=[A-Z0-9]*\d[A-Z0-9]*$)/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { vessel: parts.slice(0, -1).join(' / '), voyage: parts[parts.length - 1] };
  const toks = t.split(' ');
  const last = toks[toks.length - 1];
  if (toks.length >= 2 && /\d/.test(last) && last.length <= 10) return { vessel: toks.slice(0, -1).join(' '), voyage: last };
  return { vessel: t || undefined };
}

interface InvoiceParse {
  data: CommercialInvoiceData;
  table: TableResult;
}

const num = (t: string, dec?: '.' | ',') => parseNumber(t.replace(/\s+/g, ''), { decimalSep: dec }) ?? parseNumber(t.split(/\s+/)[0] ?? '', { decimalSep: dec });

/** Parses a commercial invoice (or the invoice part of a combined invoice/packing list). */
export function parseInvoice(doc: PDoc, ctx: ParseContext, opts: { combined?: boolean } = {}): InvoiceParse {
  const table = extractTable(doc, {
    anchors: ['lineNo', 'style', 'hsCode', 'description'],
    requireAny: ['quantity', 'amount', 'unitPrice'],
    minFields: 3,
  });
  for (const w of table.warnings) ctx.warn(w);
  const regions: Region[] = tableRegions(table);
  const ex = { exclude: regions };
  const tableBands = [...regions];

  // ── parties ──
  const sellerBlock = partyBlock(doc, 'seller', ex);
  const lh = letterhead(doc);
  const seller = sellerBlock?.address ?? (lh ? letterheadParty(lh) : undefined);
  const buyerBlock = partyBlock(doc, 'buyer', ex);
  const shipToBlock = partyBlock(doc, 'shipTo', ex);
  const consigneeBlock = partyBlock(doc, 'consignee', ex);
  let buyer = buyerBlock?.address;
  let shipTo = shipToBlock?.address;
  if (!buyer && consigneeBlock) buyer = consigneeBlock.address;
  else if (!shipTo && consigneeBlock && consigneeBlock.address.name !== buyer?.name) shipTo = consigneeBlock.address;
  if (!buyer && !shipTo) {
    // recipient address printed without a label (letter-style invoices)
    const tableTop = tableBands[0]?.page === 1 ? tableBands[0].y0 : undefined;
    const cands = unlabeledAddresses(doc, { maxY: tableTop, exclude: seller ? [seller.name] : [] }).filter(
      (a) => !seller || a.name.toUpperCase() !== seller.name.toUpperCase(),
    );
    if (cands[0]) buyer = cands[0];
  }
  const mfrBlock = partyBlock(doc, 'manufacturer', ex);
  const manufacturer = mfrBlock?.address ?? (seller && looksLikeManufacturer(seller.name) ? seller : undefined);

  // ── notes ──
  const notes: string[] = [];
  const noteParas: Array<NoteParagraph & { page: number }> = [];
  for (const found of findLabelValues(doc, 'notes', { mode: 'block', maxLines: 30, stopAtLabels: false, ...ex })) {
    // a remarks box that holds labelled form fields ("Terms of Price : FOB …", "P/O No. : …") ends where
    // they start: those lines are header fields, not prose
    const v = notesBeforeFormFields(doc, found);
    // header fields are never read from inside a notes block
    regions.push({ page: v.page, y0: v.hit.y0, y1: v.words.length ? v.bbox[3] : v.hit.y1 });
    for (const p of splitNotes(v.lines)) {
      noteParas.push({ ...p, page: v.page });
      notes.push(p.text);
    }
  }
  for (const p of unlabeledFootnotes(doc, new Set(table.rows.flatMap((r) => r.lines)))) {
    if (noteParas.some((n) => n.text.includes(p.text.slice(0, 40)))) continue;
    noteParas.push(p);
    notes.push(p.text);
  }
  for (const v of findLabelValues(doc, 'declaration', { mode: 'block', maxLines: 10, ...ex })) {
    const head = v.hit.words.map((w) => w.text).join(' ');
    const text = squash(`${head} ${v.lines.join(' ')}`);
    notes.push(text);
    noteParas.push({ text, page: v.page });
  }

  // ── header fields ──
  const invNo = labelText(doc, 'invoiceNumber', { ...ex, validate: (t) => /\d/.test(firstCode(t)) });
  let invoiceNumber = invNo ? firstCode(invNo.text) : '';
  if (!invoiceNumber) {
    const m = /\bINVOICE\s*(?:NO\.?|NUMBER|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i.exec(doc.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n'));
    if (m) invoiceNumber = m[1];
    else ctx.warn('invoice number not found');
  }
  if (invNo) ctx.meta('invoiceNumber', invNo.words.filter((w) => invoiceNumber.includes(w.text.replace(/[^A-Z0-9/-]/gi, '')) || invNo.words.length === 1));

  const monthFirst = isMonthFirstCountry(seller?.country);
  const dateVal =
    labelText(doc, 'invoiceDate', { ...ex, validate: (t) => !!parseDate(t) }) ??
    labelText(doc, 'date', { ...ex, validate: (t) => !!parseDate(t) }) ??
    (invNo ? dateBesideNumber(doc, invNo.value) : null);
  const date = dateVal ? parseDate(dateVal.text, { monthFirst }) : null;

  const poNumbers: string[] = [];
  for (const v of labelTexts(doc, 'poNumber', { ...ex, validate: (t) => /\d/.test(firstCode(t)) })) {
    // a list of order numbers: stop at the first part that is not a code ("..., value USD 4,180.00")
    for (const part of v.text.split(/\s*[,;&]\s*|\s+AND\s+|\s+\/\s+/i)) {
      const code = firstCode(part);
      const isCode = /\d/.test(code) && code.length >= 3 && !/^\d+[.,]\d{2}$/.test(code) && part.trim().split(/\s+/).length <= 2;
      if (!isCode) break;
      if (!poNumbers.includes(code) && code !== invoiceNumber) poNumbers.push(code);
    }
  }

  const amountCol = table.pages[0]?.columns.find((c) => c.field === 'amount' || c.field === 'unitPrice');
  const curVal = labelText(doc, 'currency', ex);
  const allText = doc.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
  const currency = (curVal && parseCurrency(curVal.text)) || (amountCol?.unit && parseCurrency(amountCol.unit)) || parseCurrency(allText);

  const incVal = labelText(doc, 'incoterms', { ...ex, validate: (t) => !!parseIncoterm(t) });
  let incoterm = incVal ? parseIncoterm(incVal.text) ?? undefined : undefined;
  if (!incoterm) {
    // the label is the term itself and the value is the named place ("F.O.B.  CHENNAI")
    const pt = findLabelValue(doc, 'incotermPoint', { ...ex, validate: (t) => /[A-Za-z]{3,}/.test(t) });
    const code = pt ? normalizeIncotermCode(pt.hit.words.map((w) => w.text).join(' ')) : undefined;
    if (pt && code) incoterm = { code, place: trimSeparators(pt.text) };
  }

  const payVal = labelText(doc, 'paymentTerms', { ...ex, validate: (t) => /[A-Za-z]{2,}/.test(t) && !/^\d/.test(t) });
  const cooVal = labelText(doc, 'countryOfOrigin', { ...ex, validate: (t) => !!(countryCode(t) ?? findCountry(t)) });
  const pol = labelText(doc, 'portOfLoading', ex);
  const pod = labelText(doc, 'portOfDischarge', ex);
  let vessel: string | undefined;
  let voyage: string | undefined;
  const vv = labelText(doc, 'vesselVoyage', ex);
  if (vv) ({ vessel, voyage } = splitVesselVoyage(vv.text));
  else {
    vessel = labelText(doc, 'vessel', ex)?.text;
    voyage = labelText(doc, 'voyage', ex)?.text;
    const fl = labelText(doc, 'flight', ex);
    if (!vessel && fl) vessel = fl.text;
  }
  const ref = labelText(doc, 'transportRef', { ...ex, validate: (t) => looksLikeBillNumber(firstCode(t)) });
  let etd: string | undefined;
  let eta: string | undefined;
  const both = labelText(doc, 'etdEta', ex);
  if (both) {
    const ds = findDates(both.text, { monthFirst });
    etd = ds[0]?.iso;
    eta = ds[1]?.iso;
  }
  etd ??= parseDate(labelText(doc, 'etd', { ...ex, validate: (t) => !!parseDate(t) })?.text ?? '', { monthFirst })?.iso;
  eta ??= parseDate(labelText(doc, 'eta', { ...ex, validate: (t) => !!parseDate(t) })?.text ?? '', { monthFirst })?.iso;

  // ── lines ──
  const allCells = table.rows.flatMap((r) =>
    r.columns.flatMap((c, i) => (c.field && ['quantity', 'unitPrice', 'amount'].includes(c.field) ? r.cells[i].map((ws) => joinWords(ws)) : [])),
  );
  const dec = detectDecimalSep(allCells.flatMap((t) => t.split(/\s+/)));
  const gapByPage = new Map(doc.pages.map((p) => [p.page, typicalLineGap(p)]));
  const lines: InvoiceLine[] = table.rows.map((row, i) => buildLine(ctx, row, i, dec, gapByPage.get(row.page) ?? 0));

  // footnotes/remarks that mention a line
  lines.forEach((line, i) => {
    for (const p of noteParas) {
      const markers = markersInNote(p);
      const byMarker = (line.footnoteRefs ?? []).some((m) => markers.includes(m));
      if (!byMarker && !noteMentions(p.text, { styleNo: line.styleNo, lineNo: line.lineNo })) continue;
      if (byMarker) ctx.observe('footnote', p.text, `lines[${i}]`, p.page);
      const facts = lineFactsFromNote(p.text);
      if (facts.countryOfOrigin && !line.countryOfOrigin && byMarker) line.countryOfOrigin = facts.countryOfOrigin;
      if (facts.manufacturer && !line.manufacturer && byMarker) line.manufacturer = facts.manufacturer;
      if (!line.noCommercialValue && !ASSIST_RE.test(p.text) && isNoCommercialValue(p.text) && noteMentions(p.text, { lineNo: line.lineNo, styleNo: line.styleNo })) {
        // a note saying "Item 5 samples are free of charge" marks the line NCV
        line.noCommercialValue = true;
      }
    }
  });

  // ── totals, charges, packages ──
  const rowLines = new Set(table.rows.flatMap((r) => r.lines));
  const money = scanLabelledAmounts(doc, rowLines);
  const totals: PrintedTotal[] = [];
  const charges: Charge[] = [];
  for (const m of money) {
    const amount = m.amount.value;
    const chargeType = classifyCharge(m.label);
    // quantity/weight totals are not money, unless the label names a charge ("3% VOLUME DISCOUNT")
    if (QTY_LABEL_RE.test(m.label) && !/VALUE|AMOUNT/i.test(m.label) && !chargeType) continue;
    const isTotal = TOTAL_LABEL_RE.test(m.label) || BROUGHT_FORWARD_RE.test(m.label);
    // "Cargo insurance (110% of invoice value)" is a charge; "Total charges" / "TOTAL CIF ..." are totals
    if (isTotal && !(chargeType && !/\b(?:TOTAL|SUB-?TOTAL|GRAND|FORWARD)\b/i.test(m.label))) {
      if (!totals.some((t) => t.label === m.label && t.amount === amount)) totals.push({ label: m.label, amount });
      if (!incoterm) incoterm = parseIncoterm(m.label) ?? undefined;
      continue;
    }
    const type = chargeType;
    if (type) {
      const signed = type === 'discount' || m.amount.negative || m.amount.parenthesized ? -Math.abs(amount) : amount;
      charges.push({ type, amount: signed, description: m.label });
    }
  }
  if (!incoterm) incoterm = parseIncoterm(regionText(doc, tableBands, 'above')) ?? undefined;

  let totalPackages: CommercialInvoiceData['totalPackages'];
  const pk = labelText(doc, 'packages', { ...ex, validate: (t) => /\d/.test(t) });
  if (pk) {
    const m = /(\d[\d,]*)\s*([A-Za-z][A-Za-z.]*)?/.exec(pk.text);
    if (m) totalPackages = { count: Number(m[1].replace(/,/g, '')), unit: (m[2] ?? 'PKGS').toUpperCase().replace(/\.$/, '') };
  }

  // ── assists ──
  const styles = lines.map((l) => l.styleNo).filter((s): s is string => !!s);
  const assists: Assist[] = [];
  const assistSources = [...noteParas.map((p) => ({ text: p.text, markers: markersInNote(p) })), ...lines.map((l) => ({ text: [l.description, ...l.details].join(' '), markers: [] as string[], own: l.styleNo }))];
  for (const src of assistSources) {
    const a = findAssist(src.text, styles, currency);
    if (!a) continue;
    const refs = new Set(a.styleRefs);
    for (const l of lines) if (l.styleNo && (l.footnoteRefs ?? []).some((m) => src.markers.includes(m))) refs.add(l.styleNo);
    if ('own' in src && src.own) refs.add(src.own as string);
    const assist: Assist = { description: a.description, value: a.value, styleRefs: [...refs] };
    if (a.currency) assist.currency = a.currency;
    if (a.reference) assist.reference = a.reference;
    if (!assists.some((x) => x.value === assist.value && x.description === assist.description)) assists.push(assist);
  }

  const relatedM = /\bRELATED\s+PART(?:Y|IES)\s*[:?]?\s*(YES|NO|Y|N)\b/i.exec(allText);

  const data: CommercialInvoiceData = {
    kind: 'commercial_invoice',
    invoiceNumber,
    poNumbers,
    lines,
    charges,
    totals,
    assists,
    notes,
  };
  if (dateVal) data.invoiceDateRaw = dateVal.text.split(/\s+(?=[A-Z][a-z]+:)/)[0].trim();
  if (date) {
    data.invoiceDateRaw = date.raw;
    data.invoiceDate = date.iso;
    if (date.ambiguous) {
      data.invoiceDateAmbiguous = true;
      data.invoiceDateAlternatives = date.alternatives;
    }
    ctx.meta('invoiceDate', dateVal?.words);
  }
  if (seller) data.seller = seller;
  if (buyer) data.buyer = buyer;
  if (shipTo) data.shipTo = shipTo;
  if (manufacturer) data.manufacturer = manufacturer;
  if (currency) data.currency = currency;
  if (incoterm) data.incoterm = Object.fromEntries(Object.entries(incoterm).filter(([, v]) => v !== undefined)) as CommercialInvoiceData['incoterm'];
  if (payVal) data.paymentTerms = payVal.text;
  if (cooVal) data.countryOfOrigin = countryCode(cooVal.text) ?? findCountry(cooVal.text)?.iso;
  if (pol) data.portOfLoading = pol.text;
  if (pod) data.portOfDischarge = pod.text;
  if (vessel) data.vessel = vessel;
  if (voyage) data.voyage = voyage;
  if (ref) data.transportRef = cleanCode(firstCode(ref.text));
  if (etd) data.etd = etd;
  if (eta) data.eta = eta;
  if (totalPackages) data.totalPackages = totalPackages;
  if (relatedM) data.relatedParty = /^Y/i.test(relatedM[1]);
  if (opts.combined) data.packingTotals = packingTotals(doc, table);
  checkInvoiceArithmetic(ctx, data);
  return { data, table };
}

/** Text of the page area above (or below) the item table, for fallbacks. */
function regionText(doc: PDoc, regions: Region[], where: 'above' | 'below'): string {
  return doc.pages
    .map((p) => {
      const r = regions.find((x) => x.page === p.page);
      return p.lines.filter((l) => (!r ? true : where === 'above' ? l.y1 <= r.y0 : l.y0 >= r.y1)).map((l) => l.text).join('\n');
    })
    .join('\n');
}

function cellNumber(ctx: ParseContext, row: TableRow, field: Parameters<typeof colIndex>[1], path: string, dec?: '.' | ','): { p: ParsedNumber; words: PWord[]; markers: string[] } | null {
  const ci = colIndex(row, field);
  if (ci < 0) return null;
  for (const { words } of cellLines(row, ci)) {
    const markers = words.filter((w) => /^\(?\*{1,3}\)?$/.test(w.text)).map((w) => w.text.replace(/[()]/g, ''));
    const numWords = words.filter((w) => !/^\(?\*{1,3}\)?$/.test(w.text));
    const firstNum = numWords.findIndex((w) => /\d/.test(w.text));
    if (firstNum < 0) continue;
    const p = num(numWords[firstNum].text, dec) ?? num(joinWords(numWords), dec);
    if (!p) continue;
    const used = [numWords[firstNum]];
    ctx.meta(path, used, p.repaired ? { repaired: true, originalText: numWords[firstNum].text } : {});
    if (p.repaired) ctx.observe('ocr_repair', `${path}: read "${numWords[firstNum].text}" as ${p.value} (${p.repairs.join('; ')})`, path, row.page);
    return { p, words: used, markers };
  }
  return null;
}

/** Median vertical gap between consecutive lines of a page: the page's normal line spacing. */
export function typicalLineGap(page: PPage): number {
  const gaps: number[] = [];
  for (let i = 1; i < page.lines.length; i++) {
    const g = page.lines[i].y0 - page.lines[i - 1].y1;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 0.3 * page.medH;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

/**
 * Cell lines joined into paragraphs. A gap clearly larger than the normal line spacing (`lineGap`)
 * — a blank line on the page — starts a new paragraph.
 */
export function paragraphs(cells: ReadonlyArray<{ text: string; words: PWord[] }>, lineGap: number): string[] {
  const out: string[] = [];
  let prevY1: number | undefined;
  for (const c of cells) {
    if (!c.words.length || !c.text) continue;
    const y0 = Math.min(...c.words.map((w) => w.y0));
    const y1 = Math.max(...c.words.map((w) => w.y1));
    const h = Math.max(1, ...c.words.map((w) => w.y1 - w.y0));
    if (prevY1 === undefined || y0 - prevY1 > lineGap + 0.7 * h) out.push(c.text);
    else out[out.length - 1] += ` ${c.text}`;
    prevY1 = y1;
  }
  return out;
}

function buildLine(ctx: ParseContext, row: TableRow, i: number, dec: '.' | ',' | undefined, lineGap: number): InvoiceLine {
  const path = `lines[${i}]`;
  const text = rowText(row);
  const descIdx = colIndex(row, 'description');
  const descCells = descIdx >= 0 ? cellLines(row, descIdx) : [];
  let descLines = descCells.map((c) => c.text);
  const otherText = row.columns
    .map((c, ci) => ({ c, ci }))
    .filter(({ c }) => c.field === 'colourSize' || (c.field === null && !c.inferred))
    .flatMap(({ ci }) => cellLines(row, ci).map((x) => x.text));
  const lineNoText = joinWords(row.cells[colIndex(row, 'lineNo')]?.find((ws) => ws.length) ?? []);
  const lineNo = /^\d+/.test(lineNoText) ? Number(/^\d+/.exec(lineNoText)![0]) : i + 1;
  const styleCell = colIndex(row, 'style') >= 0 ? cellLines(row, colIndex(row, 'style'))[0] : undefined;
  let styleNo = styleCell ? styleCell.text.replace(/\s*-\s*/g, '-').split(/\s+/)[0] : undefined;
  if (!styleNo) {
    // combined "Model No. / Description" column: the code alone on the first line
    const sc = splitLeadingCode(descLines);
    if (sc.code) [styleNo, descLines] = [sc.code, sc.lines];
  }
  let description = descLines[0] ?? '';
  let details = [...descLines.slice(1), ...otherText];
  if (!styleNo) {
    const m = /^([A-Z0-9]+(?:[-/.][A-Z0-9]+)+|[A-Z]{1,4}\d{3,}[A-Z0-9]*)\s+(.*)$/i.exec(description);
    if (m && /\d/.test(m[1])) {
      styleNo = m[1];
      description = m[2];
    } else {
      const sm = /\b(?:STYLE|ART(?:ICLE)?|SKU|ITEM|MODEL)\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/.]{2,})/i.exec(text);
      if (sm && /\d/.test(sm[1])) styleNo = sm[1];
    }
  }
  if (!description && details.length) [description, ...details] = details;
  if (styleCell) ctx.meta(`${path}.styleNo`, styleCell.words);

  const hsCi = colIndex(row, 'hsCode');
  let hsCode = hsCi >= 0 ? cellLines(row, hsCi).map((c) => parseHsCell(c.text)).find(Boolean) : undefined;
  if (!hsCode) {
    const m = /\b(?:HS|HTS|H\.S\.|TARIFF)\s*(?:CODE|NO\.?)?\s*[:#]?\s*(\d{4}\.?\d{2}(?:\.?\d{2,4})?(?:\.\d{2})?)/i.exec(text);
    if (m) hsCode = parseHsCell(m[1]);
  }
  if (hsCi >= 0) ctx.meta(`${path}.hsCode`, cellLines(row, hsCi)[0]?.words);

  const q = cellNumber(ctx, row, 'quantity', `${path}.quantity`, dec);
  const up = cellNumber(ctx, row, 'unitPrice', `${path}.unitPrice`, dec);
  const am = cellNumber(ctx, row, 'amount', `${path}.amount`, dec);
  const unitCi = colIndex(row, 'unit');
  let unit = unitCi >= 0 ? cellLines(row, unitCi)[0]?.text ?? '' : '';
  // unit glued to the quantity ("2,400 PCS") or printed under the quantity column header
  const qCi = colIndex(row, 'quantity');
  if (!unit && qCi >= 0) {
    const qText = cellLines(row, qCi)[0]?.text ?? '';
    const m = /[\d.,]+\s*([A-Za-z]{2,6}\.?)\s*$/.exec(qText);
    if (m) unit = m[1];
    else if (row.columns[qCi].unit) unit = row.columns[qCi].unit!;
  }
  if (/^\d/.test(unit)) {
    const m = /^[\d.,]+\s*([A-Za-z]+)/.exec(unit);
    unit = m ? m[1] : '';
  }
  unit = unit.toUpperCase().replace(/\.$/, '');

  const all = [description, ...details].join(' ');
  const ncv = isNoCommercialValue(all) || isNoCommercialValue(text);
  const line: InvoiceLine = { lineNo, description, details, quantity: q?.p.value ?? 0, unit };
  if (styleNo) line.styleNo = styleNo;
  if (hsCode) line.hsCode = hsCode;
  if (up) line.unitPrice = up.p.value;
  if (am) line.amount = am.p.value;
  const negativeLine = !ncv && ((am && (am.p.parenthesized || am.p.negative)) || (up && (up.p.parenthesized || up.p.negative)));
  if (negativeLine) {
    if (line.amount !== undefined) line.amount = -Math.abs(line.amount);
    if (line.unitPrice !== undefined) line.unitPrice = -Math.abs(line.unitPrice);
  }
  if (ncv) {
    line.noCommercialValue = true;
    const stated = statedCustomsValue(all);
    if (stated) line.customsValue = Math.round((stated.perUnit ? stated.value * (line.quantity || 1) : stated.value) * 100) / 100;
    else if (am && am.p.parenthesized) line.customsValue = am.p.value;
    if (am?.p.parenthesized || up?.p.parenthesized) ctx.observe('note', `Line ${lineNo} amounts printed in parentheses (${[up?.words[0]?.text, am?.words[0]?.text].filter(Boolean).join(' ')}): no-commercial-value line, value stated for customs only.`, path, row.page);
  }
  if (q && !Number.isInteger(line.quantity) && /PCS|PIECES|SETS|PRS|PAIRS|NOS|EA|UNITS/.test(unit)) ctx.observe('low_confidence', `Line ${lineNo}: fractional quantity ${line.quantity} ${unit}`, `${path}.quantity`, row.page);

  // origin stated at line level
  const originCi = colIndex(row, 'origin');
  const originText = originCi >= 0 ? cellLines(row, originCi)[0]?.text : undefined;
  const coo =
    (originText && (countryCode(originText, { allowIso2: true }) ?? findCountry(originText)?.iso)) ||
    (() => {
      const m = /\b(?:ORIGIN|COUNTRY\s+OF\s+ORIGIN|C\/O|COO|MADE\s+IN|PRODUCT\s+OF)\s*[:-]?\s*([A-Za-z][A-Za-z .'-]{2,40})/i.exec(all);
      if (!m) return undefined;
      const seg = m[1].split(/[),;]/)[0];
      return countryCode(seg) ?? findCountry(seg)?.iso;
    })();
  if (coo) {
    line.countryOfOrigin = coo;
    if (originCi >= 0) ctx.meta(`${path}.countryOfOrigin`, cellLines(row, originCi)[0]?.words);
  }

  const markers = new Set<string>([...findMarkers(details.join(' ')), ...findMarkers(description), ...(up?.markers ?? []), ...(am?.markers ?? []), ...(q?.markers ?? [])]);
  if (markers.size) line.footnoteRefs = [...markers];
  // "WOMEN'S LEATHER LOAFER *": the marker is a reference, not part of the description
  line.description = line.description.replace(/\s+(?:\(\*{1,3}\)|\*{1,3})$/, '');

  const comp = parseComposition(description) ?? parseComposition(details.join(' \n '));
  if (comp) {
    line.composition = comp.fibers;
    line.compositionRaw = comp.raw;
  }
  const construction = detectConstruction(all);
  if (construction) line.construction = construction;
  const gender = detectGender(description) ?? detectGender(all);
  if (gender) line.gender = gender;
  const garmentType = detectGarmentType(description, details.join(' '));
  if (garmentType) line.garmentType = garmentType;
  // a maker block ("MADE IN X - Maker Ltd, street, city") ends at a blank line in the description
  const facts = lineFactsFromNote([...paragraphs(descCells, lineGap), otherText.join(' ')].filter(Boolean).join('\n'));
  if (facts.manufacturer) line.manufacturer = facts.manufacturer;

  // combined invoice + packing list columns
  const ctn = cellNumber(ctx, row, 'cartons', `${path}.cartons`, dec);
  if (ctn) line.cartons = ctn.p.value;
  const nwCol = row.columns.find((c) => c.field === 'netWeight');
  const gwCol = row.columns.find((c) => c.field === 'grossWeight');
  const nw = cellNumber(ctx, row, 'netWeight', `${path}.netWeightKg`, dec);
  const gw = cellNumber(ctx, row, 'grossWeight', `${path}.grossWeightKg`, dec);
  if (nw) line.netWeightKg = weightToKg(nw.p.value, nwCol?.unit);
  if (gw) line.grossWeightKg = weightToKg(gw.p.value, gwCol?.unit);
  return line;
}

/** Totals block of a combined invoice/packing list: from the totals row and labelled totals. */
function packingTotals(doc: PDoc, table: TableResult): CommercialInvoiceData['packingTotals'] {
  const out: NonNullable<CommercialInvoiceData['packingTotals']> = {};
  const last = [...table.pages].reverse().find((p) => p.stopCells);
  if (last?.stopCells) {
    last.columns.forEach((c, i) => {
      const t = joinWords(last.stopCells![i]);
      const p = parseNumber(t.split(/\s+/)[0] ?? '', {});
      if (!p) return;
      if (c.field === 'cartons') out.cartons = p.value;
      if (c.field === 'netWeight') out.netWeightKg = weightToKg(p.value, c.unit);
      if (c.field === 'grossWeight') out.grossWeightKg = weightToKg(p.value, c.unit);
      if (c.field === 'volume' || /CBM|M3/i.test(t)) out.volumeCbm = volumeToCbm(p.value, c.unit ?? t);
    });
  }
  const nw = findLabelValue(doc, 'netWeight', { validate: (t) => /\d/.test(t) });
  const gw = findLabelValue(doc, 'grossWeight', { validate: (t) => /\d/.test(t) });
  const vol = findLabelValue(doc, 'measurement', { validate: (t) => /\d/.test(t) });
  const n = (t: string) => parseNumber((/[\d.,]+/.exec(t) ?? [''])[0]);
  if (out.netWeightKg === undefined && nw) out.netWeightKg = weightToKg(n(nw.text)?.value ?? NaN, nw.text);
  if (out.grossWeightKg === undefined && gw) out.grossWeightKg = weightToKg(n(gw.text)?.value ?? NaN, gw.text);
  if (out.volumeCbm === undefined && vol) out.volumeCbm = volumeToCbm(n(vol.text)?.value ?? NaN, vol.text);
  for (const k of Object.keys(out) as Array<keyof typeof out>) if (out[k] === undefined || Number.isNaN(out[k])) delete out[k];
  return out;
}

/**
 * Arithmetic checks on invoice lines. Printed amounts are never changed; missing cells are
 * derived when determinable, and disagreements are recorded for reconciliation.
 */
export function checkInvoiceArithmetic(ctx: ParseContext, data: CommercialInvoiceData): void {
  data.lines.forEach((l, i) => {
    const path = `lines[${i}]`;
    if (l.amount === undefined && l.unitPrice !== undefined && l.quantity) {
      l.amount = Math.round(l.quantity * l.unitPrice * 100) / 100;
      ctx.meta(`${path}.amount`, undefined, { conf: 60, repaired: true, originalText: '' });
      ctx.observe('ocr_repair', `Line ${l.lineNo}: amount not read; derived ${l.quantity} × ${l.unitPrice} = ${l.amount}.`, `${path}.amount`);
    } else if (l.unitPrice === undefined && l.amount !== undefined && l.quantity) {
      l.unitPrice = Math.round((l.amount / l.quantity) * 10000) / 10000;
      ctx.meta(`${path}.unitPrice`, undefined, { conf: 60, repaired: true, originalText: '' });
      ctx.observe('ocr_repair', `Line ${l.lineNo}: unit price not read; derived ${l.amount} / ${l.quantity}.`, `${path}.unitPrice`);
    } else if (!l.quantity && l.amount !== undefined && l.unitPrice) {
      const q = l.amount / l.unitPrice;
      if (Math.abs(q - Math.round(q)) < 1e-6) {
        l.quantity = Math.round(q);
        ctx.meta(`${path}.quantity`, undefined, { conf: 60, repaired: true, originalText: '' });
        ctx.observe('ocr_repair', `Line ${l.lineNo}: quantity not read; derived ${l.amount} / ${l.unitPrice} = ${l.quantity}.`, `${path}.quantity`);
      }
    }
    if (!l.quantity) ctx.warn(`line ${l.lineNo}: quantity not read`);
    if (l.amount !== undefined && l.unitPrice !== undefined && l.quantity) {
      const computed = Math.round(l.quantity * l.unitPrice * 100) / 100;
      if (Math.abs(Math.abs(computed) - Math.abs(l.amount)) > 0.01 + Math.abs(computed) * 1e-6) {
        ctx.observe('other', `Line ${l.lineNo}: quantity × unit price = ${computed.toFixed(2)} but printed amount is ${l.amount.toFixed(2)} (kept as printed).`, `${path}.amount`);
      }
    }
  });
}
