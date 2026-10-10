/**
 * Shared locators and fixtures for the E2E specs. Selectors are accessible roles, labels and
 * visible text (the same things a broker sees), never CSS structure.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SAMPLES_DIR = join(REPO_ROOT, 'samples');

/** Every PDF directly under samples/ (the reference shipment: invoice, packing list, house B/L). */
export function samplePdfs(): string[] {
  const files = readdirSync(SAMPLES_DIR)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort()
    .map((name) => join(SAMPLES_DIR, name));
  expect(files, 'samples/*.pdf').toHaveLength(3);
  return files;
}

export const fileInput = (page: Page) => page.getByLabel('Choose shipment documents');
export const generateButton = (page: Page) => page.getByRole('button', { name: 'Generate entry', exact: true });
export const summaryRegion = (page: Page) => page.getByRole('region', { name: 'Entry summary' });
export const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name });
export const actionItemsPanel = (page: Page) => page.getByRole('tabpanel', { name: /^Action items/ });
export const xmlRegion = (page: Page) => page.getByRole('region', { name: 'Entry XML', exact: true });

/** The <dd> of a summary row, found by its <dt> label. */
export function summaryValue(page: Page, label: string): Locator {
  return summaryRegion(page)
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');
}

/**
 * Issue cards (role article, named by their title) carrying an issue code, optionally narrowed by
 * text such as a style number. Codes come from IssueCode in packages/shared/src/types.ts.
 */
export function issueCards(scope: Locator, code: string, text?: string | RegExp): Locator {
  let cards = scope.getByRole('article').filter({ has: scope.page().getByText(code, { exact: true }) });
  if (text !== undefined) cards = cards.filter({ hasText: text });
  return cards;
}

/** The "Blockers" severity group inside the Action items tab. */
export const blockersGroup = (page: Page) => actionItemsPanel(page).getByRole('region', { name: /^Blockers\b/ });

/** Opens a result tab and waits until its panel is shown. */
export async function openTab(page: Page, name: string | RegExp): Promise<void> {
  const t = tab(page, name);
  await t.click();
  await expect(t).toHaveAttribute('aria-selected', 'true');
}

/** Upload files with the picker and start generation. */
export async function uploadAndGenerate(page: Page, files: Parameters<Locator['setInputFiles']>[0]): Promise<void> {
  await fileInput(page).setInputFiles(files);
  await expect(generateButton(page)).toBeEnabled();
  await generateButton(page).click();
}
