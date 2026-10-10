/**
 * USITC HTS REST client with a two-level disk cache.
 *
 * Lookup order: memory → committed data (src/reference/data/hts*) → runtime cache
 * (server/.cache/hts) → network (unless offline). Network responses are written to the
 * runtime cache so a code is fetched at most once per machine. Tests run with
 * `configureHtsClient({ offline: true })` so they only ever read committed data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HTS_API_BASE = 'https://hts.usitc.gov/reststop';

/** One row as returned by `exportList` / `search` (only the fields we use are typed). */
export interface HtsRow {
  htsno: string;
  indent: string | number;
  description: string;
  units?: string[] | null;
  general?: string | null;
  special?: string | null;
  other?: string | null;
  footnotes?: unknown;
  superior?: string | null;
  statisticalSuffix?: string | null;
}

export interface HtsClientConfig {
  /** Never touch the network (tests). Default: env HTS_OFFLINE === '1'. */
  offline: boolean;
  /** Committed, read-only data directory (contains hts/ and hts-search/). */
  dataDir: string;
  /** Writable runtime cache directory. */
  cacheDir: string;
  /** Network timeout per request. */
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

const here = dirname(fileURLToPath(import.meta.url));

const config: HtsClientConfig = {
  offline: process.env.HTS_OFFLINE === '1',
  dataDir: join(here, '..', 'data'),
  cacheDir: process.env.HTS_CACHE_DIR ?? join(here, '..', '..', '..', '.cache', 'hts'),
  timeoutMs: 20_000,
  fetchImpl: (...args) => fetch(...args),
};

const headingMemo = new Map<string, Promise<HtsRow[] | null>>();
const searchMemo = new Map<string, Promise<HtsRow[] | null>>();

/** Override client settings (offline mode for tests, alternative cache dirs). Clears the memo. */
export function configureHtsClient(patch: Partial<HtsClientConfig>): HtsClientConfig {
  Object.assign(config, patch);
  headingMemo.clear();
  searchMemo.clear();
  return { ...config };
}

export function getHtsClientConfig(): Readonly<HtsClientConfig> {
  return config;
}

/** File-name-safe key for a search keyword ("t-shirts cotton" → "t-shirts-cotton"). */
export function searchSlug(keyword: string): string {
  return keyword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJson(path: string): HtsRow[] | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as HtsRow[]) : null;
  } catch {
    return null;
  }
}

function writeCache(sub: string, file: string, rows: HtsRow[]): void {
  try {
    const dir = join(config.cacheDir, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(rows, null, 1));
  } catch {
    // A read-only filesystem must not break classification.
  }
}

async function getJson(url: string): Promise<HtsRow[] | null> {
  if (config.offline) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
  try {
    const res = await config.fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as HtsRow[]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** exportList URL for a whole 4-digit heading (the API's `to` bound is inclusive of the next heading row). */
export function headingUrl(heading: string): string {
  const next = String(Number(heading) + 1).padStart(4, '0');
  return `${HTS_API_BASE}/exportList?from=${heading}&to=${next}&format=JSON&styles=false`;
}

export function searchUrl(keyword: string): string {
  return `${HTS_API_BASE}/search?keyword=${encodeURIComponent(keyword.trim())}`;
}

/**
 * Raw rows of a whole 4-digit heading, including unnumbered parent rows.
 * The whole heading is fetched (not just a subheading) so that sibling subheadings
 * (e.g. 6110.30 when 6110.20 was declared) and the heading text are always available.
 */
export function fetchHeadingRows(heading: string): Promise<HtsRow[] | null> {
  if (!/^\d{4}$/.test(heading)) return Promise.resolve(null);
  let p = headingMemo.get(heading);
  if (!p) {
    p = (async () => {
      const file = `${heading}.json`;
      const local = readJson(join(config.dataDir, 'hts', file)) ?? readJson(join(config.cacheDir, 'headings', file));
      if (local) return local;
      const rows = await getJson(headingUrl(heading));
      if (rows && rows.length > 0) writeCache('headings', file, rows);
      return rows && rows.length > 0 ? rows : null;
    })();
    headingMemo.set(heading, p);
  }
  return p;
}

/** Raw rows of a keyword search (omits unnumbered parents; candidate discovery only). */
export function fetchSearchRows(keyword: string): Promise<HtsRow[] | null> {
  const slug = searchSlug(keyword);
  if (!slug) return Promise.resolve(null);
  let p = searchMemo.get(slug);
  if (!p) {
    p = (async () => {
      const file = `${slug}.json`;
      const local = readJson(join(config.dataDir, 'hts-search', file)) ?? readJson(join(config.cacheDir, 'search', file));
      if (local) return local;
      const rows = await getJson(searchUrl(keyword));
      if (rows) writeCache('search', file, rows);
      return rows;
    })();
    searchMemo.set(slug, p);
  }
  return p;
}
