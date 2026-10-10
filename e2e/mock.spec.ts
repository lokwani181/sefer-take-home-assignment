/**
 * Spec 4 (smoke): ?mock=1 renders a complete result from the built-in demo data without any
 * request to the API, so the UI can be explored with no server or OCR tools.
 */
import { expect, test } from '@playwright/test';
import { blockersGroup, issueCards, openTab, samplePdfs, summaryRegion, summaryValue, uploadAndGenerate, xmlRegion } from './support';

test('mock mode renders results without a server round trip', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) apiCalls.push(`${req.method()} ${req.url()}`);
  });

  await page.goto('/?mock=1');
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Server ready/ })).toBeVisible();

  await uploadAndGenerate(page, samplePdfs()[0]);
  await expect(summaryRegion(page)).toBeVisible({ timeout: 15_000 });
  await expect(summaryValue(page, 'Invoice no.')).not.toHaveText('—');
  await expect(summaryValue(page, 'Schema')).toHaveText(/XSD-valid/);
  await expect(blockersGroup(page)).toBeVisible();
  await expect(issueCards(blockersGroup(page), 'MISSING_IMPORTER_ID')).toHaveCount(1);

  await openTab(page, 'Entry XML');
  await expect(xmlRegion(page)).toContainText('<entry xmlns="http://www.netchb.com/xml/entry">');
  for (const name of ['Shipment data', 'Valuation & duties', 'Broker inputs']) {
    await openTab(page, name);
    await expect(page.getByRole('tabpanel', { name })).toBeVisible();
  }

  expect(apiCalls, 'requests to /api in mock mode').toEqual([]);
});
