/** Valuation rules: line arithmetic, totals, non-dutiable / unitemized charges, NCV values, assists. */
import { describe, expect, it } from 'vitest';
import { assistRule } from '../../../src/reconcile/rules/assist';
import { chargesNotItemizedRule } from '../../../src/reconcile/rules/chargesNotItemized';
import { lineAmountRule } from '../../../src/reconcile/rules/lineAmount';
import { ncvValueRule } from '../../../src/reconcile/rules/ncvValue';
import { nonDutiableChargesRule } from '../../../src/reconcile/rules/nonDutiableCharges';
import { totalsRule } from '../../../src/reconcile/rules/totals';
import { BASE_LINES, baseDocs, ids, invLine, invoice, packingList, runRule } from '../helpers';

const withLines = (mut: (lines: typeof BASE_LINES) => void, over = {}) => {
  const lines = structuredClone(BASE_LINES);
  mut(lines);
  return invoice({ lines, ...over });
};

describe('LINE_AMOUNT_MISMATCH', () => {
  it('passes when qty × price = amount', () => {
    expect(runRule(lineAmountRule, baseDocs()).issues).toEqual([]);
  });

  it('corrects to the computed amount when the printed total corroborates it', () => {
    const { issues, ctx } = runRule(lineAmountRule, [withLines((l) => (l[0].amount = 4050))]);
    expect(ids(issues)).toEqual(['LINE_AMOUNT_MISMATCH:inv0-line1']);
    expect(issues[0]).toMatchObject({ severity: 'warning', lineId: 'inv0-line1', decision: { key: 'amount:inv0-line1', chosen: 'computed' } });
    expect(issues[0].detail).toMatch(/digits look transposed/);
    const line = ctx.shipment.invoices[0].lines[0];
    expect(line.amount).toMatchObject({ value: 4500, status: 'corrected' });
    expect(line.printedAmount).toBe(4050);
  });

  it('keeps the printed amount when the totals reconcile with it', () => {
    const { issues, ctx } = runRule(lineAmountRule, [withLines((l) => (l[0].amount = 4050), { totals: [{ label: 'TOTAL FOB (USD)', amount: 8050 }] })]);
    expect(issues[0].decision?.chosen).toBe('printed');
    expect(issues[0].detail).toMatch(/printed amount is kept/);
    expect(ctx.shipment.invoices[0].lines[0].amount).toMatchObject({ value: 4050, status: 'extracted' });
    expect(ctx.shipment.invoices[0].lines[0].printedAmount).toBeUndefined();
  });

  it('without totals, keeps the higher value (conservative)', () => {
    const low = runRule(lineAmountRule, [withLines((l) => (l[0].amount = 4050), { totals: [] })]);
    expect(low.issues[0].decision?.chosen).toBe('computed');
    expect(low.issues[0].detail).toMatch(/No printed total decides/);
    const high = runRule(lineAmountRule, [withLines((l) => (l[0].amount = 4600), { totals: [] })]);
    expect(high.issues[0].decision?.chosen).toBe('printed');
    expect(high.ctx.shipment.invoices[0].lines[0].amount.value).toBe(4600);
  });

  it('decides several wrong lines jointly against the totals', () => {
    const { issues } = runRule(lineAmountRule, [withLines((l) => { l[0].amount = 4050; l[1].amount = 400; })]);
    expect(issues.map((i) => i.decision?.chosen)).toEqual(['computed', 'computed']);
  });

  it('tolerates unit prices rounded to the cent', () => {
    const lines = [invLine({ lineNo: 1, styleNo: 'R-1', description: 'WIDGET', quantity: 1000, unitPrice: 0.33, amount: 333.33 })];
    expect(runRule(lineAmountRule, [invoice({ lines, totals: [] })]).issues).toEqual([]);
  });
});

describe('TOTALS_MISMATCH', () => {
  it('passes for page sub-totals, goods + charges − discount, and ignores quantity totals', () => {
    const inv = invoice({
      incoterm: { code: 'CFR', place: 'LOS ANGELES' },
      charges: [{ type: 'freight', amount: 300, description: 'Ocean freight' }, { type: 'discount', amount: 50, description: 'Less discount' }],
      totals: [
        { label: 'SUB-TOTAL C/F', amount: 4500 },
        { label: 'TOTAL QUANTITY', amount: 1500 },
        { label: 'TOTAL CFR LOS ANGELES', amount: 8750 },
      ],
    });
    expect(runRule(totalsRule, [inv, packingList()]).issues).toEqual([]);
  });

  it('fires when a printed total cannot be reproduced', () => {
    const { issues } = runRule(totalsRule, [invoice({ totals: [{ label: 'TOTAL FOB (USD)', amount: 9000 }] })]);
    expect(ids(issues)).toEqual(['TOTALS_MISMATCH']);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].detail).toMatch(/9,000\.00.*8,500\.00/);
  });

  it('stays silent when line values could not be read (MISSING_FIELD covers it)', () => {
    const inv = withLines((l) => { delete l[1].amount; delete l[1].unitPrice; }, { totals: [{ label: 'TOTAL', amount: 8500 }] });
    expect(runRule(totalsRule, [inv]).issues).toEqual([]);
  });

  it('fires when packing-list lines do not add up to the grand total', () => {
    const pl = packingList();
    if (pl.data.kind === 'packing_list') pl.data.totals.cartons = 61;
    const { issues } = runRule(totalsRule, [invoice(), pl]);
    expect(ids(issues)).toEqual(['TOTALS_MISMATCH:pl:t-pl']);
    expect(issues[0].detail).toMatch(/cartons: lines add up to 60 but the grand total reads 61/);
  });
});

describe('NON_DUTIABLE_CHARGES', () => {
  const cif = (totals: { label: string; amount: number }[]) =>
    invoice({
      incoterm: { code: 'CIF', place: 'LOS ANGELES' },
      charges: [{ type: 'freight', amount: 600, description: 'Ocean freight' }, { type: 'insurance', amount: 40, description: 'Insurance' }],
      totals,
    });

  it('passes (no issue) for FOB without charges', () => {
    const { issues, ctx } = runRule(nonDutiableChargesRule, baseDocs());
    expect(issues).toEqual([]);
    expect(ctx.shipment.invoices[0].linesAreFob).toBe(true);
  });

  it('fires as info when FOB + charges = CIF total (lines are FOB)', () => {
    const { issues, ctx } = runRule(nonDutiableChargesRule, [cif([{ label: 'TOTAL FOB', amount: 8500 }, { label: 'TOTAL CIF LOS ANGELES', amount: 9140 }])]);
    expect(issues[0]).toMatchObject({ id: 'NON_DUTIABLE_CHARGES', severity: 'info' });
    expect(issues[0].detail).toMatch(/640\.00/);
    expect(ctx.shipment.invoices[0].linesAreFob).toBe(true);
  });

  it('fires as info with lines not FOB when the line amounts already equal the CIF total', () => {
    const { issues, ctx } = runRule(nonDutiableChargesRule, [cif([{ label: 'TOTAL CIF LOS ANGELES', amount: 8500 }])]);
    expect(issues[0].severity).toBe('info');
    expect(ctx.shipment.invoices[0].linesAreFob).toBe(false);
  });

  it('warns when no total proves the price basis', () => {
    const { issues, ctx } = runRule(nonDutiableChargesRule, [cif([])]);
    expect(issues[0].severity).toBe('warning');
    expect(ctx.shipment.invoices[0].linesAreFob).toBe(false);
  });

  it('warns about itemized dutiable charges (packing, commission)', () => {
    const { issues } = runRule(nonDutiableChargesRule, [invoice({ charges: [{ type: 'packing', amount: 120, description: 'Export packing' }] })]);
    expect(issues[0]).toMatchObject({ severity: 'warning', title: 'Itemized dutiable charges' });
    expect(issues[0].detail).toMatch(/1401a\(b\)\(1\)/);
  });
});

describe('CHARGES_NOT_ITEMIZED', () => {
  it('passes for FOB and for CIF with freight and insurance itemized', () => {
    expect(runRule(chargesNotItemizedRule, baseDocs()).issues).toEqual([]);
    const cif = invoice({ incoterm: { code: 'CIF' }, charges: [{ type: 'freight', amount: 600, description: 'F' }, { type: 'insurance', amount: 40, description: 'I' }] });
    expect(runRule(chargesNotItemizedRule, [cif]).issues).toEqual([]);
  });

  it('blocks a CIF invoice with no charges', () => {
    const { issues } = runRule(chargesNotItemizedRule, [invoice({ incoterm: { code: 'CIF', place: 'NEW YORK' } })]);
    expect(issues[0]).toMatchObject({ id: 'CHARGES_NOT_ITEMIZED', severity: 'blocker' });
  });

  it('warns when only part of the costs is itemized', () => {
    const { issues } = runRule(chargesNotItemizedRule, [invoice({ incoterm: { code: 'CIP' }, charges: [{ type: 'freight', amount: 600, description: 'Air freight' }] })]);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].title).toMatch(/insurance not itemized/);
  });

  it('treats C&F as CFR', () => {
    expect(runRule(chargesNotItemizedRule, [invoice({ incoterm: { code: 'C&F' } })]).issues[0]?.severity).toBe('blocker');
  });
});

describe('NCV_VALUE', () => {
  const sample = (over: Partial<Parameters<typeof invLine>[0]> = {}) =>
    invLine({ lineNo: 3, styleNo: 'SK-100S', description: "MEN'S POLO - SAMPLES", details: ['FREE OF CHARGE, NO COMMERCIAL VALUE'], quantity: 10, unit: 'PCS', noCommercialValue: true, garmentType: 'polo', ...over });

  it('passes when there is no NCV line', () => {
    expect(runRule(ncvValueRule, baseDocs()).issues).toEqual([]);
  });

  it('warns about a nominal stated value', () => {
    const { issues } = runRule(ncvValueRule, [withLines((l) => l.push(sample({ unitPrice: 0.5, amount: 5, customsValue: 5 })))]);
    expect(issues[0]).toMatchObject({ id: 'NCV_VALUE:inv0-line3', severity: 'warning' });
    expect(issues[0].detail).toMatch(/same garment type \(polo\)/);
  });

  it('blocks an NCV line with no value at all', () => {
    const { issues } = runRule(ncvValueRule, [withLines((l) => l.push(sample()))]);
    expect(issues[0].severity).toBe('blocker');
  });

  it('only informs when the stated value is realistic', () => {
    const { issues } = runRule(ncvValueRule, [withLines((l) => l.push(sample({ customsValue: 45, amount: 45, unitPrice: 4.5 })))]);
    expect(issues[0].severity).toBe('info');
  });

  it('detects FOC lines from their text when the parser did not flag them', () => {
    const { issues, ctx } = runRule(ncvValueRule, [withLines((l) => l.push(sample({ noCommercialValue: undefined, details: ['F.O.C. samples'], unitPrice: 0.1, amount: 1 })))]);
    expect(ctx.shipment.invoices[0].lines[2].noCommercialValue).toBe(true);
    expect(ctx.shipment.invoices[0].lines[2].customsValue).toBe(1);
    expect(issues[0].severity).toBe('warning');
  });
});

describe('ASSIST', () => {
  it('passes when there are no assists or buyer-material hints', () => {
    expect(runRule(assistRule, baseDocs()).issues).toEqual([]);
  });

  it('adds an assist to the referenced style', () => {
    const inv = invoice({ assists: [{ description: 'Buyer-supplied yarn', value: 1200, currency: 'USD', styleRefs: ['SK 200'] }] });
    const { issues, ctx } = runRule(assistRule, [inv]);
    expect(ids(issues)).toEqual(['ASSIST:inv0-line2']);
    expect(issues[0].detail).toMatch(/4,000\.00 \+ USD 1,200\.00 = USD 5,200\.00/);
    expect(ctx.shipment.invoices[0].lines[1].assists.map((a) => a.value)).toEqual([1200]);
    expect(ctx.shipment.invoices[0].lines[0].assists).toEqual([]);
  });

  it('apportions one assist over several styles by quantity', () => {
    const inv = invoice({ assists: [{ description: 'Buyer-supplied labels', value: 1500, styleRefs: ['SK-100', 'SK-200'] }] });
    const { issues, ctx } = runRule(assistRule, [inv]);
    expect(ctx.shipment.invoices[0].lines.map((l) => l.assists[0]?.value)).toEqual([1000, 500]);
    expect(issues[0].detail).toMatch(/in proportion to quantity/);
  });

  it('targets the CMT-priced line when the assist names no style', () => {
    const inv = withLines((l) => l[1].details.push('CMT price only'), { assists: [{ description: 'Fabric supplied by buyer', value: 900, styleRefs: [] }] });
    const { ctx } = runRule(assistRule, [inv]);
    expect(ctx.shipment.invoices[0].lines.map((l) => l.assists.length)).toEqual([0, 1]);
  });

  it('flags buyer-material hints without a stated value', () => {
    const pl = packingList();
    if (pl.data.kind === 'packing_list') pl.data.lines[0].details.push('BUYER FABRIC');
    const { issues } = runRule(assistRule, [invoice(), pl]);
    expect(issues[0]).toMatchObject({ id: 'ASSIST:inv0-line1', severity: 'warning' });
    expect(issues[0].title).toMatch(/possible assist/);
  });
});
