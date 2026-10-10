/**
 * Bill of lading parser (house or master; also used for arrival notices, which carry the
 * same transport facts).
 *
 * B/L forms are grids of boxed labels, so most fields are "value below the label inside its
 * box". Containers get the ISO 6346 treatment (typed / struck-through / handwritten
 * candidates), stamps are read from the stamp pass and from OCR text, and dates read from
 * stamps are checked against the typed issue date.
 */
import type { Address, BillOfLadingData, Container, FreightChargeLine } from '@app/shared';
import type { ParseContext } from '../context';
import { joinWords, realWords, segmentsOf, xCenter, type PDoc, type PPage, type PWord } from '../layout';
import { findLabelValue, findLabels, labelHits, valueBelow, valueRight, type LabelHit } from '../labels';
import { daysBetween, findDates, parseDate, type ParsedDate } from '../dates';
import { chooseContainer, containerCandidates, groupContainerReadings, ownerCodeHints, parseSizeType, type RawToken } from '../domain/container';
import { cleanCode, findHsCodes, findScac, hsHeadingExists, looksLikeBillNumber, volumeToCbm, weightToKg } from '../domain/codes';
import { parseNumber } from '../numbers';
import { countryCode, findCountry } from '../countries';
import { parseParty } from '../party';
import { firstCode, labelText, textBlocks } from './common';
import { hasLegalSuffix } from '../party';
import { splitVesselVoyage } from './invoice';
import { meanConf } from '../layout';
import { squash, trimSeparators } from '../text';

const STAMP_PHRASES: Array<[RegExp, string]> = [
  [/\bTELEX\s*RE(?:L(?:EASED?)?)?\b|\bTELEX\s+RELEASE\b|\bTLX\s+RLS/i, 'TELEX RELEASED'],
  [/\bORIGINALS?\s+(?:B\/?L'?S?\s+)?SURRENDERED\b|\bB\/?L\s+SURRENDERED\b|\bSURRENDERED\s+(?:AT|B\/?L)\b/i, 'SURRENDERED'],
  [/\bEXPRESS\s+RELEASE\b|\bSEA\s*WAY\s*BILL\b|\bSEAWAY\s+BILL\b/i, 'SEAWAY'],
  [/\bSHIPPED\s+ON\s+BOARD\b|\bLADEN\s+ON\s+BOARD\b/i, 'SHIPPED ON BOARD'],
];

const STAMP_WORDS_RE = /\b(?:TELEX|RELEASED?|SURRENDER\w*|SHIPPED|ON\s+BOARD|LADEN|RECEIVED|PAID|COPY|ORIGINAL|APPROVED|CERTIFIED|EXPRESS|DATE)\b/i;

const NUMBER_WORDS: Record<string, number> = { ZERO: 0, NIL: 0, NONE: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 };

const PACKAGE_UNITS = 'CARTONS?|CTNS?|PACKAGES?|PKGS?|PALLETS?|PLTS|SKIDS?|BALES?|CASES?|BOXES|ROLLS?|BAGS?|DRUMS?|CRATES?|PIECES|PCS';
/** A number as printed: "2,004", "26,078.400", "138". */
const QTY_NUM = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';

/**
 * A package count in a "No. of packages" value: a number with a package unit ("2,004 CTNS"), or a bare
 * number on its own. A container size ("40' HC") or a container count ("2 X 40' HC") is not one.
 */
export function packageCount(text: string): BillOfLadingData['packages'] | null {
  const withUnit = new RegExp(`(?<![\\d,.])(${QTY_NUM})\\s*(${PACKAGE_UNITS})\\b`, 'i').exec(text);
  if (withUnit) return { count: Number(withUnit[1].replace(/,/g, '')), unit: withUnit[2].toUpperCase().replace(/[.()]/g, '') };
  const bare = /^\s*(\d{1,3}(?:,\d{3})+|\d+)(?![\d,.'’"″°])(?!\s*[Xx×]\b)(?:\s+([A-Za-z][A-Za-z.()]*))?/.exec(text);
  if (!bare) return null;
  return { count: Number(bare[1].replace(/,/g, '')), unit: (bare[2] ?? 'PKGS').toUpperCase().replace(/[.()]/g, '') };
}

/** Every "<number> <unit>" in the text (unit group given as a regex alternation in parentheses). */
function unitAmounts(text: string, unitGroup: string): Array<{ value: number; unit: string }> {
  const re = new RegExp(`(?<![\\d,.])(${QTY_NUM})\\s*${unitGroup}\\b`, 'gi');
  const out: Array<{ value: number; unit: string }> = [];
  for (const m of text.matchAll(re)) out.push({ value: Number(m[1].replace(/,/g, '')), unit: m[2] });
  return out;
}

/**
 * The printed total that `reading` is part of: the largest figure, when it equals the sum of two or
 * more of the other figures including `reading`. Undefined when no total is confirmed this way.
 */
export function confirmedTotal(reading: number, figures: number[]): number | undefined {
  if (!figures.length) return undefined;
  const total = Math.max(...figures);
  if (Math.abs(total - reading) < 1e-9) return undefined;
  const parts = figures.filter((f) => Math.abs(f - total) > 1e-9);
  if (parts.length < 2 || parts.length > 16 || !parts.some((f) => Math.abs(f - reading) < 1e-9)) return undefined;
  const tol = Math.max(0.01, total * 1e-5);
  // subsets of the other figures (exact sums only: a coincidence at printed precision is unlikely)
  for (let mask = 1; mask < 1 << parts.length; mask++) {
    let sum = 0;
    let n = 0;
    let hasReading = false;
    for (let i = 0; i < parts.length; i++) {
      if (!(mask & (1 << i))) continue;
      sum += parts[i];
      n++;
      if (Math.abs(parts[i] - reading) < 1e-9) hasReading = true;
    }
    if (n >= 2 && hasReading && Math.abs(sum - total) <= tol) return total;
  }
  return undefined;
}

function pageOf(doc: PDoc, n: number): PPage {
  return doc.pages.find((p) => p.page === n)!;
}

/** Strips stamp-overlap junk from a block line: very low confidence fragments. */
function cleanBlockLines(lineWords: PWord[][]): string[] {
  return lineWords
    .map((ws) => ws.filter((w) => w.conf >= 35 || /\d/.test(w.text)))
    .map((ws) => joinWords(ws))
    .filter((t) => /[A-Za-z0-9]{2,}/.test(t));
}

/** Party blocks; when OCR garbled a party label ("C nplete name and"), the B/L order shipper → consignee → notify is used. */
function parties(doc: PDoc): { shipper?: Address; consignee?: Address; notify?: Address; alsoNotify?: string } {
  const out: { shipper?: Address; consignee?: Address; notify?: Address; alsoNotify?: string } = {};
  const roles = ['shipper', 'consignee', 'notify'] as const;
  const hits: Partial<Record<(typeof roles)[number], LabelHit>> = {};
  for (const r of roles) hits[r] = labelHits(doc, r === 'shipper' ? ['shipper', 'seller'] : r)[0];
  const missing = roles.filter((r) => !hits[r]);
  if (missing.length) {
    // party label lines that were not recognized: "(complete name and address)" style text
    const page = doc.pages[0];
    const known = new Set(Object.values(hits).map((h) => h && `${h.page}:${h.line}`));
    const guesses: LabelHit[] = [];
    for (const line of page.lines) {
      if (line.x0 > page.width * 0.4 || known.has(`${page.page}:${line.index}`)) continue;
      const seg = segmentsOf(line, page.segGap)
        .filter((sg) => sg[0].x0 < page.width * 0.45)
        .flat();
      if (!seg.length) continue;
      const t = joinWords(seg);
      if (!/\bNAME\s*(?:AND|&)\s*(?:ADD|$)|COMPLETE\s+NAME|\bNAME\s+AND\b/i.test(t)) continue;
      guesses.push({
        field: 'consignee',
        synonym: t,
        page: page.page,
        line: line.index,
        words: seg.slice(0, 1),
        x0: seg[0].x0,
        y0: Math.min(...seg.map((w) => w.y0)),
        x1: seg[0].x1,
        y1: Math.max(...seg.map((w) => w.y1)),
        colon: false,
        segStart: true,
        credible: true,
        fuzzy: true,
      });
    }
    const all = [...roles.map((r) => ({ r, h: hits[r] })).filter((x) => x.h), ...guesses.map((h) => ({ r: undefined as (typeof roles)[number] | undefined, h }))].sort(
      (a, b) => a.h!.y0 - b.h!.y0,
    );
    // assign roles to the unknown labels by position between the known ones
    let ri = 0;
    for (const x of all) {
      if (x.r) {
        ri = roles.indexOf(x.r) + 1;
        continue;
      }
      while (ri < roles.length && hits[roles[ri]]) ri++;
      if (ri < roles.length) {
        hits[roles[ri]] = { ...x.h!, field: roles[ri] === 'shipper' ? 'shipper' : roles[ri] };
        ri++;
      }
    }
  }
  for (const r of roles) {
    const h = hits[r];
    if (!h) continue;
    const below = valueBelow(doc, h, 8, true);
    if (!below) continue;
    const lines = cleanBlockLines(below.lineWords);
    // "ALSO NOTIFY" inside the notify block
    const alsoIdx = lines.findIndex((l) => /^ALSO\s+NOTIFY/i.test(l));
    const body = alsoIdx >= 0 ? lines.slice(0, alsoIdx) : lines;
    if (!body.length) continue;
    const addr = parseParty(body, { lineConf: below.lineWords.map(meanConf) });
    if (r === 'shipper') out.shipper = addr;
    if (r === 'consignee') out.consignee = addr;
    if (r === 'notify') out.notify = addr;
  }
  const also = findLabelValue(doc, 'alsoNotify', { mode: 'right' });
  if (also) {
    const t = squash(also.words.filter((w) => w.conf >= 40).map((w) => w.text).join(' '));
    if (t) out.alsoNotify = t;
  }
  return out;
}

/** "THREE (3)" → 3, "3/3" → 3, "ZERO (0)" → 0. */
export function parseOriginals(text: string): number | undefined {
  const par = /\((\d{1,2})\)/.exec(text);
  if (par) return Number(par[1]);
  const frac = /\b(\d)\s*\/\s*(\d)\b/.exec(text);
  if (frac) return Number(frac[2]);
  const word = /\b(ZERO|NIL|NONE|ONE|TWO|THREE|FOUR|FIVE|SIX)\b/i.exec(text);
  if (word) return NUMBER_WORDS[word[1].toUpperCase()];
  const d = /\b(\d{1,2})\b/.exec(text);
  return d ? Number(d[1]) : undefined;
}

/**
 * A date read from a stamp (or handwriting) is checked against a typed reference date:
 * if it is implausibly far away and a single-character change of the year brings it close,
 * the typed year is used and the repair is reported.
 */
export function reconcileStampDate(read: ParsedDate, reference: string | undefined, maxDays = 60): { iso: string; repaired: boolean } {
  if (!reference) return { iso: read.iso, repaired: false };
  if (Math.abs(daysBetween(read.iso, reference)) <= maxDays) return { iso: read.iso, repaired: false };
  const [y, m, d] = read.iso.split('-');
  const refYear = reference.slice(0, 4);
  let diff = 0;
  for (let i = 0; i < 4; i++) if (y[i] !== refYear[i]) diff++;
  const fixed = `${refYear}-${m}-${d}`;
  if (diff === 1 && Math.abs(daysBetween(fixed, reference)) <= maxDays) return { iso: fixed, repaired: true };
  return { iso: read.iso, repaired: false };
}

/** Parses a bill of lading (or arrival notice). */
export function parseBillOfLading(doc: PDoc, ctx: ParseContext): BillOfLadingData {
  const allLines = doc.pages.flatMap((p) => p.lines);
  const allText = allLines.map((l) => l.text).join('\n');
  const stamps = doc.pages.flatMap((p) => p.stamps.map((s) => ({ text: s.replace(/^(?:BLUE|RED|GREEN|BLACK|PURPLE|STAMP)\s*:\s*/i, ''), page: p.page })));

  // ── numbers ──
  const scacV = labelText(doc, 'scac', { validate: (t) => /^[A-Z]{4}\b/i.test(t.trim()) });
  const issuerScac = scacV ? /^[A-Z]{4}/i.exec(scacV.text.trim())![0].toUpperCase() : findScac(allText.split('\n').filter((l) => !/\(\s*SCAC/i.test(l)).join('\n'));
  if (scacV) ctx.meta('issuerScac', scacV.words.slice(0, 1));
  const bl = codeNear(doc, 'blNumber');
  let blNumber = bl ? bl.code : '';
  if (bl) ctx.meta('blNumber', bl.words);
  if (!blNumber && issuerScac) {
    const m = new RegExp(`\\b(${issuerScac}[A-Z0-9]{6,20})\\b`).exec(allText);
    if (m) blNumber = m[1];
  }
  if (!blNumber) ctx.warn('B/L number not found');
  const mbl = codeNear(doc, 'masterBl', (c) => c !== blNumber);
  const masterBlNumber = mbl?.code;
  if (mbl) ctx.meta('masterBlNumber', mbl.words);
  const booking = labelText(doc, 'bookingNumber', { validate: (t) => /\d/.test(t) });

  // carrier: the first name-like line in the carrier box (a stacked "carrier / master B/L" box holds both)
  const carrierV = findLabelValue(doc, 'carrier', { mode: 'below', maxLines: 3, validate: (t) => /[A-Za-z]{3,}/.test(t) }) ?? findLabelValue(doc, 'carrier', { mode: 'right', validate: (t) => /[A-Za-z]{3,}/.test(t) });
  const carrierLine = carrierV?.lines.find((l) => /[A-Za-z]{3,}/.test(l) && !looksLikeBillNumber(firstCode(l)));
  let carrierName = carrierLine ? cleanCarrierName(carrierLine) : undefined;
  let carrierScac = carrierLine ? findScac(carrierLine) : undefined;
  if (carrierScac && carrierV) ctx.meta('carrierScac', carrierV.words.filter((w) => w.text.includes(carrierScac!)));
  if (!carrierScac && masterBlNumber && /^[A-Z]{4}/.test(masterBlNumber) && /\d/.test(masterBlNumber)) carrierScac = masterBlNumber.slice(0, 4);
  if (!carrierName) {
    const m = /\bAS\s+AGENTS?\s+FOR\s+(?:THE\s+)?[CG]ARRIER\s*[:,]?\s*([A-Z][A-Za-z .&,-]{3,60})/i.exec(allText);
    if (m) carrierName = trimSeparators(m[1]);
  }

  const issuerName = findIssuerName(doc);

  // ── parties ──
  const pty = parties(doc);

  // ── routing ──
  const vv = labelText(doc, 'vesselVoyage', { mode: 'belowFirst', validate: (t) => /[A-Za-z]{3,}/.test(t) });
  let { vessel, voyage } = vv ? splitVesselVoyage(vv.text) : { vessel: labelText(doc, 'vessel')?.text, voyage: labelText(doc, 'voyage')?.text };
  if (vv) {
    const vw = vv.words.find((w) => voyage && w.text === voyage);
    if (vw) ctx.meta('voyage', [vw]);
    ctx.meta('vessel', vv.words.filter((w) => w !== vw));
  }
  const field = (f: Parameters<typeof labelText>[1]) => {
    const v = labelText(doc, f, { mode: 'belowFirst', validate: (t) => /[A-Za-z0-9]{2,}/.test(t) });
    return v ? { text: trimSeparators(v.text), words: v.words } : undefined;
  };
  const preCarriage = field('preCarriage');
  const placeOfReceipt = field('placeOfReceipt');
  const pol = field('portOfLoading');
  const pod = field('portOfDischarge');
  const placeOfDelivery = field('placeOfDelivery');
  const finalDestination = field('finalDestination');
  const moveType = field('moveType');
  if (pol) ctx.meta('portOfLoading', pol.words);
  if (pod) ctx.meta('portOfDischarge', pod.words);

  // ── dates ──
  const issue = labelText(doc, 'issuePlaceDate', { validate: (t) => /[A-Za-z0-9]{3,}/.test(t), maxLines: 2 });
  let issueDate: string | undefined;
  let issuePlace: string | undefined;
  if (issue) {
    const d = findDates(issue.text)[0];
    if (d) {
      issueDate = d.iso;
      const place = trimSeparators(issue.text.slice(0, d.index));
      if (place) issuePlace = place;
    } else issuePlace = issue.text;
  }
  const onBoard = findOnBoardDate(doc, stamps);
  let onBoardDate: string | undefined;
  if (onBoard) {
    const fixed = reconcileStampDate(onBoard.date, issueDate);
    onBoardDate = fixed.iso;
    if (fixed.repaired) {
      ctx.meta('onBoardDate', onBoard.words, { conf: Math.min(60, onBoard.conf), repaired: true, originalText: onBoard.date.raw });
      ctx.observe('ocr_repair', `On-board date read as "${onBoard.date.raw}" (${onBoard.source}); typed issue date is ${issueDate}, so the year was taken from the typed date: ${fixed.iso}.`, 'onBoardDate', onBoard.page);
    } else ctx.meta('onBoardDate', onBoard.words, { conf: onBoard.conf });
  }

  // ── stamps / release ──
  let releaseType: BillOfLadingData['releaseType'];
  const stampTexts = [...stamps.map((s) => s.text), ...allLines.map((l) => l.text)];
  // the colour pass may also return coloured printed form text: only stamp-like lines are observations
  for (const s of stamps) if (STAMP_WORDS_RE.test(s.text) || parseDate(s.text)) ctx.observe('stamp', s.text, undefined, s.page);
  for (const [re, name] of STAMP_PHRASES) {
    // inside the stamp pass a lone "TELEX" is enough (OCR of a stamp often drops the second word)
    const inStamp = name === 'TELEX RELEASED' ? stamps.map((s) => /\bTELEX\b/i.exec(s.text)).find(Boolean) : undefined;
    const hit = inStamp ?? stampTexts.map((t) => re.exec(t)).find(Boolean);
    if (!hit) continue;
    if ((name === 'TELEX RELEASED' || name === 'SURRENDERED') && !releaseType) releaseType = 'telex';
    if (name === 'SEAWAY' && !releaseType) releaseType = 'seaway';
    if (!stamps.length && name !== 'SEAWAY') ctx.observe('stamp', `${name} (read from page text: "${hit[0].trim()}")`, name === 'SHIPPED ON BOARD' ? 'onBoardDate' : 'releaseType');
  }
  const originalsV = labelText(doc, 'originals', { validate: (t) => parseOriginals(t) !== undefined });
  const originalsCount = originalsV ? parseOriginals(originalsV.text) : undefined;
  if (!releaseType) releaseType = originalsCount !== undefined && originalsCount > 0 ? 'original' : originalsCount === 0 ? 'seaway' : 'unknown';

  // ETA (arrival notices) has no field in BillOfLadingData: surface it as an observation for reconciliation
  const etaV = labelText(doc, ['eta'], { validate: (t) => !!parseDate(t) });
  const eta = etaV ? parseDate(etaV.text, { monthFirst: /\b(?:USA|U\.S\.A|UNITED STATES)\b/i.test(allText) }) : null;
  if (eta) ctx.observe('note', `ETA ${eta.iso} (printed "${eta.raw}")${eta.ambiguous ? `; also readable as ${eta.alternatives.join(', ')}` : ''}`, 'eta', etaV!.value.page);

  // ── particulars ──
  const containers = extractContainers(doc, ctx, allText, [blNumber, masterBlNumber, booking?.text].filter((x): x is string => !!x).map((x) => cleanCode(x).replace(/[-/]/g, '')));
  const pk = findLabelValue(doc, 'packages', { mode: 'below', maxLines: 2, validate: (t) => !!packageCount(t) });
  let packages: BillOfLadingData['packages'];
  if (pk) {
    packages = packageCount(pk.text)!;
    ctx.meta('packages', pk.words.slice(0, 1));
  }
  if (!packages) {
    const m = new RegExp(`(?<![\\d,.])(${QTY_NUM})\\s+(${PACKAGE_UNITS})\\b`, 'i').exec(allText);
    if (m) packages = { count: Number(m[1].replace(/,/g, '')), unit: m[2].toUpperCase() };
  }

  const gwV = findLabelValue(doc, 'grossWeight', { mode: 'below', maxLines: 2, validate: (t) => /\d/.test(t) });
  let grossWeightKg: number | undefined;
  let volumeCbm: number | undefined;
  if (gwV) {
    const firstNum = gwV.words.find((w) => parseNumber(w.text, { ocrFix: false }));
    if (firstNum) {
      const unitWord = gwV.words.find((w) => /^(KGS?|KILOS?|LBS?|POUNDS?)\.?$/i.test(w.text));
      grossWeightKg = weightToKg(parseNumber(firstNum.text)!.value, unitWord?.text);
      ctx.meta('grossWeightKg', [firstNum]);
      // standard B/L grid: measurement is the next numeric column on the same row
      const sameRow = gwV.lineWords[0].filter((w) => w.x0 > firstNum.x1 && parseNumber(w.text, { ocrFix: false }));
      const measV = findLabelValue(doc, 'measurement', { mode: 'below', maxLines: 2, validate: (t) => /\d/.test(t) });
      if (measV) {
        const n = measV.words.find((w) => parseNumber(w.text, { ocrFix: false }));
        if (n) {
          volumeCbm = volumeToCbm(parseNumber(n.text)!.value, measV.text);
          ctx.meta('volumeCbm', [n]);
        }
      } else if (sameRow.length) {
        volumeCbm = volumeToCbm(parseNumber(sameRow[0].text)!.value, joinWords(gwV.words));
        ctx.meta('volumeCbm', [sameRow[0]], { conf: Math.min(70, sameRow[0].conf) });
        ctx.observe('low_confidence', `Measurement header not read; ${sameRow[0].text} taken from the column right of the gross weight (standard B/L layout).`, 'volumeCbm');
      }
    }
  }
  if (grossWeightKg === undefined) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*(KGS?|KILOS|LBS)\b/i.exec(allText);
    if (m) grossWeightKg = weightToKg(parseNumber(m[1])!.value, m[2]);
  }
  if (volumeCbm === undefined) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*(CBM|M3|CFT)\b/i.exec(allText);
    if (m) volumeCbm = volumeToCbm(parseNumber(m[1])!.value, m[2]);
  }
  // multi-container bills print one row per container and a TOTAL row: when a reading is one of the
  // rows and another printed figure is the sum of the rows, the sum is the bill's figure
  const qtyText = allLines.filter((l) => !/\bSAY\b|IN\s+WORDS/i.test(l.text)).map((l) => l.text).join('\n');
  const weights = unitAmounts(qtyText, '(KGS?|KILOS?|LBS?)').map((x) => weightToKg(x.value, x.unit));
  const volumes = unitAmounts(qtyText, '(CBM|M3|CFT)').map((x) => volumeToCbm(x.value, x.unit));
  const counts = unitAmounts(qtyText, `(${PACKAGE_UNITS})`);
  const totalWeight = grossWeightKg !== undefined ? confirmedTotal(grossWeightKg, weights) : undefined;
  if (totalWeight !== undefined) {
    ctx.observe('note', `Gross weight ${grossWeightKg} kg is one container row; the printed total ${totalWeight} kg (sum of the rows) is used.`, 'grossWeightKg');
    grossWeightKg = totalWeight;
  }
  const totalVolume = volumeCbm !== undefined ? confirmedTotal(volumeCbm, volumes) : undefined;
  if (totalVolume !== undefined) volumeCbm = totalVolume;
  const totalCount = packages ? confirmedTotal(packages.count, counts.map((c) => c.value)) : undefined;
  if (packages && totalCount !== undefined) {
    const unit = counts.find((c) => c.value === totalCount)?.unit.toUpperCase() ?? packages.unit;
    ctx.observe('note', `Package count ${packages.count} is one container row; the printed total ${totalCount} ${unit} (sum of the rows) is used.`, 'packages');
    packages = { count: totalCount, unit };
  }

  const desc = findLabelValue(doc, 'description', { mode: 'block', maxLines: 20, validate: (t) => /[A-Za-z]{3,}/.test(t) });
  const cargoDescription: string[] = [];
  if (desc) {
    for (const l of desc.lines) {
      if (/^(?:HS|HTS|H\.S\.?|INV|INVOICE|P\.?O\.?\b|SHIPPER'?S\s+LOAD|SAID\s+TO|FREIGHT|AMS|ISF|TOTAL|CY\/|CFS\/|NET\s+W|N\.W)/i.test(l)) break;
      cargoDescription.push(squash(l));
    }
  }

  // HS codes: on the "HS:" line and the continuation lines that only carry codes
  const hsCodes: string[] = [];
  for (const hit of labelHits(doc, 'hsCode')) {
    const page = pageOf(doc, hit.page);
    const first = valueRight(doc, hit);
    const collected: Array<{ code: string; words: PWord[] }> = [];
    const take = (ws: PWord[]) => {
      for (const w of ws) for (const c of findHsCodes(w.text)) collected.push({ code: c.code, words: [w] });
    };
    if (first) take(first.words);
    for (let li = hit.line + 1; li < page.lines.length; li++) {
      const ws = realWords(page.lines[li]).filter((w) => xCenter(w) >= hit.x0 - page.medH && xCenter(w) < page.width * 0.7);
      const codes = ws.filter((w) => findHsCodes(w.text).length);
      if (!codes.length || codes.length < ws.filter((w) => /[A-Za-z0-9]/.test(w.text)).length * 0.5) break;
      take(codes);
    }
    for (const c of collected) {
      if (hsCodes.includes(c.code)) continue;
      hsCodes.push(c.code);
      const path = `hsCodes[${hsCodes.length - 1}]`;
      if (!hsHeadingExists(c.code)) {
        ctx.meta(path, c.words, { conf: Math.min(40, c.words[0].conf), force: true });
        ctx.observe('low_confidence', `HS code read as ${c.code}: heading ${c.code.slice(0, 4)} does not exist in chapter ${c.code.slice(0, 2)}; likely an OCR misread — verify against the invoice.`, path);
      } else ctx.meta(path, c.words);
    }
    if (collected.length) break;
  }

  // freight
  const freightM = /\bFREIGHT\s+(PREPAID|COLLECT)\b/i.exec(allText);
  const charges: FreightChargeLine[] = [];
  const fc = findLabelValue(doc, 'freightCharges', { mode: 'block', maxLines: 10, stopAtLabels: true });
  if (fc) {
    fc.lineWords.forEach((ws) => {
      const t = joinWords(ws);
      const m = /^(.*?)\s+(PREPAID|COLLECT|PP|CC)\b/i.exec(t);
      if (m) charges.push({ description: squash(m[1]), terms: /^(PREPAID|PP)$/i.test(m[2]) ? 'prepaid' : 'collect' });
    });
  }

  const ams = labelText(doc, 'amsFiledBy');
  const isf = labelText(doc, 'isfFiledBy');
  const coo = labelText(doc, 'countryOfOrigin', { validate: (t) => !!(countryCode(t) ?? findCountry(t)) });
  const exportRefs = findLabelValue(doc, 'exportReferences', { mode: 'block', maxLines: 3 });
  const exportReferences = exportRefs
    ? exportRefs.lines.flatMap((l) =>
        squash(l)
          .split(/\s+(?=(?:INV|INVOICE|PO|P\.O\.|REF|S\/O|SO|BKG|ORDER|LC|L\/C)\b)/i)
          .map((s) => squash(s.replace(/\s_+|_+(?=\S)/g, ' ')))
          .filter(Boolean),
      )
    : [];

  // house vs master: a separate master bill or an NVOCC/OTI issuer means house; a carrier's own bill is master
  let blType: BillOfLadingData['blType'] = 'unknown';
  if ((masterBlNumber && masterBlNumber !== blNumber) || /\bHOUSE\s+B(?:ILL|\/L)|\bHBL\b|\bNVOCC\b|\bOTI\b|\bH\s?B\/L\b/i.test(allText)) blType = 'house';
  else if (/\bMASTER\s+B(?:ILL|\/L)\b|\bMBL\b/i.test(allText) || issuerScac || carrierScac) {
    blType = 'master';
    carrierScac ??= issuerScac;
    carrierName ??= issuerName?.replace(/,?\s*AS\s+AGENTS?.*$/i, '');
  }

  const data: BillOfLadingData = {
    kind: 'bill_of_lading',
    blType,
    blNumber,
    exportReferences,
    containers,
    cargoDescription,
    hsCodes,
    charges,
  };
  if (issuerName) data.issuerName = issuerName;
  if (issuerScac) data.issuerScac = issuerScac;
  if (masterBlNumber) data.masterBlNumber = masterBlNumber;
  if (carrierName) data.carrierName = carrierName;
  if (carrierScac) data.carrierScac = carrierScac;
  if (booking) data.bookingNumber = cleanCode(booking.text);
  if (pty.shipper) data.shipper = pty.shipper;
  if (pty.consignee) data.consignee = pty.consignee;
  if (pty.notify) data.notifyParty = pty.notify;
  if (pty.alsoNotify) data.alsoNotify = pty.alsoNotify;
  if (vessel) data.vessel = vessel;
  if (voyage) data.voyage = voyage;
  if (preCarriage) data.preCarriage = preCarriage.text;
  if (placeOfReceipt) data.placeOfReceipt = placeOfReceipt.text;
  if (pol) data.portOfLoading = pol.text;
  if (pod) data.portOfDischarge = pod.text;
  if (placeOfDelivery) data.placeOfDelivery = placeOfDelivery.text;
  if (finalDestination) data.finalDestination = finalDestination.text;
  if (moveType) data.moveType = moveType.text;
  if (onBoardDate) data.onBoardDate = onBoardDate;
  if (issueDate) data.issueDate = issueDate;
  if (issuePlace) data.issuePlace = issuePlace;
  if (packages) data.packages = packages;
  if (grossWeightKg !== undefined) data.grossWeightKg = grossWeightKg;
  if (volumeCbm !== undefined) data.volumeCbm = volumeCbm;
  if (freightM) data.freightTerms = `FREIGHT ${freightM[1].toUpperCase()}`;
  data.releaseType = releaseType;
  if (originalsCount !== undefined) data.originalsCount = originalsCount;
  if (ams) data.amsFiledBy = ams.text;
  if (isf) data.isfFiledBy = isf.text;
  if (coo) data.countryOfOrigin = countryCode(coo.text) ?? findCountry(coo.text)?.iso;
  return data;
}

interface OnBoard {
  date: ParsedDate;
  words: PWord[];
  conf: number;
  page: number;
  source: string;
}

/** On-board date from the stamp pass, an "ON BOARD" label/stamp in the text, or a labelled field. */
function findOnBoardDate(doc: PDoc, stamps: Array<{ text: string; page: number }>): OnBoard | null {
  // stamp pass: "SHIPPED ON BOARD" followed by a date on the same or next stamp line
  let fromStamp: OnBoard | null = null;
  for (let i = 0; i < stamps.length && !fromStamp; i++) {
    // tolerant: stamp OCR reads "SHIPPED ON BOARD" as "SHIPPED ON ROAR D", "LADEN 0N BOARD", ...
    if (!/ON\s+B[O0]ARD|SHIPPED\s+[O0]N\b|LADEN\s+[O0]N\b/i.test(stamps[i].text)) continue;
    for (const s of stamps.slice(i, i + 3)) {
      const d = parseDate(s.text);
      if (d) {
        fromStamp = { date: d, words: [], conf: 70, page: s.page, source: 'stamp' };
        break;
      }
    }
  }
  const fromText = onBoardFromText(doc);
  // typed text wins over stamp text unless the "typed" reading is itself the stamp seen by the main OCR pass
  if (fromText && fromStamp && fromText.date.iso !== fromStamp.date.iso) {
    const isStampText = stamps.some((s) => s.text.includes(fromText.date.raw));
    return isStampText ? fromStamp : fromText;
  }
  return fromStamp ?? fromText;
}

function onBoardFromText(doc: PDoc): OnBoard | null {
  // OCR text: label hits and stamp text below them
  const hits = findLabels(doc).filter((h) => h.field === 'onBoardDate');
  for (const h of hits) {
    const page = pageOf(doc, h.page);
    const right = valueRight(doc, h);
    const candidates: PWord[][] = [];
    if (right) candidates.push(right.words);
    for (let li = h.line + 1; li < page.lines.length && li <= h.line + 3; li++) {
      const ws = realWords(page.lines[li]).filter((w) => Math.abs(xCenter(w) - (h.x0 + h.x1) / 2) < (h.x1 - h.x0) + 6 * page.medH);
      if (ws.length) candidates.push(ws);
    }
    for (const ws of candidates) {
      const text = joinWords(ws);
      const d = parseDate(text);
      if (!d) continue;
      const used = ws.filter((w) => d.raw.includes(w.text) || /\d/.test(w.text));
      return { date: d, words: used, conf: Math.min(...used.map((w) => w.conf)), page: h.page, source: 'on-board stamp/text' };
    }
  }
  return null;
}

/** Container numbers with candidates, seals and size/type. */
function extractContainers(doc: PDoc, ctx: ParseContext, allText: string, billNumbers: string[] = []): Container[] {
  const hints = ownerCodeHints(allText);
  const box = findLabelValue(doc, ['containerMarks', 'containerNo'], { mode: 'block', maxLines: 12, stopAtLabels: false });
  const boxTokens: RawToken[] = [];
  const pageTokens: RawToken[] = [];
  for (const p of doc.pages) {
    for (const l of p.lines) {
      for (const w of realWords(l)) {
        const tok: RawToken = { text: w.text, conf: w.conf, raw: w.raw, line: p.page * 10000 + l.index, x0: w.x0 };
        pageTokens.push(tok);
      }
    }
  }
  if (box) {
    for (const ws of box.lineWords) {
      const lineText = joinWords(ws);
      if (/\bSEAL/i.test(lineText)) continue;
      for (const w of ws) boxTokens.push({ text: w.text, conf: w.conf, raw: w.raw, line: w.page * 10000 + w.line, x0: w.x0 });
    }
  }
  // strict ISO numbers anywhere on the page + confusion-aware readings inside the container box
  const strict = containerCandidates(pageTokens.filter((t) => /[A-Z]{3}[UJZ]\s?\d{6}/i.test(t.text) || /^[A-Z]{4}$/i.test(t.text) || /^\d{6,7}$/.test(t.text)), hints).filter((c) => c.source === 'typed');
  const fuzzy = containerCandidates(boxTokens, [...hints, ...strict.map((s) => s.number.slice(0, 4))]);
  // bill/booking numbers can have the container shape (carrier prefix + 7 digits): never containers
  const readings = [...strict, ...fuzzy.filter((f) => !strict.some((s) => s.number === f.number && s.line === f.line))].filter(
    (r) => !billNumbers.some((b) => b.includes(r.number) || r.number.includes(b)),
  );
  const tokens = [...pageTokens, ...boxTokens];
  const groups = groupContainerReadings(readings);
  const choices = groups.map((g) => chooseContainer(g, tokens)).filter((c): c is NonNullable<typeof c> => !!c);
  if (!choices.length) return [];
  // seals, each assigned to the nearest container (all of them when there is a single container)
  const seals: Array<{ seal: string; line: number }> = [];
  for (const p of doc.pages) {
    for (const l of p.lines) {
      for (const m of l.text.matchAll(/\bSEAL(?:S|\s*NO\.?|\s*#|\s*NOS?\.?)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{4,}(?:\s*[,/&]\s*[A-Z0-9][A-Z0-9-]{4,})*)/gi)) {
        for (const sl of m[1].split(/\s*[,/&]\s*/)) {
          const seal = sl.toUpperCase();
          if (/\d/.test(seal) && !seals.some((x) => x.seal === seal) && !choices.some((c) => c.number === seal)) seals.push({ seal, line: p.page * 10000 + l.index });
        }
      }
    }
  }
  const lineOf = (c: (typeof choices)[number]) => Math.min(...c.readings.map((r) => r.line));
  const globalSize = [...(box?.lines ?? []), ...allText.split('\n')].map((t) => parseSizeType(t)).find(Boolean)?.sizeType;
  return choices.map((choice, i) => {
    const mine = seals.filter((sl) => choices.length === 1 || choices.reduce((best, c, j) => (Math.abs(lineOf(c) - sl.line) < Math.abs(lineOf(choices[best]) - sl.line) ? j : best), 0) === i);
    const ownLines = new Set(choice.readings.map((r) => r.line));
    const ownText = doc.pages.flatMap((p) => p.lines.filter((l) => ownLines.has(p.page * 10000 + l.index)).map((l) => l.text));
    const sizeType = ownText.map((t) => parseSizeType(t)).find(Boolean)?.sizeType ?? globalSize;
    const sealNumbers = mine.map((x) => x.seal);
    // "Container No. / Seal No." grids print "HNRU4120679 / HN6204417" (OCR may add a quote after the slash)
    if (!sealNumbers.length && /\bSEAL/i.test(allText)) {
      const re = new RegExp(`${choice.number.slice(0, 4)}\\s?${choice.number.slice(4)}\\s*/['’"]?\\s*([A-Z0-9][A-Z0-9-]{4,14})\\b`, 'i');
      for (const t of ownText) {
        const m = re.exec(t);
        const seal = m?.[1].toUpperCase();
        if (seal && /\d/.test(seal) && !choices.some((c) => c.number === seal) && !billNumbers.some((b) => b === seal)) sealNumbers.push(seal);
      }
    }
    const container: Container = { number: choice.number, checkDigitValid: choice.checkDigitValid, sealNumbers };
    if (sizeType) container.sizeType = sizeType;
    if (choice.candidates.length) container.candidates = choice.candidates;
    const path = `containers[${i}].number`;
    const chosen = choice.chosen;
    // a repaired reading that passes the check digit is more reliable than its raw OCR confidence, but still low
    const conf = choice.repaired ? (choice.checkDigitValid ? 40 : Math.min(chosen.conf, 30)) : chosen.conf;
    const words = (box?.words ?? []).filter((w) => chosen.originalText.split(' ').includes(w.text));
    ctx.meta(path, words, choice.repaired ? { conf, repaired: true, originalText: chosen.originalText } : { conf });
    for (const r of choice.readings) {
      if (r.source === 'strikethrough') ctx.observe('strikethrough', `Typed container number read as ${r.number} appears crossed out (fails ISO 6346 check digit).`, path);
      if (r.source === 'handwritten') ctx.observe('handwritten', `Handwritten container number "${r.originalText}" read as ${r.number} (${r.repairs.join('; ')}); passes ISO 6346 check digit.`, path);
    }
    if (!choice.checkDigitValid) ctx.observe('low_confidence', `Container number ${choice.number} fails the ISO 6346 check digit.`, path);
    return container;
  });
}

/** "ZHOUSHAN PACIFIC LINES (SCAC ZSPL)" → "ZHOUSHAN PACIFIC LINES". */
function cleanCarrierName(t: string): string {
  return trimSeparators(
    t
      .replace(/\(\s*(?:SCAC\s*:?\s*)?[A-Z]{4}\s*\)/g, '')
      .replace(/,?\s*AS\s+AGENTS?\b.*$/i, '')
      .replace(/^\s*(?:CARRIER|OCEAN\s+CARRIER)\s*[:]/i, ''),
  );
}

/**
 * A bill-number-like code near a label: on the same line, or on one of the next lines of its
 * box (stacked boxes such as "OCEAN CARRIER / MASTER B/L NO." hold several values).
 */
function codeNear(doc: PDoc, field: 'blNumber' | 'masterBl', accept: (code: string) => boolean = () => true): { code: string; words: PWord[] } | null {
  for (const hit of labelHits(doc, field)) {
    const cands: PWord[][] = [];
    const right = valueRight(doc, hit);
    if (right && (hit.colon || right.words[0].x0 - hit.x1 > 1.5 * pageOf(doc, hit.page).medH || /\d/.test(right.words[0].text))) cands.push(right.words);
    const below = valueBelow(doc, hit, 3);
    if (below) cands.push(...below.lineWords);
    for (const ws of cands) {
      const text = joinWords(ws);
      for (const tok of [firstCode(text), ...text.split(/\s+/)]) {
        const code = cleanCode(tok);
        if (looksLikeBillNumber(code) && /[A-Z]/i.test(code) && accept(code)) return { code, words: ws.filter((w) => code.includes(cleanCode(w.text)) && cleanCode(w.text).length > 2) };
      }
    }
  }
  return null;
}

/**
 * Issuer of the bill: the company block that carries the issuer's SCAC/FMC line (name = the line with a
 * legal form, plus a preceding all-letters line such as a large-type brand word), else the name after
 * "Signed for the Carrier".
 */
function findIssuerName(doc: PDoc): string | undefined {
  for (const page of doc.pages) {
    const anchor = page.lines.find((l) => /\bSCAC\b|\bFMC\b|\bNVOCC\b|\bOTI\s+NO/i.test(l.text) && l.y0 < page.height * 0.4);
    if (!anchor) continue;
    const blocks = textBlocks(page, anchor.y1 + 1);
    const block = blocks.find((b) => b.lines.some((ws) => ws.some((w) => w.line === anchor.index) && /\bSCAC\b|\bFMC\b|\bNVOCC\b|\bOTI\b/i.test(joinWords(ws))));
    if (!block) continue;
    const texts = block.lines.map((ws) => joinWords(ws.filter((w) => !w.noise)));
    const k = texts.findIndex((t) => hasLegalSuffix(t.replace(/,$/, '')));
    if (k < 0) continue;
    const prev = texts[k - 1];
    const name = prev && /^[A-Z][A-Z &.'-]+$/.test(prev) && !/\b(?:NO|BILL|LADING|B\/L)\b/.test(prev) ? `${prev} ${texts[k]}` : texts[k];
    return trimSeparators(name);
  }
  for (const page of doc.pages) {
    for (let i = 0; i < page.lines.length; i++) {
      for (const seg of segmentsOf(page.lines[i], page.segGap)) {
        const t = joinWords(seg);
        const same = /(?:ON\s+BEHALF\s+OF|SIGNED\s+(?:FOR|BY))\s+(?:AND\s+ON\s+BEHALF\s+OF\s+)?THE\s+CARRIER\s*:\s*(.{4,})$/i.exec(t);
        if (same) return trimSeparators(same[1].replace(/,?\s*AS\s+AGENTS?\b.*$/i, ''));
        if (!/ON\s+BEHALF\s+OF|SIGNED\s+(?:FOR|BY)|AS\s+CARRIER/i.test(t)) continue;
        const next = page.lines.slice(i + 1, i + 3).flatMap((l) => segmentsOf(l, page.segGap)).find((sg) => Math.abs(sg[0].x0 - seg[0].x0) < 3 * page.medH);
        if (next && /[A-Za-z]{3,}/.test(joinWords(next))) return trimSeparators(joinWords(next));
      }
    }
  }
  return undefined;
}
