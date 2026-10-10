import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import type { EntryModel } from '@app/shared';
import { assembleEntry, buildEntryXml, buildUploadEnvelope, validateEntryXml } from '../../src/netchb';
import { validateEntryXmlWithSystemXmllint } from '../../src/netchb/validate';
import { sampleAltClassifications, sampleClassifications, sampleIssues, sampleShipment, stubLookups } from './fixtures/sample';

function sampleModel(brokerInputs = {}): EntryModel {
  return assembleEntry({
    shipment: sampleShipment(),
    classifications: sampleClassifications(),
    altClassifications: sampleAltClassifications(),
    brokerInputs,
    issues: sampleIssues(),
    lookups: stubLookups(),
  }).entryModel;
}

const FULL_INPUTS = {
  importerTaxId: '93-1234567',
  bondType: '08',
  suretyCode: '036',
  locationOfGoods: 'W123',
  paymentType: '7',
  brokerReference: 'B123',
};

type Ordered = Record<string, unknown> & { ':@'?: Record<string, string> };
const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: true });
const plain = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

/** Tag name of a preserveOrder node. */
const tagOf = (n: Ordered): string => Object.keys(n).find((k) => k !== ':@')!;
/** Children of the first node named `name` under `nodes`. */
function childrenOf(nodes: Ordered[], name: string): Ordered[] {
  const n = nodes.find((x) => tagOf(x) === name);
  if (!n) throw new Error(`no <${name}>`);
  return n[name] as Ordered[];
}
const names = (nodes: Ordered[]): string[] => nodes.map(tagOf).filter((t) => t !== '#text');

/** Element declaration order in the XSD for a complex type's direct children (by scanning entry.xsd). */
const xsd = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'netchb', 'schema', 'entry.xsd'), 'utf8');
function isSubsequence(sub: string[], seq: string[]): boolean {
  let i = 0;
  for (const s of seq) if (s === sub[i]) i++;
  return i === sub.length;
}
function declaredOrder(startMarker: string, endMarker: string): string[] {
  const start = xsd.indexOf(startMarker);
  const end = xsd.indexOf(endMarker, start);
  const block = xsd.slice(start, end);
  return [...block.matchAll(/<xsd:element name="([^"]+)"/g)].map((m) => m[1]);
}

describe('buildEntryXml', () => {
  const model = sampleModel(FULL_INPUTS);
  const xml = buildEntryXml(model);

  it('the sample entry validates against entry.xsd (xmllint-wasm)', async () => {
    const r = await validateEntryXml(xml);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('also validates with the system xmllint fallback', async () => {
    const r = await validateEntryXmlWithSystemXmllint(xml);
    expect(r).toEqual({ valid: true, errors: [] });
  });

  it('the model without broker inputs also validates (missing optionals are omitted)', async () => {
    expect((await validateEntryXml(buildEntryXml(sampleModel()))).valid).toBe(true);
  });

  it('declares the NetCHB namespace, is pretty-printed with 2 spaces, and has an XML declaration', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<entry xmlns="http://www.netchb.com/xml/entry">\n  <entry-no>')).toBe(true);
    expect(xml).toMatch(/\n {4}<system-generated\/>\n/);
    expect(xml).toMatch(/\n {4}<importer-tax-id>93-1234567<\/importer-tax-id>/);
  });

  it('root children appear in xsd:sequence order', () => {
    const doc = ordered.parse(xml) as Ordered[];
    const root = childrenOf(doc, 'entry');
    expect(names(root)).toEqual(['entry-no', 'auto-apply-remedies', 'header', 'manifest', 'containers', 'ace-cargo-release-parties', 'invoices']);
    const rootOrder = declaredOrder('<xsd:element name="entry">', '<xsd:attribute name="schemaLocation"');
    expect(isSubsequence(names(root), rootOrder)).toBe(true);
  });

  it('header, bill, container, line-item and tariff children follow the XSD declaration order', () => {
    const doc = ordered.parse(xml) as Ordered[];
    const root = childrenOf(doc, 'entry');
    const header = names(childrenOf(root, 'header'));
    expect(header.slice(0, 7)).toEqual(['importer-tax-id', 'importer-name', 'ultimate-consignee', 'processing-port', 'entry-port', 'entry-date', 'entry-type']);
    expect(isSubsequence(header, declaredOrder('<xsd:complexType name="headerType">', '<xsd:complexType name="consolidatedEntryType">'))).toBe(true);

    const bill = names(childrenOf(childrenOf(root, 'manifest'), 'bill-of-lading'));
    expect(bill).toEqual(['master-scac', 'master-bill', 'house-scac', 'house-bill', 'quantity', 'unit']);

    const container = names(childrenOf(childrenOf(root, 'containers'), 'container'));
    expect(isSubsequence(container, declaredOrder('<xsd:complexType name="containerType">', '</xsd:complexType>'))).toBe(true);

    const invoice = childrenOf(childrenOf(root, 'invoices'), 'invoice');
    const lineItem = childrenOf(childrenOf(invoice, 'line-items'), 'line-item');
    const lineOrder = declaredOrder('<xsd:complexType name="lineItemType">', '<xsd:complexType name="tariffType">');
    expect(isSubsequence(names(lineItem), lineOrder)).toBe(true);
    const tariff = names(childrenOf(childrenOf(lineItem, 'tariffs'), 'tariff'));
    expect(tariff).toEqual(['tariff-no', 'value', 'quantity1', 'unit-of-measure1', 'quantity2', 'unit-of-measure2']);
  });

  it('emits whole numbers for xsd:long fields and ≤ 2 decimals for quantities', () => {
    const doc = plain.parse(xml);
    const h = doc.entry.header;
    expect(h.charges).toBe('4035');
    expect(h['gross-weight']).toBe('1930');
    expect(h['total-entry-value']).toBe('27439');
    const items = doc.entry.invoices.invoice['line-items']['line-item'];
    expect(items[1].tariffs.tariff.value).toBe('8880');
    expect(items[1].tariffs.tariff.quantity2).toBe('715.4');
    expect(items[4].tariffs.tariff.quantity2).toBe('5.1');
  });

  it('never emits <transmit/> and uses system-generated entry numbers', () => {
    expect(xml).not.toMatch(/<transmit/);
    expect(xml).toContain('<system-generated/>');
    expect(xml).toContain('<auto-apply-remedies/>');
  });

  it('omits auto-apply-remedies when disabled and supports a user-specified entry number', async () => {
    const m = sampleModel({ ...FULL_INPUTS, autoApplyRemedies: false });
    m.entryNo = { kind: 'user', filerCode: 'ABC', entryNo: '1234567' };
    const x = buildEntryXml(m);
    expect(x).not.toContain('auto-apply-remedies');
    expect(x).toContain('<user-specified>\n      <filer-code>ABC</filer-code>\n      <entry-no>1234567</entry-no>\n    </user-specified>');
    expect((await validateEntryXml(x)).valid).toBe(true);
  });

  it('escapes special characters and the escaped XML still validates and round-trips', async () => {
    const m = sampleModel(FULL_INPUTS);
    m.header.description = 'TOOLS & PARTS <SET> "A"';
    m.invoices[0].lineItems[0].commercialDescription = 'R&D <PROTO> 5" PIPE & TEE';
    m.header.importerName = 'Smith & Sons <Imports>';
    const x = buildEntryXml(m);
    expect(x).toContain('<description>TOOLS &amp; PARTS &lt;SET&gt; "A"</description>');
    expect(x).toContain('R&amp;D &lt;PROTO&gt; 5" PIPE &amp; TEE');
    expect(x).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect((await validateEntryXml(x)).valid).toBe(true);
    const back = new XMLParser({ processEntities: true, htmlEntities: false, parseTagValue: false }).parse(x);
    expect(back.entry.header['importer-name']).toBe('Smith & Sons <Imports>');
  });

  it('omits undefined and empty optionals instead of emitting empty tags', () => {
    const m = sampleModel();
    expect(m.header.importerTaxId).toBeUndefined();
    const x = buildEntryXml(m);
    expect(x).not.toContain('<importer-tax-id');
    expect(x).not.toContain('<bond-type');
    expect(x).not.toContain('<lading-port');
    expect(x).not.toMatch(/<([a-z-]+)><\/\1>/);
  });
});

describe('validateEntryXml', () => {
  const xml = buildEntryXml(sampleModel(FULL_INPUTS));

  it('fails a deliberately mis-ordered entry (manifest before header) with a line number', async () => {
    const doc = xml.split('\n');
    const hs = doc.findIndex((l) => l === '  <header>');
    const he = doc.findIndex((l) => l === '  </header>');
    const ms = doc.findIndex((l) => l === '  <manifest>');
    const me = doc.findIndex((l) => l === '  </manifest>');
    const swapped = [...doc.slice(0, hs), ...doc.slice(ms, me + 1), ...doc.slice(hs, he + 1), ...doc.slice(me + 1)].join('\n');
    const r = await validateEntryXml(swapped);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/^Line \d+: .*manifest/);
    const sys = await validateEntryXmlWithSystemXmllint(swapped);
    expect(sys.valid).toBe(false);
  });

  it('reports enumeration and pattern violations', async () => {
    const bad = xml.replace('<entry-type>01</entry-type>', '<entry-type>99</entry-type>').replace('<invoice-no>KBAS-NB-26-0912</invoice-no>', '<invoice-no>KBAS/NB/26-0912</invoice-no>');
    const r = await validateEntryXml(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entry-type/.test(e))).toBe(true);
    expect(r.errors.some((e) => /invoice-no/.test(e))).toBe(true);
  });

  it('rejects an emitted <transmit/> placed out of order and malformed XML', async () => {
    const r = await validateEntryXml(xml.replace('<auto-apply-remedies/>', '<auto-apply-remedies/>\n  <transmit/>'));
    expect(r.valid).toBe(false);
    const broken = await validateEntryXml('<entry xmlns="http://www.netchb.com/xml/entry"><entry-no>');
    expect(broken.valid).toBe(false);
    expect(broken.errors[0]).toMatch(/^Line \d+:/);
  });
});

describe('buildUploadEnvelope', () => {
  const xml = buildEntryXml(sampleModel(FULL_INPUTS));
  const env = buildUploadEnvelope(xml);

  it('is a SOAP 1.1 rpc uploadEntry call with credential placeholders', () => {
    expect(env).toContain('xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(env).toContain('<net:uploadEntry>');
    expect(env).toContain('<username>{username}</username>');
    expect(env).toContain('<password>{password}</password>');
    expect(env).toContain('&lt;entry xmlns="http://www.netchb.com/xml/entry"&gt;');
  });

  it('carries the entry XML as an escaped string that unescapes to the original', () => {
    const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, processEntities: true, htmlEntities: false }).parse(env);
    const body = doc['soapenv:Envelope']['soapenv:Body']['net:uploadEntry'];
    expect(body.entryXml).toBe(xml);
  });
});
