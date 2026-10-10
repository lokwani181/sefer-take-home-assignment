import { MAX_FILES } from '../api/client';

/** Client-side checks for the upload list, mirroring the server's limits so users get instant feedback. */

export const ACCEPTED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff'] as const;
export const ACCEPT_ATTRIBUTE = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/png,image/jpeg,image/tiff';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const extensionOf = (name: string) => name.toLowerCase().split('.').pop() ?? '';

export function isAcceptedFile(file: File): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));
}

export const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

export interface MergeResult {
  files: File[];
  rejected: string[];
}

/**
 * Adds new files to the current selection: skips duplicates, rejects unsupported types and
 * oversized files, and caps the list at MAX_FILES. Returns human-readable rejection reasons.
 */
export function mergeFiles(current: File[], incoming: File[]): MergeResult {
  const files = [...current];
  const rejected: string[] = [];
  const seen = new Set(current.map(fileKey));
  for (const file of incoming) {
    if (seen.has(fileKey(file))) continue;
    if (!isAcceptedFile(file)) {
      rejected.push(`${file.name}: unsupported type (use PDF, PNG, JPG or TIFF)`);
    } else if (file.size > MAX_FILE_BYTES) {
      rejected.push(`${file.name}: larger than 20 MB`);
    } else if (files.length >= MAX_FILES) {
      rejected.push(`${file.name}: at most ${MAX_FILES} files per shipment`);
    } else {
      files.push(file);
      seen.add(fileKey(file));
    }
  }
  return { files, rejected };
}

export const fileKind = (file: File) => (extensionOf(file.name) === 'pdf' ? 'PDF' : 'Image');
