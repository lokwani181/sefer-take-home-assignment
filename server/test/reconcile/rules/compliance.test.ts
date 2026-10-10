/** Compliance / assumption rules and advisories. */
import { describe, expect, it } from 'vitest';
import { arrivalEstimatedRule } from '../../../src/reconcile/rules/arrivalEstimated';
import { collectChargesRule } from '../../../src/reconcile/rules/collectCharges';
import { dateAmbiguousRule } from '../../../src/reconcile/rules/dateAmbiguous';
import { declarationConflictRule } from '../../../src/reconcile/rules/declarationConflict';
import { houseMasterBillRule } from '../../../src/reconcile/rules/houseMasterBill';
import { isfRule } from '../../../src/reconcile/rules/isf';
import { originDiffersRule } from '../../../src/reconcile/rules/originDiffers';
import { partiesRule } from '../../../src/reconcile/rules/parties';
import { relatedPartyRule } from '../../../src/reconcile/rules/relatedParty';
import { sellerManufacturerRule } from '../../../src/reconcile/rules/sellerManufacturer';
import { telexReleaseRule } from '../../../src/reconcile/rules/telexRelease';
import { uflpaRule } from '../../../src/reconcile/rules/uflpa';
import { addr, airWaybill, arrivalNotice, BASE_LINES, baseDocs, billOfLading, BUYER, ids, invoice, packingList, runRule } from '../helpers';

const lines = (mut: (l: typeof BASE_LINES) => void) => {
  const l = structuredClone(BASE_LINES);
  mut(l);
  return l;
};
const BD_FACTORY = addr('DHAKA STITCH LTD.', 'BD', { city: 'Gazipur' });

describe('ORIGIN_DIFFERS', () => {
  it('passes when every line has the header origin', () => {
    expect(runRule(originDiffersRule, baseDocs()).issues).toEqual([]);
  });

  it('warns when a line origin differs from the header and names the missing local manufacturer', () => {
    const inv = invoice({ lines: lines((l) => { l[1].countryOfOrigin = 'BD'; l[1].details.push('Made in Bangladesh'); }) });
    const { issues } = runRule(originDiffersRule, [inv, packingList(), billOfLading()]);
    expect(ids(issues)).toEqual(['ORIGIN_DIFFERS:inv0-line2']);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].detail).toMatch(/BD \(Bangladesh\).*header states IN \(India\)/);
    expect(issues[0].detail).toMatch(/No manufacturer in Bangladesh/);
  });

  it('accepts a line manufacturer in the origin country', () => {
    const inv = invoice({ lines: lines((l) => { l[1].countryOfOrigin = 'BD'; l[1].manufacturer = BD_FACTORY; }) });
    expect(runRule(originDiffersRule, [inv]).issues[0].detail).toMatch(/producer in that country: DHAKA STITCH LTD\. \(BD\)/);
  });

  it('warns when the invoice line and packing list disagree', () => {
    const inv = invoice({ countryOfOrigin: undefined, lines: lines((l) => (l[0].countryOfOrigin = 'IN')) });
    const pl = packingList();
    if (pl.data.kind === 'packing_list') pl.data.lines[0].countryOfOrigin = 'LK';
    const { issues } = runRule(originDiffersRule, [inv, pl]);
    expect(issues[0].detail).toMatch(/invoice line states IN.*packing list states LK/);
  });
});

describe('DECLARATION_CONFLICT', () => {
  const note = 'We hereby declare that the goods are of Indian origin.';

  it('passes when the declaration matches every line', () => {
    expect(runRule(declarationConflictRule, [invoice({ notes: [note] })]).issues).toEqual([]);
  });

  it('warns when a printed declaration contradicts a line origin', () => {
    const inv = invoice({ notes: [note], lines: lines((l) => (l[1].countryOfOrigin = 'BD')) });
    const { issues } = runRule(declarationConflictRule, [inv]);
    expect(issues[0]).toMatchObject({ id: 'DECLARATION_CONFLICT', severity: 'warning' });
    expect(issues[0].detail).toMatch(/Indian origin.*line 2 \(SK-200\) is of Bangladesh origin/);
  });

  it('ignores line-specific statements and flags contradicting carton marks', () => {
    const inv = invoice({ notes: ['Style SK-200 goods are made in Bangladesh.'], lines: lines((l) => (l[1].countryOfOrigin = 'BD')) });
    expect(runRule(declarationConflictRule, [inv]).issues).toEqual([]);
    const pl = packingList({ shippingMarks: ['HARBOR LANE', 'MADE IN INDIA', 'C/NO. 1-60'] });
    const { issues } = runRule(declarationConflictRule, [inv, pl]);
    expect(issues[0].detail).toMatch(/carton marks read "MADE IN INDIA/);
    expect(issues[0].action).toMatch(/19 USC 1304/);
  });
});

describe('SELLER_NOT_MANUFACTURER / FIRST_SALE_OPPORTUNITY', () => {
  it('passes when the seller is the (stated or assumed) manufacturer', () => {
    expect(runRule(sellerManufacturerRule, baseDocs()).issues).toEqual([]);
    const inv = invoice({ manufacturer: addr('Sunrise Knitwear Private Limited', 'IN') });
    expect(runRule(sellerManufacturerRule, [inv]).issues).toEqual([]);
  });

  it('fires both info items for a trading-company seller', () => {
    const inv = invoice({ seller: addr('GLOBAL SOURCING (HK) LIMITED', 'HK'), manufacturer: addr('SUNRISE KNITWEAR PVT. LTD.', 'IN') });
    const { issues } = runRule(sellerManufacturerRule, [inv]);
    expect(ids(issues)).toEqual(['SELLER_NOT_MANUFACTURER', 'FIRST_SALE_OPPORTUNITY']);
    expect(issues.every((i) => i.severity === 'info')).toBe(true);
    expect(issues[0].detail).toMatch(/MID/);
    expect(issues[1].detail).toMatch(/Hong Kong.*first-sale/);
  });
});

describe('IMPORTER_ASSUMED / ULTIMATE_CONSIGNEE_ASSUMED', () => {
  it('passes when the buyer is also the consignee', () => {
    expect(runRule(partiesRule, baseDocs()).issues).toEqual([]);
  });

  it('uses the buyer as ultimate consignee when the ship-to is a 3PL', () => {
    const inv = invoice({ shipTo: addr('INLAND EMPIRE 3PL WAREHOUSING LLC', 'US', { city: 'Ontario', stateProvince: 'CA' }) });
    const { issues, ctx } = runRule(partiesRule, [inv]);
    expect(ids(issues)).toEqual(['ULTIMATE_CONSIGNEE_ASSUMED']);
    expect(issues[0].detail).toMatch(/logistics provider \("3PL"\)/);
    expect(ctx.shipment.ultimateConsignee?.value.name).toBe(BUYER.name);
    expect(ctx.shipment.shipTo?.name).toMatch(/3PL/);
  });

  it('recognizes a "for account of" ship-to', () => {
    const shipTo = addr('ACME RECEIVING DOCK', 'US', { raw: 'ACME RECEIVING DOCK\nFor account of: Harbor Lane Apparel LLC' });
    const { ctx, issues } = runRule(partiesRule, [invoice({ shipTo })]);
    expect(issues[0].detail).toMatch(/for account of Harbor Lane/);
    expect(ctx.shipment.ultimateConsignee?.value.name).toBe(BUYER.name);
  });

  it('uses a non-logistics ship-to as ultimate consignee', () => {
    const { ctx, issues } = runRule(partiesRule, [invoice({ shipTo: addr('BIG BOX STORES INC', 'US', { city: 'Dallas', stateProvince: 'TX' }) })]);
    expect(ctx.shipment.ultimateConsignee).toMatchObject({ value: { name: 'BIG BOX STORES INC' }, status: 'derived' });
    expect(issues[0].title).toMatch(/ship-to BIG BOX/);
  });

  it('never picks a customs broker notify party as importer', () => {
    const bl = billOfLading({ notifyParty: addr('PRAIRIE GATEWAY CUSTOMS BROKERAGE', 'US'), consignee: BUYER });
    const { ctx } = runRule(partiesRule, [invoice({ buyer: undefined }), bl]);
    expect(ctx.shipment.importer?.value.name).toBe(BUYER.name);
  });

  // negotiable "to order" bills (L/C trade): the order party (a bank) holds title as security only
  it('never uses a "TO THE ORDER OF <bank>" consignee as ship-to or ultimate consignee', () => {
    const bank = addr('TO THE ORDER OF PACIFIC MERCHANTS BANK', 'US', { city: 'Oakland', stateProvince: 'CA' });
    const { ctx, issues } = runRule(partiesRule, [invoice(), billOfLading({ consignee: bank, notifyParty: BUYER })]);
    expect(ctx.shipment.importer?.value.name).toBe(BUYER.name);
    expect(ctx.shipment.ultimateConsignee?.value.name).toBe(BUYER.name);
    expect(ctx.shipment.shipTo?.name ?? '').not.toMatch(/BANK/);
    expect(ids(issues)).toEqual(['ULTIMATE_CONSIGNEE_ASSUMED']);
    expect(issues[0].detail).toMatch(/to the order of PACIFIC MERCHANTS BANK/i);
  });

  it('falls back to the notify party as importer when no buyer is printed', () => {
    const { ctx, issues } = runRule(partiesRule, [invoice({ buyer: undefined }), billOfLading({ consignee: addr('TO ORDER', 'US') })]);
    expect(ids(issues)).toContain('IMPORTER_ASSUMED');
    expect(ctx.shipment.importer).toMatchObject({ value: { name: BUYER.name }, status: 'assumed' });
  });
});

describe('HOUSE_MASTER_BILL', () => {
  it('passes for a single master bill', () => {
    expect(runRule(houseMasterBillRule, baseDocs()).issues).toEqual([]);
  });

  it('reports a house bill under a master and splits both', () => {
    const bl = billOfLading({ blType: 'house', blNumber: 'FWDX12345678', issuerScac: 'FWDX', issuerName: 'FAST FORWARDING LTD', masterBlNumber: 'SEAU260300123', carrierScac: 'SEAU' });
    const { issues, ctx } = runRule(houseMasterBillRule, [invoice(), bl]);
    expect(issues[0]).toMatchObject({ id: 'HOUSE_MASTER_BILL', severity: 'info' });
    expect(ctx.shipment.bills).toEqual([{ house: { scac: 'FWDX', number: '12345678' }, master: { scac: 'SEAU', number: '260300123' } }]);
    expect(ctx.shipment.consolidator?.name).toBe('FAST FORWARDING LTD');
  });
});

describe('RELATED_PARTY_ASSUMED', () => {
  it('passes when a document states the relationship', () => {
    const r = runRule(relatedPartyRule, [invoice({ notes: ['Buyer and seller are not related parties.'] })]);
    expect(r.issues).toEqual([]);
    expect(r.ctx.shipment.invoices[0].relatedParty).toMatchObject({ value: false, status: 'extracted' });
    const r2 = runRule(relatedPartyRule, [invoice({ relatedParty: true })]);
    expect(r2.issues).toEqual([]);
    expect(r2.ctx.shipment.invoices[0].relatedParty.value).toBe(true);
  });

  it('assumes not related otherwise', () => {
    const { issues, ctx } = runRule(relatedPartyRule, baseDocs());
    expect(issues[0]).toMatchObject({ id: 'RELATED_PARTY_ASSUMED', severity: 'info' });
    expect(ctx.shipment.invoices[0].relatedParty).toMatchObject({ value: false, status: 'assumed' });
  });
});

describe('DATE_AMBIGUOUS', () => {
  it('passes for an unambiguous date', () => {
    expect(runRule(dateAmbiguousRule, baseDocs()).issues).toEqual([]);
  });

  it('resolves a day-first date by chronology', () => {
    const { issues, ctx } = runRule(dateAmbiguousRule, [invoice({ invoiceDateRaw: '05/03/2026', invoiceDate: '2026-05-03', invoiceDateAmbiguous: true }), packingList(), billOfLading()]);
    expect(issues[0]).toMatchObject({ id: 'DATE_AMBIGUOUS', severity: 'info' });
    expect(ctx.shipment.invoices[0].invoiceDate).toMatchObject({ value: '2026-03-05', status: 'derived' });
  });

  it('warns when nothing decides', () => {
    const inv = invoice({ invoiceDateRaw: '05/03/2026', invoiceDate: '2026-03-05', seller: undefined, etd: undefined, eta: undefined });
    const { issues, ctx } = runRule(dateAmbiguousRule, [inv]);
    expect(issues[0].severity).toBe('warning');
    expect(ctx.shipment.invoices[0].invoiceDate?.value).toBe('2026-03-05');
  });
});

describe('ARRIVAL_ESTIMATED', () => {
  it('passes with an arrival notice giving the actual date', () => {
    expect(runRule(arrivalEstimatedRule, baseDocs()).issues).toEqual([]);
  });

  it('warns when only an ETA is known', () => {
    const { issues } = runRule(arrivalEstimatedRule, [invoice(), billOfLading()]);
    expect(issues[0]).toMatchObject({ id: 'ARRIVAL_ESTIMATED', severity: 'warning' });
    expect(issues[0].detail).toMatch(/2026-04-10/);
  });

  it('treats an ETA on the arrival notice as still estimated', () => {
    const { issues, ctx } = runRule(arrivalEstimatedRule, [invoice(), arrivalNotice('ARRIVAL NOTICE\nETA: 04/12/2026')]);
    expect(ctx.shipment.transport.arrivalDate?.value).toBe('2026-04-12');
    expect(issues[0].detail).toMatch(/arrival notice/);
  });
});

describe('advisories', () => {
  it('UFLPA: silent without cotton, warns on cotton or unknown textile composition', () => {
    const noCotton = invoice({ lines: lines((l) => { l[0].composition = [{ fiber: 'polyester', pct: 100 }]; l[0].details = ['100% polyester pique']; }) });
    expect(runRule(uflpaRule, [noCotton]).issues).toEqual([]);
    const cotton = runRule(uflpaRule, baseDocs()).issues;
    expect(cotton[0]).toMatchObject({ id: 'UFLPA', severity: 'warning' });
    const unknown = invoice({ lines: lines((l) => { l[1].composition = undefined; l[0].composition = [{ fiber: 'nylon', pct: 100 }]; l[0].details = []; }) });
    expect(runRule(uflpaRule, [unknown]).issues[0].detail).toMatch(/Line 2 \(SK-200\)/);
  });

  it('ISF: ocean only, names the filer when stated', () => {
    expect(runRule(isfRule, [invoice(), airWaybill()]).issues).toEqual([]);
    expect(runRule(isfRule, baseDocs()).issues[0]).toMatchObject({ id: 'ISF', severity: 'info' });
    expect(runRule(isfRule, [invoice(), billOfLading({ isfFiledBy: 'CUSTOMS BROKER XYZ' })]).issues[0].title).toBe('ISF filed by CUSTOMS BROKER XYZ');
  });

  it('TELEX_RELEASE: silent for original bills, fires on telex release or a surrender stamp', () => {
    expect(runRule(telexReleaseRule, baseDocs()).issues).toEqual([]);
    expect(runRule(telexReleaseRule, [invoice(), billOfLading({ releaseType: 'telex' })]).issues[0]).toMatchObject({ id: 'TELEX_RELEASE', severity: 'info' });
    const stamped = billOfLading({ releaseType: 'unknown' }, { observations: [{ kind: 'stamp', text: 'SURRENDERED', page: 1 }] });
    expect(ids(runRule(telexReleaseRule, [invoice(), stamped]).issues)).toEqual(['TELEX_RELEASE']);
  });

  it('COLLECT_CHARGES: silent for prepaid, fires for collect charges', () => {
    const prepaid = billOfLading({ freightTerms: 'FREIGHT PREPAID', charges: [{ description: 'OCEAN FREIGHT', terms: 'prepaid' }] });
    expect(runRule(collectChargesRule, [invoice(), prepaid]).issues).toEqual([]);
    const { issues } = runRule(collectChargesRule, baseDocs());
    expect(issues[0]).toMatchObject({ id: 'COLLECT_CHARGES', severity: 'info' });
    expect(issues[0].detail).toMatch(/OCEAN FREIGHT/);
  });
});
