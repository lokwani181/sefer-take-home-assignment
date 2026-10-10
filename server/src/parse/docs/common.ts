/**
 * Helpers shared by the document parsers: title detection, letterhead (issuer) block,
 * labelled party blocks, single labelled values, table bands and remark → line links.
 */
import type { Address } from '@app/shared';
import { TITLES } from '../vocab';
import { findLabels, findLabelValue, findLabelValues, type FindLabelOptions, type LabelValue, type Region } from '../labels';
import type { LabelField } from '../vocab';
import { joinWords, meanConf, segmentsOf, type PDoc, type PLine, type PPage, type PWord } from '../layout';
import { compactKey, squash, trimSeparators } from '../text';
import { hasLegalSuffix, parseParty } from '../party';
import type { TableResult } from '../table';
import { countryCode, findCountry } from '../countries';

export type TitledType = keyof typeof TITLES;

export interface TitleHit {
  type: TitledType;
  phrase: string;
  page: number;
  line: PLine;
  /** 0–1: how title-like the line is (position, size, isolation). */
  strength: number;
}

const TITLE_ORDER: TitledType[] = ['invoice_packing_list', 'arrival_notice', 'air_waybill', 'bill_of_lading', 'packing_list', 'commercial_invoice'];

/**
 * Finds title phrases on page 1 (top 45%) — the strongest classification signal.
 * Matching is per text block so that a title printed beside other blocks still counts,
 * while label uses ("Ref. Invoice:", "Invoice No.") do not. Returns hits sorted by strength.
 */
export function findTitles(doc: PDoc): TitleHit[] {
  const page = doc.pages[0];
  if (!page) return [];
  const out: TitleHit[] = [];
  for (const line of page.lines) {
    if (line.y0 > page.height * 0.45) continue;
    for (const seg of segmentsOf(line, page.segGap)) {
      const segText = joinWords(seg);
      const key = compactKey(segText);
      if (!key) continue;
      const height = Math.max(...seg.map((w) => w.y1 - w.y0));
      let found = false;
      for (const type of TITLE_ORDER) {
        for (const phrase of TITLES[type]) {
          const pk = compactKey(phrase);
          const at = key.indexOf(pk);
          if (pk.length < 3 || at < 0) continue;
          // short codes (B/L, HAWB) only count when they are most of the block
          if (pk.length <= 4 && key.length > pk.length + 6) continue;
          // label use: "Invoice No.:", "Invoice:", "Ref. Invoice"
          const after = key.slice(at + pk.length);
          const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
          const m = re.exec(segText);
          const textAfter = m ? segText.slice(m.index + m[0].length) : '';
          const specific = /\s/.test(phrase.trim());
          const labelUse = /^\s*[:#]/.test(textAfter) || /^(?:NO|NUMBER|NR|DATE|REF)/.test(after) || /^REF/.test(key);
          // "Invoice No.:" / "Ref. Invoice:" are labels; a specific title may still carry a number ("BILL OF LADING No.")
          if (labelUse && (!specific || at > 0)) continue;
          const share = Math.min(1, (pk.length / key.length) * 1.25);
          const big = height >= 1.4 * page.medH ? 0.2 : 0;
          const top = line.y0 < page.height * 0.25 ? 0.1 : 0;
          const strength = Math.min(1, (0.3 + 0.4 * share + big + top + (specific ? 0.1 : 0)) * (labelUse ? 0.85 : 1));
          out.push({ type, phrase, page: page.page, line, strength });
          found = true;
          break;
        }
        if (found) break;
      }
    }
  }
  return out.sort((a, b) => b.strength - a.strength);
}

export interface Letterhead {
  name: string;
  lines: string[];
  conf: number[];
  words: PWord[];
}

export interface TextBlock {
  lines: PWord[][];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Groups the text of a page region into blocks: segments that are stacked closely and overlap
 * horizontally (a letterhead, an address window, a box of fields). Table rules ("|") are kept
 * inside the segment text so callers can split on them.
 */
export function textBlocks(page: PPage, maxY: number, skip: (w: PWord) => boolean = () => false): TextBlock[] {
  const blocks: Array<TextBlock & { lx0: number; lx1: number }> = [];
  const gap = Math.max(2 * page.medH, 60);
  for (const line of page.lines) {
    if (line.y0 > maxY) break;
    for (const seg of segmentsOf(line, gap)) {
      const x0 = seg[0].x0;
      const x1 = Math.max(...seg.map((w) => w.x1));
      const ws = line.words.filter((w) => w.x0 >= x0 - 1 && w.x1 <= x1 + 1 && (!w.noise || /^[|¦]$/.test(w.text)) && w.conf >= 20 && !skip(w));
      if (!ws.length || !ws.some((w) => /[A-Za-z0-9]/.test(w.text))) continue;
      const y0 = Math.min(...ws.map((w) => w.y0));
      const y1 = Math.max(...ws.map((w) => w.y1));
      const h = Math.max(...ws.map((w) => w.y1 - w.y0));
      // a block grows downwards by overlapping its previous line (not its whole extent)
      const b = blocks
        .filter((bl) => y0 - bl.y1 <= Math.max(1.2 * page.medH, 0.6 * h) && y0 > bl.y0 && Math.min(bl.lx1, x1) - Math.max(bl.lx0, x0) > 0)
        .sort((a, c) => c.y1 - a.y1)[0];
      if (b) {
        b.lines.push(ws);
        b.x0 = Math.min(b.x0, x0);
        b.x1 = Math.max(b.x1, x1);
        b.y1 = Math.max(b.y1, y1);
        b.lx0 = x0;
        b.lx1 = x1;
      } else blocks.push({ lines: [ws], x0, x1, y0, y1, lx0: x0, lx1: x1 });
    }
  }
  return blocks.map(({ lines, x0, x1, y0, y1 }) => ({ lines, x0, x1, y0, y1 }));
}

/** Labels that open another party's block: a letterhead never runs into them. */
const PARTY_LABEL_FIELDS: readonly LabelField[] = ['seller', 'shipper', 'buyer', 'shipTo', 'consignee', 'notify', 'alsoNotify', 'manufacturer'];

/**
 * The issuer block (company name, address, phone) at the top of page 1: the first block above or
 * beside the title whose first lines carry a company legal form, else the first substantial block.
 *
 * A block over or under the title ends at the title line. A block printed BESIDE the title (no
 * horizontal overlap: company top-left, "INVOICE" top-right) is its own column, so it keeps the
 * lines that continue it below the title line (clipped to the column by `textBlocks`, which splits
 * a visual line into segments at wide gaps), until a vertical gap, another party's label or a line that
 * starts a labelled field.
 */
export function letterhead(doc: PDoc): Letterhead | null {
  const page = doc.pages[0];
  if (!page) return null;
  const title = findTitles(doc).find((t) => t.page === page.page);
  const titleSeg = title ? segmentsOf(title.line, page.segGap).find((sg) => compactKey(joinWords(sg)).includes(compactKey(title.phrase))) ?? [] : [];
  const titleWords = new Set(titleSeg);
  const limitY = title ? title.line.y1 : page.height * 0.2;
  const tx0 = titleSeg.length ? Math.min(...titleSeg.map((w) => w.x0)) : Infinity;
  const tx1 = titleSeg.length ? Math.max(...titleSeg.map((w) => w.x1)) : -Infinity;
  const scanY = titleSeg.length ? Math.max(limitY, page.height * 0.45) : limitY;
  const pageLabels = findLabels(doc).filter((h) => h.credible && h.page === page.page);
  const partyLabelWords = new Set(pageLabels.filter((h) => PARTY_LABEL_FIELDS.includes(h.field)).map((h) => h.words[0]));
  const labelStarts = new Set(pageLabels.map((h) => h.words[0]));
  // the visual line's top, as textBlocks used to stop on (`line.y0 > maxY`)
  const top = (ws: PWord[]) => page.lines[ws[0].line]?.y0 ?? Math.min(...ws.map((w) => w.y0));
  // Blocks are built top-down, so the lines above the title line group exactly as before; only
  // blocks beside the title may keep what follows below it.
  const blocks = textBlocks(page, scanY, (w) => titleWords.has(w))
    .filter((b) => b.y0 < limitY)
    .map((b): TextBlock => {
      const head = b.lines.filter((ws) => top(ws) <= limitY);
      const hx0 = Math.min(...head.flat().map((w) => w.x0));
      const hx1 = Math.max(...head.flat().map((w) => w.x1));
      const beside = titleSeg.length > 0 && (hx1 < tx0 || hx0 > tx1);
      if (!beside) return { ...b, lines: head };
      // the continuation ends at another party's label, or at a line that starts a labelled field ("Invoice No.:")
      const stop = b.lines.findIndex((ws) => {
        if (top(ws) <= limitY) return false;
        const first = ws.find((w) => !w.noise);
        return ws.some((w) => partyLabelWords.has(w)) || (!!first && labelStarts.has(first));
      });
      return stop > 0 ? { ...b, lines: b.lines.slice(0, stop) } : b;
    });
  const useful = (b: TextBlock) => b.lines.filter((ws) => ws.length >= 2 || ws.some((w) => w.text.length > 4));
  const scored = blocks.map((b) => {
    const ls = useful(b);
    const legal = ls.slice(0, 3).findIndex((ws) => hasLegalSuffix(joinWords(ws.filter((w) => !w.noise))));
    return { b, ls, legal };
  });
  const pick = scored.find((x) => x.legal >= 0) ?? scored.find((x) => x.ls.length >= 2);
  if (!pick) return null;
  const ls = pick.ls.slice(Math.max(0, pick.legal));
  const lines = ls.map((ws) => joinWords(ws).replace(/\s*[|¦]\s*/g, ' | '));
  let name = trimSeparators(joinWords(ls[0].filter((w) => !w.noise)));
  // a logo prints the name over two lines ("STRAITSBRIDGE" / "SOURCING PTE. LTD."): join them when the
  // full name is printed as one line elsewhere (signature block, footer)
  const prev = pick.legal > 0 ? trimSeparators(joinWords(pick.ls[pick.legal - 1].filter((w) => !w.noise))) : undefined;
  if (prev && !/\d/.test(prev)) {
    const joined = `${prev} ${name}`;
    if (printedElsewhere(doc, joined, new Set(pick.b.lines.flat()))) {
      name = joined;
      lines[0] = joined;
    }
  }
  const conf = ls.map((ws) => meanConf(ws));
  const words = ls.flat();
  // logo left, address right: the name block has no locality, a block beside it starts with a street
  // line and parses into one ("12 Marina View, #08-01" / "Singapore 018961")
  const located = (ls2: string[]) => {
    const a = parseParty(ls2);
    return !!(a.country || a.city);
  };
  if (!located(lines)) {
    // the address lines of a block run until its first labelled field ("Inv. Ref. …")
    const addressLines = (x: (typeof scored)[number]) => {
      const cut = x.ls.findIndex((ws) => ws.some((w) => labelStarts.has(w)));
      return cut < 0 ? x.ls : x.ls.slice(0, cut);
    };
    const beside = scored.find((x) => {
      const al = addressLines(x);
      return (
        x !== pick &&
        al.length > 0 &&
        x.b.y0 < pick.b.y1 &&
        x.b.y1 > pick.b.y0 &&
        STREET_START_RE.test(joinWords(al[0])) &&
        located([name, ...al.map((ws) => joinWords(ws))])
      );
    });
    if (beside) {
      for (const ws of addressLines(beside)) {
        lines.push(joinWords(ws).replace(/\s*[|¦]\s*/g, ' | '));
        conf.push(meanConf(ws));
        words.push(...ws);
      }
    }
  }
  return { name, lines, conf, words };
}

/** A line that opens a street address: a house number or a street word first. */
const STREET_START_RE = /^\s*(?:\d+[A-Z]?\b|(?:NO|LOT|PLOT|UNIT|SUITE|FLOOR|BLOCK|BLDG|BUILDING|JL|JALAN|ROOM|RM)\b\.?)/i;

/** True when `text` is printed within one line segment of the document outside `exclude`. */
function printedElsewhere(doc: PDoc, text: string, exclude: Set<PWord>): boolean {
  const key = compactKey(text);
  if (key.length < 8) return false;
  return doc.pages.some((p) =>
    p.lines.some((l) => segmentsOf(l, p.segGap).some((sg) => !sg.some((w) => exclude.has(w)) && compactKey(joinWords(sg)).includes(key))),
  );
}

/**
 * Address blocks printed without a label (e.g. the recipient window of a European letter):
 * blocks in the upper part of page 1 that parse into a named address with a locality.
 * Lines naming `exclude` (the issuer's return-address line) and leading country-only lines are dropped.
 */
export function unlabeledAddresses(doc: PDoc, opts: { maxY?: number; exclude?: string[] } = {}): Address[] {
  const page = doc.pages[0];
  if (!page) return [];
  const maxY = opts.maxY ?? page.height * 0.45;
  const out: Address[] = [];
  const excl = (opts.exclude ?? []).map((e) => compactKey(e)).filter((k) => k.length >= 6);
  const labelWords = new Set(findLabels(doc).filter((h) => h.credible).map((h) => h.words[0]));
  for (const b of textBlocks(page, maxY)) {
    // lines that start a labelled field belong to a key/value grid, not to an address
    let lines = b.lines.filter((ws) => !ws.some((w) => labelWords.has(w))).map((ws) => joinWords(ws.filter((w) => !w.noise)));
    // the excluded party's own block (e.g. the issuer letterhead) is skipped entirely
    if (lines.length && excl.some((k) => compactKey(lines[0]) === k)) continue;
    // a one-line return address ("Seller GmbH · street · city") above the recipient is dropped
    while (lines.length && (excl.some((k) => compactKey(lines[0]).includes(k)) || countryCode(lines[0]) || !/[A-Za-z]{2,}/.test(lines[0]))) lines = lines.slice(1);
    if (lines.length < 2 || lines.length > 9) continue;
    const a = parseParty(lines);
    if (!a.name || !/[A-Za-z]{2,}.*\s+\S/.test(a.name) || /\d{3,}/.test(a.name)) continue;
    if (!(a.postalCode || (a.country && a.city))) continue;
    out.push(a);
  }
  return out;
}

/** Parses a letterhead into an Address. */
export function letterheadParty(lh: Letterhead): Address {
  return parseParty(lh.lines, { lineConf: lh.conf });
}

/** Row bands of an item table, used to keep header-field lookups out of table bodies. */
export function tableRegions(table: TableResult): Region[] {
  const out: Region[] = [];
  for (const p of table.pages) {
    const rows = table.rows.filter((r) => r.page === p.page);
    const ys = [...p.headerLines.map((l) => l.y0), ...rows.flatMap((r) => r.lines.map((l) => l.y0))];
    const ye = [...p.headerLines.map((l) => l.y1), ...rows.flatMap((r) => r.lines.map((l) => l.y1))];
    if (ys.length) out.push({ page: p.page, y0: Math.min(...ys), y1: Math.max(...ye) });
  }
  return out;
}

export interface PartyResult {
  address: Address;
  value: LabelValue;
}

/** A labelled party block ("Consignee", "Sold to", ...) parsed into an Address. */
export function partyBlock(doc: PDoc, fields: LabelField | LabelField[], opts: FindLabelOptions = {}): PartyResult | null {
  const v = findLabelValue(doc, fields, {
    mode: 'block',
    maxLines: 8,
    validate: (t) => /[A-Za-z]{3,}/.test(t),
    ...opts,
  });
  if (!v) return null;
  const address = parseParty(v.lines, { lineConf: v.lineWords.map(meanConf) });
  if (!address.name) return null;
  return { address, value: v };
}

/** First labelled value as text plus its words (for confidence/evidence). */
export function labelText(doc: PDoc, fields: LabelField | LabelField[], opts: FindLabelOptions = {}): { text: string; words: PWord[]; value: LabelValue } | null {
  const v = findLabelValue(doc, fields, opts);
  if (!v) return null;
  return { text: squash(v.text), words: v.words, value: v };
}

/** All labelled values for a field (e.g. every PO number on every page). */
export function labelTexts(doc: PDoc, fields: LabelField | LabelField[], opts: FindLabelOptions = {}): Array<{ text: string; words: PWord[] }> {
  return findLabelValues(doc, fields, opts).map((v) => ({ text: squash(v.text), words: v.words }));
}

const LONE_CODE_RE = /^(?=[A-Z0-9-/.]*\d)(?:[A-Z0-9]+(?:[-/.][A-Z0-9]+)+|[A-Z]{1,4}\d{3,}[A-Z0-9]*)$/i;

/**
 * A combined "Model No. / Description" cell prints the code alone on its first line and the
 * description below: returns the code and the remaining lines (unchanged when the first line is text).
 */
export function splitLeadingCode(lines: string[]): { code?: string; lines: string[] } {
  const first = (lines[0] ?? '').trim();
  if (lines.length < 2 || !LONE_CODE_RE.test(first) || !/[A-Za-z]{3,}/.test(lines[1])) return { lines };
  return { code: first, lines: lines.slice(1) };
}

/** First code-like token of a value ("KBAS/NB/26-0912 Date: ..." → "KBAS/NB/26-0912"), joining split joiners. */
export function firstCode(text: string): string {
  const t = text.trim().replace(/\s*([-/])\s*(?=[A-Z0-9])/gi, '$1');
  const tok = t.split(/\s+/)[0] ?? '';
  return tok.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '');
}

const MANUFACTURING_RE = /\b(?:GARMENTS?|FACTORY|MANUFACTUR\w*|TEXTILES?|KNIT\w*|WEAV\w*|MILLS?|INDUSTR\w*|SEWING|FASHION\s+(?:CO|COMPANY|LTD)|PRODUCTION|APPAREL\s+(?:MFG|MANUFACTURING)|FOOTWEAR|LEATHER\s+GOODS|DYEING|SPINNING)\b/i;
const TRADING_RE = /\b(?:TRADING|TRADE|SOURCING|IMPORT|EXPORT|IMPEX|LOGISTICS|FORWARDING|SHIPPING|AGENCY|AGENT|BUYING|HOLDINGS?|DISTRIBUT\w*|INTERNATIONAL\s+TRADE|MERCHANDIS\w*|WHOLESALE|RETAIL|BRANDS?)\b/i;

/** True when a company name looks like a producer rather than a trader/agent. */
export function looksLikeManufacturer(name: string): boolean {
  return MANUFACTURING_RE.test(name) && !TRADING_RE.test(name);
}

/**
 * Tokens that cannot belong to a postal address and end a maker address that runs on in free text:
 * package counts ("186 CTNS"), currency / amount / total labels, weights, HS and PO references.
 */
const NON_ADDRESS_RE =
  /(?:^|[\s,;])(?:\d[\d,.]*\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PCS|PIECES|PALLETS?|PLTS?|BALES?|ROLLS?|BOXES|CASES|DOZ(?:EN)?S?|KGS?|LBS?|CBM)\b|(?:CURRENCY|TOTAL|SUB-?TOTAL|AMOUNT|NET\s+WEIGHT|GROSS\s+WEIGHT|HS\s*CODE|HTS|P\.?O\.?\s*(?:NO\.?|#))(?=[\s:.#]|$)|(?:N\.?\s?W|G\.?\s?W)\.?\s*[:=]?\s*\d|US\$|USD\b|EUR\b)/i;

/** Cuts free text at the first token that cannot be part of an address (see NON_ADDRESS_RE). */
export function clipAddressText(text: string): string {
  const m = NON_ADDRESS_RE.exec(text);
  return (m ? text.slice(0, m.index) : text).replace(/[\s,;.:-]+$/, '');
}

/**
 * Line-level facts stated in a remark/footnote: producing factory and origin. Paragraphs are
 * separated by "\n" (a blank line on the page); a maker's address never continues past one.
 */
export function lineFactsFromNote(text: string): { manufacturer?: Address; countryOfOrigin?: string } {
  const out: { manufacturer?: Address; countryOfOrigin?: string } = {};
  const origin = /\b(?:MADE\s+IN|COUNTRY\s+OF\s+ORIGIN(?:\s+(?:OF|FOR)\s+(?:THIS|THESE|THE|THAT)\s+(?:ARTICLES?|ITEMS?|GOODS|LINES?|STYLES?|PRODUCTS?|MODELS?))?\s*[:-]?|ORIGIN\s*[:-]|PRODUCT\s+OF)\s*([A-Z][A-Za-z .'-]{2,40})/i.exec(text);
  if (origin) {
    const c = countryCode(origin[1].split(/[.,;)]/)[0]) ?? findCountry(origin[1].split(/[.;)]/)[0])?.iso;
    if (c) out.countryOfOrigin = c;
  }
  // "MADE IN SRI LANKA - Lanka Weave Garments (Pvt) Ltd, 41 Baseline Road, Colombo 09"
  const madeInBy = /\bMADE\s+IN\s+[A-Za-z .]+?\s*[-–:,]\s+(?=[A-Z][A-Za-z&.'() -]*\b(?:LTD|LIMITED|INC|LLC|CO|COMPANY|CORP|JSC|GMBH|PVT|PTE|SDN BHD|S\.?A)\b)/i.exec(text);
  if (madeInBy) {
    const rest = clipAddressText(text.slice(madeInBy.index + madeInBy[0].length).split(/\n/)[0]);
    const addr = parseParty([rest.replace(/[.\s]+$/, '')], { defaultCountry: out.countryOfOrigin });
    if (addr.name) {
      if (!addr.country && out.countryOfOrigin) addr.country = out.countryOfOrigin;
      out.manufacturer = addr;
      return out;
    }
  }
  const intro = /\b(?:PRODUCED|MANUFACTURED|MADE|SEWN|MFD|PRODUCED\s+AND\s+SHIPPED|MANUFACTURED\s+AND\s+SHIPPED)\s+(?:AT|BY)\s+(?:OUR\s+|THE\s+|A\s+)?(?:[A-Za-z]+'S\s+)?(?:SISTER\s+(?:UNIT|COMPANY|FACTORY|CONCERN)|SUB-?CONTRACTOR|CONTRACTED\s+FACTORY|PARTNER\s+FACTORY|AFFILIATE(?:D\s+FACTORY)?|FACTORY|MILL)?\s*[:,]?\s*/i.exec(text);
  if (intro) {
    const rest = clipAddressText(text.slice(intro.index + intro[0].length).split(/\n/)[0]);
    if (/^[A-Z0-9]/.test(rest) && !/^(?:IN|AT)\b/i.test(rest)) {
      const country = findCountry(rest.slice(0, 160), { last: false });
      let block = rest.split(/\.\s+(?=[A-Z])(?<!\b(?:LTD|CO|INC|CORP|NO|ST|RD)\.\s+(?=[A-Z]))/i)[0];
      if (country) {
        // cut right after the first mention of the country that ends the address, not one inside the
        // company name ("NUSANTARA FOOTWEAR VIETNAM CO., LTD., …, Vietnam")
        const m = new RegExp(`^(.*?\\b${country.name.split(' ').join('[\\s.]+')}\\b)(?!\\s*(?:CO\\b|CO\\.|COMPANY|CORP|LTD|LIMITED|INC|JSC|PTE|PVT|SDN|GROUP|LLC|GMBH))`, 'i').exec(rest.replace(/\s+/g, ' '));
        if (m) block = m[1];
      }
      block = block.replace(/[.\s]+$/, '');
      const addr = parseParty([block], { defaultCountry: out.countryOfOrigin });
      if (addr.name) {
        if (!addr.country && out.countryOfOrigin) addr.country = out.countryOfOrigin;
        out.manufacturer = addr;
      }
    }
  }
  return out;
}

/** Style numbers / carton numbers / item numbers mentioned in a remark that identify a line. */
export function noteMentions(text: string, line: { styleNo?: string; cartonRange?: string; lineNo?: number }): boolean {
  if (line.styleNo && new RegExp(`(^|[^A-Z0-9-])${line.styleNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9-])`, 'i').test(text)) return true;
  if (line.lineNo !== undefined && new RegExp(`\\b(?:ITEM|LINE)\\s*(?:NO\\.?\\s*)?#?\\s*${line.lineNo}\\b`, 'i').test(text)) return true;
  if (line.cartonRange) {
    const m = /\b(?:CARTON|CTN|C\/NO)S?\.?\s*(?:NO\.?|NOS\.?|#)?\s*[:.]?\s*(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?/i.exec(text);
    if (m) {
      const [a, b] = line.cartonRange.split('-').map(Number);
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      if (lo >= a && hi <= (b ?? a)) return true;
    }
  }
  return false;
}
