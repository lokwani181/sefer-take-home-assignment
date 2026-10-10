/**
 * No declared HS code: discover candidate headings with the USITC keyword search, then classify
 * each candidate heading with the same tree walk and keep the best. Always confidence 'low'.
 */
import type { Fiber, HtsCandidate, LineClassification, ShipmentLine } from '@app/shared';
import { classifyFromHeading } from './classify.js';
import { fetchSearchRows, type HtsRow } from './client.js';
import { buildProfile, contentTokens, describe, evaluate, stripExclusions, type GarmentGroup, type LineProfile } from './features.js';
import { cleanHtml, formatHts, mapUnits, parseRate, tenDigit, textileCategory } from './tree.js';

const GARMENT_QUERY: Record<GarmentGroup, string> = {
  tshirt: 't-shirts', singlet: 'tank tops', top: 'tops', sweater: 'sweaters', sweatshirt: 'sweatshirts', vest: 'vests',
  trousers: 'trousers', shorts: 'shorts', overalls: 'overalls', blouse: 'blouses', shirt: 'shirts', jacket: 'jackets',
  coat: 'anoraks', suit: 'suits', ensemble: 'ensembles', dress: 'dresses', skirt: 'skirts', underwear: 'underpants',
  nightwear: 'pajamas', swimwear: 'swimwear', tracksuit: 'track suits', hosiery: 'hosiery', gloves: 'gloves',
};

const FIBRE_QUERY: Record<string, string> = { cotton: 'cotton', wool: 'wool', mmf: 'man-made', silk: 'silk', flax: 'flax', veg: 'vegetable' };

const QUERY_STOP = new Set(
  'a an and or of the for with without in on to by pcs pc set sets new assorted style item items size sizes colour colours color colors pack packs piece pieces qty total model ref no'.split(' '),
);

/** True when the query starts with the garment term (apparel queries are "<garment> <fibre>"). */
function garmentQuery(q: string): boolean {
  return Object.values(GARMENT_QUERY).some((g) => q === g || q.startsWith(`${g} `));
}

/**
 * Search keywords, most specific first: "<garment> <fibre>" for apparel (e.g. "trousers cotton"),
 * otherwise the leading noun phrase of the description (e.g. "kitchen knives").
 */
export function searchQueries(line: ShipmentLine, profile: LineProfile): string[] {
  const out: string[] = [];
  const garment = [...profile.garments][0];
  if (garment) {
    const term = GARMENT_QUERY[garment];
    const fibre = profile.predominant ? FIBRE_QUERY[profile.predominant] : undefined;
    if (fibre) out.push(`${term} ${fibre}`);
    out.push(term);
  }
  const phrase = line.description.split(/[,;:(\[–—]|\s-\s/)[0];
  const words = phrase
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 1 && !QUERY_STOP.has(w) && !/^(men|women|ladies|boys|girls|mens|womens|unisex)$/.test(w));
  if (words.length) {
    out.push(words.slice(0, 3).join(' '));
    if (words.length > 2) out.push(words.slice(0, 2).join(' '));
    if (words.length > 1) out.push(words[words.length > 3 ? 2 : words.length - 1]);
  }
  return [...new Set(out.map((q) => q.trim()).filter(Boolean))];
}

interface HeadingCandidate {
  heading: string;
  /** Most query words matched by one search row of this heading. */
  rowMatch: number;
  /** Pre-selection rank: rowMatch plus the heading row's fit when the row is in the results. */
  pre: number;
}

/**
 * Rank headings found by the search. rowMatch = most distinct query words found in one row of the
 * heading (the heading row's own words count for every row, since search rows lack their parents).
 * Headings whose heading row contradicts the line (wrong gender, knit vs woven…) are dropped.
 */
export function rankSearchHeadings(rows: HtsRow[], profile: LineProfile, query: string, nounFirst = false): HeadingCandidate[] {
  const qTokens = contentTokens(query);
  const q = new Set(qTokens);
  // The article noun ("knives" in "kitchen knives", "trousers" in "trousers cotton") counts double.
  const noun = new Set(contentTokens(nounFirst ? query.split(/\s+/)[0] : query.split(/\s+/).slice(-1)[0]));
  const by = new Map<string, { rows: string[][]; head?: HtsRow }>();
  for (const r of rows) {
    const digits = (r.htsno ?? '').replace(/\D/g, '');
    if (digits.length < 4 || /^9[89]/.test(digits)) continue;
    const h = digits.slice(0, 4);
    const cur = by.get(h) ?? { rows: [] };
    cur.rows.push(contentTokens(stripExclusions(cleanHtml(r.description).toLowerCase())));
    if (digits.length === 4) cur.head = r;
    by.set(h, cur);
  }
  const out: HeadingCandidate[] = [];
  for (const [heading, v] of by) {
    const headTokens = v.head ? contentTokens(stripExclusions(cleanHtml(v.head.description).toLowerCase())) : [];
    let rowMatch = 0;
    for (const toks of v.rows) {
      const hit = new Set([...toks, ...headTokens].filter((t) => q.has(t)));
      // The noun bonus needs the whole noun ("kitchen" + "ware"), not part of it ("Sanitary ware").
      const fullNoun = noun.size > 0 && [...noun].every((t) => hit.has(t));
      rowMatch = Math.max(rowMatch, [...hit].reduce((a, t) => a + (fullNoun && noun.has(t) ? 2 : 1), 0));
    }
    let headFit = 0;
    if (v.head) {
      const e = evaluate(describe(cleanHtml(v.head.description), heading), profile);
      if (e.rejected) continue;
      headFit = Math.min(1, Math.max(0, e.score));
    }
    if (rowMatch > 0) out.push({ heading, rowMatch, pre: rowMatch + headFit });
  }
  return out.sort((a, b) => b.rowMatch - a.rowMatch || b.pre - a.pre || a.heading.localeCompare(b.heading));
}

const COUNT_UNITS = /^(PCS?|PIECES?|EA|EACH|UNITS?|SETS?|DOZ|DZ|DOZEN|PRS|PAIRS?|NO|NOS|CTNS?)$/i;
const MEASURE_UNITS = /^(KGS?|LBS?|MT|TONS?|M|MTR|MTRS|M2|SQM|YDS?|YARDS?|L|LTRS?|LITERS?)$/i;

/** +1 when the leaf reports in countable units for a line invoiced by the piece; −6 for m²/kg-only leaves (fabrics, yarns). */
export function unitFit(lineUnit: string | undefined, leafUnits: string[]): number {
  if (!lineUnit || leafUnits.length === 0) return 0;
  const first = leafUnits[0];
  const leafCount = /^(DOZ|NO|PCS|PRS|DPR|GRS|THS)$/.test(first);
  if (COUNT_UNITS.test(lineUnit.trim())) return leafCount ? 1 : first === 'X' ? 0 : -6;
  if (MEASURE_UNITS.test(lineUnit.trim())) return leafCount ? -1 : 0;
  return 0;
}

function rowCandidate(r: HtsRow, reason: string): HtsCandidate {
  const digits = (r.htsno ?? '').replace(/\D/g, '');
  const code = tenDigit(digits);
  const desc = cleanHtml(r.description);
  return {
    htsNumber: code,
    htsFormatted: formatHts(code),
    description: desc,
    generalRate: cleanHtml(r.general) || undefined,
    adValoremPct: parseRate(cleanHtml(r.general) || undefined).adValoremPct,
    units: mapUnits(r.units),
    reason,
  };
}

const MAX_HEADINGS = 6;

/** Keyword-search classification; null only if no query returned rows. */
export async function classifyBySearch(line: ShipmentLine, composition?: Fiber[]): Promise<LineClassification> {
  const profile = buildProfile(line, composition);
  const queries = searchQueries(line, profile);
  let rows: HtsRow[] | null = null;
  let used = '';
  for (const q of queries) {
    const r = await fetchSearchRows(q);
    if (r && r.length > 0) {
      rows = r;
      used = q;
      break;
    }
  }
  const none = (msg: string): LineClassification => ({
    lineId: line.id,
    htsNumber: '',
    htsFormatted: '',
    description: '',
    units: [],
    confidence: 'low',
    rationale: msg,
    alternatives: [],
    basis: 'search',
    flags: [{ code: 'NO_CANDIDATE', message: msg }],
  });
  if (!rows) return none(`No HS code declared and the HTS keyword search (${queries.map((q) => `"${q}"`).join(', ') || 'no usable keywords'}) returned nothing (offline or no match). Classify manually.`);

  const headings = rankSearchHeadings(rows, profile, used, garmentQuery(used)).slice(0, MAX_HEADINGS);
  const scored: { result: LineClassification; total: number; heading: string }[] = [];
  for (const h of headings) {
    const r = await classifyFromHeading(line, h.heading, composition);
    if (!r) continue;
    // Heading fit dominates; the walk (whose depth varies by heading) only breaks ties.
    const forced = r.forced;
    const total = 2 * h.rowMatch + r.rootEval.score + 0.25 * r.score + unitFit(line.unit, r.result.units) - (forced ? 50 : 0);
    scored.push({ result: r.result, total, heading: h.heading });
  }
  scored.sort((a, b) => b.total - a.total || a.heading.localeCompare(b.heading));

  if (scored.length === 0) {
    // No candidate heading could be loaded: fall back to the best individual search row.
    const q = new Set([...contentTokens(used), ...profile.tokens]);
    const ranked = rows
      .filter((r) => (r.htsno ?? '').replace(/\D/g, '').length >= 8 && !/^9[89]/.test(r.htsno))
      .map((r) => ({ r, m: contentTokens(cleanHtml(r.description)).filter((t) => q.has(t)).length }))
      .filter((x) => x.m > 0)
      .sort((a, b) => b.m - a.m);
    if (ranked.length === 0) return none(`HTS search "${used}" returned no usable rows. Classify manually.`);
    const [best, ...rest] = ranked;
    const c = rowCandidate(best.r, 'search row');
    return {
      lineId: line.id,
      htsNumber: c.htsNumber,
      htsFormatted: c.htsFormatted,
      description: c.description,
      generalRate: c.generalRate,
      adValoremPct: c.adValoremPct,
      units: c.units ?? [],
      textileCategory: textileCategory(c.description),
      confidence: 'low',
      rationale: `No HS code declared. Search "${used}": best matching row ${c.htsFormatted} "${c.description}" (heading trees unavailable, so the row was not walked; its rate/units may be on a parent). Verify.`,
      alternatives: rest.slice(0, 4).map((x) => rowCandidate(x.r, 'other search row')),
      basis: 'search',
      flags: [{ code: 'HTS_DATA_UNAVAILABLE', message: 'Search row used without its HTS subtree.' }],
    };
  }

  const best = scored[0];
  const others = scored.slice(1, 5).map((s) => ({
    htsNumber: s.result.htsNumber,
    htsFormatted: s.result.htsFormatted,
    description: s.result.description,
    generalRate: s.result.generalRate,
    adValoremPct: s.result.adValoremPct,
    units: s.result.units,
    reason: `Search candidate heading ${s.heading} (score ${s.total.toFixed(1)} vs ${best.total.toFixed(1)}).`,
  }));
  const seen = new Set([best.result.htsNumber]);
  const alternatives = [...others, ...best.result.alternatives].filter((a) => a.htsNumber && !seen.has(a.htsNumber) && seen.add(a.htsNumber)).slice(0, 5);
  return {
    ...best.result,
    confidence: 'low',
    basis: 'search',
    rationale:
      `No HS code declared. Keyword search "${used}" → candidate headings ${headings.map((h) => h.heading).join(', ')}; ` +
      `heading ${best.heading} fits best (score ${best.total.toFixed(1)}). Confirm with the broker.\n` +
      best.result.rationale,
    alternatives,
  };
}
