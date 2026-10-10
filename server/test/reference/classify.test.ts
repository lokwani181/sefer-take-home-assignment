import { beforeAll, describe, expect, it } from 'vitest';
import type { LineClassification } from '@app/shared';
import { classifyAsHts, classifyLine } from '../../src/reference/index.js';
import { compositionFromText, predominantFibre, buildProfile } from '../../src/reference/hts/features.js';
import { makeLine, sampleLines, useOfflineHts } from './helpers.js';

const flags = (c: LineClassification): string[] => (c.flags ?? []).map((f) => f.code);

describe('classifyLine — sample shipment (offline, committed USITC data)', () => {
  beforeAll(useOfflineHts);
  const lines = sampleLines();

  // Pinned against the live 2026 HTS tree (data fetched 2026-10-10, committed under src/reference/data/hts).
  const expected: [style: string, hts: string, formatted: string, category: string, rate: string, pct: number][] = [
    ['NB-T101', '6109100012', '6109.10.00.12', '338', '16.5%', 16.5], // men's cotton knit T-shirt: Men's or boys' › Other T-shirts › Men's
    ['NB-H205', '6110202046', '6110.20.20.46', '339', '16.5%', 16.5], // women's cotton-rich sweatshirt (hoodie): Sweatshirts › Women's
    ['NB-C330', '6203424518', '6203.42.45.18', '347', '16.6%', 16.6], // 2026 tree: Other › Other › Men's trousers and breeches › Other
    ['W-B220', '6206403035', '6206.40.30.35', '641', '26.9%', 26.9], // solid colourways → not "two or more colors in the warp" → Other › Women's › Other
    ['NB-P118S', '6106100010', '6106.10.00.10', '339', '19.7%', 19.7], // women's cotton knit polo
  ];

  for (const [style, hts, formatted, category, rate, pct] of expected) {
    it(`${style} → ${formatted}`, async () => {
      const c = await classifyLine(lines[style]);
      expect(c.htsNumber).toBe(hts);
      expect(c.htsFormatted).toBe(formatted);
      expect(c.textileCategory).toBe(category);
      expect(c.generalRate).toBe(rate);
      expect(c.adValoremPct).toBe(pct);
      expect(c.units).toEqual(['DOZ', 'KG']);
      expect(c.confidence).toBe('high');
      expect(c.basis).toBe('declared');
      expect(c.lineId).toBe(lines[style].id);
      expect(c.rationale.split('\n').length).toBeGreaterThan(2);
    });
  }

  it('gives the same leaves when the parser supplied no attributes (text only)', async () => {
    for (const [style, hts] of expected) {
      const line = { ...lines[style], attributes: {} };
      const c = await classifyLine(line);
      expect(c.htsNumber, style).toBe(hts);
    }
  });

  it('hoodie: description is the full path from heading to leaf', async () => {
    const c = await classifyLine(lines['NB-H205']);
    expect(c.description).toBe(
      'Sweaters, pullovers, sweatshirts, waistcoats (vests) and similar articles, knitted or crocheted › Of cotton › Other › Other › Sweatshirts › Women\'s (339)',
    );
  });

  it('chinos: walks the restructured 2026 tree (not the old 6203.42.40)', async () => {
    const c = await classifyLine(lines['NB-C330']);
    expect(c.description).toContain("Men's trousers and breeches › Other (347)");
    expect(c.rationale).toMatch(/Recreational performance outerwear/);
  });

  it('hoodie with the packing-list composition (polyester 65 / cotton 35) → 6110.30.30.45', async () => {
    const c = await classifyLine(lines['NB-H205'], {
      composition: [
        { fiber: 'polyester', pct: 65 },
        { fiber: 'cotton', pct: 35 },
      ],
    });
    expect(c.htsNumber).toBe('6110303045');
    expect(c.htsNumber.startsWith('611030')).toBe(true);
    expect(c.textileCategory).toBe('639');
    expect(c.generalRate).toBe('32%');
    expect(c.adValoremPct).toBe(32);
    expect(c.confidence).toBe('medium');
    expect(c.basis).toBe('declared');
    expect(flags(c)).toContain('RECLASSIFIED_FOR_COMPOSITION');
    expect(c.alternatives.map((a) => a.htsNumber)).toContain('6110202046');
  });
});

describe('classifyLine — rules', () => {
  beforeAll(useOfflineHts);

  it('declared fibre subheading contradicts the composition: stays in the declared code, offers the sibling', async () => {
    const line = makeLine("WOMEN'S PULLOVER HOODIE", '6110.20', {
      gender: 'women',
      garmentType: 'hoodie',
      construction: 'knit',
      composition: [
        { fiber: 'polyester', pct: 65 },
        { fiber: 'cotton', pct: 35 },
      ],
    });
    const c = await classifyLine(line);
    expect(c.htsNumber).toBe('6110202046');
    expect(c.confidence).toBe('medium');
    expect(flags(c)).toContain('FIBER_CONFLICT');
    expect(c.alternatives[0].htsNumber).toBe('6110303045');
    expect(c.alternatives[0].reason).toMatch(/man-made/);
  });

  it('knit line declared in Ch. 62: flags the chapter mismatch and offers the Ch. 61 counterpart', async () => {
    const line = makeLine("WOMEN'S BLOUSE", '6206.40', { gender: 'women', garmentType: 'blouse', construction: 'knit', composition: [{ fiber: 'polyester', pct: 100 }] });
    const c = await classifyLine(line);
    expect(flags(c)).toContain('CHAPTER_MISMATCH');
    expect(c.confidence).toBe('low');
    expect(c.alternatives[0].htsNumber.startsWith('6106')).toBe(true);
    expect(c.alternatives[0].htsNumber).toBe('6106202010');
  });

  it('gender not stated: Note-9 default (women\'s) with medium confidence and the men\'s leaf as an alternative', async () => {
    const line = makeLine('CREW NECK T-SHIRT', '6109.10', { garmentType: 't-shirt', construction: 'knit', composition: [{ fiber: 'cotton', pct: 100 }] });
    const c = await classifyLine(line);
    expect(c.htsNumber).toBe('6109100040');
    expect(c.confidence).toBe('medium');
    expect(c.alternatives.map((a) => a.htsNumber)).toContain('6109100012');
  });

  it('unisex garments are classified as women\'s (Ch. 61 note 9) with high confidence', async () => {
    const line = makeLine('UNISEX CREW NECK T-SHIRT', '6109.10', { gender: 'unisex', garmentType: 't-shirt', construction: 'knit', composition: [{ fiber: 'cotton', pct: 100 }] });
    const c = await classifyLine(line);
    expect(c.htsNumber).toBe('6109100040');
    expect(c.confidence).toBe('high');
    expect(c.rationale).toMatch(/unisex/i);
  });

  it('special conditions are only chosen when the text supports them (blue denim)', async () => {
    const plain = await classifyLine(makeLine("MEN'S 5-POCKET TROUSERS", '6203.42', { gender: 'men', garmentType: 'trousers', construction: 'woven', composition: [{ fiber: 'cotton', pct: 100 }] }));
    const denim = await classifyLine(makeLine("MEN'S BLUE DENIM JEANS", '6203.42', { gender: 'men', garmentType: 'trousers', construction: 'woven', composition: [{ fiber: 'cotton', pct: 100 }] }));
    expect(plain.htsNumber).toBe('6203424518');
    expect(denim.htsNumber).toBe('6203424511');
  });

  it('fibre thresholds are evaluated against the composition (≥36% flax)', async () => {
    const line = makeLine("WOMEN'S SWEATER", '6110.20', { gender: 'women', garmentType: 'sweater', construction: 'knit', composition: [{ fiber: 'cotton', pct: 55 }, { fiber: 'linen', pct: 45 }] });
    const c = await classifyLine(line);
    expect(c.htsNumber).toBe('6110201020');
    expect(c.generalRate).toBe('5%');
  });

  it('women\'s cotton trousers and men\'s polo shirts (synthetic-shipment headings)', async () => {
    const w = await classifyLine(makeLine("Women's cotton twill trousers", '6204.62', { gender: 'women', garmentType: 'trousers', construction: 'woven', composition: [{ fiber: 'cotton', pct: 100 }] }));
    expect(w.htsNumber).toBe('6204628018');
    const m = await classifyLine(makeLine("Men's knit polo shirt", '6105.10', { gender: 'men', garmentType: 'polo', construction: 'knit', composition: [{ fiber: 'cotton', pct: 100 }] }));
    expect(m.htsNumber).toBe('6105100010');
  });

  it('a declared code that no longer exists is walked from its nearest existing parent', async () => {
    const c = await classifyLine(makeLine("MEN'S TROUSERS", '6203.42.40', { gender: 'men', garmentType: 'trousers', construction: 'woven', composition: [{ fiber: 'cotton', pct: 100 }] }));
    expect(c.htsNumber).toBe('6203424518');
    expect(flags(c)).toContain('DECLARED_CODE_NOT_FOUND');
    expect(c.confidence).toBe('medium');
  });

  it('attributes missing from the parser are read from the text', async () => {
    const c = await classifyLine(makeLine("LADIES' 100% COTTON KNITTED T-SHIRT", '6109.10'));
    expect(c.htsNumber).toBe('6109100040');
    expect(c.confidence).toBe('high');
  });

  it('heading data unavailable offline: declared code passed through, low confidence, no invented suffix', async () => {
    const c = await classifyLine(makeLine('LIVE HORSES', '0101.21'));
    expect(c.htsNumber).toBe('010121');
    expect(c.confidence).toBe('low');
    expect(flags(c)).toContain('HTS_DATA_UNAVAILABLE');
  });
});

describe('classifyLine — no declared code (keyword search, low confidence)', () => {
  beforeAll(useOfflineHts);

  it('men\'s cotton chinos → search "trousers cotton" → 6203.42.45.18', async () => {
    const c = await classifyLine(makeLine("MEN'S SLIM FIT CHINO TROUSERS", undefined, { gender: 'men', garmentType: 'trousers', construction: 'woven', composition: [{ fiber: 'cotton', pct: 98 }, { fiber: 'elastane', pct: 2 }] }));
    expect(c.basis).toBe('search');
    expect(c.confidence).toBe('low');
    expect(c.htsNumber).toBe('6203424518');
    expect(c.rationale).toMatch(/trousers cotton/);
    expect(c.alternatives.length).toBeGreaterThan(0);
  });

  it('men\'s cotton T-shirt → search "t-shirts cotton" → 6109.10.00.12', async () => {
    const c = await classifyLine(makeLine("MEN'S CREW NECK T-SHIRT", undefined, { gender: 'men', garmentType: 't-shirt', construction: 'knit', composition: [{ fiber: 'cotton', pct: 100 }] }));
    expect(c.basis).toBe('search');
    expect(c.confidence).toBe('low');
    expect(c.htsNumber).toBe('6109100012');
  });

  it('nothing searchable offline → empty number, NO_CANDIDATE flag', async () => {
    const c = await classifyLine(makeLine('Widget assembly'));
    expect(c.htsNumber).toBe('');
    expect(c.confidence).toBe('low');
    expect(flags(c)).toContain('NO_CANDIDATE');
  });
});

describe('broker-selected HTS (decision hts:<lineId>)', () => {
  beforeAll(useOfflineHts);

  it('returns the chosen leaf with its units, rate and category', async () => {
    const line = sampleLines()['NB-H205'];
    const c = await classifyAsHts(line, '6110.30.30.45');
    expect(c.basis).toBe('user');
    expect(c.htsNumber).toBe('6110303045');
    expect(c.generalRate).toBe('32%');
    expect(c.units).toEqual(['DOZ', 'KG']);
    expect(c.textileCategory).toBe('639');
    expect(c.confidence).toBe('high');
  });

  it('unknown codes pass through with low confidence', async () => {
    const c = await classifyAsHts(sampleLines()['NB-H205'], '6110.99.99.99');
    expect(c.basis).toBe('user');
    expect(c.htsNumber).toBe('6110999999');
    expect(c.confidence).toBe('low');
  });
});

describe('composition rules', () => {
  it('reads compositions from text when the parser gave none', () => {
    expect(compositionFromText('60% Cotton 40% Polyester brushed fleece')).toEqual([
      { fiber: 'cotton', pct: 60 },
      { fiber: 'polyester', pct: 40 },
    ]);
    expect(compositionFromText('TC 65/35')).toEqual([
      { fiber: 'polyester', pct: 65 },
      { fiber: 'cotton', pct: 35 },
    ]);
    expect(compositionFromText('CVC 60/40')?.[0]).toEqual({ fiber: 'cotton', pct: 60 });
    expect(compositionFromText('100% organic cotton jersey')).toEqual([{ fiber: 'organic cotton', pct: 100 }]);
    expect(compositionFromText('600D polyester')).toEqual([{ fiber: 'polyester', pct: 100 }]);
    expect(compositionFromText('cotton/poly blend')).toBeUndefined();
  });

  it('synthetic + artificial count together as man-made; ties go to the later heading', () => {
    const p = buildProfile(makeLine('x', undefined, { composition: [{ fiber: 'cotton', pct: 45 }, { fiber: 'polyester', pct: 30 }, { fiber: 'viscose', pct: 25 }] }));
    expect(p.predominant).toBe('mmf');
    const tie = buildProfile(makeLine('x', undefined, { composition: [{ fiber: 'cotton', pct: 50 }, { fiber: 'polyester', pct: 50 }] }));
    expect(tie.predominant).toBe('mmf');
    expect(predominantFibre({ cotton: 50, wool: 50, silk: 0, flax: 0, veg: 0, synthetic: 0, artificial: 0, down: 0, leather: 0, other: 0 })).toBe('cotton');
  });
});
