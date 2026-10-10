/**
 * Enumerations and lexical patterns copied from the vendored NetCHB schemas
 * (schema/entry.xsd + schema/data_type.xsd). Kept in one place so assembly can
 * reject values the XSD would refuse before they ever reach the XML.
 */

/** entry.xsd bondType: 00 = no bond required, 08 = continuous, 09 = single transaction. */
export const BOND_TYPES = ['00', '08', '09'] as const;

/** Bond types that are secured by a surety (and therefore need a surety-code). */
export const BOND_TYPES_NEEDING_SURETY = ['08', '09'] as const;

/** data_type.xsd paymentType ('' is allowed by the XSD but means "not set"). */
export const PAYMENT_TYPES = ['1', '2', '3', '5', '6', '7', '8'] as const;

/** data_type.xsd entryType. */
export const ENTRY_TYPES = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '20', '21', '22', '23', '24', '25', '26',
  '30', '31', '32', '33', '34', '38', '40', '41', '42', '43', '44', '45', '46', '50', '51', '52', '60', '61', '62',
  '63', '64', '65', '66', '86',
] as const;

/** data_type.xsd modeTransportType (CBP mode-of-transport codes). */
export const MODE_TRANSPORT_CODES = [
  '10', '11', '12', '20', '21', '30', '31', '32', '33', '34', '40', '41', '50', '60', '70',
] as const;

/** entry.xsd containerType/container-size. */
export const CONTAINER_SIZES = ['20 ft', '20 ft HC', '40 ft', '40 ft HC', '45 ft', '45 ft HC', '53 ft', '53 ft HC'] as const;

/** entry.xsd containerType/container-type. */
export const CONTAINER_TYPES = ['Dry', 'Flat Rack', 'Headload', 'Open', 'Reefer', 'LCL', 'Tank'] as const;

/** entry.xsd entityType/entity-code. */
export const ENTITY_CODES = ['SE', 'BY', 'ST', 'LG', 'CS', 'MF', 'CN'] as const;

/** data_type.xsd unitOfMeasureType (CATAIR Appendix C subset accepted by NetCHB). */
export const UNITS_OF_MEASURE = new Set([
  'AC', 'ASTM', 'BBL', 'C', 'CAR', 'CC', 'CG', 'CGM', 'CKG', 'CLR', 'CM', 'CM2', 'CM3', 'CTN', 'CU', 'CUR', 'CY',
  'CYG', 'CYK', 'D', 'DC', 'DEG', 'DOZ', 'DPC', 'DPR', 'FIB', 'FBM', 'G', 'GBQ', 'GR', 'GRL', 'GVW', 'HUN', 'HZ',
  'IRC', 'JWL', 'K', 'KCAL', 'KG', 'KHZ', 'KL', 'KM', 'KM2', 'KM3', 'KN', 'KPA', 'KSB', 'KVA', 'KVAR', 'KW', 'KWH',
  'L', 'LIN', 'LNM', 'M', 'MBQ', 'MC', 'MG', 'MHZ', 'ML', 'MM', 'MPA', 'M2', 'M3', 'NO', 'ODE', 'PCS', 'PF', 'PFG',
  'PFL', 'PK', 'PRS', 'RPM', 'SBE', 'SQ', 'T', 'V', 'W', 'WG', 'WL', 'WT', 'X',
]);

/** data_type.xsd usStateType. */
export const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'FM', 'GU', 'MH', 'MP', 'PW',
  'PR', 'VI',
]);

/** Lexical patterns (XSD patterns are implicitly anchored; these are too). */
export const PATTERNS = {
  /** data_type.xsd taxIdType: EIN(+2 suffix) | CBP-assigned | SSN. */
  taxId: /^(?:\d{2}-\d{7}[\dA-Za-z]?[\dA-Za-z]?|\d{6}-\d{5}|\d{3}-\d{2}-\d{4})$/,
  invoiceNo: /^[A-Za-z\d-]{1,17}$/,
  billNo: /^[\dA-Za-z]{0,50}$/,
  /** data_type.xsd carrierCodeType: 2 or 4 word characters. */
  carrierCode: /^(?:\w{2}|\w{4})$/,
  port: /^\d{4}$/,
  foreignPort: /^\d{5}$/,
  country: /^[A-Za-z]{2}$/,
  tariffNo: /^\d{5,10}$/,
  categoryNo: /^\d{0,3}$/,
  currencyCode: /^[A-Z]{3}$/,
  isoDate: /^\d{4}-\d{2}-\d{2}$/,
  filerCode: /^[A-Za-z0-9]{3}$/,
  entryNo: /^\d{7,8}$/,
} as const;

/** Max lengths (xsd:maxLength) of the token elements we populate. */
export const MAX_LEN = {
  description: 70,
  vesselName: 20,
  brokerReferenceNo: 9,
  customerReferenceNo: 50,
  voyageNo: 5,
  locationOfGoods: 4,
  suretyCode: 3,
  manifestUnit: 5,
  manufacturerId: 15,
  entityName: 35,
  addressInformation: 35,
  city: 35,
  stateProvinceCode: 3,
  postalCode: 15,
  externalReferenceNumber: 100,
  /** Not limited by the XSD (xsd:string); 70 follows the ACE line description width (inferred). */
  commercialDescription: 70,
} as const;
