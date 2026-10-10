import { describe, expect, it } from 'vitest';
import { lookups } from '../../src/reference/index.js';
import { CARGO_AIRPORTS, majorUsPortCodes, portCountry, scheduleKExists, usPortExists } from '../../src/reference/ports.js';
import { countryName, isIsoAlpha2 } from '../../src/reference/countries.js';

describe('usPortCode (CBP Schedule D)', () => {
  const cases: [string, string | null][] = [
    ['TACOMA, WA, USA', '3002'],
    ['TACOMA, WA, U.S.A.', '3002'],
    ['Port of Tacoma', '3002'],
    ['SEATTLE, WA', '3001'],
    ['BLAINE WA', '3004'],
    ['LOS ANGELES/LONG BEACH', '2704'],
    ['Los Angeles, CA', '2704'],
    ['LONG BEACH, CA', '2709'],
    ['LAX', '2720'],
    ['LOS ANGELES INTL AIRPORT', '2720'],
    ['NEW YORK, NY', '1001'],
    ['NEWARK, NJ', '4601'],
    ['NY/NJ', '4601'],
    ['JFK AIRPORT', '4701'],
    ['New York JFK', '4701'],
    ['SEATTLE-TACOMA INTL AIRPORT', '3029'],
    ['HOUSTON, TX', '5301'],
    ['CHARLESTON, SC', '1601'],
    ['Charleston, WV', '1409'],
    ['SAVANNAH, GA', '1703'],
    ['NORFOLK, VA', '1401'],
    ['BALTIMORE', '1303'],
    ['MIAMI, FL', '5201'],
    ['MIAMI INTERNATIONAL AIRPORT', '5206'],
    ['CHICAGO, IL', '3901'],
    ['SAN FRANCISCO', '2809'],
    ['OAKLAND, CA', '2811'],
    ['DETROIT, MI', '3801'],
    ['BUFFALO, NY', '0901'],
    ['PORTLAND, OR', '2904'],
    ['PORTLAND, ME', '0101'],
    ['3002', '3002'],
    ['PORTLAND', null], // two states, no way to choose
    ['Kent, WA 98032', null], // not a port
    ['XYZ', null],
    ['', null],
  ];
  for (const [text, code] of cases) {
    it(`${JSON.stringify(text)} → ${code}`, () => {
      expect(lookups.usPortCode(text)?.code ?? null).toBe(code);
    });
  }

  it('every curated major port code exists in the Schedule D / CBP data, and there are ≥ 60 of them', () => {
    const codes = majorUsPortCodes();
    expect(new Set(codes).size).toBeGreaterThanOrEqual(60);
    for (const c of codes) expect(usPortExists(c), c).toBe(true);
  });

  it('returns a readable name', () => {
    expect(lookups.usPortCode('TACOMA, WA, USA')).toEqual({ code: '3002', name: 'Tacoma, Washington' });
  });
});

describe('foreignPortCode (Schedule K, sea ports only)', () => {
  const cases: [string, string | undefined, string | null][] = [
    ['CAT LAI, HO CHI MINH CITY, VN', undefined, '55224'],
    ['HO CHI MINH', undefined, '55224'],
    ['SAIGON, VIETNAM', undefined, '55224'],
    ['CAT LAI', undefined, null], // terminal name not in Schedule K: no guess
    ['HAIPHONG, VIETNAM', undefined, '55201'],
    ['CAI MEP, VN', undefined, '55206'],
    ['DA NANG', 'VN', '55204'],
    ['SHANGHAI, CHINA', undefined, '57035'],
    ['NINGBO', undefined, '57020'],
    ['YANTIAN, SHENZHEN, CN', undefined, '57078'],
    ['SHENZHEN', undefined, null], // several Shenzhen ports (Yantian, Shekou, Chiwan, Da Chan Bay)
    ['QINGDAO', undefined, '57047'],
    ['XIAMEN, CHINA', undefined, '57069'],
    ['HONG KONG', undefined, '58201'],
    ['CHITTAGONG, BANGLADESH', undefined, '53827'],
    ['CHATTOGRAM', undefined, '53827'],
    ['NHAVA SHEVA, INDIA', undefined, '53313'],
    ['CHENNAI', undefined, '53357'],
    ['MUNDRA', undefined, '53306'],
    ['COLOMBO, SRI LANKA', undefined, '54201'],
    ['HAMBURG, GERMANY', undefined, '42876'],
    ['BREMERHAVEN', undefined, '42870'],
    ['ROTTERDAM, NETHERLANDS', undefined, '42157'],
    ['BUSAN, KOREA', undefined, '58023'],
    ['PUSAN', undefined, '58023'],
    ['TOKYO, JAPAN', undefined, '58886'],
    ['YOKOHAMA', undefined, '58895'],
    ['KOBE', undefined, '58840'],
    ['NAGOYA', undefined, '58857'],
    ['KAOHSIUNG, TAIWAN', undefined, '58309'],
    ['SINGAPORE', undefined, '55976'],
    ['FRANKFURT AIRPORT, GERMANY', undefined, null],
    ['HO CHI MINH CITY AIRPORT (SGN)', undefined, null],
    ['BAR HARBOUR', undefined, null], // short names need a country or an exact segment
    ['HAMBURG', 'VN', null], // country filter
  ];
  for (const [text, country, code] of cases) {
    it(`${JSON.stringify(text)}${country ? ` [${country}]` : ''} → ${code}`, () => {
      expect(lookups.foreignPortCode(text, country)?.code ?? null).toBe(code);
    });
  }

  it('the official Schedule K snapshot carries the codes above', () => {
    for (const c of ['55224', '55201', '55206', '55204', '57035', '57020', '57078', '57047', '57069', '58201', '53827', '53313', '53357', '53306', '54201', '42876', '42870', '42157', '58023', '58886', '58309', '55976']) {
      expect(scheduleKExists(c), c).toBe(true);
    }
  });
});

describe('countryCode', () => {
  const cases: [string, string | null][] = [
    ['VIETNAM', 'VN'],
    ['VIET NAM', 'VN'],
    ['U.S.A.', 'US'],
    ['USA', 'US'],
    ['UNITED STATES', 'US'],
    ['United States of America', 'US'],
    ['HONG KONG', 'HK'],
    ['P.R. CHINA', 'CN'],
    ['PRC', 'CN'],
    ['KOREA, REPUBLIC OF', 'KR'],
    ['SOUTH KOREA', 'KR'],
    ['UK', 'GB'],
    ['U.K.', 'GB'],
    ['GREAT BRITAIN', 'GB'],
    ['VN', 'VN'],
    ['VNM', 'VN'],
    ['DEU', 'DE'],
    ['Bangladesh', 'BD'],
    ['Taiwan', 'TW'],
    ['Côte d’Ivoire', 'CI'],
    ['Türkiye', 'TR'],
    ['Kwun Tong, Kowloon, Hong Kong', 'HK'],
    ['Portland, OR 97210, U.S.A.', 'US'],
    ['Kent, WA 98032', 'US'],
    ['CAT LAI, HCMC, VN', 'VN'],
    ['Di An City, Binh Duong Province, Vietnam', 'VN'],
    ['Made in China', 'CN'],
    ['GEORGIA', 'GE'],
    ['Savannah, Georgia', null], // US state, not the country
    ['NEW MEXICO', null],
    ['PORTLAND, OR', null], // OR is a state, not a country code
    ['Narnia', null],
    ['', null],
  ];
  for (const [text, code] of cases) {
    it(`${JSON.stringify(text)} → ${code}`, () => {
      expect(lookups.countryCode(text)).toBe(code);
    });
  }
  it('has names for ISO codes', () => {
    expect(countryName('VN')).toBe('Vietnam');
  });
});

describe('usStateCode', () => {
  const cases: [string, string | null][] = [
    ['Kent, WA 98032, U.S.A.', 'WA'],
    ['Portland, OR 97210', 'OR'],
    ['TACOMA, WA, USA', 'WA'],
    ['Tacoma, Washington', 'WA'],
    ['Springfield, Illinois 62701', 'IL'],
    ['Washington, DC 20001', 'DC'],
    ['New York, NY', 'NY'],
    ['Indianapolis, IN 46204', 'IN'],
    ['WA', 'WA'],
    ['2150 NW Raleigh Street, Suite 300', null],
    ['Ho Chi Minh City, VN', null],
    ['', null],
  ];
  for (const [text, code] of cases) {
    it(`${JSON.stringify(text)} → ${code}`, () => {
      expect(lookups.usStateCode(text)).toBe(code);
    });
  }
});

describe('portCountry (country of a foreign port or airport)', () => {
  const cases: [string, string | null][] = [
    ['FRANKFURT/MAIN (FRA)', 'DE'], // IATA FRA is Frankfurt, not the ISO alpha-3 code of France
    ['FRA', 'DE'],
    ['HONG KONG (HKG)', 'HK'],
    ['Leipzig/Halle Airport', 'DE'],
    ['MUNICH AIRPORT', 'DE'],
    ['NARITA', 'JP'],
    ['ICN', 'KR'],
    ['CHENNAI', 'IN'], // Schedule K sea port
    ['HAMBURG', 'DE'],
    ['CAT LAI, HO CHI MINH CITY', 'VN'],
    ['SHENZHEN', 'CN'], // several Schedule K codes, one country
    ['XYZ', null],
    ['SOMEWHERE INLAND', null],
    ['', null],
  ];
  for (const [text, iso] of cases) {
    it(`${JSON.stringify(text)} → ${iso}`, () => {
      expect(portCountry(text)).toBe(iso);
      expect(lookups.portCountry?.(text) ?? null).toBe(iso);
    });
  }

  it('the curated airport table has unique IATA codes and ISO countries', () => {
    const codes = CARGO_AIRPORTS.map((a) => a.iata);
    expect(new Set(codes).size).toBe(codes.length);
    for (const a of CARGO_AIRPORTS) {
      expect(a.iata, a.iata).toMatch(/^[A-Z]{3}$/);
      expect(isIsoAlpha2(a.country), `${a.iata} ${a.country}`).toBe(true);
    }
  });
});
