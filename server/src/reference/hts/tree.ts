/**
 * HTS tree model built from USITC `exportList` rows (which include unnumbered parent rows).
 * Children inherit the general rate and units from the nearest ancestor that states them.
 */
import { fetchHeadingRows, type HtsRow } from './client.js';

export interface HtsNode {
  /** As published, '' for unnumbered parent rows (e.g. "Men's or boys':"). */
  htsno: string;
  /** htsno without dots. */
  digits: string;
  indent: number;
  /** HTML stripped, whitespace collapsed. */
  description: string;
  /** Units as published (HTML stripped). */
  rawUnits: string[];
  /** NetCHB unit-of-measure codes, inherited from the nearest ancestor when the row has none. */
  units: string[];
  /** Rate on this row, if any. */
  ownGeneral?: string;
  /** Rate on this row or the nearest ancestor that has one. */
  general?: string;
  special?: string;
  other?: string;
  /** Textile category number from "(338)". */
  textileCategory?: string;
  /** Ancestor descriptions from the heading down to this node (inclusive). */
  path: string[];
  /** Nearest numbered ancestor-or-self htsno (for unnumbered rows). */
  numberedAncestor?: string;
  children: HtsNode[];
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", cent: '¢' };

/** Strip HTML tags and decode the entities the USITC data uses. */
export function cleanHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/<sup>\s*2\s*<\/sup>/gi, '2')
    .replace(/<sup>\s*3\s*<\/sup>/gi, '3')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_MAP: Record<string, string> = {
  'doz.': 'DOZ',
  doz: 'DOZ',
  kg: 'KG',
  'no.': 'NO',
  no: 'NO',
  'prs.': 'PRS',
  prs: 'PRS',
  'doz. prs.': 'DPR',
  'dpr.': 'DPR',
  m2: 'M2',
  'm²': 'M2',
  m3: 'M3',
  'm³': 'M3',
  m: 'M',
  liters: 'L',
  l: 'L',
  'pf.l.': 'PFL',
  pcs: 'PCS',
  gross: 'GRS',
  t: 'T',
  'tadw': 'ADW',
  'kg cmsc': 'CKG',
  x: 'X',
  thousand: 'THS',
  'thousand units': 'THS',
  carat: 'CAR',
  'ct.': 'CAR',
  g: 'G',
  gm: 'G',
  'gross containers': 'GCN',
  bbl: 'BBL',
  head: 'HD',
  'mc': 'MC',
  'gbq': 'GBQ',
  'kwh': 'KWH',
  'sq.': 'SQ',
};

/**
 * Map a USITC unit string to a NetCHB/ACE unit-of-measure code ("doz." → DOZ, "<u>kg</u>" → KG).
 * Combined strings like "No. and kg" are split by {@link mapUnits}. Unknown units are stripped + uppercased.
 */
export function mapUnit(raw: string): string {
  const s = cleanHtml(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (UNIT_MAP[s] !== undefined) return UNIT_MAP[s];
  const compact = s.replace(/\s+/g, '');
  if (UNIT_MAP[compact] !== undefined) return UNIT_MAP[compact];
  return s.replace(/[^a-z0-9]/g, '').toUpperCase();
}

/** Map a USITC `units` array to NetCHB codes in reporting order, dropping blanks. */
export function mapUnits(raw: (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const r of raw ?? []) {
    for (const part of cleanHtml(r).split(/\s+and\s+/i)) {
      const u = mapUnit(part);
      if (u) out.push(u);
    }
  }
  return out;
}

/** Textile category from the trailing "(338)" of a statistical description. */
export function textileCategory(description: string): string | undefined {
  const all = [...description.matchAll(/\((\d{3})\)/g)];
  return all.length ? all[all.length - 1][1] : undefined;
}

/** "6110.30.30.45" for a 10-digit string. */
export function formatHts(digits: string): string {
  const d = digits.replace(/\D/g, '');
  const parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  return parts.join('.');
}

/** 10-digit number for a leaf: 8-digit leaves get the "00" statistical suffix. */
export function tenDigit(digits: string): string {
  return digits.length >= 10 ? digits.slice(0, 10) : digits.padEnd(10, '0');
}

export interface ParsedRate {
  /** Ad valorem part in percent (16.5 for "16.5%", 0 for "Free"). */
  adValoremPct?: number;
  /** Non-ad-valorem part as published, e.g. "56.3¢/kg". */
  specific?: string;
}

/**
 * Parse a general duty rate: "16.5%" → 16.5, "Free" → 0, "56.3¢/kg + 14.3%" → 14.3 with the
 * specific part kept separately; text rates ("The rate applicable to each garment…") → {}.
 */
export function parseRate(rate: string | undefined): ParsedRate {
  if (!rate) return {};
  const s = cleanHtml(rate);
  if (/^free\b/i.test(s)) return { adValoremPct: 0 };
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/);
  const specificPart = s
    .replace(/\+?\s*\d+(?:\.\d+)?\s*%/, '')
    .replace(/\+\s*$/, '')
    .trim()
    .replace(/^\+\s*/, '')
    .trim();
  const hasSpecific = /\d/.test(specificPart) && /(¢|\$|c\/|cents?|\/kg|each|\/doz|\/liter|\/m)/i.test(specificPart);
  if (!pct) return hasSpecific ? { specific: specificPart } : {};
  return { adValoremPct: Number(pct[1]), ...(hasSpecific ? { specific: specificPart } : {}) };
}

/** Build the tree for a heading from raw rows; rows after the heading's last numbered row are dropped. */
export function buildHeadingTree(heading: string, rows: HtsRow[]): HtsNode | null {
  const keep: HtsRow[] = [];
  let started = false;
  for (const r of rows) {
    const digits = (r.htsno ?? '').replace(/\./g, '');
    if (!started) {
      if (digits === heading) started = true;
      else continue;
    } else if (digits && !digits.startsWith(heading)) {
      break;
    }
    keep.push(r);
  }
  if (keep.length === 0) return null;
  const root = toNode(keep[0], undefined);
  const stack: HtsNode[] = [root];
  for (const r of keep.slice(1)) {
    const indent = Number(r.indent) || 0;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const node = toNode(r, parent);
    parent.children.push(node);
    stack.push(node);
  }
  finalizeUnits(root);
  return root;
}

function toNode(r: HtsRow, parent: HtsNode | undefined): HtsNode {
  const description = cleanHtml(r.description);
  const ownGeneral = cleanHtml(r.general) || undefined;
  const htsno = (r.htsno ?? '').trim();
  return {
    htsno,
    digits: htsno.replace(/\./g, ''),
    indent: Number(r.indent) || 0,
    description,
    rawUnits: (r.units ?? []).map(cleanHtml).filter(Boolean),
    units: mapUnits(r.units),
    ownGeneral,
    general: ownGeneral ?? parent?.general,
    special: cleanHtml(r.special) || parent?.special,
    other: cleanHtml(r.other) || parent?.other,
    textileCategory: textileCategory(description),
    path: [...(parent?.path ?? []), description],
    numberedAncestor: htsno || parent?.numberedAncestor,
    children: [],
  };
}

/** Leaves without units inherit them from the nearest ancestor that has some. */
function finalizeUnits(node: HtsNode, inherited: string[] = []): void {
  if (node.units.length === 0 && inherited.length > 0) node.units = [...inherited];
  for (const c of node.children) finalizeUnits(c, node.units.length ? node.units : inherited);
}

const treeMemo = new Map<string, Promise<HtsNode | null>>();

/** Full tree for a 4-digit heading (memoized). Null when the heading is unavailable (offline + uncached, or unknown). */
export function getHeadingTree(heading: string): Promise<HtsNode | null> {
  let p = treeMemo.get(heading);
  if (!p) {
    p = fetchHeadingRows(heading).then((rows) => (rows ? buildHeadingTree(heading, rows) : null));
    treeMemo.set(heading, p);
  }
  return p;
}

/** Clear memoized trees (tests that reconfigure the client). */
export function clearTreeMemo(): void {
  treeMemo.clear();
}

/** Depth-first list of nodes. */
export function walk(node: HtsNode, out: HtsNode[] = []): HtsNode[] {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

/** True for nodes with no children (statistical leaves, or 8/10-digit lines without breakouts). */
export function isLeaf(node: HtsNode): boolean {
  return node.children.length === 0;
}

/**
 * The node for a code inside a heading tree: the first (shallowest) node whose digits start with
 * the code. Returns the parent chain too. If no node matches exactly, the deepest matching
 * prefix (≥ 4 digits) is returned with `exact: false`.
 */
export function findNode(root: HtsNode, code: string): { node: HtsNode; chain: HtsNode[]; exact: boolean } | null {
  const digits = code.replace(/\D/g, '');
  if (digits.length < 4) return null;
  for (let len = digits.length; len >= 4; len--) {
    const want = digits.slice(0, len);
    const hit = findFirst(root, want, []);
    if (hit) return { ...hit, exact: len === digits.length };
  }
  return null;
}

function findFirst(node: HtsNode, want: string, chain: HtsNode[]): { node: HtsNode; chain: HtsNode[] } | null {
  if (node.digits && node.digits.startsWith(want)) return { node, chain };
  // Prune: a numbered node whose digits are not a prefix of `want` cannot contain it.
  if (node.digits && !want.startsWith(node.digits)) return null;
  for (const c of node.children) {
    const hit = findFirst(c, want, [...chain, node]);
    if (hit) return hit;
  }
  return null;
}
