/**
 * Ground-truth tokens read by hand off the sample scans (test-only), and a recall metric.
 */
import type { Word } from '@app/shared';

export interface TokenSet {
  name: string;
  tokens: string[];
}

/** Key tokens from the task spec (must be read with conf >= 80). */
export const PL_KEY = [
  'NB-T101', 'NB-H205', 'NB-C330', 'W-B220', 'NB-P118S', '2,400', '1,176', '900', '600', '432.00', '715.40',
  '486.00', '96.00', '1,888.00', '13.58', 'TC', '65/35', 'SPG-PL-2609-117',
];
export const BL_KEY = ['BMLVHCM26090418', 'OPLUSGN260917735', 'OPL7731482', '1,930.000', '13.580', 'PACIFIC', 'ARGOS', '041E'];

/** Broader coverage: every table cell and reference on the packing list. */
export const PL_EXTENDED = [
  '48', '50', '9.00', '10.00', '480.00', '60x40x35', '49', '24', '14.60', '15.80', '774.20', '60x45x45', '30',
  '16.20', '17.40', '522.00', '60x40x40', '10', '60', '9.60', '10.60', '106.00', '55x40x30', '138', '5.10', '5.80',
  '50x35x30', '5,100', '1,734.50', '20-Sep-2026', 'KBAS/NB/26-0912', 'NB-26-0918', 'SPG-0918', "20'GP",
  '3702148865', '97210', '98032', 'NB-26-0918F', 'Gazipur', 'Bangladesh', 'FLEECE', '280GSM', '160GSM',
  'COTTON/SPANDEX', '98/2', 'CREPE', 'PIQUE', 'OATMEAL', 'KHAKI', 'IVORY', 'ASSORTED',
];

/** Typed data on the bill of lading, including text under the red and blue stamps. */
export const BL_DATA = [
  'BMLHCM2609-0377', 'KBAS/NB/26-0912', 'NB-26-0918', 'CASCADE', 'FULFILLMENT', '21820', '76TH', '98032', '0193',
  'NORTHBOUND', 'OUTFITTERS', 'INC', 'SUITE', '300', '97210', '0148', 'HOLT', 'CUSTOMS', 'BROKER', '(TBA)', 'TRUCK',
  'THAN', 'DUONG', 'CAT', 'LAI', 'HCMC', 'TACOMA', 'KENT', '(DOOR)', 'CFS', 'DOOR', 'CARTONS', '6109.10', '6110.20',
  '6203.42', '6206.40', '6106.10', '1-138', 'PREPAID', 'COLLECT', 'THREE', '24-SEP-2026', '(OPLU)', 'ORIENT',
  'LINES', 'VIETNAM', 'SEAL', "20'GP", 'HUNDRED', 'THIRTY', 'EIGHT', 'ONLY', 'IMPORTER/AGENT', 'RAMP/TRUCK',
  '029415N', 'BMLV',
];

/** Blue pre-printed form labels on the bill of lading (what blue suppression would erase). */
export const BL_LABELS = [
  'Shipper', 'Exporter', 'Consignee', 'Notify', 'Party', 'Booking', 'References', 'Master', 'Carrier', 'Origin',
  'Domestic', 'Routing', 'Pre-carriage', 'Receipt', 'Vessel', 'Voy', 'Loading', 'Discharge', 'Delivery', 'Final',
  'Destination', 'Move', 'Container', 'Seal', 'Marks', 'Pkgs', 'Packages', 'Goods', 'Gross', 'Weight',
  'Measurement', 'Freight', 'Charges', 'Number', 'Original', 'Issue', 'Payable', 'PARTICULARS', 'FURNISHED',
  'RESPONSIBLE', 'LOGISTICS', 'MERIDIAN', 'B/L',
];

export const PL_TOKENS: TokenSet[] = [
  { name: 'key', tokens: PL_KEY },
  { name: 'extended', tokens: PL_EXTENDED },
];
export const BL_TOKENS: TokenSet[] = [
  { name: 'key', tokens: BL_KEY },
  { name: 'data', tokens: BL_DATA },
  { name: 'labels', tokens: BL_LABELS },
];

/** Case-insensitive, quotes unified, surrounding punctuation stripped. */
export function normToken(s: string): string {
  return s
    .toUpperCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/^[\s,.;:'"“”!?_—–-]+|[\s,.;:'"“”!?_—–-]+$/g, '');
}

export interface Recall {
  found: number;
  total: number;
  missing: string[];
}

/** How many tokens appear as a whole word with conf >= minConf. */
export function recall(words: Word[], tokens: string[], minConf: number): Recall {
  const seen = new Set(words.filter((w) => w.conf >= minConf).map((w) => normToken(w.text)));
  const missing = tokens.filter((t) => !seen.has(normToken(t)));
  return { found: tokens.length - missing.length, total: tokens.length, missing };
}

/** Best confidence of a token on the page, or -1 when absent. */
export function bestConf(words: Word[], token: string): number {
  const t = normToken(token);
  return words.reduce((best, w) => (normToken(w.text) === t && w.conf > best ? w.conf : best), -1);
}
