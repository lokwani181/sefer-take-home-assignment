import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address, PackingListData } from '@app/shared';
import { buildMid, computeHmf, computeMpf, feeConfig, iso6346CheckDigit, isValidContainerNumber } from '../../src/reference/index.js';

const A = (name: string, lines: string[], city: string | undefined, country: string | undefined, extra: Partial<Address> = {}): Address => ({
  name,
  lines,
  city,
  country,
  raw: [name, ...lines, city ?? ''].join('\n'),
  ...extra,
});

describe('buildMid — examples published by CBP (ACE Entry Summary Instructions, MID rules)', () => {
  const examples: [Address, string][] = [
    [A('LA VIE DE FRANCE', ['243 Rue de la Payees'], 'Bremond', 'FR', { postalCode: '62591' }), 'FRLAVIE243BRE'],
    [A('20TH CENTURY TECHNOLOGIES', ['5 Ricardo Munoz, Suite 5880'], 'Caracas', 'VE'), 'VE20TCEN5880CAR'],
    [A('THE E.K. RODGERS COMPANIES', ['One Hawthorne Lane'], 'London', 'GB', { postalCode: 'SW1Y5HO' }), 'GBEKRODLON'],
    [A('THE GREENHOUSE', ['45 Royal Crescent'], 'Birmingham', 'US', { stateProvince: 'AL', postalCode: '35204' }), 'USGRE45BIR'],
    [A('CARDUCCIO AND JONES', ['88 Canberra Avenue'], 'Sidney', 'AU'), 'AUCARJON88SID'],
    [A('N. MINAMI & CO., LTD.', ['2-6, 8-Chome Isogami-Dori', 'Fukiai-Ku'], 'Kobe', 'JP'), 'JPMINCO26KOB'],
    [A('BOCCHACCIO S.P.A.', ['Visa Mendotti, 61'], 'Verona', 'IT', { postalCode: '8320' }), 'ITBOCSPA61VER'],
    [A('MURLA-PRAXITELES INC.', [], 'Athens', 'GR'), 'GRMURINCATH'],
    [A('SIGMA COY E.X.T.', ['1640 Delgado'], 'Smyrna', 'IT', { postalCode: '4000' }), 'ITSIGCOY1640SMY'],
    [A('COMPANHIA TEXTIL KARSTEN', ['Calle Grande, 25-27'], 'Lisbon', 'PT', { postalCode: '67890' }), 'PTKAR2527LIS'],
    [A('HURON LANDMARK', ['1840 Huron Road'], 'Windsor', 'CA', { stateProvince: 'ON', postalCode: 'N9C 2L5' }), 'XOHURLAN1840WIN'],
  ];
  for (const [addr, mid] of examples) {
    it(`${addr.name} → ${mid}`, () => {
      const r = buildMid(addr)!;
      expect(r.mid).toBe(mid);
      expect(r.needsVerification).toBe(false);
    });
  }

  // Rule-text examples (name / address / city pieces) from the same CBP section.
  const pieces: [Address, string][] = [
    [A('Amalgamated Plastics Corp.', [], 'Tokyo', 'JP'), 'JPAMAPLATOK'],
    [A('Bergstrom', [], 'Tokyo', 'JP'), 'JPBERTOK'],
    [A('A.B.C. Company', ['11455 Main Street Suite 9999'], 'Tokyo', 'JP'), 'JPABCCOM1145TOK'],
    [A('A B C Company', ['232 Main Street Suite 1234'], 'Tokyo', 'JP'), 'JPABCCOM1234TOK'],
    [A('O.A.S.I.S. Corp.', [], 'Tokyo', 'JP'), 'JPOASCORTOK'],
    [A('Dr. S.A. Smith', ['One Thousand Century Plaza Suite 345'], 'St. Michel', 'FR'), 'FRDRSA345STM'],
    [A('Shavings B L Inc.', ['Apt. 509 2727 Cleveland St.'], 'The Hague', 'NL'), 'NLSHABL2727HAG'],
    [A('The Embassy of Spain', ['One Thousand Century Plaza'], 'Madrid', 'ES'), 'ESEMBSPAMAD'],
    [A('Rawles – Aden Corp.', ['12,34,56 Alaska Road'], '18-Mile High', 'US'), 'USRAWCOR1234MIL'],
    [A('Rawles-Aden Corp.', ['12-34-56 Alaska Road'], 'Tokyo', 'JP'), 'JPRAWCOR1234TOK'],
    [A('20th Century Fox', [], 'Tokyo', 'JP'), 'JP20TCENTOK'],
    [A('Concept 2000', [], 'Macau', 'MO'), 'MOCON200MAC'],
    [A('Thomas S. Delvaux Company', [], 'Tokyo', 'JP'), 'JPTHODELTOK'],
    [A('Fabrica de Artigos de Vestuario JUMP HIGH Ltd', [], 'Macau', 'MO'), 'MOJUMHIGMAC'],
    [A('PT Morich Indo Fashion', [], 'Bandung', 'ID'), 'IDMORINDBAN'],
    [A('Some Trading Ltd', ['12 Harbour Road'], 'Wan Chai', 'HK'), 'HKSOMTRA12HON'],
    [A('Some Trading Pte', ['1 Raffles Place'], 'Singapore', 'SG'), 'SGSOMTRA1SIN'],
  ];
  for (const [addr, mid] of pieces) {
    it(`${addr.name} / ${addr.lines.join(' ') || '(no street)'} / ${addr.city} → ${mid}`, () => {
      expect(buildMid(addr)!.mid).toBe(mid);
    });
  }

  it('is at most 15 characters and uppercase', () => {
    const r = buildMid(A('Extraordinarily Longnamed Manufacturing', ['123456789 Road'], 'Constantinople', 'TR'))!;
    expect(r.mid).toBe('TREXTLON1234CON');
    expect(r.mid.length).toBeLessThanOrEqual(15);
  });
});

describe('buildMid — sample fixture manufacturers', () => {
  const pl = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'sample', 'packing-list.expected.json'), 'utf8')) as { data: PackingListData };

  it('main factory (Binh Duong, VN): built, but flagged for the "Lot C7-C8, Road No. 9" street line', () => {
    const r = buildMid(pl.data.manufacturer!)!;
    expect(r.mid).toBe('VNSAIPHO9DIA');
    expect(r.needsVerification).toBe(true);
  });

  it('sample-line factory (Gazipur, BD)', () => {
    const line = pl.data.lines.find((l) => l.manufacturer)!;
    const r = buildMid(line.manufacturer!)!;
    expect(r.mid).toBe('BDSPGAR41GAZ');
    expect(r.mid.startsWith('BD')).toBe(true);
  });
});

describe('buildMid — sample-style ambiguity handling', () => {
  it('flags alphanumeric lot numbers ("Lot C7-C8, Road No. 9") and explains the choice', () => {
    const r = buildMid(
      A('SAIGON PHOENIX GARMENT JOINT STOCK COMPANY', ['Lot C7-C8, Road No. 9, Song Than 2 Industrial Park, Di An Ward'], 'Di An City', 'VN', { stateProvince: 'Binh Duong Province' }),
    )!;
    expect(r.mid).toBe('VNSAIPHO9DIA');
    expect(r.needsVerification).toBe(true);
    expect(r.notes.join(' ')).toMatch(/C7-C8/);
  });

  // "Kab. Tangerang" is Tangerang Regency: the administrative prefix is not the city name
  it('drops administrative-division prefixes from the city piece (Kab., Kabupaten, TP., Huyen, Amphoe)', () => {
    expect(buildMid(A('PT SEPATU MAKMUR', ['Jl. Industri 5'], 'Kab. Tangerang', 'ID'))!.mid).toBe('IDSEPMAK5TAN');
    expect(buildMid(A('PT KARYA BARU', ['Jl. Raya 12'], 'Kabupaten Bekasi', 'ID'))!.mid).toBe('IDKARBAR12BEK');
    expect(buildMid(A('VIET TEX CO., LTD.', ['88 Le Loi'], 'TP. Ho Chi Minh', 'VN'))!.mid).toBe('VNVIETEX88HOC');
    expect(buildMid(A('BORNEO WOOD SDN BHD', ['Lot 7'], 'Kota Kinabalu', 'MY'))!.mid).toBe('MYBORWOO7KOT');
  });

  it('builds the MID of a line-level manufacturer (different country)', () => {
    expect(buildMid(A('SP Garments Dhaka Ltd.', ['Plot 41'], 'Gazipur', 'BD'))!.mid).toBe('BDSPGAR41GAZ');
  });

  it('Canada without a province cannot be built; unknown country neither', () => {
    const ca = buildMid(A('Maple Works', ['10 King St'], 'Toronto', 'CA'))!;
    expect(ca.mid).toBe('');
    expect(ca.needsVerification).toBe(true);
    const none = buildMid(A('Nowhere Ltd', ['1 Road'], 'Atlantis', undefined))!;
    expect(none.mid).toBe('');
    expect(none.needsVerification).toBe(true);
  });

  it('infers the country from the raw block when the parser left it empty (flagged)', () => {
    const r = buildMid({ name: 'Delta Knits Ltd', lines: ['House 5, Road 7'], city: 'Dhaka', raw: 'Delta Knits Ltd\nHouse 5, Road 7\nDhaka, Bangladesh' })!;
    expect(r.mid).toBe('BDDELKNI7DHA');
    expect(r.needsVerification).toBe(true);
  });

  it('flags generic prefixes dropped by analogy (Vietnamese "Cong Ty TNHH")', () => {
    const r = buildMid(A('CONG TY TNHH MAY MAC HOA BINH', ['So 12 Duong 3'], 'Ho Chi Minh', 'VN'))!;
    expect(r.mid).toBe('VNMAYMAC12HOC');
    expect(r.needsVerification).toBe(true);
  });

  it('takes the number from the street line, not from a locality / postal district after the city', () => {
    // "Colombo 15" is the city + postal district; the street number is 5
    const r = buildMid(A('Lanka Weave Garments (Pvt) Ltd', ['5 Galle Road, Colombo 15'], 'Colombo', 'LK'))!;
    expect(r.mid).toBe('LKLANWEA5COL');
  });

  it('ignores package counts / currency text run on into the street line', () => {
    const r = buildMid(A('Lanka Weave Garments (Pvt) Ltd', ['41 Baseline Road, Colombo 09 186 CTNS Currency: US$'], 'Colombo', 'LK'))!;
    expect(r.mid).toBe('LKLANWEA41COL');
  });

  it('prefers the street line over numbered non-street lines (tax registrations, carton counts)', () => {
    const r = buildMid(A('Kaveri Knit Exports Pvt Ltd', ['GSTIN: 33AABCK4417M1Z5', 'S.F. No. 214/2, Kangeyam Road'], 'Tiruppur', 'IN'))!;
    expect(r.mid).toBe('INKAVKNI214TIR');
    const s = buildMid(A('Lanka Weave Garments (Pvt) Ltd', ['186 CTNS', '41 Baseline Road'], 'Colombo', 'LK'))!;
    expect(s.mid).toBe('LKLANWEA41COL');
    expect(s.needsVerification).toBe(false);
    // a street that merely starts like a tax label is still the street
    expect(buildMid(A('Harbour Knit Ltd', ['Pan Asia Centre, 12 Harbour Road'], 'Hong Kong', 'HK'))!.mid).toBe('HKHARKNI12HON');
    expect(buildMid(A('Harbour Knit Ltd', ['Tin Hau Temple Road 18'], 'Hong Kong', 'HK'))!.mid).toBe('HKHARKNI18HON');
  });

  it('returns null without a manufacturer name', () => {
    expect(buildMid(A('  ', [], 'X', 'VN'))).toBeNull();
  });
});

describe('ISO 6346 container check digit', () => {
  it('OPLU3041722 is valid (check digit 2); OPLU3041728 is not', () => {
    expect(iso6346CheckDigit('OPLU3041722')).toBe(2);
    expect(iso6346CheckDigit('OPLU304172')).toBe(2);
    expect(isValidContainerNumber('OPLU3041722')).toBe(true);
    expect(isValidContainerNumber('OPLU3041728')).toBe(false);
  });
  it('matches the ISO 6346 standard example and handles 10 → 0', () => {
    expect(iso6346CheckDigit('CSQU305438')).toBe(3);
    expect(isValidContainerNumber('CSQU 305438 3')).toBe(true);
    expect(isValidContainerNumber('OPLU30417')).toBe(false);
    expect(() => iso6346CheckDigit('12345')).toThrow();
  });
});

describe('fees (FY2027)', () => {
  it('uses the Federal Register FY2027 MPF limits and the statutory HMF rate', () => {
    const cfg = feeConfig();
    expect(cfg.fiscalYear).toBe('FY2027');
    expect(cfg.mpfRate).toBe(0.003464);
    expect(cfg.mpfMin).toBe(34.58);
    expect(cfg.mpfMax).toBe(670.86);
    expect(cfg.hmfRate).toBe(0.00125);
    expect(cfg.note).toMatch(/federalregister\.gov/);
  });
  it('clamps MPF to min/max and charges HMF on vessel shipments only', () => {
    expect(computeMpf(27439)).toBe(95.05);
    expect(computeMpf(5000)).toBe(34.58);
    expect(computeMpf(500000)).toBe(670.86);
    expect(computeMpf(0)).toBe(0);
    expect(computeHmf(27439, true)).toBe(34.3);
    expect(computeHmf(27439, false)).toBe(0);
  });
});
