/**
 * Refresh the committed HTS snapshots used for offline tests and first-run classification.
 *
 *   npx tsx server/src/reference/prefetch.ts                # default list below
 *   npx tsx server/src/reference/prefetch.ts 8211 "kitchen knives"
 *
 * Arguments that are 4+ digits (dots allowed) are headings; anything else is a search keyword.
 * Rows are stored verbatim except that always-null fields are dropped to keep the files small.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHtsClientConfig, headingUrl, searchSlug, searchUrl, type HtsRow } from './hts/client.js';

/** Headings needed by tests: sample lines + alternatives + the synthetic shipments + search candidates. */
export const DEFAULT_HEADINGS = [
  '6109', '6110', '6203', '6206', '6106', // sample lines and their alternatives
  '8211', '7323', '9403', '4202', '6302', '6204', '6105', '3924', // synthetic shipments
  '8509', '8516', '6402', '6403', '6404', // blind synthetic shipments s4/s5 (household appliances, footwear)
  // top-ranked candidates of the committed searches (keeps offline search results equal to online)
  '3926', '4420', '4803', '5802', '5806', '6103', '6104', '6111', '6117', '6209', '6210', '6211', '6307',
  '6912', '7013', '7114', '7204', '7218', '7324', '8201', '8208', '8214', '8215', '8452', '9402', '9619',
];

export const DEFAULT_KEYWORDS = [
  'trousers cotton',
  't-shirts cotton',
  'kitchen knives',
  'stainless steel kitchenware',
  'wooden furniture',
  'backpacks',
  'cotton towels',
];

const KEEP: (keyof HtsRow)[] = ['htsno', 'statisticalSuffix', 'indent', 'description', 'superior', 'units', 'general', 'special', 'other', 'footnotes'];

function trim(rows: HtsRow[]): HtsRow[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of KEEP) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
    return out as unknown as HtsRow;
  });
}

async function get(url: string): Promise<HtsRow[]> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error(`unexpected body for ${url}`);
  return body as HtsRow[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headings = new Set<string>();
  const keywords = new Set<string>();
  for (const a of args.length ? args : [...DEFAULT_HEADINGS, ...DEFAULT_KEYWORDS]) {
    const digits = a.replace(/\./g, '');
    if (/^\d{4,10}$/.test(digits)) headings.add(digits.slice(0, 4));
    else keywords.add(a);
  }
  const { dataDir } = getHtsClientConfig();
  mkdirSync(join(dataDir, 'hts'), { recursive: true });
  mkdirSync(join(dataDir, 'hts-search'), { recursive: true });
  for (const h of headings) {
    const rows = trim(await get(headingUrl(h)));
    writeFileSync(join(dataDir, 'hts', `${h}.json`), JSON.stringify(rows, null, 1) + '\n');
    console.log(`heading ${h}: ${rows.length} rows`);
  }
  for (const k of keywords) {
    const rows = trim(await get(searchUrl(k)));
    writeFileSync(join(dataDir, 'hts-search', `${searchSlug(k)}.json`), JSON.stringify(rows, null, 1) + '\n');
    console.log(`search "${k}": ${rows.length} rows`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
