/**
 * Country names → ISO 3166-1 alpha-2, plus US state codes.
 *
 * Why: addresses, origin statements ("Made in Bangladesh", "(Origin: VIETNAM)") and
 * port strings name countries in many ways ("U.S.A.", "VIET NAM", "P.R. CHINA").
 * Matching is done on compact upper-case keys so punctuation and spacing don't matter.
 */
import { compactKey, spacedKey } from './text';

/** ISO2 → names/aliases (first entry is the display name). */
const COUNTRIES: Record<string, string[]> = {
  AF: ['Afghanistan'], AL: ['Albania'], DZ: ['Algeria'], AD: ['Andorra'], AO: ['Angola'], AG: ['Antigua and Barbuda'],
  AR: ['Argentina'], AM: ['Armenia'], AU: ['Australia'], AT: ['Austria', 'Osterreich'], AZ: ['Azerbaijan'], BS: ['Bahamas'],
  BH: ['Bahrain'], BD: ['Bangladesh'], BB: ['Barbados'], BY: ['Belarus'], BE: ['Belgium', 'Belgique', 'Belgie'], BZ: ['Belize'],
  BJ: ['Benin'], BT: ['Bhutan'], BO: ['Bolivia'], BA: ['Bosnia and Herzegovina', 'Bosnia'], BW: ['Botswana'], BR: ['Brazil', 'Brasil'],
  BN: ['Brunei', 'Brunei Darussalam'], BG: ['Bulgaria'], BF: ['Burkina Faso'], BI: ['Burundi'], KH: ['Cambodia', 'Kampuchea'],
  CM: ['Cameroon'], CA: ['Canada'], CV: ['Cape Verde', 'Cabo Verde'], CF: ['Central African Republic'], TD: ['Chad'], CL: ['Chile'],
  CN: ['China', 'P.R. China', 'PR China', 'PRC', "People's Republic of China", 'Peoples Republic of China', 'Mainland China'],
  CO: ['Colombia'], KM: ['Comoros'], CG: ['Congo'], CD: ['Democratic Republic of the Congo', 'DR Congo'], CR: ['Costa Rica'],
  CI: ["Cote d'Ivoire", 'Ivory Coast'], HR: ['Croatia', 'Hrvatska'], CU: ['Cuba'], CY: ['Cyprus'], CZ: ['Czech Republic', 'Czechia'],
  DK: ['Denmark', 'Danmark'], DJ: ['Djibouti'], DM: ['Dominica'], DO: ['Dominican Republic'], EC: ['Ecuador'], EG: ['Egypt'],
  SV: ['El Salvador'], GQ: ['Equatorial Guinea'], ER: ['Eritrea'], EE: ['Estonia'], SZ: ['Eswatini', 'Swaziland'], ET: ['Ethiopia'],
  FJ: ['Fiji'], FI: ['Finland', 'Suomi'], FR: ['France'], GA: ['Gabon'], GM: ['Gambia'], GE: ['Georgia'],
  DE: ['Germany', 'Deutschland', 'Federal Republic of Germany'], GH: ['Ghana'], GR: ['Greece', 'Hellas'], GD: ['Grenada'],
  GT: ['Guatemala'], GN: ['Guinea'], GW: ['Guinea-Bissau'], GY: ['Guyana'], HT: ['Haiti'], HN: ['Honduras'],
  HK: ['Hong Kong', 'Hongkong', 'Hong Kong SAR', 'HKSAR'], HU: ['Hungary'], IS: ['Iceland'], IN: ['India', 'Bharat'],
  ID: ['Indonesia'], IR: ['Iran'], IQ: ['Iraq'], IE: ['Ireland', 'Eire'], IL: ['Israel'], IT: ['Italy', 'Italia'], JM: ['Jamaica'],
  JP: ['Japan', 'Nippon'], JO: ['Jordan'], KZ: ['Kazakhstan'], KE: ['Kenya'], KI: ['Kiribati'], KP: ['North Korea', 'DPRK'],
  KR: ['South Korea', 'Korea', 'Republic of Korea', 'Korea Republic of', 'Korea (South)', 'ROK'], KW: ['Kuwait'], KG: ['Kyrgyzstan'],
  LA: ['Laos', "Lao People's Democratic Republic", 'Lao PDR'], LV: ['Latvia'], LB: ['Lebanon'], LS: ['Lesotho'], LR: ['Liberia'],
  LY: ['Libya'], LI: ['Liechtenstein'], LT: ['Lithuania'], LU: ['Luxembourg'], MO: ['Macau', 'Macao'], MG: ['Madagascar'],
  MW: ['Malawi'], MY: ['Malaysia'], MV: ['Maldives'], ML: ['Mali'], MT: ['Malta'], MH: ['Marshall Islands'], MR: ['Mauritania'],
  MU: ['Mauritius'], MX: ['Mexico', 'Mejico'], FM: ['Micronesia'], MD: ['Moldova'], MC: ['Monaco'], MN: ['Mongolia'],
  ME: ['Montenegro'], MA: ['Morocco', 'Maroc'], MZ: ['Mozambique'], MM: ['Myanmar', 'Burma'], NA: ['Namibia'], NR: ['Nauru'],
  NP: ['Nepal'], NL: ['Netherlands', 'The Netherlands', 'Holland', 'Nederland'], NZ: ['New Zealand'], NI: ['Nicaragua'],
  NE: ['Niger'], NG: ['Nigeria'], MK: ['North Macedonia', 'Macedonia'], NO: ['Norway', 'Norge'], OM: ['Oman'], PK: ['Pakistan'],
  PW: ['Palau'], PS: ['Palestine'], PA: ['Panama'], PG: ['Papua New Guinea'], PY: ['Paraguay'], PE: ['Peru'],
  PH: ['Philippines', 'The Philippines'], PL: ['Poland', 'Polska'], PT: ['Portugal'], PR: ['Puerto Rico'], QA: ['Qatar'],
  RO: ['Romania'], RU: ['Russia', 'Russian Federation'], RW: ['Rwanda'], KN: ['Saint Kitts and Nevis'], LC: ['Saint Lucia'],
  VC: ['Saint Vincent and the Grenadines'], WS: ['Samoa'], SM: ['San Marino'], ST: ['Sao Tome and Principe'],
  SA: ['Saudi Arabia', 'KSA'], SN: ['Senegal'], RS: ['Serbia'], SC: ['Seychelles'], SL: ['Sierra Leone'], SG: ['Singapore'],
  SK: ['Slovakia', 'Slovak Republic'], SI: ['Slovenia'], SB: ['Solomon Islands'], SO: ['Somalia'], ZA: ['South Africa', 'RSA'],
  SS: ['South Sudan'], ES: ['Spain', 'Espana'], LK: ['Sri Lanka', 'Ceylon'], SD: ['Sudan'], SR: ['Suriname'],
  SE: ['Sweden', 'Sverige'], CH: ['Switzerland', 'Schweiz', 'Suisse', 'Svizzera'], SY: ['Syria'],
  TW: ['Taiwan', 'Taiwan ROC', 'Republic of China', 'Chinese Taipei', 'R.O.C.'], TJ: ['Tajikistan'], TZ: ['Tanzania'],
  TH: ['Thailand'], TL: ['Timor-Leste', 'East Timor'], TG: ['Togo'], TO: ['Tonga'], TT: ['Trinidad and Tobago'], TN: ['Tunisia'],
  TR: ['Turkey', 'Turkiye'], TM: ['Turkmenistan'], TV: ['Tuvalu'], UG: ['Uganda'], UA: ['Ukraine'],
  AE: ['United Arab Emirates', 'UAE', 'U.A.E.'], GB: ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
  US: ['United States', 'USA', 'U.S.A.', 'U.S.', 'United States of America', 'America', 'US of America'],
  UY: ['Uruguay'], UZ: ['Uzbekistan'], VU: ['Vanuatu'], VE: ['Venezuela'],
  VN: ['Vietnam', 'Viet Nam', 'Socialist Republic of Vietnam', 'S.R. Vietnam', 'SRV'], YE: ['Yemen'], ZM: ['Zambia'], ZW: ['Zimbabwe'],
};

/** US states + DC + territories (2-letter postal codes). */
export const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP'.split(' '),
);

const BY_KEY = new Map<string, string>();
const NAMES_BY_LENGTH: Array<{ key: string; iso: string }> = [];
for (const [code, names] of Object.entries(COUNTRIES)) {
  for (const n of names) {
    BY_KEY.set(compactKey(n), code);
    NAMES_BY_LENGTH.push({ key: spacedKey(n), iso: code });
  }
}
NAMES_BY_LENGTH.sort((a, b) => b.key.length - a.key.length);
// Short keys that are also common words must not match inside free text.
const UNSAFE_IN_TEXT = new Set(['AMERICA', 'US', 'U S', 'PRC', 'KSA', 'RSA', 'ROK', 'SRV', 'DPRK', 'CHAD', 'JORDAN', 'GEORGIA']);

/** Display name for an ISO2 code. */
export function countryName(iso2: string): string | undefined {
  return COUNTRIES[iso2.toUpperCase()]?.[0];
}

/**
 * ISO2 for a short text that IS a country ("VIETNAM", "U.S.A.", "Hong Kong").
 * Two-letter ISO codes are accepted only when `allowIso2` is set (they collide with US states).
 */
export function countryCode(text: string, opts: { allowIso2?: boolean } = {}): string | undefined {
  const k = compactKey(text);
  if (!k) return undefined;
  const hit = BY_KEY.get(k);
  if (hit) return hit;
  if (opts.allowIso2 && k.length === 2 && COUNTRIES[k]) return k;
  return undefined;
}

/**
 * Finds a country named anywhere inside free text ("Made in Bangladesh.", "Binh Duong, Vietnam").
 * Returns the last mention when several exist, because addresses end with the country.
 */
export function findCountry(text: string, opts: { last?: boolean } = {}): { iso: string; index: number; name: string } | undefined {
  const s = ` ${spacedKey(text)} `;
  let best: { iso: string; index: number; name: string } | undefined;
  for (const { key, iso } of NAMES_BY_LENGTH) {
    if (key.length < 3 || UNSAFE_IN_TEXT.has(key)) continue;
    let from = 0;
    for (;;) {
      const i = s.indexOf(` ${key} `, from);
      if (i < 0) break;
      const covered = best && i >= best.index && i < best.index + best.name.length;
      if (!covered && (!best || (opts.last === false ? i < best.index : i > best.index))) best = { iso, index: i, name: key };
      from = i + 1;
    }
  }
  return best;
}
