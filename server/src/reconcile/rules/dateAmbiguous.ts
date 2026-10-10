/**
 * DATE_AMBIGUOUS: a numeric invoice date like 12/09/2026 reads as two dates. Resolved by
 * chronology (invoice ≤ packing list ≤ shipment ≤ arrival), then by the seller country's
 * convention (month-first in the US), and the result is set on ShipmentInvoice.invoiceDate.
 */
import type { Evidence, Issue } from '@app/shared';
import type { InvoiceSource, ReconcileContext, Rule } from '../context';
import { invoiceKey } from '../context';
import { daysBetween, isIsoDate, MONTH_FIRST_COUNTRIES, numericDateReadings } from '../lib/dates';
import { evidenceFor, makeIssue } from '../lib/issues';
import { sourced } from '../merge/sourced';

interface Anchor {
  label: string;
  date: string;
  /** The invoice date should be on or before this anchor. */
  strict: boolean;
}

/** Dates the invoice date should precede: packing list, shipment (on-board/ETD/flight), arrival. */
function anchors(ctx: ReconcileContext, inv: InvoiceSource): Anchor[] {
  const out: Anchor[] = [];
  for (const p of ctx.packingLists) if (isIsoDate(p.data.date)) out.push({ label: `packing list date ${p.data.date}`, date: p.data.date, strict: false });
  const t = ctx.transport;
  if (t?.kind === 'bl') {
    const d = t.src.data;
    if (isIsoDate(d.onBoardDate)) out.push({ label: `on-board date ${d.onBoardDate}`, date: d.onBoardDate, strict: true });
    else if (isIsoDate(d.issueDate)) out.push({ label: `B/L issue date ${d.issueDate}`, date: d.issueDate, strict: true });
  }
  if (t?.kind === 'awb' && isIsoDate(t.src.data.flightDate)) out.push({ label: `flight date ${t.src.data.flightDate}`, date: t.src.data.flightDate, strict: true });
  if (isIsoDate(inv.data.etd)) out.push({ label: `ETD ${inv.data.etd}`, date: inv.data.etd, strict: true });
  if (isIsoDate(inv.data.eta)) out.push({ label: `ETA ${inv.data.eta}`, date: inv.data.eta, strict: true });
  return out;
}

/**
 * Score a candidate: must not be after the shipment/arrival dates (invoices may follow the packing
 * list by a few days, so that bound is soft) and should be within a year before shipment.
 */
function score(candidate: string, as: Anchor[]): number {
  let s = 0;
  for (const a of as) {
    const d = daysBetween(candidate, a.date);
    if (d >= 0) s += a.strict ? 3 : 1;
    else if (a.strict && d >= -45) s += 0;
    else s -= a.strict ? 5 : 1;
    if (a.strict && d > 365) s -= 2;
  }
  return s;
}

function runInvoice(ctx: ReconcileContext, inv: InvoiceSource): Issue | undefined {
  const d = inv.data;
  let readings = numericDateReadings(d.invoiceDateRaw);
  if (!readings && d.invoiceDateAmbiguous && isIsoDate(d.invoiceDate) && d.invoiceDateAlternatives?.length) {
    // No raw text: the parser's best + alternative stand in for the two readings (order unknown).
    const [a, b] = [d.invoiceDate, d.invoiceDateAlternatives[0]];
    readings = { dayFirst: a, monthFirst: b };
  }
  if (!readings) return undefined;
  const { dayFirst, monthFirst } = readings;
  const as = anchors(ctx, inv);
  const sDay = score(dayFirst, as);
  const sMonth = score(monthFirst, as);
  const sellerCountry = d.seller?.country?.toUpperCase();
  const monthFirstCountry = !!sellerCountry && MONTH_FIRST_COUNTRIES.has(sellerCountry);

  let chosen: string;
  let how: string;
  let resolved = true;
  if (sDay !== sMonth) {
    chosen = sDay > sMonth ? dayFirst : monthFirst;
    how = `Chronology decides: the invoice must precede the ${as.map((a) => a.label).join(', ')}, which only ${chosen} does${sellerCountry ? ` (consistent with ${chosen === monthFirst ? 'month-first' : 'day-first'} dates${(chosen === monthFirst) === monthFirstCountry ? ` used in ${sellerCountry}` : ''})` : ''}.`;
  } else if (sellerCountry) {
    chosen = monthFirstCountry ? monthFirst : dayFirst;
    how = `The other documents' dates don't decide; the seller is in ${sellerCountry}, where numeric dates are written ${monthFirstCountry ? 'month-first' : 'day-first'}, so ${chosen} is used.`;
  } else {
    chosen = isIsoDate(d.invoiceDate) ? d.invoiceDate : dayFirst;
    how = `Neither the other documents' dates nor the seller's country decide; ${chosen} is assumed.`;
    resolved = false;
  }
  const other = chosen === dayFirst ? monthFirst : dayFirst;
  inv.invoice.invoiceDate = sourced(chosen, 'derived', inv.doc, ['invoiceDateRaw'], `"${d.invoiceDateRaw ?? d.invoiceDate}" is ambiguous; ${chosen} chosen (alternative ${other}).`);

  const evidence: Evidence[] = [evidenceFor(inv.doc, `Invoice Date: ${d.invoiceDateRaw ?? d.invoiceDate}`, 'invoiceDateRaw')];
  for (const p of ctx.packingLists) if (isIsoDate(p.data.date)) evidence.push(evidenceFor(p.doc, `Date: ${p.data.date}`, 'date'));
  if (ctx.transport?.kind === 'bl' && isIsoDate(ctx.transport.src.data.onBoardDate)) evidence.push(evidenceFor(ctx.transport.src.doc, `On board: ${ctx.transport.src.data.onBoardDate}`, 'onBoardDate'));

  return makeIssue({
    code: 'DATE_AMBIGUOUS',
    key: invoiceKey(ctx, inv),
    severity: resolved ? 'info' : 'warning',
    category: 'assumption',
    title: `Invoice date ${d.invoiceDateRaw ?? d.invoiceDate} read as ${chosen}`,
    detail: `"${d.invoiceDateRaw ?? d.invoiceDate}" can be read as ${dayFirst} (day/month) or ${monthFirst} (month/day). ${how}`,
    evidence,
    action: resolved ? `No action needed unless the seller confirms ${other}.` : 'Confirm the invoice date with the seller; it determines the exchange-rate and valuation references.',
    field: `invoices[${inv.index}].invoiceDate`,
  });
}

export const dateAmbiguousRule: Rule = {
  name: 'date-ambiguous',
  codes: ['DATE_AMBIGUOUS'],
  run: (ctx) => ctx.invoices.map((inv) => runInvoice(ctx, inv)).filter((i): i is Issue => !!i),
};
