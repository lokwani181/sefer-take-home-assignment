/**
 * Shipment (+ classifications, broker inputs, reconcile issues) → EntryModel.
 *
 * Order of work: apply decisions → value every line → header (ports, dates,
 * transport, parties, bond) → manifest/containers/cargo-release parties →
 * invoices/line items → broker-facing issues → estimates. Everything the
 * documents cannot supply becomes an Issue; nothing is invented.
 */
import type {
  Address,
  AssembleFn,
  AssembleInput,
  AssembleOutput,
  EntryHeader,
  EntryInvoice,
  EntryModel,
  Issue,
  LineClassification,
  LineValuation,
  ReferenceLookups,
  Shipment,
  ShipmentTransport,
} from '@app/shared';
import { BOND_TYPES_NEEDING_SURETY, MAX_LEN, MODE_TRANSPORT_CODES, PATTERNS, US_STATES } from './enums';
import { checkBrokerInputs, type CheckedBrokerInputs, type InvalidInput } from './broker-inputs';
import { effectiveLines, resolveDecisions, type EffectiveLine } from './decisions';
import { headerDescription } from './description';
import { computeEstimates } from './estimates';
import { evidenceDoc, evidenceOf, IssueBag, makeIssue } from './issues';
import { buildLineItem, lineGrossWeights, midIssues, toIso2, type MidUse } from './line-items';
import { buildBills, buildContainers } from './manifest';
import { isIsoDate, nameKey, normalizeInvoiceNo, truncateWords } from './normalize';
import { buildCargoReleaseParties } from './parties';
import { valueInvoice } from './valuation';

const EUROZONE = new Set(['AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES']);

/** Currencies shared by several countries (ISO 4217 code → ISO 3166 countries that use it). */
const SHARED_CURRENCIES: Record<string, ReadonlySet<string>> = {
  EUR: EUROZONE,
  XOF: new Set(['BJ', 'BF', 'CI', 'GW', 'ML', 'NE', 'SN', 'TG']), // West African CFA franc
  XAF: new Set(['CM', 'CF', 'TD', 'CG', 'GQ', 'GA']), // Central African CFA franc
  XCD: new Set(['AG', 'DM', 'GD', 'KN', 'LC', 'VC', 'AI', 'MS']), // East Caribbean dollar
  XPF: new Set(['PF', 'NC', 'WF']), // CFP franc
};

/**
 * currency-country-code for an ISO 4217 code. National currencies: the first two letters (GBP → GB).
 * Shared currencies (EUR, XOF, XAF, XCD, XPF): the first of the export country and the `fallbacks`
 * (seller, manufacturers, origins…) that uses the currency, else undefined (never invented).
 * Other X-codes (metals, SDR) have no country.
 */
export function currencyCountryCode(currency: string, countryOfExport: string | undefined, fallbacks: (string | undefined)[] = []): string | undefined {
  const c = currency.toUpperCase();
  const shared = SHARED_CURRENCIES[c];
  if (shared) return [countryOfExport, ...fallbacks].map((x) => x?.toUpperCase()).find((x): x is string => !!x && shared.has(x));
  if (c.startsWith('X')) return undefined; // supranational / metals (XAU, XDR…)
  return /^[A-Z]{3}$/.test(c) ? c.slice(0, 2) : undefined;
}

/** CBP mode-of-transport code from the transport mode and containerization. */
export function modeOfTransport(t: ShipmentTransport): string | undefined {
  const code = (() => {
    switch (t.mode) {
      case 'ocean':
        return t.containerized ? '11' : '10';
      case 'air':
        return t.containerized ? '41' : '40';
      case 'truck':
        return t.containerized ? '31' : '30';
      case 'rail':
        return t.containerized ? '21' : '20';
      default:
        return undefined;
    }
  })();
  return code && (MODE_TRANSPORT_CODES as readonly string[]).includes(code) ? code : undefined;
}

/** The importing carrier: for ocean the master-bill (vessel-operating) SCAC, never the NVOCC's house SCAC. */
function carrierCode(shipment: Shipment): string | undefined {
  const t = shipment.transport;
  const candidates =
    t.mode === 'ocean'
      ? [...shipment.bills.map((b) => b.master?.scac), t.carrierScac]
      : [t.carrierScac, ...shipment.bills.map((b) => b.master?.scac)];
  for (const c of candidates) {
    const s = (c ?? '').trim().toUpperCase();
    if (PATTERNS.carrierCode.test(s)) return s;
  }
  return undefined;
}

/** Voyage (ocean) or flight number without the airline prefix (air); ≤5 characters per the XSD. */
function voyageNo(t: ShipmentTransport): { value?: string; dropped?: string } {
  let v = (t.voyage ?? '').replace(/\s+/g, '').toUpperCase();
  if (!v && t.mode === 'air' && t.flight) v = t.flight.replace(/\s+/g, '').toUpperCase().replace(/^[A-Z0-9]{2}(?=\d)/, '');
  if (!v) return {};
  return v.length <= MAX_LEN.voyageNo ? { value: v } : { dropped: v };
}

function validTaxId(s: string | undefined): string | undefined {
  const v = (s ?? '').trim();
  return PATTERNS.taxId.test(v) ? v : undefined;
}

function stateFromAddress(a: Address | undefined, lookups: ReferenceLookups): string | undefined {
  if (!a) return undefined;
  const country = toIso2(a.country, lookups);
  if (country && country !== 'US') return undefined;
  const s = (a.stateProvince ?? '').trim().toUpperCase();
  if (US_STATES.has(s)) return s;
  const fromRaw = lookups.usStateCode(a.stateProvince ?? '') ?? lookups.usStateCode(a.raw);
  return fromRaw && US_STATES.has(fromRaw) ? fromRaw : undefined;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const INVALID_INPUT_CODE: Partial<Record<InvalidInput['field'], { code: Issue['code']; key?: string }>> = {
  importerTaxId: { code: 'MISSING_IMPORTER_ID' },
  ultimateConsigneeTaxId: { code: 'MISSING_CONSIGNEE_ID' },
  bondType: { code: 'MISSING_BOND' },
  suretyCode: { code: 'MISSING_SURETY' },
  locationOfGoods: { code: 'MISSING_LOCATION_OF_GOODS' },
  entryPort: { code: 'PORT_UNKNOWN' },
};

/** Broker inputs that fail the XSD rules and have no dedicated MISSING_* code. */
function invalidInputIssues(bi: CheckedBrokerInputs, bag: IssueBag): void {
  for (const inv of bi.invalid) {
    if (INVALID_INPUT_CODE[inv.field]) continue; // reported by the matching MISSING_* / PORT_UNKNOWN issue
    bag.add(
      makeIssue(
        'BROKER_INPUT_INVALID',
        inv.field,
        'blocker',
        'format',
        `Broker input "${inv.field}" is invalid: ${inv.value}`,
        `The value was not used because NetCHB would reject it: ${inv.reason}.${
          inv.field === 'entryType' ? ' Entry type 01 (consumption) is used until it is corrected.' : ''
        }`,
        `Correct ${inv.field} in the broker inputs.`,
        { field: `brokerInputs.${inv.field}` },
      ),
    );
  }
}

function invalidNote(bi: CheckedBrokerInputs, field: InvalidInput['field']): string {
  const inv = bi.invalid.find((i) => i.field === field);
  return inv ? ` The value entered ("${inv.value}") was rejected: ${inv.reason}.` : '';
}

/** Appends a note to the input issue that carries a decision key. */
function noteOnDecision(issues: Issue[], key: string, note: string): Issue[] {
  return issues.map((i) => (i.decision?.key === key ? { ...i, detail: `${i.detail} ${note}` } : i));
}

/** Assembles the NetCHB entry model, valuations, issues and estimates for one shipment. */
export const assembleEntry: AssembleFn = (input: AssembleInput): AssembleOutput => {
  const { shipment, lookups } = input;
  const classifications: Record<string, LineClassification> = input.classifications ?? {};
  const altClassifications: Record<string, LineClassification> = input.altClassifications ?? {};
  const bi = checkBrokerInputs(input.brokerInputs);
  const bag = new IssueBag();
  const t = shipment.transport;

  // ── Decisions ────────────────────────────────────────────────────────────
  const dec = resolveDecisions(input.issues ?? [], input.brokerInputs?.decisions);
  let inputIssues = dec.issues;
  for (const r of dec.rejected) inputIssues = noteOnDecision(inputIssues, r.key, `Broker choice "${r.value}" ignored: ${r.reason}.`);
  const lines = effectiveLines(shipment, classifications, altClassifications, dec.chosen, input.overrideClassifications ?? {});
  for (const l of lines) for (const n of l.notes) inputIssues = noteOnDecision(inputIssues, n.key, n.note);
  // A broker-entered arrival date replaces the estimate, so the "arrival is estimated" warning no longer applies.
  if (bi.arrivalDate) inputIssues = inputIssues.filter((i) => i.code !== 'ARRIVAL_ESTIMATED');
  const decisionKeysInUse = new Set(inputIssues.map((i) => i.decision?.key).filter((k): k is string => !!k));

  // ── Valuation ────────────────────────────────────────────────────────────
  const valuations: LineValuation[] = [];
  const exactValues: Record<string, number> = {};
  const enteredValues: Record<string, number> = {};
  const unconverted = new Set<string>();
  let chargesUsd = 0;
  const usdRate = (currency: string): number | undefined =>
    !currency || currency.toUpperCase() === 'USD' ? 1 : bi.exchangeRates[currency.toUpperCase()];

  shipment.invoices.forEach((inv, i) => {
    const invLines = lines.filter((l) => l.invoiceIndex === i);
    const r = valueInvoice({
      currency: inv.currency || 'USD',
      incoterm: inv.incoterm,
      linesAreFob: inv.linesAreFob,
      charges: inv.charges,
      discountsDeducted: inv.discountsDeducted === true,
      lines: invLines.map((l) => ({
        lineId: l.line.id,
        amount: l.amount,
        amountLabel: l.amountLabel,
        noCommercialValue: l.line.noCommercialValue,
        customsValue: l.line.customsValue,
        assists: l.line.assists,
      })),
    });
    valuations.push(...r.valuations);
    Object.assign(exactValues, r.exactValues);
    for (const v of r.valuations) enteredValues[v.lineId] = v.enteredValue;
    const rate = usdRate(inv.currency);
    const fi = inv.charges.filter((c) => c.type === 'freight' || c.type === 'insurance').reduce((s, c) => s + Math.abs(c.amount), 0);
    if (rate === undefined) unconverted.add(inv.currency.toUpperCase());
    else chargesUsd += fi * rate;
  });

  // ── Ports ────────────────────────────────────────────────────────────────
  const unladingLookup = t.portOfUnlading ? lookups.usPortCode(t.portOfUnlading) : null;
  const unladingCode = unladingLookup && PATTERNS.port.test(unladingLookup.code) ? unladingLookup.code : undefined;
  const entryPort = bi.entryPort ?? unladingCode;
  if (!entryPort) {
    bag.add(
      makeIssue(
        'PORT_UNKNOWN',
        undefined,
        'blocker',
        'missing_data',
        'U.S. port of entry unknown',
        `${
          t.portOfUnlading
            ? `Port of discharge "${t.portOfUnlading}" could not be matched to a CBP Schedule D port code.`
            : 'No U.S. port of discharge was found on the documents.'
        }${invalidNote(bi, 'entryPort')} Entry and processing port are required, so the XML will not validate until a port is entered.`,
        'Enter the 4-digit Schedule D port of entry in the broker inputs.',
        { field: 'header.entryPort' },
      ),
    );
  } else if (bi.invalid.some((x) => x.field === 'entryPort')) {
    bag.add(
      makeIssue('PORT_UNKNOWN', undefined, 'blocker', 'format', 'Entry port input invalid', `${invalidNote(bi, 'entryPort').trim()} The port from the documents (${entryPort}) is used.`, 'Correct the entry port.', {
        field: 'header.entryPort',
      }),
    );
  }

  const countryExport = toIso2(shipment.countryOfExport, lookups);
  // Schedule K codes are for vessel lading only: CBP Form 7501 Block 19 (rev. 02/26) says to leave the
  // foreign port of lading blank "when merchandise is transported by a mode of transportation other
  // than vessel". Schedule K lists no airports, so an airport city that shares a sea port's name must
  // not get that sea port's code.
  const vesselMode = t.mode === 'ocean' || t.mode === 'unknown';
  const ladingLookup = vesselMode && t.portOfLading ? lookups.foreignPortCode(t.portOfLading, countryExport) : null;
  const ladingPort = ladingLookup && PATTERNS.foreignPort.test(ladingLookup.code) ? ladingLookup.code : undefined;
  if (!vesselMode) {
    bag.add(
      makeIssue(
        'LADING_PORT_UNKNOWN',
        undefined,
        'info',
        'missing_data',
        `No foreign port of lading for ${t.mode} shipments`,
        `${t.portOfLading ? `${t.mode === 'air' ? 'Airport of departure' : 'Place of loading'}: "${t.portOfLading}". ` : ''}CBP Schedule K lists sea ports only, and the CBP Form 7501 instructions (Block 19, Foreign Port of Lading) say to leave it blank when the merchandise is transported by a mode other than vessel, so lading-port is omitted from the line items.`,
        `No action for ${t.mode === 'air' ? 'an air' : `a ${t.mode}`} shipment: leave the foreign port of lading blank in NetCHB. Only if the goods actually crossed on a vessel (e.g. sea-air), enter that sea port's Schedule K code.`,
        { field: 'invoices[].lineItems[].ladingPort' },
      ),
    );
  } else if (!ladingPort) {
    bag.add(
      makeIssue(
        'LADING_PORT_UNKNOWN',
        undefined,
        'warning',
        'missing_data',
        'Foreign port of lading not coded',
        t.portOfLading
          ? `Port of loading "${t.portOfLading}" could not be matched to a CBP Schedule K code, so lading-port is omitted from the line items.`
          : 'No port of loading was found on the documents, so lading-port is omitted from the line items.',
        `Look up the 5-digit Schedule K code for the port where the goods were laden on the vessel and add it in NetCHB; if that port is not listed, CBP Form 7501 Block 19 says to use the "all other ports" code of ${
          countryExport ? `the lading country (${countryExport})` : 'the lading country'
        }.`,
        { field: 'invoices[].lineItems[].ladingPort' },
      ),
    );
  }

  // ── Dates ────────────────────────────────────────────────────────────────
  const docArrival = isIsoDate(t.arrivalDate?.value) ? t.arrivalDate!.value : undefined;
  const arrivalDate = bi.arrivalDate ?? docArrival;
  const exportDate = isIsoDate(t.exportDate?.value) ? t.exportDate!.value : undefined;
  let entryDate = bi.entryDate;
  if (!entryDate) {
    entryDate = arrivalDate ?? todayIso();
    bag.add(
      makeIssue(
        'ENTRY_DATE_DEFAULTED',
        undefined,
        'info',
        'assumption',
        `Entry date defaulted to ${entryDate}`,
        arrivalDate
          ? `No entry date was given, so the ${bi.arrivalDate ? 'broker-entered' : t.arrivalDateEstimated ? 'estimated' : 'documented'} arrival date is used.`
          : 'No entry date or arrival date is known, so the date of generation is used.',
        'Set the entry date in the broker inputs if the entry will be filed on a different date.',
        { field: 'header.entryDate' },
      ),
    );
  }

  // ── Weights ──────────────────────────────────────────────────────────────
  const plGross = lines.reduce((s, l) => s + (l.line.grossWeightKg?.value ?? 0), 0);
  let headerGross = shipment.grossWeightKg?.value;
  if (dec.chosen.grossWeight === 'packing_list' && plGross > 0) headerGross = plGross;
  if ((headerGross === undefined || headerGross <= 0) && plGross > 0) headerGross = plGross;
  const grossByLine = lineGrossWeights(lines, headerGross, exactValues);

  // ── Importer / consignee ─────────────────────────────────────────────────
  const importerAddr = shipment.importer?.value;
  const importerName = bi.importerName ?? importerAddr?.name;
  const importerTaxId = bi.importerTaxId ?? validTaxId(importerAddr?.taxId);
  const ucAddr = shipment.ultimateConsignee?.value ?? importerAddr;
  const ucSameAsImporter = !ucAddr || !importerAddr || nameKey(ucAddr.name) === nameKey(importerAddr.name);
  const ucTaxId = bi.ultimateConsigneeTaxId ?? validTaxId(ucAddr?.taxId) ?? (ucSameAsImporter ? importerTaxId : undefined);

  if (!importerTaxId && bi.entryType !== '86') {
    bag.add(
      makeIssue(
        'MISSING_IMPORTER_ID',
        undefined,
        'blocker',
        'missing_data',
        'Importer of record number missing',
        `The documents carry no IRS/CBP number for the importer of record${importerName ? ` (${importerName})` : ''}. CBP requires it for this entry type, and NetCHB matches the importer by this tax ID.${invalidNote(bi, 'importerTaxId')}`,
        'Enter the importer of record number (EIN NN-NNNNNNN with suffix, CBP-assigned NNNNNN-NNNNN, or SSN) in the broker inputs.',
        { field: 'header.importerTaxId', evidence: evidenceOf(shipment.importer, importerName ?? '') },
      ),
    );
  }
  if (!ucSameAsImporter && !ucTaxId) {
    bag.add(
      makeIssue(
        'MISSING_CONSIGNEE_ID',
        undefined,
        bi.invalid.some((x) => x.field === 'ultimateConsigneeTaxId') ? 'blocker' : 'warning',
        'missing_data',
        'Ultimate consignee tax ID missing',
        `The ultimate consignee (${ucAddr?.name}) differs from the importer of record and has no tax ID on the documents.${invalidNote(bi, 'ultimateConsigneeTaxId')}`,
        'Enter the ultimate consignee tax ID in the broker inputs (or confirm the consignee is the importer).',
        { field: 'header.ultimateConsignee.taxId', evidence: evidenceOf(shipment.ultimateConsignee, ucAddr?.name ?? '') },
      ),
    );
  }

  // ── Bond / surety / FIRMS ────────────────────────────────────────────────
  if (!bi.bondType) {
    bag.add(
      makeIssue(
        'MISSING_BOND',
        undefined,
        'blocker',
        'missing_data',
        'Bond type missing',
        `A formal entry needs a customs bond; the bond is known only to the broker/importer.${invalidNote(bi, 'bondType')}`,
        'Select the bond type (08 continuous, 09 single transaction, 00 no bond required) in the broker inputs.',
        { field: 'header.bondType' },
      ),
    );
  }
  const needsSurety = !bi.bondType || (BOND_TYPES_NEEDING_SURETY as readonly string[]).includes(bi.bondType);
  if (needsSurety && !bi.suretyCode) {
    bag.add(
      makeIssue(
        'MISSING_SURETY',
        undefined,
        'blocker',
        'missing_data',
        'Surety code missing',
        `${bi.bondType ? `Bond type ${bi.bondType} is secured by a surety` : 'The bond (once selected) is secured by a surety'}; the 3-digit CBP surety code is not on the documents.${invalidNote(bi, 'suretyCode')}`,
        'Enter the surety code of the bond in the broker inputs.',
        { field: 'header.suretyCode' },
      ),
    );
  }
  if (!bi.locationOfGoods) {
    const invalid = bi.invalid.some((x) => x.field === 'locationOfGoods');
    bag.add(
      makeIssue(
        'MISSING_LOCATION_OF_GOODS',
        undefined,
        invalid ? 'blocker' : 'warning',
        'missing_data',
        'Location of goods (FIRMS code) missing',
        `The FIRMS code of the facility holding the goods (terminal/CFS/CES) is not on the documents; it is usually on the arrival notice.${invalidNote(bi, 'locationOfGoods')}`,
        'Enter the 4-character FIRMS code in the broker inputs.',
        { field: 'header.locationOfGoods' },
      ),
    );
  }
  invalidInputIssues(bi, bag);

  // ── Line items + invoices ────────────────────────────────────────────────
  const midUses: MidUse[] = [];
  const invoices: EntryInvoice[] = shipment.invoices.map((inv, i) => {
    const raw = inv.invoiceNumber.value ?? '';
    const norm = normalizeInvoiceNo(raw);
    if (!norm.value) {
      bag.add(
        makeIssue(
          'XSD_INVALID',
          `invoices[${i}].invoiceNo`,
          'blocker',
          'missing_data',
          `Invoice ${i + 1}: invoice number missing`,
          'invoice-no is required ([A-Za-z0-9-]{1,17}) and none was read from the documents.',
          'Enter the commercial invoice number.',
          { field: `invoices[${i}].invoiceNo` },
        ),
      );
    } else if (norm.changed) {
      bag.add(
        makeIssue(
          'INVOICE_NO_NORMALIZED',
          shipment.invoices.length > 1 ? `inv${i}` : undefined,
          'info',
          'format',
          `Invoice number normalized: ${raw} → ${norm.value}`,
          'NetCHB invoice numbers may contain only letters, digits and "-" (max 17 characters), so other characters were replaced with "-".',
          'No action, unless your records use a different form of this invoice number.',
          { field: `invoices[${i}].invoiceNo`, evidence: evidenceOf(inv.invoiceNumber, raw) },
        ),
      );
    }

    const currency = (inv.currency || 'USD').toUpperCase();
    let foreignCurrency: EntryInvoice['foreignCurrency'];
    if (currency !== 'USD') {
      const rate = bi.exchangeRates[currency];
      const countryCode = currencyCountryCode(currency, countryExport, [
        toIso2((shipment.seller ?? inv.seller)?.country, lookups),
        ...shipment.manufacturers.map((m) => toIso2(m.country, lookups)),
        ...lines.filter((l) => l.invoiceIndex === i).map((l) => toIso2(l.line.countryOfOrigin.value, lookups)),
      ]);
      foreignCurrency = { currencyCode: currency, exchangeRate: rate, ...(countryCode ? { currencyCountryCode: countryCode } : {}) };
      bag.add(
        makeIssue(
          'CURRENCY_CONVERSION',
          shipment.invoices.length > 1 ? `inv${i}` : undefined,
          'warning',
          'valuation',
          `Invoice ${norm.value || i + 1} is in ${currency}`,
          rate
            ? `Values are sent in ${currency} with the broker-entered exchange rate ${rate} USD/${currency}.`
            : `Values are sent in ${currency} without an exchange rate (foreign-currency currency-code${
                countryCode ? ` + currency-country-code ${countryCode}` : ''
              }). Per the NetCHB schema notes NetCHB fills the rate for the export date${
                countryCode ? '' : ', but it needs the currency country code, which could not be derived'
              }. Assumption (unverified): tariff values are interpreted in the invoice currency and converted by NetCHB. Header total entry value, charges and the duty/fee estimates exclude this invoice.`,
          'Verify the exchange rate NetCHB applies (CBP certified rate for the date of exportation) before filing.',
          { field: `invoices[${i}].foreignCurrency`, evidence: evidenceDoc(inv.docId, currency) },
        ),
      );
    }

    const invLines = lines.filter((l) => l.invoiceIndex === i);
    const lineItems = invLines.map((l, idx) => {
      const extra = [classifications[l.line.id], altClassifications[l.line.id]].filter((c): c is LineClassification => !!c);
      const { item, mid } = buildLineItem(
        l,
        idx,
        {
          shipment,
          lookups,
          bag,
          explicit: dec.explicit,
          decisionKeysInUse,
          exportDate,
          countryExport,
          ladingPort,
          grossByLine,
          enteredValues,
        },
        extra,
      );
      midUses.push(mid);
      return item;
    });

    return {
      invoiceNo: norm.value,
      relatedParty: inv.relatedParty.value || undefined,
      foreignCurrency,
      lineItems,
    };
  });
  midIssues(midUses, bag);

  // ── Header ───────────────────────────────────────────────────────────────
  const tariffNos = invoices.flatMap((i) => i.lineItems.map((li) => li.tariffs[0]?.tariffNo ?? '')).filter(Boolean);
  const allUsd = unconverted.size === 0;
  const totalEntryValueUsd = shipment.invoices.reduce((sum, inv, i) => {
    const rate = usdRate(inv.currency) ?? 0;
    return sum + lines.filter((l) => l.invoiceIndex === i).reduce((s, l) => s + (enteredValues[l.line.id] ?? 0) * rate, 0);
  }, 0);
  const voyage = voyageNo(t);
  if (voyage.dropped) {
    bag.add(
      makeIssue(
        'FIELD_OMITTED',
        'header.voyageNo',
        'info',
        'format',
        `Voyage/flight number "${voyage.dropped}" omitted`,
        `NetCHB voyage-no allows at most ${MAX_LEN.voyageNo} characters, so the element is left out (the XML stays valid).`,
        'Enter the voyage number in NetCHB in the form CBP expects for this carrier.',
        { field: 'header.voyageNo' },
      ),
    );
  }
  const firstPo = shipment.invoices.flatMap((i) => [...i.poNumbers, ...i.lines.map((l) => l.poNumber ?? '')]).find(Boolean);
  const stateDest =
    (t.destinationState && US_STATES.has(t.destinationState.toUpperCase()) ? t.destinationState.toUpperCase() : undefined) ??
    stateFromAddress(shipment.shipTo, lookups) ??
    stateFromAddress(ucAddr, lookups);

  const header: EntryHeader = {
    importerTaxId,
    importerName,
    ultimateConsignee: ucTaxId || ucAddr?.name ? { taxId: ucTaxId, consigneeName: ucAddr?.name } : undefined,
    processingPort: entryPort ?? '',
    entryPort: entryPort ?? '',
    entryDate,
    entryType: bi.entryType,
    bondType: bi.bondType,
    paymentType: bi.paymentType,
    charges: allUsd && chargesUsd >= 0.5 ? Math.round(chargesUsd) : undefined,
    grossWeight: headerGross && headerGross > 0 ? Math.max(1, Math.round(headerGross)) : undefined,
    totalEntryValue: allUsd && totalEntryValueUsd >= 1 ? Math.round(totalEntryValueUsd) : undefined,
    description: headerDescription(
      tariffNos,
      lines.map((l) => l.line.description),
    ),
    suretyCode: bi.suretyCode,
    stateDestination: stateDest,
    vesselName: t.vessel ? truncateWords(t.vessel.toUpperCase(), MAX_LEN.vesselName) : undefined,
    modeTransportation: modeOfTransport(t),
    unladingPort: unladingCode ?? entryPort,
    importDate: arrivalDate,
    arrivalDate,
    carrierCode: carrierCode(shipment),
    brokerReferenceNo: bi.brokerReference,
    customerReferenceNo: firstPo ? truncateWords(firstPo, MAX_LEN.customerReferenceNo) : undefined,
    voyageNo: voyage.value,
    locationOfGoods: bi.locationOfGoods,
  };

  // ── Manifest, containers, parties ────────────────────────────────────────
  const billsOfLading = buildBills(shipment, bag);
  const containers = buildContainers(shipment);
  const firstInvoice = shipment.invoices[0];
  const manufacturers = [...shipment.manufacturers, ...lines.map((l) => l.line.manufacturer).filter((m): m is Address => !!m)];
  const { parties, skipped } = buildCargoReleaseParties(
    {
      seller: shipment.seller ?? firstInvoice?.seller,
      buyer: firstInvoice?.buyer ?? importerAddr,
      shipTo: shipment.shipTo ?? firstInvoice?.shipTo,
      consolidator: shipment.consolidator,
      manufacturers,
    },
    lookups,
  );
  const importantSkips = skipped.filter((s) => s.code !== 'MF' || !/no room/.test(s.reason));
  if (importantSkips.length) {
    bag.add(
      makeIssue(
        'FIELD_OMITTED',
        'cargoReleaseParties',
        importantSkips.some((s) => s.code === 'SE' || s.code === 'BY') ? 'warning' : 'info',
        'missing_data',
        'Some cargo release parties were not sent',
        `Without party IDs NetCHB needs a full address (street, city, country). Not sent: ${importantSkips
          .map((s) => `${s.code} ${s.name} (${s.reason})`)
          .join('; ')}.`,
        'Complete these parties in NetCHB (address or DUNS) if the cargo release needs them; seller (SE) and buyer (BY) are required for ACE cargo release.',
        { field: 'cargoReleaseParties' },
      ),
    );
  }

  // ── Compliance notes ─────────────────────────────────────────────────────
  const origins = [...new Set(invoices.flatMap((i) => i.lineItems.map((li) => li.countryOrigin)).filter(Boolean))];
  const autoApply = bi.autoApplyRemedies;
  bag.add(
    makeIssue(
      'CHAPTER_99_NOT_COMPUTED',
      undefined,
      'warning',
      'compliance',
      'Chapter 99 additional duties not computed',
      `Additional Chapter 99 duties (e.g. reciprocal/IEEPA, Section 122/232/301 measures) for origin${origins.length > 1 ? 's' : ''} ${
        origins.join(', ') || 'unknown'
      } as of entry date ${entryDate} are not computed by this app.${
        autoApply ? ' NetCHB auto-apply-remedies is enabled, so NetCHB will add the trade remedies it finds for single-tariff lines.' : ''
      }`,
      'Verify the applicable Chapter 99 provisions against current CBP CSMS guidance for these origins and the entry date before filing.',
      { field: 'invoices[].lineItems[].tariffs' },
    ),
  );
  bag.add(
    autoApply
      ? makeIssue(
          'AUTO_REMEDIES',
          undefined,
          'info',
          'compliance',
          'auto-apply-remedies is on',
          'The XML includes <auto-apply-remedies/>: NetCHB applies the trade remedies it finds to lines with a single tariff.',
          'Review the remedies NetCHB applied before transmitting; turn the option off in the broker inputs to declare them manually.',
          { field: 'autoApplyRemedies' },
        )
      : makeIssue(
          'AUTO_REMEDIES',
          undefined,
          'warning',
          'compliance',
          'auto-apply-remedies is off',
          'NetCHB will not add Chapter 99 trade remedies automatically.',
          'Add any applicable Chapter 99 tariff lines manually in NetCHB.',
          { field: 'autoApplyRemedies' },
        ),
  );

  const entryModel: EntryModel = {
    entryNo: { kind: 'system' },
    autoApplyRemedies: autoApply,
    header,
    manifest: { billsOfLading },
    containers,
    cargoReleaseParties: parties,
    invoices,
  };

  // ── Estimates ────────────────────────────────────────────────────────────
  const estimates = computeEstimates({
    lines: lines.map((l: EffectiveLine) => {
      const rate = usdRate(l.invoice.currency);
      const entered = enteredValues[l.line.id] ?? 0;
      return {
        lineId: l.line.id,
        htsNumber: l.classification?.htsNumber ?? '',
        enteredValue: entered,
        enteredValueUsd: rate === undefined ? undefined : entered * rate,
        ratePct: l.classification?.adValoremPct,
      };
    }),
    fees: lookups.feeConfig(),
    ocean: t.mode === 'ocean',
    unconvertedCurrencies: [...unconverted],
  });

  const assembled = bag.list();
  const assembledIds = new Set(assembled.map((i) => i.id));
  return {
    entryModel,
    issues: [...inputIssues.filter((i) => !assembledIds.has(i.id)), ...assembled],
    valuations,
    estimates,
  };
};
