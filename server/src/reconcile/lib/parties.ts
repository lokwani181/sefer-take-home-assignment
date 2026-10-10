/** Party heuristics: logistics providers, "for account of" clauses, same-party checks. */
import type { Address } from '@app/shared';
import { clean, sameCompany } from './text';

const LOGISTICS_NAME_RE =
  /\b(FULFIL+MENT|LOGISTICS?|WAREHOUS(?:E|ES|ING)|3PL|3-PL|THIRD[- ]PARTY LOGISTICS|DISTRIBUTION(?: CENT(?:ER|RE))?|DC|FORWARD(?:ER|ERS|ING)|FREIGHT|SHIPPING|TRANSPORT(?:ATION|S)?|CARGO|CUSTOMS BROKER(?:S|AGE)?|STORAGE|DEPOT|TERMINAL|SUPPLY CHAIN|CFS|CONSOLIDAT\w*|COLD CHAIN|EXPEDIT(?:OR|ORS|ING))\b/i;

const ACCOUNT_OF_RE = /\b(?:for (?:the )?account of|f\/a\/o|fao|c\/o|care of|on behalf of|for the benefit of)\s*[:-]?\s*([^\n]+)/i;

/** Keyword that marks the party as a logistics provider, if any ("FULFILLMENT"). */
export function logisticsKeyword(addr: Address | undefined): string | undefined {
  if (!addr?.name) return undefined;
  return LOGISTICS_NAME_RE.exec(addr.name)?.[1];
}

/** Party named after "for account of" / "c/o" / "on behalf of" in the block, if any. */
export function accountOfParty(addr: Address | undefined): string | undefined {
  if (!addr) return undefined;
  const m = ACCOUNT_OF_RE.exec(addr.raw ?? '') ?? addr.lines.map((l) => ACCOUNT_OF_RE.exec(l)).find(Boolean);
  return m ? clean(m[1]) : undefined;
}

/** Same legal party (name-based; addresses are too noisy across OCR'd documents). */
export function sameParty(a: Address | undefined, b: Address | undefined): boolean {
  return !!a && !!b && sameCompany(a.name, b.name);
}

/** Uppercase name for messages. */
export const partyName = (a: Address | undefined): string => clean(a?.name) || 'unknown party';

/** One-line address for evidence text. */
export function oneLine(a: Address | undefined): string {
  if (!a) return '';
  return clean(a.raw?.replace(/\n/g, ', ')) || [a.name, ...a.lines, a.city, a.stateProvince, a.postalCode, a.country].filter(Boolean).join(', ');
}
