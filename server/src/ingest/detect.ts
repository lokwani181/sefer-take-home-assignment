/**
 * File-type detection from magic bytes (the browser-supplied mime type and extension are only hints).
 */
import { IngestError } from './errors.js';

export type FileKind = 'pdf' | 'png' | 'jpeg' | 'tiff' | 'webp';

export const KIND_MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  tif: 'tiff',
  tiff: 'tiff',
  webp: 'webp',
};

function sniff(b: Uint8Array): FileKind | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  // %PDF may be preceded by a little junk; the spec allows it within the first 1 KB.
  const head = Buffer.from(b.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return null;
}

/** Decide how to read an upload. Magic bytes win; mime/extension are used only to explain errors. */
export function detectKind(bytes: Uint8Array, name: string, mime: string): FileKind {
  if (bytes.length === 0) throw new IngestError('BAD_INPUT', `'${name}' is empty`);
  const kind = sniff(bytes);
  if (kind) return kind;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const claimed = EXT_KIND[ext] ?? Object.entries(KIND_MIME).find(([, m]) => m === mime)?.[0];
  throw new IngestError(
    'UNSUPPORTED_FILE',
    claimed
      ? `'${name}' claims to be ${claimed.toUpperCase()} but its content is not a readable ${claimed.toUpperCase()} file`
      : `'${name}' is not a supported document (PDF, PNG, JPEG, TIFF or WebP)`,
  );
}
