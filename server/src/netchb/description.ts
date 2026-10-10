/**
 * Text fields NetCHB shows to CBP: the header commodity description (≤70) and the
 * line commercial description. Both are derived generically from the HTS
 * chapters and the line texts — never from sample-specific strings.
 */
import type { Fiber } from '@app/shared';
import { MAX_LEN } from './enums';
import { collapse, truncateWords } from './normalize';

/** Plain-language labels for HTS chapters, used for the header description. */
const CHAPTER_LABELS: Record<string, string> = {
  '39': 'PLASTIC ARTICLES',
  '40': 'RUBBER ARTICLES',
  '42': 'LEATHER GOODS AND BAGS',
  '44': 'WOOD ARTICLES',
  '48': 'PAPER PRODUCTS',
  '49': 'PRINTED MATTER',
  '52': 'COTTON FABRICS AND YARNS',
  '54': 'MAN-MADE FILAMENT FABRICS',
  '55': 'MAN-MADE STAPLE FIBER FABRICS',
  '60': 'KNITTED FABRICS',
  '61': 'WEARING APPAREL',
  '62': 'WEARING APPAREL',
  '63': 'MADE-UP TEXTILE ARTICLES',
  '64': 'FOOTWEAR',
  '65': 'HEADGEAR',
  '69': 'CERAMIC PRODUCTS',
  '70': 'GLASSWARE',
  '71': 'JEWELRY',
  '72': 'IRON AND STEEL',
  '73': 'ARTICLES OF IRON OR STEEL',
  '74': 'COPPER ARTICLES',
  '76': 'ALUMINUM ARTICLES',
  '82': 'TOOLS AND CUTLERY',
  '83': 'MISCELLANEOUS BASE METAL ARTICLES',
  '84': 'MACHINERY AND PARTS',
  '85': 'ELECTRICAL EQUIPMENT',
  '87': 'VEHICLE PARTS',
  '90': 'OPTICAL AND MEASURING INSTRUMENTS',
  '91': 'CLOCKS AND WATCHES',
  '94': 'FURNITURE AND LIGHTING',
  '95': 'TOYS, GAMES AND SPORTS EQUIPMENT',
  '96': 'MISCELLANEOUS MANUFACTURED ARTICLES',
};

/**
 * Short header description: the chapter label shared by the lines (e.g. Ch.61+62 →
 * "WEARING APPAREL"), several labels joined if they fit, else the first line's text.
 */
export function headerDescription(htsNumbers: string[], lineDescriptions: string[]): string | undefined {
  const labels = [...new Set(htsNumbers.map((h) => CHAPTER_LABELS[h.slice(0, 2)]).filter((l): l is string => !!l))];
  if (labels.length && htsNumbers.every((h) => CHAPTER_LABELS[h.slice(0, 2)])) {
    const joined = labels.join(', ');
    if (joined.length <= MAX_LEN.description) return joined;
  }
  const first = lineDescriptions.map((d) => collapse(d)).find(Boolean);
  return first ? truncateWords(first.toUpperCase(), MAX_LEN.description) : labels[0];
}

/** "60% COTTON 40% POLYESTER" (largest share first). */
export function formatComposition(fibers: Fiber[] | undefined): string {
  if (!fibers?.length) return '';
  return [...fibers]
    .sort((a, b) => b.pct - a.pct)
    .map((f) => `${Math.round(f.pct * 10) / 10}% ${f.fiber.toUpperCase()}`)
    .join(' ');
}

/**
 * Line commercial description: the invoice description plus the fibre content
 * (which drives textile classification), upper-cased and kept within 70 chars.
 */
export function commercialDescription(description: string, composition: Fiber[] | undefined): string {
  const desc = collapse(description).toUpperCase();
  const comp = /\d\s*%/.test(desc) ? '' : formatComposition(composition);
  if (!comp) return truncateWords(desc, MAX_LEN.commercialDescription);
  const room = MAX_LEN.commercialDescription - comp.length - 2;
  if (room < 10) return truncateWords(desc, MAX_LEN.commercialDescription);
  return `${truncateWords(desc, room)}, ${comp}`;
}
