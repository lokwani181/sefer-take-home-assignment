/** Cross-document discrepancy rules: quantity, composition, packages, gross weight, containers. */
import { describe, expect, it } from 'vitest';
import { compositionRule } from '../../../src/reconcile/rules/composition';
import { containerRule } from '../../../src/reconcile/rules/container';
import { grossWeightRule } from '../../../src/reconcile/rules/grossWeight';
import { packageCountRule } from '../../../src/reconcile/rules/packageCount';
import { quantityRule } from '../../../src/reconcile/rules/quantity';
import type { ExtractedDocument, PackingListData } from '@app/shared';
import { BASE_LINES, baseDocs, billOfLading, ids, invoice, packingList, plLine, runRule } from '../helpers';

const plWith = (mut: (d: PackingListData) => void): ExtractedDocument => {
  const pl = packingList();
  if (pl.data.kind === 'packing_list') mut(pl.data);
  return pl;
};

describe('QTY_MISMATCH', () => {
  it('passes when every style is packed in the invoiced quantity', () => {
    expect(runRule(quantityRule, baseDocs()).issues).toEqual([]);
  });

  it('blocks a short-packed style and offers the packed quantity', () => {
    const pl = plWith((d) => {
      d.lines[0].pcsPerCarton = 24;
      d.lines[0].totalPcs = 960;
    });
    const { issues, ctx } = runRule(quantityRule, [invoice(), pl]);
    expect(ids(issues)).toEqual(['QTY_MISMATCH:inv0-line1']);
    expect(issues[0]).toMatchObject({ severity: 'blocker', decision: { key: 'quantity:inv0-line1', chosen: 'invoice' } });
    expect(issues[0].decision?.options.map((o) => o.value)).toEqual(['invoice', 'packed']);
    expect(issues[0].detail).toMatch(/40 ctns × 24 pcs\/ctn = 960/);
    expect(issues[0].detail).toMatch(/4,320\.00/);
    expect(ctx.shipment.invoices[0].lines[0].packedQuantity).toBe(960);
  });

  it('mentions when the grand totals agree by coincidence', () => {
    const pl = plWith((d) => {
      d.lines[0].totalPcs = 980;
      d.lines[1].totalPcs = 520;
    });
    const { issues } = runRule(quantityRule, [invoice(), pl]);
    expect(issues).toHaveLength(2);
    expect(issues[0].detail).toMatch(/coincidentally agree \(1,500/);
  });

  it('compares dozens with pieces', () => {
    const lines = structuredClone(BASE_LINES);
    lines[0].unit = 'DOZ';
    lines[0].quantity = 83.33;
    lines[0].unitPrice = 54;
    lines[0].amount = 4499.82;
    expect(runRule(quantityRule, [invoice({ lines }), packingList()]).issues).toEqual([]);
    lines[0].quantity = 80;
    lines[0].amount = 4320;
    const { issues, ctx } = runRule(quantityRule, [invoice({ lines }), packingList()]);
    expect(issues[0].title).toMatch(/invoiced 80 vs packed 83\.33 DOZ/);
    expect(ctx.shipment.invoices[0].lines[0].packedQuantity).toBe(83.33);
  });

  it('flags packed styles missing from the invoice and invoice styles missing from the packing list', () => {
    const pl = plWith((d) => {
      d.lines[1] = plLine({ styleNo: 'ZZ-999', description: 'BABY ROMPER', totalPcs: 500, cartons: 20 });
    });
    const { issues } = runRule(quantityRule, [invoice(), pl]);
    expect(ids(issues).sort()).toEqual(['QTY_MISMATCH:inv0-line2', 'QTY_MISMATCH:pl:t-pl:line2']);
    expect(issues.every((i) => i.severity === 'warning' && !i.decision)).toBe(true);
  });
});

describe('QTY_MISMATCH robustness', () => {
  it('ignores packing-list rows without a style or piece count (marks, remarks)', () => {
    const pl = plWith((d) => d.lines.push(plLine({ description: "SHIPPER'S LOAD, STOW AND COUNT" }), plLine({ description: '60 CARTONS', cartons: 60 })));
    expect(runRule(quantityRule, [invoice(), pl]).issues).toEqual([]);
  });

  it('does not list every invoice line when the packing list matches none of them', () => {
    const pl = plWith((d) => (d.lines = [plLine({ styleNo: 'QQ-1', description: 'DESK LAMP', totalPcs: 10 })]));
    expect(ids(runRule(quantityRule, [invoice(), pl]).issues)).toEqual(['QTY_MISMATCH:pl:t-pl:line1']);
  });
});

describe('COMPOSITION_CONFLICT', () => {
  it('passes for the same composition written differently (or within 10 points)', () => {
    expect(runRule(compositionRule, baseDocs()).issues).toEqual([]);
    const pl = plWith((d) => (d.lines[1].composition = [{ fiber: 'POLY', pct: 75 }, { fiber: 'rayon', pct: 25 }]));
    expect(runRule(compositionRule, [invoice(), pl]).issues).toEqual([]);
  });

  it('blocks when the predominant fibre differs and records the alternative', () => {
    const pl = plWith((d) => {
      d.lines[1].composition = [{ fiber: 'viscose', pct: 55 }, { fiber: 'polyester', pct: 45 }];
      d.lines[1].compositionRaw = '55/45 VISCOSE/POLY';
    });
    const { issues, ctx } = runRule(compositionRule, [invoice(), pl]);
    expect(ids(issues)).toEqual(['COMPOSITION_CONFLICT:inv0-line2']);
    expect(issues[0]).toMatchObject({ severity: 'blocker', decision: { key: 'composition:inv0-line2', chosen: 'invoice' } });
    expect(issues[0].decision?.options.map((o) => o.value)).toEqual(['invoice', 'other_doc']);
    expect(issues[0].detail).toMatch(/predominates by weight/);
    const line = ctx.shipment.invoices[0].lines[1];
    expect(line.altComposition).toEqual([{ fiber: 'viscose', pct: 55 }, { fiber: 'polyester', pct: 45 }]);
    expect(line.altCompositionSource).toMatchObject({ docId: 't-pl', field: 'lines[1].composition' });
    expect(line.attributes.composition?.[0]).toEqual({ fiber: 'polyester', pct: 80 });
  });

  it('blocks when a fibre differs by 10+ points even with the same predominant fibre', () => {
    const pl = plWith((d) => (d.lines[1].composition = [{ fiber: 'polyester', pct: 65 }, { fiber: 'viscose', pct: 35 }]));
    const { issues } = runRule(compositionRule, [invoice(), pl]);
    expect(issues[0].detail).toMatch(/differs by 15 percentage points/);
  });
});

describe('PACKAGE_COUNT_MISMATCH', () => {
  it('passes when invoice, packing list and B/L agree', () => {
    expect(runRule(packageCountRule, baseDocs()).issues).toEqual([]);
  });

  it('warns when the B/L count differs', () => {
    const { issues } = runRule(packageCountRule, [invoice(), packingList(), billOfLading({ packages: { count: 62, unit: 'CTNS' } })]);
    expect(issues[0]).toMatchObject({ id: 'PACKAGE_COUNT_MISMATCH', severity: 'warning' });
    expect(issues[0].detail).toMatch(/bill of lading: 62 CTNS/);
  });

  it('does not compare pallets with cartons', () => {
    expect(runRule(packageCountRule, [invoice(), packingList(), billOfLading({ packages: { count: 2, unit: 'PALLETS' } })]).issues).toEqual([]);
  });
});

describe('GROSS_WEIGHT_MISMATCH', () => {
  it('passes within 1%', () => {
    expect(runRule(grossWeightRule, baseDocs()).issues).toEqual([]);
    expect(runRule(grossWeightRule, [invoice(), packingList(), billOfLading({ grossWeightKg: 444 })]).issues).toEqual([]);
  });

  it('warns above 1% and defaults to the transport document', () => {
    const { issues, ctx } = runRule(grossWeightRule, [invoice(), packingList(), billOfLading({ grossWeightKg: 480 })]);
    expect(issues[0]).toMatchObject({ id: 'GROSS_WEIGHT_MISMATCH', severity: 'warning', decision: { key: 'grossWeight', chosen: 'transport_doc' } });
    expect(issues[0].decision?.options.map((o) => o.value)).toEqual(['transport_doc', 'packing_list']);
    expect(ctx.shipment.grossWeightKg?.value).toBe(480);
  });

  it('uses the sum of packing-list lines when there is no grand total', () => {
    const pl = plWith((d) => (d.totals = {}));
    const { issues } = runRule(grossWeightRule, [invoice(), pl, billOfLading({ grossWeightKg: 500 })]);
    expect(issues[0].detail).toMatch(/packing list: 440 kg/);
  });
});

describe('CONTAINER_NUMBER_CORRECTED / CONTAINER_NUMBER_INVALID', () => {
  const blWith = (container: Record<string, unknown>, extra: Partial<ExtractedDocument> = {}) =>
    billOfLading({ containers: [{ sealNumbers: ['S1'], checkDigitValid: false, number: '', ...container }] as never }, extra);

  it('passes a clean, valid number', () => {
    const { issues, ctx } = runRule(containerRule, baseDocs());
    expect(issues).toEqual([]);
    expect(ctx.shipment.containers[0].checkDigitValid).toBe(true);
  });

  it('chooses the only valid candidate over an invalid typed number', () => {
    const bl = blWith({
      number: 'CSQU3054380',
      candidates: [
        { number: 'CSQU3054380', checkDigitValid: false, source: 'strikethrough' },
        { number: 'CSQU3054383', checkDigitValid: true, source: 'handwritten' },
      ],
    });
    const { issues, ctx } = runRule(containerRule, [invoice(), bl]);
    expect(ids(issues)).toEqual(['CONTAINER_NUMBER_CORRECTED']);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].detail).toMatch(/CSQU3054380 \(strikethrough\) fails the check digit \(computed 3, printed 0\)/);
    expect(ctx.shipment.containers[0]).toMatchObject({ number: 'CSQU3054383', checkDigitValid: true });
  });

  it('repairs OCR letter/digit confusions when that yields exactly one valid number', () => {
    const { issues, ctx } = runRule(containerRule, [invoice(), blWith({ number: 'C5QU 3O54383' })]);
    expect(issues[0].id).toBe('CONTAINER_NUMBER_CORRECTED');
    expect(ctx.shipment.containers[0].number).toBe('CSQU3054383');
  });

  it('asks for verification of a valid number that was OCR-repaired', () => {
    const bl = blWith({ number: 'CSQU3054383', checkDigitValid: true }, { fieldMeta: { 'containers[0].number': { conf: 45, repaired: true, originalText: 'CSQU 305438 3' } } });
    expect(ids(runRule(containerRule, [invoice(), bl]).issues)).toEqual(['CONTAINER_NUMBER_CORRECTED']);
  });

  it('blocks when no reading passes the check digit', () => {
    const { issues, ctx } = runRule(containerRule, [invoice(), blWith({ number: 'CSQU3054381' })]);
    expect(ids(issues)).toEqual(['CONTAINER_NUMBER_INVALID']);
    expect(issues[0].severity).toBe('blocker');
    expect(ctx.shipment.containers[0]).toMatchObject({ number: 'CSQU3054381', checkDigitValid: false });
  });

  it('blocks when two different readings are both valid', () => {
    const bl = blWith({
      number: 'CSQU3054389',
      candidates: [
        { number: 'CSQU3054383', checkDigitValid: true, source: 'ocr' },
        { number: 'TGHU1234567', checkDigitValid: true, source: 'handwritten' },
      ],
    });
    const { issues } = runRule(containerRule, [invoice(), bl]);
    expect(issues[0].id).toBe('CONTAINER_NUMBER_INVALID');
    expect(issues[0].detail).toMatch(/several readings pass/);
  });
});
