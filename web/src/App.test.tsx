import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '@app/shared';
import { App } from './App';
import { ApiRequestError, createMockClient, type ApiClient } from './api/client';
import { applyMockInputs } from './api/mock-effects';
import { mockResult } from './api/mock-result';

const pdf = (name: string) => new File(['%PDF-1.4 test'], name, { type: 'application/pdf' });

/** A client whose calls are spies; regenerate applies the demo effects so the UI updates realistically. */
function spyClient(overrides: Partial<ApiClient> = {}): ApiClient & { regenerate: ReturnType<typeof vi.fn> } {
  const regenerate = vi.fn(async (_id: string, inputs: Parameters<ApiClient['regenerate']>[1]) => applyMockInputs(mockResult, inputs));
  return {
    mode: 'mock',
    health: vi.fn(async () => ({ ok: true, tools: { tesseract: '5.5.1' }, missing: [] })),
    createShipment: vi.fn(async () => structuredClone(mockResult) as PipelineResult),
    regenerate,
    ...overrides,
  } as ApiClient & { regenerate: ReturnType<typeof vi.fn> };
}

async function uploadAndGenerate(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText(/choose shipment documents/i), [pdf('invoice.pdf'), pdf('packing-list.pdf'), pdf('bl.pdf')]);
  await user.click(screen.getByRole('button', { name: 'Generate entry' }));
  await screen.findByRole('region', { name: 'Entry summary' });
}

describe('App: upload → results (mock client)', () => {
  it('renders the upload panel, shows progress, then the results', async () => {
    const user = userEvent.setup();
    render(<App client={createMockClient({ delayMs: 50, regenerateDelayMs: 0 })} healthIntervalMs={0} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Shipment → NetCHB Entry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate entry' })).toBeDisabled();
    expect(await screen.findByText('Server ready')).toBeInTheDocument();

    await user.upload(screen.getByLabelText(/choose shipment documents/i), [pdf('invoice.pdf'), pdf('packing-list.pdf'), pdf('bl.pdf')]);
    const list = screen.getByRole('list', { name: 'Selected files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Remove bl.pdf' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Generate entry' }));
    expect(screen.getByRole('timer', { name: 'Elapsed time' })).toHaveTextContent(/s elapsed/);
    expect(screen.getByText(/Processing 2 documents/)).toBeInTheDocument();

    const summary = await screen.findByRole('region', { name: 'Entry summary' });
    expect(within(summary).getByText('KBAS-NB-26-0912')).toBeInTheDocument();
    expect(within(summary).getByText('NORTHBOUND OUTFITTERS, INC.')).toBeInTheDocument();
    expect(within(summary).getByText('$27,439')).toBeInTheDocument();
    expect(within(summary).getByText('5 blockers')).toBeInTheDocument();
    expect(within(summary).getByText('✓ XSD-valid')).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Action items 5 blocking', 'Entry XML', 'Shipment data', 'Valuation & duties', 'Broker inputs']);
    expect(screen.getByRole('tab', { name: /action items/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();

    // The upload panel collapses to one line and can be reopened.
    expect(within(screen.getByRole('list', { name: 'Processed files' })).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Change documents' }));
    expect(screen.getByRole('button', { name: 'Generate new entry' })).toBeEnabled();
  });

  it('accepts dropped files', async () => {
    render(<App client={spyClient()} healthIntervalMs={0} />);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [pdf('dropped.pdf')] } });
    expect(within(screen.getByRole('list', { name: 'Selected files' })).getByText('dropped.pdf')).toBeInTheDocument();
  });

  it('broker inputs regenerate the entry and clear their blockers', async () => {
    const user = userEvent.setup();
    const client = spyClient();
    render(<App client={client} healthIntervalMs={0} />);
    await uploadAndGenerate(user);

    await user.click(screen.getByRole('tab', { name: 'Broker inputs' }));
    await user.type(screen.getByLabelText('Importer tax ID'), '93-1234567');
    await user.selectOptions(screen.getByLabelText('Bond type'), '09');
    await user.type(screen.getByLabelText('Surety code'), '036');
    await user.click(screen.getByRole('button', { name: 'Regenerate entry' }));

    expect(client.regenerate).toHaveBeenCalledWith(
      'demo-sample-shipment',
      expect.objectContaining({ importerTaxId: '93-1234567', bondType: '09', suretyCode: '036' }),
    );
    // No decision was touched, so none is sent (defaults stay defaults and blockers stay blockers).
    expect(vi.mocked(client.regenerate).mock.calls[0][1].decisions).toBeUndefined();
    const summary = screen.getByRole('region', { name: 'Entry summary' });
    await waitFor(() => expect(within(summary).getByText('2 blockers')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Broker inputs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByText('✓ Resolved by this input')).toHaveLength(3);
  });

  it('shows the server error, detail and hint when generation fails', async () => {
    const user = userEvent.setup();
    const client = spyClient({
      createShipment: vi.fn(async () => {
        throw new ApiRequestError(503, { error: 'OCR engine unavailable', detail: 'tesseract: command not found', hint: 'brew install tesseract poppler' });
      }),
    });
    render(<App client={client} healthIntervalMs={0} />);
    await user.upload(screen.getByLabelText(/choose shipment documents/i), [pdf('scan.pdf')]);
    await user.click(screen.getByRole('button', { name: 'Generate entry' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('OCR engine unavailable');
    expect(alert).toHaveTextContent('tesseract: command not found');
    expect(alert).toHaveTextContent('brew install tesseract poppler');
  });

  it('flags missing tools in the health indicator tooltip', async () => {
    const client = spyClient({ health: vi.fn(async () => ({ ok: false, tools: { pdftotext: '25.01' }, missing: ['tesseract'] })) });
    render(<App client={client} healthIntervalMs={0} />);
    expect(await screen.findByText('Tools missing')).toBeInTheDocument();
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Missing: tesseract');
  });

  it('rejects unsupported files without adding them', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<App client={spyClient()} healthIntervalMs={0} />);
    await user.upload(screen.getByLabelText(/choose shipment documents/i), [new File(['x'], 'notes.docx'), pdf('invoice.pdf')]);
    expect(screen.getByText(/notes\.docx: unsupported type/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Selected files' })).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('App: decisions regenerate the entry', () => {
  it('sends only the decision the broker changed and keeps the Action items tab', async () => {
    const user = userEvent.setup();
    const client = spyClient();
    render(<App client={client} healthIntervalMs={0} />);
    await uploadAndGenerate(user);

    const group = screen.getByRole('group', { name: 'Which quantity should be declared for NB-H205?' });
    const invoiceOption = within(group).getByRole('radio', { name: /Invoice quantity/ });
    const packedOption = within(group).getByRole('radio', { name: /Packed quantity/ });
    expect(invoiceOption).toBeChecked();
    expect(within(group).getByText('(recommended)').closest('label')).toHaveTextContent('Invoice quantity');

    await user.click(packedOption);

    expect(client.regenerate).toHaveBeenCalledTimes(1);
    // Untouched decisions must NOT be sent: the server treats any sent key as an explicit choice.
    expect(client.regenerate).toHaveBeenCalledWith('demo-sample-shipment', {
      decisions: { 'quantity:inv0-line2': 'packed' },
    });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Entry summary' })).getByText('$27,261')).toBeInTheDocument());
    expect(packedOption).toBeChecked();
    expect(screen.getByRole('tab', { name: /action items/i })).toHaveAttribute('aria-selected', 'true');

    // A second flip carries the first one forward.
    await user.click(within(screen.getByRole('group', { name: 'Which gross weight should the header carry?' })).getByRole('radio', { name: /Packing list/ }));
    expect(client.regenerate).toHaveBeenLastCalledWith(
      'demo-sample-shipment',
      expect.objectContaining({ decisions: expect.objectContaining({ 'quantity:inv0-line2': 'packed', grossWeight: 'packing_list' }) }),
    );
  });

  it('rolls the choice back and shows an error when regeneration fails', async () => {
    const user = userEvent.setup();
    const client = spyClient();
    client.regenerate.mockRejectedValueOnce(new ApiRequestError(404, { error: 'Shipment not found', hint: 'Upload the documents again.' }));
    render(<App client={client} healthIntervalMs={0} />);
    await uploadAndGenerate(user);

    const group = screen.getByRole('group', { name: 'Which amount should be declared for NB-T101?' });
    await user.click(within(group).getByRole('radio', { name: /Printed/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload the documents again.');
    expect(within(group).getByRole('radio', { name: /Computed/ })).toBeChecked();
  });
});
