/**
 * Country names → ISO 3166-1 alpha-2, for free-text fields (ports, declarations, notes).
 * Self-contained; the one reference lookup reconcile uses (port / airport → country, for the
 * country of export) is imported in merge/transport.ts.
 */

const COUNTRIES: Record<string, string[]> = {
  AD: ['ANDORRA'], AE: ['UNITED ARAB EMIRATES', 'UAE'], AF: ['AFGHANISTAN'], AG: ['ANTIGUA AND BARBUDA', 'ANTIGUA'],
  AI: ['ANGUILLA'], AL: ['ALBANIA'], AM: ['ARMENIA'], AO: ['ANGOLA'], AR: ['ARGENTINA'], AS: ['AMERICAN SAMOA'],
  AT: ['AUSTRIA'], AU: ['AUSTRALIA'], AW: ['ARUBA'], AZ: ['AZERBAIJAN'],
  BA: ['BOSNIA AND HERZEGOVINA', 'BOSNIA'], BB: ['BARBADOS'], BD: ['BANGLADESH'], BE: ['BELGIUM'], BF: ['BURKINA FASO'],
  BG: ['BULGARIA'], BH: ['BAHRAIN'], BI: ['BURUNDI'], BJ: ['BENIN'], BM: ['BERMUDA'], BN: ['BRUNEI DARUSSALAM', 'BRUNEI'],
  BO: ['BOLIVIA'], BR: ['BRAZIL', 'BRASIL'], BS: ['BAHAMAS'], BT: ['BHUTAN'], BW: ['BOTSWANA'], BY: ['BELARUS'], BZ: ['BELIZE'],
  CA: ['CANADA'], CD: ['DEMOCRATIC REPUBLIC OF THE CONGO', 'DR CONGO'], CF: ['CENTRAL AFRICAN REPUBLIC'],
  CG: ['REPUBLIC OF THE CONGO', 'CONGO'], CH: ['SWITZERLAND'], CI: ['COTE D IVOIRE', 'COTE DIVOIRE', 'IVORY COAST'],
  CL: ['CHILE'], CM: ['CAMEROON'], CN: ['CHINA', 'PEOPLES REPUBLIC OF CHINA', 'PR CHINA', 'PRC', 'MAINLAND CHINA'],
  CO: ['COLOMBIA'], CR: ['COSTA RICA'], CU: ['CUBA'], CV: ['CABO VERDE', 'CAPE VERDE'], CW: ['CURACAO'], CY: ['CYPRUS'],
  CZ: ['CZECH REPUBLIC', 'CZECHIA'],
  DE: ['GERMANY', 'DEUTSCHLAND'], DJ: ['DJIBOUTI'], DK: ['DENMARK'], DM: ['DOMINICA'], DO: ['DOMINICAN REPUBLIC'], DZ: ['ALGERIA'],
  EC: ['ECUADOR'], EE: ['ESTONIA'], EG: ['EGYPT'], ER: ['ERITREA'], ES: ['SPAIN', 'ESPANA'], ET: ['ETHIOPIA'],
  FI: ['FINLAND'], FJ: ['FIJI'], FM: ['MICRONESIA'], FO: ['FAROE ISLANDS'], FR: ['FRANCE'],
  GA: ['GABON'], GB: ['UNITED KINGDOM', 'GREAT BRITAIN', 'UK', 'ENGLAND', 'SCOTLAND', 'NORTHERN IRELAND', 'BRITAIN'],
  GD: ['GRENADA'], GE: ['REPUBLIC OF GEORGIA'], GF: ['FRENCH GUIANA'], GH: ['GHANA'], GI: ['GIBRALTAR'], GL: ['GREENLAND'],
  GM: ['GAMBIA'], GN: ['GUINEA'], GP: ['GUADELOUPE'], GQ: ['EQUATORIAL GUINEA'], GR: ['GREECE'], GT: ['GUATEMALA'],
  GU: ['GUAM'], GW: ['GUINEA BISSAU'], GY: ['GUYANA'],
  HK: ['HONG KONG', 'HONG KONG SAR', 'HONGKONG'], HN: ['HONDURAS'], HR: ['CROATIA'], HT: ['HAITI'], HU: ['HUNGARY'],
  ID: ['INDONESIA'], IE: ['IRELAND'], IL: ['ISRAEL'], IM: ['ISLE OF MAN'], IN: ['INDIA'], IQ: ['IRAQ'], IR: ['IRAN'],
  IS: ['ICELAND'], IT: ['ITALY', 'ITALIA'],
  JM: ['JAMAICA'], JO: ['JORDAN'], JP: ['JAPAN'],
  KE: ['KENYA'], KG: ['KYRGYZSTAN'], KH: ['CAMBODIA', 'KAMPUCHEA'], KI: ['KIRIBATI'], KM: ['COMOROS'],
  KN: ['SAINT KITTS AND NEVIS'], KP: ['NORTH KOREA', 'DEMOCRATIC PEOPLES REPUBLIC OF KOREA'],
  KR: ['SOUTH KOREA', 'REPUBLIC OF KOREA', 'KOREA'], KW: ['KUWAIT'], KY: ['CAYMAN ISLANDS'], KZ: ['KAZAKHSTAN'],
  LA: ['LAOS', 'LAO PDR'], LB: ['LEBANON'], LC: ['SAINT LUCIA'], LI: ['LIECHTENSTEIN'], LK: ['SRI LANKA'], LR: ['LIBERIA'],
  LS: ['LESOTHO'], LT: ['LITHUANIA'], LU: ['LUXEMBOURG'], LV: ['LATVIA'], LY: ['LIBYA'],
  MA: ['MOROCCO'], MC: ['MONACO'], MD: ['MOLDOVA'], ME: ['MONTENEGRO'], MG: ['MADAGASCAR'], MH: ['MARSHALL ISLANDS'],
  MK: ['NORTH MACEDONIA', 'MACEDONIA'], ML: ['MALI'], MM: ['MYANMAR', 'BURMA'], MN: ['MONGOLIA'], MO: ['MACAO', 'MACAU'],
  MQ: ['MARTINIQUE'], MR: ['MAURITANIA'], MT: ['MALTA'], MU: ['MAURITIUS'], MV: ['MALDIVES'], MW: ['MALAWI'],
  MX: ['MEXICO'], MY: ['MALAYSIA'], MZ: ['MOZAMBIQUE'],
  NA: ['NAMIBIA'], NC: ['NEW CALEDONIA'], NE: ['NIGER'], NG: ['NIGERIA'], NI: ['NICARAGUA'],
  NL: ['NETHERLANDS', 'THE NETHERLANDS', 'HOLLAND'], NO: ['NORWAY'], NP: ['NEPAL'], NZ: ['NEW ZEALAND'],
  OM: ['OMAN'],
  PA: ['PANAMA'], PE: ['PERU'], PF: ['FRENCH POLYNESIA'], PG: ['PAPUA NEW GUINEA'], PH: ['PHILIPPINES'], PK: ['PAKISTAN'],
  PL: ['POLAND'], PR: ['PUERTO RICO'], PS: ['PALESTINE'], PT: ['PORTUGAL'], PW: ['PALAU'], PY: ['PARAGUAY'],
  QA: ['QATAR'],
  RE: ['REUNION'], RO: ['ROMANIA'], RS: ['SERBIA'], RU: ['RUSSIA', 'RUSSIAN FEDERATION'], RW: ['RWANDA'],
  SA: ['SAUDI ARABIA'], SB: ['SOLOMON ISLANDS'], SC: ['SEYCHELLES'], SD: ['SUDAN'], SE: ['SWEDEN'], SG: ['SINGAPORE'],
  SI: ['SLOVENIA'], SK: ['SLOVAKIA'], SL: ['SIERRA LEONE'], SM: ['SAN MARINO'], SN: ['SENEGAL'], SO: ['SOMALIA'],
  SR: ['SURINAME'], SS: ['SOUTH SUDAN'], SV: ['EL SALVADOR'], SY: ['SYRIA'], SZ: ['ESWATINI', 'SWAZILAND'],
  TC: ['TURKS AND CAICOS ISLANDS'], TD: ['CHAD'], TG: ['TOGO'], TH: ['THAILAND'], TJ: ['TAJIKISTAN'],
  TL: ['TIMOR LESTE', 'EAST TIMOR'], TM: ['TURKMENISTAN'], TN: ['TUNISIA'], TO: ['TONGA'], TR: ['TURKEY', 'TURKIYE'],
  TT: ['TRINIDAD AND TOBAGO', 'TRINIDAD'], TV: ['TUVALU'], TW: ['TAIWAN'], TZ: ['TANZANIA'],
  UA: ['UKRAINE'], UG: ['UGANDA'], US: ['UNITED STATES', 'UNITED STATES OF AMERICA', 'USA'], UY: ['URUGUAY'], UZ: ['UZBEKISTAN'],
  VA: ['HOLY SEE', 'VATICAN'], VC: ['SAINT VINCENT AND THE GRENADINES'], VE: ['VENEZUELA'], VG: ['BRITISH VIRGIN ISLANDS'],
  VI: ['US VIRGIN ISLANDS'], VN: ['VIETNAM', 'VIET NAM'], VU: ['VANUATU'],
  WS: ['SAMOA'],
  YE: ['YEMEN'],
  ZA: ['SOUTH AFRICA'], ZM: ['ZAMBIA'], ZW: ['ZIMBABWE'],
};

/** Adjectival forms seen in origin declarations ("of Chinese origin"). */
const DEMONYMS: Record<string, string> = {
  VIETNAMESE: 'VN', CHINESE: 'CN', BANGLADESHI: 'BD', INDIAN: 'IN', PAKISTANI: 'PK', CAMBODIAN: 'KH',
  INDONESIAN: 'ID', THAI: 'TH', MEXICAN: 'MX', TURKISH: 'TR', ITALIAN: 'IT', GERMAN: 'DE', JAPANESE: 'JP',
  KOREAN: 'KR', TAIWANESE: 'TW', 'SRI LANKAN': 'LK', MALAYSIAN: 'MY', FILIPINO: 'PH', PHILIPPINE: 'PH',
  PORTUGUESE: 'PT', SPANISH: 'ES', FRENCH: 'FR', BRITISH: 'GB', CANADIAN: 'CA', BURMESE: 'MM', EGYPTIAN: 'EG',
  MOROCCAN: 'MA', BRAZILIAN: 'BR', PERUVIAN: 'PE', GUATEMALAN: 'GT', HONDURAN: 'HN', SALVADORAN: 'SV',
  JORDANIAN: 'JO', ETHIOPIAN: 'ET', KENYAN: 'KE', 'HONG KONG': 'HK',
};

const ISO2 = new Set(Object.keys(COUNTRIES));
const NAME_TO_ISO = new Map<string, string>();
for (const [code, names] of Object.entries(COUNTRIES)) for (const n of names) NAME_TO_ISO.set(n, code);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLengthDesc = (a: string, b: string) => b.length - a.length;
const NAME_RE = new RegExp(`(?<![A-Z])(${[...NAME_TO_ISO.keys()].sort(byLengthDesc).map(escapeRe).join('|')})(?![A-Z])`, 'g');
const DEMONYM_RE = new RegExp(`(?<![A-Z])(${Object.keys(DEMONYMS).sort(byLengthDesc).map(escapeRe).join('|')})(?![A-Z])`, 'g');

/** Uppercase, dots removed ("U.S.A." → "USA"), apostrophes removed, whitespace collapsed. */
function prep(text: string): string {
  return text.toUpperCase().replace(/[.’'`]/g, '').replace(/[^A-Z0-9,/()\-\s]/g, ' ').replace(/\s+/g, ' ');
}

export const isIso2Country = (code: string | undefined): boolean => !!code && ISO2.has(code.toUpperCase());

/** Every country named in the text, in reading order (names, plus demonyms when asked). */
export function countriesInText(text: string | undefined, opts: { demonyms?: boolean } = {}): string[] {
  if (!text) return [];
  const t = prep(text);
  const hits: { at: number; code: string }[] = [];
  for (const m of t.matchAll(NAME_RE)) hits.push({ at: m.index ?? 0, code: NAME_TO_ISO.get(m[1]) ?? '' });
  if (opts.demonyms) for (const m of t.matchAll(DEMONYM_RE)) hits.push({ at: m.index ?? 0, code: DEMONYMS[m[1]] });
  return hits.sort((a, b) => a.at - b.at).map((h) => h.code).filter(Boolean);
}

/**
 * Country of a free-text location such as a port ("CAT LAI, HCMC, VN", "SHANGHAI, CHINA").
 * The last named country wins (addresses end with the country); a trailing ISO2 code is accepted
 * because port fields commonly end with one.
 */
export function countryFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const named = countriesInText(text);
  if (named.length) return named[named.length - 1];
  const parts = prep(text).split(/[,/()]/).map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && /^[A-Z]{2}$/.test(last) && ISO2.has(last)) return last;
  return undefined;
}

/** Display name for an ISO2 code ("VN" → "Vietnam"); the first listed name is the display form. */
export function countryName(code: string | undefined): string {
  if (!code) return 'unknown';
  const names = COUNTRIES[code.toUpperCase()];
  if (!names) return code;
  return names[0].toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
