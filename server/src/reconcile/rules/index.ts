/**
 * Rule registry. Order matters: amount corrections run before totals and FOB-basis checks, and
 * container/weight/date rules refine the shipment before the advisories read it.
 */
import type { Rule } from '../context';
import { arrivalEstimatedRule } from './arrivalEstimated';
import { assistRule } from './assist';
import { chargesNotItemizedRule } from './chargesNotItemized';
import { collectChargesRule } from './collectCharges';
import { compositionRule } from './composition';
import { containerRule } from './container';
import { dateAmbiguousRule } from './dateAmbiguous';
import { declarationConflictRule } from './declarationConflict';
import { grossWeightRule } from './grossWeight';
import { houseMasterBillRule } from './houseMasterBill';
import { isfRule } from './isf';
import { lineAmountRule } from './lineAmount';
import { missingDocumentRule } from './missingDocument';
import { missingFieldRule } from './missingField';
import { ncvValueRule } from './ncvValue';
import { nonDutiableChargesRule } from './nonDutiableCharges';
import { ocrVerifyRule } from './ocrVerify';
import { originDiffersRule } from './originDiffers';
import { packageCountRule } from './packageCount';
import { partiesRule } from './parties';
import { quantityRule } from './quantity';
import { relatedPartyRule } from './relatedParty';
import { sellerManufacturerRule } from './sellerManufacturer';
import { telexReleaseRule } from './telexRelease';
import { totalsRule } from './totals';
import { uflpaRule } from './uflpa';
import { unrecognizedDocumentRule } from './unrecognizedDocument';

export const RULES: Rule[] = [
  missingDocumentRule,
  unrecognizedDocumentRule,
  lineAmountRule,
  totalsRule,
  nonDutiableChargesRule,
  chargesNotItemizedRule,
  quantityRule,
  compositionRule,
  packageCountRule,
  grossWeightRule,
  containerRule,
  originDiffersRule,
  declarationConflictRule,
  ncvValueRule,
  assistRule,
  dateAmbiguousRule,
  sellerManufacturerRule,
  partiesRule,
  houseMasterBillRule,
  arrivalEstimatedRule,
  relatedPartyRule,
  missingFieldRule,
  ocrVerifyRule,
  uflpaRule,
  isfRule,
  telexReleaseRule,
  collectChargesRule,
];

export {
  arrivalEstimatedRule,
  assistRule,
  chargesNotItemizedRule,
  collectChargesRule,
  compositionRule,
  containerRule,
  dateAmbiguousRule,
  declarationConflictRule,
  grossWeightRule,
  houseMasterBillRule,
  isfRule,
  lineAmountRule,
  missingDocumentRule,
  missingFieldRule,
  ncvValueRule,
  nonDutiableChargesRule,
  ocrVerifyRule,
  originDiffersRule,
  packageCountRule,
  partiesRule,
  quantityRule,
  relatedPartyRule,
  sellerManufacturerRule,
  telexReleaseRule,
  totalsRule,
  uflpaRule,
  unrecognizedDocumentRule,
};
