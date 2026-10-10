/**
 * Duty and fee ESTIMATES for the broker's orientation. NetCHB/ACE compute the
 * authoritative amounts; Chapter 99 measures and the cotton fee are not included.
 */
import type { Estimates, FeeConfig, LineEstimate } from '@app/shared';
import { round2 } from './normalize';

export interface EstimateLineInput {
  lineId: string;
  htsNumber: string;
  /** Entered value in USD (undefined when the invoice currency could not be converted). */
  enteredValueUsd?: number;
  /** Entered value as emitted (invoice currency). */
  enteredValue: number;
  ratePct?: number;
}

export interface EstimateInput {
  lines: EstimateLineInput[];
  fees: FeeConfig;
  ocean: boolean;
  /** Currencies whose lines could not be converted to USD (excluded from totals). */
  unconvertedCurrencies: string[];
}

/** Computes per-line duty, MPF (clamped) and HMF (ocean only) on the USD lines. */
export function computeEstimates(input: EstimateInput): Estimates {
  const lines: LineEstimate[] = input.lines.map((l) => ({
    lineId: l.lineId,
    htsNumber: l.htsNumber,
    enteredValue: l.enteredValue,
    ratePct: l.ratePct,
    duty:
      l.ratePct !== undefined && l.enteredValueUsd !== undefined ? round2((l.enteredValueUsd * l.ratePct) / 100) : undefined,
  }));
  const totalDuty = round2(lines.reduce((s, l) => s + (l.duty ?? 0), 0));
  const totalUsd = input.lines.reduce((s, l) => s + (l.enteredValueUsd ?? 0), 0);
  const { mpfRate, mpfMin, mpfMax, hmfRate } = input.fees;
  const mpf = totalUsd > 0 ? round2(Math.min(Math.max(totalUsd * mpfRate, mpfMin), mpfMax)) : 0;
  const hmf = input.ocean && totalUsd > 0 ? round2(totalUsd * hmfRate) : 0;

  const notes = [
    'Estimates only: NetCHB/ACE calculate the authoritative duties and fees.',
    'Chapter 99 additional duties (e.g. reciprocal/IEEPA, Section 122/232/301 measures) are NOT included.',
    'Cotton fee (Cotton Research & Promotion assessment) is NOT included; NetCHB computes it.',
    `MPF ${(mpfRate * 100).toFixed(4)}% (min ${mpfMin.toFixed(2)}, max ${mpfMax.toFixed(2)})${
      input.ocean ? `; HMF ${(hmfRate * 100).toFixed(3)}% (vessel shipments only)` : '; HMF not applicable (not a vessel shipment)'
    }. Fee table ${input.fees.fiscalYear}: ${input.fees.note}`,
  ];
  const noRate = lines.filter((l) => l.ratePct === undefined).map((l) => l.lineId);
  if (noRate.length) notes.push(`No ad valorem rate known for ${noRate.join(', ')}: duty not estimated for those lines.`);
  if (input.unconvertedCurrencies.length)
    notes.push(
      `Lines invoiced in ${input.unconvertedCurrencies.join(', ')} are excluded from duty/MPF/HMF estimates: no exchange rate was provided (NetCHB converts at the CBP rate).`,
    );
  return { lines, totalDuty, mpf, hmf, notes };
}
