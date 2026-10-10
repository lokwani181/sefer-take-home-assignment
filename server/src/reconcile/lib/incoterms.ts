/** Incoterm groups and the costs each one puts inside the invoice price. */

/** Normalize spellings: "C&F"/"CNF" → CFR, lower case → upper. */
export function normIncoterm(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.toUpperCase().replace(/[^A-Z&+]/g, '');
  if (c === 'C&F' || c === 'CNF' || c === 'C+F' || c === 'CANDF') return 'CFR';
  return c || undefined;
}

/** Terms where the price stops at (or before) loading on the international carrier. */
export const FOB_LIKE = new Set(['EXW', 'FCA', 'FAS', 'FOB']);
/** Terms whose price includes main international freight. */
export const FREIGHT_INCLUDED = new Set(['CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DAT', 'DDP', 'DDU', 'DES', 'DEQ']);
/** Terms whose price includes cargo insurance by definition. */
export const INSURANCE_INCLUDED = new Set(['CIF', 'CIP']);
/** Terms whose price includes import duties. */
export const DUTY_INCLUDED = new Set(['DDP']);

export const isFobLike = (code: string | undefined): boolean => !!code && FOB_LIKE.has(code);
export const includesFreight = (code: string | undefined): boolean => !!code && FREIGHT_INCLUDED.has(code);
export const isDTerm = (code: string | undefined): boolean => !!code && code.startsWith('D');
