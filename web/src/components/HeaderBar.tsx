import { useId } from 'react';
import type { ApiMode } from '../api/client';
import type { HealthState } from '../hooks/useHealth';

function describe(state: HealthState): { tone: 'ok' | 'warn' | 'error' | 'pending'; label: string; lines: string[] } {
  switch (state.status) {
    case 'checking':
      return { tone: 'pending', label: 'Checking server…', lines: ['Contacting /api/health'] };
    case 'unreachable':
      return { tone: 'error', label: 'Server unreachable', lines: [state.message, 'Start the API on port 3001 or use ?mock=1.'] };
    case 'ok':
    case 'degraded': {
      const tools = Object.entries(state.health.tools ?? {}).map(([name, version]) => `${name} ${version}`);
      const missing = state.health.missing ?? [];
      const lines = [
        ...(missing.length ? [`Missing: ${missing.join(', ')}`] : []),
        ...(tools.length ? [`Found: ${tools.join(' · ')}`] : []),
      ];
      return state.status === 'ok'
        ? { tone: 'ok', label: 'Server ready', lines: lines.length ? lines : ['All tools found'] }
        : { tone: 'warn', label: missing.length ? 'Tools missing' : 'Server degraded', lines };
    }
  }
}

/** Dot + label; hovering or focusing reveals which OCR/PDF tools the server found or is missing. */
export function HealthIndicator({ state }: { state: HealthState }) {
  const tooltipId = useId();
  const { tone, label, lines } = describe(state);
  return (
    <button type="button" className="health" aria-describedby={tooltipId}>
      <span className={`health-dot health-${tone}`} aria-hidden="true" />
      <span className="health-label">{label}</span>
      <span role="tooltip" id={tooltipId} className="tooltip">
        {lines.map((line) => (
          <span key={line} className="tooltip-line">
            {line}
          </span>
        ))}
      </span>
    </button>
  );
}

export function HeaderBar({ health, mode }: { health: HealthState; mode: ApiMode }) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <div className="brand">
          <h1 className="brand-title">Shipment → NetCHB Entry</h1>
          <p className="brand-subtitle">Upload invoice, packing list and bill of lading; review a NetCHB-ready entry and the action items to file it.</p>
        </div>
        <div className="header-status">
          {mode === 'mock' && (
            <span className="badge badge-mock" title="Demo mode: results come from built-in sample data, not the server">
              Demo data
            </span>
          )}
          <HealthIndicator state={health} />
        </div>
      </div>
    </header>
  );
}
