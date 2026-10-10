/** Fibre-content comparison. Textiles are classified by the fibre that predominates by weight. */
import type { Fiber } from '@app/shared';

const ALIASES: Record<string, string> = {
  COTTON: 'cotton', CO: 'cotton', CTN: 'cotton',
  POLYESTER: 'polyester', POLY: 'polyester', PES: 'polyester', PET: 'polyester', PE: 'polyester',
  ELASTANE: 'elastane', SPANDEX: 'elastane', LYCRA: 'elastane', EA: 'elastane', EL: 'elastane',
  NYLON: 'nylon', POLYAMIDE: 'nylon', PA: 'nylon',
  VISCOSE: 'viscose', RAYON: 'viscose', MODAL: 'viscose', LYOCELL: 'viscose', TENCEL: 'viscose', CV: 'viscose',
  WOOL: 'wool', WO: 'wool', MERINO: 'wool', CASHMERE: 'wool',
  LINEN: 'linen', FLAX: 'linen', LI: 'linen',
  SILK: 'silk', SE: 'silk',
  ACRYLIC: 'acrylic', PAN: 'acrylic',
};

export function normFiber(f: string): string {
  const k = f.toUpperCase().replace(/[^A-Z]/g, '');
  return ALIASES[k] ?? f.toLowerCase();
}

/** Fibre → pct, aliases folded and duplicates summed. */
export function fiberMap(list: Fiber[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of list ?? []) {
    if (!f || typeof f.pct !== 'number') continue;
    const k = normFiber(f.fiber);
    m.set(k, (m.get(k) ?? 0) + f.pct);
  }
  return m;
}

/** The single fibre with the highest share, or undefined on a tie for first place. */
export function predominantFiber(list: Fiber[] | undefined): { fiber: string; pct: number } | undefined {
  const entries = [...fiberMap(list).entries()].sort((a, b) => b[1] - a[1]);
  if (!entries.length) return undefined;
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return undefined;
  return { fiber: entries[0][0], pct: entries[0][1] };
}

export interface CompositionComparison {
  conflict: boolean;
  predominantA?: { fiber: string; pct: number };
  predominantB?: { fiber: string; pct: number };
  predominantDiffers: boolean;
  /** Largest absolute percentage-point difference over all fibres (missing = 0). */
  maxDiff: number;
  maxDiffFiber?: string;
}

/** Conflict = different predominant fibre, or any fibre differing by ≥ `threshold` points. */
export function compareCompositions(a: Fiber[] | undefined, b: Fiber[] | undefined, threshold = 10): CompositionComparison {
  const ma = fiberMap(a);
  const mb = fiberMap(b);
  const predominantA = predominantFiber(a);
  const predominantB = predominantFiber(b);
  let maxDiff = 0;
  let maxDiffFiber: string | undefined;
  for (const k of new Set([...ma.keys(), ...mb.keys()])) {
    const d = Math.abs((ma.get(k) ?? 0) - (mb.get(k) ?? 0));
    if (d > maxDiff) {
      maxDiff = d;
      maxDiffFiber = k;
    }
  }
  const predominantDiffers = !!predominantA && !!predominantB && predominantA.fiber !== predominantB.fiber;
  const comparable = ma.size > 0 && mb.size > 0;
  return {
    conflict: comparable && (predominantDiffers || maxDiff >= threshold),
    predominantA,
    predominantB,
    predominantDiffers,
    maxDiff,
    maxDiffFiber,
  };
}

/** "60% cotton / 40% polyester" */
export function fmtComposition(list: Fiber[] | undefined): string {
  return (list ?? []).map((f) => `${f.pct}% ${normFiber(f.fiber)}`).join(' / ') || 'unknown';
}

const MAN_MADE = new Set(['polyester', 'nylon', 'acrylic', 'elastane', 'viscose']);

/** Fibre family used by the tariff: cotton | wool | man-made fibres | … */
export function fiberFamily(fiber: string): string {
  const f = normFiber(fiber);
  if (MAN_MADE.has(f)) return 'man-made fibres';
  return f;
}

export const hasCotton = (list: Fiber[] | undefined): boolean => (fiberMap(list).get('cotton') ?? 0) > 0;
