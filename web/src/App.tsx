import { useMemo, useState } from 'react';
import type { ApiClient } from './api/client';
import { createDefaultClient } from './api/client';
import { ActionItemsTab } from './components/ActionItemsTab';
import { BrokerInputsTab } from './components/BrokerInputsTab';
import { HeaderBar } from './components/HeaderBar';
import { ShipmentDataTab } from './components/ShipmentDataTab';
import { SummaryStrip } from './components/SummaryStrip';
import { Tabs, type TabDef } from './components/Tabs';
import { UploadPanel } from './components/UploadPanel';
import { ValuationTab } from './components/ValuationTab';
import { XmlTab } from './components/XmlTab';
import { useHealth } from './hooks/useHealth';
import { useShipment } from './hooks/useShipment';
import { countBySeverity } from './lib/issues';

export type ResultTab = 'actions' | 'xml' | 'data' | 'valuation' | 'inputs';

export interface AppProps {
  /** Injected in tests; defaults to the http client, or the mock with ?mock=1 / VITE_API_MODE=mock. */
  client?: ApiClient;
  /** Health polling interval; 0 disables polling after the first check. */
  healthIntervalMs?: number;
}

export function App({ client: injected, healthIntervalMs }: AppProps) {
  const client = useMemo(() => injected ?? createDefaultClient(), [injected]);
  const health = useHealth(client, healthIntervalMs);
  const shipment = useShipment(client);
  const [files, setFiles] = useState<File[]>([]);
  const [tab, setTab] = useState<ResultTab>('actions');
  const { result } = shipment;

  const generate = () => {
    setTab('actions');
    void shipment.upload(files);
  };

  const tabs: TabDef<ResultTab>[] = result
    ? [
        {
          id: 'actions',
          label: 'Action items',
          badge: (() => {
            const c = countBySeverity(result.issues);
            return c.blocker > 0 ? `${c.blocker} blocking` : result.issues.length;
          })(),
          panel: (
            <ActionItemsTab
              result={result}
              decisions={shipment.brokerInputs.decisions ?? {}}
              recommended={shipment.recommendedDecisions}
              onDecisionChange={(key, value) => void shipment.changeDecision(key, value)}
              regenerating={shipment.regenerating}
              regenerateError={shipment.regenerateError}
              onDismissRegenerateError={shipment.clearRegenerateError}
            />
          ),
        },
        { id: 'xml', label: 'Entry XML', panel: <XmlTab result={result} /> },
        {
          id: 'data',
          label: 'Shipment data',
          panel: (
            <ShipmentDataTab
              result={result}
              pageImageUrl={client.pageImageUrl ? (docId, page) => client.pageImageUrl!(result.shipmentId, docId, page) : undefined}
            />
          ),
        },
        { id: 'valuation', label: 'Valuation & duties', panel: <ValuationTab result={result} /> },
        {
          id: 'inputs',
          label: 'Broker inputs',
          panel: (
            <BrokerInputsTab
              key={shipment.generation}
              result={result}
              brokerInputs={shipment.brokerInputs}
              onSubmit={(inputs) => void shipment.regenerate(inputs)}
              regenerating={shipment.regenerating}
              lastRegeneratedAt={shipment.lastRegeneratedAt}
            />
          ),
        },
      ]
    : [];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <HeaderBar health={health} mode={client.mode} />
      <main id="main" className="app-main">
        <UploadPanel
          files={files}
          onFilesChange={setFiles}
          onGenerate={generate}
          startedAt={shipment.uploadStartedAt}
          error={shipment.uploadError}
          onDismissError={shipment.clearUploadError}
          hasResult={result !== null}
        />

        {result && (
          <section className={`results${shipment.regenerating ? ' is-regenerating' : ''}`} aria-label="Results" aria-busy={shipment.regenerating}>
            <SummaryStrip result={result} />
            {shipment.regenerating && <div className="regen-bar" aria-hidden="true" />}
            <Tabs<ResultTab> tabs={tabs} active={tab} onChange={setTab} label="Result views" />
          </section>
        )}
      </main>
      <footer className="app-footer">
        <p>
          Duty and fee figures are indicative estimates. This app prepares an entry for broker review and never transmits anything to CBP or NetCHB.
          Extraction is deterministic (PDF text layer, Tesseract OCR and rules); verify flagged fields against the original documents.
        </p>
      </footer>
    </div>
  );
}
