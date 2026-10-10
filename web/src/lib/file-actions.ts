/**
 * Clipboard and download helpers. Kept separate from components so the browser APIs they touch
 * (navigator.clipboard, URL.createObjectURL) can be stubbed in tests.
 */

/** Copies text, falling back to a hidden textarea + execCommand where the async API is unavailable (e.g. plain http). */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!ok) throw new Error('Copy is not supported in this browser.');
  } finally {
    textarea.remove();
  }
}

/** Saves text as a file via a temporary object URL. */
export function downloadText(text: string, fileName: string, mime = 'application/xml'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 250);
}
