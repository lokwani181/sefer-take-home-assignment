/**
 * Spec 3: the header health indicator reports the server and its OCR/PDF tools as ready.
 */
import { expect, test } from '@playwright/test';

test('health indicator shows the server ready with its OCR tools', async ({ page }) => {
  await page.goto('/');
  const indicator = page.getByRole('button', { name: /Server ready/ });
  await expect(indicator).toBeVisible();
  await expect(page.getByRole('button', { name: /Server unreachable|Tools missing|Server degraded/ })).toHaveCount(0);

  // Hover (or focus) reveals which tools were found.
  await indicator.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('tesseract');
  await expect(tooltip).toContainText('pdftoppm');
  await expect(tooltip).toContainText('pdftotext');
  await expect(tooltip).not.toContainText('Missing');
});

test('GET /api/health reports ok with tool versions', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: boolean; tools: Record<string, string>; missing?: string[] };
  expect(body.ok).toBe(true);
  expect(body.missing ?? []).toEqual([]);
  expect(Object.keys(body.tools)).toEqual(expect.arrayContaining(['tesseract', 'pdftoppm', 'pdftotext']));
});
