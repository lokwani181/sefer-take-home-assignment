import type { PipelineResult } from '@app/shared';
import { countBySeverity } from '../lib/issues';
import { formatUsd } from '../lib/format';
import { XsdBadge } from './Badges';

/** The invoice number the entry is filed under (normalized), falling back to the printed one. */
export function invoiceNumberOf(result: PipelineResult): string | undefined {
  return result.entryModel.invoices[0]?.invoiceNo ?? result.shipment.invoices[0]?.invoiceNumber.value;
}

export function lineCountOf(result: PipelineResult): number {
  return result.entryModel.invoices.reduce((n, inv) => n + inv.lineItems.length, 0);
}

/** One-glance summary of the generated entry: identity, value, validity and how much work is left. */
export function SummaryStrip({ result }: { result: PipelineResult }) {
  const h = result.entryModel.header;
  const counts = countBySeverity(result.issues);
  const importer = h.importerName ?? result.shipment.importer?.value.name;
  const totalValue = h.totalEntryValue ?? result.valuations.reduce((sum, v) => sum + v.enteredValue, 0);
  // Only label the port with the document text when the code was derived from it (not overridden).
  const portText = h.entryPort === h.unladingPort ? result.shipment.transport.portOfUnlading : undefined;

  return (
    <section className="summary" aria-label="Entry summary">
      <dl className="summary-grid">
        <div>
          <dt>Invoice no.</dt>
          <dd className="mono">{invoiceNumberOf(result) ?? '—'}</dd>
        </div>
        <div>
          <dt>Importer</dt>
          <dd>{importer ?? '—'}</dd>
        </div>
        <div>
          <dt>Entry type</dt>
          <dd className="mono">{h.entryType}</dd>
        </div>
        <div>
          <dt>Entry port</dt>
          <dd>
            <span className="mono">{h.entryPort || '—'}</span>
            {portText && <span className="muted small"> {portText}</span>}
          </dd>
        </div>
        <div>
          <dt>Total entered value</dt>
          <dd className="num">{formatUsd(totalValue)}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd className="num">{lineCountOf(result)}</dd>
        </div>
        <div>
          <dt>Schema</dt>
          <dd>
            <XsdBadge validation={result.xsdValidation} />
          </dd>
        </div>
        <div>
          <dt>Action items</dt>
          <dd className="counts">
            <span className="count count-blocker">{counts.blocker} blockers</span>
            <span className="count count-warning">{counts.warning} warnings</span>
            <span className="count count-info">{counts.info} info</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
