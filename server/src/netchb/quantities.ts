/**
 * Statistical reporting quantities (tariff quantity1/2 + unit-of-measure1/2) in
 * the units the HTS line requires, derived from the invoice quantity and the
 * packing-list weights.
 */
import { UNITS_OF_MEASURE } from './enums';
import { round2 } from './normalize';

/** Assumed net/gross ratio when only a gross weight is known (documented assumption). */
export const NET_TO_GROSS_RATIO = 0.9;

export interface QuantityContext {
  /** Effective invoice quantity (after decisions). */
  quantity: number;
  /** Invoice unit as printed (PCS, SETS, DOZ, KG…). */
  unit: string;
  netWeightKg?: number;
  /** Line gross weight (actual or prorated). */
  grossWeightKg?: number;
  grossWeightProrated?: boolean;
}

export interface ReportingQuantity {
  uom: string;
  quantity: number;
}

export interface QuantityResult {
  quantities: ReportingQuantity[];
  /** Set when a KG quantity had to be estimated from gross weight. */
  weightAssumption?: string;
  /** Units that could not be derived from the documents. */
  missing: string[];
}

type UnitKind = 'piece' | 'dozen' | 'pair' | 'dozenPair' | 'kg' | 'gram' | 'set' | 'other';

function unitKind(unit: string): UnitKind {
  const u = unit.toUpperCase().replace(/[^A-Z]/g, '');
  if (/^(PCS?|PIECES?|EA|EACH|NOS?|NUMBER|UNITS?|U|ARTICLES?)$/.test(u)) return 'piece';
  if (/^(DOZ|DZ|DZN|DOZENS?)$/.test(u)) return 'dozen';
  if (/^(PRS?|PAIRS?)$/.test(u)) return 'pair';
  if (/^(DPR|DOZENPAIRS?)$/.test(u)) return 'dozenPair';
  if (/^(KGS?|KILOS?|KILOGRAMS?)$/.test(u)) return 'kg';
  if (/^(G|GR|GRAMS?)$/.test(u)) return 'gram';
  if (/^(SETS?)$/.test(u)) return 'set';
  return 'other';
}

/** Count of single articles in the invoice quantity, or undefined if the unit is not a count. */
function pieces(ctx: QuantityContext): number | undefined {
  switch (unitKind(ctx.unit)) {
    case 'piece':
    case 'set':
      return ctx.quantity;
    case 'dozen':
      return ctx.quantity * 12;
    default:
      return undefined;
  }
}

function pairs(ctx: QuantityContext): number | undefined {
  switch (unitKind(ctx.unit)) {
    case 'pair':
      return ctx.quantity;
    case 'dozenPair':
      return ctx.quantity * 12;
    default:
      return undefined;
  }
}

function kilograms(ctx: QuantityContext): { kg?: number; assumption?: string } {
  if (unitKind(ctx.unit) === 'kg') return { kg: ctx.quantity };
  if (ctx.netWeightKg !== undefined && ctx.netWeightKg > 0) return { kg: ctx.netWeightKg };
  if (ctx.grossWeightKg !== undefined && ctx.grossWeightKg > 0) {
    const kg = ctx.grossWeightKg * NET_TO_GROSS_RATIO;
    return {
      kg,
      assumption: `Net weight not on the documents: reported KG = ${ctx.grossWeightProrated ? 'prorated ' : ''}gross weight ${round2(
        ctx.grossWeightKg,
      )} kg × ${NET_TO_GROSS_RATIO} = ${round2(kg)} kg (assumed net/gross ratio).`,
    };
  }
  return {};
}

/** Derives the reporting quantities for the HTS units, e.g. ['DOZ','KG'] → [{DOZ, pcs/12}, {KG, net kg}]. */
export function reportingQuantities(units: string[], ctx: QuantityContext): QuantityResult {
  const quantities: ReportingQuantity[] = [];
  const missing: string[] = [];
  let weightAssumption: string | undefined;
  for (const raw of units) {
    const uom = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!uom || uom === 'X') continue; // X = no quantity reported for this line
    if (!UNITS_OF_MEASURE.has(uom)) {
      missing.push(raw);
      continue;
    }
    let q: number | undefined;
    switch (uom) {
      case 'DOZ': {
        const p = pieces(ctx);
        q = p === undefined ? undefined : p / 12;
        break;
      }
      case 'NO':
      case 'PCS':
        q = pieces(ctx);
        break;
      case 'PRS':
        q = pairs(ctx);
        break;
      case 'DPR': {
        const p = pairs(ctx);
        q = p === undefined ? undefined : p / 12;
        break;
      }
      case 'KG':
      case 'G':
      case 'T': {
        const { kg, assumption } = kilograms(ctx);
        if (kg !== undefined) {
          q = uom === 'KG' ? kg : uom === 'G' ? kg * 1000 : kg / 1000;
          weightAssumption ??= assumption;
        }
        break;
      }
      default:
        // Same unit on the invoice (e.g. M2, L): report the invoice quantity as is.
        if (ctx.unit.toUpperCase().replace(/[^A-Z0-9]/g, '') === uom) q = ctx.quantity;
    }
    if (q === undefined || !Number.isFinite(q)) missing.push(uom);
    else quantities.push({ uom, quantity: round2(q) });
  }
  return { quantities, weightAssumption, missing };
}
