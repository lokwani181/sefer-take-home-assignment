/**
 * Merchandise Processing Fee and Harbor Maintenance Fee configuration (data/fees.json, FY2027
 * values verified against the Federal Register) plus the arithmetic T5 needs for estimates.
 */
import type { FeeConfig } from '@app/shared';
import { readDataJson } from './text.js';

interface FeeFile {
  fiscalYear: string;
  effectiveFrom: string;
  effectiveTo: string;
  mpfRate: number;
  mpfMin: number;
  mpfMax: number;
  hmfRate: number;
  sources: Record<string, string>;
  note: string;
}

const FEES = readDataJson<FeeFile>('fees.json');

/** Fee configuration in effect for FY2027 (Oct 1 2026 – Sep 30 2027), with source and caveats in `note`. */
export function feeConfig(): FeeConfig {
  return {
    fiscalYear: FEES.fiscalYear,
    mpfRate: FEES.mpfRate,
    mpfMin: FEES.mpfMin,
    mpfMax: FEES.mpfMax,
    hmfRate: FEES.hmfRate,
    note: `${FEES.note} Effective ${FEES.effectiveFrom} to ${FEES.effectiveTo}. Source: ${FEES.sources.mpf}`,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Formal-entry MPF: ad valorem on total entered value, clamped to the fiscal-year min/max. */
export function computeMpf(enteredValueUsd: number, cfg: FeeConfig = feeConfig()): number {
  if (!(enteredValueUsd > 0)) return 0;
  return round2(Math.min(cfg.mpfMax, Math.max(cfg.mpfMin, enteredValueUsd * cfg.mpfRate)));
}

/** HMF: 0.125% of value, vessel shipments only (19 CFR 24.24). */
export function computeHmf(enteredValueUsd: number, isVessel: boolean, cfg: FeeConfig = feeConfig()): number {
  if (!isVessel || !(enteredValueUsd > 0)) return 0;
  return round2(enteredValueUsd * cfg.hmfRate);
}
