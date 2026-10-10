/**
 * Browser end-to-end tests against the production build: `npm run build && npm start` serves the
 * built web app and the API from one Express process on http://localhost:3001.
 *
 *   npm run e2e                                  (= playwright test -c e2e/playwright.config.ts)
 *   npm run e2e -- --headed / --ui / -g "health"
 *   E2E_BASE_URL=http://localhost:3011 npm run e2e   run against an already-running deployment
 *                                                    (e.g. the Docker image); no server is started
 *
 * The OCR layout cache is disabled for the server under test, so the sample's scanned packing
 * list and bill of lading really go through Tesseract on every run. Set E2E_OCR_CACHE=1 to reuse
 * the cache under e2e/.cache for faster local iteration.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ocrCacheDir = fileURLToPath(new URL('./.cache/ocr', import.meta.url));
const PORT = 3001;
const external = process.env.E2E_BASE_URL?.replace(/\/+$/, '');
const baseURL = external || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  // One worker: the full-flow spec is CPU-bound (Tesseract), the others take seconds.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Upload + OCR (up to 120 s) plus two regenerations and a download.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    baseURL,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : {
        command: 'npm run build && npm start',
        cwd: repoRoot,
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        // Cold `npm run build` (tsc + vite) plus server start-up.
        timeout: 300_000,
        stdout: 'pipe',
        stderr: 'pipe',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        env: {
          PORT: String(PORT),
          INGEST_CACHE: process.env.E2E_OCR_CACHE === '1' ? '1' : '0',
          INGEST_CACHE_DIR: ocrCacheDir,
        },
      },
});
