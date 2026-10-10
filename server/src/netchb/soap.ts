/**
 * SOAP 1.1 preview of the NetCHB EntryUploadService.uploadEntry call.
 *
 * The WSDL (schema/EntryUploadService.wsdl) binds uploadEntry as rpc/literal in
 * namespace http://www.netchb.com/ with three string parts: username, password,
 * entryXml. The entry XML therefore travels as an escaped string. This is for
 * display only: the app never sends it and never holds credentials, so the
 * credentials are literal '{username}' / '{password}' placeholders.
 */
import { escapeText } from './xml';

export const NETCHB_SOAP_ENDPOINT = 'https://www.netchb.com:443/main/services/entry/EntryUploadService';
export const NETCHB_SOAP_NAMESPACE = 'http://www.netchb.com/';

/** Wraps entry XML in an uploadEntry SOAP envelope with credential placeholders. */
export function buildUploadEnvelope(xml: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- POST ${NETCHB_SOAP_ENDPOINT}  (Content-Type: text/xml; charset=utf-8, SOAPAction: "") -->`,
    '<!-- Preview only: this app does not transmit entries to NetCHB. -->',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:net="http://www.netchb.com/">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    '    <net:uploadEntry>',
    '      <username>{username}</username>',
    '      <password>{password}</password>',
    `      <entryXml>${escapeText(xml)}</entryXml>`,
    '    </net:uploadEntry>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
    '',
  ].join('\n');
}
