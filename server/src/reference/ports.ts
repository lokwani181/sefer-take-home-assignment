/**
 * Port lookups.
 *  - US: CBP Schedule D 4-digit ports (data/us-ports.json = Census Schedule D merged with the CBP
 *    port directory) plus a curated alias table for the busiest ports, used first.
 *  - Foreign: USACE/CBP Schedule K 5-digit sea ports (data/schedule-k.json). Airports return null:
 *    Schedule K lists no airports, and CBP Form 7501 Block 19 is left blank for non-vessel shipments.
 *  - portCountry: the country of a foreign sea port or cargo airport (airports.ts), for the
 *    country of export when the port text names no country.
 */
import type { PortRef } from '@app/shared';
import { AIRPORT_BY_IATA, CARGO_AIRPORTS } from './airports.js';
import { countryCode } from './countries.js';
import { usStateCode } from './states.js';
import { indexOfWords, normalizeKey, readDataJson, stripDiacritics } from './text.js';

interface UsPortRow {
  code: string;
  name: string;
  state: string | null;
  kind: 'port' | 'air' | 'courier';
  aliases: string[];
}

interface MajorPort {
  code: string;
  state: string;
  air?: boolean;
  /** Always eligible (normalized words). */
  names: string[];
  /** Eligible only when the text says it is an airport. */
  airportCity?: string[];
}

/**
 * Busiest CBP ports with the spellings found on transport documents. Order is the tie-break.
 * Codes are from the CBP port directory (cbp.gov/about/contact/ports), falling back to Census
 * Schedule D where CBP has no page (1001, 2709, 2811, 3029).
 */
const MAJOR_US_PORTS: MajorPort[] = [
  { code: '2720', state: 'CA', air: true, names: ['LAX', 'LOS ANGELES INTERNATIONAL', 'LOS ANGELES INTL'], airportCity: ['LOS ANGELES'] },
  { code: '4701', state: 'NY', air: true, names: ['JFK', 'JOHN F KENNEDY', 'KENNEDY AIRPORT', 'KENNEDY INTL', 'KENNEDY INTERNATIONAL'], airportCity: ['NEW YORK'] },
  { code: '3029', state: 'WA', air: true, names: ['SEA TAC', 'SEATAC', 'SEATTLE TACOMA INTL', 'SEATTLE TACOMA INTERNATIONAL', 'SEATTLE TACOMA AIRPORT'], airportCity: ['SEATTLE'] },
  { code: '2801', state: 'CA', air: true, names: ['SFO', 'SAN FRANCISCO INTL', 'SAN FRANCISCO INTERNATIONAL'], airportCity: ['SAN FRANCISCO'] },
  { code: '5206', state: 'FL', air: true, names: ['MIAMI INTL', 'MIAMI INTERNATIONAL'], airportCity: ['MIAMI'] },
  { code: '5309', state: 'TX', air: true, names: ['IAH', 'GEORGE BUSH INTERCONTINENTAL', 'HOUSTON INTERCONTINENTAL'], airportCity: ['HOUSTON'] },
  { code: '3807', state: 'MI', air: true, names: ['DETROIT METRO', 'DETROIT METROPOLITAN', 'DTW'], airportCity: ['DETROIT'] },
  { code: '2721', state: 'CA', air: true, names: ['ONTARIO INTL', 'ONTARIO INTERNATIONAL', 'ONTARIO AIRPORT'] },
  { code: '3205', state: 'HI', air: true, names: ['HONOLULU INTL', 'DANIEL K INOUYE'], airportCity: ['HONOLULU'] },
  { code: '4913', state: 'PR', air: true, names: ['LUIS MUNOZ MARIN', 'SAN JUAN INTL'], airportCity: ['SAN JUAN'] },
  { code: '0417', state: 'MA', air: true, names: ['LOGAN AIRPORT', 'LOGAN INTL'], airportCity: ['BOSTON'] },
  { code: '3910', state: 'IL', air: true, names: ['MIDWAY'] },
  { code: '2704', state: 'CA', names: ['LOS ANGELES LONG BEACH', 'LA LONG BEACH', 'LOS ANGELES', 'SAN PEDRO', 'WILMINGTON CA', 'TERMINAL ISLAND'] },
  { code: '2709', state: 'CA', names: ['LONG BEACH'] },
  { code: '3002', state: 'WA', names: ['TACOMA'] },
  { code: '3001', state: 'WA', names: ['SEATTLE'] },
  { code: '3004', state: 'WA', names: ['BLAINE'] },
  { code: '4601', state: 'NJ', names: ['NEW YORK NEWARK', 'NY NJ', 'NEWARK', 'PORT NEWARK', 'ELIZABETH', 'BAYONNE', 'PORT ELIZABETH'] },
  { code: '4602', state: 'NJ', names: ['PERTH AMBOY'] },
  { code: '1001', state: 'NY', names: ['NEW YORK', 'NEW YORK CITY', 'NYC', 'STATEN ISLAND', 'BROOKLYN'] },
  { code: '5301', state: 'TX', names: ['HOUSTON', 'BARBOURS CUT', 'BAYPORT'] },
  { code: '5310', state: 'TX', names: ['GALVESTON'] },
  { code: '5311', state: 'TX', names: ['FREEPORT'] },
  { code: '5312', state: 'TX', names: ['CORPUS CHRISTI'] },
  { code: '1601', state: 'SC', names: ['CHARLESTON'] },
  { code: '1703', state: 'GA', names: ['SAVANNAH', 'GARDEN CITY'] },
  { code: '1701', state: 'GA', names: ['BRUNSWICK'] },
  { code: '1704', state: 'GA', names: ['ATLANTA'] },
  { code: '1401', state: 'VA', names: ['NORFOLK', 'NEWPORT NEWS', 'PORTSMOUTH VA', 'HAMPTON ROADS', 'VIRGINIA INTERNATIONAL GATEWAY'] },
  { code: '1303', state: 'MD', names: ['BALTIMORE'] },
  { code: '1101', state: 'PA', names: ['PHILADELPHIA'] },
  { code: '1103', state: 'DE', names: ['WILMINGTON DE'] },
  { code: '1501', state: 'NC', names: ['WILMINGTON NC'] },
  { code: '1512', state: 'NC', names: ['CHARLOTTE'] },
  { code: '0401', state: 'MA', names: ['BOSTON'] },
  { code: '0101', state: 'ME', names: ['PORTLAND ME'] },
  { code: '5201', state: 'FL', names: ['MIAMI', 'PORT MIAMI'] },
  { code: '5203', state: 'FL', names: ['PORT EVERGLADES', 'FORT LAUDERDALE', 'FT LAUDERDALE'] },
  { code: '5204', state: 'FL', names: ['WEST PALM BEACH'] },
  { code: '1801', state: 'FL', names: ['TAMPA'] },
  { code: '1803', state: 'FL', names: ['JACKSONVILLE'] },
  { code: '1901', state: 'AL', names: ['MOBILE'] },
  { code: '1902', state: 'MS', names: ['GULFPORT'] },
  { code: '2002', state: 'LA', names: ['NEW ORLEANS'] },
  { code: '2004', state: 'LA', names: ['BATON ROUGE'] },
  { code: '2101', state: 'TX', names: ['PORT ARTHUR', 'BEAUMONT'] },
  { code: '2809', state: 'CA', names: ['SAN FRANCISCO'] },
  { code: '2811', state: 'CA', names: ['OAKLAND'] },
  { code: '2713', state: 'CA', names: ['PORT HUENEME'] },
  { code: '2501', state: 'CA', names: ['SAN DIEGO'] },
  { code: '2506', state: 'CA', names: ['OTAY MESA'] },
  { code: '2904', state: 'OR', names: ['PORTLAND OR', 'PORTLAND OREGON'] },
  { code: '3901', state: 'IL', names: ['CHICAGO', 'OHARE', 'O HARE'] },
  { code: '3801', state: 'MI', names: ['DETROIT'] },
  { code: '3802', state: 'MI', names: ['PORT HURON'] },
  { code: '0901', state: 'NY', names: ['BUFFALO', 'NIAGARA FALLS', 'LEWISTON'] },
  { code: '0712', state: 'NY', names: ['CHAMPLAIN', 'ROUSES POINT'] },
  { code: '2304', state: 'TX', names: ['LAREDO'] },
  { code: '2402', state: 'TX', names: ['EL PASO'] },
  { code: '2604', state: 'AZ', names: ['NOGALES'] },
  { code: '2605', state: 'AZ', names: ['PHOENIX'] },
  { code: '2722', state: 'NV', names: ['LAS VEGAS'] },
  { code: '3307', state: 'CO', names: ['DENVER'] },
  { code: '3303', state: 'UT', names: ['SALT LAKE CITY'] },
  { code: '3501', state: 'MN', names: ['MINNEAPOLIS', 'ST PAUL', 'SAINT PAUL'] },
  { code: '2006', state: 'TN', names: ['MEMPHIS'] },
  { code: '4115', state: 'KY', names: ['LOUISVILLE'] },
  { code: '4102', state: 'KY', names: ['CINCINNATI'] },
  { code: '4101', state: 'OH', names: ['CLEVELAND'] },
  { code: '4103', state: 'OH', names: ['COLUMBUS OH'] },
  { code: '4110', state: 'IN', names: ['INDIANAPOLIS'] },
  { code: '4501', state: 'MO', names: ['KANSAS CITY'] },
  { code: '4503', state: 'MO', names: ['ST LOUIS', 'SAINT LOUIS'] },
  { code: '5501', state: 'TX', names: ['DALLAS', 'FORT WORTH', 'FT WORTH', 'DFW'] },
  { code: '5401', state: 'VA', names: ['DULLES', 'WASHINGTON DULLES'] },
  { code: '3126', state: 'AK', names: ['ANCHORAGE'] },
  { code: '3201', state: 'HI', names: ['HONOLULU'] },
  { code: '4909', state: 'PR', names: ['SAN JUAN'] },
];

const US_PORTS = readDataJson<{ ports: UsPortRow[] }>('us-ports.json').ports;
const US_BY_CODE = new Map(US_PORTS.map((p) => [p.code, p]));

const AIR_HINT = /\b(AIRPORT|AIRPRT|ARPT|AIRPT|AIR CARGO|AIRFIELD|AEROPORT|AEROPUERTO|INTL AIRPORT)\b/;

function portName(code: string): string {
  return US_BY_CODE.get(code)?.name ?? code;
}

export function usPortExists(code: string): boolean {
  return US_BY_CODE.has(code);
}

export function majorUsPortCodes(): string[] {
  return MAJOR_US_PORTS.map((p) => p.code);
}

/** City part of a Schedule D / CBP name: "Tacoma, Washington" → "TACOMA". */
function cityKey(name: string): string {
  return normalizeKey(name.split(',')[0].replace(/\b(seaport|area port of|port of)\b/gi, ''));
}

/**
 * CBP 4-digit port for free text such as "TACOMA, WA, USA", "LOS ANGELES/LONG BEACH", "JFK".
 * Curated major ports first (earliest mention wins, airports only when the text says airport),
 * then the full Schedule D by city name. Returns null when the city matches ports in several
 * states and the text has no state to disambiguate.
 */
export function usPortCode(text: string): PortRef | null {
  if (!text) return null;
  const key = normalizeKey(text);
  if (!key) return null;
  const explicit = key.match(/(?:^|\s)(\d{4})(?:\s|$)/);
  if (explicit && US_BY_CODE.has(explicit[1]) && key.replace(explicit[1], '').trim().length <= 12) {
    return { code: explicit[1], name: portName(explicit[1]) };
  }
  const state = usStateCode(text);
  // An airport's own name ("JFK", "LAX", "SEA-TAC") is airport evidence even without the word AIRPORT.
  const namesAirport = MAJOR_US_PORTS.some((p) => p.air && (!state || p.state === state) && p.names.some((n) => indexOfWords(key, n) >= 0));
  const isAir = AIR_HINT.test(key) || namesAirport;

  type Cand = { code: string; pos: number; len: number; air: boolean };
  const cands: Cand[] = [];
  for (const p of MAJOR_US_PORTS) {
    if (state && p.state !== state) continue;
    const pats = [...p.names, ...(isAir && p.airportCity ? p.airportCity : [])];
    for (const pat of pats) {
      const pos = indexOfWords(key, pat);
      if (pos >= 0) {
        cands.push({ code: p.code, pos, len: pat.length, air: !!p.air });
        break;
      }
    }
  }
  const pick = (list: Cand[]): Cand | undefined =>
    [...list].sort((a, b) => Number(b.air === isAir) - Number(a.air === isAir) || a.pos - b.pos || b.len - a.len)[0];
  const curated = pick(cands);
  if (curated) return { code: curated.code, name: portName(curated.code) };

  // Full list fallback: city name match, filtered by state and port kind.
  const hits: { row: UsPortRow; pos: number; len: number }[] = [];
  for (const row of US_PORTS) {
    if (row.kind === 'courier') continue;
    if (state && row.state && row.state !== state) continue;
    for (const n of [row.name, ...row.aliases]) {
      const ck = cityKey(n);
      if (ck.length < 3) continue;
      const pos = indexOfWords(key, ck);
      if (pos >= 0) {
        hits.push({ row, pos, len: ck.length });
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort(
    (a, b) =>
      Number((b.row.kind === 'air') === isAir) - Number((a.row.kind === 'air') === isAir) ||
      a.pos - b.pos ||
      b.len - a.len,
  );
  const best = hits[0];
  const states = new Set(hits.filter((h) => h.pos === best.pos && h.len === best.len).map((h) => h.row.state));
  if (!state && states.size > 1) return null;
  return { code: best.row.code, name: best.row.name };
}

// ── Schedule K ────────────────────────────────────────────────────────────────

type KRow = [code: string, name: string, iso2: string, official: 0 | 1];

interface KEntry {
  code: string;
  name: string;
  key: string;
  iso2: string;
  official: boolean;
}

const K_ROWS = readDataJson<{ ports: KRow[] }>('schedule-k.json').ports;
const K_ENTRIES: KEntry[] = K_ROWS.map(([code, name, iso2, official]) => ({
  code,
  name,
  key: normalizeKey(name),
  iso2,
  official: official === 1,
}));
const K_OFFICIAL_NAME = new Map<string, string>();
for (const e of K_ENTRIES) if (e.official && !K_OFFICIAL_NAME.has(e.code)) K_OFFICIAL_NAME.set(e.code, e.name);

/**
 * Spellings on shipping documents that Schedule K lists under another alias of the SAME code.
 * Each target code below is the code Schedule K itself assigns to that city.
 */
const K_EXTRA_ALIASES: { text: string; code: string }[] = [
  { text: 'HO CHI MINH', code: '55224' }, // Schedule K: 55224 Saigon / Ho Chi Minh City
  { text: 'HCMC', code: '55224' },
  { text: 'JNPT', code: '53313' }, // 53313 Jawaharlal Nehru / Nhava Sheva
  { text: 'JAWAHARLAL NEHRU PORT', code: '53313' },
  { text: 'CHATTOGRAM', code: '53827' }, // official new spelling of Chittagong (2018)
  { text: 'HAI PHONG', code: '55201' },
];

export function scheduleKExists(code: string): boolean {
  return K_ENTRIES.some((e) => e.code === code);
}

/**
 * Schedule K 5-digit foreign sea port from free text ("CAT LAI, HO CHI MINH CITY, VN",
 * "SHENZHEN/YANTIAN", "BUSAN, KOREA"). Matches official names and aliases as whole words,
 * restricted to the country when known; the earliest-mentioned, longest name wins.
 * Returns null for airports and whenever nothing in the official list matches (a wrong code
 * is worse than none: the caller raises an issue instead).
 */
export function foreignPortCode(text: string, countryIso2?: string): PortRef | null {
  if (!text) return null;
  const key = normalizeKey(text);
  if (!key || AIR_HINT.test(key)) return null;
  return matchScheduleK(text, key, countryIso2);
}

/** Schedule K name/alias match (no airport check): see foreignPortCode. */
function matchScheduleK(text: string, key: string, countryIso2?: string): PortRef | null {
  // A bare code ("55224", "SCHEDULE K 55224"), not a postal code inside an address.
  const explicit = key.match(/(?:^|\s)(\d{5})(?:\s|$)/);
  if (explicit && K_OFFICIAL_NAME.has(explicit[1]) && key.replace(explicit[1], '').trim().length <= 12) {
    return { code: explicit[1], name: K_OFFICIAL_NAME.get(explicit[1])! };
  }
  const country = countryIso2?.toUpperCase() ?? countryCode(text) ?? undefined;
  const segments = new Set(text.split(/[,;\n|/()]+/).map((s) => normalizeKey(s)));

  type Cand = { code: string; pos: number; len: number; official: boolean };
  const cands: Cand[] = [];
  for (const e of K_ENTRIES) {
    if (country && e.iso2 !== country) continue;
    if (e.key.length < 3) continue;
    // Without a country, short names ("SON", "BAR", "NICE") must be a whole segment of the text.
    if (!country && e.key.length < 6 && !segments.has(e.key)) continue;
    const pos = indexOfWords(key, e.key);
    if (pos >= 0) cands.push({ code: e.code, pos, len: e.key.length, official: e.official });
  }
  for (const a of K_EXTRA_ALIASES) {
    const entry = K_ENTRIES.find((e) => e.code === a.code);
    if (!entry || (country && entry.iso2 !== country)) continue;
    const pos = indexOfWords(key, a.text);
    if (pos >= 0) cands.push({ code: a.code, pos, len: a.text.length, official: false });
  }
  if (cands.length === 0) return null;
  // A country name that is also a port name ("SINGAPORE", "HONG KONG") should not beat a
  // specific port mentioned earlier, so earliest position wins; then longer, then official.
  cands.sort((a, b) => a.pos - b.pos || b.len - a.len || Number(b.official) - Number(a.official));
  const best = cands[0];
  return { code: best.code, name: K_OFFICIAL_NAME.get(best.code) ?? best.code };
}

// ── Country of a port / airport ────────────────────────────────────────────────

export { CARGO_AIRPORTS } from './airports.js';

const K_COUNTRY_BY_CODE = new Map(K_ENTRIES.map((e) => [e.code, e.iso2]));
const AIRPORT_NAMES = CARGO_AIRPORTS.flatMap((a) => a.names.map((n) => ({ key: n, country: a.country })));

/**
 * ISO2 country of a foreign port of lading or departure airport named in free text, when the text
 * itself names no country: "FRANKFURT/MAIN (FRA)" → DE, "HKG" → HK, "Leipzig/Halle Airport" → DE,
 * "CHENNAI" → IN. Order: IATA code of a curated cargo airport (in parentheses or alone; checked
 * before anything else because codes like FRA are also ISO alpha-3 country codes), then airport /
 * city names, then Schedule K sea-port names. Null when nothing matches or the match is ambiguous.
 * Callers check printed country names first (this lookup does not read them).
 */
export function portCountry(text: string): string | null {
  if (!text?.trim()) return null;
  const upper = stripDiacritics(text).toUpperCase();
  const codes = [...upper.matchAll(/\(\s*([A-Z]{3})\s*\)/g)].map((m) => m[1]);
  const bare = /^\s*([A-Z]{3})\s*$/.exec(upper)?.[1];
  if (bare) codes.push(bare);
  for (const c of codes) {
    const a = AIRPORT_BY_IATA.get(c);
    if (a) return a.country;
  }
  const key = normalizeKey(text);
  if (!key) return null;
  const byName = new Set(AIRPORT_NAMES.filter((n) => indexOfWords(key, n.key) >= 0).map((n) => n.country));
  if (byName.size === 1) return [...byName][0];
  if (byName.size > 1) return null;
  const k = matchScheduleK(text, key);
  return k ? (K_COUNTRY_BY_CODE.get(k.code) ?? null) : null;
}
