/** US state / territory codes (USPS) and the parser that finds one in a free-text address. */
import { normalizeKey } from './text.js';

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam',
  VI: 'Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

const NAME_TO_CODE = new Map<string, string>(Object.entries(US_STATES).map(([c, n]) => [normalizeKey(n), c]));
NAME_TO_CODE.set('WASHINGTON DC', 'DC');
NAME_TO_CODE.set('WASHINGTON D C', 'DC');
NAME_TO_CODE.set('US VIRGIN ISLANDS', 'VI');
/** Longest names first so "WEST VIRGINIA" wins over "VIRGINIA". */
const NAMES = [...NAME_TO_CODE.keys()].sort((a, b) => b.length - a.length);

export function isUsStateCode(code: string): boolean {
  return Object.hasOwn(US_STATES, code.toUpperCase());
}

/**
 * 2-letter US state from free text such as "Kent, WA 98032, U.S.A.", "TACOMA, WA, USA",
 * "Portland, Oregon". Two-letter codes are only accepted next to a ZIP code or as their own
 * comma-separated segment, so words like "IN" or "OR" inside a street line are not misread.
 */
export function usStateCode(text: string): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  // "ST 12345" or "ST 12345-6789" (the strongest signal).
  for (const m of upper.matchAll(/\b([A-Z]{2})\.?,?\s+(\d{5})(?:-\d{4})?\b/g)) {
    if (isUsStateCode(m[1])) return m[1];
  }
  const segments = upper
    .split(/[,;\n]+/)
    .map((s) => normalizeKey(s))
    .filter(Boolean);
  if (segments.length === 1 && /^[A-Z]{2}$/.test(segments[0])) {
    return isUsStateCode(segments[0]) ? segments[0] : null;
  }
  // A segment that is exactly a code ("TACOMA, WA, USA"), skipping the first (usually city/name).
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i].replace(/\s+\d{5}(?:\s+\d{4})?$/, '');
    if (/^[A-Z]{2}$/.test(seg) && isUsStateCode(seg)) return seg;
  }
  // Full state names as their own segment or before a ZIP ("Tacoma, Washington 98421").
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].replace(/\s+\d{5}(?:\s+\d{4})?$/, '');
    const code = NAME_TO_CODE.get(seg);
    if (code && (i > 0 || segments.length === 1)) return code;
  }
  // Last resort: a full state name anywhere (multi-word names only, to avoid "Washington Street").
  const hay = ` ${normalizeKey(upper)} `;
  for (const n of NAMES) {
    if (n.includes(' ') && hay.includes(` ${n} `)) return NAME_TO_CODE.get(n)!;
  }
  return null;
}
