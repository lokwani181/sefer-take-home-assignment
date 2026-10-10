/**
 * Synthetic test shipments generator (T7).
 *
 * Renders HTML templates to PDF with Playwright/Chromium, turns the "scanned" variants into
 * image-only PDFs (pdftoppm + sharp + pdf-lib), validates every expected.json with zod and
 * writes samples/synthetic/<id>/ plus a SHA256SUMS manifest. Deterministic: same inputs → same bytes.
 *
 * Usage: npx tsx scripts/make-synthetic.ts [--out <dir>] [--only <id>[,<id>…]]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './synthetic/generate.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]): { outDir: string; only?: string[] } {
  let outDir = resolve(REPO_ROOT, 'samples/synthetic');
  let only: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outDir = resolve(argv[++i] ?? '');
    else if (a === '--only') only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx scripts/make-synthetic.ts [--out <dir>] [--only <id>[,<id>...]]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return { outDir, only };
}

async function main(): Promise<void> {
  const { outDir, only } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  console.log(`Generating synthetic shipments into ${outDir}`);
  const { files, errors } = await generate({ outDir, only, log: (m) => console.log(m) });
  if (errors.length > 0) {
    console.error(`\n${errors.length} validation error(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`\n${files.length} files written, all expected.json valid (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
