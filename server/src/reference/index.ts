/**
 * T4 reference module: deterministic HTS classification against the live USITC tree (cached),
 * CBP port codes (Schedule D / Schedule K), ISO countries, US states, MID construction, fees.
 */
import type { ClassifyLineFn, ClassifyOptions, LineClassification, ReferenceLookups, ShipmentLine } from '@app/shared';
import { classifyAsCode, classifyDeclared } from './hts/classify.js';
import { fetchSearchRows } from './hts/client.js';
import { classifyBySearch } from './hts/search.js';
import { cleanHtml, findNode, formatHts, getHeadingTree, mapUnits, parseRate, type HtsNode } from './hts/tree.js';
import { countryCode } from './countries.js';
import { feeConfig } from './fees.js';
import { buildMid } from './mid.js';
import { foreignPortCode, portCountry, usPortCode } from './ports.js';
import { usStateCode } from './states.js';

export type { HtsNode } from './hts/tree.js';
export type { ClassificationFlag, ClassificationFlagCode } from './hts/classify.js';
export { configureHtsClient } from './hts/client.js';
export { iso6346CheckDigit, isValidContainerNumber } from './iso6346.js';
export { computeHmf, computeMpf } from './fees.js';
export { mapUnit, mapUnits, parseRate, textileCategory, formatHts } from './hts/tree.js';
export { countryCode, usStateCode, usPortCode, foreignPortCode, portCountry, buildMid, feeConfig };

/**
 * Classify one shipment line to a 10-digit HTS number.
 * Declared code (≥ 4 digits): walk the USITC tree under it. No declared code: keyword search,
 * confidence 'low'. `opts.composition` re-classifies under an alternative fibre composition.
 */
export const classifyLine: ClassifyLineFn = async (line: ShipmentLine, opts?: ClassifyOptions): Promise<LineClassification> => {
  const declared = (line.hsCodeDeclared ?? '').replace(/\D/g, '');
  if (declared.length >= 4) {
    const res = await classifyDeclared(line, declared, opts?.composition);
    if (res) return res;
    const fallback: LineClassification = {
      lineId: line.id,
      htsNumber: declared.slice(0, 10),
      htsFormatted: formatHts(declared),
      description: '',
      units: [],
      confidence: 'low',
      rationale: `HTS data for heading ${declared.slice(0, 4)} is unavailable (offline and not cached, or the heading does not exist). The declared code ${formatHts(declared)} is passed through unverified; no statistical suffix was invented.`,
      alternatives: [],
      basis: 'declared',
      flags: [{ code: 'HTS_DATA_UNAVAILABLE', message: `Heading ${declared.slice(0, 4)} not available.` }],
    };
    return fallback;
  }
  return classifyBySearch(line, opts?.composition);
};

/**
 * Classification for an HTS number the broker chose (decision `hts:<lineId>`), so the XML gets
 * that code's units, rate and textile category. Low-confidence pass-through if the code is unknown.
 */
export async function classifyAsHts(line: ShipmentLine, htsNumber: string): Promise<LineClassification> {
  const res = await classifyAsCode(line, htsNumber);
  if (res) return res;
  const digits = htsNumber.replace(/\D/g, '');
  return {
    lineId: line.id,
    htsNumber: digits,
    htsFormatted: formatHts(digits),
    description: '',
    units: [],
    confidence: 'low',
    rationale: `Broker-selected ${formatHts(digits)} was not found in the HTS data available (offline or not a valid number); passed through unverified.`,
    alternatives: [],
    basis: 'user',
  };
}

/** Synchronous reference lookups injected into assembly (T5). */
export const lookups: ReferenceLookups = {
  usPortCode,
  foreignPortCode,
  portCountry,
  countryCode,
  usStateCode,
  buildMid,
  feeConfig,
};

/**
 * The HTS subtree for a code (4–10 digits, dots optional), including unnumbered parent rows,
 * with inherited general rate, NetCHB units and textile categories. Null if unavailable.
 */
export async function getHtsSubtree(code: string): Promise<HtsNode | null> {
  const digits = code.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const root = await getHeadingTree(digits.slice(0, 4));
  if (!root) return null;
  const found = findNode(root, digits);
  return found && found.exact ? found.node : null;
}

export interface HtsSearchHit {
  htsno: string;
  /** 10 digits for statistical lines, otherwise the digits as published. */
  htsNumber: string;
  description: string;
  indent: number;
  generalRate?: string;
  adValoremPct?: number;
  units: string[];
}

/** USITC keyword search (cached). Results omit unnumbered parents; use for candidate discovery only. */
export async function searchHts(keyword: string): Promise<HtsSearchHit[]> {
  const rows = (await fetchSearchRows(keyword)) ?? [];
  return rows
    .filter((r) => r.htsno)
    .map((r) => {
      const digits = r.htsno.replace(/\D/g, '');
      const general = cleanHtml(r.general) || undefined;
      return {
        htsno: r.htsno,
        htsNumber: digits,
        description: cleanHtml(r.description),
        indent: Number(r.indent) || 0,
        generalRate: general,
        adValoremPct: parseRate(general).adValoremPct,
        units: mapUnits(r.units),
      };
    });
}
