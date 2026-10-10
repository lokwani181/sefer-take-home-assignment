import type { BrokerInputs, EntryLineItem, Estimates, PipelineResult, ShipmentLine } from '@app/shared';
import { DECISION_KEYS } from '@app/shared';
import { INPUT_CLEARS, TAX_ID_PATTERN, decisionDefaults, type BrokerFormField } from '../lib/broker-inputs';
import { formatHts } from '../lib/format';
import { buildMockEntryXml, buildMockSoapEnvelope } from './mock-xml';

/**
 * Demo-only "regenerate": applies broker inputs and decisions to a base PipelineResult the way
 * the server's assemble step would (for the effects the UI needs to demonstrate). Works on any
 * result's own data; nothing here is tied to a specific shipment.
 */

/** Fee parameters used only for the demo recalculation (the server owns the real config). */
const DEMO_FEES = { mpfRate: 0.003464, mpfMin: 33.58, mpfMax: 651.5, hmfRate: 0.00125 };
const VESSEL_MODES = new Set(['10', '11', '12']);

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function findLineItem(result: PipelineResult, lineId: string): EntryLineItem | undefined {
  for (const invoice of result.entryModel.invoices) {
    const item = invoice.lineItems.find((li) => li.lineId === lineId);
    if (item) return item;
  }
  return undefined;
}

function applyLineDecisions(result: PipelineResult, line: ShipmentLine, decisions: Record<string, string>) {
  const valuation = result.valuations.find((v) => v.lineId === line.id);
  const item = findLineItem(result, line.id);
  if (!valuation || !item || item.tariffs.length === 0) return;
  const tariff = item.tariffs[0];

  if (decisions[DECISION_KEYS.amount(line.id)] === 'printed' && line.printedAmount !== undefined) {
    const delta = round2(line.printedAmount - line.amount.value);
    if (delta !== 0) {
      valuation.steps.push({ label: 'Printed amount used (broker decision)', amount: delta, note: `Declared as printed: ${line.printedAmount}` });
    }
  }

  if (decisions[DECISION_KEYS.quantity(line.id)] === 'packed' && line.packedQuantity !== undefined && line.unitPrice !== undefined) {
    const delta = round2((line.packedQuantity - line.quantity.value) * line.unitPrice);
    valuation.steps.push({
      label: 'Packed quantity used (broker decision)',
      amount: delta,
      note: `${line.packedQuantity} ${line.unit} per packing list × ${line.unitPrice}`,
    });
    item.invoiceQuantity = line.packedQuantity;
    if (tariff.unitOfMeasure1 === 'DOZ') tariff.quantity1 = round2(line.packedQuantity / 12);
    else if (tariff.unitOfMeasure1 === 'NO' || tariff.unitOfMeasure1 === 'PCS') tariff.quantity1 = line.packedQuantity;
  }

  valuation.enteredValue = Math.round(sum(valuation.steps.map((s) => s.amount)));
  tariff.value = valuation.enteredValue;

  if (decisions[DECISION_KEYS.composition(line.id)] === 'other_doc' && result.altClassifications[line.id]) {
    const primary = result.classifications[line.id];
    result.classifications[line.id] = result.altClassifications[line.id];
    if (primary) result.altClassifications[line.id] = primary;
  }

  const htsOverride = decisions[DECISION_KEYS.hts(line.id)];
  if (htsOverride && /^\d{10}$/.test(htsOverride) && result.classifications[line.id]) {
    const current = result.classifications[line.id];
    if (current.htsNumber !== htsOverride) {
      result.classifications[line.id] = {
        ...current,
        htsNumber: htsOverride,
        htsFormatted: formatHts(htsOverride),
        description: 'Entered by the broker',
        generalRate: undefined,
        adValoremPct: undefined,
        textileCategory: undefined,
        confidence: 'high',
        rationale: 'HTS number overridden by the broker.',
        alternatives: [],
        basis: 'user',
      };
    }
  }

  const cls = result.classifications[line.id];
  if (cls) {
    tariff.tariffNo = cls.htsNumber;
    item.categoryNo = cls.textileCategory;
  }
}

function applyHeaderInputs(result: PipelineResult, inputs: BrokerInputs, decisions: Record<string, string>) {
  const h = result.entryModel.header;
  const entryDateFollowsArrival = h.entryDate === h.arrivalDate;

  if (decisions[DECISION_KEYS.grossWeight] === 'packing_list') {
    for (const doc of result.extracted) {
      if (doc.data.kind === 'packing_list' && doc.data.totals.grossWeightKg !== undefined) {
        h.grossWeight = Math.round(doc.data.totals.grossWeightKg);
        break;
      }
    }
  }
  if (inputs.importerTaxId) h.importerTaxId = inputs.importerTaxId;
  if (inputs.importerName) h.importerName = inputs.importerName;
  if (inputs.ultimateConsigneeTaxId) h.ultimateConsignee = { ...h.ultimateConsignee, taxId: inputs.ultimateConsigneeTaxId };
  if (inputs.bondType) h.bondType = inputs.bondType;
  if (inputs.suretyCode) h.suretyCode = inputs.suretyCode;
  if (inputs.paymentType) h.paymentType = inputs.paymentType;
  if (inputs.entryType) h.entryType = inputs.entryType;
  if (inputs.entryPort) h.entryPort = inputs.entryPort;
  if (inputs.locationOfGoods) h.locationOfGoods = inputs.locationOfGoods;
  if (inputs.arrivalDate) h.arrivalDate = inputs.arrivalDate;
  if (inputs.entryDate) h.entryDate = inputs.entryDate;
  else if (entryDateFollowsArrival && h.arrivalDate) h.entryDate = h.arrivalDate;
  if (inputs.brokerReference) h.brokerReferenceNo = inputs.brokerReference;
  result.entryModel.autoApplyRemedies = inputs.autoApplyRemedies ?? true;

  const items = result.entryModel.invoices.flatMap((inv) => inv.lineItems);
  h.totalEntryValue = sum(items.flatMap((item) => item.tariffs.map((t) => t.value)));
}

function recomputeEstimates(result: PipelineResult): Estimates {
  const items = result.entryModel.invoices.flatMap((inv) => inv.lineItems);
  const lines = items.map((item) => {
    const value = sum(item.tariffs.map((t) => t.value));
    const ratePct = result.classifications[item.lineId]?.adValoremPct;
    return {
      lineId: item.lineId,
      htsNumber: item.tariffs[0]?.tariffNo ?? '',
      enteredValue: value,
      ratePct,
      duty: ratePct === undefined ? undefined : round2((value * ratePct) / 100),
    };
  });
  const total = result.entryModel.header.totalEntryValue ?? 0;
  const mpf = round2(Math.min(DEMO_FEES.mpfMax, Math.max(DEMO_FEES.mpfMin, total * DEMO_FEES.mpfRate)));
  const vessel = VESSEL_MODES.has(result.entryModel.header.modeTransportation ?? '');
  return {
    lines,
    totalDuty: round2(sum(lines.map((l) => l.duty ?? 0))),
    mpf,
    hmf: vessel ? round2(total * DEMO_FEES.hmfRate) : 0,
    notes: result.estimates.notes,
  };
}

/** Mimics the XSD check for the fields the broker can type, so invalid input shows up in the demo. */
function validateInputs(inputs: BrokerInputs): string[] {
  const errors: string[] = [];
  for (const [field, value] of [
    ['importer-tax-id', inputs.importerTaxId],
    ['tax-id', inputs.ultimateConsigneeTaxId],
  ] as const) {
    if (value && !TAX_ID_PATTERN.test(value)) {
      errors.push(`Element '{http://www.netchb.com/xml/entry}${field}': [facet 'pattern'] The value '${value}' is not accepted by the pattern.`);
    }
  }
  if (inputs.entryPort && !/^\d{4}$/.test(inputs.entryPort)) {
    errors.push(`Element '{http://www.netchb.com/xml/entry}entry-port': '${inputs.entryPort}' is not a valid 4-digit port.`);
  }
  return errors;
}

/** Returns a new result with the broker inputs and decisions applied; the base is never mutated. */
export function applyMockInputs(base: PipelineResult, inputs: BrokerInputs): PipelineResult {
  const result = structuredClone(base);
  const decisions = { ...decisionDefaults(base.issues), ...(inputs.decisions ?? {}) };

  const cleared = new Set<string>();
  for (const [field, codes] of Object.entries(INPUT_CLEARS) as [BrokerFormField, string[]][]) {
    const key = field as keyof BrokerInputs;
    if (inputs[key] !== undefined && inputs[key] !== '') codes.forEach((code) => cleared.add(code));
  }
  const explicit = inputs.decisions ?? {};
  result.issues = result.issues
    .filter((issue) => !cleared.has(issue.code))
    .map((issue) => {
      if (!issue.decision) return issue;
      const chosen = decisions[issue.decision.key] ?? issue.decision.chosen;
      const decided = issue.decision.key in explicit;
      // Mirrors the server: an explicit broker choice resolves the decision's blocker.
      const label = issue.decision.options.find((o) => o.value === chosen)?.label ?? chosen;
      return {
        ...issue,
        severity: decided && issue.severity === 'blocker' ? 'warning' : issue.severity,
        detail: decided ? `${issue.detail} Resolved by broker choice: ${label}. Keep supporting documents.` : issue.detail,
        decision: { ...issue.decision, chosen },
      };
    });

  for (const line of result.shipment.invoices.flatMap((inv) => inv.lines)) applyLineDecisions(result, line, decisions);
  applyHeaderInputs(result, inputs, decisions);
  result.estimates = recomputeEstimates(result);

  result.xml = buildMockEntryXml(result.entryModel);
  result.soapEnvelope = buildMockSoapEnvelope(result.xml);
  const errors = validateInputs(inputs);
  result.xsdValidation = { valid: errors.length === 0, errors };
  result.brokerInputs = { ...inputs };
  return result;
}
