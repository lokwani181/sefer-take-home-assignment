import { describe, expect, it } from 'vitest';
import { detectDecimalSep, findNumbers, parseNumber } from '../../src/parse/numbers';
import { findDates, isMonthFirstCountry, parseDate } from '../../src/parse/dates';
import { parseComposition } from '../../src/parse/domain/composition';
import { detectConstruction, detectGarmentType, detectGender } from '../../src/parse/domain/garment';
import { chooseContainer, containerCandidates, isoCheckDigit, isValidContainerNumber, ownerCodeHints, parseSizeType, type RawToken } from '../../src/parse/domain/container';
import { cleanCode, findHsCodes, findScac, hsHeadingExists, looksLikeBillNumber, parseCurrency, parseHsCell, parseIncoterm, volumeToCbm, weightToKg } from '../../src/parse/domain/codes';
import { classifyCharge, findAssist, isNoCommercialValue, statedCustomsValue } from '../../src/parse/domain/value';
import { findPhone, normalizePhone, parseParty } from '../../src/parse/party';
import { findMarkers, markersInNote, splitNotes } from '../../src/parse/footnotes';
import { countryCode, findCountry } from '../../src/parse/countries';
import { reconcileStampDate, parseOriginals } from '../../src/parse/docs/billOfLading';
import { isValidAwb, findAwbNumbers } from '../../src/parse/docs/airWaybill';
import { clipAddressText, lineFactsFromNote, looksLikeManufacturer } from '../../src/parse/docs/common';
import { splitVesselVoyage } from '../../src/parse/docs/invoice';

describe('parseNumber', () => {
  it.each([
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1 234,56', 1234.56],
    ['2,400', 2400],
    ['6,480.00', 6480],
    ['1,930.000', 1930],
    ['13.580', 13.58],
    ['21.878,00', 21878],
    ['USD 4,180.00', 4180],
    ['3,85', 3.85],
    ['12,34,567.00', 1234567],
  ])('%s → %d', (text, value) => {
    expect(parseNumber(text)?.value).toBeCloseTo(value, 6);
  });

  it('keeps parentheses as a flag (NCV/negative decided by the caller)', () => {
    const p = parseNumber('(24.00)')!;
    expect(p.value).toBe(24);
    expect(p.parenthesized).toBe(true);
    expect(parseNumber('-15.5')!.negative).toBe(true);
    expect(parseNumber('15.50-')!.negative).toBe(true);
  });

  it('maps OCR letter confusions in a numeric context and flags the repair', () => {
    expect(parseNumber('S55')).toMatchObject({ value: 555, repaired: true });
    expect(parseNumber('1O0')).toMatchObject({ value: 100, repaired: true });
    expect(parseNumber('l2.5')).toMatchObject({ value: 12.5, repaired: true });
    expect(parseNumber('B8')).toMatchObject({ value: 88, repaired: true });
    expect(parseNumber('1|0')).toMatchObject({ value: 110, repaired: true });
    expect(parseNumber('OS')).toBeNull();
    expect(parseNumber('S55', { ocrFix: false })).toBeNull();
  });

  it('repairs a comma read as the decimal point in a dot-decimal column', () => {
    const p = parseNumber('14,60', { decimalSep: '.' })!;
    expect(p.value).toBe(14.6);
    expect(p.repaired).toBe(true);
    // in a comma-decimal document the same token is simply correct
    expect(parseNumber('14,60', { decimalSep: ',' })).toMatchObject({ value: 14.6, repaired: false });
    // a single 3-digit group stays thousands unless the column is comma-decimal
    expect(parseNumber('1,176', { decimalSep: '.' })!.value).toBe(1176);
    expect(parseNumber('1,176', { decimalSep: ',' })!.value).toBe(1.176);
  });

  it('strips table rules glued to numbers by OCR', () => {
    expect(parseNumber('60|')!.value).toBe(60);
    expect(parseNumber('1,200]')!.value).toBe(1200);
    expect(parseNumber('2.10 *')!.value).toBe(2.1);
  });

  it('rejects non-numbers', () => {
    for (const t of ['', 'PCS', '1-48', "20'GP", 'NB-T101', 'sing']) expect(parseNumber(t)).toBeNull();
  });

  it('detects the decimal convention of a column', () => {
    expect(detectDecimalSep(['9.00', '10.00', '14,60', '15.80'])).toBe('.');
    expect(detectDecimalSep(['3,85', '9.240,00', '2,15'])).toBe(',');
    expect(detectDecimalSep(['100', '200'])).toBeUndefined();
  });

  it('finds numbers inside prose', () => {
    expect(findNumbers('value USD 4,180.00, not included').map((n) => n.value)).toContain(4180);
  });
});

describe('dates', () => {
  it.each([
    ['24-SEP-2026', '2026-09-24'],
    ['20-Sep-2026', '2026-09-20'],
    ['24 SEP 2026', '2026-09-24'],
    ['2026-09-24', '2026-09-24'],
    ['SEP. 08, 2026', '2026-09-08'],
    ['September 8th, 2026', '2026-09-08'],
    ['18.09.2026', '2026-09-18'],
    ['14-0CT-2026', '2026-10-14'],
  ])('%s → %s', (text, iso) => {
    expect(parseDate(text)?.iso).toBe(iso);
  });

  it('flags dd/mm vs mm/dd ambiguity and picks the primary reading by convention', () => {
    const dmy = parseDate('12/09/2026')!;
    expect(dmy).toMatchObject({ iso: '2026-09-12', ambiguous: true, alternatives: ['2026-12-09'] });
    const mdy = parseDate('03/04/2026', { monthFirst: true })!;
    expect(mdy).toMatchObject({ iso: '2026-03-04', ambiguous: true, alternatives: ['2026-04-03'] });
    expect(parseDate('25/12/2026')).toMatchObject({ iso: '2026-12-25', ambiguous: false });
    expect(parseDate('12/25/2026')).toMatchObject({ iso: '2026-12-25', ambiguous: false });
    expect(isMonthFirstCountry('US')).toBe(true);
    expect(isMonthFirstCountry('HK')).toBe(false);
  });

  // "Invoice No. & Date" boxes print the number and the date in one value: "MRH-260914-07 SEP. 14, 2026"
  it('does not read the tail of a hyphenated code, or a month-first day, as a day-month-2-digit-year date', () => {
    expect(parseDate('MRH-260914-07 SEP. 14, 2026')?.iso).toBe('2026-09-14');
    expect(parseDate('07 SEP. 14, 2026')?.iso).toBe('2026-09-14');
    expect(parseDate('24 SEP 26')?.iso).toBe('2026-09-24');
    expect(parseDate('INV.12-SEP-2026')?.iso).toBe('2026-09-12');
  });

  it('finds several dates in order', () => {
    expect(findDates('24-SEP-2026 / 14-OCT-2026').map((d) => d.iso)).toEqual(['2026-09-24', '2026-10-14']);
  });

  it('prefers the typed year when a stamp date is implausible', () => {
    const read = parseDate('DATE: 24 SEP 2006')!;
    expect(reconcileStampDate(read, '2026-09-24')).toEqual({ iso: '2026-09-24', repaired: true });
    expect(reconcileStampDate(parseDate('25 SEP 2026')!, '2026-09-24')).toEqual({ iso: '2026-09-25', repaired: false });
    // two digits off: not a single OCR slip, kept as read
    expect(reconcileStampDate(parseDate('24 SEP 1996')!, '2026-09-24').repaired).toBe(false);
  });
});

describe('fibre composition', () => {
  it.each([
    ['60% Cotton 40% Polyester brushed fleece', [['cotton', 60], ['polyester', 40]], '60% Cotton 40% Polyester'],
    ['100% Cotton single jersey', [['cotton', 100]], '100% Cotton'],
    ['98/2 COTTON/SPANDEX TWILL', [['cotton', 98], ['elastane', 2]], '98/2 COTTON/SPANDEX'],
    ['TC 65/35 FLEECE 280GSM', [['polyester', 65], ['cotton', 35]], 'TC 65/35'],
    ['T/C 80/20 poplin', [['polyester', 80], ['cotton', 20]], 'T/C 80/20'],
    ['CVC 60/40 jersey', [['cotton', 60], ['polyester', 40]], 'CVC 60/40'],
    ['100% POLY CREPE (BUYER FABRIC)', [['polyester', 100]], '100% POLY'],
    ['Cotton 95% / Lycra 5%', [['cotton', 95], ['elastane', 5]], 'Cotton 95% / Lycra 5%'],
    ['55% linen, 45% viscose', [['linen', 55], ['viscose', 45]], '55% linen, 45% viscose'],
    ['70% wool 30% polyamide', [['wool', 70], ['nylon', 30]], '70% wool 30% polyamide'],
  ])('%s', (text, fibers, raw) => {
    const c = parseComposition(text)!;
    expect(c.fibers.map((f) => [f.fiber, f.pct])).toEqual(fibers);
    expect(c.raw).toBe(raw);
  });

  it('ignores numbers that are not compositions', () => {
    expect(parseComposition('Size ratio S-M-L-XL-XXL : 1-3-3-2-1')).toBeNull();
    expect(parseComposition('Waist 30-32-34-36-38')).toBeNull();
    expect(parseComposition('1 PC PER COLOUR/SIZE')).toBeNull();
  });
});

describe('garment attributes', () => {
  it('gender', () => {
    expect(detectGender("WOMEN'S PULLOVER HOODIE")).toBe('women');
    expect(detectGender("MEN'S CREW NECK T-SHIRT")).toBe('men');
    expect(detectGender('LADIES POLO')).toBe('women');
    expect(detectGender('BOYS SHORTS')).toBe('boys');
    expect(detectGender("GIRLS' DRESS")).toBe('girls');
    expect(detectGender('UNISEX HOODIE')).toBe('unisex');
    expect(detectGender('BABY ROMPER')).toBe('infant');
    expect(detectGender('KITCHEN KNIFE')).toBeUndefined();
  });

  it('construction: explicit word wins over fabric hints', () => {
    expect(detectConstruction('100% Cotton single jersey, knitted')).toBe('knit');
    expect(detectConstruction('stretch twill, woven')).toBe('woven');
    expect(detectConstruction('pique polo')).toBe('knit');
    expect(detectConstruction('denim jeans')).toBe('woven');
    expect(detectConstruction('crepe de chine blouse')).toBe('woven');
    expect(detectConstruction('jersey fabric, woven')).toBe('woven');
    expect(detectConstruction('knit and woven garments')).toBeUndefined();
  });

  it('garment type: specific before generic', () => {
    expect(detectGarmentType('POLO SHIRT - SAMPLES')).toBe('polo');
    expect(detectGarmentType('CREW NECK S/S TEE')).toBe('t-shirt');
    expect(detectGarmentType('PULLOVER HOODIE')).toBe('hoodie');
    expect(detectGarmentType('SLIM FIT CHINO TROUSERS')).toBe('trousers');
    expect(detectGarmentType('LONG SLEEVE BLOUSE')).toBe('blouse');
    expect(detectGarmentType('OXFORD SHIRT')).toBe('shirt');
  });
});

describe('ISO 6346 containers', () => {
  it('computes the check digit', () => {
    expect(isoCheckDigit('CSQU305438')).toBe(3);
    expect(isValidContainerNumber('CSQU3054383')).toBe(true);
    expect(isValidContainerNumber('OPLU3041722')).toBe(true);
    expect(isValidContainerNumber('OPLU3041728')).toBe(false);
    expect(isValidContainerNumber('OPLU 304172 2')).toBe(true);
  });

  it('recovers a handwritten correction using the owner code seen elsewhere on the page', () => {
    const tokens: RawToken[] = [
      { text: 'OPLU3041228', raw: '“OPLU3041228__', conf: 2, line: 1, x0: 112 },
      { text: 'ORSKU', raw: 'ORSKU', conf: 0, line: 2, x0: 132 },
      { text: '304/72', raw: '304/72', conf: 88, line: 2, x0: 261 },
      { text: '2', raw: '2', conf: 93, line: 2, x0: 394 },
    ];
    const readings = containerCandidates(tokens, ownerCodeHints('CARRIER: ORIENT PACIFIC LINES (OPLU)\nSEAL: OPL7731482'));
    const choice = chooseContainer(readings, tokens)!;
    expect(choice.number).toBe('OPLU3041722');
    expect(choice.checkDigitValid).toBe(true);
    expect(choice.repaired).toBe(true);
    expect(choice.candidates).toEqual([
      { number: 'OPLU3041228', checkDigitValid: false, source: 'strikethrough' },
      { number: 'OPLU3041722', checkDigitValid: true, source: 'handwritten' },
    ]);
  });

  it('never invents a correction for a typed number with a wrong check digit', () => {
    const tokens: RawToken[] = [
      { text: 'BYXU', conf: 92, line: 1, x0: 143 },
      { text: '5209184', conf: 97, line: 1, x0: 257 },
    ];
    const choice = chooseContainer(containerCandidates(tokens, ['BYXU']), tokens)!;
    expect(choice.number).toBe('BYXU5209184');
    expect(choice.checkDigitValid).toBe(false);
    expect(choice.candidates).toEqual([]);
  });

  it('normalizes size/type', () => {
    expect(parseSizeType("1 X 20'GP CONTAINER")).toEqual({ sizeType: '20GP', count: 1 });
    expect(parseSizeType("40' HC")?.sizeType).toBe('40HC');
    expect(parseSizeType('1 x 40HQ')?.sizeType).toBe('40HC');
    expect(parseSizeType('45G1')?.sizeType).toBe('40HC');
    expect(parseSizeType('22G1')?.sizeType).toBe('20GP');
  });
});

describe('codes', () => {
  it('HS codes and heading plausibility', () => {
    expect(findHsCodes('HS: 6109.10 / 6110.20 / 6203.42').map((h) => h.code)).toEqual(['6109.10', '6110.20', '6203.42']);
    expect(parseHsCell('6109.10.0012')).toBe('6109.10.0012');
    expect(parseHsCell('61091000')).toBe('6109.10.00');
    expect(hsHeadingExists('6203.42')).toBe(true);
    expect(hsHeadingExists('6263.42')).toBe(false);
    expect(hsHeadingExists('6117.10')).toBe(true);
    expect(hsHeadingExists('6118.10')).toBe(false);
  });

  it.each([
    ['CIF TACOMA, WA (INCOTERMS 2020)', { code: 'CIF', place: 'TACOMA, WA', version: '2020' }],
    ['FCA Frankfurt Airport (FRA), Incoterms® 2020', { code: 'FCA', place: 'Frankfurt Airport', version: '2020' }],
    ['DDP SAVANNAH, GA (INCOTERMS 2020)', { code: 'DDP', place: 'SAVANNAH, GA', version: '2020' }],
    ['F.O.B. Chennai', { code: 'FOB', place: 'Chennai', version: undefined }],
    ['C&F Long Beach', { code: 'CFR', place: 'Long Beach', version: undefined }],
    ['Ex Works Shenzhen', { code: 'EXW', place: 'Shenzhen', version: undefined }],
  ])('incoterm %s', (text, exp) => {
    expect(parseIncoterm(text)).toEqual(exp);
  });

  it('currency', () => {
    expect(parseCurrency('SAY US DOLLARS TWENTY')).toBe('USD');
    expect(parseCurrency('Amount EUR')).toBe('EUR');
    expect(parseCurrency('Total in Euro')).toBe('EUR');
    expect(parseCurrency('HK$ 1,000')).toBe('HKD');
    expect(parseCurrency('RMB 500')).toBe('CNY');
    expect(parseCurrency('no currency here')).toBeUndefined();
  });

  it('weights and volumes with units', () => {
    expect(weightToKg(1930, 'KGS')).toBe(1930);
    expect(weightToKg(4255, 'LBS')).toBeCloseTo(1930.03, 1);
    expect(volumeToCbm(480, 'CFT')).toBeCloseTo(13.592, 2);
  });

  it('SCAC and bill numbers', () => {
    expect(findScac('CARRIER: ORIENT PACIFIC LINES (OPLU)')).toBe('OPLU');
    expect(findScac('FMC NVOCC No. 029415N SCAC: BMLV')).toBe('BMLV');
    expect(findScac('ZHOUSHAN PACIFIC LINES (SCAC ZSPL)')).toBe('ZSPL');
    expect(cleanCode('BMLHCM2609 -0377')).toBe('BMLHCM2609-0377');
    expect(looksLikeBillNumber('OPLUSGN260917735')).toBe(true);
    expect(looksLikeBillNumber('VIETNAM')).toBe(false);
  });

  it('AWB numbers use the mod-7 check', () => {
    expect(isValidAwb('020-12345675')).toBe(true);
    expect(isValidAwb('020-12345676')).toBe(false);
    expect(findAwbNumbers('MAWB 020 1234 5675')).toEqual(['020-12345675']);
  });

  it('vessel / voyage split', () => {
    expect(splitVesselVoyage('PACIFIC ARGOS / 041E')).toEqual({ vessel: 'PACIFIC ARGOS', voyage: '041E' });
    expect(splitVesselVoyage('PACIFIC ARGOS 041E')).toEqual({ vessel: 'PACIFIC ARGOS', voyage: '041E' });
    expect(splitVesselVoyage('MSC ANNA V.123W')).toEqual({ vessel: 'MSC ANNA', voyage: '123W' });
    expect(splitVesselVoyage('EVER GIVEN')).toEqual({ vessel: 'EVER GIVEN' });
  });

  it('number of originals', () => {
    expect(parseOriginals('THREE (3)')).toBe(3);
    expect(parseOriginals('3/3')).toBe(3);
    expect(parseOriginals('ZERO (0)')).toBe(0);
    expect(parseOriginals('ONE')).toBe(1);
  });
});

describe('countries', () => {
  it('names and codes', () => {
    expect(countryCode('VIETNAM')).toBe('VN');
    expect(countryCode('Viet Nam')).toBe('VN');
    expect(countryCode('U.S.A.')).toBe('US');
    expect(countryCode('Hong Kong')).toBe('HK');
    expect(countryCode("People's Republic of China")).toBe('CN');
    expect(countryCode('VN')).toBeUndefined();
    expect(countryCode('VN', { allowIso2: true })).toBe('VN');
    expect(findCountry('Made in Bangladesh. Hand-carried')?.iso).toBe('BD');
    expect(findCountry('ORIGIN: SRI LANKA')?.iso).toBe('LK');
  });
});

describe('parseParty', () => {
  it('US address with contact and phone', () => {
    const a = parseParty(['NORTHBOUND OUTFITTERS, INC.', '2150 NW Raleigh Street, Suite 300', 'Portland, OR 97210, U.S.A.', 'Attn: Megan Holt, Sourcing Dept.', 'Tel: +1 503 555 0148']);
    expect(a).toMatchObject({
      name: 'NORTHBOUND OUTFITTERS, INC.',
      lines: ['2150 NW Raleigh Street, Suite 300'],
      city: 'Portland',
      stateProvince: 'OR',
      postalCode: '97210',
      country: 'US',
      contact: 'Megan Holt, Sourcing Dept.',
      phone: '+1 503 555 0148',
    });
  });

  it('non-US address: city/province from trailing segments, tax id and phone after pipes', () => {
    const a = parseParty(['SAIGON PHOENIX GARMENT JOINT STOCK COMPANY', 'Lot C7-C8, Road No. 9, Song Than 2 Industrial Park, Di An Ward, Di An City, Binh Duong Province, Vietnam | MST/Tax Code: 3702148865 | Tel: +84 274 3742 618']);
    expect(a).toMatchObject({ city: 'Di An City', stateProvince: 'Binh Duong Province', country: 'VN', taxId: '3702148865', phone: '+84 274 3742 618' });
    expect(a.lines).toEqual(['Lot C7-C8, Road No. 9, Song Than 2 Industrial Park, Di An Ward']);
  });

  it('postal code before the city (European) and bilingual country', () => {
    const a = parseParty(['Rheinwerk Kuechentechnik GmbH', 'Klingenstraße 42', '42651 Solingen', 'Deutschland / Germany']);
    expect(a).toMatchObject({ city: 'Solingen', postalCode: '42651', country: 'DE', lines: ['Klingenstraße 42'] });
  });

  it('skips on-behalf-of lines and stops at the first locality', () => {
    const a = parseParty(['SAIGON PHOENIX GARMENT JSC', 'LOT C7-C8, ROAD NO. 9, SONG THAN 2 IP', 'DI AN CITY, BINH DUONG, VIETNAM', 'O/B KOWLOON BAY APPAREL SOURCING LTD', 'KWUN TONG, KOWLOON, HONG KONG']);
    expect(a).toMatchObject({ city: 'DI AN CITY', stateProvince: 'BINH DUONG', country: 'VN' });
  });

  it('one-line "Name Ltd., street, city, country"', () => {
    expect(parseParty(['SP Garments Dhaka Ltd., Plot 41, Gazipur, Bangladesh'])).toMatchObject({ name: 'SP Garments Dhaka Ltd.', lines: ['Plot 41'], city: 'Gazipur', country: 'BD' });
  });

  it('Indian PIN codes and tax ids', () => {
    const a = parseParty(['KAVERI KNIT EXPORTS PVT. LTD.', 'S.F. No. 214/2, Kangeyam Road', 'Tiruppur - 641 604, Tamil Nadu, INDIA', 'GSTIN: 33AABCK4417M1Z5']);
    expect(a).toMatchObject({ city: 'Tiruppur', stateProvince: 'Tamil Nadu', postalCode: '641 604', country: 'IN', taxId: '33AABCK4417M1Z5' });
  });

  it('"City NN" postal districts (Colombo 09, Dublin 4) split into city + district', () => {
    expect(parseParty(['ACME MILLS LTD', '41 Baseline Road', 'Colombo 09, Sri Lanka'])).toMatchObject({ lines: ['41 Baseline Road'], city: 'Colombo', postalCode: '09', country: 'LK' });
    expect(parseParty(['ACME MILLS LTD', '7 Harcourt Street, Dublin 2, Ireland'])).toMatchObject({ lines: ['7 Harcourt Street'], city: 'Dublin', postalCode: '2', country: 'IE' });
  });

  it('a country known from context (defaultCountry) lets the last segment be the locality', () => {
    expect(parseParty(['Lanka Weave Garments (Pvt) Ltd, 41 Baseline Road, Colombo 09'], { defaultCountry: 'LK' })).toMatchObject({
      name: 'Lanka Weave Garments (Pvt) Ltd',
      lines: ['41 Baseline Road'],
      city: 'Colombo',
      postalCode: '09',
      country: 'LK',
    });
    // without a hint nothing is guessed
    expect(parseParty(['Lanka Weave Garments (Pvt) Ltd, 41 Baseline Road, Colombo 09']).city).toBeUndefined();
  });

  it('phones tolerate OCR confusions; fax is not the phone', () => {
    expect(normalizePhone('+1 503 S55 @148')).toBe('+1 503 555 0148');
    expect(findPhone('Tel: +852 2797 4410 Fax: +852 2797 4411')).toBe('+852 2797 4410');
    expect(findPhone('Fax: +852 2797 4411')).toBeUndefined();
  });
});

describe('footnotes and notes', () => {
  it('splits notes by marker and normalizes markers', () => {
    const notes = splitNotes(['NOTES:', '(*) Style X: price is CMT only. Fabric supplied', 'by buyer, value USD 100.00.', '(1) Goods made in Vietnam.', '2. Second remark', '** Carton 3: samples']);
    expect(notes.map((n) => n.marker)).toEqual([undefined, '*', '1', '2', '**']);
    expect(notes[1].text).toBe('(*) Style X: price is CMT only. Fabric supplied by buyer, value USD 100.00.');
  });

  it('finds markers on rows and inside remarks', () => {
    expect(findMarkers('CMT price, see note (*)')).toEqual(['*']);
    expect(findMarkers('1 PC PER COLOUR/SIZE **')).toEqual(['**']);
    expect(findMarkers('see note 3')).toEqual(['3']);
    expect(findMarkers('100% Cotton')).toEqual([]);
    expect(markersInNote({ marker: '3', text: '3. ** Carton No. 138: samples' })).toEqual(['3', '**']);
  });

  it('line facts from a remark: producing factory and origin', () => {
    const f = lineFactsFromNote('3. ** Carton No. 138: FOC samples produced at our sister unit SP Garments Dhaka Ltd., Plot 41, Gazipur, Bangladesh. Made in Bangladesh.');
    expect(f.countryOfOrigin).toBe('BD');
    expect(f.manufacturer).toMatchObject({ name: 'SP Garments Dhaka Ltd.', city: 'Gazipur', country: 'BD' });
    const g = lineFactsFromNote('MADE IN SRI LANKA - Lanka Weave Garments (Pvt) Ltd, 41 Baseline Road, Colombo 09');
    expect(g.countryOfOrigin).toBe('LK');
    expect(g.manufacturer?.name).toBe('Lanka Weave Garments (Pvt) Ltd');
    expect(g.manufacturer).toMatchObject({ lines: ['41 Baseline Road'], city: 'Colombo', postalCode: '09', country: 'LK' });
  });

  it('a maker address run on into carton counts / currency / totals is cut before them', () => {
    const f = lineFactsFromNote('MADE IN SRI LANKA - Lanka Weave Garments (Pvt) Ltd, 41 Baseline Road, Colombo 09 186 CTNS Currency: US$');
    expect(f.manufacturer).toMatchObject({ name: 'Lanka Weave Garments (Pvt) Ltd', lines: ['41 Baseline Road'], city: 'Colombo', country: 'LK' });
    const g = lineFactsFromNote('Produced by Delta Knit Mills Ltd., 9 Mill Road, Kandy, Sri Lanka TOTAL US$ 4,000.00');
    expect(g.manufacturer).toMatchObject({ name: 'Delta Knit Mills Ltd.', city: 'Kandy', country: 'LK' });
    expect(g.manufacturer?.raw).not.toMatch(/TOTAL/);
    // compass abbreviations are address text; only weights followed by a number end the address
    expect(clipAddressText('Delta Mills Ltd., 2150 NW Raleigh Street, Portland, OR 97210, USA N.W. 120.5 KGS')).toBe('Delta Mills Ltd., 2150 NW Raleigh Street, Portland, OR 97210, USA');
  });

  it('manufacturer vs trader names', () => {
    expect(looksLikeManufacturer('SAIGON PHOENIX GARMENT JOINT STOCK COMPANY')).toBe(true);
    expect(looksLikeManufacturer('KOWLOON BAY APPAREL SOURCING LIMITED')).toBe(false);
    expect(looksLikeManufacturer('ACME TRADING CO., LTD.')).toBe(false);
  });
});

describe('value extractors', () => {
  it('no-commercial-value phrases', () => {
    for (const t of ['FOC SAMPLES - NO COMMERCIAL VALUE', 'N.C.V.', 'Free of charge', 'Value for customs purpose only USD 1.00/pc']) expect(isNoCommercialValue(t)).toBe(true);
    expect(isNoCommercialValue('100% Cotton pique, knitted')).toBe(false);
  });

  it('stated customs value per unit or total', () => {
    expect(statedCustomsValue('Value for customs purpose only USD 1.00/pc')).toEqual({ value: 1, perUnit: true, currency: 'USD' });
    expect(statedCustomsValue('Customs value: EUR 250.00')).toEqual({ value: 250, perUnit: false, currency: 'EUR' });
  });

  it('assists: buyer-supplied materials with a value, linked to styles', () => {
    const a = findAssist(
      "(*) Style W-B220: Price is CMT (cut, make & trim) only. Main fabric (100% polyester crepe de chine, 1,450 m) supplied free of charge by buyer under buyer's fabric P.O. NB-26-0918F, value USD 4,180.00, not included in this invoice.",
      ['NB-T101', 'W-B220'],
    )!;
    expect(a).toMatchObject({ value: 4180, currency: 'USD', styleRefs: ['W-B220'], reference: 'NB-26-0918F' });
    expect(a.description).toBe('Main fabric (100% polyester crepe de chine, 1,450 m) supplied free of charge by buyer');
    const b = findAssist('Moulds for item AB-100 provided by the customer, valued at EUR 2,500', ['AB-100'])!;
    expect(b).toMatchObject({ value: 2500, currency: 'EUR', styleRefs: ['AB-100'] });
    expect(findAssist('Goods manufactured in Vietnam.', [])).toBeNull();
  });

  it('charge classification', () => {
    expect(classifyCharge('Ocean Freight (Cat Lai - Tacoma)')).toBe('freight');
    expect(classifyCharge('Marine Insurance Premium')).toBe('insurance');
    expect(classifyCharge('US import duties & customs fees (estimated)')).toBe('duty');
    expect(classifyCharge("US inland delivery, port - buyer's warehouse")).toBe('inland_freight_us');
    expect(classifyCharge('Inland freight to port of origin')).toBe('inland_freight_foreign');
    expect(classifyCharge('Packing charges')).toBe('packing');
    expect(classifyCharge('Discount 5%')).toBe('discount');
    expect(classifyCharge('Goods value')).toBeNull();
  });
});

describe('container reading groups', () => {
  it('a correction joins the reading it corrects; distinct valid numbers stay separate', async () => {
    const { groupContainerReadings } = await import('../../src/parse/domain/container');
    const r = (number: string, valid: boolean, line: number) => ({ number, checkDigitValid: valid, source: 'typed' as const, originalText: number, conf: 90, repairs: [], line, x0: 0 });
    const groups = groupContainerReadings([r('OPLU3041728', false, 1), r('OPLU3041722', true, 2), r('CSQU3054383', true, 3)]);
    expect(groups.map((g) => g.map((x) => x.number))).toEqual([['OPLU3041728', 'OPLU3041722'], ['CSQU3054383']]);
  });
});
