/**
 * Invoice line items: origin, MID, weights, descriptions, quantities and the
 * tariff (HTS number + entered value + reporting quantities), plus the per-line
 * classification issues.
 */
import {
  DECISION_KEYS,
  type Address,
  type DecisionOption,
  type EntryLineItem,
  type EntryTariff,
  type LineClassification,
  type MidResult,
  type ReferenceLookups,
  type Shipment,
} from '@app/shared';
import type { EffectiveLine } from './decisions';
import { commercialDescription } from './description';
import { MAX_LEN, PATTERNS } from './enums';
import { evidenceDoc, IssueBag, makeIssue } from './issues';
import { formatHts, round2 } from './normalize';
import { reportingQuantities } from './quantities';

export interface LineGross {
  kg: number;
  prorated: boolean;
  note?: string;
}

export interface LineContext {
  shipment: Shipment;
  lookups: ReferenceLookups;
  bag: IssueBag;
  explicit: Set<string>;
  /** Decision keys already carried by an input issue (so we don't duplicate them). */
  decisionKeysInUse: Set<string>;
  exportDate?: string;
  countryExport?: string;
  ladingPort?: string;
  grossByLine: Map<string, LineGross>;
  enteredValues: Record<string, number>;
}

export interface MidUse {
  lineId: string;
  manufacturer?: Address;
  result?: MidResult | null;
}

/** ISO2 from a value that may already be ISO2 or a country name. */
export function toIso2(value: string | undefined, lookups: ReferenceLookups): string | undefined {
  const v = (value ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return v ? (lookups.countryCode(v) ?? undefined) : undefined;
}

/**
 * Gross weight per line: the packing-list weight when known, otherwise the
 * remaining header weight prorated by value over the lines without one.
 */
export function lineGrossWeights(
  lines: EffectiveLine[],
  headerGrossKg: number | undefined,
  exactValues: Record<string, number>,
): Map<string, LineGross> {
  const out = new Map<string, LineGross>();
  const unknown: EffectiveLine[] = [];
  let known = 0;
  for (const l of lines) {
    const kg = l.line.grossWeightKg?.value;
    if (kg !== undefined && kg > 0) {
      out.set(l.line.id, { kg, prorated: false });
      known += kg;
    } else unknown.push(l);
  }
  if (!unknown.length || !headerGrossKg || headerGrossKg <= 0) return out;
  const remaining = headerGrossKg - known;
  const pool = remaining > 0 ? remaining : headerGrossKg;
  const poolLines = remaining > 0 ? unknown : lines;
  const totalValue = poolLines.reduce((s, l) => s + Math.max(0, exactValues[l.line.id] ?? 0), 0);
  for (const l of unknown) {
    const v = Math.max(0, exactValues[l.line.id] ?? 0);
    const share = totalValue > 0 ? v / totalValue : 1 / poolLines.length;
    out.set(l.line.id, {
      kg: pool * share,
      prorated: true,
      note: `${remaining > 0 ? 'Unallocated' : 'Header'} gross weight ${round2(pool)} kg × ${(share * 100).toFixed(1)}% (share of value)`,
    });
  }
  return out;
}

/** Picks the manufacturer for a line: its own, else the single shipment manufacturer in the origin country. */
function manufacturerFor(l: EffectiveLine, origin: string | undefined, shipment: Shipment, lookups: ReferenceLookups): Address | undefined {
  if (l.line.manufacturer) return l.line.manufacturer;
  const ms = shipment.manufacturers;
  const inOrigin = ms.filter((m) => toIso2(m.country, lookups) === origin);
  if (inOrigin.length === 1) return inOrigin[0];
  const noCountry = ms.filter((m) => !m.country);
  if (!inOrigin.length && ms.length === 1 && noCountry.length === 1) return ms[0];
  return undefined;
}

/**
 * Short label for an HTS leaf from a " › " joined path: the leaf, prefixed with
 * its parent when the leaf alone is uninformative ("Other", "Men's (338)").
 */
export function leafLabel(description: string): string {
  const parts = description
    .split(/\s*›\s*/)
    .map((p) => p.trim().replace(/:$/, ''))
    .filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  const ancestor = parts.slice(0, -1).reverse().find((p) => !/^other$/i.test(p)) ?? '';
  const parent = ancestor.split(/[,;]/)[0].trim();
  if (parent && (/^other\b/i.test(last) || last.length < 25)) return `${parent}: ${last}`;
  return last;
}

function rateText(c: LineClassification): string {
  if (c.generalRate) return c.generalRate;
  if (c.adValoremPct !== undefined) return `${c.adValoremPct}%`;
  return 'rate unknown';
}

function declaredText(hs: string | undefined): string {
  return hs ? formatDeclaredHs(hs) : 'No HS declared';
}

function htsOptions(l: EffectiveLine, extra: LineClassification[]): DecisionOption[] {
  const seen = new Set<string>();
  const opts: DecisionOption[] = [];
  const add = (hts: string, label: string) => {
    if (seen.has(hts)) return;
    seen.add(hts);
    opts.push({ value: hts, label });
  };
  for (const c of [l.classification, l.baseClassification, ...extra].filter((c): c is LineClassification => !!c)) {
    add(c.htsNumber, `${c.htsFormatted} ${leafLabel(c.description)} (${rateText(c)})`);
  }
  for (const c of [l.baseClassification, ...extra].filter((c): c is LineClassification => !!c)) {
    for (const a of c.alternatives) {
      add(
        a.htsNumber,
        `${a.htsFormatted} ${leafLabel(a.description)}${a.generalRate ? ` (${a.generalRate})` : a.adValoremPct !== undefined ? ` (${a.adValoremPct}%)` : ''}${a.reason ? ` - ${a.reason}` : ''}`,
      );
    }
  }
  return opts;
}

/** Emits HTS_RESOLVED / HTS_LOW_CONFIDENCE / HTS_NOT_DECLARED / CHAPTER_MISMATCH for one line. */
function htsIssues(l: EffectiveLine, ctx: LineContext, extraOptions: LineClassification[], field: string): void {
  const id = l.line.id;
  const n = l.line.invoiceLineNo;
  const style = l.line.styleNo ? ` (${l.line.styleNo})` : '';
  const key = DECISION_KEYS.hts(id);
  const brokerSet = ctx.explicit.has(key);
  const evidence = l.line.hsCodeDeclared ? evidenceDoc(l.invoice.docId, `HS ${l.line.hsCodeDeclared}`) : [];
  const c = l.classification;
  const decisionFor = (chosen: string) => ({
    key,
    question: `Which 10-digit HTS number applies to line ${n}${style}?`,
    options: htsOptions(l, extraOptions),
    chosen,
  });

  if (!c) {
    ctx.bag.add(
      makeIssue(
        'HTS_LOW_CONFIDENCE',
        id,
        'blocker',
        'classification',
        `Line ${n}${style}: no 10-digit HTS number resolved`,
        `Declared HS: ${l.line.hsCodeDeclared ?? 'none'}. The classifier returned no result for this line${
          l.line.hsCodeDeclared ? '; the declared digits are used as a placeholder tariff number' : ''
        }.`,
        'Classify the line and enter the 10-digit HTS number.',
        { lineId: id, field: `${field}.tariffs[0].tariffNo`, evidence, decision: decisionFor('') },
      ),
    );
    return;
  }

  const sourceNote =
    l.classificationSource === 'alternative'
      ? ' Classified under the composition from the other document (broker decision).'
      : l.classificationSource === 'override'
        ? ' HTS number set by the broker.'
        : '';
  const category = c.textileCategory ? ` (cat. ${c.textileCategory})` : '';
  const title = `${l.classificationSource === 'override' ? 'Broker override' : declaredText(l.line.hsCodeDeclared)} -> ${c.htsFormatted} ${leafLabel(
    c.description,
  )}${c.textileCategory && !leafLabel(c.description).includes(`(${c.textileCategory})`) ? category : ''}, ${rateText(c)}`;

  // Whether a decision-carrying issue is needed depends on the classifier's result, not on a later override,
  // so the issue the broker answered stays visible (downgraded to info) after the override.
  const base = l.baseClassification ?? c;
  const baseFlags = base.flags ?? [];
  // The classifier could not verify any 10-digit number (no HTS data, or no search candidate): a blocker.
  const noReliableCode = baseFlags.some((f) => f.code === 'HTS_DATA_UNAVAILABLE' || f.code === 'NO_CANDIDATE');
  const carriesDecision =
    !ctx.decisionKeysInUse.has(key) && (base.basis === 'search' || (base.confidence === 'low' && base.basis !== 'user'));
  ctx.bag.add(
    makeIssue(
      'HTS_RESOLVED',
      id,
      'info',
      'classification',
      `Line ${n}${style}: ${title}`,
      `${c.description}. ${c.rationale}${sourceNote} Confidence: ${c.confidence}.`,
      'Review the classification; change it via the HTS decision if needed.',
      {
        lineId: id,
        field: `${field}.tariffs[0].tariffNo`,
        evidence,
        // A broker override with no other issue carrying the key stays flippable here.
        decision: brokerSet && !carriesDecision && !ctx.decisionKeysInUse.has(key) ? decisionFor(c.htsNumber) : undefined,
      },
    ),
  );

  if (carriesDecision && c.basis === 'search') {
    ctx.bag.add(
      makeIssue(
        'HTS_NOT_DECLARED',
        id,
        brokerSet ? 'info' : 'blocker',
        'classification',
        `Line ${n}${style}: no HS code on the invoice; HTS found by keyword search`,
        `The documents carry no HS code for this line. ${base.htsFormatted} was proposed by keyword search over the HTS (${base.rationale}).${
          brokerSet ? ` The broker set ${c.htsFormatted}.` : ''
        }`,
        brokerSet ? 'No action.' : 'Classify the line: confirm one of the candidates or enter the correct 10-digit HTS number.',
        { lineId: id, decision: decisionFor(c.htsNumber) },
      ),
    );
  } else if (carriesDecision) {
    ctx.bag.add(
      makeIssue(
        'HTS_LOW_CONFIDENCE',
        id,
        brokerSet ? 'info' : noReliableCode ? 'blocker' : 'warning',
        'classification',
        `Line ${n}${style}: low-confidence HTS ${base.htsFormatted}`,
        `${base.rationale}${base.alternatives.length ? ` Alternatives: ${base.alternatives.map((a) => a.htsFormatted).join(', ')}.` : ''}${
          brokerSet ? ` The broker set ${c.htsFormatted}.` : ''
        }`,
        brokerSet ? 'No action.' : 'Confirm the 10-digit HTS number (choose an alternative or enter one).',
        { lineId: id, evidence, decision: decisionFor(c.htsNumber) },
      ),
    );
  }

  const chapter = c.htsNumber.slice(0, 2);
  const cons = l.line.attributes.construction;
  const constructionMismatch = (cons === 'knit' && chapter === '62') || (cons === 'woven' && chapter === '61');
  // Heading-level conflicts the classifier found (knit/woven chapter, men's vs women's heading). A broker
  // override replaces the classifier's result, so its flags no longer apply.
  const headingFlags = l.classificationSource === 'override' ? [] : (c.flags ?? []).filter((f) => f.code === 'CHAPTER_MISMATCH' || f.code === 'GENDER_CONFLICT');
  if (constructionMismatch || headingFlags.length) {
    const gender = headingFlags.some((f) => f.code === 'GENDER_CONFLICT');
    ctx.bag.add(
      makeIssue(
        'CHAPTER_MISMATCH',
        id,
        'warning',
        'classification',
        constructionMismatch
          ? `Line ${n}${style}: ${cons} garment classified in Chapter ${chapter}`
          : `Line ${n}${style}: declared heading does not match the description${gender ? ' (gender)' : ''}`,
        [
          constructionMismatch
            ? `The line is described as ${cons}, but ${c.htsFormatted} is in Chapter ${chapter} (${
                chapter === '61' ? 'knitted or crocheted' : 'not knitted or crocheted'
              } apparel).`
            : '',
          ...headingFlags.map((f) => f.message),
          c.alternatives.length ? `Alternative: ${c.alternatives[0].htsFormatted}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        gender && !constructionMismatch
          ? "Confirm whether the garment is men's/boys' or women's/girls' and correct the heading (choose the alternative via the HTS decision if it applies)."
          : 'Confirm the fabric construction (knit vs woven) with the supplier and correct the heading.',
        { lineId: id, evidence },
      ),
    );
  }
}

/** Builds one EntryLineItem and records the line's issues. */
export function buildLineItem(
  l: EffectiveLine,
  itemIndex: number,
  ctx: LineContext,
  extraOptions: LineClassification[],
): { item: EntryLineItem; mid: MidUse } {
  const { lookups, shipment, bag } = ctx;
  const id = l.line.id;
  const n = l.line.invoiceLineNo;
  const style = l.line.styleNo ? ` (${l.line.styleNo})` : '';
  const field = `invoices[${l.invoiceIndex}].lineItems[${itemIndex}]`;

  // Country of origin (required).
  const origin = toIso2(l.line.countryOfOrigin.value, lookups);
  if (!origin) {
    bag.add(
      makeIssue(
        'XSD_INVALID',
        `${field}.countryOrigin`,
        'blocker',
        'missing_data',
        `Line ${n}${style}: country of origin unknown`,
        `Country of origin "${l.line.countryOfOrigin.value ?? ''}" could not be mapped to an ISO country code; country-origin is required.`,
        'Enter the 2-letter country of origin for this line.',
        { lineId: id, field: `${field}.countryOrigin` },
      ),
    );
  }

  // Manufacturer ID from the manufacturer (never the seller).
  const manufacturer = manufacturerFor(l, origin, shipment, lookups);
  const midResult = manufacturer ? lookups.buildMid(manufacturer) : undefined;
  const mid = midResult?.mid && midResult.mid.length <= MAX_LEN.manufacturerId ? midResult.mid : undefined;

  // Weights.
  const gross = ctx.grossByLine.get(id);
  if (gross?.prorated) {
    bag.add(
      makeIssue(
        'WEIGHT_PRORATED',
        id,
        'info',
        'assumption',
        `Line ${n}${style}: gross weight prorated (${Math.max(1, Math.round(gross.kg))} kg)`,
        `No per-line gross weight on the packing list. ${gross.note ?? ''}.`,
        'Replace with the actual per-style gross weight if the packing list provides it.',
        { lineId: id, field: `${field}.grossWeight` },
      ),
    );
  }

  // Classification + issues.
  htsIssues(l, ctx, extraOptions, field);
  const c = l.classification;
  const declaredDigits = (l.line.hsCodeDeclared ?? '').replace(/\D/g, '');
  const tariffNo = c && /^\d{10}$/.test(c.htsNumber) ? c.htsNumber : PATTERNS.tariffNo.test(declaredDigits) ? declaredDigits : '';

  // Reporting quantities.
  const q = reportingQuantities(c?.units ?? [], {
    quantity: l.quantity,
    unit: l.line.unit,
    netWeightKg: l.line.netWeightKg?.value,
    grossWeightKg: gross?.kg,
    grossWeightProrated: gross?.prorated,
  });
  if (q.weightAssumption) {
    const prev = bag.get(`WEIGHT_PRORATED:${id}`);
    bag.add(
      makeIssue(
        'WEIGHT_PRORATED',
        id,
        'info',
        'assumption',
        prev ? prev.title : `Line ${n}${style}: net weight estimated from gross weight`,
        `${prev ? `${prev.detail} ` : ''}${q.weightAssumption}`,
        'Replace with the actual net weight from the packing list or supplier.',
        { lineId: id, field: `${field}.tariffs[0].quantity2` },
      ),
    );
  }
  if (q.missing.length && c) {
    const prev = bag.get(`HTS_RESOLVED:${id}`);
    if (prev) {
      bag.add({
        ...prev,
        severity: 'warning',
        detail: `${prev.detail} Reporting quantity in ${q.missing.join(', ')} could not be derived from the documents (invoice unit ${l.line.unit}).`,
        action: `Enter the quantity in ${q.missing.join(', ')} for this line in NetCHB.`,
      });
    }
  }

  const tariff: EntryTariff = {
    tariffNo,
    value: ctx.enteredValues[id] ?? 0,
    quantity1: q.quantities[0]?.quantity,
    unitOfMeasure1: q.quantities[0]?.uom,
    quantity2: q.quantities[1]?.quantity,
    unitOfMeasure2: q.quantities[1]?.uom,
  };

  // Invoice quantity and unit value (the invoice price, not the customs value).
  const unitValue =
    l.line.noCommercialValue && l.line.customsValue !== undefined && l.quantity > 0
      ? l.line.customsValue / l.line.quantity.value
      : (l.line.unitPrice ?? (l.quantity > 0 ? l.amount / l.quantity : undefined));

  const category = c?.textileCategory && PATTERNS.categoryNo.test(c.textileCategory) ? c.textileCategory : undefined;
  const item: EntryLineItem = {
    lineId: id,
    exportDate: ctx.exportDate,
    countryOrigin: origin ?? '',
    manufacturerId: mid,
    relatedParty: l.invoice.relatedParty.value ? 'Y' : 'N',
    countryExport: ctx.countryExport,
    ladingPort: ctx.ladingPort,
    grossWeight: gross ? Math.max(1, Math.round(gross.kg)) : undefined,
    commercialDescription: commercialDescription(l.line.description, l.composition) || undefined,
    invoiceQuantity: l.quantity,
    invoiceUnitValue: unitValue !== undefined && Number.isFinite(unitValue) ? roundUnitValue(unitValue) : 'auto',
    poNumber: l.line.poNumber ?? l.invoice.poNumbers[0],
    categoryNo: category,
    tariffs: [tariff],
  };
  return { item, mid: { lineId: id, manufacturer, result: midResult } };
}

/** Unit values keep up to 4 decimals (prices like 0.0125 exist). */
function roundUnitValue(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Aggregates MID problems per manufacturer into MID_VERIFY warnings. */
export function midIssues(uses: MidUse[], bag: IssueBag): void {
  const groups = new Map<string, { uses: MidUse[]; problem: string; title: string }>();
  for (const u of uses) {
    let problem: string | undefined;
    let key: string;
    let title: string;
    if (!u.manufacturer) {
      key = 'none';
      title = 'Manufacturer not identified';
      problem =
        'No manufacturer could be identified for these lines, so no MID was generated. NetCHB would otherwise derive it from the seller, which is wrong when the seller is a trading company.';
    } else if (!u.result || !u.result.mid) {
      // buildMid can return an empty MID (e.g. country unknown) with notes explaining why.
      key = `name:${u.manufacturer.name}`;
      title = `MID could not be built for ${u.manufacturer.name}`;
      problem = ['The manufacturer address is incomplete for the CBP MID algorithm.', ...(u.result?.notes ?? [])].join(' ');
    } else {
      key = u.result.mid;
      title = `Verify MID ${u.result.mid} (${u.manufacturer.name})`;
      const noAddress = !u.manufacturer.lines.length || !u.manufacturer.city;
      if (u.result.needsVerification || noAddress) {
        problem = [
          noAddress ? 'The manufacturer address is incomplete (street or city missing).' : '',
          ...u.result.notes,
          u.result.needsVerification ? 'The address is ambiguous for the CBP MID rules.' : '',
        ]
          .filter(Boolean)
          .join(' ');
      }
    }
    if (!problem) continue;
    const g = groups.get(key) ?? { uses: [], problem, title };
    g.uses.push(u);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const lineIds = g.uses.map((u) => u.lineId);
    bag.add(
      makeIssue(
        'MID_VERIFY',
        key,
        'warning',
        'compliance',
        g.title,
        `${g.problem} Lines: ${lineIds.join(', ')}.`,
        'Verify the manufacturer ID against the factory name and street address (or a previous entry) before filing.',
        { lineId: lineIds.length === 1 ? lineIds[0] : undefined },
      ),
    );
  }
}

/** Formats a declared HS for display ("6109.10" stays; "610910" → "6109.10"). */
export function formatDeclaredHs(hs: string): string {
  return /\./.test(hs) ? hs : formatHts(hs);
}
