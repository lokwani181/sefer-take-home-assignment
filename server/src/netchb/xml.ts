/**
 * EntryModel → NetCHB entry XML.
 *
 * The root <entry> children are an xsd:sequence, so order matters there; the
 * header/invoice/line-item/tariff types are xsd:all but are still emitted in the
 * XSD's declaration order so the output reads like the schema. Undefined/empty
 * optionals are omitted, xsd:long fields are emitted as integers, and <transmit/>
 * is never emitted (entries are generated for broker review, not auto-filed).
 */
import type {
  BuildXmlFn,
  EntryBillOfLading,
  EntryContainer,
  EntryEntity,
  EntryHeader,
  EntryInvoice,
  EntryLineItem,
  EntryModel,
  EntryTariff,
} from '@app/shared';
import { round2 } from './normalize';

export const ENTRY_NAMESPACE = 'http://www.netchb.com/xml/entry';

/** Minimal element tree; `children: []` with no text renders as an empty tag. */
interface XNode {
  name: string;
  text?: string;
  children?: XNode[];
  attrs?: Record<string, string>;
}

type Child = XNode | undefined | null | false;

function el(name: string, ...children: Child[]): XNode | undefined {
  const kids = children.filter((c): c is XNode => !!c);
  return kids.length ? { name, children: kids } : undefined;
}

function flag(name: string, on: boolean | undefined): XNode | undefined {
  return on ? { name, children: [] } : undefined;
}

function text(name: string, value: string | undefined | null): XNode | undefined {
  if (value === undefined || value === null) return undefined;
  const v = String(value).replace(/\s+/g, ' ').trim();
  return v ? { name, text: v } : undefined;
}

/** xsd:long / xsd:integer: whole numbers only. */
function long(name: string, value: number | undefined): XNode | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return { name, text: String(Math.round(value)) };
}

/** decimal with ≤ 2 fraction digits (dollarAmountType / tariffQuantityType). */
function dec2(name: string, value: number | undefined): XNode | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return { name, text: formatNumber(round2(value), 2) };
}

/** xsd:double / xsd:float: plain decimal notation, no exponent. */
function dbl(name: string, value: number | undefined, maxDigits = 6): XNode | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return { name, text: formatNumber(value, maxDigits) };
}

function formatNumber(n: number, maxFractionDigits: number): string {
  const fixed = n.toFixed(maxFractionDigits);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Escapes character data (&, <, >) and drops characters XML 1.0 cannot carry. */
export function escapeText(s: string): string {
  return s.replace(INVALID_XML_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes an attribute value (character data plus both quote kinds). */
export function escapeXml(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function render(node: XNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const attrs = node.attrs
    ? Object.entries(node.attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join('')
    : '';
  if (node.text !== undefined) {
    out.push(`${pad}<${node.name}${attrs}>${escapeText(node.text)}</${node.name}>`);
  } else if (!node.children || node.children.length === 0) {
    out.push(`${pad}<${node.name}${attrs}/>`);
  } else {
    out.push(`${pad}<${node.name}${attrs}>`);
    for (const c of node.children) render(c, depth + 1, out);
    out.push(`${pad}</${node.name}>`);
  }
}

function entryNoNode(model: EntryModel): XNode {
  const e = model.entryNo;
  if (e.kind === 'user') {
    return {
      name: 'entry-no',
      children: [el('user-specified', text('filer-code', e.filerCode), text('entry-no', e.entryNo))!],
    };
  }
  return { name: 'entry-no', children: [{ name: 'system-generated', children: [] }] };
}

function headerNode(h: EntryHeader): XNode {
  return {
    name: 'header',
    children: [
      text('importer-tax-id', h.importerTaxId),
      text('importer-name', h.importerName),
      h.ultimateConsignee &&
        el('ultimate-consignee', text('tax-id', h.ultimateConsignee.taxId), text('consignee-name', h.ultimateConsignee.consigneeName)),
      text('processing-port', h.processingPort),
      text('entry-port', h.entryPort),
      text('entry-date', h.entryDate),
      text('entry-type', h.entryType),
      text('bond-type', h.bondType),
      text('payment-type', h.paymentType),
      long('charges', h.charges),
      long('gross-weight', h.grossWeight),
      h.totalEntryValue !== undefined && h.totalEntryValue >= 1 ? long('total-entry-value', h.totalEntryValue) : undefined,
      text('description', h.description),
      text('surety-code', h.suretyCode),
      text('state-destination', h.stateDestination),
      text('vessel-name', h.vesselName),
      text('mode-transportation', h.modeTransportation),
      text('unlading-port', h.unladingPort),
      text('import-date', h.importDate),
      text('arrival-date', h.arrivalDate),
      text('carrier-code', h.carrierCode),
      text('broker-reference-no', h.brokerReferenceNo),
      text('customer-reference-no', h.customerReferenceNo),
      text('voyage-no', h.voyageNo),
      text('location-of-goods', h.locationOfGoods),
    ].filter((c): c is XNode => !!c),
  };
}

function billNode(b: EntryBillOfLading): XNode {
  return el(
    'bill-of-lading',
    text('master-scac', b.masterScac),
    text('master-bill', b.masterBill),
    text('house-scac', b.houseScac),
    text('house-bill', b.houseBill),
    long('quantity', b.quantity),
    text('unit', b.unit),
  )!;
}

function containerNode(c: EntryContainer): XNode {
  return el(
    'container',
    text('container-number', c.containerNumber),
    text('container-size', c.containerSize),
    text('container-type', c.containerType),
    text('seal-numbers', c.sealNumbers),
    text('po-number', c.poNumber),
    dbl('weight', c.weight),
    text('weight-unit', c.weightUnit),
    dbl('quantity', c.quantity),
    text('quantity-unit', c.quantityUnit),
  )!;
}

function entityNode(e: EntryEntity): XNode | undefined {
  let info: XNode | undefined;
  if (e.entityId) info = el('entity-information', text('entity-id', e.entityId));
  else if (e.address) {
    const a = e.address;
    info = el(
      'entity-information',
      el(
        'entity-address',
        el(
          'address-components',
          ...a.addressComponents.map((line) =>
            el('address-component', text('component-type', '15'), text('address-information', line)),
          ),
        ),
        text('city', a.city),
        text('state-province-code', a.stateProvinceCode),
        text('postal-code', a.postalCode),
        text('country', a.country),
      ),
    );
  } else if (e.sellingPartyMid) info = el('entity-information', text('selling-party-mid', e.sellingPartyMid));
  if (!info) return undefined;
  return el('entity', text('entity-code', e.entityCode), text('entity-name', e.entityName), info);
}

function tariffNode(t: EntryTariff): XNode {
  return el(
    'tariff',
    text('tariff-no', t.tariffNo),
    long('value', t.value),
    dec2('duty', t.duty),
    dec2('quantity1', t.quantity1),
    t.quantity1 !== undefined ? text('unit-of-measure1', t.unitOfMeasure1) : undefined,
    dec2('quantity2', t.quantity2),
    t.quantity2 !== undefined ? text('unit-of-measure2', t.unitOfMeasure2) : undefined,
    text('special-program', t.specialProgram),
    long('value-adjustment', t.valueAdjustment),
    text('adjustment-description', t.adjustmentDescription),
  )!;
}

function lineItemNode(l: EntryLineItem): XNode {
  const unitValue =
    l.invoiceUnitValue === undefined
      ? undefined
      : l.invoiceUnitValue === 'auto'
        ? el('invoice-unit-value', { name: 'system-auto-calculate', children: [] })
        : el('invoice-unit-value', dbl('user-specified', l.invoiceUnitValue));
  return el(
    'line-item',
    text('export-date', l.exportDate),
    text('country-origin', l.countryOrigin),
    text('manufacturer-id', l.manufacturerId),
    text('related-party', l.relatedParty),
    { name: 'tariffs', children: l.tariffs.map(tariffNode) },
    text('country-export', l.countryExport),
    text('lading-port', l.ladingPort),
    long('gross-weight', l.grossWeight),
    text('commercial-description', l.commercialDescription),
    dbl('invoice-quantity', l.invoiceQuantity),
    unitValue,
    text('po-number', l.poNumber),
    text('category-no', l.categoryNo),
  )!;
}

/** Extra optional field we populate when known (proposed addition to EntryInvoice.foreignCurrency). */
type ForeignCurrencyExt = NonNullable<EntryInvoice['foreignCurrency']> & { currencyCountryCode?: string };

function invoiceNode(inv: EntryInvoice): XNode {
  const fc = inv.foreignCurrency as ForeignCurrencyExt | undefined;
  return el(
    'invoice',
    text('invoice-no', inv.invoiceNo),
    text('ultimate-consignee-tax-id', inv.ultimateConsigneeTaxId),
    flag('related-party', inv.relatedParty),
    fc &&
      el(
        'foreign-currency',
        text('currency-code', fc.currencyCode),
        dbl('exchange-rate', fc.exchangeRate, 6),
        text('currency-country-code', fc.currencyCountryCode),
      ),
    { name: 'line-items', children: inv.lineItems.map(lineItemNode) },
  )!;
}

/** Serializes an EntryModel to pretty-printed (2-space) NetCHB entry XML in XSD order. */
export const buildEntryXml: BuildXmlFn = (model: EntryModel): string => {
  const parties = model.cargoReleaseParties.slice(0, 5).map(entityNode).filter((n): n is XNode => !!n);
  const root: XNode = {
    name: 'entry',
    attrs: { xmlns: ENTRY_NAMESPACE },
    children: [
      entryNoNode(model),
      // NOTE: <transmit/> and <transmit-3461/> are deliberately never emitted.
      text('external-reference-number', model.externalReferenceNumber),
      flag('auto-apply-remedies', model.autoApplyRemedies),
      headerNode(model.header),
      { name: 'manifest', children: model.manifest.billsOfLading.map(billNode) },
      model.containers.length ? { name: 'containers', children: model.containers.map(containerNode) } : undefined,
      parties.length ? { name: 'ace-cargo-release-parties', children: parties } : undefined,
      { name: 'invoices', children: model.invoices.map(invoiceNode) },
    ].filter((c): c is XNode => !!c),
  };
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  render(root, 0, out);
  return out.join('\n') + '\n';
};
