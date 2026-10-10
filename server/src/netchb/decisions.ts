/**
 * Applies broker decisions to the reconcile issues and to the shipment lines.
 *
 * Every ambiguous finding upstream carries a Decision with a policy default.
 * Here the broker's choice (BrokerInputs.decisions[key]) overrides that default,
 * the issue is returned with decision.chosen updated, and each line gets its
 * effective quantity / amount / composition / classification.
 */
import {
  DECISION_KEYS,
  type Fiber,
  type HtsCandidate,
  type Issue,
  type LineClassification,
  type Shipment,
  type ShipmentInvoice,
  type ShipmentLine,
} from '@app/shared';
import { formatHts } from './normalize';

export interface DecisionState {
  /** Input issues with decision.chosen set to the effective choice. */
  issues: Issue[];
  /** Effective choice per decision key (issue defaults overlaid with broker choices). */
  chosen: Record<string, string>;
  /** Keys the broker set explicitly (and that were accepted). */
  explicit: Set<string>;
  /** Broker choices that were rejected (not one of the decision's options). */
  rejected: { key: string; value: string; reason: string }[];
}

const HTS_KEY_PREFIX = 'hts:';

/** Appended to an issue whose decision the broker set explicitly. */
export function resolvedNote(label: string): string {
  return `Resolved by broker choice: ${label}. Keep supporting documents (e.g. credit note / fibre test report).`;
}

/** Normalizes an HTS override to 10 digits, or null if it isn't one. */
export function parseHtsOverride(value: string | undefined): string | null {
  const d = (value ?? '').replace(/[\s.]/g, '');
  return /^\d{10}$/.test(d) ? d : null;
}

/**
 * Overlays broker choices on issue defaults; returns the issues with decision.chosen updated.
 * An issue whose decision the broker set EXPLICITLY (key present in brokerInputs.decisions with an
 * accepted value, even the default one) is resolved: a blocker drops to a warning, the decision stays
 * on the issue so it can be changed back, and the detail records the choice. Without an explicit
 * choice the default severity is kept.
 */
export function resolveDecisions(issues: Issue[], brokerDecisions: Record<string, string> | undefined): DecisionState {
  const chosen: Record<string, string> = {};
  const explicit = new Set<string>();
  const rejected: DecisionState['rejected'] = [];
  const broker = brokerDecisions ?? {};

  const out = issues.map((issue) => {
    const d = issue.decision;
    if (!d) return issue;
    let value = d.chosen;
    let accepted = false;
    const requested = broker[d.key];
    if (requested !== undefined) {
      const ok = d.key.startsWith(HTS_KEY_PREFIX) ? parseHtsOverride(requested) !== null : d.options.some((o) => o.value === requested);
      if (ok) {
        value = d.key.startsWith(HTS_KEY_PREFIX) ? parseHtsOverride(requested)! : requested;
        explicit.add(d.key);
        accepted = true;
      } else rejected.push({ key: d.key, value: requested, reason: `not one of: ${d.options.map((o) => o.value).join(', ')}` });
    }
    chosen[d.key] = value;
    const decided = { ...issue, decision: { ...d, chosen: value } };
    if (!accepted) return decided;
    const label = d.options.find((o) => o.value === value)?.label ?? (d.key.startsWith(HTS_KEY_PREFIX) ? formatHts(value) : value);
    return {
      ...decided,
      severity: issue.severity === 'blocker' ? 'warning' : issue.severity,
      detail: `${issue.detail} ${resolvedNote(label)}`,
    };
  });

  // Broker decisions with no matching issue still apply (e.g. hts overrides, or a key from a previous run).
  for (const [key, value] of Object.entries(broker)) {
    if (key in chosen) continue;
    if (key.startsWith(HTS_KEY_PREFIX)) {
      const hts = parseHtsOverride(value);
      if (hts) {
        chosen[key] = hts;
        explicit.add(key);
      } else rejected.push({ key, value, reason: 'an HTS override must be 10 digits' });
    } else {
      chosen[key] = value;
      explicit.add(key);
    }
  }
  return { issues: out, chosen, explicit, rejected };
}

export interface EffectiveLine {
  line: ShipmentLine;
  invoice: ShipmentInvoice;
  invoiceIndex: number;
  quantity: number;
  quantitySource: 'invoice' | 'packed';
  amount: number;
  amountLabel: string;
  composition?: Fiber[];
  compositionSource: 'invoice' | 'other_doc';
  /** Classification before any hts override (primary, or the alternative-composition one). */
  baseClassification?: LineClassification;
  /** Classification actually used (after an hts override). */
  classification?: LineClassification;
  classificationSource: 'primary' | 'alternative' | 'override' | 'none';
  /** Decisions that could not be applied, keyed by decision key. */
  notes: { key: string; note: string }[];
}

const num = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

/** Textile category printed in parentheses at the end of an HTS description, e.g. "Women's (339)". */
function categoryFromDescription(description: string | undefined): string | undefined {
  const all = [...(description ?? '').matchAll(/\((\d{3})\)/g)];
  return all.length ? all[all.length - 1][1] : undefined;
}

/** Builds a classification for a broker HTS override, reusing what is known about that code. */
function overrideClassification(
  lineId: string,
  hts: string,
  base: LineClassification | undefined,
  candidates: HtsCandidate[],
): LineClassification {
  const known = candidates.find((c) => c.htsNumber === hts);
  const sameHeading = base && base.htsNumber.slice(0, 4) === hts.slice(0, 4);
  return {
    lineId,
    htsNumber: hts,
    htsFormatted: known?.htsFormatted ?? formatHts(hts),
    description: known?.description ?? (base?.htsNumber === hts ? base.description : 'Broker-specified HTS number'),
    generalRate: known ? known.generalRate : base?.htsNumber === hts ? base.generalRate : undefined,
    adValoremPct: known ? known.adValoremPct : base?.htsNumber === hts ? base.adValoremPct : undefined,
    units: known?.units ?? (sameHeading ? base!.units : []),
    textileCategory:
      (known as LineClassification | undefined)?.textileCategory ?? categoryFromDescription(known?.description),
    confidence: 'high',
    rationale: 'HTS number set by the broker (decision override).',
    alternatives: [],
    basis: 'user',
  };
}

/** Resolves every shipment line to its effective quantity, amount, composition and classification. */
export function effectiveLines(
  shipment: Shipment,
  classifications: Record<string, LineClassification>,
  altClassifications: Record<string, LineClassification>,
  chosen: Record<string, string>,
  overrideClassifications: Record<string, LineClassification> = {},
): EffectiveLine[] {
  const out: EffectiveLine[] = [];
  shipment.invoices.forEach((invoice, invoiceIndex) => {
    for (const line of invoice.lines) {
      const notes: EffectiveLine['notes'] = [];
      const id = line.id;
      const invQty = line.quantity.value;

      // Amount: computed (default) vs printed.
      let amount = line.amount.value;
      let amountLabel =
        line.unitPrice !== undefined && invQty
          ? line.printedAmount !== undefined
            ? `Invoice amount, corrected (${num(invQty)} × ${num(line.unitPrice)}; printed ${num(line.printedAmount)})`
            : `Invoice amount (${num(invQty)} × ${num(line.unitPrice)})`
          : 'Invoice line amount';
      if (chosen[DECISION_KEYS.amount(id)] === 'printed') {
        if (line.printedAmount !== undefined) {
          amount = line.printedAmount;
          amountLabel = 'Invoice amount as printed (broker decision)';
        } else notes.push({ key: DECISION_KEYS.amount(id), note: 'Decision "printed" not applied: no printed amount differs from the computed one.' });
      }

      // Quantity: invoice (default) vs packed.
      let quantity = invQty;
      let quantitySource: EffectiveLine['quantitySource'] = 'invoice';
      if (chosen[DECISION_KEYS.quantity(id)] === 'packed') {
        if (line.packedQuantity !== undefined) {
          quantity = line.packedQuantity;
          quantitySource = 'packed';
          if (line.unitPrice !== undefined) {
            amount = line.unitPrice * quantity;
            amountLabel = `Packed quantity × unit price (${num(quantity)} × ${num(line.unitPrice)}, broker decision)`;
          } else if (invQty > 0) {
            amount = (amount * quantity) / invQty;
            amountLabel = `Invoice amount pro rata to packed quantity (${num(quantity)}/${num(invQty)}, broker decision)`;
          }
        } else notes.push({ key: DECISION_KEYS.quantity(id), note: 'Decision "packed" not applied: no packed quantity differs from the invoice.' });
      }

      // Composition + classification: invoice (default) vs other document.
      let composition = line.attributes.composition;
      let compositionSource: EffectiveLine['compositionSource'] = 'invoice';
      let base = classifications[id];
      let classificationSource: EffectiveLine['classificationSource'] = base ? 'primary' : 'none';
      if (chosen[DECISION_KEYS.composition(id)] === 'other_doc') {
        if (line.altComposition) {
          composition = line.altComposition;
          compositionSource = 'other_doc';
        }
        if (altClassifications[id]) {
          base = altClassifications[id];
          classificationSource = 'alternative';
        } else
          notes.push({
            key: DECISION_KEYS.composition(id),
            note: 'Composition from the other document chosen, but no alternative classification was provided; the HTS number is unchanged.',
          });
      }

      let classification = base;
      const override = parseHtsOverride(chosen[DECISION_KEYS.hts(id)]);
      if (override && override !== base?.htsNumber) {
        const candidates: HtsCandidate[] = [
          ...[classifications[id], altClassifications[id]].filter((c): c is LineClassification => !!c),
          ...(classifications[id]?.alternatives ?? []),
          ...(altClassifications[id]?.alternatives ?? []),
        ];
        const resolved = overrideClassifications[id];
        classification =
          resolved && resolved.htsNumber === override
            ? { ...resolved, lineId: id, basis: 'user', alternatives: [] }
            : overrideClassification(id, override, base, candidates);
        classificationSource = 'override';
      }

      out.push({
        line,
        invoice,
        invoiceIndex,
        quantity,
        quantitySource,
        amount,
        amountLabel,
        composition,
        compositionSource,
        baseClassification: base,
        classification,
        classificationSource,
        notes,
      });
    }
  });
  return out;
}
