/**
 * Cross-checks a shipment spec beyond what the zod schema can see: the hand-written entered
 * values must match the valuation policy recomputed from the rendered document data, and the
 * expected issue codes must agree with the planted defects (bad arithmetic, bad check digits…).
 */
import { isValidContainer } from './checks.js';
import type { ExpectedShipment } from './expected-schema.js';
import type { ShipmentSpec, ValuationInputs } from './spec.js';

/** Round half away from zero to a whole number (CBP values are whole dollars/units). */
export function roundWhole(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v) + 1e-9);
}

/**
 * Valuation policy used for every synthetic case: line amount, minus non-dutiable charges that
 * are included in the price and minus a granted invoice discount (both prorated by line value),
 * plus assists; rounded per line.
 */
export function computeEnteredValues(v: ValuationInputs): number[] {
  const total = v.lineAmounts.reduce((s, a) => s + a, 0);
  const reduction = v.includedNonDutiableCharges + (v.discount ?? 0);
  return v.lineAmounts.map((amount, i) => {
    const deduction = total > 0 ? (reduction * amount) / total : 0;
    return roundWhole(amount - deduction + (v.assists?.[i] ?? 0));
  });
}

/** Returns human-readable problems; empty when the spec is self-consistent. */
export function checkConsistency(spec: ShipmentSpec, expected: ExpectedShipment): string[] {
  const errs: string[] = [];
  const e = expected.expect;
  const has = (code: string): boolean => (e.issuesInclude as string[]).includes(code);
  const excluded = (code: string): boolean => (e.issuesExclude as string[]).includes(code);

  if (expected.id !== spec.id) errs.push(`expected.id ${expected.id} ≠ spec.id ${spec.id}`);
  const names = spec.docs.map((d) => d.file);
  if (new Set(names).size !== names.length) errs.push('duplicate document file names');

  // Valuation recomputed from the document data vs. the hand-entered numbers.
  if (spec.valuation.lineAmounts.length !== e.lines.length) {
    errs.push(`valuation has ${spec.valuation.lineAmounts.length} line amounts, expected.lines has ${e.lines.length}`);
  } else {
    const computed = computeEnteredValues(spec.valuation);
    e.lines.forEach((l, i) => {
      if (computed[i] !== l.enteredValue) {
        errs.push(`line ${l.lineNo}: hand-entered enteredValue ${l.enteredValue} ≠ recomputed ${computed[i]}`);
      }
    });
  }

  // Planted arithmetic defects must be expected, and only those.
  const mismatched = e.lines.filter((l) => Math.abs(l.quantity * l.unitPrice - l.printedAmount) > 0.005);
  if (mismatched.length > 0 && !has('LINE_AMOUNT_MISMATCH')) {
    errs.push(`lines ${mismatched.map((l) => l.lineNo).join(',')} have qty×price ≠ printed amount but LINE_AMOUNT_MISMATCH is not expected`);
  }
  if (mismatched.length === 0 && has('LINE_AMOUNT_MISMATCH')) errs.push('LINE_AMOUNT_MISMATCH expected but every line reconciles');

  // Container check digits must agree with the expected container issues.
  const containers = e.transport.containers ?? [];
  const invalid = containers.filter((c) => !isValidContainer(c));
  if (invalid.length > 0 && !has('CONTAINER_NUMBER_INVALID')) errs.push(`invalid container(s) ${invalid.join(',')} without CONTAINER_NUMBER_INVALID`);
  if (invalid.length === 0 && has('CONTAINER_NUMBER_INVALID')) errs.push('CONTAINER_NUMBER_INVALID expected but all containers are valid');

  // Mode consistency.
  if (e.transport.mode === 'air' && e.transport.modeTransportation !== '40') errs.push('air shipments use mode 40');
  if (e.transport.mode === 'ocean' && !['10', '11'].includes(e.transport.modeTransportation)) errs.push('ocean shipments use mode 10/11');
  if (e.transport.mode === 'ocean' && containers.length > 0 && e.transport.modeTransportation !== '11') {
    errs.push('containerized ocean shipments use mode 11');
  }

  // Lines without printed HS codes must expect HTS_NOT_DECLARED.
  if (e.lines.some((l) => l.hs6 === null) && !has('HTS_NOT_DECLARED')) errs.push('a line has no HS code but HTS_NOT_DECLARED is not expected');
  if (e.lines.every((l) => l.hs6 !== null) && has('HTS_NOT_DECLARED')) errs.push('HTS_NOT_DECLARED expected but every line has an HS code');

  // Included charges imply a deduction issue.
  if (spec.valuation.includedNonDutiableCharges > 0 && !has('NON_DUTIABLE_CHARGES')) errs.push('charges are deducted but NON_DUTIABLE_CHARGES is not expected');
  if (spec.valuation.includedNonDutiableCharges === 0 && has('NON_DUTIABLE_CHARGES')) errs.push('NON_DUTIABLE_CHARGES expected but nothing is deducted');

  // Normalized invoice number.
  const normalizedDiffers = e.invoiceNumber !== e.invoiceNumberNormalized;
  if (normalizedDiffers && !has('INVOICE_NO_NORMALIZED')) errs.push('invoice number changes on normalization but INVOICE_NO_NORMALIZED is not expected');
  if (!normalizedDiffers && has('INVOICE_NO_NORMALIZED')) errs.push('INVOICE_NO_NORMALIZED expected but the number is already valid');

  // A packing list (or combined invoice/packing list) must be present unless MISSING_DOCUMENT is expected.
  const hasPl = spec.docs.some((d) => d.docType === 'packing_list' || d.docType === 'invoice_packing_list');
  if (!hasPl && !has('MISSING_DOCUMENT')) errs.push('no packing list but MISSING_DOCUMENT is not expected');
  if (hasPl && has('MISSING_DOCUMENT')) errs.push('MISSING_DOCUMENT expected but a packing list is present');
  if (hasPl && !excluded('MISSING_DOCUMENT')) errs.push('packing list present: MISSING_DOCUMENT should be in issuesExclude');

  return errs;
}
