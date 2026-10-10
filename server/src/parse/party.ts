/**
 * Party / address block parsing.
 *
 * Why: parties are printed as free-form blocks ("NAME / street / City, ST 12345, USA /
 * Attn: ... Tel: ..."). Downstream needs name, country, city/state/postal code (US state
 * of destination, MID city), contact and phone. The rules are generic: US "City, ST 12345",
 * a country name or ISO2 at the end of the locality line, street-keyword detection for the
 * remaining comma segments, and contact/phone/tax-id/agent line recognition.
 */
import type { Address } from '@app/shared';
import { countryCode, findCountry, US_STATES } from './countries';
import { asciiRatio, squash, trimSeparators } from './text';

/** An order clause that needs the next line to be complete ("TO THE ORDER OF", "UNTO ORDER OF"). */
const ORDER_CLAUSE_RE = /^(?:(?:UN)?TO\s+(?:THE\s+)?ORDER\s+OF|ORDER\s+OF)\s*[:,]?$/i;
const AGENT_RE = /^(?:ON\s+BEHALF\s+OF|O\/B\b|0\/B\b|FOR\s+(?:THE\s+)?ACCOUNT\s+OF|A\/C\s+OF|AS\s+AGENT\s+(?:FOR|OF)|C\/O\b|CARE\s+OF)/i;
const CONTACT_RE = /\b(?:ATTN|ATTENTION|CONTACT(?:\s+PERSON)?|CONTACT\s+NAME)\b\s*[:.]?\s*(.+?)(?=\s+(?:TEL|PHONE|PH|MOB|MOBILE|CELL|FAX|EMAIL|E-MAIL)\b|$)/i;
const PHONE_LABEL_RE = /\b(?:TEL|TELEPHONE|PHONE|PH|MOB|MOBILE|CELL|RECEIVING|HOTLINE)\s*(?:NO\.?|#)?\s*[:.]?\s*(\+?[\d@OoSlI()][\d@OoSlI()\s.\-/]{5,}[\d@OoSlI])/i;
const BARE_PHONE_RE = /(\+\d{1,3}[\s.-]?(?:\(?\d+\)?[\s.-]?){2,6}\d)/;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const TAX_RE = /\b(?:TAX\s*(?:ID|CODE|NO\.?)|MST(?:\/TAX\s*CODE)?|VAT\s*(?:NO\.?|ID|REG\.?(?:\s*NO\.?)?)|EIN|IRS\s*NO\.?|GST(?:IN)?|USCI|CNPJ|RFC|NIF|TIN|IOR\s*NO\.?|IEC)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{4,})/i;
const STREET_RE = /\d|\b(?:STREET|STR|ST|ROAD|RD|AVENUE|AVE|AV|LANE|LN|BUILDING|BLDG|FLOOR|FLR|FL|UNIT|SUITE|STE|ROOM|RM|LOT|PLOT|PARK|BLOCK|BLK|ZONE|IP|KCN|WARD|DISTRICT|DIST|VILLAGE|HAMLET|COMMUNE|NO|INDUSTRIAL|ESTATE|TOWER|CENTRE|CENTER|DOCK|HIGHWAY|HWY|BOULEVARD|BLVD|DRIVE|DR|WAY|PLAZA|SQUARE|SQ|P\.?O\.?\s*BOX|BOX|STRASSE|STRAßE|CALLE|RUE|VIA|JALAN|JL|SOI|MOO|QUARTER|COMPOUND|MANSION|HOUSE|CENTRE|WAREHOUSE|PIER|TERMINAL|AREA|SECTOR|PHASE|ALLEY|LANE)\b/i;
const LEGAL_SUFFIX_RE = /\b(?:LTD|LIMITED|INC|INCORPORATED|LLC|L\.L\.C|CO|COMPANY|CORP|CORPORATION|JSC|GMBH|AG|S\.?A|S\.?A\.?S|S\.?R\.?L|B\.?V|N\.?V|PLC|PTE|PVT|PTY|LLP|LP|SDN\s+BHD|BHD|KG|OY|AB|AS|SPA|S\.?P\.?A|K\.?K|TNHH|JOINT\s+STOCK\s+COMPANY)\.?,?$/i;

/** Normalizes a phone number read by OCR ("@148" → "0148", "S55" → "555"). */
export function normalizePhone(s: string): string {
  return squash(
    s
      .replace(/[@Oo]/g, '0')
      .replace(/[S]/g, '5')
      .replace(/[lI]/g, '1')
      .replace(/\s*-\s*/g, ' ')
      .replace(/[.]/g, ' '),
  );
}

/** Extracts the first phone number (not fax) from a line. */
export function findPhone(line: string): string | undefined {
  const noFax = line.replace(/\bFAX\b\s*[:.]?\s*\+?[\d()\s.-]{6,}/gi, ' ');
  const m = PHONE_LABEL_RE.exec(noFax) ?? BARE_PHONE_RE.exec(noFax);
  if (!m) return undefined;
  const p = normalizePhone(m[1]);
  return (p.match(/\d/g) ?? []).length >= 7 ? p : undefined;
}

interface Locality {
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
  /** Street segments that preceded the locality on the same line. */
  streetPrefix: string[];
  /** All segments were consumed by city/state (none left for the street). */
  onlyCountry: boolean;
}

const isStreet = (seg: string) => STREET_RE.test(seg);

/**
 * Parses one locality line split into comma segments. `assumeCountry` (a country known from the
 * context, e.g. "MADE IN SRI LANKA - <maker>, <street>, Colombo 09") stands in for a country the
 * line does not print, so its last segments can still be read as city / postal code.
 */
function parseLocality(part: string, assumeCountry?: string): Locality | null {
  const segs = part
    .split(/,|\s{2,}/)
    .map((s) => trimSeparators(s))
    .filter(Boolean);
  if (!segs.length) return null;
  const loc: Locality = { streetPrefix: [], onlyCountry: false };
  // country at the end (name, or ISO2 when it is not a US state); bilingual "Deutschland / Germany"
  const last = segs[segs.length - 1];
  const lastCountry =
    countryCode(last, { allowIso2: !US_STATES.has(last.toUpperCase()) }) ??
    (last.includes('/') ? last.split('/').map((x) => countryCode(x.trim())).find(Boolean) : undefined);
  if (lastCountry) {
    loc.country = lastCountry;
    segs.pop();
  } else {
    const embedded = /^(.*?)[\s.]+([A-Za-z .']+)$/.exec(last);
    const c = embedded ? countryCode(embedded[2]) : undefined;
    // "<country> <postal code>" (city-states and postal-code-after-country styles: "Singapore 018961")
    const countryPostal = /^([A-Za-z][A-Za-z .']+?)\s+(\d{4,6})$/.exec(last);
    const cp = countryPostal ? countryCode(countryPostal[1]) : undefined;
    if (embedded && c && embedded[1].trim()) {
      loc.country = c;
      segs[segs.length - 1] = embedded[1].trim();
    } else if (countryPostal && cp) {
      loc.country = cp;
      loc.postalCode = countryPostal[2];
      segs.pop();
    }
  }
  // US "City, ST 12345" / "City ST 12345"
  const tail = segs[segs.length - 1] ?? '';
  const us = /^(?:(.*?)[\s,]+)?([A-Z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/i.exec(tail);
  if (us && US_STATES.has(us[2].toUpperCase())) {
    loc.stateProvince = us[2].toUpperCase();
    loc.postalCode = us[3];
    if (!loc.country) loc.country = 'US';
    segs.pop();
    if (us[1]) loc.city = trimSeparators(us[1]);
    else if (segs.length) loc.city = segs.pop();
    loc.streetPrefix = segs;
    return loc;
  }
  if (!loc.country && assumeCountry) loc.country = assumeCountry;
  if (!loc.country) return null;
  if (!segs.length) {
    loc.onlyCountry = true;
    return loc;
  }
  // province/state code + postal code: "ON M5H 1A1" (Canada), "NSW 2000", "SP 01310-100"
  const prov = /^(?:(.*?)[\s,]+)?([A-Z]{2,3})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{4,5}(?:-\d{3,4})?)$/.exec(segs[segs.length - 1]);
  if (prov) {
    loc.stateProvince = prov[2];
    loc.postalCode = prov[3];
    segs.pop();
    if (prov[1]) loc.city = trimSeparators(prov[1]);
    else if (segs.length) loc.city = segs.pop();
    loc.streetPrefix = segs;
    return loc;
  }
  // generic postal codes: "20354 Hamburg", "Hamburg 20354", "SW1A 1AA", "400001"
  const pc = (s: string) =>
    /^(\d{4,6}|\d{3}\s\d{3})\s+([^\d].*)$/.exec(s) ??
    /^(.*[^\d\s-])[\s-]+(\d{4,6}|\d{3}\s\d{3})$/.exec(s) ??
    /^([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i.exec(s) ??
    /^(\d{3,6}(?:-\d{3,4})?)$/.exec(s);
  for (let i = segs.length - 1; i >= Math.max(0, segs.length - 3); i--) {
    const m = pc(segs[i]);
    if (!m) continue;
    if (/^\d/.test(m[1]) && m[2]) {
      loc.postalCode = m[1];
      segs[i] = m[2];
    } else if (m[2] && /^\d/.test(m[2])) {
      loc.postalCode = m[2];
      segs[i] = m[1];
    } else {
      loc.postalCode = m[1];
      segs.splice(i, 1);
    }
    break;
  }
  // postal district written after the city: "Colombo 09", "Dublin 2" (not "Tower 2", "Phase 3")
  if (!loc.postalCode && segs.length) {
    const d = /^([A-Za-z][A-Za-z .'-]*[A-Za-z.])\s+(\d{1,2})$/.exec(segs[segs.length - 1]);
    if (d && !isStreet(d[1])) {
      loc.postalCode = d[2];
      segs[segs.length - 1] = d[1];
    }
  }
  const trailing: string[] = [];
  while (segs.length && trailing.length < 2 && !isStreet(segs[segs.length - 1])) trailing.unshift(segs.pop()!);
  if (trailing.length === 2) {
    loc.city = trailing[0];
    loc.stateProvince = trailing[1];
  } else if (trailing.length === 1) loc.city = trailing[0];
  loc.streetPrefix = segs;
  return loc;
}

function cleanName(s: string): string {
  return squash(
    trimSeparators(s)
      .replace(/(?<=[A-Za-z]):(?=\s)/g, '')
      .replace(/\s+[^A-Za-z0-9.)&]+$/, '')
      .replace(/^[^A-Za-z0-9(]+/, ''),
  );
}

export interface ParsePartyOptions {
  /** Mean OCR confidence per input line (used to choose between duplicate locality lines). */
  lineConf?: number[];
  /**
   * ISO2 country known from the context (e.g. the "MADE IN <country>" that introduces a maker).
   * Used only when the block prints no country: its last line is then read as the locality.
   */
  defaultCountry?: string;
}

/**
 * Parses an address block (name first). Unknown structure is kept verbatim in `lines`/`raw`.
 */
export function parseParty(input: string[], opts: ParsePartyOptions = {}): Address {
  const rawLines = input.map((l) => squash(l)).filter(Boolean);
  const raw = rawLines.join('\n');
  const parts: Array<{ text: string; conf: number }> = [];
  rawLines.forEach((l, i) => {
    for (const p of l.split(/\s*\|\s*/)) if (p.trim()) parts.push({ text: p.trim(), conf: opts.lineConf?.[i] ?? 100 });
  });
  const addr: Address = { name: '', lines: [], raw };
  if (!parts.length) return addr;

  // name: first part; a one-line block "Name Ltd., street, city, country" is split at the legal suffix
  let first = parts.shift()!.text;
  // a negotiable bill's order clause on its own line names the order party on the next one:
  // "TO THE ORDER OF" / "CORONADO TRUST BANK" is one name
  if (ORDER_CLAUSE_RE.test(first) && parts.length) first = `${first} ${parts.shift()!.text}`;
  // "Name Ltd., street, city, country" on one line: split at the legal form
  const oneLine = first.split(',').length >= 3 && (!parts.length || !!parseLocality(first));
  if (oneLine && first.includes(',')) {
    const segs = first.split(',').map((s) => s.trim());
    let k = segs.findIndex((s) => LEGAL_SUFFIX_RE.test(s));
    // "CO., LTD." / "CO., INC.": a legal form split by its own comma
    while (k >= 0 && k + 1 < segs.length && /^(?:LTD|LIMITED|INC|LLC|JSC|PLC|CORP|BHD|SDN\s+BHD|PTE\.?\s+LTD|PVT\.?\s+LTD)\.?$/i.test(segs[k + 1])) k++;
    const cut = k >= 0 ? k + 1 : 1;
    addr.name = cleanName(segs.slice(0, cut).join(', '));
    first = segs.slice(cut).join(', ');
    if (first) parts.unshift({ text: first, conf: 100 });
  } else addr.name = cleanName(first);

  const addressParts: Array<{ text: string; conf: number }> = [];
  let localityFound = false;
  let stop = false;
  for (const p of parts) {
    const t = p.text;
    if (AGENT_RE.test(t)) {
      if (localityFound) stop = true;
      continue;
    }
    const contact = CONTACT_RE.exec(t);
    const phone = findPhone(t);
    const tax = TAX_RE.exec(t);
    if (contact && !addr.contact) addr.contact = trimSeparators(contact[1].replace(/\b(?:TEL|PHONE|FAX)\b.*$/i, ''));
    if (phone && !addr.phone) addr.phone = phone;
    if (tax && !addr.taxId) addr.taxId = tax[1];
    // keep the address text that precedes contact/phone/tax/e-mail details on the same line
    const cut = Math.min(
      ...[contact?.index, tax?.index, PHONE_LABEL_RE.exec(t)?.index, EMAIL_RE.exec(t)?.index, /\b(?:FAX|E-?MAIL|WEB|WWW|HTTP)\b/i.exec(t)?.index].filter(
        (x): x is number => x !== undefined,
      ),
    );
    const head = Number.isFinite(cut) ? trimSeparators(t.slice(0, cut)) : t;
    if (stop || !head || !/[A-Za-z0-9]{2,}\S*\s+\S/.test(head)) continue;
    addressParts.push({ ...p, text: head });
    if (parseLocality(head)) localityFound = true;
  }

  // choose the locality line: the first one, unless a later duplicate is clearly cleaner (bilingual letterheads)
  const locIdx = addressParts.map((p, i) => (parseLocality(p.text) ? i : -1)).filter((i) => i >= 0);
  let li = locIdx[0] ?? -1;
  for (const j of locIdx.slice(1)) {
    const a = addressParts[li];
    const b = addressParts[j];
    if (asciiRatio(b.text) * b.conf > asciiRatio(a.text) * a.conf + 5) li = j;
  }
  let loc = li >= 0 ? parseLocality(addressParts[li].text) : null;
  if (li < 0 && opts.defaultCountry && addressParts.length && !findCountry(addressParts.map((p) => p.text).join(', '))) {
    // no country printed, but the context names it: the last line is the locality when it yields a city
    const last = addressParts.length - 1;
    const assumed = parseLocality(addressParts[last].text, opts.defaultCountry);
    if (assumed?.city) {
      li = last;
      loc = assumed;
    }
  }
  if (li < 0 || !loc) {
    // no recognizable locality: keep the lines, try a country anywhere
    addr.lines = addressParts.map((p) => trimSeparators(p.text));
    const c = findCountry(addressParts.map((p) => p.text).join(', '));
    if (c) addr.country = c.iso;
    return addr;
  }
  let before = addressParts.slice(0, li).map((p) => p.text);
  // a duplicate-language address line before a cleaner one is dropped
  if (li > 0 && locIdx[0] < li) before = before.filter((_, i) => !locIdx.includes(i));
  if (loc.onlyCountry && before.length) {
    // "KWUN TONG, KOWLOON" on one line and "HONG KONG" on the next
    const prev = parseLocality(`${before[before.length - 1]}, ${addressParts[li].text}`);
    if (prev && !prev.onlyCountry) {
      before = before.slice(0, -1);
      Object.assign(loc, prev);
    }
  }
  addr.city = loc.city;
  addr.stateProvince = loc.stateProvince;
  addr.postalCode = loc.postalCode;
  addr.country = loc.country;
  const street = [...before.map((b) => trimSeparators(b)), ...(loc.streetPrefix.length ? [loc.streetPrefix.join(', ')] : [])];
  addr.lines = street.filter(Boolean);
  for (const k of ['city', 'stateProvince', 'postalCode', 'country', 'contact', 'phone', 'taxId'] as const) if (!addr[k]) delete addr[k];
  return addr;
}

/** True when the name carries a company legal form (used to pick letterhead name lines). */
export function hasLegalSuffix(s: string): boolean {
  return LEGAL_SUFFIX_RE.test(s.trim());
}
