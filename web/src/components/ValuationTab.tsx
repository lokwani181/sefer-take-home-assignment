import type { PipelineResult } from '@app/shared';
import { formatPercent, formatSignedUsd, formatUsd } from '../lib/format';
import { lineLabel } from './IssueCard';

/** Per-line computation trail from invoice amount to entered value, plus indicative duty and fees. */
export function ValuationTab({ result }: { result: PipelineResult }) {
  const linesById = new Map(result.shipment.invoices.flatMap((inv) => inv.lines).map((l) => [l.id, l]));
  const estimateById = new Map(result.estimates.lines.map((e) => [e.lineId, e]));
  const totalValue = result.entryModel.header.totalEntryValue ?? result.valuations.reduce((s, v) => s + v.enteredValue, 0);
  const { totalDuty, mpf, hmf } = result.estimates;
  const charges = result.entryModel.header.charges;

  return (
    <div className="valuation">
      <div className="valuation-lines">
        {result.valuations.map((v) => {
          const line = linesById.get(v.lineId);
          const est = estimateById.get(v.lineId);
          const cls = result.classifications[v.lineId];
          const headingId = `val-${v.lineId}`;
          return (
            <section key={v.lineId} className="card valuation-card" aria-labelledby={headingId}>
              <h3 id={headingId}>
                {lineLabel(v.lineId)}
                {line?.styleNo && <span className="mono"> · {line.styleNo}</span>}
                {line && <span className="muted small"> {line.description}</span>}
              </h3>
              <table className="table steps-table">
                <caption className="sr-only">Valuation steps for {lineLabel(v.lineId)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col" className="num">
                      Amount ({v.currency})
                    </th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {v.steps.map((step, i) => (
                    <tr key={i}>
                      <td>{step.label}</td>
                      <td className={`num${step.amount < 0 ? ' negative' : ''}`}>{i === 0 ? formatUsd(step.amount, true) : formatSignedUsd(step.amount)}</td>
                      <td className="muted small">{step.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Entered value (whole USD)</th>
                    <td className="num strong">{formatUsd(v.enteredValue)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              <dl className="duty-line">
                <div>
                  <dt>HTS</dt>
                  <dd className="mono">{cls?.htsFormatted ?? est?.htsNumber ?? '—'}</dd>
                </div>
                <div>
                  <dt>General rate</dt>
                  <dd>{cls?.generalRate ?? formatPercent(est?.ratePct)}</dd>
                </div>
                <div>
                  <dt>Estimated duty</dt>
                  <dd className="num">{est?.duty === undefined ? 'Not computed' : formatUsd(est.duty, true)}</dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>

      <section className="card totals" aria-labelledby="totals-heading">
        <h3 id="totals-heading">Totals (indicative)</h3>
        <table className="table totals-table">
          <tbody>
            <tr>
              <th scope="row">Total entered value</th>
              <td className="num strong">{formatUsd(totalValue)}</td>
            </tr>
            {charges !== undefined && (
              <tr>
                <th scope="row">Non-dutiable charges (freight, insurance)</th>
                <td className="num">{formatUsd(charges)}</td>
              </tr>
            )}
            <tr>
              <th scope="row">Estimated duty (column 1 general)</th>
              <td className="num">{formatUsd(totalDuty, true)}</td>
            </tr>
            <tr>
              <th scope="row">Merchandise processing fee (MPF)</th>
              <td className="num">{formatUsd(mpf, true)}</td>
            </tr>
            <tr>
              <th scope="row">Harbor maintenance fee (HMF)</th>
              <td className="num">{formatUsd(hmf, true)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Estimated duty and fees</th>
              <td className="num strong">{formatUsd(totalDuty + mpf + hmf, true)}</td>
            </tr>
          </tfoot>
        </table>
        <h4>Notes and caveats</h4>
        <ul className="notes">
          {result.estimates.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>Estimates are indicative. They exclude Chapter 99 additional duties, AD/CVD and other agency fees unless listed above.</li>
        </ul>
      </section>
    </div>
  );
}
