/**
 * Checks broker-entered values against the XSD lexical rules before they are
 * used, so a typo becomes a blocker the broker can fix instead of an XML that
 * NetCHB rejects.
 */
import type { BrokerInputs } from '@app/shared';
import { BOND_TYPES, ENTRY_TYPES, MAX_LEN, PATTERNS, PAYMENT_TYPES } from './enums';
import { collapse, isIsoDate } from './normalize';

export type BrokerField = keyof BrokerInputs;

export interface InvalidInput {
  field: BrokerField;
  value: string;
  reason: string;
}

export interface CheckedBrokerInputs {
  importerTaxId?: string;
  importerName?: string;
  ultimateConsigneeTaxId?: string;
  bondType?: string;
  suretyCode?: string;
  paymentType?: string;
  entryType: string;
  entryPort?: string;
  locationOfGoods?: string;
  entryDate?: string;
  arrivalDate?: string;
  autoApplyRemedies: boolean;
  brokerReference?: string;
  exchangeRates: Record<string, number>;
  invalid: InvalidInput[];
}

const TAX_ID_HINT = 'expected NN-NNNNNNN or NN-NNNNNNNXX (IRS EIN + suffix), NNNNNN-NNNNN (CBP-assigned) or NNN-NN-NNNN (SSN)';

/** Validates and normalizes broker inputs; invalid values are dropped and reported. */
export function checkBrokerInputs(raw: BrokerInputs | undefined): CheckedBrokerInputs {
  const b = raw ?? {};
  const invalid: InvalidInput[] = [];
  const str = (v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const s = collapse(String(v));
    return s ? s : undefined;
  };
  const check = (field: BrokerField, ok: (v: string) => boolean, reason: string, transform: (v: string) => string = (v) => v) => {
    const v = str(b[field]);
    if (v === undefined) return undefined;
    const t = transform(v);
    if (ok(t)) return t;
    invalid.push({ field, value: v, reason });
    return undefined;
  };

  const importerTaxId = check('importerTaxId', (v) => PATTERNS.taxId.test(v), TAX_ID_HINT);
  const ultimateConsigneeTaxId = check('ultimateConsigneeTaxId', (v) => PATTERNS.taxId.test(v), TAX_ID_HINT);
  const bondType = check(
    'bondType',
    (v) => (BOND_TYPES as readonly string[]).includes(v),
    `bond type must be one of ${BOND_TYPES.join(', ')} (00 = no bond, 08 = continuous, 09 = single transaction)`,
    (v) => (/^\d$/.test(v) ? `0${v}` : v),
  );
  const suretyCode = check('suretyCode', (v) => /^[A-Za-z0-9]{1,3}$/.test(v), 'surety code is at most 3 characters (CBP 3-digit surety code)');
  const paymentType = check(
    'paymentType',
    (v) => (PAYMENT_TYPES as readonly string[]).includes(v),
    `payment type must be one of ${PAYMENT_TYPES.join(', ')}`,
  );
  const entryTypeChecked = check(
    'entryType',
    (v) => (ENTRY_TYPES as readonly string[]).includes(v),
    'entry type must be a 2-digit CBP entry type code (e.g. 01, 11, 86)',
    (v) => (/^\d$/.test(v) ? `0${v}` : v),
  );
  const entryPort = check('entryPort', (v) => PATTERNS.port.test(v), 'port must be a 4-digit CBP Schedule D code', (v) => v.replace(/\D/g, ''));
  const locationOfGoods = check(
    'locationOfGoods',
    (v) => /^[A-Za-z0-9]{1,4}$/.test(v),
    'location of goods must be a FIRMS code of at most 4 characters',
    (v) => v.toUpperCase(),
  );
  const entryDate = check('entryDate', isIsoDate, 'date must be YYYY-MM-DD');
  const arrivalDate = check('arrivalDate', isIsoDate, 'date must be YYYY-MM-DD');
  const brokerReference = check(
    'brokerReference',
    (v) => v.length <= MAX_LEN.brokerReferenceNo,
    `broker reference is at most ${MAX_LEN.brokerReferenceNo} characters`,
  );

  const exchangeRates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(b.exchangeRates ?? {})) {
    const c = code.toUpperCase().trim();
    if (PATTERNS.currencyCode.test(c) && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) exchangeRates[c] = rate;
    else invalid.push({ field: 'exchangeRates', value: `${code}=${rate}`, reason: 'exchange rate must be a positive number keyed by an ISO 4217 code' });
  }

  return {
    importerTaxId,
    importerName: str(b.importerName),
    ultimateConsigneeTaxId,
    bondType,
    suretyCode,
    paymentType,
    entryType: entryTypeChecked ?? '01',
    entryPort,
    locationOfGoods,
    entryDate,
    arrivalDate,
    autoApplyRemedies: b.autoApplyRemedies !== false,
    brokerReference,
    exchangeRates,
    invalid,
  };
}
