/**
 * Country name/code → ISO 3166-1 alpha-2.
 * Data: data/countries.json (ISO names + alpha-3, Census Schedule C names) plus the common
 * trade-document variants below ("U.S.A.", "VIET NAM", "P.R. CHINA", "KOREA, REPUBLIC OF", "UK").
 */
import { US_STATES } from './states.js';
import { readDataJson, stripDiacritics } from './text.js';

interface CountryRow {
  a2: string;
  a3: string;
  name: string;
  names: string[];
}

/** Variants seen on invoices / B/Ls that ISO and Census name lists don't carry. */
const EXTRA_ALIASES: Record<string, string[]> = {
  US: ['USA', 'U.S.A.', 'U.S.', 'UNITED STATES', 'UNITED STATES OF AMERICA', 'THE UNITED STATES', 'US OF A'],
  GB: ['UK', 'U.K.', 'UNITED KINGDOM', 'GREAT BRITAIN', 'BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND'],
  VN: ['VIETNAM', 'VIET NAM', 'SOCIALIST REPUBLIC OF VIETNAM', 'S.R. VIETNAM', 'SR VIETNAM'],
  CN: ['CHINA', 'P.R. CHINA', 'PR CHINA', 'P.R.C.', 'PRC', "PEOPLE'S REPUBLIC OF CHINA", 'PEOPLES REPUBLIC OF CHINA', 'MAINLAND CHINA', 'CHINA MAINLAND', 'CHINA (MAINLAND)'],
  HK: ['HONG KONG', 'HONGKONG', 'HONG KONG SAR', 'HONG KONG S.A.R.', 'HK SAR', 'HKSAR', 'HONG KONG CHINA', 'HONG KONG, CHINA'],
  MO: ['MACAU', 'MACAO', 'MACAU SAR', 'MACAO SAR'],
  TW: ['TAIWAN', 'TAIWAN R.O.C.', 'TAIWAN ROC', 'REPUBLIC OF CHINA', 'R.O.C.', 'TAIWAN, PROVINCE OF CHINA', 'CHINESE TAIPEI'],
  KR: ['KOREA', 'SOUTH KOREA', 'KOREA, SOUTH', 'KOREA SOUTH', 'KOREA, REPUBLIC OF', 'REPUBLIC OF KOREA', 'KOREA (SOUTH)', 'S. KOREA', 'ROK'],
  KP: ['NORTH KOREA', 'KOREA, NORTH', 'DPRK', "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF"],
  NL: ['HOLLAND', 'THE NETHERLANDS', 'NETHERLANDS'],
  AE: ['UAE', 'U.A.E.', 'UNITED ARAB EMIRATES'],
  RU: ['RUSSIA', 'RUSSIAN FEDERATION'],
  TR: ['TURKEY', 'TURKIYE'],
  CZ: ['CZECH REPUBLIC', 'CZECHIA'],
  CI: ['IVORY COAST', "COTE D'IVOIRE"],
  MM: ['BURMA', 'MYANMAR'],
  LA: ['LAOS', 'LAO PDR'],
  IR: ['IRAN'],
  SY: ['SYRIA'],
  VE: ['VENEZUELA'],
  BO: ['BOLIVIA'],
  TZ: ['TANZANIA'],
  MD: ['MOLDOVA'],
  VA: ['VATICAN', 'HOLY SEE'],
  BN: ['BRUNEI'],
  CV: ['CAPE VERDE', 'CABO VERDE'],
  SZ: ['SWAZILAND', 'ESWATINI'],
  MK: ['MACEDONIA', 'NORTH MACEDONIA'],
  DE: ['GERMANY', 'DEUTSCHLAND', 'FED. REP. OF GERMANY'],
  ES: ['ESPANA'],
  IT: ['ITALIA'],
  JP: ['NIPPON'],
  LK: ['SRI LANKA', 'CEYLON'],
  KH: ['CAMBODIA', 'KAMPUCHEA'],
  BR: ['BRASIL'],
  CD: ['DR CONGO', 'DRC', 'CONGO, DEMOCRATIC REPUBLIC OF THE', 'CONGO KINSHASA'],
  CG: ['CONGO BRAZZAVILLE', 'REPUBLIC OF THE CONGO'],
  FM: ['MICRONESIA'],
  PS: ['PALESTINE'],
};

/** Country names that are also US state names: only accepted when they are the whole text. */
const US_STATE_LOOKALIKES = new Set(['GEORGIA']);

/** Names that also commonly appear as non-country words (US state, surname…); only matched as a whole segment. */
const SEGMENT_ONLY = new Set(['GEORGIA', 'JERSEY', 'CHAD', 'JORDAN', 'GUERNSEY', 'MAN', 'NIUE', 'TOGO', 'MALI', 'PERU', 'CUBA', 'OMAN']);

/** Normalize for country matching: dots dropped ("U.S.A." → "USA"), other punctuation → space. */
export function countryKey(s: string): string {
  return stripDiacritics(s)
    .toUpperCase()
    .replace(/[.’'`]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const rows = readDataJson<{ countries: CountryRow[] }>('countries.json').countries;
const byA2 = new Map<string, CountryRow>();
const byA3 = new Map<string, string>();
const byName = new Map<string, string>();

for (const r of rows) {
  byA2.set(r.a2, r);
  byA3.set(r.a3, r.a2);
  for (const n of r.names) {
    const k = countryKey(n);
    if (k.length > 2 && !byName.has(k)) byName.set(k, r.a2);
  }
}
for (const [a2, aliases] of Object.entries(EXTRA_ALIASES)) {
  for (const n of aliases) byName.set(countryKey(n), a2);
}
/** Longest names first so "PAPUA NEW GUINEA" wins over "GUINEA". */
const namesByLength = [...byName.keys()].sort((a, b) => b.length - a.length);

const US_STATE_CODES = new Set(Object.keys(US_STATES));
const US_STATE_NAME_KEYS = Object.values(US_STATES).map((n) => countryKey(n));

export function countryName(a2: string): string | null {
  return byA2.get(a2.toUpperCase())?.name ?? null;
}

export function isIsoAlpha2(code: string): boolean {
  return byA2.has(code.toUpperCase());
}

function exact(key: string): string | null {
  if (!key) return null;
  const named = byName.get(key);
  if (named) return named;
  if (key === 'UK') return 'GB';
  if (/^[A-Z]{2}$/.test(key) && byA2.has(key)) return key;
  if (/^[A-Z]{3}$/.test(key)) return byA3.get(key) ?? null;
  return null;
}

/**
 * ISO2 from free text: exact names/codes first, then the last comma-separated segment that is
 * a country, then a whole-word search for a country name (longest, right-most wins).
 * Two-letter segments that are also US state codes (e.g. "PORTLAND, OR") are not read as countries.
 */
export function countryCode(text: string): string | null {
  if (!text) return null;
  const whole = countryKey(text);
  const direct = exact(whole);
  if (direct) return direct;

  const segments = text
    .split(/[,;\n|/()]+/)
    .map(countryKey)
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (/^[A-Z]{2}$/.test(seg) && US_STATE_CODES.has(seg)) continue;
    if (US_STATE_LOOKALIKES.has(seg)) continue;
    const hit = exact(seg) ?? exact(seg.replace(/\s+\d[\d\s-]*$/, '')); // "VIETNAM 820000"
    if (hit) return hit;
  }

  // Blank out US state names first so "NEW MEXICO" / "NEW JERSEY" don't read as countries.
  let hay = ` ${whole} `;
  for (const st of US_STATE_NAME_KEYS) {
    if (st.includes(' ')) hay = hay.replaceAll(` ${st} `, ' ');
  }
  let best: { a2: string; end: number; len: number } | null = null;
  for (const name of namesByLength) {
    if (name.length < 4 || SEGMENT_ONLY.has(name)) continue;
    const idx = hay.lastIndexOf(` ${name} `);
    if (idx < 0) continue;
    const end = idx + name.length;
    if (!best || end > best.end || (end === best.end && name.length > best.len)) {
      best = { a2: byName.get(name)!, end, len: name.length };
    }
  }
  if (best) return best.a2;

  // A US "City, ST 12345" address with no country printed.
  if (/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/.test(whole)) {
    const m = whole.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
    if (m && US_STATE_CODES.has(m[1])) return 'US';
  }
  return null;
}
