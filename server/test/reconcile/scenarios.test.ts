/**
 * Synthetic end-to-end scenarios built in code (different layouts, terms and parties from the sample).
 */
import type { Issue } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { reconcile } from '../../src/reconcile';
import { addr, airWaybill, arrivalNotice, baseDocs, billOfLading, invoice, invLine, packingList } from './helpers';

const ADVISORY = new Set(['UFLPA', 'ISF', 'TELEX_RELEASE', 'COLLECT_CHARGES']);
const sev = (issues: Issue[], s: Issue['severity']) => issues.filter((i) => i.severity === s);

describe('(a) clean, consistent FOB shipment', () => {
  const { shipment, issues } = reconcile(baseDocs());

  it('has no blockers and only advisory warnings', () => {
    expect(sev(issues, 'blocker')).toEqual([]);
    expect(sev(issues, 'warning').filter((i) => !ADVISORY.has(i.code))).toEqual([]);
  });

  it('raises the cotton advisory and the expected info items only', () => {
    expect(issues.find((i) => i.code === 'UFLPA')?.detail).toMatch(/Line 1 \(SK-100\)/);
    expect(issues.find((i) => i.code === 'UFLPA')?.detail).not.toMatch(/SK-200/);
    const infoCodes = sev(issues, 'info').map((i) => i.id).sort();
    expect(infoCodes).toEqual(['COLLECT_CHARGES', 'ISF', 'MISSING_FIELD:manufacturer-assumed', 'RELATED_PARTY_ASSUMED']);
  });

  it('merges a consistent shipment', () => {
    const inv = shipment.invoices[0];
    expect(inv.linesAreFob).toBe(true);
    expect(inv.lines.map((l) => [l.id, l.amount.value, l.amount.status, l.countryOfOrigin.value])).toEqual([
      ['inv0-line1', 4500, 'extracted', 'IN'],
      ['inv0-line2', 4000, 'extracted', 'IN'],
    ]);
    expect(inv.lines.every((l) => l.packedQuantity === undefined && l.altComposition === undefined)).toBe(true);
    expect(inv.lines.map((l) => l.netWeightKg?.value)).toEqual([220, 175]);
    expect(shipment.bills).toEqual([{ master: { scac: 'SEAU', number: '260300123' } }]);
    expect(shipment.containers[0]).toMatchObject({ number: 'CSQU3054383', checkDigitValid: true });
    expect(shipment.transport).toMatchObject({ mode: 'ocean', containerized: true, carrierScac: 'SEAU', destinationState: 'CA', arrivalDateEstimated: false });
    expect(shipment.transport.arrivalDate).toMatchObject({ value: '2026-04-09', status: 'extracted' });
    expect(shipment.transport.exportDate?.value).toBe('2026-03-08');
    expect(shipment.importer?.value.name).toBe('HARBOR LANE APPAREL LLC');
    expect(shipment.ultimateConsignee?.value.name).toBe('HARBOR LANE APPAREL LLC');
    expect(shipment.countryOfExport).toBe('IN');
    expect(shipment.manufacturers.map((m) => m.name)).toEqual(['SUNRISE KNITWEAR PVT. LTD.']);
  });

  it('without the arrival notice, warns that arrival is an ETA', () => {
    const r = reconcile(baseDocs().filter((d) => d.docType !== 'arrival_notice'));
    expect(r.issues.find((i) => i.id === 'ARRIVAL_ESTIMATED')?.severity).toBe('warning');
    expect(r.shipment.transport.arrivalDate?.value).toBe('2026-04-10');
  });
});

describe('(b) DDP invoice without itemized charges', () => {
  const docs = [
    invoice({
      incoterm: { code: 'DDP', place: 'LOS ANGELES' },
      totals: [{ label: 'TOTAL DDP LOS ANGELES (USD)', amount: 8500 }],
      countryOfOrigin: 'CN',
      seller: addr('NINGBO BRIGHT HOMEWARES CO., LTD.', 'CN', { city: 'Ningbo' }),
    }),
  ];
  const { shipment, issues } = reconcile(docs);

  it('raises CHARGES_NOT_ITEMIZED as a blocker and keeps lines non-FOB', () => {
    const i = issues.find((x) => x.id === 'CHARGES_NOT_ITEMIZED');
    expect(i?.severity).toBe('blocker');
    expect(i?.detail).toMatch(/DDP/);
    expect(i?.detail).toMatch(/US duties/);
    expect(shipment.invoices[0].linesAreFob).toBe(false);
    expect(issues.find((x) => x.code === 'NON_DUTIABLE_CHARGES')).toBeUndefined();
  });

  it('reports the missing transport document and packing list', () => {
    expect(issues.find((x) => x.id === 'MISSING_DOCUMENT:transport_document')?.severity).toBe('warning');
    expect(issues.find((x) => x.id === 'MISSING_DOCUMENT:packing_list')?.severity).toBe('info');
    expect(shipment.transport.mode).toBe('unknown');
  });

  it('a DDP invoice that itemizes duty and freight is fine', () => {
    const r = reconcile([
      invoice({
        incoterm: { code: 'DDP', place: 'LOS ANGELES' },
        charges: [
          { type: 'freight', amount: 900, description: 'Freight to Los Angeles' },
          { type: 'duty', amount: 1400, description: 'US import duty' },
          { type: 'inland_freight_us', amount: 250, description: 'Delivery to door' },
        ],
        totals: [{ label: 'TOTAL DDP LOS ANGELES (USD)', amount: 11050 }],
      }),
    ]);
    expect(r.issues.find((x) => x.code === 'CHARGES_NOT_ITEMIZED')).toBeUndefined();
    expect(r.issues.find((x) => x.id === 'NON_DUTIABLE_CHARGES')?.detail).toMatch(/2,550\.00/);
    expect(r.shipment.invoices[0].linesAreFob).toBe(true);
  });
});

describe('(c) US seller with a month-first date', () => {
  const usSeller = addr('PACIFIC RIM TRADING INC.', 'US', { city: 'Seattle', stateProvince: 'WA', postalCode: '98104' });
  const mexicanFactory = addr('TEXTILES DEL NORTE SA DE CV', 'MX', { city: 'Monterrey' });

  it('resolves 03/04/2026 to March 4 by chronology and sets the invoice date', () => {
    const docs = [
      invoice({ seller: usSeller, invoiceDateRaw: '03/04/2026', invoiceDate: '2026-04-03', invoiceDateAmbiguous: true, invoiceDateAlternatives: ['2026-03-04'], countryOfOrigin: 'MX', etd: undefined, eta: undefined }),
      billOfLading({ shipper: mexicanFactory, onBoardDate: '2026-03-10', countryOfOrigin: 'MX', portOfLoading: 'MANZANILLO, MX' }),
    ];
    const { shipment, issues } = reconcile(docs);
    const i = issues.find((x) => x.id === 'DATE_AMBIGUOUS');
    expect(i?.severity).toBe('info');
    expect(i?.detail).toMatch(/Chronology/);
    expect(shipment.invoices[0].invoiceDate).toMatchObject({ value: '2026-03-04', status: 'derived' });
    expect(shipment.countryOfExport).toBe('MX');
  });

  it('falls back to the US month-first convention when the other dates do not decide', () => {
    const docs = [invoice({ seller: usSeller, invoiceDateRaw: '03/04/2026', invoiceDate: '2026-04-03', invoiceDateAmbiguous: true, etd: undefined, eta: undefined })];
    const { shipment, issues } = reconcile(docs);
    expect(issues.find((x) => x.id === 'DATE_AMBIGUOUS')?.detail).toMatch(/month-first/);
    expect(shipment.invoices[0].invoiceDate?.value).toBe('2026-03-04');
  });

  it('a non-US seller with the same digits reads day-first', () => {
    const docs = [invoice({ invoiceDateRaw: '03/04/2026', invoiceDate: '2026-04-03', invoiceDateAmbiguous: true, etd: undefined, eta: undefined })];
    expect(reconcile(docs).shipment.invoices[0].invoiceDate?.value).toBe('2026-04-03');
  });
});

describe('(d) air shipment on an air waybill', () => {
  const docs = [
    invoice({
      invoiceNumber: 'KW-2026-118',
      seller: addr('KUECHENWERK GMBH', 'DE', { city: 'Solingen' }),
      buyer: addr('CHEF SUPPLY CO', 'US', { city: 'Chicago', stateProvince: 'IL', postalCode: '60607' }),
      currency: 'EUR',
      incoterm: { code: 'FCA', place: 'FRANKFURT AIRPORT' },
      countryOfOrigin: 'DE',
      lines: [
        invLine({ lineNo: 1, styleNo: 'KW-8801', description: "CHEF'S KNIFE 20CM", hsCode: '8211.92', quantity: 240, unit: 'PCS', unitPrice: 18.5, amount: 4440 }),
        invLine({ lineNo: 2, styleNo: 'KW-8802', description: 'PARING KNIFE 9CM', hsCode: '8211.92', quantity: 480, unit: 'PCS', unitPrice: 6.25, amount: 3000 }),
      ],
      totals: [{ label: 'TOTAL FCA (EUR)', amount: 7440 }],
      totalPackages: { count: 12, unit: 'PCS' },
      etd: undefined,
      eta: '2026-05-03',
    }),
    airWaybill(),
  ];
  const { shipment, issues } = reconcile(docs);

  it('is an air shipment without containers', () => {
    expect(shipment.transport.mode).toBe('air');
    expect(shipment.transport.containerized).toBe(false);
    expect(shipment.containers).toEqual([]);
    expect(shipment.transport.flight).toBe('EK 9912');
    expect(shipment.transport.carrierScac).toBe('EK');
    expect(shipment.transport.exportDate).toMatchObject({ value: '2026-05-02', status: 'extracted' });
    expect(shipment.transport.destinationState).toBe('IL');
    expect(shipment.packages?.value).toEqual({ count: 12, unit: 'PCS' });
    expect(shipment.grossWeightKg?.value).toBe(180);
    expect(shipment.countryOfExport).toBe('DE');
    expect(shipment.invoices[0].currency).toBe('EUR');
    expect(shipment.invoices[0].linesAreFob).toBe(true);
  });

  it('reports house + master air waybills and no ocean-only advisories', () => {
    expect(shipment.bills).toEqual([{ house: { number: 'FRA7781234' }, master: { scac: 'EK', number: '17612345675' } }]);
    expect(issues.find((i) => i.id === 'HOUSE_MASTER_BILL')?.title).toMatch(/air waybill/);
    for (const code of ['ISF', 'TELEX_RELEASE', 'CONTAINER_NUMBER_INVALID', 'CONTAINER_NUMBER_CORRECTED', 'UFLPA', 'PACKAGE_COUNT_MISMATCH']) {
      expect(issues.find((i) => i.code === code), code).toBeUndefined();
    }
    expect(issues.find((i) => i.id === 'MISSING_DOCUMENT:packing_list')?.severity).toBe('info');
    expect(sev(issues, 'blocker')).toEqual([]);
  });

  it('accepts an arrival notice for an air shipment as the actual arrival', () => {
    const r = reconcile([...docs, arrivalNotice('ARRIVAL NOTICE\nATA: 05/03/2026')]);
    expect(r.shipment.transport.arrivalDateEstimated).toBe(false);
    expect(r.shipment.transport.arrivalDate?.value).toBe('2026-05-03');
  });
});

describe('country of export when the port of lading names no country', () => {
  const sellerDe = addr('KUECHENWERK GMBH', 'DE', { city: 'Solingen' });
  const awbFrom = (airportOfDeparture: string, shipperCountry?: string) =>
    airWaybill({ airportOfDeparture, shipper: shipperCountry ? addr('KUECHENWERK GMBH', shipperCountry) : { name: 'KUECHENWERK GMBH', lines: [], raw: 'KUECHENWERK GMBH' } });
  const inv = (over: Parameters<typeof invoice>[0] = {}) => invoice({ seller: sellerDe, countryOfOrigin: 'DE', portOfLoading: undefined, currency: 'EUR', ...over });

  it('an IATA airport code resolves through the reference lookups ("FRANKFURT/MAIN (FRA)" → DE)', () => {
    const r = reconcile([inv({ seller: addr('KUECHENWERK GMBH', 'AT'), countryOfOrigin: 'AT' }), awbFrom('FRANKFURT/MAIN (FRA)')]);
    expect(r.shipment.countryOfExport).toBe('DE');
  });

  it('then the shipper on the transport document, then the invoice seller', () => {
    expect(reconcile([inv(), awbFrom('UNKNOWN FIELD', 'CH')]).shipment.countryOfExport).toBe('CH');
    expect(reconcile([inv({ seller: addr('KUECHENWERK GMBH', 'AT') }), awbFrom('UNKNOWN FIELD')]).shipment.countryOfExport).toBe('AT');
  });

  it('finally the invoice header country of origin', () => {
    const r = reconcile([inv({ seller: { name: 'KUECHENWERK GMBH', lines: [], raw: 'KUECHENWERK GMBH' }, countryOfOrigin: 'IT' }), awbFrom('UNKNOWN FIELD')]);
    expect(r.shipment.countryOfExport).toBe('IT');
  });
});

describe('robustness', () => {
  it('handles no documents and an unrecognized document', () => {
    const r = reconcile([]);
    expect(r.issues.find((i) => i.id === 'MISSING_DOCUMENT:commercial_invoice')?.severity).toBe('blocker');
    expect(r.shipment.invoices).toEqual([]);
  });

  it('does not throw on sparse parser output', () => {
    const sparse = invoice({ invoiceNumber: '', lines: [invLine({ lineNo: 1, description: 'GOODS' })], seller: undefined, buyer: undefined, incoterm: undefined, currency: undefined, totals: [], countryOfOrigin: undefined });
    const r = reconcile([sparse, packingList({ lines: [] }), billOfLading({ containers: [], packages: undefined, blNumber: '' })]);
    const codes = r.issues.map((i) => i.id);
    expect(codes).toEqual(expect.arrayContaining(['MISSING_FIELD:quantity', 'MISSING_FIELD:value', 'MISSING_FIELD:invoiceNumber', 'MISSING_FIELD:incoterm', 'MISSING_FIELD:currency']));
  });

  it('keeps multi-invoice line ids distinct and keys invoice-level issues per invoice', () => {
    const a = invoice({ invoiceNumber: 'A-1', incoterm: { code: 'CIF' }, totals: [] });
    const b = invoice({ invoiceNumber: 'B-2', incoterm: { code: 'CIF' }, totals: [] }, { docId: 't-ci-2' });
    const r = reconcile([a, b]);
    expect(r.shipment.invoices.map((i) => i.lines[0].id)).toEqual(['inv0-line1', 'inv1-line1']);
    expect(r.issues.filter((i) => i.code === 'CHARGES_NOT_ITEMIZED').map((i) => i.id)).toEqual(['CHARGES_NOT_ITEMIZED:inv0', 'CHARGES_NOT_ITEMIZED:inv1']);
  });
});
