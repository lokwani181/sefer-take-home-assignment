import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockResult } from '../api/mock-result';
import { decisionDefaults } from '../lib/broker-inputs';
import { ActionItemsTab } from './ActionItemsTab';

function renderTab(onDecisionChange = vi.fn()) {
  render(
    <ActionItemsTab
      result={mockResult}
      decisions={decisionDefaults(mockResult.issues)}
      recommended={decisionDefaults(mockResult.issues)}
      onDecisionChange={onDecisionChange}
      regenerating={false}
      regenerateError={null}
      onDismissRegenerateError={() => {}}
    />,
  );
  return onDecisionChange;
}

describe('ActionItemsTab', () => {
  it('renders severity groups in order (blockers first) with counts', () => {
    renderTab();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Blockers 5', 'Warnings 15', 'Info 11']);
    expect(screen.getByText('5 blockers')).toBeInTheDocument();
  });

  it('orders categories within a severity and lists blocker cards first', () => {
    renderTab();
    const blockers = screen.getByRole('region', { name: /Blockers/ });
    const categories = within(blockers)
      .getAllByRole('heading', { level: 4 })
      .filter((h) => h.classList.contains('category-heading'))
      .map((h) => h.textContent);
    expect(categories).toEqual(['Missing information (3)', 'Document conflicts (1)', 'Classification (1)']);

    const cards = within(blockers).getAllByRole('article');
    expect(cards.map((c) => c.getAttribute('data-issue-id'))).toEqual([
      'MISSING_IMPORTER_ID',
      'MISSING_BOND',
      'MISSING_SURETY',
      'QTY_MISMATCH:inv0-line2',
      'COMPOSITION_CONFLICT:inv0-line2',
    ]);
    expect(screen.getAllByRole('article')).toHaveLength(mockResult.issues.length);
  });

  it('shows the action and evidence with file name and page', () => {
    renderTab();
    const card = screen.getByRole('article', { name: /invoice 1,200 pcs vs packing list 1,176 pcs/ });
    expect(within(card).getByText('What to do')).toBeInTheDocument();
    expect(within(card).getByText(/Confirm with the seller/)).toBeInTheDocument();
    const evidence = within(card).getByRole('list', { name: 'Evidence' });
    expect(within(evidence).getByText('SPG-PL-2609-117_Packing_List.pdf, p. 1')).toBeInTheDocument();
    expect(within(evidence).getByText('KBAS-NB-26-0912_Commercial_Invoice.pdf, p. 1')).toBeInTheDocument();
  });

  it('reports a decision change with its key and option value', async () => {
    const user = userEvent.setup();
    const onChange = renderTab();
    const group = screen.getByRole('group', { name: 'Which fiber content should drive classification?' });
    await user.click(within(group).getByRole('radio', { name: /Packing list/ }));
    expect(onChange).toHaveBeenCalledWith('composition:inv0-line2', 'other_doc');
  });
});
