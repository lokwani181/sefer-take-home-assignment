import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BrokerInputs } from '@app/shared';
import { mockResult } from '../api/mock-result';
import { inputsFromResult } from '../lib/broker-inputs';
import { BrokerInputsTab } from './BrokerInputsTab';

function renderForm(brokerInputs: BrokerInputs = inputsFromResult(mockResult)) {
  const onSubmit = vi.fn();
  render(<BrokerInputsTab result={mockResult} brokerInputs={brokerInputs} onSubmit={onSubmit} regenerating={false} lastRegeneratedAt={null} />);
  return onSubmit;
}

describe('BrokerInputsTab', () => {
  it('shows an error for a malformed EIN and does not submit', async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    const ein = screen.getByLabelText('Importer tax ID');
    await user.type(ein, '931234567');
    await user.click(screen.getByRole('button', { name: 'Regenerate entry' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(ein).toHaveAttribute('aria-invalid', 'true');
    expect(ein).toHaveAccessibleDescription(/Use NN-NNNNNNN/);
    expect(ein).toHaveFocus();
  });

  it('submits a valid EIN with the other inputs and the current decisions', async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm({ ...inputsFromResult(mockResult), decisions: { grossWeight: 'packing_list' } });
    await user.type(screen.getByLabelText('Importer tax ID'), '93-1234567');
    await user.selectOptions(screen.getByLabelText('Bond type'), '08');
    await user.type(screen.getByLabelText('Surety code'), '036');
    await user.selectOptions(screen.getByLabelText('Payment type'), '7');
    await user.type(screen.getByLabelText('Location of goods (FIRMS)'), 'w123');
    await user.click(screen.getByLabelText('Auto-apply trade remedies in NetCHB'));
    await user.click(screen.getByRole('button', { name: 'Regenerate entry' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      importerTaxId: '93-1234567',
      bondType: '08',
      suretyCode: '036',
      paymentType: '7',
      entryType: '01',
      locationOfGoods: 'W123',
      autoApplyRemedies: false,
      decisions: { grossWeight: 'packing_list' },
    });
  });

  it('clears the error once the field is edited, and validates other fields', async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    await user.type(screen.getByLabelText('Entry port override'), '30');
    await user.type(screen.getByLabelText('Surety code'), '36');
    await user.click(screen.getByRole('button', { name: 'Regenerate entry' }));
    expect(screen.getByText(/Port codes are 4 digits/)).toBeInTheDocument();
    expect(screen.getByText(/Surety code is exactly 3/)).toBeInTheDocument();
    // Focus lands on the first invalid field in form order (Bond and payment comes before Entry).
    expect(screen.getByLabelText('Surety code')).toHaveFocus();

    await user.type(screen.getByLabelText('Entry port override'), '02');
    expect(screen.queryByText(/Port codes are 4 digits/)).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows which blockers each input clears', () => {
    renderForm();
    const ein = screen.getByLabelText('Importer tax ID').closest('.form-field') as HTMLElement;
    expect(within(ein).getByText('Clears blocker: Importer of record number is missing')).toBeInTheDocument();
    expect(screen.getByText('Clears blocker: Bond type not provided')).toBeInTheDocument();
    expect(screen.getByText('Clears blocker: Surety code not provided')).toBeInTheDocument();
    expect(screen.getByText(/3 open blockers can be cleared here/)).toBeInTheDocument();
  });
});
