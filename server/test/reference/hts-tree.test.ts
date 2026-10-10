import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyLine, configureHtsClient, getHtsSubtree, mapUnit, mapUnits, parseRate, searchHts, textileCategory, type HtsNode } from '../../src/reference/index.js';
import { buildHeadingTree, cleanHtml, clearTreeMemo, findNode, formatHts, tenDigit } from '../../src/reference/hts/tree.js';
import { headingUrl, searchSlug, searchUrl } from '../../src/reference/hts/client.js';
import { makeLine, useOfflineHts } from './helpers.js';

describe('HTS parsing helpers', () => {
  it('maps USITC units to NetCHB codes, stripping HTML', () => {
    expect(mapUnits(['doz.', 'kg'])).toEqual(['DOZ', 'KG']);
    expect(mapUnits(['No.', '<u>kg</u>'])).toEqual(['NO', 'KG']);
    expect(mapUnits(['m<sup>2</sup>', ' <u>kg</u>'])).toEqual(['M2', 'KG']);
    expect(mapUnits(['No. and kg'])).toEqual(['NO', 'KG']);
    expect(mapUnits(['doz. ,kg'.split(',')[0], 'kg'])).toEqual(['DOZ', 'KG']);
    expect(mapUnit('prs.')).toBe('PRS');
    expect(mapUnit('m')).toBe('M');
    expect(mapUnit('liters')).toBe('L');
    expect(mapUnit('pcs')).toBe('PCS');
    expect(mapUnit('&nbsp;gross')).toBe('GRS');
    expect(mapUnit('t adw')).toBe('ADW');
    expect(mapUnit('Weird unit!')).toBe('WEIRDUNIT');
  });

  it('parses the ad valorem part of general rates', () => {
    expect(parseRate('16.5%')).toEqual({ adValoremPct: 16.5 });
    expect(parseRate('Free')).toEqual({ adValoremPct: 0 });
    expect(parseRate('56.3¢/kg + 14.3%')).toEqual({ adValoremPct: 14.3, specific: '56.3¢/kg' });
    expect(parseRate('56.3c/kg + 14.3%')).toEqual({ adValoremPct: 14.3, specific: '56.3c/kg' });
    expect(parseRate('0.8¢ each + 4.6%')).toEqual({ adValoremPct: 4.6, specific: '0.8¢ each' });
    expect(parseRate('0.47¢/kg')).toEqual({ specific: '0.47¢/kg' });
    expect(parseRate('The rate applicable to each garment in the ensemble if separately entered')).toEqual({});
    expect(parseRate(undefined)).toEqual({});
  });

  it('extracts textile categories and formats numbers', () => {
    expect(textileCategory("Men's (338)")).toBe('338');
    expect(textileCategory("Women's or girls' (646)")).toBe('646');
    expect(textileCategory('Garments described in heading 6201(634)')).toBe('634');
    expect(textileCategory('Of stainless steel')).toBeUndefined();
    expect(formatHts('6110303045')).toBe('6110.30.30.45');
    expect(tenDigit('62034245')).toBe('6203424500');
    expect(cleanHtml('Containing by weight <il>25 percent</il> or more&nbsp;cotton')).toBe('Containing by weight 25 percent or more cotton');
  });

  it('builds a tree with unnumbered parents, inherited rates and units', () => {
    const rows = [
      { htsno: '9999', indent: '0', description: 'Test heading:', units: [], general: '' },
      { htsno: '9999.10', indent: '1', description: 'Of cotton:', units: [], general: '' },
      { htsno: '9999.10.10', indent: '2', description: 'Other', units: [], general: '12%' },
      { htsno: '', indent: '3', description: "Men's or boys':", units: [], general: '' },
      { htsno: '9999.10.10.10', indent: '4', description: "Men's (338)", units: ['doz.', '<u>kg</u>'], general: '' },
      { htsno: '9999.10.20.00', indent: '2', description: 'Other (339)', units: [], general: 'Free' },
      { htsno: '9999.90', indent: '1', description: 'Of other materials', units: ['No.'], general: '5%' },
      { htsno: '', indent: '2', description: 'Leaf without units', units: [], general: '' },
      { htsno: '10000', indent: '0', description: 'Next heading', units: [], general: '' },
    ];
    const root = buildHeadingTree('9999', rows)!;
    expect(root.children.map((c) => c.htsno)).toEqual(['9999.10', '9999.90']);
    const men = findNode(root, '9999101010')!.node;
    expect(men.general).toBe('12%');
    expect(men.units).toEqual(['DOZ', 'KG']);
    expect(men.path).toEqual(['Test heading:', 'Of cotton:', 'Other', "Men's or boys':", "Men's (338)"]);
    expect(findNode(root, '9999.10.20')!.node.general).toBe('Free');
    const unitless = root.children[1].children[0];
    expect(unitless.units).toEqual(['NO']);
    expect(findNode(root, '9999.10.99')!.exact).toBe(false);
  });

  it('builds the USITC URLs used for fetching and caching', () => {
    expect(headingUrl('6203')).toBe('https://hts.usitc.gov/reststop/exportList?from=6203&to=6204&format=JSON&styles=false');
    expect(searchUrl('trousers cotton')).toBe('https://hts.usitc.gov/reststop/search?keyword=trousers%20cotton');
    expect(searchSlug('T-Shirts  Cotton')).toBe('t-shirts-cotton');
  });
});

describe('getHtsSubtree / searchHts (offline)', () => {
  beforeAll(useOfflineHts);

  it('returns the full subtree including unnumbered parent rows', async () => {
    const node = (await getHtsSubtree('6203.42')) as HtsNode;
    expect(node.description).toBe('Of cotton:');
    expect(node.children.map((c) => c.description.replace(/:$/, ''))).toEqual(['Recreational performance outerwear', 'Other']);
    const all: HtsNode[] = [];
    const walk = (n: HtsNode): void => {
      all.push(n);
      n.children.forEach(walk);
    };
    walk(node);
    const leaf = all.find((n) => n.htsno === '6203.42.45.18')!;
    expect(leaf.general).toBe('16.6%');
    expect(leaf.units).toEqual(['DOZ', 'KG']);
    expect(leaf.textileCategory).toBe('347');
    expect(all.some((n) => n.htsno === '' && n.description === "Men's trousers and breeches:")).toBe(true);
  });

  it('accepts codes without dots and returns null for unknown codes', async () => {
    expect((await getHtsSubtree('611020'))?.htsno).toBe('6110.20');
    expect(await getHtsSubtree('6110.55')).toBeNull();
    expect(await getHtsSubtree('61')).toBeNull();
  });

  it('serves committed keyword searches', async () => {
    const hits = await searchHts('backpacks');
    expect(hits.find((h) => h.htsno === '4202.92.31.20')?.units).toEqual(['NO', 'KG']);
    expect((await searchHts('t-shirts cotton')).some((h) => h.htsno === '6109.10.00.12')).toBe(true);
    expect(await searchHts('something never cached')).toEqual([]);
  });
});

describe('runtime fetch + cache (stubbed network)', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'hts-rt-'));
  let calls: string[] = [];
  beforeAll(() => {
    clearTreeMemo();
    configureHtsClient({
      offline: false,
      cacheDir,
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url));
        const rows = [
          { htsno: '0101', indent: '0', description: 'Live horses, asses, mules and hinnies:', units: [], general: '' },
          { htsno: '0101.21.00', indent: '1', description: 'Purebred breeding animals', units: [], general: 'Free' },
          { htsno: '0101.21.00.10', indent: '2', description: 'Males', units: ['No.'], general: '' },
          { htsno: '0101.21.00.20', indent: '2', description: 'Females', units: ['No.'], general: '' },
          { htsno: '0102', indent: '0', description: 'Live bovine animals:', units: [], general: '' },
        ];
        return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
  });
  afterAll(() => {
    clearTreeMemo();
    useOfflineHts();
  });

  it('fetches an unknown heading once, writes it to the runtime cache and classifies from it', async () => {
    calls = [];
    const c = await classifyLine(makeLine('Breeding horse, female', '0101.21'));
    expect(calls).toEqual(['https://hts.usitc.gov/reststop/exportList?from=0101&to=0102&format=JSON&styles=false']);
    expect(existsSync(join(cacheDir, 'headings', '0101.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(cacheDir, 'headings', '0101.json'), 'utf8'))).toHaveLength(5);
    expect(c.htsNumber).toBe('0101210020');
    expect(c.units).toEqual(['NO']);
    expect(c.generalRate).toBe('Free');
    await classifyLine(makeLine('Breeding horse, male', '0101.21'));
    expect(calls).toHaveLength(1);
  });
});
