import type { EntryEntity, EntryLineItem, EntryModel } from '@app/shared';

/**
 * Minimal NetCHB entry XML writer used ONLY by the demo mock (the real XML comes from the server's
 * netchb module). It emits the subset of entry.xsd the EntryModel covers, in XSD sequence order,
 * so the mock's "XSD-valid" badge is honest.
 */

const NS = 'http://www.netchb.com/xml/entry';

/** Escapes text for XML element content and attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class Writer {
  private out: string[] = [];
  private depth = 0;

  private pad() {
    return '  '.repeat(this.depth);
  }
  raw(line: string) {
    this.out.push(this.pad() + line);
  }
  open(name: string, attrs = '') {
    this.raw(`<${name}${attrs}>`);
    this.depth++;
  }
  close(name: string) {
    this.depth--;
    this.raw(`</${name}>`);
  }
  empty(name: string) {
    this.raw(`<${name}/>`);
  }
  /** Emits a leaf element; skips undefined/empty values so optional elements are omitted. */
  leaf(name: string, value: string | number | undefined | null) {
    if (value === undefined || value === null || value === '') return;
    this.raw(`<${name}>${escapeXml(String(value))}</${name}>`);
  }
  group(name: string, body: () => void) {
    this.open(name);
    body();
    this.close(name);
  }
  toString() {
    return this.out.join('\n');
  }
}

const whole = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));

function writeEntity(w: Writer, entity: EntryEntity) {
  w.group('entity', () => {
    w.leaf('entity-code', entity.entityCode);
    w.leaf('entity-name', entity.entityName?.slice(0, 35));
    w.group('entity-information', () => {
      if (entity.entityId) {
        w.leaf('entity-id', entity.entityId);
      } else if (entity.address) {
        const address = entity.address;
        w.group('entity-address', () => {
          w.group('address-components', () => {
            for (const component of address.addressComponents.slice(0, 6)) {
              w.group('address-component', () => {
                w.leaf('component-type', '15');
                w.leaf('address-information', component.slice(0, 35));
              });
            }
          });
          w.leaf('city', address.city);
          w.leaf('state-province-code', address.stateProvinceCode);
          w.leaf('postal-code', address.postalCode);
          w.leaf('country', address.country);
        });
      } else if (entity.sellingPartyMid) {
        w.leaf('selling-party-mid', entity.sellingPartyMid);
      }
    });
  });
}

function writeLineItem(w: Writer, item: EntryLineItem) {
  w.group('line-item', () => {
    w.leaf('export-date', item.exportDate);
    w.leaf('country-origin', item.countryOrigin);
    w.leaf('manufacturer-id', item.manufacturerId);
    w.leaf('related-party', item.relatedParty);
    w.group('tariffs', () => {
      for (const tariff of item.tariffs) {
        w.group('tariff', () => {
          w.leaf('tariff-no', tariff.tariffNo);
          w.leaf('value', whole(tariff.value));
          w.leaf('quantity1', tariff.quantity1);
          w.leaf('unit-of-measure1', tariff.unitOfMeasure1);
          w.leaf('quantity2', tariff.quantity2);
          w.leaf('unit-of-measure2', tariff.unitOfMeasure2);
          w.leaf('special-program', tariff.specialProgram);
          w.leaf('value-adjustment', tariff.valueAdjustment);
          w.leaf('adjustment-description', tariff.adjustmentDescription);
        });
      }
    });
    w.leaf('country-export', item.countryExport);
    w.leaf('lading-port', item.ladingPort);
    w.leaf('gross-weight', whole(item.grossWeight));
    w.leaf('commercial-description', item.commercialDescription?.slice(0, 70));
    w.leaf('invoice-quantity', item.invoiceQuantity);
    if (item.invoiceUnitValue === 'auto') {
      w.group('invoice-unit-value', () => w.empty('system-auto-calculate'));
    } else if (item.invoiceUnitValue !== undefined) {
      w.group('invoice-unit-value', () => w.leaf('user-specified', item.invoiceUnitValue as number));
    }
    w.leaf('po-number', item.poNumber);
    w.leaf('category-no', item.categoryNo);
  });
}

/** Serializes an EntryModel to NetCHB entry XML (demo subset, XSD order). */
export function buildMockEntryXml(model: EntryModel): string {
  const w = new Writer();
  const h = model.header;
  w.raw('<?xml version="1.0" encoding="UTF-8"?>');
  w.raw('<!-- Generated for broker review only; not transmitted to NetCHB or CBP. -->');
  w.open('entry', ` xmlns="${NS}"`);
  w.group('entry-no', () => {
    if (model.entryNo.kind === 'system') {
      w.empty('system-generated');
    } else {
      const { filerCode, entryNo } = model.entryNo;
      w.group('user-specified', () => {
        w.leaf('filer-code', filerCode);
        w.leaf('entry-no', entryNo);
      });
    }
  });
  w.leaf('external-reference-number', model.externalReferenceNumber);
  if (model.autoApplyRemedies) w.empty('auto-apply-remedies');
  w.group('header', () => {
    w.leaf('importer-tax-id', h.importerTaxId);
    w.leaf('importer-name', h.importerName);
    if (h.ultimateConsignee && (h.ultimateConsignee.taxId || h.ultimateConsignee.consigneeName)) {
      const uc = h.ultimateConsignee;
      w.group('ultimate-consignee', () => {
        w.leaf('tax-id', uc.taxId);
        w.leaf('consignee-name', uc.consigneeName);
      });
    }
    w.leaf('processing-port', h.processingPort);
    w.leaf('entry-port', h.entryPort);
    w.leaf('entry-date', h.entryDate);
    w.leaf('entry-type', h.entryType);
    w.leaf('bond-type', h.bondType);
    w.leaf('payment-type', h.paymentType);
    w.leaf('charges', whole(h.charges));
    w.leaf('gross-weight', whole(h.grossWeight));
    w.leaf('total-entry-value', whole(h.totalEntryValue));
    w.leaf('description', h.description?.slice(0, 70));
    w.leaf('surety-code', h.suretyCode);
    w.leaf('state-destination', h.stateDestination);
    w.leaf('vessel-name', h.vesselName);
    w.leaf('mode-transportation', h.modeTransportation);
    w.leaf('unlading-port', h.unladingPort);
    w.leaf('import-date', h.importDate);
    w.leaf('arrival-date', h.arrivalDate);
    w.leaf('carrier-code', h.carrierCode);
    w.leaf('broker-reference-no', h.brokerReferenceNo);
    w.leaf('customer-reference-no', h.customerReferenceNo);
    w.leaf('voyage-no', h.voyageNo);
    w.leaf('location-of-goods', h.locationOfGoods);
  });
  w.group('manifest', () => {
    for (const bill of model.manifest.billsOfLading) {
      w.group('bill-of-lading', () => {
        w.leaf('master-scac', bill.masterScac);
        w.leaf('master-bill', bill.masterBill);
        w.leaf('house-scac', bill.houseScac);
        w.leaf('house-bill', bill.houseBill);
        w.leaf('quantity', bill.quantity);
        w.leaf('unit', bill.unit);
      });
    }
  });
  if (model.containers.length > 0) {
    w.group('containers', () => {
      for (const c of model.containers) {
        w.group('container', () => {
          w.leaf('container-number', c.containerNumber);
          w.leaf('container-size', c.containerSize);
          w.leaf('container-type', c.containerType);
          w.leaf('seal-numbers', c.sealNumbers);
          w.leaf('po-number', c.poNumber);
          w.leaf('weight', c.weight);
          w.leaf('weight-unit', c.weightUnit);
          w.leaf('quantity', c.quantity);
          w.leaf('quantity-unit', c.quantityUnit);
        });
      }
    });
  }
  if (model.cargoReleaseParties.length > 0) {
    w.group('ace-cargo-release-parties', () => {
      for (const entity of model.cargoReleaseParties.slice(0, 5)) writeEntity(w, entity);
    });
  }
  w.group('invoices', () => {
    for (const invoice of model.invoices) {
      w.group('invoice', () => {
        w.leaf('invoice-no', invoice.invoiceNo);
        w.leaf('ultimate-consignee-tax-id', invoice.ultimateConsigneeTaxId);
        if (invoice.relatedParty) w.empty('related-party');
        if (invoice.foreignCurrency) {
          const fc = invoice.foreignCurrency;
          w.group('foreign-currency', () => {
            w.leaf('currency-code', fc.currencyCode);
            w.leaf('exchange-rate', fc.exchangeRate);
          });
        }
        w.group('line-items', () => {
          for (const item of invoice.lineItems) writeLineItem(w, item);
        });
      });
    }
  });
  w.close('entry');
  return w.toString() + '\n';
}

/** SOAP 1.1 rpc/literal request for EntryUploadService.uploadEntry, for display only. */
export function buildMockSoapEnvelope(entryXml: string): string {
  const body = entryXml.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/]]>/g, ']]]]><![CDATA[>');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:net="http://www.netchb.com/">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    '    <net:uploadEntry>',
    '      <username>YOUR_NETCHB_USERNAME</username>',
    '      <password>********</password>',
    `      <entryXml><![CDATA[${body.trimEnd()}]]></entryXml>`,
    '    </net:uploadEntry>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
    '',
  ].join('\n');
}
