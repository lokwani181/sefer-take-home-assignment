/**
 * Spec 2: unsupported uploads produce an actionable error, both from the server (a file whose
 * content is not a document) and from the client-side pre-check (a file type the app never accepts).
 */
import { expect, test } from '@playwright/test';
import { fileInput, generateButton, summaryRegion, uploadAndGenerate } from './support';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Server ready/ })).toBeVisible();
});

test('a file that is not really a PDF shows an error banner with a hint', async ({ page }) => {
  await uploadAndGenerate(page, {
    name: 'not-a-real-invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('This is plain text pretending to be a commercial invoice.\n'),
  });

  const banner = page.getByRole('alert').filter({ hasText: 'Could not generate the entry' });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText('Unsupported file');
  await expect(banner).toContainText('not-a-real-invoice.pdf');
  // The hint tells the broker what to do.
  await expect(banner).toContainText('How to fix:');
  await expect(banner).toContainText(/Upload PDF, PNG, JPEG, TIFF or WebP files/);
  await expect(summaryRegion(page)).toHaveCount(0);

  // The banner can be dismissed and the upload retried.
  await banner.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(banner).toHaveCount(0);
  await expect(generateButton(page)).toBeEnabled();
});

test('an unsupported file type is rejected before upload with the accepted types', async ({ page }) => {
  await fileInput(page).setInputFiles({ name: 'packing-list.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\u0003\u0004') });
  await expect(page.getByText('packing-list.docx: unsupported type (use PDF, PNG, JPG or TIFF)')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Selected files' })).toHaveCount(0);
  await expect(generateButton(page)).toBeDisabled();
});

test('the API answers an unsupported upload with 415 and a hint', async ({ request }) => {
  const res = await request.post('/api/shipments', {
    multipart: { files: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') } },
  });
  expect(res.status()).toBe(415);
  const body = (await res.json()) as { error: string; hint?: string };
  expect(body.error).toMatch(/unsupported/i);
  expect(body.hint).toMatch(/PDF/);
});
