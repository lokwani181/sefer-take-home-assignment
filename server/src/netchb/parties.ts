/**
 * Header-level ACE cargo release parties (entry.xsd ace-cargo-release-parties,
 * max 5 entities). Parties are sent with an entity-address (no IDs are known),
 * which the XSD allows for every code except CN (CN requires a tax-id entity-id,
 * so it is never emitted). A seller without a usable address falls back to
 * selling-party-mid, which the XSD allows for SE only.
 */
import type { Address, EntryEntity, ReferenceLookups } from '@app/shared';
import { MAX_LEN, US_STATES } from './enums';
import { chunkWords, collapse, nameKey, truncateWords } from './normalize';

export const MAX_PARTIES = 5;

export interface PartyResult {
  entity?: EntryEntity;
  /** Why the party could not be sent. */
  problem?: string;
}

function countryOf(addr: Address, lookups: ReferenceLookups): string | undefined {
  const c = collapse(addr.country);
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  if (c) return lookups.countryCode(c) ?? undefined;
  return undefined;
}

function stateCode(addr: Address, country: string, lookups: ReferenceLookups): string | undefined {
  const s = collapse(addr.stateProvince);
  if (!s) return undefined;
  if (country === 'US') {
    if (US_STATES.has(s.toUpperCase())) return s.toUpperCase();
    return lookups.usStateCode(s) ?? undefined;
  }
  return /^[A-Za-z0-9]{1,3}$/.test(s) ? s.toUpperCase() : undefined;
}

const LEGAL_ABBREVIATIONS: [RegExp, string][] = [
  [/\bJOINT[\s-]+STOCK\s+COMPANY\b/gi, 'JSC'],
  [/\bLIMITED\b/gi, 'LTD'],
  [/\bCOMPANY\b/gi, 'CO'],
  [/\bCORPORATION\b/gi, 'CORP'],
  [/\bINCORPORATED\b/gi, 'INC'],
  [/\bPRIVATE\b/gi, 'PVT'],
  [/\bINTERNATIONAL\b/gi, 'INTL'],
];

/** Fits a party name into entity-name (35 chars): abbreviate legal suffixes first, then cut at a word. */
export function entityName(name: string): string {
  let n = collapse(name);
  for (const [re, abbr] of LEGAL_ABBREVIATIONS) {
    if (n.length <= MAX_LEN.entityName) break;
    n = n.replace(re, abbr);
  }
  return truncateWords(n, MAX_LEN.entityName);
}

/** Builds an entity-address entity from a parsed Address, or explains why it can't. */
export function entityFromAddress(code: EntryEntity['entityCode'], addr: Address, lookups: ReferenceLookups): PartyResult {
  const name = entityName(addr.name);
  if (!name) return { problem: 'no name' };
  const country = countryOf(addr, lookups);
  const city = truncateWords(addr.city ?? '', MAX_LEN.city);
  const components = addr.lines.flatMap((l) => chunkWords(l, MAX_LEN.addressInformation)).slice(0, 6);
  const missing = [!components.length && 'street address', !city && 'city', !country && 'country'].filter(Boolean);
  if (missing.length) return { problem: `address incomplete (missing ${missing.join(', ')})` };
  const postal = collapse(addr.postalCode);
  return {
    entity: {
      entityCode: code,
      entityName: name,
      address: {
        addressComponents: components,
        city,
        stateProvinceCode: stateCode(addr, country!, lookups),
        postalCode: postal && postal.length <= MAX_LEN.postalCode ? postal : undefined,
        country: country!,
      },
    },
  };
}

export interface PartyInputs {
  seller?: Address;
  buyer?: Address;
  shipTo?: Address;
  consolidator?: Address;
  manufacturers: Address[];
}

export interface PartiesResult {
  parties: EntryEntity[];
  /** Parties that were identified but not sent, with the reason. */
  skipped: { code: EntryEntity['entityCode']; name: string; reason: string }[];
}

/**
 * Picks up to 5 parties: SE and BY first (ACE requires them for cargo release),
 * then ST and CS, then manufacturers while there is room. Emitted in the order
 * SE, BY, ST, MF…, CS.
 */
export function buildCargoReleaseParties(input: PartyInputs, lookups: ReferenceLookups): PartiesResult {
  const skipped: PartiesResult['skipped'] = [];
  const tryParty = (code: EntryEntity['entityCode'], addr: Address | undefined): EntryEntity | undefined => {
    if (!addr?.name) return undefined;
    const r = entityFromAddress(code, addr, lookups);
    if (r.entity) return r.entity;
    if (code === 'SE') {
      const mid = lookups.buildMid(addr)?.mid;
      if (mid && mid.length <= MAX_LEN.manufacturerId) return { entityCode: 'SE', entityName: entityName(addr.name), sellingPartyMid: mid };
    }
    skipped.push({ code, name: addr.name, reason: r.problem ?? 'unusable address' });
    return undefined;
  };

  const se = tryParty('SE', input.seller);
  const by = tryParty('BY', input.buyer);
  const sameAsBuyer = (a?: Address) => !!a && !!input.buyer && nameKey(a.name) === nameKey(input.buyer.name);
  const st = sameAsBuyer(input.shipTo) ? undefined : tryParty('ST', input.shipTo);
  const cs = tryParty('CS', input.consolidator);

  const fixed = [se, by, st, cs].filter((e): e is EntryEntity => !!e);
  const seen = new Set<string>();
  const mfs: EntryEntity[] = [];
  for (const m of input.manufacturers) {
    const key = nameKey(m.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (fixed.length + mfs.length >= MAX_PARTIES) {
      skipped.push({ code: 'MF', name: m.name, reason: `no room (max ${MAX_PARTIES} parties); reported via line manufacturer-id` });
      continue;
    }
    const mf = tryParty('MF', m);
    if (mf) mfs.push(mf);
  }
  const parties = [se, by, st, ...mfs, cs].filter((e): e is EntryEntity => !!e);
  return { parties, skipped };
}
