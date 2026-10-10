/** Unit normalization for quantity and package comparisons across documents. */

const PIECE_UNITS = new Set([
  '', 'PC', 'PCS', 'PCE', 'PCES', 'PIECE', 'PIECES', 'EA', 'EACH', 'UNIT', 'UNITS', 'NO', 'NOS', 'NMB', 'U', 'UN', 'ITEM', 'ITEMS',
]);
const DOZEN_UNITS = new Set(['DZ', 'DOZ', 'DOZEN', 'DOZENS']);
const SAME_COUNT_UNITS = new Set(['SET', 'SETS', 'PR', 'PRS', 'PAIR', 'PAIRS']);

/**
 * How many packing-list pieces one invoice unit represents: PCS → 1, DOZ → 12.
 * Sets/pairs compare 1:1 (packing lists count the selling unit); weights/lengths are not comparable.
 */
export function piecesPerUnit(unit: string | undefined): number | undefined {
  const u = (unit ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (PIECE_UNITS.has(u)) return 1;
  if (DOZEN_UNITS.has(u)) return 12;
  if (SAME_COUNT_UNITS.has(u)) return 1;
  return undefined;
}

export type PackageKind = 'carton' | 'pallet' | 'bale' | 'bag' | 'roll' | 'drum' | 'crate' | 'generic';

/** Coarse package family so "138 CTNS" and "138 CARTONS" compare, but cartons vs pallets don't. */
export function packageKind(unit: string | undefined): PackageKind {
  const u = (unit ?? '').toUpperCase();
  if (/CART|CTN|\bCT\b|BOX|CASE|\bCS\b/.test(u)) return 'carton';
  if (/PALLET|PLT|SKID/.test(u)) return 'pallet';
  if (/BALE/.test(u)) return 'bale';
  if (/BAG|SACK/.test(u)) return 'bag';
  if (/ROLL/.test(u)) return 'roll';
  if (/DRUM/.test(u)) return 'drum';
  if (/CRATE/.test(u)) return 'crate';
  return 'generic';
}

export const packageKindsComparable = (a: PackageKind, b: PackageKind): boolean => a === b || a === 'generic' || b === 'generic';
