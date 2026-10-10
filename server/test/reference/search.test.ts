import { beforeAll, describe, expect, it } from 'vitest';
import { classifyLine } from '../../src/reference/index.js';
import { searchQueries, unitFit } from '../../src/reference/hts/search.js';
import { buildProfile } from '../../src/reference/hts/features.js';
import { makeLine, useOfflineHts } from './helpers.js';

describe('non-apparel classification (synthetic-shipment headings, offline)', () => {
  beforeAll(useOfflineHts);

  it('declared 8211.92 chef knife with plastic handle → kitchen and butcher knives', async () => {
    const c = await classifyLine(makeLine('CHEF KNIFE 8 INCH', '8211.92', {}, ['Stainless steel blade, POM plastic handle']));
    expect(c.htsNumber).toBe('8211922000');
    expect(c.generalRate).toBe('0.8¢ each + 4.6%');
    expect(c.adValoremPct).toBe(4.6);
    expect(c.units).toEqual(['NO']);
    expect(c.rationale).toMatch(/specific duty of 0\.8¢ each/);
  });

  it('declared 8211.91 table knives: the unit-value condition is evaluated', async () => {
    const cheap = await classifyLine(makeLine('Table knives with stainless steel handles', '8211.91', {}, [], { unitPrice: 0.2 }));
    const dear = await classifyLine(makeLine('Table knives with stainless steel handles', '8211.91', {}, [], { unitPrice: 1.5 }));
    expect(cheap.htsNumber).toBe('8211913000');
    expect(dear.htsNumber).toBe('8211914000');
  });

  it('declared 9403.60 acacia dining table → dining tables, not "Of teak"', async () => {
    const c = await classifyLine(makeLine('Solid acacia wood dining table', '9403.60'));
    expect(c.htsNumber).toBe('9403608040');
    expect(c.generalRate).toBe('Free');
    expect(c.adValoremPct).toBe(0);
  });

  it('declared 4202.92 polyester backpack → backpacks (670)', async () => {
    const c = await classifyLine(makeLine('Polyester laptop backpack', '4202.92', {}, ['100% polyester outer']));
    expect(c.htsNumber).toBe('4202923120');
    expect(c.textileCategory).toBe('670');
    expect(c.units).toEqual(['NO', 'KG']);
  });

  it('declared 6302.60 cotton terry bath towel → towels, other (363)', async () => {
    const c = await classifyLine(makeLine('Cotton bath towel, terry', '6302.60', {}, ['100% cotton']));
    expect(c.htsNumber).toBe('6302600020');
    expect(c.textileCategory).toBe('363');
  });

  it('declared 7323.93 / 3924.10 resolve within the declared subheading', async () => {
    const steel = await classifyLine(makeLine('STAINLESS STEEL MIXING BOWL SET', '7323.93'));
    expect(steel.htsNumber.startsWith('73239300')).toBe(true);
    expect(steel.alternatives.map((a) => a.htsNumber).concat(steel.htsNumber)).toContain('7323930060');
    const plastic = await classifyLine(makeLine('Plastic salad bowls', '3924.10', {}, ['Melamine']));
    expect(plastic.htsNumber.startsWith('392410')).toBe(true);
  });

  const searchCases: [desc: string, query: string, expected: string][] = [
    ['Kitchen knives, stainless steel blade, wood handle', 'kitchen knives', '8211929030'],
    ['Wooden furniture - solid acacia dining table', 'wooden furniture', '9403608040'],
    ['Backpacks, 600D polyester', 'backpacks', '4202923120'],
    ['Cotton towels, terry, 100% cotton', 'cotton towels', '6302600020'],
  ];
  for (const [desc, query, expected] of searchCases) {
    it(`no declared code: "${desc}" → search "${query}" → ${expected}`, async () => {
      const line = makeLine(desc);
      expect(searchQueries(line, buildProfile(line))[0]).toBe(query);
      const c = await classifyLine(line);
      expect(c.basis).toBe('search');
      expect(c.confidence).toBe('low');
      expect(c.htsNumber).toBe(expected);
      expect(c.rationale).toContain(`"${query}"`);
    });
  }

  it('no declared code: stainless steel kitchenware → heading 7323 kitchen ware among the top candidates', async () => {
    const line = makeLine('Stainless steel kitchenware - mixing bowls');
    expect(searchQueries(line, buildProfile(line))[0]).toBe('stainless steel kitchenware');
    const c = await classifyLine(line);
    expect(c.basis).toBe('search');
    expect([c.htsNumber, ...c.alternatives.map((a) => a.htsNumber)]).toContain('7323930060');
  });

  it('piece-invoiced lines prefer countable tariff units over fabric/yarn units', () => {
    expect(unitFit('PCS', ['NO', 'KG'])).toBeGreaterThan(0);
    expect(unitFit('PCS', ['M2', 'KG'])).toBeLessThan(-3);
    expect(unitFit('KGS', ['KG'])).toBe(0);
    expect(unitFit(undefined, ['NO'])).toBe(0);
  });
});
