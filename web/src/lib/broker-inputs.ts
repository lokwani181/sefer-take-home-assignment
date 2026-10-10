import type { BrokerInputs, Issue, IssueCode, PipelineResult } from '@app/shared';

/**
 * Broker-input form model, validation, and the mapping from each input to the issues it
 * resolves. Shared by the form (to show what each field clears) and the demo mock.
 */

/** XSD taxIdType: EIN (+ optional 2-char suffix), CBP-assigned number, or SSN. */
export const TAX_ID_PATTERN = /^(?:\d{2}-\d{7}[A-Za-z0-9]{0,2}|\d{6}-\d{5}|\d{3}-\d{2}-\d{4})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const BOND_TYPES = [
  { value: '08', label: '08 · Continuous' },
  { value: '09', label: '09 · Single transaction' },
  { value: '00', label: '00 · No bond' },
] as const;

export const PAYMENT_TYPES = [
  { value: '1', label: '1 · Single pay' },
  { value: '2', label: '2 · Daily statement' },
  { value: '3', label: '3 · Broker daily statement' },
  { value: '5', label: '5 · Periodic monthly statement' },
  { value: '6', label: '6 · Periodic monthly statement' },
  { value: '7', label: '7 · PMS, importer' },
  { value: '8', label: '8 · PMS, broker' },
] as const;

export const ENTRY_TYPES = [
  { value: '01', label: '01 · Consumption, free and dutiable' },
  { value: '03', label: '03 · Consumption, AD/CVD' },
  { value: '06', label: '06 · Consumption, FTZ' },
  { value: '11', label: '11 · Informal' },
  { value: '21', label: '21 · Warehouse' },
] as const;

/** Editable form state: every text field is a string ('' = not provided). */
export interface BrokerFormValues {
  importerTaxId: string;
  importerName: string;
  ultimateConsigneeTaxId: string;
  bondType: string;
  suretyCode: string;
  paymentType: string;
  entryType: string;
  entryPort: string;
  locationOfGoods: string;
  entryDate: string;
  arrivalDate: string;
  autoApplyRemedies: boolean;
  brokerReference: string;
}

export type BrokerFormField = keyof BrokerFormValues;
export type BrokerFormErrors = Partial<Record<BrokerFormField, string>>;

/** Issue codes that disappear once the given input is supplied. */
export const INPUT_CLEARS: Partial<Record<BrokerFormField, IssueCode[]>> = {
  importerTaxId: ['MISSING_IMPORTER_ID'],
  ultimateConsigneeTaxId: ['MISSING_CONSIGNEE_ID'],
  bondType: ['MISSING_BOND'],
  suretyCode: ['MISSING_SURETY'],
  entryPort: ['PORT_UNKNOWN'],
  locationOfGoods: ['MISSING_LOCATION_OF_GOODS'],
  entryDate: ['ENTRY_DATE_DEFAULTED'],
  arrivalDate: ['ARRIVAL_ESTIMATED'],
};

/** Open issues (from the current result) that the given field would clear. */
export function issuesClearedBy(field: BrokerFormField, issues: Issue[]): Issue[] {
  const codes = INPUT_CLEARS[field];
  if (!codes) return [];
  return issues.filter((issue) => codes.includes(issue.code));
}

export function toFormValues(inputs: BrokerInputs): BrokerFormValues {
  return {
    importerTaxId: inputs.importerTaxId ?? '',
    importerName: inputs.importerName ?? '',
    ultimateConsigneeTaxId: inputs.ultimateConsigneeTaxId ?? '',
    bondType: inputs.bondType ?? '',
    suretyCode: inputs.suretyCode ?? '',
    paymentType: inputs.paymentType ?? '',
    entryType: inputs.entryType ?? '01',
    entryPort: inputs.entryPort ?? '',
    locationOfGoods: inputs.locationOfGoods ?? '',
    entryDate: inputs.entryDate ?? '',
    arrivalDate: inputs.arrivalDate ?? '',
    autoApplyRemedies: inputs.autoApplyRemedies ?? true,
    brokerReference: inputs.brokerReference ?? '',
  };
}

const opt = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Converts form values to BrokerInputs: trims, drops empties, uppercases codes, keeps decisions. */
export function fromFormValues(values: BrokerFormValues, decisions?: Record<string, string>): BrokerInputs {
  const inputs: BrokerInputs = {
    importerTaxId: opt(values.importerTaxId)?.toUpperCase(),
    importerName: opt(values.importerName),
    ultimateConsigneeTaxId: opt(values.ultimateConsigneeTaxId)?.toUpperCase(),
    bondType: opt(values.bondType),
    suretyCode: opt(values.suretyCode)?.toUpperCase(),
    paymentType: opt(values.paymentType),
    entryType: opt(values.entryType),
    entryPort: opt(values.entryPort),
    locationOfGoods: opt(values.locationOfGoods)?.toUpperCase(),
    entryDate: opt(values.entryDate),
    arrivalDate: opt(values.arrivalDate),
    autoApplyRemedies: values.autoApplyRemedies,
    brokerReference: opt(values.brokerReference),
    decisions: decisions && Object.keys(decisions).length > 0 ? { ...decisions } : undefined,
  };
  for (const key of Object.keys(inputs) as (keyof BrokerInputs)[]) {
    if (inputs[key] === undefined) delete inputs[key];
  }
  return inputs;
}

/** Field-level validation mirroring the NetCHB XSD patterns. Returns {} when valid. */
export function validateBrokerForm(values: BrokerFormValues): BrokerFormErrors {
  const errors: BrokerFormErrors = {};
  const taxIdMessage = 'Use NN-NNNNNNN (EIN, optional 2-character suffix), YYDDPP-NNNNN (CBP-assigned) or NNN-NN-NNNN (SSN).';
  const importerTaxId = values.importerTaxId.trim();
  if (importerTaxId && !TAX_ID_PATTERN.test(importerTaxId)) errors.importerTaxId = taxIdMessage;
  const ucTaxId = values.ultimateConsigneeTaxId.trim();
  if (ucTaxId && !TAX_ID_PATTERN.test(ucTaxId)) errors.ultimateConsigneeTaxId = taxIdMessage;
  const surety = values.suretyCode.trim();
  if (surety && !/^[A-Za-z0-9]{3}$/.test(surety)) errors.suretyCode = 'Surety code is exactly 3 letters or digits.';
  const entryType = values.entryType.trim();
  if (entryType && !/^\d{2}$/.test(entryType)) errors.entryType = 'Entry type is a 2-digit code, e.g. 01.';
  const port = values.entryPort.trim();
  if (port && !/^\d{4}$/.test(port)) errors.entryPort = 'Port codes are 4 digits (CBP Schedule D), e.g. 3002.';
  const firms = values.locationOfGoods.trim();
  if (firms && !/^[A-Za-z0-9]{1,4}$/.test(firms)) errors.locationOfGoods = 'FIRMS codes are up to 4 letters or digits.';
  if (values.entryDate && !ISO_DATE.test(values.entryDate)) errors.entryDate = 'Use a valid date.';
  if (values.arrivalDate && !ISO_DATE.test(values.arrivalDate)) errors.arrivalDate = 'Use a valid date.';
  if (values.importerName.trim().length > 100) errors.importerName = 'Keep the importer name to 100 characters or fewer.';
  if (values.brokerReference.trim().length > 35) errors.brokerReference = 'Keep the reference to 35 characters or fewer.';
  return errors;
}

/** Decision key → chosen value for every issue that carries a decision. */
export function decisionDefaults(issues: Issue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.decision) out[issue.decision.key] = issue.decision.chosen;
  }
  return out;
}

/**
 * The UI's broker-input state for a result: the server's echo, with ONLY the decisions the broker
 * explicitly chose. Defaults are not filled in, because the server treats every decision key it
 * receives as an explicit broker choice (which downgrades that issue's blocker). Show defaults via
 * `issue.decision.chosen` instead.
 */
export function inputsFromResult(result: PipelineResult): BrokerInputs {
  const explicit = result.brokerInputs.decisions;
  const inputs: BrokerInputs = { ...result.brokerInputs };
  if (explicit && Object.keys(explicit).length > 0) inputs.decisions = { ...explicit };
  else delete inputs.decisions;
  return inputs;
}
