import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Vitest config for the synthetic-shipment generator (run from the repo root with --config). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Keep Vite's cache out of the repo (the default would be scripts/synthetic/node_modules/.vite).
  cacheDir: join(tmpdir(), 'vitest-synthetic-cache'),
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
