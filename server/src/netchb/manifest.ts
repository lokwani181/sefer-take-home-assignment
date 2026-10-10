/**
 * Manifest (bills of lading) and containers sections of the entry.
 */
import type { EntryBillOfLading, EntryContainer, Shipment } from '@app/shared';
import { PATTERNS } from './enums';
import { IssueBag, makeIssue } from './issues';
import { mapContainerSizeType, normalizeBillNo, normalizePackageUnit } from './normalize';

/** Removes a leading SCAC from a bill number ("MSCU123456789" → "123456789") when the SCAC is known. */
function stripScac(number: string, scac: string | undefined): string {
  if (!scac) return number;
  const n = number.toUpperCase();
  return n.startsWith(scac.toUpperCase()) && n.length - scac.length >= 6 ? number.slice(scac.length) : number;
}

function scacOrUndefined(scac: string | undefined): string | undefined {
  const s = (scac ?? '').trim().toUpperCase();
  return PATTERNS.carrierCode.test(s) ? s : undefined;
}

/**
 * One bill-of-lading element per shipment bill: master/house SCAC + bill number
 * (alphanumeric, SCAC prefix removed) and the package count/unit from the
 * transport document.
 */
export function buildBills(shipment: Shipment, bag: IssueBag): EntryBillOfLading[] {
  const pkgs = shipment.packages?.value;
  const cartonsFromLines = shipment.invoices.flatMap((i) => i.lines).reduce((s, l) => s + (l.cartons ?? 0), 0);
  const quantity = pkgs?.count !== undefined ? Math.round(pkgs.count) : cartonsFromLines > 0 ? cartonsFromLines : undefined;
  const unit = normalizePackageUnit(pkgs?.unit ?? (cartonsFromLines > 0 ? 'CTN' : undefined));
  if (quantity === undefined && shipment.bills.length) {
    bag.add(
      makeIssue(
        'MANIFEST_QUANTITY_UNKNOWN',
        undefined,
        'blocker',
        'missing_data',
        'Manifest package count unknown',
        'No package count was found on the transport document, invoice or packing list. The bill-of-lading quantity is required by NetCHB; 0 is used as a placeholder.',
        'Enter the B/L package count and unit (from the B/L or arrival notice) before uploading.',
        { field: 'manifest.billsOfLading[0].quantity' },
      ),
    );
  }

  return shipment.bills.map((b, i) => {
    const out: EntryBillOfLading = { quantity: quantity ?? 0, unit };
    for (const kind of ['master', 'house'] as const) {
      const ref = b[kind];
      if (!ref) continue;
      const scac = scacOrUndefined(ref.scac);
      const raw = ref.number ?? '';
      const stripped = stripScac(raw, scac);
      const norm = normalizeBillNo(stripped);
      if (norm.value && (norm.changed || stripped !== raw)) {
        bag.add(
          makeIssue(
            'BILL_NO_NORMALIZED',
            `${kind}:${norm.value}`,
            'info',
            'format',
            `${kind === 'master' ? 'Master' : 'House'} bill number normalized: ${raw} → ${norm.value}`,
            `NetCHB bill numbers are alphanumeric only (billNoType) and are sent without the carrier SCAC${
              scac ? ` (${scac}, sent separately as ${kind}-scac)` : ''
            }.`,
            'No action unless the normalized number differs from the bill as filed in AMS.',
            { field: `manifest.billsOfLading[${i}].${kind}Bill` },
          ),
        );
      }
      if (kind === 'master') {
        out.masterScac = scac;
        out.masterBill = norm.value || undefined;
      } else {
        out.houseScac = scac;
        out.houseBill = norm.value || undefined;
      }
    }
    return out;
  });
}

/** Containers with XSD-enumerated size/type when the printed code is recognised. */
export function buildContainers(shipment: Shipment): EntryContainer[] {
  return shipment.containers
    .filter((c) => c.number)
    .map((c) => {
      const { size, type } = mapContainerSizeType(c.sizeType);
      const seals = c.sealNumbers.map((s) => s.trim()).filter(Boolean);
      return {
        containerNumber: c.number.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        containerSize: size,
        containerType: type,
        sealNumbers: seals.length ? seals.join(', ') : undefined,
      };
    });
}
