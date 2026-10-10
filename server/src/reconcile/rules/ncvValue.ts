/**
 * NCV_VALUE: free-of-charge / no-commercial-value lines must still be entered at the value of the
 * goods (identical/similar goods or cost of production, 19 USC 1401a). A stated value that looks
 * nominal is flagged: < 25% of the unit value of comparable lines or < USD 2 per unit. Missing value
 * is a blocker.
 */
import type { Issue } from '@app/shared';
import type { LineLink, ReconcileContext, Rule } from '../context';
import { linePath } from '../context';
import { makeIssue } from '../lib/issues';
import { fmtMoney, isNum, median, round2 } from '../lib/num';
import { detailsMatching, invoiceLineEvidence, lineName, lineNameLc, money, qtyText } from './helpers';

export const NOMINAL_SHARE = 0.25;
export const NOMINAL_FLOOR_USD = 2;

/** Value per unit of a commercial line, including assists (its real cost to the buyer). */
const unitValue = (l: LineLink) => (l.line.amount.value + l.line.assists.reduce((s, a) => s + a.value, 0)) / l.line.quantity.value;

/** Comparable commercial lines: same garment type, else same HS heading, else all commercial lines of the invoice. */
function comparables(ctx: ReconcileContext, link: LineLink): { lines: LineLink[]; basis: string } {
  const pool = ctx.links.filter((l) => l.inv.invoice.currency === link.inv.invoice.currency && !l.line.noCommercialValue && l.line.quantity.value > 0 && l.line.amount.value > 0 && l.line.unit === link.line.unit);
  const gt = link.line.attributes.garmentType;
  const sameType = gt ? pool.filter((l) => l.line.attributes.garmentType === gt) : [];
  if (sameType.length) return { lines: sameType, basis: `the same garment type (${gt})` };
  const heading = link.line.hsCodeDeclared?.replace(/\D/g, '').slice(0, 4);
  const sameHeading = heading && heading.length === 4 ? pool.filter((l) => l.line.hsCodeDeclared?.replace(/\D/g, '').startsWith(heading)) : [];
  if (sameHeading.length) return { lines: sameHeading, basis: `the same HS heading (${heading})` };
  return { lines: pool, basis: 'the commercial lines on the invoice' };
}

function lineIssue(ctx: ReconcileContext, link: LineLink): Issue | undefined {
  if (!link.line.noCommercialValue) return undefined;
  const qty = link.line.quantity.value;
  const unit = link.line.unit;
  const cur = link.inv.invoice.currency;
  const stated = link.line.customsValue;
  const evidence = [invoiceLineEvidence(link)];
  const quotes = detailsMatching(link, /F\.?O\.?C|free of charge|commercial value|customs|N\.?C\.?V|sample/i);

  if (!isNum(stated) || stated <= 0) {
    return makeIssue({
      code: 'NCV_VALUE',
      key: link.line.id,
      severity: 'blocker',
      category: 'valuation',
      title: `${lineName(link)}: no-commercial-value line without a customs value`,
      detail: `${lineName(link)} (${qtyText(qty, unit)}) is free of charge / no commercial value${quotes.length ? ` ("${quotes.join('"; "')}")` : ''} and no value for customs is stated. Goods without a sale price must still be entered at their value (identical/similar goods or cost of production).`,
      evidence,
      action: 'Obtain the value of the goods (factory cost or the price of comparable commercial goods) from the shipper and enter it for this line.',
      field: linePath(link, 'customsValue'),
      lineId: link.line.id,
    });
  }

  const perUnit = qty > 0 ? stated / qty : stated;
  const comp = comparables(ctx, link);
  const ref = median(comp.lines.map(unitValue));
  const reasons: string[] = [];
  if (ref !== undefined && perUnit < NOMINAL_SHARE * ref) reasons.push(`it is under ${NOMINAL_SHARE * 100}% of the median unit value of ${comp.basis} (${fmtMoney(round2(ref), cur)}/${unit || 'unit'})`);
  if (cur === 'USD' && perUnit < NOMINAL_FLOOR_USD) reasons.push(`it is below USD ${NOMINAL_FLOOR_USD.toFixed(2)} per unit`);
  const nominal = reasons.length > 0;

  return makeIssue({
    code: 'NCV_VALUE',
    key: link.line.id,
    severity: nominal ? 'warning' : 'info',
    category: 'valuation',
    title: nominal ? `${lineName(link)}: stated customs value looks nominal (${money(link, perUnit)}/${unit || 'unit'})` : `${lineName(link)}: no-commercial-value line entered at stated value`,
    detail:
      `${lineName(link)} is free of charge / no commercial value${quotes.length ? ` ("${quotes.join('"; "')}")` : ''}; the stated value for customs is ${money(link, stated)} for ${qtyText(qty, unit)} (${money(link, round2(perUnit))}/${unit || 'unit'}). ` +
      (nominal
        ? `This looks nominal because ${reasons.join(' and ')}. CBP requires NCV goods to be entered at the value of identical or similar goods, or their cost of production, not a token amount.`
        : 'It is used as the line value; NCV goods must be entered at their actual value.'),
    evidence,
    action: nominal
      ? `Ask the shipper for the factory cost or the price of comparable commercial goods and update ${lineNameLc(link)}'s value; entering a nominal value risks undervaluation penalties.`
      : 'Confirm the stated value reflects the actual value of the goods.',
    field: linePath(link, 'customsValue'),
    lineId: link.line.id,
  });
}

export const ncvValueRule: Rule = {
  name: 'ncv-value',
  codes: ['NCV_VALUE'],
  run: (ctx) => ctx.links.map((l) => lineIssue(ctx, l)).filter((i): i is Issue => !!i),
};
