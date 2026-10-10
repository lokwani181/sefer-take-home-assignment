/**
 * Synonym dictionaries. Everything that is wording-specific lives here so the parsers
 * stay generic: graders upload documents with different layouts and vocabulary.
 *
 * Synonyms are matched on compact keys (upper-case alphanumerics), so "Invoice No.:",
 * "INVOICE NO" and "Invoice No" are the same label. A "/" in a synonym also tolerates
 * OCR reading the slash as a letter ("BiL No." for "B/L No.").
 */

/** One box holding both the invoice number and its date (trade forms): a label of both fields. */
const INVOICE_NO_AND_DATE = ['invoice no & date', 'invoice no and date', 'invoice no / date', 'invoice number & date', 'invoice number and date', 'invoice no. & date', 'invoice no. and date'] as const;

/** Form labels (key/value fields and block headers). */
export const LABELS = {
  invoiceNumber: ['invoice no', 'invoice number', 'invoice #', 'invoice nr', 'inv no', 'inv #', 'inv number', 'commercial invoice no', 'commercial invoice number', 'proforma invoice no', 'invoice ref', 'inv ref', 'inv. ref.', 'invoice ref no', 'inv ref no', 'bill no', ...INVOICE_NO_AND_DATE],
  invoiceDate: ['invoice date', 'date of invoice', 'inv date', 'invoice dt', ...INVOICE_NO_AND_DATE],
  date: ['date', 'dated', 'issue date', 'date of issue', 'doc date', 'document date'],
  poNumber: ['your po', 'your p.o.', 'your order', 'your order no', 'customer order no', "buyer's p.o.", 'buyer p.o.', "buyer's po", 'buyer po', 'buyer order no', 'p.o. no', 'po no', 'po number', 'po #', 'p.o.', 'p.o. #', 'po', 'purchase order', 'purchase order no', 'purchase order number', 'customer po', 'customer p.o.', 'your order no', 'your ref', 'order no', 'order number', 'cust po'],
  factoryOrder: ['factory order', 'factory order no', 'production order', 'our order', 'sales order', 's/o no', 'so no'],
  currency: ['currency', 'curr', 'currency code', 'invoice currency'],
  incoterms: ['incoterms', 'incoterm', 'terms of delivery', 'delivery terms', 'trade terms', 'price terms', 'terms of sale', 'shipping terms', 'term of delivery', 'price basis', 'delivery term', 'inco terms'],
  shipVia: ['ship via', 'shipped via', 'mode of transport', 'transport mode', 'shipment by'],
  incotermPoint: ['f.o.b.', 'fob', 'f.o.b. point', 'fob point', 'c.i.f.', 'c&f', 'f.c.a.', 'ex works', 'ex-works'],
  paymentTerms: ['payment terms', 'terms of payment', 'payment term', 'payment', 'terms'],
  countryOfOrigin: ['country of origin', 'point and country of origin of goods', 'country of origin of goods', 'country of manufacture', 'origin of goods', 'origin', 'made in', 'coo', 'c/o', 'place of origin', 'ctry of origin'],
  portOfLoading: ['port of loading', 'port of lading', 'loading port', 'pol', 'port of shipment', 'place of loading', 'shipped from', 'from port', 'from', 'port of export', 'airport of departure', 'departure airport', 'airport of departure (addr. of first carrier) and requested routing'],
  portOfDischarge: ['port of discharge', 'discharge port', 'pod', 'port of destination', 'destination port', 'port of entry', 'port of unloading', 'to', 'to port', 'airport of destination', 'destination airport', 'port of arrival'],
  placeOfReceipt: ['place of receipt', 'place of receipt by pre-carrier', 'receipt'],
  placeOfDelivery: ['place of delivery', 'delivery place'],
  finalDestination: ['final destination', 'final destination (for merchant ref.)', 'final dest', 'destination'],
  preCarriage: ['pre-carriage by', 'pre carriage by', 'pre-carriage', 'precarriage by'],
  moveType: ['type of move', 'move type', 'service type', 'type of service'],
  vessel: ['vessel', 'ocean vessel', 'vessel/flight', 'feeder vessel / voy', 'vessel name', 'carrier vessel', 'mother vessel', 'feeder vessel', 'name of vessel', 'ship name', 'shipped per', 'per vessel', 'per s.s.', 'carrier / vessel'],
  voyage: ['voyage', 'voyage no', 'voy no', 'voy', 'voyage number'],
  vesselVoyage: ['ocean vessel / voy', 'ocean vessel / voyage', 'vessel / voy.', 'vessel & voy', 'vessel / voyage', 'vessel/voy', 'vessel / voy', 'ocean vessel / voy. no', 'ocean vessel voy no', 'vessel / voyage no', 'vessel & voyage', 'vessel and voyage', 'vessel voy', 'vessel/voyage no', 'vsl/voy'],
  flight: ['flight', 'flight no', 'flight number', 'flight/date', 'flight / date', 'requested flight/date', 'flight date'],
  etd: ['etd', 'sailing date', 'departure date', 'ship date', 'shipment date', 'date of shipment', 'shipping date', 'est. departure', 'estimated departure', 'sailing on or about'],
  eta: ['eta', 'arrival date', 'estimated arrival', 'est. arrival', 'eta date', 'estimated time of arrival', 'eta destination'],
  etdEta: ['etd / eta', 'etd/eta', 'etd - eta', 'etd & eta'],
  transportRef: ['b/l no', 'b/l number', 'b/l #', 'bl no', 'bill of lading no', 'bill of lading number', 'awb no', 'awb number', 'air waybill no', 'airway bill no', 'mawb no', 'hawb no', 'hbl no', 'mbl no', 'b/l', 'awb', 'bl number', 'transport document no', 'tracking no'],
  blNumber: ['b/l no', 'b/l number', 'b/l #', 'bl no', 'bl number', 'bill of lading no', 'bill of lading number', 'hbl no', 'house b/l no', 'house bill no', 'b/l no.', 'document no', 'waybill no', 'sea waybill no', 'swb no', 'h b/l no', 'hb/l no', 'bol no', 'bol number'],
  masterBl: ['master b/l no', 'master b/l', 'master bill', 'master bill of lading', 'mbl', 'mbl no', 'mb/l', 'mb/l no', 'ocean b/l no', 'carrier b/l no', 'master b/l no. / ocean carrier', 'master bl'],
  carrier: ['carrier', 'ocean carrier', 'shipping line', 'carrier name', 'issuing carrier', 'issuing carrier name', 'airline', 'by first carrier', 'steamship line'],
  scac: ['scac', 'scac code', 'carrier scac', 'scac no'],
  bookingNumber: ['booking no', 'booking number', 'booking ref', 'bkg no', 'booking', 'booking #'],
  exportReferences: ['export references', 'export reference', 'export ref', 'references', 'reference no', 'shipper ref', 'shipper reference', 'forwarder ref'],
  domesticRouting: ['domestic routing / export instructions', 'domestic routing', 'export instructions', 'routing'],
  containerNo: ['container no', 'container number', 'container #', 'cntr no', 'cntr', 'container', 'containers', 'ctnr no', 'cont no', 'container nos', 'equipment no', 'cntr#'],
  containerMarks: ['container no. / seal no. / marks & nos', 'container no / seal no', 'container / seal no', 'container no./seal no.', 'marks & nos', 'marks and numbers', 'marks and nos', 'container & seal', 'marks & numbers'],
  sealNo: ['seal no', 'seal', 'seal number', 'seal #', 'seal nos', 'seals'],
  packages: ['no. of pkgs', 'no of pkgs', 'number of packages', 'no. of packages', 'no of packages', 'packages', 'pkgs', 'no. of pkgs.', 'quantity and kind of packages', 'no. of ctns', 'no of cartons', 'total packages', 'number of pieces', 'no. of pieces', 'pieces', 'no of pieces', 'rcp', 'total cartons', 'total ctns'],
  grossWeight: ['gross weight', 'gross wt', 'g.w.', 'total gross weight', 'gross weight (kg)', 'gross weight kgs', 'gross', 'total g.w.', 'g.wt', 'weight', 'gross mass'],
  netWeight: ['net weight', 'net wt', 'n.w.', 'total net weight', 'total n.w.', 'net weight (kg)', 'n.wt'],
  chargeableWeight: ['chargeable weight', 'chargeable wt', 'charg. weight', 'chargeable'],
  measurement: ['measurement', 'meas', 'meas.', 'cbm', 'volume', 'total meas', 'total measurement', 'total volume', 'cubic meters', 'measurement (cbm)', 'total cbm', 'm3'],
  description: ['description of goods', 'description of packages and goods', 'description', 'goods description', 'nature and quantity of goods', 'nature and quantity of goods (incl. dimensions or volume)', 'commodity', 'kind of packages; description of goods', 'description of goods / merchandise', 'particulars'],
  hsCode: ['hs code', 'hs', 'hts', 'hts code', 'h.s. code', 'hs no', 'tariff code', 'commodity code', 'hs/hts'],
  seller: ['seller', 'shipper / exporter', 'shipper/exporter', 'exporter', 'shipper', 'vendor', 'supplier', 'seller / exporter', 'manufacturer / seller', 'sold by', 'consignor', "shipper's name and address", 'from (seller)', 'seller name and address', 'exporter name and address'],
  shipper: ['shipper', 'shipper / exporter', 'shipper/exporter', 'exporter', 'consignor', "shipper's name and address", 'shipper name and address', 'shipper (complete name and address)', 'shipper / exporter (complete name and address)'],
  buyer: ['sold to', 'bill to', 'sold to / bill to', 'bill to / sold to', 'buyer', 'invoice to', 'invoiced to', 'billed to', 'customer', 'importer', 'purchaser', 'messrs', 'to messrs', 'for account & risk of messrs', 'for account and risk of messrs', 'for account & risk of messers', 'for account and risk of', 'for account & risk of', 'accountee', 'importer of record', 'buyer (if other than consignee)', 'buyer / importer', 'importer / buyer'],
  shipTo: ['ship to', 'deliver to', 'ship to / deliver to', 'delivery address', 'delivered to', 'shipped to', 'ship-to', 'delivery to', 'consign to', 'deliver to address', 'final consignee', 'ultimate consignee', 'warehouse'],
  consignee: ['consignee', 'consignee / buyer', 'consignee/buyer', "consignee's name and address", 'consignee name and address', 'consignee (complete name and address)', 'consigned to', 'consignee (if order state notify party)', 'consignee / importer'],
  notify: ['notify party', 'notify', 'notify party (complete name and address)', "notify party's name and address", 'notify address', 'notify party 1'],
  alsoNotify: ['also notify', 'also notify party', 'second notify party', 'notify party 2', 'also notify:'],
  manufacturer: ['manufacturer', 'manufacturer name and address', 'manufactured by', 'factory', 'producer', 'maker', 'factory name', 'manufacturer / factory', 'mfr', 'mid', 'made by', 'goods made by', 'goods made & shipped by', 'goods made and shipped by', 'made & shipped by', 'made and shipped by', 'manufactured & shipped by', 'manufactured and shipped by'],
  plNumber: ['p/l no', 'packing list no', 'packing list number', 'pl no', 'packing no', 'packing list #', 'p/l #', 'packing list ref', 'pl number', 'packing slip no', 'delivery note no'],
  invoiceRef: ['ref. invoice', 'ref invoice', 'invoice ref', 'invoice no', 'invoice number', 'inv no', 'inv #', 'commercial invoice no', 'related invoice', 'invoice'],
  onBoardDate: ['shipped on board', 'shipped on board date', 'on board date', 'laden on board', 'date of shipment', 'on board', 'shipped on board the vessel', 'date laden on board'],
  issuePlaceDate: ['place and date of issue', 'place & date of issue', 'place of issue', 'date of issue', 'issued at', 'place and date of issue of b/l', 'executed on', 'executed at'],
  originals: ['number of original b/ls', 'no. of original b/ls', 'number of originals', 'no. of originals', 'no of original b/l', 'originals', 'number of original bills of lading', 'no. of original b/l'],
  freightPayableAt: ['freight payable at', 'payable at'],
  freightCharges: ['freight & charges', 'freight and charges', 'freight charges', 'charges', 'freight details'],
  shippingMarks: ['shipping marks', 'marks', 'marks & nos', 'marks and numbers', 'shipping mark', 'marks & numbers', 'n/m'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'additional information', 'special instructions', 'footnotes'],
  declaration: ['declaration', 'we hereby certify', 'we certify', 'certification', 'we declare'],
  bankDetails: ['bank details', 'bank', 'banking details', "beneficiary's bank", 'bank information', 'remit to', 'account no', 'a/c no', 'swift'],
  awbNumber: ['awb no', 'awb number', 'air waybill no', 'air waybill number', 'airway bill no', 'mawb no', 'mawb', 'master awb', 'awb'],
  hawbNumber: ['hawb no', 'hawb', 'house awb', 'house air waybill no', 'hawb number', 'house air waybill'],
  amsFiledBy: ['ams filed by', 'ams by'],
  isfFiledBy: ['isf filed by', 'isf by', 'isf 10+2 filed by'],
  /** Generic form labels that are not extracted but bound neighbouring values. */
  formLabel: [
    'amount of insurance', 'declared value for carriage', 'declared value for customs', 'decl. value for customs', 'handling information',
    'accounting information', "issuing carrier's agent name and city", "agent's iata code", 'account no', 'account number', 'reference number',
    'optional shipping information', 'rate class', 'rate / charge', 'nature and quantity of goods', 'other charges', 'total prepaid',
    'total collect', 'executed on', 'signature of shipper or his agent', 'customer no', 'kunden-nr', 'commodity item no', 'routing',
    'requested routing', 'currency', 'chgs code', 'wt/val', 'forwarding agent', 'forwarding agent references', 'also notify',
    'particulars furnished by shipper', 'for delivery of goods please apply to', 'delivery agent', 'service contract no', 'freight payable at',
    "shipper's account number", "consignee's account number", 'account information', 'not negotiable', 'issued by',
  ],
  totalQuantity: ['total quantity', 'total qty', 'total pcs', 'total pieces', 'total units'],
  airportOfDeparture: ['airport of departure', 'airport of departure (addr. of first carrier) and requested routing', 'departure airport', 'airport of loading', 'origin airport'],
  airportOfDestination: ['airport of destination', 'destination airport', 'airport of discharge', 'dest. airport'],
  pieces: ['no. of pieces rcp', 'no. of pieces', 'no of pieces', 'number of pieces', 'pieces', 'pcs', 'rcp', 'no. of pcs'],
} as const;

export type LabelField = keyof typeof LABELS;

/**
 * Single generic words that are labels only when clearly used as such (followed by a colon,
 * or standing alone in their cell). Inside content they are ordinary words ("DESTINATION CHGS").
 */
export const WEAK_LABEL_WORDS = new Set([
  'ORIGIN', 'DESTINATION', 'DATE', 'DATED', 'TERMS', 'PAYMENT', 'WEIGHT', 'GROSS', 'PACKAGES', 'PIECES', 'PKGS', 'MARKS',
  'RECEIPT', 'REFERENCES', 'ROUTING', 'FACTORY', 'BOOKING', 'CONTAINER', 'CONTAINERS', 'SEAL', 'SEALS', 'VESSEL', 'VOYAGE',
  'VOY', 'FLIGHT', 'CARRIER', 'DESCRIPTION', 'COMMODITY', 'PARTICULARS', 'REMARKS', 'REMARK', 'NOTES', 'NOTE', 'BANK',
  'FROM', 'TO', 'CNTR', 'CURRENCY', 'CURR', 'CUSTOMER', 'IMPORTER', 'MAKER', 'PRODUCER', 'MANUFACTURER', 'INVOICE', 'BUYER',
  'SUPPLIER', 'VENDOR', 'MEAS', 'VOLUME', 'CBM', 'M3', 'HS', 'HTS', 'PO', 'COO', 'SCAC', 'AWB', 'HAWB', 'MAWB', 'MBL',
  'POL', 'POD', 'ETD', 'ETA', 'AIRLINE', 'COMMENTS', 'BL', 'SWIFT', 'DECLARATION', 'CERTIFICATION', 'MID', 'MFR', 'ORIGINALS',
  'CHARGES', 'MESSRS', 'EXPORTER', 'CONSIGNOR', 'WAREHOUSE', 'MEASUREMENT', 'PREPAID', 'COLLECT',
]);

/** Table column headers. */
export const COLUMNS = {
  lineNo: ['no', 'item', 'line', 'line no', 'item no', 'sr no', 'sl no', 's/n', 'sno', '#', 'pos', 'seq', 'ln', 'nr', 'item #', 'sr', 'sl'],
  style: ['art.-nr.', 'art nr', 'artikel-nr', 'artikelnummer', 'artikel', 'item code no', 'style', 'style no', 'style #', 'style number', 'article', 'article no', 'art no', 'art #', 'art', 'item code', 'sku', 'part no', 'part number', 'part #', 'model', 'model no', 'product code', 'product no', 'ref no', 'reference', 'material no', 'item number', 'catalog no', 'cat no', 'code', 'style/ref', 'style code', 'article number', 'mat no'],
  description: ['description', 'description of goods', 'goods description', 'commodity', 'product description', 'item description', 'particulars', 'merchandise', 'goods', 'description of merchandise', 'product', 'commodity description', 'description of goods / merchandise', 'details', 'marks & description'],
  hsCode: ['hs code', 'hs', 'hts', 'hts code', 'hs no', 'tariff code', 'commodity code', 'hs/hts', 'h.s. code', 'customs code', 'tariff no', 'hts no', 'hs tariff', 'harmonized code', 'hts number', 'hs number', 'tariff', 'h.s.', 'hscode'],
  quantity: ['quantity', 'qty', "q'ty", 'pcs', 'pieces', 'units', 'total qty', 'total quantity', 'total pcs', 'total pieces', 'total units', 'no of pcs', 'quantity shipped', 'shipped qty', 'qty shipped', 'invoice qty', 'quantity (pcs)', 'qnty'],
  unit: ['unit', 'uom', 'u/m', 'unit of measure', 'um', 'units of measure', 'measure unit'],
  unitPrice: ['unit price', 'price', 'unit value', 'price/unit', 'rate', 'unit cost', 'price per unit', 'fob price', 'u/price', 'price each', 'each', 'cost', 'unit rate', 'fob unit price', 'price/pc', 'price per pc', 'unit fob', 'cif price', 'net price', 'u.price', 'unit price fob'],
  amount: ['amount', 'total', 'total amount', 'extended value', 'ext value', 'ext. value', 'extension', 'value', 'total value', 'line total', 'net amount', 'total price', 'fob amount', 'total fob', 'ext price', 'extended price', 'line value', 'sum', 'amount fob', 'total usd', 'total fob value', 'subtotal'],
  origin: ['origin', 'country of origin', 'coo', 'c/o', 'made in', 'orig', 'ctry of origin', 'origin country', 'country'],
  po: ['po', 'po no', 'po #', 'p.o.', 'p.o. no', 'purchase order', 'order no', 'order #', 'cust po'],
  colourSize: ['colour', 'color', 'colour / size', 'color / size', 'colour/size assortment', 'color/size assortment', 'colour / size assortment', 'size', 'sizes', 'assortment', 'size breakdown', 'size ratio', 'colorway', 'colour & size', 'size/colour', 'size/color', 'color size'],
  cartonRange: ['carton no', 'ctn no', 'c/no', 'c/nos', 'c/t no', 'c/t nos', 'c/t #', 'carton nos', 'ctn nos', 'carton number', 'carton range', 'ctn range', 'cartons no', 'box no', 'case no', 'pkg no', 'package no', 'ctn #', 'carton #', 'ctn. no', 'cartons nos', 'from - to', 'ctn from-to'],
  cartons: ['ctns', 'cartons', 'no of ctns', 'no. of cartons', 'no of cartons', 'ctn', 'carton', 'total ctns', 'total cartons', 'pkgs', 'packages', 'package', 'no of pkgs', 'boxes', 'cases', 'ctn qty', 'number of cartons', 'pkg', 'no. of pkgs', "ctns qty", 'packs', 'bales'],
  pcsPerCarton: ['pcs/ctn', 'pcs per ctn', 'qty/ctn', 'qty per ctn', 'units/ctn', 'pcs/carton', 'pcs per carton', 'qty per carton', 'inner qty', 'pack qty', 'pcs/box', 'units per carton', 'per ctn', 'pcs/ctns', 'qty/carton', 'pieces per carton', 'pcs/pkg', 'units/carton'],
  netWeightPerCarton: ['n.w./ctn', 'nw/ctn', 'n.w. per ctn', 'net wt/ctn', 'net weight per carton', 'nw per carton', 'n.w./carton', 'net wt per ctn', 'nw each', 'net weight/ctn', 'n.w. each', 'net/ctn', 'unit n.w.', 'nw per ctn'],
  grossWeightPerCarton: ['g.w./ctn', 'gw/ctn', 'g.w. per ctn', 'gross wt/ctn', 'gross weight per carton', 'gw per carton', 'g.w./carton', 'gross wt per ctn', 'gw each', 'gross weight/ctn', 'g.w. each', 'gross/ctn', 'unit g.w.', 'gw per ctn'],
  netWeight: ['total n.w.', 'n.w.', 'nw', 'net weight', 'net wt', 'total net weight', 'total nw', 'net', 'n.wt', 'net kgs', 'total net wt', 'net mass', 'nett weight', 'nett wt'],
  grossWeight: ['total g.w.', 'g.w.', 'gw', 'gross weight', 'gross wt', 'total gross weight', 'total gw', 'gross', 'g.wt', 'gross kgs', 'total gross wt', 'gross mass', 'weight'],
  dimensions: ['ctn meas', 'meas', 'measurement', 'dimensions', 'dimension', 'ctn size', 'carton size', 'carton dimensions', 'ctn dim', 'l x w x h', 'lxwxh', 'ctn measurement', 'carton measurement', 'ctn dimension', 'size of carton', 'meas.'],
  volume: ['cbm', 'm3', 'volume', 'cubic meters', 'total cbm', 'vol', 'cu.m', 'cubic metre'],
  /** Shipping marks printed beside the items: neither description nor package counts. */
  marks: ['marks', 'marks & numbers', 'marks and numbers', 'marks & nos', 'marks and nos', 'shipping marks', 'shipping mark', 'marks & numbers of pkgs', 'marks & no', 'mark & no', 'marks/nos'],
} as const;

export type ColumnField = keyof typeof COLUMNS;

/** Document titles by type, strongest phrases first. */
export const TITLES: Record<'commercial_invoice' | 'packing_list' | 'invoice_packing_list' | 'bill_of_lading' | 'air_waybill' | 'arrival_notice', string[]> = {
  invoice_packing_list: ['invoice and packing list', 'invoice & packing list', 'invoice / packing list', 'invoice/packing list', 'invoice cum packing list', 'invoice-cum-packing list', 'commercial invoice and packing list', 'commercial invoice & packing list', 'commercial invoice / packing list', 'invoice & packing slip', 'invoice and packing slip', 'packing list and invoice', 'packing list & invoice', 'packing list / invoice'],
  commercial_invoice: ['commercial invoice', 'invoice', 'proforma invoice', 'pro forma invoice', 'tax invoice', 'customs invoice', 'export invoice', 'sales invoice', 'factura comercial', 'rechnung', 'handelsrechnung', 'facture commerciale'],
  packing_list: ['packing list', 'packing slip', 'packing / weight list', 'packing and weight list', 'weight list', 'packinglist', 'packing specification', 'packliste', 'delivery note'],
  bill_of_lading: ['bill of lading', 'house bill of lading', 'master bill of lading', 'ocean bill of lading', 'combined transport bill of lading', 'sea waybill', 'sea way bill', 'non-negotiable sea waybill', 'multimodal transport bill of lading', 'house b/l', 'b/l', 'express bill of lading', 'through bill of lading', 'bill of lading for combined transport'],
  air_waybill: ['air waybill', 'airway bill', 'air way bill', 'house air waybill', 'master air waybill', 'air consignment note', 'hawb', 'mawb'],
  arrival_notice: ['arrival notice', 'notice of arrival', 'cargo arrival notice', 'arrival notification', 'freight arrival notice'],
};

/** Body keywords that indicate a document type when the title is missing or garbled. */
export const CONTENT_SIGNALS: Record<'commercial_invoice' | 'packing_list' | 'bill_of_lading' | 'air_waybill' | 'arrival_notice', string[]> = {
  commercial_invoice: ['unit price', 'amount', 'invoice no', 'incoterms', 'payment terms', 'total amount', 'total value', 'currency', 'sold to', 'bill to', 'say us dollars', 'total fob', 'unit value', 'beneficiary', 'swift'],
  packing_list: ['n.w.', 'g.w.', 'net weight', 'gross weight', 'ctns', 'cartons', 'carton no', 'pcs/ctn', 'meas', 'cbm', 'total cartons', 'packing'],
  bill_of_lading: ['shipper', 'consignee', 'notify party', 'port of loading', 'port of discharge', 'place of receipt', 'place of delivery', 'ocean vessel', 'freight prepaid', 'freight collect', 'number of original', 'shipped on board', 'pre-carriage', 'particulars furnished by shipper', 'scac', 'said to contain', 'shipper\'s load'],
  air_waybill: ['airport of departure', 'airport of destination', 'chargeable weight', 'rate class', 'issuing carrier', 'iata', 'flight', 'handling information', 'declared value for carriage', 'declared value for customs', 'accounting information', 'commodity item no'],
  arrival_notice: ['arrival notice', 'eta', 'free time', 'last free day', 'available', 'pick up', 'pickup', 'it number', 'firms', 'cargo location', 'storage'],
};

/** Lines that end the body of an item table. */
export const TABLE_STOP_RE = /^(?:GRAND\s*TOTALS?|TOTALS?\b|SUB[\s-]?TOTALS?|SAY\b|CONTINUED|CARRIED\s+FORWARD|TOTAL\s+AMOUNT|NOTES?\s*:|REMARKS?\s*:|DECLARATION|SHIPPING\s+MARKS|BANK\s+DETAILS|AMOUNT\s+IN\s+WORDS)/i;
/** Line-internal phrases that also end a table page. */
export const TABLE_STOP_ANY_RE = /\b(?:GRAND\s+TOTAL|SUB[\s-]?TOTAL|CARRIED\s+FORWARD|CONTINUED\s+ON|GOODS\s+VALUE|INVOICE\s+(?:TOTAL|VALUE|AMOUNT)|TOTAL\s+(?:AMOUNT|VALUE|INVOICE|DUE)|AMOUNT\s+DUE|BALANCE\s+DUE|NET\s+TOTAL|TOTAL\s+(?:FOB|CIF|CFR|EXW|FCA|DDP|DAP)\b)/i;
/** Lines that repeat a previous page's subtotal at the top of a continuation page. */
export const BROUGHT_FORWARD_RE = /\b(?:BROUGHT\s+FORWARD|B\/F|BALANCE\s+FORWARD|CARRIED\s+OVER\s+FROM)\b/i;

/** Charge keywords (invoice totals area) → ChargeType. Order matters: first match wins. */
export const CHARGE_KEYWORDS: Array<[RegExp, import('@app/shared').ChargeType]> = [
  [/\b(?:INLAND|ORIGIN|PRE[-\s]?CARRIAGE|LOCAL)\b.*\bFREIGHT\b|\bFREIGHT\b.*\bORIGIN\b|\bTRUCKING\b.*\bORIGIN\b/i, 'inland_freight_foreign'],
  [/\bINSURANCE\b/i, 'insurance'],
  [/\b(?:DUTY|DUTIES|TARIFFS?|CUSTOMS\s+(?:CLEARANCE|FEES?)|IMPORT\s+TAX(?:ES)?|VAT)\b/i, 'duty'],
  [/\b(?:US|U\.S\.|DOMESTIC|DESTINATION|ON[-\s]?CARRIAGE|INLAND|LAST\s+MILE)\b.*\b(?:FREIGHT|DELIVERY|TRUCKING|DRAYAGE|HAULAGE)\b|\bDELIVERY\s+(?:TO|CHARGES?|FEE)\b/i, 'inland_freight_us'],
  [/\bFREIGHT\b|\bSHIPPING\b|\bS\s*&\s*H\b|\bPOSTAGE\b|\bCARRIAGE\b|\bAIR\s+FREIGHT\b|\bCOURIER\b/i, 'freight'],
  [/\bPACKING\b|\bPACKAGING\b/i, 'packing'],
  [/\bCOMMISSION\b/i, 'commission'],
  [/\bDISCOUNT\b|\bREBATE\b|\bALLOWANCE\b/i, 'discount'],
  [/\bHANDLING\b|\bTHC\b|\bDOCUMENTATION\b|\bDOC(?:UMENT)?\s+FEE\b|\bBANK\s+CHARGES?\b/i, 'handling'],
];

/** Phrases that mark a line as free of charge / no commercial value. */
export const NCV_RE = /\b(?:F\.?O\.?C\.?|N\.?C\.?V\.?|NO\s+COMMERCIAL\s+VALUE|FREE\s+OF\s+CHARGE|WITHOUT\s+(?:COMMERCIAL\s+)?VALUE|NO\s+CHARGE|NOT\s+FOR\s+(?:RE)?SALE|VALUE\s+FOR\s+CUSTOMS\s+(?:PURPOSES?\s+)?ONLY|FOR\s+CUSTOMS\s+PURPOSES?\s+ONLY|SAMPLES?\s+(?:OF\s+)?NO\s+VALUE)\b/i;

/** Phrases that announce an assist (buyer-supplied materials/tooling). */
export const ASSIST_RE = /\b(?:SUPPLIED|PROVIDED|FURNISHED|CONSIGNED|SENT)\s+(?:FREE\s+OF\s+CHARGE\s+)?(?:BY\s+(?:THE\s+)?(?:BUYER|CUSTOMER|IMPORTER|PURCHASER|CONSIGNEE))|\bBUYER[-\s](?:SUPPLIED|PROVIDED|FURNISHED)\b|\bFREE\s+OF\s+CHARGE\s+BY\s+(?:THE\s+)?BUYER\b|\bASSISTS?\b|\bCUSTOMER[-\s](?:SUPPLIED|PROVIDED|OWNED)\b/i;
