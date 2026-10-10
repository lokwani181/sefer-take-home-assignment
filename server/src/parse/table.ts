/**
 * Header-driven table extraction for item tables (invoice lines, packing list rows).
 *
 * Why: line-item tables differ in column order, wording and header layout (1–3 stacked
 * header lines, centred headers over left-aligned text, unlabeled columns lost by OCR).
 * The algorithm is generic:
 *   1. find the header band by matching column synonyms (vocab COLUMNS) on 1–3 stacked lines;
 *   2. build header cells (gaps / table rules split cells, stacked lines merge by x-overlap);
 *   3. refine column boundaries with the body's whitespace gutters, and split a column that
 *      holds two separate numeric clusters (an unlabeled column the OCR header pass missed);
 *   4. group body lines into rows: a row starts when the anchor column has a value,
 *      other lines are continuations; stop at totals/footers, skip "brought forward".
 */
import { COLUMNS, TABLE_STOP_ANY_RE, TABLE_STOP_RE, BROUGHT_FORWARD_RE, type ColumnField } from './vocab';
import { joinWords, realWords, xCenter, type PDoc, type PLine, type PPage, type PWord } from './layout';
import { compactKey, spacedKey } from './text';
import { parseNumber } from './numbers';

export interface TableColumn {
  field: ColumnField | null;
  /** Header text as read (stacked lines joined). Empty for inferred columns. */
  header: string;
  x0: number;
  x1: number;
  /** Unit or currency announced in the header ("KG", "LBS", "USD", "CM", "PCS"). */
  unit?: string;
  /** True when the column had no header and its meaning was inferred from the data. */
  inferred?: boolean;
  /** Extent of the header text itself (before boundary refinement). */
  hx0?: number;
  hx1?: number;
}

export interface TableRow {
  page: number;
  /** Visual lines of the row (first = the anchor line). */
  lines: PLine[];
  /** cells[columnIndex][lineIndex] = words of that column on that line. */
  cells: PWord[][][];
  columns: TableColumn[];
}

export interface TablePage {
  page: number;
  columns: TableColumn[];
  headerLines: PLine[];
  /** The totals/footer line that ended the table on this page, if any. */
  stopLine?: PLine;
  /** Cells of the stop line split by column (grand total rows). */
  stopCells?: PWord[][];
  broughtForward: PLine[];
}

export interface TableResult {
  found: boolean;
  pages: TablePage[];
  rows: TableRow[];
  warnings: string[];
}

export interface TableSpec {
  /** Anchor columns in priority order: a row starts where the first available one has a value. */
  anchors: ColumnField[];
  /** Header needs at least this many distinct recognized fields (default 3). */
  minFields?: number;
  /** Header must contain at least one of these. */
  requireAny?: ColumnField[];
}

interface ColSyn {
  field: ColumnField;
  key: string;
  /** Word form (" UNIT PRICE "), padded for whole-word containment checks. */
  spaced: string;
}
const COL_SYNS: ColSyn[] = Object.entries(COLUMNS).flatMap(([field, syns]) =>
  (syns as readonly string[]).map((s) => ({ field: field as ColumnField, key: compactKey(s), spaced: ` ${spacedKey(s)} ` })),
);
/** Synonyms up to this many characters only match inside a longer header as whole words. */
const SHORT_SYN = 5;
const UNIT_SUFFIX_RE = /(KGS|KG|LBS|LB|PCS|PC|USD|EUR|GBP|HKD|CNY|RMB|JPY|CM|MM|M3|CBM|INCH|DOZ|SETS|SET)$/;

/**
 * Maps a header cell text to a column field. Longest contained synonym wins; synonyms of
 * ≤3 characters must match the whole cell (after stripping a unit suffix like "(kg)").
 */
export function matchColumnField(text: string): { field: ColumnField; score: number } | null {
  const key = compactKey(text);
  if (!key) return null;
  const spaced = ` ${spacedKey(text)} `;
  const words = spaced.trim().split(' ');
  let core = key;
  for (let i = 0; i < 2; i++) {
    const stripped = core.replace(UNIT_SUFFIX_RE, '');
    if (stripped && stripped !== core) core = stripped;
  }
  let best: { field: ColumnField; score: number } | null = null;
  for (const s of COL_SYNS) {
    let score = 0;
    if (s.key === key || s.key === core) score = 100 + s.key.length;
    // a short synonym inside another word is not that header ("GOLDLINE" ⊃ LINE, "BEACH" ⊃ EACH)
    else if (s.key.length > 3 && (key.includes(s.key) || core.includes(s.key)) && (s.key.length > SHORT_SYN || spaced.includes(s.spaced))) score = s.key.length;
    // bilingual/stacked headers: a short synonym that is a whole word ("Menge Qty", "Pos. No.")
    else if (s.key.length <= 3 && words.includes(s.key)) score = s.key.length + 0.5;
    else if (s.key.length >= 2 && s.key.length <= 3 && core.startsWith(s.key) && core.length <= s.key.length + 2 && !/[A-Z]/.test(core.slice(s.key.length))) score = s.key.length;
    if (score && (!best || score > best.score)) best = { field: s.field, score };
  }
  return best;
}

function headerUnit(text: string): string | undefined {
  const t = text.toUpperCase();
  const m = /\b(KGS?|LBS?|USD|EUR|GBP|HKD|CNY|RMB|JPY|CAD|AUD|CHF|CM|MM|INCH|IN\.|M3|CBM|CFT|PCS|DOZ|SETS?|PRS|PAIRS)\b/.exec(t);
  return m ? m[1].replace(/\.$/, '').replace(/^KG$/, 'KGS').replace(/^LB$/, 'LBS') : undefined;
}

interface HeaderCell {
  words: PWord[];
  x0: number;
  x1: number;
  lineOrder: number;
}

const EXACT_KEYS = new Set(COL_SYNS.map((c) => c.key));

/** True when the words form a known column header phrase (optionally followed by a unit like "(kg)" or "USD"). */
function isHeaderPhrase(ws: PWord[]): boolean {
  const key = ws.map((w) => w.key).join('');
  if (EXACT_KEYS.has(key)) return true;
  const core = key.replace(UNIT_SUFFIX_RE, '');
  return core !== key && EXACT_KEYS.has(core);
}

/**
 * Splits one header line into cells. Wide gaps and table rules ("|") always split; inside a
 * chunk, known header phrases are matched greedily (longest first) so that tightly spaced
 * headers ("Ursprung Menge ME Unit Value") still separate, while unknown words split only at
 * gaps wider than normal word spacing.
 */
function lineCells(page: PPage, line: PLine, order: number): HeaderCell[] {
  const gap = Math.max(1.3 * page.medH, 30);
  const chunks: PWord[][] = [];
  let cur: PWord[] = [];
  let lastX1 = -Infinity;
  for (const w of line.words) {
    if (w.noise) {
      if (/[|¦]/.test(w.text) && cur.length) {
        chunks.push(cur);
        cur = [];
      }
      continue;
    }
    if (w.conf < 30 && !/[A-Za-z]{3,}/.test(w.text)) continue;
    if (cur.length && w.x0 - lastX1 > gap) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
    lastX1 = w.x1;
  }
  if (cur.length) chunks.push(cur);
  const cells: HeaderCell[] = [];
  const mk = (ws: PWord[]): HeaderCell => ({ words: ws, x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)), lineOrder: order });
  for (const chunk of chunks) {
    if (chunk.length === 1 || isHeaderPhrase(chunk)) {
      cells.push(mk(chunk));
      continue;
    }
    const pieces: Array<{ ws: PWord[]; known: boolean }> = [];
    for (let i = 0; i < chunk.length; ) {
      let j = Math.min(chunk.length, i + 6);
      for (; j > i + 1; j--) if (isHeaderPhrase(chunk.slice(i, j))) break;
      const known = isHeaderPhrase(chunk.slice(i, j));
      pieces.push({ ws: chunk.slice(i, j), known });
      i = j;
    }
    // unknown words: join neighbours at normal word spacing, or through a "/" (bilingual "Bezeichnung / Description")
    const merged: Array<{ ws: PWord[]; known: boolean }> = [];
    for (const p of pieces) {
      const prev = merged[merged.length - 1];
      const g = prev ? p.ws[0].x0 - prev.ws[prev.ws.length - 1].x1 : Infinity;
      const slash = prev && (prev.ws[prev.ws.length - 1].text === '/' || p.ws[0].text === '/');
      const tight = g < 0.6 * page.medH;
      if (prev && (slash || (tight && (!prev.known || !p.known)) || (tight && !prev.known && !p.known))) {
        // "Model No. / Description": a code and its description stacked in one column
        if (prev.known && p.known && !(slash && codeAndDescription(prev.ws, p.ws))) merged.push(p);
        else {
          prev.ws.push(...p.ws);
          prev.known = prev.known || p.known;
        }
      } else merged.push({ ws: [...p.ws], known: p.known });
    }
    for (const m of merged) cells.push(mk(m.ws));
  }
  return cells;
}

/** Two header phrases that name a code column and a description column ("Style / Description"). */
function codeAndDescription(a: PWord[], b: PWord[]): boolean {
  const fields = new Set([a, b].map((ws) => matchColumnField(joinWords(ws.filter((w) => w.text !== '/')))?.field));
  return fields.size === 2 && fields.has('style') && fields.has('description');
}

const overlap = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

/** Builds columns from a stack of header lines. */
function buildColumns(page: PPage, lines: PLine[]): TableColumn[] {
  const perLine = lines.map((l, i) => lineCells(page, l, i));
  const baseIdx = perLine.reduce((bi, cells, i) => (cells.length > perLine[bi].length ? i : bi), 0);
  type Col = { cells: HeaderCell[]; prefix: string[]; x0: number; x1: number };
  const cols: Col[] = perLine[baseIdx].map((c) => ({ cells: [c], prefix: [], x0: c.x0, x1: c.x1 }));
  const others = perLine.flatMap((cells, i) => (i === baseIdx ? [] : cells));
  for (const c of others) {
    const hits = cols.filter((col) => overlap(col, c) > 0.25 * Math.min(col.x1 - col.x0, c.x1 - c.x0));
    if (!hits.length) cols.push({ cells: [c], prefix: [], x0: c.x0, x1: c.x1 });
    else if (hits.length === 1) {
      hits[0].cells.push(c);
      hits[0].x0 = Math.min(hits[0].x0, c.x0);
      hits[0].x1 = Math.max(hits[0].x1, c.x1);
    } else {
      // spanning group header ("Weight (kg)" over "Net | Gross"): prefix each child
      const text = joinWords(c.words);
      for (const h of hits) h.prefix.push(text);
    }
  }
  cols.sort((a, b) => a.x0 - b.x0);
  const out: TableColumn[] = cols.map((col) => {
    const cells = [...col.cells].sort((a, b) => a.lineOrder - b.lineOrder || a.x0 - b.x0);
    const header = [...col.prefix, ...cells.map((c) => joinWords(c.words))].join(' ');
    const m = matchColumnField(header);
    const unit = headerUnit(header);
    // "Measurement (CBM)" holds a volume, not carton dimensions
    const field = m?.field === 'dimensions' && (unit === 'CBM' || unit === 'M3') ? 'volume' : m?.field ?? null;
    return { field, header, x0: col.x0, x1: col.x1, unit, score: m?.score ?? 0 } as TableColumn & { score: number };
  });
  resolveDuplicateFields(out as Array<TableColumn & { score: number }>);
  return out.map(({ field, header, x0, x1, unit }) => ({ field, header, x0, x1, unit, hx0: x0, hx1: x1 }));
}

/** When two columns map to the same field, disambiguate per-carton vs total weights, else keep the best. */
function resolveDuplicateFields(cols: Array<TableColumn & { score: number }>) {
  const byField = new Map<ColumnField, Array<TableColumn & { score: number }>>();
  for (const c of cols) if (c.field) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  for (const [field, list] of byField) {
    if (list.length < 2) continue;
    if (field === 'netWeight' || field === 'grossWeight') {
      const perCtn = field === 'netWeight' ? 'netWeightPerCarton' : 'grossWeightPerCarton';
      const totals = list.filter((c) => /TOTAL/i.test(c.header));
      if (totals.length === 1) {
        for (const c of list) if (c !== totals[0]) c.field = perCtn;
        continue;
      }
    }
    if (field === 'quantity') {
      const totals = list.filter((c) => /TOTAL/i.test(c.header));
      if (totals.length === 1 && list.length === 2) {
        const other = list.find((c) => c !== totals[0])!;
        if (!cols.some((c) => c.field === 'pcsPerCarton')) other.field = 'pcsPerCarton';
        else other.field = null;
        continue;
      }
    }
    const keep = list.reduce((a, b) => (b.score > a.score ? b : a));
    for (const c of list) if (c !== keep) c.field = null;
  }
}

function digitShare(line: PLine): number {
  const ws = realWords(line);
  if (!ws.length) return 0;
  return ws.filter((w) => /\d/.test(w.text) && !/^\(?(kg|kgs|cm|lbs?)\)?$/i.test(w.text)).length / ws.length;
}

/** Finds the best header band on a page. */
function findHeader(page: PPage, spec: TableSpec): { lines: PLine[]; columns: TableColumn[]; fields: number } | null {
  let best: { lines: PLine[]; columns: TableColumn[]; fields: number } | null = null;
  const minFields = spec.minFields ?? 3;
  for (let i = 0; i < page.lines.length; i++) {
    for (let n = 1; n <= 5 && i + n <= page.lines.length; n++) {
      const lines = page.lines.slice(i, i + n);
      let ok = true;
      for (let k = 1; k < lines.length; k++) if (lines[k].y0 - lines[k - 1].y1 > 1.2 * page.medH) ok = false;
      // header lines carry no amounts, no "label: value" pairs and are not totals / brought-forward lines
      const dataLike = (l: PLine) => {
        const ws = realWords(l);
        return (
          digitShare(l) > 0.34 ||
          ws.some((w) => /\d[.,]\d{2}\b/.test(w.text)) ||
          ws.some((w, k) => /[A-Za-z][:]$/.test(w.text) && k + 1 < ws.length) ||
          BROUGHT_FORWARD_RE.test(l.text) ||
          isStopLine(l)
        );
      };
      if (!ok || lines.some(dataLike)) break;
      // every stacked line must add header words or units ("USD", "(kg)"); titles and labels above do not
      if (lines.length > 1 && !lines.every((l) => lineCells(page, l, 0).some((c) => {
        const t = joinWords(c.words);
        return !!matchColumnField(t) || /^\(?(?:USD|EUR|GBP|HKD|CNY|RMB|JPY|KGS?|LBS?|CM|MM|M3|CBM|PCS|DOZ|SETS?)\)?\.?$/i.test(t.replace(/\s+/g, ''));
      }))) continue;
      const columns = buildColumns(page, lines);
      const recognized = columns.filter((c) => c.field);
      const fields = new Set(recognized.map((c) => c.field)).size;
      if (fields < minFields) continue;
      if (spec.requireAny && !recognized.some((c) => spec.requireAny!.includes(c.field!))) continue;
      // a header is mostly recognizable cells
      if (recognized.length < 0.5 * columns.length) continue;
      // same fields from the same start: an extra stacked line that only adds units ("USD", "(kg)") belongs to the header
      const better =
        !best ||
        fields > best.fields ||
        (fields === best.fields && best.lines[0] === lines[0] && lines.length > best.lines.length && columns.length === best.columns.length);
      if (better) best = { lines, columns, fields };
    }
  }
  return best;
}

function isStopLine(line: PLine): boolean {
  const t = line.text.trim();
  return TABLE_STOP_RE.test(t) || TABLE_STOP_ANY_RE.test(t);
}

/** Body lines between the header and the first footer line (or a large vertical gap). */
function bodyLines(page: PPage, afterY: number, startIdx: number): { lines: PLine[]; stop?: PLine; broughtForward: PLine[] } {
  const lines: PLine[] = [];
  const broughtForward: PLine[] = [];
  let lastY1 = afterY;
  for (let i = startIdx; i < page.lines.length; i++) {
    const l = page.lines[i];
    if ((l.y0 + l.y1) / 2 < afterY) continue;
    if (BROUGHT_FORWARD_RE.test(l.text)) {
      broughtForward.push(l);
      lastY1 = l.y1;
      continue;
    }
    if (isStopLine(l)) return { lines, stop: l, broughtForward };
    if (lines.length && l.y0 - lastY1 > 7 * page.medH) break;
    lines.push(l);
    lastY1 = Math.max(lastY1, l.y1);
  }
  return { lines, broughtForward };
}

/**
 * Moves the boundary between adjacent columns into a whitespace gutter of the body
 * (headers are often centred over left-aligned text or right-aligned numbers). Among the
 * candidate gutters, the one that best agrees with "each word belongs to its nearest header"
 * wins; ties go to the widest gutter.
 */
function refineBoundaries(page: PPage, cols: TableColumn[], body: PLine[]) {
  const words = body.flatMap(realWords);
  if (!words.length) return;
  const dist = (x: number, c: TableColumn) => (x < (c.hx0 ?? c.x0) ? (c.hx0 ?? c.x0) - x : x > (c.hx1 ?? c.x1) ? x - (c.hx1 ?? c.x1) : 0);
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i];
    const b = cols[i + 1];
    const lo = ((a.hx0 ?? a.x0) + (a.hx1 ?? a.x1)) / 2;
    const hi = ((b.hx0 ?? b.x0) + (b.hx1 ?? b.x1)) / 2;
    if (hi <= lo) continue;
    const step = 2;
    const n = Math.ceil((hi - lo) / step);
    const cov = new Array<number>(n).fill(0);
    for (const w of words) {
      const s0 = Math.max(0, Math.floor((w.x0 - lo) / step));
      const e0 = Math.min(n - 1, Math.floor((w.x1 - lo) / step));
      for (let k = s0; k <= e0; k++) cov[k]++;
    }
    const min = Math.min(...cov);
    const runs: Array<{ s: number; len: number }> = [];
    for (let k = 0; k < n; ) {
      if (cov[k] !== min) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < n && cov[e + 1] === min) e++;
      runs.push({ s: k, len: e - k + 1 });
      k = e + 1;
    }
    const between = words.filter((w) => xCenter(w) > lo && xCenter(w) < hi);
    let best: { boundary: number; bad: number; len: number } | null = null;
    for (const r of runs) {
      const boundary = lo + (r.s + r.len / 2) * step;
      let bad = 0;
      for (const w of between) {
        const x = xCenter(w);
        const nearA = dist(x, a) <= dist(x, b);
        if (nearA !== x < boundary) bad++;
      }
      if (!best || bad < best.bad || (bad === best.bad && r.len > best.len)) best = { boundary, bad, len: r.len };
    }
    if (!best) continue;
    a.x1 = best.boundary;
    b.x0 = best.boundary;
  }
  cols[0].x0 = Math.min(cols[0].x0, ...words.map((w) => w.x0)) - 1;
  cols[cols.length - 1].x1 = Math.max(cols[cols.length - 1].x1, page.width);
}

function columnIndexOf(cols: TableColumn[], w: PWord): number {
  const x = xCenter(w);
  for (let i = 0; i < cols.length; i++) if (x >= cols[i].x0 && x < cols[i].x1) return i;
  if (x < cols[0].x0) return 0;
  return cols.length - 1;
}

const isNumeric = (w: PWord) => !!parseNumber(w.text, { ocrFix: false });

/** Splits a column that contains two separate numeric clusters into a labeled and an unlabeled column. */
function splitHiddenColumns(page: PPage, cols: TableColumn[], body: PLine[]): TableColumn[] {
  const out: TableColumn[] = [];
  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci];
    const ws = body.flatMap(realWords).filter((w) => columnIndexOf(cols, w) === ci);
    if (ws.length < 2) {
      out.push(col);
      continue;
    }
    // x-clusters of word extents
    const sorted = [...ws].sort((a, b) => a.x0 - b.x0);
    const clusters: PWord[][] = [];
    let end = -Infinity;
    for (const w of sorted) {
      const last = clusters[clusters.length - 1];
      if (!last || w.x0 - end > 0.8 * page.medH) {
        clusters.push([w]);
        end = w.x1;
      } else {
        last.push(w);
        end = Math.max(end, w.x1);
      }
    }
    const span = (c: PWord[]) => ({ x0: Math.min(...c.map((w) => w.x0)), x1: Math.max(...c.map((w) => w.x1)) });
    const head = { x0: col.hx0 ?? col.x0, x1: col.hx1 ?? col.x1 };
    if (clusters.length < 2) {
      out.push(col);
      continue;
    }
    const owner = clusters.reduce((best, c) => (overlap(span(c), head) > overlap(span(best), head) ? c : best));
    // a cluster away from the header that holds only numbers on several rows is a column of its own
    const rowsOf = (c: PWord[]) => new Set(c.map((w) => w.line)).size;
    const isHidden = (c: PWord[]) => c !== owner && overlap(span(c), head) <= 0 && rowsOf(c) >= 2 && c.filter(isNumeric).length >= 0.8 * c.length;
    if (overlap(span(owner), head) <= 0 || !clusters.some(isHidden)) {
      out.push(col);
      continue;
    }
    // merge non-hidden clusters into their neighbours, keep hidden ones separate
    const pieces: Array<{ c: PWord[]; s: { x0: number; x1: number }; hidden: boolean }> = [];
    for (const c of clusters.map((cl) => cl).sort((a, b) => span(a).x0 - span(b).x0)) {
      const hidden = isHidden(c);
      const prev = pieces[pieces.length - 1];
      if (prev && !hidden && !prev.hidden) {
        prev.c = [...prev.c, ...c];
        prev.s = span(prev.c);
      } else pieces.push({ c, s: span(c), hidden });
    }
    let x0 = col.x0;
    pieces.forEach((p, i) => {
      const x1 = i + 1 < pieces.length ? (p.s.x1 + pieces[i + 1].s.x0) / 2 : col.x1;
      out.push(p.hidden ? { field: null, header: '', x0, x1, inferred: true } : { ...col, x0, x1 });
      x0 = x1;
    });
  }
  return out;
}

/** OCR speckle / row-separator garbage: low-confidence words that carry no usable text. */
const isJunkWord = (w: PWord) => {
  // low-confidence words that still carry data (codes, amounts) are kept and flagged downstream
  if ((w.text.match(/\d/g) ?? []).length >= 3) return false;
  return w.conf < 25 || (w.conf < 45 && !/\d/.test(w.text) && w.text.length <= 2);
};
const isJunkLine = (l: PLine) => {
  const ws = realWords(l);
  return ws.length > 0 && ws.filter((w) => w.conf < 40).length >= 0.7 * ws.length;
};

function splitLine(cols: TableColumn[], line: PLine): PWord[][] {
  const cells: PWord[][] = cols.map(() => []);
  for (const w of realWords(line)) if (!isJunkWord(w)) cells[columnIndexOf(cols, w)].push(w);
  return cells;
}

const SUMMARY_HEAD_RE = /\b(?:TOTALS?|SUB-?TOTALS?|GRAND\s+TOTAL|BREAKDOWN|SUMMARY)\b/i;
const SUMMARY_RE = /\b(?:FREIGHT|INSURANCE|DISCOUNT|HANDLING|PACKING\s+CHARGES?|DUTY|DUTIES|TAX|VAT|SURCHARGE|COMMISSION|TOTAL|SUB-?TOTAL|BALANCE|DEPOSIT|ADVANCE)\b/i;

/**
 * A line below the rows that carries only an amount (no quantity/price) and a charge/total word
 * is part of the summary block, not a continuation of the last row.
 */
function isSummaryLine(cols: TableColumn[], cells: PWord[][], line: PLine): boolean {
  const idx = (f: ColumnField) => cols.findIndex((c) => c.field === f);
  const num = (i: number) => i >= 0 && cells[i].some((w) => !!parseNumber(w.text, { ocrFix: false }));
  // a totals / breakdown heading with a figure in a value column ("VALUE BREAKDOWN … Total 10,200 PRS")
  if (SUMMARY_HEAD_RE.test(line.text) && (['quantity', 'unitPrice', 'amount'] as ColumnField[]).some((f) => num(idx(f)))) return true;
  const amountIdx = idx('amount');
  if (!num(amountIdx) || num(idx('quantity')) || num(idx('unitPrice'))) return false;
  return SUMMARY_RE.test(line.text);
}

/** A pre-row line with letters (and no numbers) in a quantity/price/amount column: a caption such as "FOB BUSAN". */
function isCaptionLine(cols: TableColumn[], cells: PWord[][]): boolean {
  return cols.some(
    (c, i) =>
      !!c.field &&
      ['quantity', 'unitPrice', 'amount'].includes(c.field) &&
      cells[i].some((w) => /[A-Za-z]{2,}/.test(w.text)) &&
      !cells[i].some((w) => /\d/.test(w.text)),
  );
}

/** An "Item"/"No." column that holds codes rather than small integers is a style/article column. */
function relabelCodeColumns(cols: TableColumn[], body: PLine[]) {
  const ci = cols.findIndex((c) => c.field === 'lineNo');
  if (ci < 0 || cols.some((c) => c.field === 'style')) return;
  const vals = body.map((l) => joinWords(splitLine(cols, l)[ci])).filter(Boolean);
  const ints = vals.filter((v) => /^\d{1,4}[.)]?$/.test(v)).length;
  const codes = vals.filter((v) => /[A-Z]/i.test(v) && /\d/.test(v) && v.length >= 4).length;
  if (codes > ints && codes >= 1) cols[ci].field = 'style';
}

const ANCHOR_RE: Partial<Record<ColumnField, RegExp>> = {
  lineNo: /^\d{1,4}[.)]?$/,
  cartonRange: /^\d{1,5}(\s*[-–~/]\s*\d{1,5})?$|^\d{1,5}\s*(?:TO|-)\s*\d{1,5}$/i,
  style: /^(?=.*\d)[A-Z0-9][A-Z0-9\-/.#]{2,}/i,
  po: /\d{3,}/,
  hsCode: /^\d{4}[.\s]?\d{2}/,
  description: /[A-Za-z]{3,}/,
};

function anchorValid(field: ColumnField, words: PWord[]): boolean {
  const text = joinWords(words).replace(/\s*-\s*/g, '-');
  if (!text) return false;
  const re = ANCHOR_RE[field];
  return re ? re.test(text) : /[A-Za-z0-9]/.test(text);
}

/**
 * Extracts the item table of a document. Tables spanning pages are handled through
 * repeated headers, or by reusing the previous page's columns after a "continued" footer.
 */
export function extractTable(doc: PDoc, spec: TableSpec): TableResult {
  const res: TableResult = { found: false, pages: [], rows: [], warnings: [] };
  let prevCols: TableColumn[] | null = null;
  let continued = false;
  for (const page of doc.pages) {
    const header = findHeader(page, spec);
    let cols: TableColumn[];
    let headerLines: PLine[] = [];
    let afterY: number;
    let startIdx: number;
    if (header) {
      cols = header.columns.map((c) => ({ ...c }));
      headerLines = header.lines;
      afterY = Math.max(...header.lines.map((l) => l.y1));
      startIdx = header.lines[header.lines.length - 1].index + 1;
    } else if (prevCols && continued) {
      cols = prevCols.map((c) => ({ ...c }));
      afterY = 0;
      startIdx = 0;
    } else continue;
    const body = bodyLines(page, afterY, startIdx);
    body.lines = body.lines.filter((l) => !isJunkLine(l));
    if (header) {
      refineBoundaries(page, cols, body.lines);
      cols = splitHiddenColumns(page, cols, body.lines);
      relabelCodeColumns(cols, body.lines);
    }
    const anchorField = spec.anchors.find((a) => cols.some((c) => c.field === a));
    const anchorIdx = anchorField ? cols.findIndex((c) => c.field === anchorField) : -1;
    const numericIdx = cols
      .map((c, i) => (c.field && ['quantity', 'amount', 'unitPrice'].includes(c.field) ? i : -1))
      .filter((i) => i >= 0);
    const valueIdx = cols
      .map((c, i) => (c.field && ['quantity', 'amount', 'unitPrice', 'cartons', 'pcsPerCarton', 'netWeight', 'grossWeight'].includes(c.field) ? i : -1))
      .filter((i) => i >= 0);
    const hasNum = (cells: PWord[][], i: number) => cells[i].some((w) => /\d/.test(w.text) && !!parseNumber(w.text));
    let current: TableRow | null = null;
    let stopEarly: PLine | undefined;
    let pending: PLine[] = [];
    const rowsBefore = res.rows.length;
    for (const line of body.lines) {
      const cells = splitLine(cols, line);
      let starts = false;
      if (anchorIdx >= 0) {
        starts = cells[anchorIdx].length > 0 && anchorValid(anchorField!, cells[anchorIdx]);
        // a description-only anchor starts a row only together with row values (else it is a detail line)
        if (starts && anchorField === 'description') starts = valueIdx.some((i) => hasNum(cells, i));
      } else starts = numericIdx.some((i) => cells[i].some(isNumeric));
      // the anchor was lost by OCR but the line repeats a full set of row values: it is a new row
      if (!starts && current && (anchorIdx < 0 || !cells[anchorIdx].length)) {
        const filled = valueIdx.filter((i) => hasNum(cells, i));
        const already = filled.filter((i) => current!.cells[i].some((ws) => ws.some((w) => /\d/.test(w.text))));
        if (filled.length >= 2 && already.length >= 2) starts = true;
      }
      // a charge/total line between the last row and the totals ("Freight: 350.00") ends the table
      if (!starts && current && isSummaryLine(cols, cells, line)) {
        stopEarly = line;
        break;
      }
      // without a table header on this page, skip prose until the first real row
      if (!header && !current && !starts) continue;
      if (starts) {
        // a group caption above the first row ("HOUSEHOLD APPLIANCES … FOB BUSAN") is not part of it:
        // it carries words in a price/amount/quantity column, which a row's own wrapped text never does
        const lastCaption = pending.map((p) => isCaptionLine(cols, splitLine(cols, p))).lastIndexOf(true);
        if (lastCaption >= 0) pending = pending.slice(lastCaption + 1);
        current = { page: page.page, lines: [...pending, line], cells: cols.map((_, i) => [...pending.map((p) => splitLine(cols, p)[i]), cells[i]]), columns: cols };
        pending = [];
        res.rows.push(current);
      } else if (current) {
        current.lines.push(line);
        cells.forEach((c, i) => current!.cells[i].push(c));
      } else pending.push(line);
    }
    if (res.rows.length === rowsBefore && !header) continue;
    res.found = true;
    const stop = stopEarly ?? body.stop;
    res.pages.push({
      page: page.page,
      columns: cols,
      headerLines,
      stopLine: stop,
      stopCells: stop ? splitLine(cols, stop) : undefined,
      broughtForward: body.broughtForward,
    });
    prevCols = cols;
    continued = !stop || /CONTINUED|CARRIED\s+FORWARD|C\/F\b/i.test(stop.text);
  }
  if (!res.found) res.warnings.push('item table header not found');
  inferHiddenColumns(res);
  return res;
}

/**
 * Names unlabeled numeric columns from arithmetic: U × pcs/ctn = total pcs → cartons,
 * qty × U = amount → unit price, U × price = amount → quantity, cartons × U = total → pcs/ctn.
 */
function inferHiddenColumns(res: TableResult) {
  for (const page of res.pages) {
    const cols = page.columns;
    const rows = res.rows.filter((r) => r.page === page.page);
    const valueOf = (r: TableRow, ci: number): number | undefined => {
      for (const ws of r.cells[ci] ?? []) {
        if (!ws.length) continue;
        const p = parseNumber(ws[0].text);
        if (p) return p.value;
      }
      return undefined;
    };
    const idx = (f: ColumnField) => cols.findIndex((c) => c.field === f);
    cols.forEach((c, ci) => {
      if (c.field || !c.inferred) return;
      const hypotheses: Array<[ColumnField, (u: number, r: TableRow) => boolean | undefined]> = [
        ['cartons', (u, r) => {
          const checks: boolean[] = [];
          const pairs: Array<[ColumnField, ColumnField]> = [['pcsPerCarton', 'quantity'], ['netWeightPerCarton', 'netWeight'], ['grossWeightPerCarton', 'grossWeight']];
          for (const [per, tot] of pairs) {
            const a = idx(per) >= 0 ? valueOf(r, idx(per)) : undefined;
            const b = idx(tot) >= 0 ? valueOf(r, idx(tot)) : undefined;
            if (a !== undefined && b !== undefined) checks.push(Math.abs(u * a - b) <= 0.011 * Math.max(1, b));
          }
          return checks.length ? checks.some(Boolean) : undefined;
        }],
        ['unitPrice', (u, r) => {
          const q = idx('quantity') >= 0 ? valueOf(r, idx('quantity')) : undefined;
          const a = idx('amount') >= 0 ? valueOf(r, idx('amount')) : undefined;
          return q !== undefined && a !== undefined ? Math.abs(q * u - a) <= 0.011 * Math.max(1, a) : undefined;
        }],
        ['quantity', (u, r) => {
          const p = idx('unitPrice') >= 0 ? valueOf(r, idx('unitPrice')) : undefined;
          const a = idx('amount') >= 0 ? valueOf(r, idx('amount')) : undefined;
          return p !== undefined && a !== undefined ? Math.abs(u * p - a) <= 0.011 * Math.max(1, a) : undefined;
        }],
        ['pcsPerCarton', (u, r) => {
          const k = idx('cartons') >= 0 ? valueOf(r, idx('cartons')) : undefined;
          const t = idx('quantity') >= 0 ? valueOf(r, idx('quantity')) : undefined;
          return k !== undefined && t !== undefined ? Math.abs(k * u - t) <= 0.011 * Math.max(1, t) : undefined;
        }],
      ];
      for (const [field, test] of hypotheses) {
        if (idx(field) >= 0) continue;
        let ok = 0;
        let tested = 0;
        for (const r of rows) {
          const u = valueOf(r, ci);
          if (u === undefined) continue;
          const t = test(u, r);
          if (t === undefined) continue;
          tested++;
          if (t) ok++;
        }
        if (tested >= 1 && ok >= Math.max(1, Math.ceil(0.6 * tested))) {
          c.field = field;
          c.header = `(${field}, inferred)`;
          break;
        }
      }
    });
  }
}

/** Index of the column holding a field in a row (-1 when absent). */
export function colIndex(row: TableRow, field: ColumnField): number {
  return row.columns.findIndex((c) => c.field === field);
}

/** Text of a field's cell on the row's first line that has one (or on line `lineIdx`). */
export function cellText(row: TableRow, field: ColumnField, lineIdx?: number): string {
  const ci = colIndex(row, field);
  if (ci < 0) return '';
  if (lineIdx !== undefined) return joinWords(row.cells[ci][lineIdx] ?? []);
  for (const ws of row.cells[ci]) if (ws.length) return joinWords(ws);
  return '';
}

/** Words of a field's first non-empty cell line. */
export function cellWords(row: TableRow, field: ColumnField): PWord[] {
  const ci = colIndex(row, field);
  if (ci < 0) return [];
  for (const ws of row.cells[ci]) if (ws.length) return ws;
  return [];
}

/** Every non-empty line of a column within the row. */
export function cellLines(row: TableRow, colIdx: number): Array<{ text: string; words: PWord[] }> {
  return (row.cells[colIdx] ?? []).filter((ws) => ws.length).map((ws) => ({ text: joinWords(ws), words: ws }));
}

/** Text of the whole row (all lines, all columns) for keyword scans. */
export function rowText(row: TableRow): string {
  return row.lines.map((l) => l.text).join('\n');
}
