/**
 * Air waybill parser (house or master). AWB forms are boxed like B/Ls; the AWB number is
 * a 3-digit airline prefix + 8-digit serial whose last digit is the serial mod 7.
 */
import type { AirWaybillData, FreightChargeLine } from '@app/shared';
import type { ParseContext } from '../context';
import type { PDoc } from '../layout';
import { findLabelValue } from '../labels';
import { findDates, parseDate } from '../dates';
import { findHsCodes, weightToKg } from '../domain/codes';
import { parseNumber } from '../numbers';
import { firstCode, labelText, partyBlock } from './common';
import { squash, trimSeparators } from '../text';

/** True when an 11-digit AWB number passes the mod-7 check on its serial. */
export function isValidAwb(n: string): boolean {
  const d = n.replace(/\D/g, '');
  if (d.length !== 11) return false;
  const serial = d.slice(3);
  return Number(serial.slice(0, 7)) % 7 === Number(serial[7]);
}

/** Finds AWB-shaped numbers ("176-12345675", "176 1234 5675"); valid ones first. */
export function findAwbNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{3})[-\s]?(\d{4})\s?(\d{4})\b/g)) {
    const n = `${m[1]}-${m[2]}${m[3]}`;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => Number(isValidAwb(b)) - Number(isValidAwb(a)));
}

/** Parses an air waybill. */
export function parseAirWaybill(doc: PDoc, ctx: ParseContext): AirWaybillData {
  const allText = doc.pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n');
  const mawbV = labelText(doc, 'awbNumber', { validate: (t) => /\d{3}[-\s]?\d{4}\s?\d{4}/.test(t) || /\d{6,}/.test(t) });
  const hawbV = labelText(doc, 'hawbNumber', { validate: (t) => /[A-Z0-9]{5,}/i.test(firstCode(t)) && /\d/.test(t) });
  const mawb = (mawbV && findAwbNumbers(mawbV.text)[0]) || findAwbNumbers(allText)[0];
  const hawb = hawbV ? firstCode(hawbV.text) : undefined;
  const isHouseTitle = /\bHOUSE\s+AIR\s*WAY\s*BILL\b|\bHAWB\b/i.test(allText);
  const awbType: AirWaybillData['awbType'] = hawb || isHouseTitle ? 'house' : mawb ? 'master' : 'unknown';
  const awbNumber = awbType === 'house' && hawb ? hawb : mawb ?? hawb ?? '';
  if (!awbNumber) ctx.warn('AWB number not found');
  if (mawb && !isValidAwb(mawb)) ctx.observe('low_confidence', `AWB number ${mawb} fails the mod-7 check digit.`, awbType === 'house' ? 'masterAwbNumber' : 'awbNumber');

  const shipper = partyBlock(doc, ['shipper', 'seller'])?.address;
  const consignee = partyBlock(doc, 'consignee')?.address;
  const notify = partyBlock(doc, 'notify')?.address;
  const opt = { mode: 'belowFirst' as const, validate: (t: string) => /[A-Za-z]{3,}/.test(t) };
  const dep = labelText(doc, 'airportOfDeparture', opt) ?? labelText(doc, 'portOfLoading', opt);
  const dest = labelText(doc, 'airportOfDestination', opt) ?? labelText(doc, 'portOfDischarge', opt);
  const carrier = labelText(doc, 'carrier', opt);
  const flightV = labelText(doc, 'flight', { mode: 'belowFirst', validate: (t) => /[A-Z0-9]{2}\s?\d{2,4}/i.test(t) });
  let flight: string | undefined;
  let flightDate: string | undefined;
  if (flightV) {
    const m = /\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{2,4}[A-Z]?)\b/.exec(flightV.text);
    if (m) flight = `${m[1]}${m[2]}`;
    flightDate = findDates(flightV.text)[0]?.iso;
  }
  flightDate ??= parseDate(labelText(doc, ['etd', 'date'], { validate: (t) => !!parseDate(t) })?.text ?? '')?.iso;

  const piecesV = labelText(doc, ['pieces', 'packages'], { mode: 'belowFirst', validate: (t) => /\d/.test(t) });
  const pieces = piecesV ? parseNumber((/\d[\d,]*/.exec(piecesV.text) ?? [''])[0])?.value : undefined;
  const gwV = findLabelValue(doc, 'grossWeight', { mode: 'belowFirst', maxLines: 2, validate: (t) => /\d/.test(t) });
  const gw = gwV ? parseNumber((/\d[\d,]*(?:\.\d+)?/.exec(gwV.text) ?? [''])[0]) : null;
  const cwV = labelText(doc, 'chargeableWeight', { mode: 'belowFirst', validate: (t) => /\d/.test(t) });
  const cw = cwV ? parseNumber((/\d[\d,]*(?:\.\d+)?/.exec(cwV.text) ?? [''])[0]) : null;
  const unitLb = (t?: string) => (t && /\bL(?:B|BS)?\b/.test(t) && !/\bKG/i.test(t) ? 'LBS' : undefined);

  const desc = findLabelValue(doc, 'description', { mode: 'block', maxLines: 12, validate: (t) => /[A-Za-z]{3,}/.test(t) });
  const charges: FreightChargeLine[] = [];
  if (/\b(?:FREIGHT\s+)?PREPAID\b|\bPP\b/.test(allText)) charges.push({ description: 'AIR FREIGHT', terms: 'prepaid' });
  else if (/\b(?:FREIGHT\s+)?COLLECT\b|\bCC\b/.test(allText)) charges.push({ description: 'AIR FREIGHT', terms: 'collect' });

  const data: AirWaybillData = {
    kind: 'air_waybill',
    awbNumber,
    awbType,
    goodsDescription: desc ? desc.lines.map(squash) : [],
    hsCodes: findHsCodes(allText).map((h) => h.code).filter((c, i, a) => a.indexOf(c) === i),
    charges,
  };
  if (awbType === 'house' && mawb) data.masterAwbNumber = mawb;
  const prefix = (mawb ?? '').slice(0, 3);
  if (/^\d{3}$/.test(prefix)) data.carrierCode = prefix;
  else if (flight) data.carrierCode = flight.slice(0, 2);
  if (carrier) data.carrierName = trimSeparators(carrier.text);
  if (shipper) data.shipper = shipper;
  if (consignee) data.consignee = consignee;
  if (notify) data.notifyParty = notify;
  if (dep) data.airportOfDeparture = dep.text;
  if (dest) data.airportOfDestination = dest.text;
  if (flight) data.flight = flight;
  // IATA airline designator = the flight number's 2-character prefix (must contain a letter: "LH", "5X").
  if (flight && /^(?=.*[A-Z])[A-Z0-9]{2}$/.test(flight.slice(0, 2))) data.carrierIata = flight.slice(0, 2);
  if (flightDate) data.flightDate = flightDate;
  if (pieces !== undefined) data.pieces = pieces;
  if (gw) data.grossWeightKg = weightToKg(gw.value, unitLb(gwV?.text));
  if (cw) data.chargeableWeightKg = weightToKg(cw.value, unitLb(cwV?.text));
  return data;
}
