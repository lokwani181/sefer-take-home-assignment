/**
 * On-disk cache: server/.cache/ocr/<sha256>/{layout.json,page-<n>.png}.
 * A layout is reused only if it was produced by the same PIPELINE_VERSION and options.
 */
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentLayout } from '@app/shared';

/** Bump whenever ingest output changes for the same input bytes (invalidates cached layouts). */
export const PIPELINE_VERSION = 'ingest-2026.10.5';

/** server/.cache/ocr, resolved from this file so it does not depend on the process cwd. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INGEST_CACHE_DIR) return resolve(env.INGEST_CACHE_DIR);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'ocr');
}

/** Caching of layout.json is on unless INGEST_CACHE=0/false/off. */
export function cacheEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.INGEST_CACHE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

interface CacheEntry {
  pipelineVersion: string;
  optionsKey: string;
  layout: DocumentLayout;
}

export function docDir(cacheDir: string, sha256: string): string {
  return join(cacheDir, sha256);
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Return the cached layout, or null when missing, stale, or its page images are gone. */
export async function readCachedLayout(cacheDir: string, sha256: string, optionsKey: string): Promise<DocumentLayout | null> {
  try {
    const raw = await readFile(join(docDir(cacheDir, sha256), 'layout.json'), 'utf8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.pipelineVersion !== PIPELINE_VERSION || entry.optionsKey !== optionsKey) return null;
    for (const p of entry.layout.pages) if (p.imagePath && !(await exists(p.imagePath))) return null;
    return entry.layout;
  } catch {
    return null;
  }
}

/** Write atomically (temp file + rename) so a concurrent reader never sees half a file. */
export async function writeCachedLayout(cacheDir: string, layout: DocumentLayout, optionsKey: string): Promise<void> {
  const dir = docDir(cacheDir, layout.sha256);
  await mkdir(dir, { recursive: true });
  const entry: CacheEntry = { pipelineVersion: PIPELINE_VERSION, optionsKey, layout };
  const tmp = join(dir, `layout.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(entry));
  await rename(tmp, join(dir, 'layout.json'));
}
