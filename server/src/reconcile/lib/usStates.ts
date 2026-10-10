/** US state detection from free-text addresses and place names ("KENT, WA (DOOR)", "Portland, OR 97210"). */

const STATES: Record<string, string> = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA', CO: 'COLORADO', CT: 'CONNECTICUT',
  DE: 'DELAWARE', DC: 'DISTRICT OF COLUMBIA', FL: 'FLORIDA', GA: 'GEORGIA', HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS',
  IN: 'INDIANA', IA: 'IOWA', KS: 'KANSAS', KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND',
  MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA', MS: 'MISSISSIPPI', MO: 'MISSOURI', MT: 'MONTANA',
  NE: 'NEBRASKA', NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO', NY: 'NEW YORK',
  NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA', OR: 'OREGON', PA: 'PENNSYLVANIA',
  RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA', SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH',
  VT: 'VERMONT', VA: 'VIRGINIA', WA: 'WASHINGTON', WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING',
  PR: 'PUERTO RICO', GU: 'GUAM', VI: 'VIRGIN ISLANDS', AS: 'AMERICAN SAMOA', MP: 'NORTHERN MARIANA ISLANDS',
};

const NAMES = Object.entries(STATES).sort((a, b) => b[1].length - a[1].length);

export const isUsState = (code: string | undefined): boolean => !!code && code.toUpperCase() in STATES;

/**
 * 2-letter US state from free text. Looks for "City, ST", "ST 12345" and full state names,
 * taking the last match because the state follows the city in US addresses.
 */
export function usStateFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.toUpperCase().replace(/\./g, '');
  let found: { at: number; code: string } | undefined;
  const consider = (at: number, code: string) => {
    if (code in STATES && (!found || at >= found.at)) found = { at, code };
  };
  for (const m of t.matchAll(/,\s*([A-Z]{2})(?=\s*(?:\d{5}|,|\(|$|\s+USA|\s+US\b|\s+UNITED STATES))/g)) consider(m.index ?? 0, m[1]);
  for (const m of t.matchAll(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g)) consider(m.index ?? 0, m[1]);
  if (!found) {
    for (const [code, name] of NAMES) {
      const re = new RegExp(`(?<![A-Z])${name}(?![A-Z])`);
      const m = re.exec(t);
      // "WASHINGTON" alone is ambiguous with the city of Washington DC; still the best available signal.
      if (m) consider(m.index, code);
    }
  }
  return found?.code;
}
