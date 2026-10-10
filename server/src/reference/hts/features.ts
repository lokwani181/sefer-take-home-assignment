/**
 * Rule-based features for HTS classification (no ML, no LLM).
 *
 * Two sides:
 *  - LineProfile: what we know about the shipment line (gender, garment type, knit/woven,
 *    fibre composition, materials, unit price, text tokens).
 *  - DescFeatures: what an HTS row's description requires (gender, garment group, fibre clause,
 *    "containing X percent or more by weight of Y" thresholds, special conditions that must be
 *    supported by the line text, materials, value conditions, residual "Other").
 * evaluate() scores a row against a line; strongly negative = contradicted/unsupported.
 */
import type { Fiber, Gender, ShipmentLine } from '@app/shared';

export type GarmentGroup =
  | 'tshirt' | 'singlet' | 'top' | 'sweater' | 'sweatshirt' | 'vest' | 'trousers' | 'shorts' | 'overalls'
  | 'blouse' | 'shirt' | 'jacket' | 'coat' | 'suit' | 'ensemble' | 'dress' | 'skirt' | 'underwear'
  | 'nightwear' | 'swimwear' | 'tracksuit' | 'hosiery' | 'gloves';

export type FibreGroup = 'cotton' | 'wool' | 'silk' | 'flax' | 'veg' | 'synthetic' | 'artificial' | 'down' | 'leather' | 'other';
export type Predominant = 'cotton' | 'wool' | 'silk' | 'flax' | 'veg' | 'mmf' | 'down' | 'leather' | 'other';
type DescGender = 'men' | 'boys' | 'women' | 'girls' | 'infant';

export const REJECT = -100;
/** Score for a row whose requirement can't be checked because the line lacks the attribute. */
const UNKNOWN = -0.05;

// ── Line profile ──────────────────────────────────────────────────────────────

export interface LineProfile {
  text: string;
  tokens: Set<string>;
  gender?: DescGender;
  genderNote?: string;
  genderSource?: 'attribute' | 'text' | 'unisex-rule';
  garments: Set<GarmentGroup>;
  garmentSource?: 'attribute' | 'text';
  construction?: 'knit' | 'woven';
  composition?: Fiber[];
  compositionSource?: 'opts' | 'attribute' | 'text';
  pct: Record<FibreGroup, number>;
  predominant?: Predominant;
  materials: Set<string>;
  /** Materials named next to "handle" ("wood handle", "handle: POM plastic"). */
  handleMaterials: Set<string>;
  unitPrice?: number;
}

const FIBRE_ALIASES: [RegExp, FibreGroup][] = [
  [/^(cotton|organic cotton|bci cotton|pima|supima)$/, 'cotton'],
  [/^(polyester|poly|pes|pet|recycled polyester|nylon|polyamide|pa|acrylic|elastane|spandex|lycra|elastomeric|polypropylene|pp|modacrylic|aramid|polyethylene|polyurethane|pu|synthetic|microfiber|microfibre)$/, 'synthetic'],
  [/^(viscose|rayon|modal|lyocell|tencel|acetate|triacetate|cupro|bamboo viscose|artificial)$/, 'artificial'],
  [/^(wool|merino|cashmere|alpaca|mohair|angora|camel|camel hair|yak|vicuna|fine animal hair|lambswool)$/, 'wool'],
  [/^(silk|silk waste)$/, 'silk'],
  [/^(linen|flax)$/, 'flax'],
  [/^(ramie|hemp|jute|sisal)$/, 'veg'],
  [/^(down|feather|feathers)$/, 'down'],
  [/^(leather)$/, 'leather'],
];

export function fibreGroup(fiber: string): FibreGroup {
  const f = fiber.trim().toLowerCase();
  for (const [re, g] of FIBRE_ALIASES) if (re.test(f)) return g;
  return 'other';
}

/**
 * Fibre that "predominates by weight" (Section XI note 2): synthetic + artificial count together
 * as man-made. Ties go to the heading occurring last in numerical order (silk 50 < wool 51 <
 * cotton 52 < flax/veg 53 < man-made 54-55).
 */
export function predominantFibre(pct: Record<FibreGroup, number>): Predominant | undefined {
  const groups: [Predominant, number][] = [
    ['silk', pct.silk],
    ['wool', pct.wool],
    ['cotton', pct.cotton],
    ['veg', pct.veg],
    ['flax', pct.flax],
    ['mmf', pct.synthetic + pct.artificial],
    ['down', pct.down],
    ['leather', pct.leather],
    ['other', pct.other],
  ];
  let best: [Predominant, number] | undefined;
  for (const g of groups) if (g[1] > 0 && (!best || g[1] >= best[1])) best = g;
  return best?.[0];
}

function emptyPct(): Record<FibreGroup, number> {
  return { cotton: 0, wool: 0, silk: 0, flax: 0, veg: 0, synthetic: 0, artificial: 0, down: 0, leather: 0, other: 0 };
}

/**
 * Composition from free text, used only when the parser supplied none:
 * "60% cotton 40% polyester", "100% organic cotton", "TC 65/35" (T/C = polyester/cotton),
 * "CVC 60/40" (cotton-rich), or a single fibre named without percentages (taken as 100%).
 */
export function compositionFromText(text: string): Fiber[] | undefined {
  const t = text.toLowerCase();
  const out: Fiber[] = [];
  for (const m of t.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%\s*([a-z][a-z -]{0,40})/g)) {
    // First one- or two-word phrase after the percentage that names a fibre ("organic cotton" → cotton).
    const words = m[2].split(/[\s-]+/).filter(Boolean).slice(0, 4);
    let fiber = '';
    for (let i = 0; i < words.length && !fiber; i++) {
      const two = words.slice(i, i + 2).join(' ');
      if (fibreGroup(two) !== 'other') fiber = two;
      else if (fibreGroup(words[i]) !== 'other') fiber = words[i];
    }
    out.push({ fiber: fiber || words[0] || 'other', pct: Number(m[1]) });
  }
  if (out.length) return out;
  const tc = t.match(/\b(tc|t\/c|cvc)\s*(\d{2})\s*\/\s*(\d{2})\b/);
  if (tc) {
    const [a, b] = [Number(tc[2]), Number(tc[3])];
    return tc[1] === 'cvc'
      ? [{ fiber: 'cotton', pct: a }, { fiber: 'polyester', pct: b }]
      : [{ fiber: 'polyester', pct: a }, { fiber: 'cotton', pct: b }];
  }
  if (!/\b(blend|blended|mix|mixed)\b/.test(t)) {
    const named = new Set<string>();
    for (const m of t.matchAll(/\b(cotton|polyester|nylon|polyamide|acrylic|wool|merino|cashmere|silk|linen|viscose|rayon|modal|lyocell)\b/g)) named.add(m[1]);
    if (named.size === 1) return [{ fiber: [...named][0], pct: 100 }];
  }
  return undefined;
}

const GARMENT_TYPE_GROUPS: Record<string, GarmentGroup[]> = {
  't-shirt': ['tshirt', 'top'], tshirt: ['tshirt', 'top'], tee: ['tshirt', 'top'],
  'tank top': ['singlet', 'top'], singlet: ['singlet', 'top'], camisole: ['singlet', 'top'],
  hoodie: ['sweatshirt'], sweatshirt: ['sweatshirt'], 'fleece pullover': ['sweatshirt'],
  sweater: ['sweater'], cardigan: ['sweater'], jumper: ['sweater'], pullover: ['sweater'],
  vest: ['vest'], waistcoat: ['vest'],
  trousers: ['trousers'], pants: ['trousers'], jeans: ['trousers'], chinos: ['trousers'], slacks: ['trousers'], leggings: ['trousers'], joggers: ['trousers'],
  shorts: ['shorts'], overalls: ['overalls'],
  blouse: ['blouse', 'shirt', 'top'], shirt: ['shirt', 'top'], polo: ['shirt', 'top'],
  dress: ['dress'], skirt: ['skirt'],
  jacket: ['jacket'], blazer: ['jacket'],
  coat: ['coat'], anorak: ['coat'], parka: ['coat'], windbreaker: ['coat'],
  suit: ['suit'], ensemble: ['ensemble'],
  underwear: ['underwear'], briefs: ['underwear'], boxers: ['underwear'], panties: ['underwear'], bra: ['underwear'],
  pajamas: ['nightwear'], nightwear: ['nightwear'], robe: ['nightwear'], bathrobe: ['nightwear'],
  swimwear: ['swimwear'], swimsuit: ['swimwear'],
  socks: ['hosiery'], hosiery: ['hosiery'], tights: ['hosiery'],
  gloves: ['gloves'], tracksuit: ['tracksuit'],
};

/** Garment keywords in line text (used when the parser gave no garmentType). Order = priority. */
const LINE_GARMENT_TEXT: [RegExp, GarmentGroup[]][] = [
  [/\bhood(ie|y|ed)\b|\bsweat ?shirts?\b|\bfleece (pullover|top|crew)\b/, ['sweatshirt']],
  [/\bt-?shirts?\b|\btees?\b/, ['tshirt', 'top']],
  [/\btank ?tops?\b|\bsinglets?\b|\bcamisoles?\b/, ['singlet', 'top']],
  [/\bpolo\b/, ['shirt', 'top']],
  [/\bblouses?\b/, ['blouse', 'shirt', 'top']],
  [/\bsweaters?\b|\bcardigans?\b|\bjumpers?\b|\bpullovers?\b/, ['sweater']],
  [/\btrousers\b|\bpants\b|\bjeans\b|\bchinos?\b|\bslacks\b|\bleggings\b|\bjoggers\b/, ['trousers']],
  [/\bshorts\b/, ['shorts']],
  [/\boveralls\b|\bdungarees\b/, ['overalls']],
  [/\bdress(es)?\b/, ['dress']],
  [/\bskirts?\b/, ['skirt']],
  [/\bblazers?\b|\bjackets?\b/, ['jacket']],
  [/\bcoats?\b|\banoraks?\b|\bparkas?\b|\bwindbreakers?\b/, ['coat']],
  [/\bshirts?\b/, ['shirt', 'top']],
  [/\bvests?\b|\bwaistcoats?\b/, ['vest']],
  [/\bpajamas\b|\bpyjamas\b|\bnightwear\b|\bbath ?robes?\b/, ['nightwear']],
  [/\bunderwear\b|\bbriefs\b|\bboxers?\b|\bpanties\b/, ['underwear']],
  [/\bswim(wear|suits?)\b/, ['swimwear']],
  [/\bsocks\b|\bhosiery\b|\btights\b/, ['hosiery']],
  [/\bgloves\b|\bmittens\b/, ['gloves']],
];

const MATERIALS: [RegExp, string[]][] = [
  [/\bstainless\b/, ['stainless', 'steel']],
  [/\bcast iron\b/, ['castiron']],
  [/\bsteel\b/, ['steel']],
  [/\biron\b/, ['iron']],
  [/\balumin(i)?um\b/, ['aluminum']],
  [/\bcopper\b|\bbrass\b|\bbronze\b/, ['copper']],
  [/\bteak\b/, ['teak']],
  [/\bbent-?wood\b/, ['wood']],
  [/\bwood(en)?\b|\btimber\b|\boak\b|\bpine\b|\bwalnut\b|\bbeech\b|\bbirch\b|\bacacia\b|\bmdf\b|\bplywood\b|\bparticleboard\b/, ['wood']],
  [/\bbamboo\b/, ['bamboo']],
  [/\brattan\b|\bwicker\b|\bosier\b/, ['rattan']],
  [/\bplastics?\b|\bpolypropylene\b|\bpolyethylene\b|\bpolystyrene\b|\bpvc\b|\bmelamine\b|\bpolycarbonate\b/, ['plastics']],
  [/\bglass(ware)?\b/, ['glass']],
  [/\bceramics?\b|\bporcelain\b|\bstoneware\b|\bearthenware\b/, ['ceramic']],
  [/\bleather\b/, ['leather']],
  [/\bpaper\b|\bpaperboard\b|\bcardboard\b/, ['paper']],
  [/\btextile\b|\bfabric\b|\bcotton\b|\bpolyester\b|\bnylon\b|\bcanvas\b|\bman-made fib/, ['textile']],
  [/\brubber\b|\bsilicone\b/, ['rubber']],
  [/\bsilver\b|\bsterling\b/, ['silver']],
  [/\bbase metal\b|\bmetal\b/, ['metal']],
];

/** Materials mentioned in a text (non-fibre sense, for kitchenware/furniture/bags). */
export function materialsIn(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (const [re, mats] of MATERIALS) if (re.test(t)) for (const m of mats) out.add(m);
  // Any named metal is a base metal for rows that say "of base metal".
  if (['steel', 'stainless', 'iron', 'castiron', 'aluminum', 'copper'].some((m) => out.has(m))) out.add('metal');
  if (out.has('castiron')) out.add('iron');
  return out;
}

const STOPWORDS = new Set(
  ('a an and or of the for with without in on to by from other others than not nor its their whether kind kinds type types used use ' +
    'article articles similar thereof parts part etc including include described provided subheading subheadings heading headings note notes chapter ' +
    'statistical foregoing each more less percent weight containing contain contains which such this that these those be is are as at all any ' +
    'only also but if no new pcs pc piece pieces set sets size sizes colour colours color colors style item items assorted total qty quantity ' +
    'unit units ctn ctns carton cartons gsm cm mm inch inches dozen doz kg n e s nes having has whose made').split(' '),
);

/** Light stemming so "knives" ≈ "knife", "towels" ≈ "towel", "wooden" ≈ "wood". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 2) return w;
  const special: Record<string, string> = { knives: 'knife', wooden: 'wood', toweling: 'towel', towelling: 'towel', furnishings: 'furniture', trousers: 'trousers', shorts: 'shorts', pants: 'trousers', cookware: 'cooking', kitchenware: 'kitchen', tableware: 'table', bakeware: 'bake' };
  if (special[w]) return special[w];
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (/(ches|shes|sses|xes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  return w;
}

/** Content tokens (stemmed, stopwords and numbers removed). Compound "kitchenware" also yields "ware". */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!s || STOPWORDS.has(s)) continue;
    out.push(s);
    if (/ware$/.test(raw) && raw.length > 4) out.push('ware');
  }
  return out;
}

/** Everyday words → the wording the HTS uses for the same thing. */
const TOKEN_SYNONYMS: Record<string, string[]> = {
  chef: ['kitchen'], santoku: ['kitchen'], paring: ['kitchen'], cleaver: ['kitchen', 'butcher'],
  cookware: ['cooking', 'kitchen'], pot: ['cooking'], pan: ['cooking'], skillet: ['cooking'], wok: ['cooking'],
  backpack: ['bag'], rucksack: ['backpack', 'bag'], knapsack: ['backpack', 'bag'], tote: ['bag'], duffel: ['bag'], handbag: ['bag'],
  sofa: ['seat'], couch: ['seat'], chair: ['seat'], stool: ['seat'],
  mixing: ['kitchen', 'ware'], colander: ['kitchen', 'ware'], ladle: ['kitchen', 'ware'], spatula: ['kitchen', 'ware'], whisk: ['kitchen', 'ware'], strainer: ['kitchen', 'ware'], grater: ['kitchen', 'ware'],
};

/** Build the line profile; `compositionOverride` is the alternative composition (ClassifyOptions). */
export function buildProfile(line: ShipmentLine, compositionOverride?: Fiber[]): LineProfile {
  const text = [line.description, ...(line.details ?? []), line.attributes?.garmentType ?? ''].join(' \n ').toLowerCase().replace(/[’`]/g, "'");
  const attrs = line.attributes ?? {};
  const profile: LineProfile = {
    text,
    tokens: new Set(contentTokens(text)),
    garments: new Set(),
    pct: emptyPct(),
    materials: materialsIn(text),
    handleMaterials: new Set(),
    unitPrice: line.unitPrice,
  };
  if (profile.materials.has('teak')) profile.materials.add('wood');
  for (const m of text.matchAll(/((?:[a-z-]+\s+){0,3})handles?\b(?:\s*(?:of|in|:)\s*((?:[a-z-]+\s*){0,3}))?/g)) {
    for (const mat of materialsIn(`${m[1] ?? ''} ${m[2] ?? ''}`)) profile.handleMaterials.add(mat);
  }
  for (const t of [...profile.tokens]) for (const syn of TOKEN_SYNONYMS[t] ?? []) profile.tokens.add(syn);

  // Gender
  let g: Gender | undefined = attrs.gender;
  let gSource: LineProfile['genderSource'] = g ? 'attribute' : undefined;
  if (!g) {
    if (/\bunisex\b/.test(text)) g = 'unisex';
    else if (/\b(women'?s?|ladies'?|lady'?s|female|womens)\b/.test(text)) g = 'women';
    else if (/\bgirls?'?s?\b/.test(text)) g = 'girls';
    else if (/\bboys?'?s?\b/.test(text)) g = 'boys';
    else if (/\b(men'?s?|mens|gents?'?|male)\b/.test(text)) g = 'men';
    else if (/\b(baby|babies|infants?|toddlers?)\b/.test(text)) g = 'infant';
    if (g) gSource = 'text';
  }
  if (g === 'unisex') {
    profile.gender = 'women';
    profile.genderSource = 'unisex-rule';
    profile.genderNote =
      "unisex: garments not identifiable as men's or women's are classified as women's (Ch. 61 note 9 / Ch. 62 note 8)";
  } else if (g) {
    profile.gender = g;
    profile.genderSource = gSource;
  }

  // Garment groups: the parser's garmentType wins; text keywords only fill gaps.
  const gt = attrs.garmentType?.trim().toLowerCase();
  if (gt && GARMENT_TYPE_GROUPS[gt]) {
    for (const x of GARMENT_TYPE_GROUPS[gt]) profile.garments.add(x);
    profile.garmentSource = 'attribute';
  } else {
    for (const [re, groups] of LINE_GARMENT_TEXT) {
      if (re.test(text)) {
        for (const x of groups) profile.garments.add(x);
        profile.garmentSource = 'text';
        break;
      }
    }
  }

  // Construction
  const c = attrs.construction;
  if (c === 'knit' || c === 'woven') profile.construction = c;
  else if (/\b(knit|knitted|crochet(ed)?|jersey|fleece|pique|interlock|rib-?knit)\b/.test(text)) profile.construction = 'knit';
  else if (/\b(woven|twill|denim|poplin|oxford|canvas|chiffon|crepe de chine|satin|chambray|flannel|corduroy|seersucker)\b/.test(text)) profile.construction = 'woven';

  // Composition
  let comp = compositionOverride;
  let compSource: LineProfile['compositionSource'] = comp ? 'opts' : undefined;
  if (!comp && attrs.composition?.length) {
    comp = attrs.composition;
    compSource = 'attribute';
  }
  if (!comp) {
    comp = compositionFromText(text);
    if (comp) compSource = 'text';
  }
  if (comp?.length) {
    profile.composition = comp;
    profile.compositionSource = compSource;
    for (const f of comp) profile.pct[fibreGroup(f.fiber)] += f.pct;
    profile.predominant = predominantFibre(profile.pct);
  }
  return profile;
}

export function describeComposition(comp: Fiber[] | undefined): string {
  return comp?.length ? comp.map((f) => `${f.pct}% ${f.fiber}`).join(' / ') : 'unknown';
}

// ── Description features ──────────────────────────────────────────────────────

interface Special {
  key: string;
  /** Also a requirement on 4-digit heading rows (most heading text only lists examples). */
  onHeading?: boolean;
  match: RegExp;
  /** Line text that supports choosing the row. */
  support: RegExp;
  /** Row requires the ABSENCE of the support (e.g. "not enameled"). */
  negated?: boolean;
}

const SPECIALS: Special[] = [
  { key: 'recreational performance outerwear', match: /recreational performance outerwear/, support: /recreational performance|performance outerwear|\brpo\b/ },
  { key: 'playsuit parts', match: /playsuits?/, support: /playsuit/ },
  { key: 'knit to shape', match: /knit to shape/, support: /knit[- ]to[- ]shape|fully[- ]fashion|full[- ]fashion/ },
  { key: 'hand-loomed/folklore', match: /hand-?loomed|folklore/, support: /hand[- ]?loom|folklore/ },
  { key: 'hospital/laboratory use', match: /hospitals?|clinics?|laborator|contaminated areas/, support: /hospital|clinic|laborator|scrubs|surgical|medical|clean ?room/ },
  { key: 'all white', match: /all white/, support: /\ball[- ]white\b|\bwhite only\b|\bsolid white\b/ },
  { key: 'thermal', match: /\bthermal\b/, support: /thermal/ },
  { key: 'corduroy', match: /corduroy/, support: /corduroy|\bcords\b/ },
  { key: 'denim', match: /\bdenim\b/, support: /denim|\bjeans?\b/ },
  { key: 'insulated', match: /insulated|cold weather/, support: /insulat|padded|quilted|cold[- ]weather|down[- ]filled/ },
  { key: 'compact yarns', match: /compact yarns?/, support: /compact yarn/ },
  { key: 'yarn-dyed (two or more colours in warp/filling)', match: /two or more colors|colors in the warp|yarns of different colors/, support: /yarn[- ]dyed|stripe|plaid|\bchecks?\b|\bchecked\b|gingham|tartan|madras|chambray|multi[- ]?colou?r(ed)? (yarn|warp|weft)/ },
  { key: 'parts of suits', match: /parts of suits|for suits described/, support: /\bsuits?\b/ },
  { key: 'martial arts uniform', match: /judo|karate|martial arts/, support: /judo|karate|martial|taekwondo|jiu[- ]?jitsu/ },
  { key: 'worsted wool ≤18.5 micron', match: /worsted wool|18\.5 microns/, support: /worsted|18\.5|super ?1[0-9]0/ },
  { key: 'water resistant', match: /water[- ]resistant/, support: /water[- ]?(resistant|proof|repellent)/ },
  { key: 'silver', match: /silver-plated|silver handles|sterling silver|\bof silver\b/, support: /silver|sterling/ },
  { key: 'set', match: /\bsets?\b/, support: /\bsets?\b|\bkits?\b/ },
  { key: 'legal note provision', match: /described in (additional u\.s\. note|general note|u\.s\. note)|entered pursuant to/, support: /(?!)/ },
  { key: 'not enameled', match: /not enamell?ed/, support: /enamel/, negated: true },
  { key: 'enameled', match: /(?<!not )enamell?ed/, support: /enamel/ },
  { key: 'bent-wood', match: /bent-?wood/, support: /bent-?wood/ },
  { key: 'jewelry box', match: /jewelry/, support: /jewel/ },
  { key: 'child enclosure', match: /play yards|confining children|confining children or pets/, support: /play ?yard|playpen|enclosure|safety gate|baby gate/ },
  { key: 'musical instrument case', match: /musical instrument/, support: /music|instrument|guitar|violin/ },
  { key: 'insulated food/beverage bag', match: /insulated food or beverage|beverage bags/, support: /insulated|cooler|beverage|lunch bag/ },
  { key: 'terry', match: /\bterry\b/, support: /\bterry\b/ },
  { key: 'pile/tufted', match: /\bpile or tufted\b|\btufted\b/, support: /\bpile\b|tufted|velour|velvet/ },
  { key: 'long sleeves', match: /with long sleeves/, support: /long[- ]sleeve/ },
  { key: 'napped', match: /\bnapped\b/, support: /napped|brushed/ },
  { key: 'for machines', match: /\bfor machines\b|\bfor mechanical appliances\b/, support: /machine|mechanical|industrial|chipper|mower|planer|cutter ?head/, onHeading: true },
  { key: 'parts/components', match: /^(parts|blades|handles|accessories|frames)\b/, support: /\b(parts?|spares?|components?|replacement|blanks?)\b/ },
];

/** Clauses that describe exclusions — removed before looking for positive features. */
export function stripExclusions(s: string, marker = ' '): string {
  return s
    .replace(/[^;,:]*\bnot falling within\b[^;,:]*/g, ' ')
    .replace(/\(?\bother than\b[^,;:()]*\)?/g, marker)
    .replace(/\(?\bexcept\b[^,;:()]*\)?/g, marker)
    .replace(/\(?\bexcluding\b[^,;:()]*\)?/g, marker);
}

/** Stands in for an "other than …" restriction inside an item, so the item can't fully match. */
const EXCLUDED = 'xexcluded';

const GENDER_RES: [RegExp, DescGender][] = [
  [/\bmen'?s\b|\bmen\b/, 'men'],
  [/\bboys'?\b|\bboy's\b/, 'boys'],
  [/\bwomen'?s\b|\bwomen\b|\bladies'?\b/, 'women'],
  [/\bgirls'?\b/, 'girls'],
  [/\bbabies'?\b|\binfants'?\b/, 'infant'],
];

/** Ordered: matched phrases are removed before later patterns run ("tank tops" must not also read as "tops"). */
const GARMENT_RES: [RegExp, GarmentGroup[]][] = [
  [/\btrack ?suits?\b|\bski-?suits?\b/, ['tracksuit']],
  [/\bswimwear\b|\bswimsuits?\b|\bbathing suits?\b|\bswim trunks\b/, ['swimwear']],
  [/\bt-?shirts?\b/, ['tshirt']],
  [/\bsinglets?\b|\btank tops?\b/, ['singlet']],
  [/\bsweaters?\b|\bcardigans?\b|\bjumpers?\b/, ['sweater']],
  [/\bpullovers?\b/, ['sweater', 'sweatshirt']],
  [/\bsweatshirts?\b/, ['sweatshirt']],
  [/\bvests?\b|\bwaistcoats?\b/, ['vest']],
  [/\btrousers\b|\bbreeches\b|\bslacks\b|\bpants\b/, ['trousers']],
  [/\bshorts\b/, ['shorts']],
  [/\boveralls\b/, ['overalls']],
  [/\bblouses?\b|\bshirt-blouses?\b/, ['blouse']],
  [/(?<![-\w])shirts?\b/, ['shirt']],
  [/\btops\b/, ['top']],
  [/\bjackets?\b|\bblazers?\b/, ['jacket']],
  [/\b(over)?coats?\b|\bcar ?coats?\b|\bcapes?\b|\bcloaks?\b|\banoraks?\b|\bwind-?breakers?\b|\bwind-jackets?\b|\bparkas?\b/, ['coat']],
  [/(?<![-\w])suits?\b(?!-type)/, ['suit']],
  [/\bensembles?\b/, ['ensemble']],
  [/\bdresses\b|\bdress\b(?!ing)/, ['dress']],
  [/\bskirts?\b/, ['skirt']],
  [/\bunderwear\b|\bunderpants\b|\bbriefs\b|\bpanties\b|\bundershirts?\b|\bslips\b|\bpetticoats\b|\bboxers?\b/, ['underwear']],
  [/\bnightshirts?\b|\bpajamas\b|\bpyjamas\b|\bnightdresses\b|\bbathrobes\b|\bdressing gowns\b|\bnegligees\b/, ['nightwear']],
  [/\bhosiery\b|\bsocks\b|\btights\b|\bpanty ?hose\b|\bstockings\b/, ['hosiery']],
  [/\bgloves\b|\bmittens\b|\bmitts\b/, ['gloves']],
];

type FibreClause = 'cotton' | 'wool' | 'silk' | 'flax' | 'veg' | 'mmf' | 'synthetic' | 'artificial' | 'other' | 'textile';

const FIBRE_CLAUSES: [RegExp, FibreClause][] = [
  [/\bof cotton\b/, 'cotton'],
  [/\bof synthetic (fib|staple|filament)/, 'synthetic'],
  [/\bof artificial (fib|staple|filament)/, 'artificial'],
  [/\bof man-made (fib|staple|filament)/, 'mmf'],
  [/\bof (wool|fine animal hair|kashmir|cashmere)\b/, 'wool'],
  [/\bof silk\b/, 'silk'],
  [/\bof (flax|linen)\b/, 'flax'],
  [/\bof vegetable fib/, 'veg'],
  [/\bof other textile materials\b|\bof other fib/, 'other'],
  [/\bof textile materials\b|\bouter surface of textile\b/, 'textile'],
];

interface Threshold {
  fibre: FibreGroup | 'mmf' | 'elastane';
  pct: number;
  op: '>=' | '<';
}

export interface DescFeatures {
  genders: Set<DescGender>;
  garments: Set<GarmentGroup>;
  fibres: Set<FibreClause>;
  thresholds: Threshold[];
  specials: Special[];
  restraint?: 'cotton' | 'wool' | 'mmf';
  construction?: 'knit' | 'woven';
  materials: Set<string>;
  /** "Knives with stainless steel handles" → materials of the handle only. */
  handleMaterials: Set<string>;
  value?: { op: 'under' | 'over' | 'notover' | 'notunder'; usd: number };
  isOther: boolean;
  /** Description starts with "Other" (e.g. "Other knives having fixed blades"): a residual-style row. */
  startsOther: boolean;
  /** 4-digit heading row: its text lists examples, so unmatched words are not held against it. */
  isHeading: boolean;
  tokens: string[];
  /** Alternatives the row lists ("Kitchen and butcher knives" → [kitchen] | [butcher, knife]). */
  items: string[][];
}

function thresholdFibre(phrase: string): Threshold['fibre'] | undefined {
  if (/flax/.test(phrase)) return 'flax';
  if (/wool|animal hair/.test(phrase)) return 'wool';
  if (/silk/.test(phrase)) return 'silk';
  if (/\bdown\b/.test(phrase)) return 'down';
  if (/leather/.test(phrase)) return 'leather';
  if (/cotton/.test(phrase)) return 'cotton';
  if (/man-made/.test(phrase)) return 'mmf';
  if (/synthetic/.test(phrase)) return 'synthetic';
  if (/artificial/.test(phrase)) return 'artificial';
  if (/elastomeric|elastane|spandex/.test(phrase)) return 'elastane';
  return undefined;
}

const featureCache = new Map<string, DescFeatures>();

/** Parse an HTS row description into requirements. `heading` is set for 4-digit heading rows (chapter 61/62 → knit/woven). */
export function describe(description: string, heading?: string): DescFeatures {
  const cacheKey = `${heading ?? ''}|${description}`;
  const hit = featureCache.get(cacheKey);
  if (hit) return hit;
  let s = description.toLowerCase().replace(/[’`]/g, "'").replace(/\(\d{3}\)/g, ' ').replace(/\s+/g, ' ').trim();
  const f: DescFeatures = {
    genders: new Set(),
    garments: new Set(),
    fibres: new Set(),
    thresholds: [],
    specials: [],
    materials: new Set(),
    handleMaterials: new Set(),
    isOther: false,
    startsOther: /^other\b/.test(s),
    isHeading: !!heading,
    tokens: [],
    items: [],
  };
  const s0 = s;
  // "Wholly of cashmere": only when the line says 100% of that fibre.
  const wholly = s.match(/^wholly of ([a-z]+)/);
  if (wholly) {
    f.specials.push({ key: `wholly of ${wholly[1]}`, match: /^wholly of [a-z]+/, support: new RegExp(`100\\s*%\\s*${wholly[1]}|${wholly[1]}\\s*100\\s*%|pure ${wholly[1]}`) });
    s = s.replace(/^wholly of [a-z]+/, ' ');
  }

  // Construction
  if (/\bnot knitted or crocheted\b/.test(s)) f.construction = 'woven';
  else if (/\bknitted or crocheted\b/.test(s)) f.construction = 'knit';
  if (heading && /^61/.test(heading)) f.construction = 'knit';
  if (heading && /^62/.test(heading)) f.construction = 'woven';
  s = s.replace(/\b(not )?knitted or crocheted\b/g, ' ');

  // Thresholds ("containing 36 percent or more by weight of flax fibers")
  for (const m of s.matchAll(/containing (less than )?(\d+(?:\.\d+)?) percent (or more )?by weight of ([a-z' -]+?)(?=[;,:)]|\(| and of which| or more|$)/g)) {
    const fib = thresholdFibre(m[4]);
    if (fib) f.thresholds.push({ fibre: fib, pct: Number(m[2]), op: m[1] ? '<' : '>=' });
  }
  for (const m of s.matchAll(/containing by weight (\d+) percent or more ([a-z]+)/g)) {
    const fib = thresholdFibre(m[2]);
    if (fib) f.thresholds.push({ fibre: fib, pct: Number(m[1]), op: '>=' });
  }
  for (const m of s.matchAll(/containing (elastomeric) fib/g)) f.thresholds.push({ fibre: thresholdFibre(m[1])!, pct: 0.0001, op: '>=' });
  s = s
    .replace(/containing (less than )?\d+(?:\.\d+)? percent (or more )?by weight of [^;,:()]*/g, ' ')
    .replace(/containing by weight \d+ percent or more [a-z]+ fib[a-z]*/g, ' ')
    .replace(/and of which [^;,:()]*/g, ' ');

  // Restraints ("Subject to cotton restraints")
  const r = s.match(/subject to (cotton|wool|man-made fiber) restraints/);
  if (r) f.restraint = r[1] === 'man-made fiber' ? 'mmf' : (r[1] as 'cotton' | 'wool');
  s = s.replace(/subject to [a-z -]+ restraints/g, ' ');

  // Value conditions ("Valued under 25¢ each")
  const v = heading ? null : s.match(/valued (not over|not under|under|over) \$?(\d+(?:\.\d+)?)\s*(¢)?/);
  if (v) {
    const op = v[1] === 'not over' ? 'notover' : v[1] === 'not under' ? 'notunder' : (v[1] as 'under' | 'over');
    f.value = { op, usd: v[3] ? Number(v[2]) / 100 : Number(v[2]) };
    s = s.replace(/valued [^;,:]*/, ' ');
  }

  // Special conditions (not on 4-digit heading rows: those list examples, not requirements)
  for (const sp of heading ? SPECIALS.filter((x) => x.onHeading) : SPECIALS) {
    if (sp.match.test(s)) {
      f.specials.push(sp);
      s = s.replace(new RegExp(sp.match.source, 'g'), ' ');
    }
  }

  let marked = stripExclusions(s, ` ${EXCLUDED} `);
  const handle = marked.match(/\bwith ([a-z ,-]+?) handles?\b/);
  if (handle) {
    for (const m of materialsIn(handle[1])) f.handleMaterials.add(m);
    if (f.handleMaterials.size) marked = marked.replace(handle[0], ' ');
  }
  const positive = marked.replaceAll(EXCLUDED, ' ');
  for (const [re, g] of GENDER_RES) if (re.test(positive)) f.genders.add(g);
  let garmentText = positive;
  for (const [re, groups] of GARMENT_RES) {
    if (re.test(garmentText)) {
      for (const g of groups) f.garments.add(g);
      garmentText = garmentText.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  for (const [re, fib] of FIBRE_CLAUSES) if (re.test(positive)) f.fibres.add(fib);
  for (const m of materialsIn(positive)) if (m !== 'textile' || f.fibres.size === 0) f.materials.add(m);
  if (f.fibres.size > 0) f.materials.delete('textile');
  if (f.fibres.has('textile')) {
    f.fibres.delete('textile');
    f.materials.add('textile');
  }

  // Residual tokens for text overlap: drop everything the structured features consumed.
  let residual = marked;
  for (const [re] of GENDER_RES) residual = residual.replace(new RegExp(re.source, 'g'), ' ');
  for (const [re] of GARMENT_RES) residual = residual.replace(new RegExp(re.source, 'g'), ' ');
  for (const [re] of FIBRE_CLAUSES) residual = residual.replace(new RegExp(re.source + '[a-z]*', 'g'), ' ');
  for (const [re] of MATERIALS) residual = residual.replace(new RegExp(re.source, 'g'), ' ');
  residual = residual.replace(/\b(fib(er|re)s?|staple|filaments?|garments?|apparel|clothing|wear)\b/g, ' ');
  // "Knives having other than fixed blades" keeps a marker so "knives" alone doesn't fully match it;
  // a clause that is only an exclusion ("(other than swimwear)") is dropped.
  f.items = residual
    .split(/[,;:()]|\band\b|\bor\b/)
    .map((part) => [...new Set(contentTokens(part))])
    .filter((it) => it.length > 0 && !(it.length === 1 && it[0] === EXCLUDED));
  f.tokens = [...new Set(f.items.flat())].filter((t) => t !== EXCLUDED);

  // Residual "Other" rows: nothing to match, chosen when every specific sibling is excluded.
  f.isOther =
    /^other\b/.test(s0) &&
    f.genders.size === 0 &&
    f.garments.size === 0 &&
    f.fibres.size === 0 &&
    f.materials.size === 0 &&
    f.handleMaterials.size === 0 &&
    f.thresholds.length === 0 &&
    f.specials.length === 0 &&
    f.tokens.length === 0;
  featureCache.set(cacheKey, f);
  return f;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

export type RejectKind = 'gender' | 'garment' | 'fibre' | 'construction' | 'threshold' | 'special' | 'material' | 'value' | 'restraint';

export interface Evaluation {
  score: number;
  rejected: boolean;
  /** At least one requirement matched an explicit line attribute. */
  explicit: boolean;
  /** At least one requirement could not be checked (attribute missing). */
  assumed: boolean;
  reasons: string[];
  rejections: { kind: RejectKind; reason: string }[];
  /** Some of the row's own words appear in the line text. */
  textMatched: boolean;
}

function pctOf(p: LineProfile, fibre: Threshold['fibre']): number {
  const comp = p.composition ?? [];
  if (fibre === 'mmf') return p.pct.synthetic + p.pct.artificial;
  if (fibre === 'elastane') return comp.filter((c) => /elast|spandex|lycra/i.test(c.fiber)).reduce((a, c) => a + c.pct, 0);
  return p.pct[fibre];
}

function fibreMatches(clause: FibreClause, p: LineProfile): boolean | 'fallback' {
  const pre = p.predominant;
  switch (clause) {
    case 'cotton':
      return pre === 'cotton';
    case 'mmf':
      return pre === 'mmf';
    case 'synthetic':
      return pre === 'mmf' && p.pct.synthetic >= p.pct.artificial;
    case 'artificial':
      return pre === 'mmf' && p.pct.artificial > p.pct.synthetic;
    case 'wool':
      return pre === 'wool';
    case 'silk':
      return pre === 'silk';
    case 'flax':
      return pre === 'flax';
    case 'veg':
      return pre === 'cotton' || pre === 'flax' || pre === 'veg';
    case 'other':
    case 'textile':
      return 'fallback';
  }
}

/** Fibre "restraint" group for "Subject to cotton/wool/man-made fiber restraints": the largest of the three if they total ≥ 50%. */
function restraintGroup(p: LineProfile): 'cotton' | 'wool' | 'mmf' | undefined {
  const c = p.pct.cotton;
  const w = p.pct.wool;
  const m = p.pct.synthetic + p.pct.artificial;
  if (c + w + m < 50) return undefined;
  return m >= c && m >= w ? 'mmf' : c >= w ? 'cotton' : 'wool';
}

const GENDER_LABEL: Record<DescGender, string> = { men: "men's", boys: "boys'", women: "women's", girls: "girls'", infant: 'babies' };

/**
 * Score one HTS row against the line. `ignore` holds row words ("knife") and materials
 * ("mat:wood") that don't discriminate between the row and its siblings.
 */
export function evaluate(f: DescFeatures, p: LineProfile, ignore?: Set<string>): Evaluation {
  const e: Evaluation = { score: 0, rejected: false, explicit: false, assumed: false, reasons: [], rejections: [], textMatched: false };
  const reject = (kind: RejectKind, reason: string): void => {
    e.score += REJECT;
    e.rejected = true;
    e.rejections.push({ kind, reason });
  };

  if (f.genders.size > 0) {
    if (p.gender && f.genders.has(p.gender)) {
      e.score += 3;
      e.explicit = true;
      e.reasons.push(`gender ${GENDER_LABEL[p.gender]}${p.genderSource === 'unisex-rule' ? ' (unisex rule)' : ''}`);
    } else if (p.gender) {
      reject('gender', `line is ${GENDER_LABEL[p.gender]}`);
    } else {
      e.score += UNKNOWN + (f.genders.has('women') ? 0.01 : 0);
      e.assumed = true;
      e.reasons.push('gender not stated');
    }
  }

  if (f.garments.size > 0) {
    const hit = [...p.garments].filter((g) => f.garments.has(g));
    if (hit.length) {
      e.score += 3;
      e.explicit = true;
      e.reasons.push(`garment ${hit[0]}`);
    } else if (p.garments.size > 0) {
      reject('garment', `line garment is ${[...p.garments][0]}`);
    } else {
      e.score += UNKNOWN;
      e.assumed = true;
      e.reasons.push('garment type not stated');
    }
  }

  if (f.construction && p.construction) {
    if (f.construction === p.construction) {
      e.score += 1;
      e.reasons.push(p.construction);
    } else {
      reject('construction', `line is ${p.construction}, row is ${f.construction}`);
    }
  }

  if (f.fibres.size > 0) {
    if (!p.predominant) {
      e.score += UNKNOWN;
      e.assumed = true;
      e.reasons.push('composition unknown');
    } else {
      const results = [...f.fibres].map((c) => fibreMatches(c, p));
      if (results.includes(true)) {
        e.score += 4;
        e.explicit = true;
        e.reasons.push(`predominant fibre ${p.predominant === 'mmf' ? 'man-made' : p.predominant} (${describeComposition(p.composition)})`);
      } else if (!results.includes('fallback')) {
        reject('fibre', `predominant fibre is ${p.predominant === 'mmf' ? 'man-made' : p.predominant}`);
      }
    }
  }

  for (const t of f.thresholds) {
    if (!p.composition) {
      reject('threshold', `needs ${t.op === '<' ? '<' : '≥'}${t.pct}% ${t.fibre}; composition unknown`);
      continue;
    }
    const have = pctOf(p, t.fibre);
    const ok = t.op === '>=' ? have >= t.pct : have < t.pct;
    if (ok) {
      e.score += 5;
      e.explicit = true;
      e.reasons.push(`${have}% ${t.fibre} ${t.op === '>=' ? '≥' : '<'} ${t.pct}%`);
    } else {
      reject('threshold', `${have}% ${t.fibre}, row needs ${t.op === '>=' ? '≥' : '<'}${t.pct}%`);
    }
  }

  for (const sp of f.specials) {
    const present = sp.support.test(p.text);
    if (present !== !!sp.negated) {
      e.score += sp.negated ? 0.5 : 5;
      e.explicit = true;
      e.reasons.push(`${sp.key} (stated)`);
    } else {
      reject('special', `"${sp.key}" not supported by the line text`);
    }
  }

  if (f.restraint) {
    const g = restraintGroup(p);
    if (g && g === f.restraint) {
      e.score += 2;
      e.explicit = true;
      e.reasons.push(`${f.restraint} restraint group`);
    } else {
      reject('restraint', `line is not in the ${f.restraint} restraint group`);
    }
  }

  // Materials shared with an ancestor and every specific sibling don't discriminate ("Of tropical wood" under "…of wood").
  const mats = ignore ? [...f.materials].filter((m) => !ignore.has(`mat:${m}`)) : [...f.materials];
  if (mats.length > 0) {
    const lineMats = new Set(p.materials);
    if (p.composition || p.garments.size) lineMats.add('textile');
    const hit = mats.filter((m) => lineMats.has(m));
    if (hit.length) {
      e.score += 2 + hit.length;
      e.explicit = true;
      e.reasons.push(`material ${hit.join('/')}`);
    } else if (lineMats.size > 0) {
      reject('material', `line material is ${[...lineMats].join('/')}`);
    } else {
      e.score += UNKNOWN;
      e.assumed = true;
    }
  }

  if (f.value) {
    if (p.unitPrice === undefined) {
      reject('value', 'unit value unknown');
    } else {
      const u = p.unitPrice;
      const ok =
        (f.value.op === 'under' && u < f.value.usd) ||
        (f.value.op === 'notover' && u <= f.value.usd) ||
        (f.value.op === 'over' && u > f.value.usd) ||
        (f.value.op === 'notunder' && u >= f.value.usd);
      if (ok) {
        e.score += 2;
        e.explicit = true;
        e.reasons.push(`unit value ${u} ${f.value.op} ${f.value.usd}`);
      } else reject('value', `unit value ${u} fails "${f.value.op} ${f.value.usd}"`);
    }
  }

  if (f.handleMaterials.size > 0) {
    const hit = [...f.handleMaterials].filter((m) => p.handleMaterials.has(m));
    if (hit.length) {
      e.score += 1;
      e.explicit = true;
      e.reasons.push(`handle ${hit.join('/')}`);
    } else if (p.handleMaterials.size > 0) {
      reject('material', `line handle is ${[...p.handleMaterials].join('/')}`);
    } else {
      e.score += UNKNOWN;
      e.assumed = true;
    }
  }

  // Free-text overlap, minus words that don't discriminate between siblings. A row lists
  // alternatives; one alternative must be fully present in the line ("Dining tables" needs
  // both words, so a side table does not qualify).
  const items = f.items.map((it) => (ignore ? it.filter((t) => !ignore.has(t)) : it)).filter((it) => it.length > 0);
  if (items.length > 0) {
    const full = items.filter((it) => it.every((t) => p.tokens.has(t)));
    const anyHit = items.some((it) => it.some((t) => p.tokens.has(t)));
    if (full.length > 0) {
      const best = full.reduce((a, b) => (b.length > a.length ? b : a));
      e.score += 1 + 0.5 * (best.length - 1);
      e.textMatched = true;
      e.reasons.push(`text match: ${best.join(' ')}`);
    } else if (anyHit) {
      // Only part of a phrase matches ("Dining tables" for a side table): weaker than the residual "Other".
      e.score += f.startsOther ? -0.1 : -0.5;
    } else {
      // Nothing in a specific row's wording is supported: prefer the residual "Other".
      const unmatched = new Set(items.flat()).size;
      e.score += -Math.min(1, 0.25 * unmatched) - (f.startsOther || f.isHeading ? 0 : 1);
    }
  }
  return e;
}
