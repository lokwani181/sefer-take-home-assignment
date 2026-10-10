/**
 * Fibre composition parsing for textile lines.
 *
 * Why: classification (cotton vs man-made fibre headings) depends on it and documents
 * express it in many ways: "60% Cotton 40% Polyester", "98/2 COTTON/SPANDEX",
 * "TC 65/35" (T/C = Tetoron (polyester) / Cotton), "CVC 60/40" (chief value cotton),
 * "100% POLY". Fibre names are normalized (spandex/lycra → elastane, poly → polyester).
 */
import type { Fiber } from '@app/shared';

const FIBER_SYNONYMS: Array<[RegExp, string]> = [
  [/^(?:COTTON|COTTONS|CTN|COTON|BAUMWOLLE|ALGODON|ORGANIC\s+COTTON|PIMA\s+COTTON|SUPIMA)$/i, 'cotton'],
  [/^(?:POLYESTER|POLYESTERS|POLY|PES|PET|POLYSTER|TETORON|TERYLENE|DACRON|RECYCLED\s+POLYESTER|RPET)$/i, 'polyester'],
  [/^(?:ELASTANE|SPANDEX|LYCRA|ELASTHANE|EA|EL|ELASTANE\s+FIBRE)$/i, 'elastane'],
  [/^(?:NYLON|POLYAMIDE|PA|NYLON\s*6|NYLON\s*66)$/i, 'nylon'],
  [/^(?:WOOL|MERINO|LAMBSWOOL|LAMBS\s+WOOL|MERINO\s+WOOL|CASHMERE|ALPACA|MOHAIR|ANGORA|CAMEL\s+HAIR|YAK)$/i, 'wool'],
  [/^(?:VISCOSE|RAYON|MODAL|LYOCELL|TENCEL|CUPRO|BAMBOO|ACETATE|TRIACETATE|VISCOSE\s+RAYON)$/i, 'viscose'],
  [/^(?:LINEN|FLAX|RAMIE|HEMP)$/i, 'linen'],
  [/^(?:SILK|MULBERRY\s+SILK)$/i, 'silk'],
  [/^(?:ACRYLIC|ACRYLICS|MODACRYLIC)$/i, 'acrylic'],
  [/^(?:POLYPROPYLENE|PP|METALLIC|METALLIC\s+FIBRE|LUREX|JUTE|LEATHER|OTHER|OTHERS|OTHER\s+FIBRES?)$/i, 'other'],
];

const FIBER_WORD = '(?:ORGANIC\\s+COTTON|PIMA\\s+COTTON|RECYCLED\\s+POLYESTER|MERINO\\s+WOOL|LAMBS\\s+WOOL|CAMEL\\s+HAIR|VISCOSE\\s+RAYON|MULBERRY\\s+SILK|OTHER\\s+FIBRES?|[A-Z]+)';

/** Normalized fibre name, or undefined when the word is not a fibre. */
export function normalizeFiber(word: string): string | undefined {
  const w = word.trim().replace(/[.,;:]+$/, '');
  for (const [re, name] of FIBER_SYNONYMS) if (re.test(w)) return name;
  return undefined;
}

export interface Composition {
  fibers: Fiber[];
  /** The matched span, verbatim. */
  raw: string;
}

function merge(fibers: Fiber[]): Fiber[] {
  const out: Fiber[] = [];
  for (const f of fibers) {
    const ex = out.find((o) => o.fiber === f.fiber);
    if (ex) ex.pct += f.pct;
    else out.push({ ...f });
  }
  return out;
}

const plausible = (fs: Fiber[]) => {
  const sum = fs.reduce((s, f) => s + f.pct, 0);
  return fs.length > 0 && sum > 0 && sum <= 100.5 && fs.every((f) => f.pct > 0);
};

/**
 * Parses the first fibre composition statement in the text.
 * Returns the fibres (by weight, as stated) and the verbatim span.
 */
export function parseComposition(text: string): Composition | null {
  const t = text.replace(/\s+/g, ' ');
  // 1. Blend codes: TC/T/C/PC/P/C 65/35 (polyester first), CVC 60/40 and C/T (cotton first).
  const blend = /\b(T\s*\/\s*C|TC|P\s*\/\s*C|PC|CVC|C\s*\/\s*T)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%\s*)?\/\s*(\d{1,3}(?:\.\d+)?)\s*%?/i.exec(t);
  if (blend) {
    const code = blend[1].replace(/[\s/]/g, '').toUpperCase();
    const a = Number(blend[2]);
    const b = Number(blend[3]);
    const first = code === 'TC' || code === 'PC' ? 'polyester' : 'cotton';
    const second = first === 'polyester' ? 'cotton' : 'polyester';
    const fibers = merge([
      { fiber: first, pct: a },
      { fiber: second, pct: b },
    ]);
    if (plausible(fibers) && Math.abs(a + b - 100) < 0.6) return { fibers, raw: blend[0].trim() };
  }
  // 2. Ratio form: 98/2 COTTON/SPANDEX, 65/35 POLY/COTTON, 50/30/20 ...
  const ratio = new RegExp(`\\b(\\d{1,3}(?:\\s*\\/\\s*\\d{1,3}){1,3})\\s*%?\\s+(${FIBER_WORD}(?:\\s*\\/\\s*${FIBER_WORD}){1,3})`, 'i').exec(t);
  if (ratio) {
    const nums = ratio[1].split('/').map((n) => Number(n.trim()));
    const names = ratio[2].split('/').map((n) => normalizeFiber(n));
    if (nums.length === names.length && names.every(Boolean)) {
      const fibers = merge(nums.map((pct, i) => ({ fiber: names[i]!, pct })));
      if (plausible(fibers) && Math.abs(nums.reduce((s, n) => s + n, 0) - 100) < 0.6) return { fibers, raw: ratio[0].trim() };
    }
  }
  // 3. Percent pairs: "60% Cotton 40% Polyester", "Cotton 95% / Elastane 5%"
  const pctFirst = new RegExp(`(\\d{1,3}(?:[.,]\\d+)?)\\s*%\\s*(${FIBER_WORD})`, 'gi');
  const pairs: Array<{ pct: number; fiber: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = pctFirst.exec(t))) {
    const fiber = normalizeFiber(m[2]);
    if (fiber) pairs.push({ pct: Number(m[1].replace(',', '.')), fiber, start: m.index, end: m.index + m[0].length });
  }
  if (!pairs.length) {
    const fiberFirst = new RegExp(`(${FIBER_WORD})\\s*(\\d{1,3}(?:[.,]\\d+)?)\\s*%`, 'gi');
    while ((m = fiberFirst.exec(t))) {
      const fiber = normalizeFiber(m[1]);
      if (fiber) pairs.push({ pct: Number(m[2].replace(',', '.')), fiber, start: m.index, end: m.index + m[0].length });
    }
  }
  if (pairs.length) {
    // keep the first run of adjacent pairs (separated only by spaces, commas, slashes, '+', '&', 'and')
    const run = [pairs[0]];
    for (let i = 1; i < pairs.length; i++) {
      const between = t.slice(run[run.length - 1].end, pairs[i].start);
      if (/^[\s,/+&;-]*(?:AND)?[\s,/+&;-]*$/i.test(between)) run.push(pairs[i]);
      else break;
    }
    const fibers = merge(run.map((p) => ({ fiber: p.fiber, pct: p.pct })));
    if (plausible(fibers)) return { fibers, raw: t.slice(run[0].start, run[run.length - 1].end).trim() };
  }
  return null;
}
