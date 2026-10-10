/**
 * Garment attributes from free-text descriptions: gender, knit/woven construction,
 * garment type. These drive HTS chapter/heading choice downstream (61 knit vs 62 woven,
 * men's vs women's subheadings), so they are extracted deterministically from keywords.
 */
import type { Construction, Gender } from '@app/shared';

const GENDER_RULES: Array<[RegExp, Gender]> = [
  [/\b(?:UNISEX|GENDER[-\s]?NEUTRAL)\b/i, 'unisex'],
  [/\b(?:BABY|BABIES|BABY'S|INFANTS?'?S?|TODDLERS?'?S?|NEWBORNS?)\b/i, 'infant'],
  [/\b(?:BOYS?'?S?|BOY'S)\b/i, 'boys'],
  [/\b(?:GIRLS?'?S?|GIRL'S)\b/i, 'girls'],
  [/\b(?:WOMEN'?S?|WOMAN'?S|WOMENS|LADIES'?|LADY'?S?|FEMALE|WMNS|WMN'?S|MISSES)\b/i, 'women'],
  [/\b(?:MEN'?S?|MENS|MAN'?S|GENTS?'?|GENTLEMEN'?S?|MALE)\b/i, 'men'],
];

/** First gender mentioned (earliest position) in the text. */
export function detectGender(text: string): Gender | undefined {
  let best: { g: Gender; i: number } | undefined;
  for (const [re, g] of GENDER_RULES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.i)) best = { g, i: m.index };
  }
  return best?.g;
}

const KNIT_EXPLICIT = /\b(?:KNIT|KNITS|KNITTED|KNITTING|KNITWEAR)\b/i;
const WOVEN_EXPLICIT = /\b(?:WOVEN|WOVENS|WOVE)\b/i;
const KNIT_HINTS = /\b(?:JERSEY|PIQUE|PIQU[EÉ]|FLEECE|INTERLOCK|RIB|RIBBED|FRENCH\s+TERRY|LOOPBACK|WAFFLE\s+KNIT|SWEATER|PULLOVER\s+SWEATER|CARDIGAN|JUMPER|HOODIE|HOODY|SWEATSHIRT|T-?SHIRT|TEE|POLO|LEGGINGS?|TRICOT|MESH\s+KNIT|SINGLE\s+JERSEY|DOUBLE\s+KNIT|PONTE)\b/i;
const WOVEN_HINTS = /\b(?:TWILL|POPLIN|DENIM|CHAMBRAY|OXFORD|CREPE\s+DE\s+CHINE|CHIFFON|SATIN|CANVAS|CORDUROY|VOILE|GEORGETTE|LAWN|SEERSUCKER|DOBBY|GABARDINE|TAFFETA|ORGANZA|POPELINE|RIPSTOP|CHINO|CHINOS|SHIRTING)\b/i;

/**
 * Knit vs woven. An explicit "knitted"/"woven" wins over fabric hints;
 * both explicit words (e.g. "knit and woven garments") leave it undetermined.
 */
export function detectConstruction(text: string): Construction | undefined {
  const k = KNIT_EXPLICIT.test(text);
  const w = WOVEN_EXPLICIT.test(text);
  if (k && !w) return 'knit';
  if (w && !k) return 'woven';
  if (k && w) return undefined;
  const kh = KNIT_HINTS.exec(text);
  const wh = WOVEN_HINTS.exec(text);
  if (kh && !wh) return 'knit';
  if (wh && !kh) return 'woven';
  if (kh && wh) {
    // fabric words are more specific than garment words; prefer a fabric hint
    const fabricKnit = /\b(?:JERSEY|PIQUE|FLEECE|INTERLOCK|RIB|RIBBED|FRENCH\s+TERRY|TRICOT|PONTE)\b/i.test(text);
    return fabricKnit ? 'knit' : 'woven';
  }
  return undefined;
}

/** Ordered: specific types before generic ones (polo before shirt, hoodie before sweater). */
const GARMENT_RULES: Array<[RegExp, string]> = [
  [/\bPOLO\b/i, 'polo'],
  [/\b(?:T-?SHIRTS?|TEES?|TSHIRTS?|T\s+SHIRTS?|TANK\s+TOPS?|SINGLETS?|CAMISOLES?)\b/i, 't-shirt'],
  [/\b(?:HOODIES?|HOODY|HOODED\s+(?:SWEAT)?SHIRTS?|HOODED\s+JACKETS?)\b/i, 'hoodie'],
  [/\bSWEATSHIRTS?\b|\bCREW\s*NECK\s+SWEAT\b/i, 'sweatshirt'],
  [/\b(?:SWEATERS?|PULLOVERS?|JUMPERS?|CARDIGANS?|JERSEYS?\s+\(SWEATER\))\b/i, 'sweater'],
  [/\b(?:JEANS)\b/i, 'trousers'],
  [/\b(?:TROUSERS?|PANTS?|CHINOS?|SLACKS|JOGGERS?|SWEATPANTS|LEGGINGS?|BREECHES|OVERALLS)\b/i, 'trousers'],
  [/\bSHORTS\b/i, 'shorts'],
  [/\bBLOUSES?\b/i, 'blouse'],
  [/\b(?:SHIRTS?|SHIRTING)\b/i, 'shirt'],
  [/\bDRESS(?:ES)?\b/i, 'dress'],
  [/\bSKIRTS?\b/i, 'skirt'],
  [/\b(?:JACKETS?|BLAZERS?|PARKAS?|ANORAKS?|WINDBREAKERS?|COATS?|OVERCOATS?|VESTS?|GILETS?)\b/i, 'jacket'],
  [/\b(?:SUITS?)\b/i, 'suit'],
  [/\b(?:PAJAMAS?|PYJAMAS?|NIGHTDRESS|NIGHTWEAR|SLEEPWEAR|ROBES?)\b/i, 'sleepwear'],
  [/\b(?:BRIEFS?|BOXERS?|UNDERPANTS|PANTIES|UNDERWEAR|BRAS?|BRASSIERES?|LINGERIE)\b/i, 'underwear'],
  [/\b(?:SOCKS?|HOSIERY|TIGHTS)\b/i, 'socks'],
  [/\b(?:SWIMWEAR|SWIMSUITS?|BIKINIS?|SWIM\s+TRUNKS)\b/i, 'swimwear'],
  [/\b(?:GLOVES?|MITTENS?)\b/i, 'gloves'],
  [/\b(?:SCARF|SCARVES|SHAWLS?)\b/i, 'scarf'],
  [/\b(?:CAPS?|HATS?|BEANIES?)\b/i, 'headwear'],
];

/** Garment type keyword, checked against the title first and then the details. */
export function detectGarmentType(title: string, details = ''): string | undefined {
  for (const text of [title, details]) {
    for (const [re, type] of GARMENT_RULES) if (re.test(text)) return type;
  }
  return undefined;
}
