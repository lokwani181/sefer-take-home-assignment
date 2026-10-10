import { describe, expect, it } from 'vitest';
import { isValidAwb, isValidContainer, iso6346CheckDigit, singleConfusionVariants } from '../checks.js';
import { computeEnteredValues, roundWhole } from '../consistency.js';
import { fmtMoney, fmtNum, roundCents } from '../format.js';
import { createRng, hashSeed } from '../prng.js';
import { intWords, moneyWords } from '../words.js';

describe('ISO 6346 container check digit', () => {
  it('accepts the canonical published example and rejects a one-digit change', () => {
    expect(iso6346CheckDigit('CSQU305438')).toBe(3);
    expect(isValidContainer('CSQU3054383')).toBe(true);
    expect(isValidContainer('CSQU 305438 3')).toBe(true);
    expect(isValidContainer('CSQU3054384')).toBe(false);
  });

  it('lists single OCR-confusion variants', () => {
    const v = singleConfusionVariants('ABCU1000000');
    expect(v).toContain('ABCU7000000'); // 1 → 7
    expect(v).toContain('ABCU1800000'); // 0 → 8
    expect(v.every((s) => s.startsWith('ABCU'))).toBe(true);
  });
});

describe('air waybill check digit', () => {
  it('validates the IATA modulus-7 rule', () => {
    expect(isValidAwb('020-12345675')).toBe(true);
    expect(isValidAwb('020-12345674')).toBe(false);
    expect(isValidAwb('020-1234567')).toBe(false);
  });
});

describe('seeded PRNG', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng('x');
    const b = createRng('x');
    const c = createRng('y');
    const sa = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
    expect(hashSeed('s1-awb')).toBe(hashSeed('s1-awb'));
  });

  it('produces roughly standard-normal values', () => {
    const r = createRng('gauss');
    const n = 20000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const g = r.gauss();
      sum += g;
      sq += g * g;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.05);
    expect(Math.abs(sq / n - 1)).toBeLessThan(0.05);
  });
});

describe('number formatting', () => {
  it('formats en and de styles without Intl', () => {
    expect(fmtMoney(21878)).toBe('21,878.00');
    expect(fmtMoney(21878, 'de')).toBe('21.878,00');
    expect(fmtNum(1342, 1, 'de')).toBe('1.342,0');
    expect(fmtNum(5335, 3)).toBe('5,335.000');
    expect(fmtMoney(96)).toBe('96.00');
    expect(roundCents(1200 * 6.85)).toBe(8220);
  });
});

describe('valuation policy helper', () => {
  it('prorates included charges by line value and rounds per line', () => {
    expect(computeEnteredValues({ lineAmounts: [4440, 4860, 8220, 3400], includedNonDutiableCharges: 4580 })).toEqual([
      3468, 3796, 6420, 2656,
    ]);
    expect(computeEnteredValues({ lineAmounts: [100, 200], includedNonDutiableCharges: 0, assists: [0, 50] })).toEqual([100, 250]);
    expect(roundWhole(2.5)).toBe(3);
    expect(roundWhole(2.4999)).toBe(2);
  });

  it('prorates a granted invoice discount like included charges, and an absent discount changes nothing', () => {
    expect(computeEnteredValues({ lineAmounts: [100, 300], includedNonDutiableCharges: 0, discount: 20 })).toEqual([95, 285]);
    expect(computeEnteredValues({ lineAmounts: [100, 300], includedNonDutiableCharges: 40, discount: 20 })).toEqual([85, 255]);
    expect(computeEnteredValues({ lineAmounts: [4440, 4860], includedNonDutiableCharges: 0 })).toEqual(
      computeEnteredValues({ lineAmounts: [4440, 4860], includedNonDutiableCharges: 0, discount: 0 }),
    );
  });
});

describe('amounts in words', () => {
  it('spells whole numbers and cents', () => {
    expect(intWords(20920, { and: true, hyphen: false })).toBe('TWENTY THOUSAND NINE HUNDRED AND TWENTY');
    expect(intWords(171354)).toBe('ONE HUNDRED SEVENTY-ONE THOUSAND THREE HUNDRED FIFTY-FOUR');
    expect(moneyWords(171354.77)).toBe('ONE HUNDRED SEVENTY-ONE THOUSAND THREE HUNDRED FIFTY-FOUR AND CENTS SEVENTY-SEVEN');
    expect(moneyWords(114300)).toBe('ONE HUNDRED FOURTEEN THOUSAND THREE HUNDRED');
    expect(intWords(1_000_005)).toBe('ONE MILLION FIVE');
  });
});
