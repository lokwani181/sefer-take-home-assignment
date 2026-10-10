import type { ReactNode } from 'react';
import type { Address, LineClassification, PipelineResult, ShipmentLine, Sourced } from '@app/shared';
import { LOW_CONFIDENCE, docTypeLabel, formatNumber, formatUsd } from '../lib/format';
import { SourceBadges, VerifyBadge } from './Badges';
import { lineLabel } from './IssueCard';

interface ShipmentDataTabProps {
  result: PipelineResult;
  /** URL of a rendered OCR page, when the backend serves page images. */
  pageImageUrl?: (docId: string, page: number) => string;
}

function AddressBlock({ address }: { address: Address | undefined }) {
  if (!address) return <span className="muted">Not found</span>;
  const cityLine = [address.city, address.stateProvince, address.postalCode].filter(Boolean).join(', ');
  return (
    <address className="address">
      <strong>{address.name}</strong>
      {address.lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
      {(cityLine || address.country) && (
        <span>
          {cityLine}
          {address.country ? `${cityLine ? ' · ' : ''}${address.country}` : ''}
        </span>
      )}
    </address>
  );
}

function SourcedValue<T>({ sourced, render }: { sourced: Sourced<T> | undefined; render?: (value: T) => ReactNode }) {
  if (!sourced) return <span className="muted">—</span>;
  return (
    <span className="sourced">
      <span>{render ? render(sourced.value) : String(sourced.value)}</span> <SourceBadges sourced={sourced} />
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function HtsCell({ cls }: { cls: LineClassification | undefined }) {
  if (!cls) return <span className="muted">Not classified</span>;
  return (
    <span className="hts-cell" title={`${cls.description}\n${cls.rationale}`}>
      <span className="mono">{cls.htsFormatted}</span>
      <span className="badges">
        {cls.confidence !== 'high' && <span className={`badge badge-conf-${cls.confidence}`}>{cls.confidence}</span>}
        {cls.basis === 'user' && <span className="badge badge-status-user">user</span>}
        {cls.alternatives.length > 0 && (
          <span className="badge badge-alt" title={cls.alternatives.map((a) => `${a.htsFormatted} ${a.generalRate ?? ''} ${a.reason ?? ''}`).join('\n')}>
            alt {cls.alternatives[0].htsFormatted}
          </span>
        )}
      </span>
    </span>
  );
}

function lineFlags(line: ShipmentLine): string[] {
  const flags: string[] = [];
  if (line.noCommercialValue) flags.push('NCV / FOC');
  if (line.assists.length > 0) flags.push('Assist');
  if (line.altComposition) flags.push('Composition conflict');
  if (line.packedQuantity !== undefined) flags.push('Qty differs from packing list');
  return flags;
}

const SOURCE_LABEL = { text: 'Text layer', ocr: 'OCR', mixed: 'Text + OCR' } as const;

/** Everything extracted and reconciled from the documents, with provenance and confidence badges. */
export function ShipmentDataTab({ result, pageImageUrl }: ShipmentDataTabProps) {
  const { shipment } = result;
  const t = shipment.transport;
  const lines = shipment.invoices.flatMap((inv) => inv.lines);
  const valueByLine = new Map(result.valuations.map((v) => [v.lineId, v.enteredValue]));

  return (
    <div className="shipment-data">
      <section aria-labelledby="docs-heading">
        <h3 id="docs-heading">Documents</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Detected type</th>
                <th scope="col">Read from</th>
                <th scope="col" className="num">
                  Pages
                </th>
                <th scope="col" className="num">
                  Classification score
                </th>
              </tr>
            </thead>
            <tbody>
              {result.documents.map((doc) => (
                <tr key={doc.docId}>
                  <td className="file-cell">{doc.fileName}</td>
                  <td>
                    {docTypeLabel(doc.docType)}
                    {doc.docType === 'other' && <span className="badge badge-warning">check</span>}
                  </td>
                  <td>
                    <span className={`badge badge-source-${doc.source}`}>{SOURCE_LABEL[doc.source] ?? doc.source}</span>
                    {pageImageUrl && doc.source !== 'text' && (
                      <span className="page-links">
                        {Array.from({ length: doc.pageCount }, (_, i) => (
                          <a key={i} href={pageImageUrl(doc.docId, i + 1)} target="_blank" rel="noreferrer">
                            p{i + 1}
                          </a>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="num">{doc.pageCount}</td>
                  <td className="num">
                    <span className="score">
                      <span className="score-bar" aria-hidden="true">
                        <span style={{ width: `${Math.round(doc.classificationScore * 100)}%` }} />
                      </span>
                      {Math.round(doc.classificationScore * 100)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.extracted.map((doc) => {
          const repaired = Object.entries(doc.fieldMeta).filter(([, m]) => m.repaired || m.conf < LOW_CONFIDENCE);
          if (doc.observations.length + repaired.length + doc.warnings.length === 0) return null;
          return (
            <details key={doc.docId} className="doc-notes">
              <summary>
                {doc.fileName}: {doc.observations.length} observation{doc.observations.length === 1 ? '' : 's'}
                {repaired.length > 0 && `, ${repaired.length} field${repaired.length === 1 ? '' : 's'} to verify`}
                {doc.warnings.length > 0 && `, ${doc.warnings.length} parser warning${doc.warnings.length === 1 ? '' : 's'}`}
              </summary>
              <ul>
                {doc.observations.map((o, i) => (
                  <li key={`o${i}`}>
                    <span className="chip">{o.kind.replace('_', ' ')}</span> {o.text}
                  </li>
                ))}
                {repaired.map(([path, meta]) => (
                  <li key={path}>
                    <span className="chip">verify</span> <code>{path}</code>
                    {meta.originalText !== undefined && meta.originalText !== '' && <> read as “{meta.originalText}”</>}
                    {meta.repaired && ' (repaired)'} <VerifyBadge conf={meta.conf} />
                  </li>
                ))}
                {doc.warnings.map((w, i) => (
                  <li key={`w${i}`}>
                    <span className="chip">warning</span> {w}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>

      <div className="cards">
        <section className="card card-wide" aria-labelledby="parties-heading">
          <h3 id="parties-heading">Parties</h3>
          <dl className="fields">
            <Field label="Importer of record">
              <SourcedValue sourced={shipment.importer} render={(a) => <AddressBlock address={a} />} />
            </Field>
            <Field label="Ultimate consignee">
              <SourcedValue sourced={shipment.ultimateConsignee} render={(a) => <AddressBlock address={a} />} />
            </Field>
            <Field label="Seller">
              <AddressBlock address={shipment.seller} />
            </Field>
            <Field label="Ship to">
              <AddressBlock address={shipment.shipTo} />
            </Field>
            {shipment.notifyParty && (
              <Field label="Notify party">
                <AddressBlock address={shipment.notifyParty} />
              </Field>
            )}
            <Field label={`Manufacturer${shipment.manufacturers.length === 1 ? '' : 's'}`}>
              {shipment.manufacturers.length === 0 ? (
                <span className="muted">Not found</span>
              ) : (
                shipment.manufacturers.map((m) => <AddressBlock key={m.name} address={m} />)
              )}
            </Field>
            {shipment.consolidator && (
              <Field label="Consolidator">
                <AddressBlock address={shipment.consolidator} />
              </Field>
            )}
          </dl>
        </section>

        <section className="card" aria-labelledby="transport-heading">
          <h3 id="transport-heading">Transport</h3>
          <dl className="fields">
            <Field label="Mode">
              {t.mode}
              {t.containerized ? ', containerized' : ''}
            </Field>
            {(t.vessel || t.flight) && (
              <Field label={t.flight ? 'Flight' : 'Vessel / voyage'}>{t.flight ?? `${t.vessel}${t.voyage ? ` / ${t.voyage}` : ''}`}</Field>
            )}
            <Field label="Carrier">
              {t.carrierName ?? '—'}
              {t.carrierScac && <span className="mono"> ({t.carrierScac})</span>}
            </Field>
            <Field label="Port of lading">{t.portOfLading ?? '—'}</Field>
            <Field label="Port of unlading">{t.portOfUnlading ?? '—'}</Field>
            {t.placeOfDelivery && <Field label="Place of delivery">{t.placeOfDelivery}</Field>}
            <Field label="Export date">
              <SourcedValue sourced={t.exportDate} />
            </Field>
            <Field label="Arrival date">
              <SourcedValue sourced={t.arrivalDate} />
              {t.arrivalDateEstimated && <span className="badge badge-status-assumed">estimated</span>}
            </Field>
            <Field label="Destination state">{t.destinationState ?? '—'}</Field>
            <Field label="Country of export">{shipment.countryOfExport ?? '—'}</Field>
            {shipment.releaseType && <Field label="Release">{shipment.releaseType}</Field>}
          </dl>
        </section>

        <section className="card" aria-labelledby="bills-heading">
          <h3 id="bills-heading">Bills, containers, weights</h3>
          <dl className="fields">
            {shipment.bills.map((b, i) => (
              <Field key={i} label={shipment.bills.length > 1 ? `Bills (${i + 1})` : 'Bills'}>
                {b.master && (
                  <div>
                    Master <span className="mono">{[b.master.scac, b.master.number].filter(Boolean).join(' ')}</span>
                  </div>
                )}
                {b.house && (
                  <div>
                    House <span className="mono">{[b.house.scac, b.house.number].filter(Boolean).join(' ')}</span>
                  </div>
                )}
              </Field>
            ))}
            {shipment.bills.length === 0 && <Field label="Bills">—</Field>}
            {shipment.containers.map((c) => (
              <Field key={c.number} label="Container">
                <span className="mono">{c.number}</span>{' '}
                {c.checkDigitValid ? (
                  <span className="badge badge-ok">check digit ✓</span>
                ) : (
                  <span className="badge badge-blocker">check digit ✕</span>
                )}
                {c.sizeType && <span className="muted"> {c.sizeType}</span>}
                {c.sealNumbers.length > 0 && (
                  <div>
                    Seal <span className="mono">{c.sealNumbers.join(', ')}</span>
                  </div>
                )}
                {c.candidates && c.candidates.length > 1 && (
                  <ul className="candidates" aria-label="Container number candidates">
                    {c.candidates.map((cand) => (
                      <li key={`${cand.number}-${cand.source}`}>
                        <span className={`mono${cand.source === 'strikethrough' ? ' struck' : ''}`}>{cand.number}</span> {cand.source}
                        {cand.checkDigitValid ? ' · valid' : ' · invalid check digit'}
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
            ))}
            <Field label="Gross weight">
              <SourcedValue sourced={shipment.grossWeightKg} render={(v) => `${formatNumber(v)} kg`} />
            </Field>
            <Field label="Packages">
              <SourcedValue sourced={shipment.packages} render={(p) => `${formatNumber(p.count)} ${p.unit}`} />
            </Field>
            {shipment.volumeCbm !== undefined && <Field label="Volume">{formatNumber(shipment.volumeCbm)} m³</Field>}
          </dl>
        </section>

        {shipment.invoices.map((inv, index) => (
          <section className="card" key={inv.docId} aria-labelledby={`inv-heading-${index}`}>
            <h3 id={`inv-heading-${index}`}>Invoice{shipment.invoices.length > 1 ? ` ${index + 1}` : ''}</h3>
            <dl className="fields">
              <Field label="Number">
                <SourcedValue sourced={inv.invoiceNumber} />
              </Field>
              <Field label="Date">
                <SourcedValue sourced={inv.invoiceDate} />
              </Field>
              <Field label="Currency / terms">
                {inv.currency}
                {inv.incoterm && ` · ${inv.incoterm.code}${inv.incoterm.place ? ` ${inv.incoterm.place}` : ''}`}
                {inv.linesAreFob && <span className="muted"> (line prices FOB)</span>}
              </Field>
              <Field label="Related party">
                <SourcedValue sourced={inv.relatedParty} render={(v) => (v ? 'Yes' : 'No')} />
              </Field>
              {inv.charges.length > 0 && (
                <Field label="Charges">
                  {inv.charges.map((c) => (
                    <div key={`${c.type}-${c.description}`}>
                      {c.description}: {formatUsd(c.amount, true)}
                    </div>
                  ))}
                </Field>
              )}
            </dl>
          </section>
        ))}
      </div>

      <section aria-labelledby="lines-heading">
        <h3 id="lines-heading">Lines</h3>
        <div className="table-wrap">
          <table className="table lines-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Style</th>
                <th scope="col">Description</th>
                <th scope="col">HTS</th>
                <th scope="col">Origin</th>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col">Unit</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="num">
                  Entered value
                </th>
                <th scope="col" className="num">
                  Net kg
                </th>
                <th scope="col" className="num">
                  Gross kg
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{lineLabel(line.id).replace(/^Line /, '')}</td>
                  <td className="mono">{line.styleNo ?? '—'}</td>
                  <td className="desc-cell">
                    <div>{line.description}</div>
                    {line.details[0] && <div className="muted small">{line.details[0]}</div>}
                    {lineFlags(line).length > 0 && (
                      <div className="badges">
                        {lineFlags(line).map((f) => (
                          <span key={f} className="badge badge-flag">
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <HtsCell cls={result.classifications[line.id]} />
                  </td>
                  <td>
                    <SourcedValue sourced={line.countryOfOrigin} />
                  </td>
                  <td className="num">
                    <SourcedValue sourced={line.quantity} render={(v) => formatNumber(v)} />
                    {line.packedQuantity !== undefined && <div className="muted small">packed {formatNumber(line.packedQuantity)}</div>}
                  </td>
                  <td>{line.unit}</td>
                  <td className="num">
                    <SourcedValue sourced={line.amount} render={(v) => formatUsd(v, true)} />
                    {line.printedAmount !== undefined && (
                      <div className="muted small">
                        printed <span className="struck">{formatUsd(line.printedAmount, true)}</span>
                      </div>
                    )}
                  </td>
                  <td className="num strong">{formatUsd(valueByLine.get(line.id))}</td>
                  <td className="num">
                    <SourcedValue sourced={line.netWeightKg} render={(v) => formatNumber(v)} />
                  </td>
                  <td className="num">
                    <SourcedValue sourced={line.grossWeightKg} render={(v) => formatNumber(v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="legend muted small">
          Badges: <span className="badge badge-status-derived">derived</span> computed from other fields ·{' '}
          <span className="badge badge-status-corrected">corrected</span> fixed by arithmetic or check digits ·{' '}
          <span className="badge badge-status-assumed">assumed</span> policy default ·{' '}
          <span className="badge badge-status-user">user</span> broker input · <span className="badge badge-verify">verify</span> confidence
          below {LOW_CONFIDENCE}. Hover a badge for its sources.
        </p>
      </section>
    </div>
  );
}
