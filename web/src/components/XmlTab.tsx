import { useEffect, useRef, useState } from 'react';
import type { PipelineResult } from '@app/shared';
import { copyText, downloadText } from '../lib/file-actions';
import { xmlFileName } from '../lib/format';
import { countBySeverity } from '../lib/issues';
import { XsdBadge } from './Badges';
import { invoiceNumberOf } from './SummaryStrip';
import { XmlView } from './XmlView';

type CopyState = 'idle' | 'copied' | 'failed';

/** The generated entry XML: highlighted view, copy/download, schema status and a SOAP preview. */
export function XmlTab({ result }: { result: PipelineResult }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileName = xmlFileName(invoiceNumberOf(result));
  const blockers = countBySeverity(result.issues).blocker;
  const { valid, errors } = result.xsdValidation;

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const onCopy = async () => {
    try {
      await copyText(result.xml);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 2500);
  };

  return (
    <div className="xml-tab">
      <div className="toolbar">
        <div className="toolbar-left">
          <XsdBadge validation={result.xsdValidation} />
          <span className="mono muted">{fileName}</span>
        </div>
        <div className="toolbar-right">
          <span className="copy-status" role="status">
            {copyState === 'copied' ? 'Copied to clipboard' : copyState === 'failed' ? 'Copy failed: select the text manually' : ''}
          </span>
          <button type="button" className="btn" onClick={onCopy}>
            Copy XML
          </button>
          <button type="button" className="btn btn-primary" onClick={() => downloadText(result.xml, fileName)}>
            Download XML
          </button>
        </div>
      </div>

      <div className={`callout ${blockers > 0 ? 'callout-warn' : 'callout-info'}`}>
        <strong>XSD-valid is not CBP-ready: resolve blockers first.</strong>{' '}
        {blockers > 0
          ? `${blockers} blocker${blockers === 1 ? '' : 's'} still open in Action items.`
          : 'No blockers remain; review warnings before filing.'}{' '}
        This XML is for broker review and is never transmitted automatically.
      </div>

      {!valid && (
        <div className="xsd-errors">
          <h3>Schema errors ({errors.length})</h3>
          <ul>
            {errors.map((err, i) => (
              <li key={i} className="mono">
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      <XmlView xml={result.xml} label="Entry XML" />

      {result.soapEnvelope && (
        <details className="soap">
          <summary>SOAP uploadEntry preview</summary>
          <p className="muted">
            How the entry would be wrapped for NetCHB&apos;s EntryUploadService.uploadEntry. Display only; credentials are placeholders.
          </p>
          <XmlView xml={result.soapEnvelope} label="SOAP envelope" />
        </details>
      )}
    </div>
  );
}
