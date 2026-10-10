/**
 * The synthetic shipments (samples/synthetic, built by T7) through the classifier, with lines shaped
 * the way the parser emits them. Proves nothing is tuned to the five sample lines.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LineAttributes } from '@app/shared';
import { classifyLine } from '../../src/reference/index.js';
import { makeLine, useOfflineHts } from './helpers.js';

type Case = [label: string, description: string, details: string[], hs: string | undefined, attrs: LineAttributes, unit: string, expected: string, basis: 'declared' | 'search'];

const cases: Case[] = [
  // S1 — German kitchen tools, air, 8-digit HTS printed
  ['S1 L1', 'Steakmesser 12 cm, Wellenschliff, Edelstahlgriff', ['Steak knife, 12 cm serrated fixed blade, one-piece stainless steel handle', 'Klinge / blade X50CrMoV15 · dishwasher safe'], '8211.91.40', {}, 'PCS', '8211914000', 'declared'],
  ['S1 L2', 'Steakmesser 11 cm, Kunststoffgriff (POM), genietet', ['Steak knife, 11 cm fixed blade, black POM plastic handle, riveted'], '8211.91.50', {}, 'PCS', '8211915030', 'declared'],
  ['S1 L3', 'Rührschüssel-Set 3-tlg., Edelstahl 18/10', ['Mixing bowl set of 3 (1.5 / 3.0 / 5.0 L), stainless steel 18/10, nesting'], '7323.93.00', {}, 'SETS', '7323930060', 'declared'],
  ['S1 L4', 'Küchensieb 24 cm, Edelstahl, mit zwei Griffen', ['Colander 24 cm, perforated stainless steel, two handles, footed base'], '7323.93.00', {}, 'PCS', '7323930060', 'declared'],
  // S2 — Chinese furniture and bags, scanned combined invoice/packing list
  ['S2 L1', 'SOLID ACACIA WOOD SIDE TABLE', ['50 x 50 x 55 cm, natural oil finish', 'Knock-down, 2 pcs per carton'], '9403.60.80', {}, 'PCS', '9403608093', 'declared'],
  ['S2 L2', 'PINE WOOD 4-TIER BOOKSHELF', ['80 x 30 x 150 cm, white-wash finish', 'Flat-packed with hardware kit'], '9403.60.80', {}, 'PCS', '9403608093', 'declared'],
  ['S2 L3', 'LAPTOP BACKPACK 15.6 INCH', ['Outer: 600D polyester, PU coated', 'Padded laptop sleeve, USB port'], '4202.92.31', {}, 'PCS', '4202923120', 'declared'],
  ['S2 L4', 'KIDS BACKPACK, PRINTED', ['Outer: 420D nylon', '2 zip pockets, padded straps'], '4202.92.31', {}, 'PCS', '4202923120', 'declared'],
  // S3 — Indian/Sri Lankan apparel, no HS codes at all
  ['S3 L1', "MEN'S CREW NECK T-SHIRT", ['100% cotton single jersey knit, 180 GSM,', 'short sleeve', 'asstd colours, sizes S-XXL'], undefined, {}, 'PCS', '6109100012', 'search'],
  ['S3 L2', "MEN'S V-NECK T-SHIRT", ['100% cotton jersey knit, 160 GSM'], undefined, {}, 'PCS', '6109100012', 'search'],
  ['S3 L3', "WOMEN'S STRAIGHT LEG TROUSERS", ['100% cotton twill, woven, 240 GSM', 'MADE IN SRI LANKA - Lanka Weave Garments'], undefined, {}, 'PCS', '6204628018', 'search'],
];

describe('synthetic shipments (offline)', () => {
  beforeAll(useOfflineHts);
  for (const [label, description, details, hs, attrs, unit, expected, basis] of cases) {
    it(`${label}: ${description} → ${expected}`, async () => {
      const c = await classifyLine(makeLine(description, hs, attrs, details, { unit }));
      expect(c.htsNumber).toBe(expected);
      expect(c.basis).toBe(basis);
      if (basis === 'search') expect(c.confidence).toBe('low');
      if (hs) expect(c.htsNumber.startsWith(hs.replace(/\D/g, ''))).toBe(true);
      expect(c.units.length).toBeGreaterThan(0);
    });
  }

  it('the same lines with parser attributes give the same S3 results', async () => {
    const c = await classifyLine(
      makeLine("WOMEN'S STRAIGHT LEG TROUSERS", undefined, { gender: 'women', garmentType: 'trousers', construction: 'woven', composition: [{ fiber: 'cotton', pct: 100 }] }),
    );
    expect(c.htsNumber).toBe('6204628018');
  });
});
