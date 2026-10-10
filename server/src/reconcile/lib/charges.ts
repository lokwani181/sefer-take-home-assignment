/** Charge classification: parsers may leave a charge as 'other'; its description usually says what it is. */
import type { Charge, ChargeType } from '@app/shared';

const RULES: [RegExp, ChargeType][] = [
  [/insur/i, 'insurance'],
  [/\bdut(?:y|ies)\b|customs (?:fees?|clearance)|\btariffs?\b|\bMPF\b|\bHMF\b|import tax/i, 'duty'],
  [/(?:inland|delivery|trucking|drayage)[^,;]*\b(?:US|U\.S\.|USA|destination)\b|\b(?:US|U\.S\.|USA|destination)\b[^,;]*(?:inland|delivery|trucking|drayage)|door delivery/i, 'inland_freight_us'],
  [/freight|shipping|carriage|transport/i, 'freight'],
  [/packing|packaging/i, 'packing'],
  [/commission/i, 'commission'],
  [/discount|rebate|allowance/i, 'discount'],
];

/** The charge's type, inferred from its description when the parser could only say 'other'. */
export function chargeKind(c: Charge): ChargeType {
  if (c.type !== 'other') return c.type;
  const d = c.description ?? '';
  return RULES.find(([re]) => re.test(d))?.[1] ?? 'other';
}

/** Copy of the charges with 'other' types resolved from their descriptions. */
export const normalizeCharges = (charges: Charge[] | undefined): Charge[] => (charges ?? []).map((c) => ({ ...c, type: chargeKind(c) }));
