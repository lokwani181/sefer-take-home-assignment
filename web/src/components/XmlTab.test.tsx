import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResult } from '../api/mock-result';
import { applyMockInputs } from '../api/mock-effects';
import { XmlTab } from './XmlTab';

describe('XmlTab', () => {
  const created: Blob[] = [];
  let clicked: { href: string; download: string }[] = [];

  beforeEach(() => {
    clicked = [];
    created.length = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:mock-url';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies the XML to the clipboard and confirms', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<XmlTab result={mockResult} />);
    await user.click(screen.getByRole('button', { name: 'Copy XML' }));
    expect(writeText).toHaveBeenCalledWith(mockResult.xml);
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('reports a failed copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    render(<XmlTab result={mockResult} />);
    await user.click(screen.getByRole('button', { name: 'Copy XML' }));
    expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
  });

  it('downloads the XML named after the invoice number', async () => {
    const user = userEvent.setup();
    render(<XmlTab result={mockResult} />);
    await user.click(screen.getByRole('button', { name: 'Download XML' }));

    expect(clicked).toEqual([{ href: 'blob:mock-url', download: 'KBAS-NB-26-0912.entry.xml' }]);
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('application/xml;charset=utf-8');
    expect(await created[0].text()).toBe(mockResult.xml);
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url'));
  });

  it('shows the XSD badge, the CBP-readiness note and the SOAP preview', () => {
    render(<XmlTab result={mockResult} />);
    expect(screen.getByText('✓ XSD-valid')).toBeInTheDocument();
    expect(screen.getByText('XSD-valid is not CBP-ready: resolve blockers first.')).toBeInTheDocument();
    expect(screen.getByText(/5 blockers still open/)).toBeInTheDocument();
    expect(screen.getByText('SOAP uploadEntry preview')).toBeInTheDocument();
    const xmlRegion = screen.getByRole('region', { name: 'Entry XML' });
    expect(xmlRegion.querySelector('.xml-ln')).toHaveTextContent('1');
    expect(xmlRegion.querySelector('.xml-ln')).toHaveAttribute('aria-hidden', 'true');
    expect(within(xmlRegion).getByText('KBAS-NB-26-0912')).toHaveClass('xml-text');
  });

  it('lists schema errors when the XML is invalid', () => {
    const invalid = applyMockInputs(mockResult, { importerTaxId: '12345' });
    render(<XmlTab result={invalid} />);
    expect(screen.getByText('✕ XSD-invalid')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: 'Schema errors (1)' });
    expect(within(heading.parentElement!).getByRole('listitem')).toHaveTextContent(/importer-tax-id.*12345/);
  });
});
