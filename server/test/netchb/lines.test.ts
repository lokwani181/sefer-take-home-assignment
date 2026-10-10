import { describe, expect, it } from 'vitest';
import type { AssembleOutput, BrokerInputs, LineClassification, Shipment } from '@app/shared';
import { assembleEntry, buildEntryXml, validateEntryXml } from '../../src/netchb';
import { modeOfTransport } from '../../src/netchb/assemble';
import { headerDescription } from '../../src/netchb/description';
import { reportingQuantities } from '../../src/netchb/quantities';
import { entityName } from '../../src/netchb/parties';
import {
  sampleAltClassifications,
  sampleClassifications,
  sampleIssues,
  sampleShipment,
  stubLookups,
} from './fixtures/sample';

function assemble(
  mutate: (s: Shipment) => void = () => {},
  opts: {
    brokerInputs?: BrokerInputs;
    classifications?: (c: Record<string, LineClassification>) => void;
    lookups?: Parameters<typeof stubLookups>[0];
    overrideClassifications?: Record<string, LineClassification>;
  } = {},
): AssembleOutput {
  const shipment = sampleShipment();
  mutate(shipment);
  const classifications = sampleClassifications();
  opts.classifications?.(classifications);
  return assembleEntry({
    shipment,
    classifications,
    altClassifications: sampleAltClassifications(),
    overrideClassifications: opts.overrideClassifications,
    brokerInputs: opts.brokerInputs ?? {},
    issues: sampleIssues(),
    lookups: stubLookups(opts.lookups),
  });
}

const item = (out: AssembleOutput, id: string) => out.entryModel.invoices.flatMap((i) => i.lineItems).find((l) => l.lineId === id)!;
const issue = (out: AssembleOutput, id: string) => out.issues.find((i) => i.id === id);

describe('reporting quantities', () => {
  it('DOZ = pieces / 12 (2 decimals), KG = net weight', () => {
    expect(reportingQuantities(['DOZ', 'KG'], { quantity: 1000, unit: 'PCS', netWeightKg: 123.456 }).quantities).toEqual([
      { uom: 'DOZ', quantity: 83.33 },
      { uom: 'KG', quantity: 123.46 },
    ]);
  });

  it('NO / PCS = pieces; dozens and pairs convert', () => {
    expect(reportingQuantities(['NO'], { quantity: 5, unit: 'DOZ' }).quantities).toEqual([{ uom: 'NO', quantity: 60 }]);
    expect(reportingQuantities(['PCS'], { quantity: 7, unit: 'pieces' }).quantities).toEqual([{ uom: 'PCS', quantity: 7 }]);
    expect(reportingQuantities(['DPR'], { quantity: 120, unit: 'PAIRS' }).quantities).toEqual([{ uom: 'DPR', quantity: 10 }]);
    expect(reportingQuantities(['PRS'], { quantity: 120, unit: 'PRS' }).quantities).toEqual([{ uom: 'PRS', quantity: 120 }]);
  });

  it('KG falls back to gross × 0.9 and says so', () => {
    const r = reportingQuantities(['KG'], { quantity: 10, unit: 'PCS', grossWeightKg: 100, grossWeightProrated: true });
    expect(r.quantities).toEqual([{ uom: 'KG', quantity: 90 }]);
    expect(r.weightAssumption).toMatch(/prorated gross weight 100 kg × 0.9 = 90 kg/);
  });

  it('X means no quantity; unknown conversions are reported missing', () => {
    expect(reportingQuantities(['X'], { quantity: 3, unit: 'PCS' })).toEqual({ quantities: [], missing: [], weightAssumption: undefined });
    expect(reportingQuantities(['M2'], { quantity: 3, unit: 'PCS' }).missing).toEqual(['M2']);
    expect(reportingQuantities(['M2'], { quantity: 3, unit: 'm2' }).quantities).toEqual([{ uom: 'M2', quantity: 3 }]);
    expect(reportingQuantities(['KG'], { quantity: 3, unit: 'PCS' }).missing).toEqual(['KG']);
  });
});

describe('line weights', () => {
  it('prorates header gross weight by value when the packing list has no line weights', () => {
    const out = assemble((s) => {
      for (const l of s.invoices[0].lines) {
        delete l.grossWeightKg;
        delete l.netWeightKg;
      }
    });
    const weights = out.entryModel.invoices[0].lineItems.map((l) => l.grossWeight!);
    expect(weights.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1928);
    expect(weights.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1932);
    // 6840 / 27439 × 1930 ≈ 481
    expect(weights[0]).toBe(481);
    const w = issue(out, 'WEIGHT_PRORATED:inv0-line1')!;
    expect(w.severity).toBe('info');
    expect(w.detail).toMatch(/× 0.9/);
    // KG reporting quantity = prorated gross × 0.9
    expect(item(out, 'inv0-line1').tariffs[0].quantity2).toBeCloseTo((1930 * 6840) / 27439 * 0.9, 1);
  });

  it('net weight missing but line gross known: KG = gross × 0.9 with an info issue', () => {
    const out = assemble((s) => delete s.invoices[0].lines[0].netWeightKg);
    expect(item(out, 'inv0-line1').tariffs[0].quantity2).toBe(432);
    expect(issue(out, 'WEIGHT_PRORATED:inv0-line1')?.title).toMatch(/net weight estimated/);
  });
});

describe('classification issues', () => {
  it('low confidence → HTS_LOW_CONFIDENCE warning with an hts decision (classification + alternatives)', () => {
    const out = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line2'] = { ...c['inv0-line2'], confidence: 'low' };
      },
    });
    const i = issue(out, 'HTS_LOW_CONFIDENCE:inv0-line2')!;
    expect(i.severity).toBe('warning');
    expect(i.decision?.key).toBe('hts:inv0-line2');
    expect(i.decision?.chosen).toBe('6110202079');
    expect(i.decision?.options.map((o) => o.value)).toEqual(['6110202079', '6110303059']);
    const confirmed = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line2'] = { ...c['inv0-line2'], confidence: 'low' };
      },
      brokerInputs: { decisions: { 'hts:inv0-line2': '6110202079' } },
    });
    expect(issue(confirmed, 'HTS_LOW_CONFIDENCE:inv0-line2')?.severity).toBe('info');
    const switched = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line2'] = { ...c['inv0-line2'], confidence: 'low' };
      },
      brokerInputs: { decisions: { 'hts:inv0-line2': '6110303059' } },
    });
    const sw = issue(switched, 'HTS_LOW_CONFIDENCE:inv0-line2')!;
    expect(sw.severity).toBe('info');
    expect(sw.decision?.chosen).toBe('6110303059');
    expect(sw.detail).toMatch(/broker set 6110.30.30.59/);
    expect(issue(switched, 'HTS_RESOLVED:inv0-line2')?.decision).toBeUndefined();
    expect(item(switched, 'inv0-line2').tariffs[0].tariffNo).toBe('6110303059');
  });

  it('basis "search" → HTS_NOT_DECLARED blocker with the decision', () => {
    const out = assemble(
      (s) => delete s.invoices[0].lines[2].hsCodeDeclared,
      {
        classifications: (c) => {
          c['inv0-line3'] = { ...c['inv0-line3'], basis: 'search', confidence: 'low' };
        },
      },
    );
    const i = issue(out, 'HTS_NOT_DECLARED:inv0-line3')!;
    expect(i.severity).toBe('blocker');
    expect(i.decision?.key).toBe('hts:inv0-line3');
    expect(issue(out, 'HTS_LOW_CONFIDENCE:inv0-line3')).toBeUndefined();
    expect(issue(out, 'HTS_RESOLVED:inv0-line3')!.title).toMatch(/No HS declared ->/);
  });

  it('knit attributes with a Chapter 62 code → CHAPTER_MISMATCH', () => {
    const out = assemble((s) => (s.invoices[0].lines[2].attributes.construction = 'knit'));
    expect(issue(out, 'CHAPTER_MISMATCH:inv0-line3')?.severity).toBe('warning');
    expect(issue(out, 'CHAPTER_MISMATCH:inv0-line1')).toBeUndefined();
  });

  it('missing classification → blocker, declared digits as placeholder tariff', () => {
    const out = assemble(undefined, { classifications: (c) => delete c['inv0-line4'] });
    expect(issue(out, 'HTS_LOW_CONFIDENCE:inv0-line4')?.severity).toBe('blocker');
    expect(item(out, 'inv0-line4').tariffs[0].tariffNo).toBe('620640');
  });

  it('classifier heading flags (CHAPTER_MISMATCH / GENDER_CONFLICT) → one CHAPTER_MISMATCH warning per line', () => {
    const out = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line3'] = {
          ...c['inv0-line3'],
          confidence: 'low',
          flags: [
            { code: 'GENDER_CONFLICT', message: "Declared heading 6203 does not cover the line gender (women's)." },
            { code: 'CHAPTER_MISMATCH', message: 'Declared chapter 62 is knit.' },
          ],
        };
      },
    });
    const i = issue(out, 'CHAPTER_MISMATCH:inv0-line3')!;
    expect(i.severity).toBe('warning');
    expect(i.detail).toMatch(/does not cover the line gender/);
    expect(i.detail).toMatch(/Declared chapter 62 is knit/);
    expect(out.issues.filter((x) => x.code === 'CHAPTER_MISMATCH')).toHaveLength(1);
    // A broker override replaces the classifier's result, so its flags no longer raise the issue.
    const overridden = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line3'] = { ...c['inv0-line3'], confidence: 'low', flags: [{ code: 'GENDER_CONFLICT', message: 'x' }] };
      },
      brokerInputs: { decisions: { 'hts:inv0-line3': '6204624021' } },
    });
    expect(issue(overridden, 'CHAPTER_MISMATCH:inv0-line3')).toBeUndefined();
  });

  it('HTS data unavailable / no candidate → the low-confidence issue is a blocker', () => {
    const out = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line4'] = { ...c['inv0-line4'], confidence: 'low', flags: [{ code: 'HTS_DATA_UNAVAILABLE', message: 'Heading 6206 not available.' }] };
      },
    });
    expect(issue(out, 'HTS_LOW_CONFIDENCE:inv0-line4')?.severity).toBe('blocker');
    const answered = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line4'] = { ...c['inv0-line4'], confidence: 'low', flags: [{ code: 'HTS_DATA_UNAVAILABLE', message: 'x' }] };
      },
      brokerInputs: { decisions: { 'hts:inv0-line4': '6206403035' } },
    });
    expect(issue(answered, 'HTS_LOW_CONFIDENCE:inv0-line4')?.severity).toBe('info');
  });

  it('a pre-resolved override classification supplies the rate, units and category of the chosen code', () => {
    const base = sampleClassifications()['inv0-line2'];
    const resolved: LineClassification = {
      ...base,
      htsNumber: '6110303059',
      htsFormatted: '6110.30.30.59',
      description: 'Sweaters › Of man-made fibers › Other › Women\'s or girls\' (639)',
      generalRate: '32%',
      adValoremPct: 32,
      units: ['DOZ', 'KG'],
      textileCategory: '639',
      confidence: 'medium',
      basis: 'user',
    };
    const out = assemble(undefined, {
      brokerInputs: { decisions: { 'hts:inv0-line2': '6110.30.30.59' } },
      overrideClassifications: { 'inv0-line2': resolved },
    });
    const li = item(out, 'inv0-line2');
    expect(li.tariffs[0].tariffNo).toBe('6110303059');
    expect(li.categoryNo).toBe('639');
    expect(out.estimates.lines.find((l) => l.lineId === 'inv0-line2')?.ratePct).toBe(32);
    expect(issue(out, 'HTS_RESOLVED:inv0-line2')?.title).toMatch(/Broker override/);
    // A resolved classification for another number is ignored (the override decides).
    const mismatched = assemble(undefined, {
      brokerInputs: { decisions: { 'hts:inv0-line2': '6110202079' } },
      overrideClassifications: { 'inv0-line2': resolved },
    });
    expect(item(mismatched, 'inv0-line2').tariffs[0].tariffNo).toBe('6110202079');
  });

  it('an HTS unit that cannot be derived upgrades HTS_RESOLVED to a warning', () => {
    const out = assemble(undefined, {
      classifications: (c) => {
        c['inv0-line1'] = { ...c['inv0-line1'], units: ['M2'] };
      },
    });
    expect(issue(out, 'HTS_RESOLVED:inv0-line1')?.severity).toBe('warning');
    expect(item(out, 'inv0-line1').tariffs[0].quantity1).toBeUndefined();
  });
});

describe('header derivations', () => {
  it.each([
    ['ocean', true, '11'],
    ['ocean', false, '10'],
    ['air', false, '40'],
    ['air', true, '41'],
    ['truck', false, '30'],
    ['truck', true, '31'],
    ['rail', false, '20'],
    ['rail', true, '21'],
    ['unknown', false, undefined],
  ] as const)('mode %s containerized=%s → %s', (mode, containerized, code) => {
    expect(modeOfTransport({ mode, containerized, arrivalDateEstimated: false })).toBe(code);
  });

  it('unknown port → PORT_UNKNOWN blocker, XML fails XSD until a port is entered', async () => {
    const out = assemble((s) => (s.transport.portOfUnlading = 'NOWHERE, ZZ'));
    expect(issue(out, 'PORT_UNKNOWN')?.severity).toBe('blocker');
    expect((await validateEntryXml(buildEntryXml(out.entryModel))).valid).toBe(false);
    const fixed = assemble((s) => (s.transport.portOfUnlading = 'NOWHERE, ZZ'), { brokerInputs: { entryPort: '3001' } });
    expect(issue(fixed, 'PORT_UNKNOWN')).toBeUndefined();
    expect(fixed.entryModel.header.unladingPort).toBe('3001');
    expect((await validateEntryXml(buildEntryXml(fixed.entryModel))).valid).toBe(true);
  });

  it('lading port from the lookup when Schedule K resolves it', () => {
    const out = assemble(undefined, { lookups: { foreignPortCode: () => ({ code: '55224', name: 'Ho Chi Minh City' }) } });
    expect(item(out, 'inv0-line1').ladingPort).toBe('55224');
    expect(issue(out, 'LADING_PORT_UNKNOWN')).toBeUndefined();
  });

  it('air: no lading port (Schedule K is vessel-only; CBP 7501 Block 19 is blank for non-vessel modes)', async () => {
    // even if a sea port shares the airport city's name, nothing is emitted for air
    const out = assemble(
      (s) => {
        s.transport = { ...s.transport, mode: 'air', containerized: false, portOfLading: 'HONG KONG (HKG)', flight: 'CX 880', voyage: undefined, vessel: undefined };
        s.containers = [];
      },
      { lookups: { foreignPortCode: () => ({ code: '58201', name: 'Hong Kong' }) } },
    );
    expect(item(out, 'inv0-line1').ladingPort).toBeUndefined();
    const lp = issue(out, 'LADING_PORT_UNKNOWN')!;
    expect(lp.severity).toBe('info');
    expect(lp.detail).toMatch(/Form 7501/);
    expect(lp.detail).toMatch(/vessel/);
    expect(lp.action).toMatch(/air/i);
    expect(await validateEntryXml(buildEntryXml(out.entryModel))).toEqual({ valid: true, errors: [] });
  });

  it('ocean port not in Schedule K: warning that points to the country "all other ports" code', () => {
    const out = assemble((s) => (s.transport.portOfLading = 'SOMEWHERE UPRIVER'));
    const lp = issue(out, 'LADING_PORT_UNKNOWN')!;
    expect(lp.severity).toBe('warning');
    expect(lp.action).toMatch(/all other ports/i);
  });

  it('a voyage number longer than the XSD allows is omitted with FIELD_OMITTED (not XSD_INVALID)', async () => {
    const out = assemble((s) => (s.transport.voyage = 'V2026-118W'));
    expect(out.entryModel.header.voyageNo).toBeUndefined();
    expect(issue(out, 'FIELD_OMITTED:header.voyageNo')).toMatchObject({ code: 'FIELD_OMITTED', severity: 'info' });
    expect(out.issues.filter((i) => i.code === 'XSD_INVALID')).toEqual([]);
    expect((await validateEntryXml(buildEntryXml(out.entryModel))).valid).toBe(true);
  });

  it('carrier code is the master-bill SCAC for ocean, not the NVOCC', () => {
    const out = assemble((s) => (s.transport.carrierScac = 'BMLV'));
    expect(out.entryModel.header.carrierCode).toBe('OPLU');
  });

  it('air: carrier from transport, flight number without airline prefix as voyage, no HMF', async () => {
    const out = assemble((s) => {
      s.transport = { ...s.transport, mode: 'air', containerized: false, voyage: undefined, vessel: undefined, flight: 'LH 8402', carrierScac: 'LH' };
      s.bills = [{ master: { number: '020-12345675' } }];
      s.containers = [];
    });
    const h = out.entryModel.header;
    expect(h.modeTransportation).toBe('40');
    expect(h.carrierCode).toBe('LH');
    expect(h.voyageNo).toBe('8402');
    expect(out.entryModel.manifest.billsOfLading[0].masterBill).toBe('02012345675');
    expect(out.estimates.hmf).toBe(0);
    expect(issue(out, 'BILL_NO_NORMALIZED:master:02012345675')?.severity).toBe('info');
    expect(await validateEntryXml(buildEntryXml(out.entryModel))).toEqual({ valid: true, errors: [] });
  });

  it('bill numbers printed with the SCAC prefix are split', () => {
    const out = assemble((s) => (s.bills = [{ master: { scac: 'OPLU', number: 'OPLUSGN260917735' }, house: { scac: 'BMLV', number: 'BMLVHCM26090418' } }]));
    expect(out.entryModel.manifest.billsOfLading[0]).toMatchObject({ masterBill: 'SGN260917735', houseBill: 'HCM26090418' });
    expect(issue(out, 'BILL_NO_NORMALIZED:house:HCM26090418')).toBeDefined();
  });

  it('header description: chapter label, else the first line description', () => {
    expect(headerDescription(['6109100012', '6203424511'], [])).toBe('WEARING APPAREL');
    expect(headerDescription(['8215200000', '8211910000'], [])).toBe('TOOLS AND CUTLERY');
    expect(headerDescription(['6109100012', '6403990000'], [])).toBe('WEARING APPAREL, FOOTWEAR');
    expect(headerDescription(['2106909998'], ['Protein bar, chocolate'])).toBe('PROTEIN BAR, CHOCOLATE');
  });

  it('entity names: legal suffixes are abbreviated before truncating to 35', () => {
    expect(entityName('SAIGON PHOENIX GARMENT JOINT STOCK COMPANY')).toBe('SAIGON PHOENIX GARMENT JSC');
    expect(entityName('SHORT NAME LIMITED')).toBe('SHORT NAME LIMITED');
  });

  it('cargo-release parties: seller without an address falls back to selling-party-mid', async () => {
    const out = assemble((s) => {
      s.seller = { name: 'ACME TRADING', lines: [], raw: 'ACME TRADING' };
      s.invoices[0].seller = s.seller;
    }, { lookups: { buildMid: () => ({ mid: 'HKACMTRA1HON', needsVerification: false, notes: [] }) } });
    const se = out.entryModel.cargoReleaseParties.find((p) => p.entityCode === 'SE')!;
    expect(se.sellingPartyMid).toBe('HKACMTRA1HON');
    expect(se.address).toBeUndefined();
    const xml = buildEntryXml(out.entryModel);
    expect(xml).toContain('<selling-party-mid>HKACMTRA1HON</selling-party-mid>');
    expect(await validateEntryXml(xml)).toEqual({ valid: true, errors: [] });
  });

  it('manufacturer without a usable MID → MID_VERIFY', () => {
    const out = assemble((s) => {
      s.manufacturers = [];
      delete s.invoices[0].lines[4].manufacturer;
    });
    expect(issue(out, 'MID_VERIFY:none')?.detail).toMatch(/inv0-line1/);
    expect(item(out, 'inv0-line1').manufacturerId).toBeUndefined();
  });

  it('unknown package count → blocker with placeholder quantity 0', () => {
    const out = assemble((s) => {
      delete s.packages;
      for (const l of s.invoices[0].lines) delete l.cartons;
    });
    expect(out.entryModel.manifest.billsOfLading[0].quantity).toBe(0);
    expect(issue(out, 'MANIFEST_QUANTITY_UNKNOWN')?.severity).toBe('blocker');
  });
});
