/**
 * Spec 1: the full broker flow on the real sample shipment (samples/*.pdf), through the real
 * server: text layer + Tesseract OCR, parsing, reconciliation, classification, XML and XSD.
 *
 * Expected values come from PLAN.md §1 / server/test/golden/sample-expected.json.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  actionItemsPanel,
  blockersGroup,
  issueCards,
  openTab,
  samplePdfs,
  summaryRegion,
  summaryValue,
  uploadAndGenerate,
  xmlRegion,
} from './support';

const ENTRY_ROOT = '<entry xmlns="http://www.netchb.com/xml/entry">';

test('sample shipment: upload → entry + action items → decision → broker inputs → download', async ({ page }) => {
  await test.step('open the app', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Shipment → NetCHB Entry' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Server ready/ })).toBeVisible();
  });

  await test.step('upload the 3 sample PDFs and wait for the entry', async () => {
    const files = samplePdfs();
    await expect(page.getByRole('heading', { name: 'Upload shipment documents' })).toBeVisible();
    await uploadAndGenerate(page, files);
    // Real OCR of the scanned packing list and bill of lading.
    await expect(summaryRegion(page)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('list', { name: 'Processed files' }).getByRole('listitem')).toHaveCount(files.length);
  });

  await test.step('summary: invoice, total entered value, XSD-valid', async () => {
    await expect(summaryValue(page, 'Invoice no.')).toHaveText('KBAS-NB-26-0912');
    await expect(summaryValue(page, 'Total entered value')).toHaveText('$27,439');
    await expect(summaryValue(page, 'Schema')).toHaveText('✓ XSD-valid');
    await expect(summaryValue(page, 'Lines')).toHaveText('5');
  });

  await test.step('action items: NB-H205 quantity + composition blockers, missing importer ID', async () => {
    await expect(page.getByRole('tab', { name: /^Action items/ })).toHaveAttribute('aria-selected', 'true');
    const blockers = blockersGroup(page);
    await expect(blockers).toBeVisible();
    await expect(issueCards(blockers, 'QTY_MISMATCH', 'NB-H205')).toHaveCount(1);
    await expect(issueCards(blockers, 'COMPOSITION_CONFLICT', 'NB-H205')).toHaveCount(1);
    await expect(issueCards(blockers, 'MISSING_IMPORTER_ID')).toHaveCount(1);
    await expect(issueCards(blockers, 'MISSING_BOND')).toHaveCount(1);
    await expect(issueCards(blockers, 'MISSING_SURETY')).toHaveCount(1);
    // The composition conflict names both fibre contents.
    await expect(issueCards(blockers, 'COMPOSITION_CONFLICT', 'NB-H205')).toContainText(/cotton/i);
    await expect(issueCards(blockers, 'COMPOSITION_CONFLICT', 'NB-H205')).toContainText(/polyester/i);
  });

  await test.step('Entry XML tab: total and container', async () => {
    await openTab(page, 'Entry XML');
    const xml = xmlRegion(page);
    await expect(xml).toContainText('<total-entry-value>27439</total-entry-value>');
    await expect(xml).toContainText('<container-number>OPLU3041722</container-number>');
    await expect(xml).toContainText('<value>8880</value>');
    await expect(page.getByRole('tabpanel', { name: 'Entry XML' }).getByText('✓ XSD-valid')).toBeVisible();
  });

  await test.step('flip the NB-H205 quantity decision to the packed quantity', async () => {
    await openTab(page, /^Action items/);
    const card = issueCards(actionItemsPanel(page), 'QTY_MISMATCH', 'NB-H205');
    const invoiceQty = card.getByRole('radio', { name: /invoice/i });
    const packedQty = card.getByRole('radio', { name: /packed/i });
    await expect(invoiceQty).toBeChecked();
    await packedQty.check();
    // 1,176 packed × USD 7.40 = 8,702.40 → 8,702; the total drops by 178.
    await expect(summaryValue(page, 'Total entered value')).toHaveText('$27,261', { timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Results' })).toHaveAttribute('aria-busy', 'false');
    await expect(issueCards(actionItemsPanel(page), 'QTY_MISMATCH', 'NB-H205').getByRole('radio', { name: /packed/i })).toBeChecked();
    // Only the decision the broker touched may change; the untouched composition conflict stays a blocker.
    await expect(
      issueCards(blockersGroup(page), 'COMPOSITION_CONFLICT', 'NB-H205'),
      'composition blocker after flipping only the quantity decision',
    ).toHaveCount(1);

    await openTab(page, 'Entry XML');
    const xml = xmlRegion(page);
    await expect(xml).toContainText('<value>8702</value>');
    await expect(xml).not.toContainText('<value>8880</value>');
    await expect(xml).toContainText('<total-entry-value>27261</total-entry-value>');
  });

  await test.step('broker inputs: importer, bond, surety, FIRMS → regenerate', async () => {
    await openTab(page, 'Broker inputs');
    const form = page.getByRole('tabpanel', { name: 'Broker inputs' });
    await form.getByLabel('Importer tax ID', { exact: true }).fill('93-1234567');
    await form.getByLabel('Bond type', { exact: true }).selectOption('08');
    await form.getByLabel('Surety code', { exact: true }).fill('036');
    await form.getByLabel('Location of goods (FIRMS)', { exact: true }).fill('W123');
    await form.getByRole('button', { name: 'Regenerate entry' }).click();

    // Each assertion is false before the regeneration lands, so they also wait for it.
    await openTab(page, /^Action items/);
    const actions = actionItemsPanel(page);
    for (const code of ['MISSING_IMPORTER_ID', 'MISSING_BOND', 'MISSING_SURETY', 'MISSING_LOCATION_OF_GOODS']) {
      await expect(issueCards(actions, code), code).toHaveCount(0, { timeout: 30_000 });
    }
    // The document blockers remain: broker inputs cannot resolve them.
    await expect(issueCards(blockersGroup(page), 'COMPOSITION_CONFLICT', 'NB-H205')).toHaveCount(1);
    await expect(summaryValue(page, 'Schema')).toHaveText('✓ XSD-valid');

    await openTab(page, 'Entry XML');
    const xml = xmlRegion(page);
    await expect(xml).toContainText('<importer-tax-id>93-1234567</importer-tax-id>');
    await expect(xml).toContainText('<bond-type>08</bond-type>');
    await expect(xml).toContainText('<surety-code>036</surety-code>');
    await expect(xml).toContainText('<location-of-goods>W123</location-of-goods>');
    // The earlier decision survives the broker-input regeneration.
    await expect(xml).toContainText('<value>8702</value>');
  });

  await test.step('download the XML', async () => {
    await openTab(page, 'Entry XML');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download XML' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.xml$/);
    expect(download.suggestedFilename()).toContain('KBAS-NB-26-0912');
    const content = await readFile(await download.path(), 'utf8');
    expect(content).toContain(ENTRY_ROOT);
    expect(content).toContain('<importer-tax-id>93-1234567</importer-tax-id>');
    expect(content).toContain('<total-entry-value>27261</total-entry-value>');
  });
});
