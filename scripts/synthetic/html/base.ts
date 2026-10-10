/**
 * Small helpers shared by the document templates: escaping and a page wrapper that pins the
 * paper size with CSS @page so Chromium prints exactly the intended number of pages.
 */

/** Escapes text for HTML element content and attribute values. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapes, then turns newlines into <br> (for address blocks written as multi-line strings). */
export function lines(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

const PAPER = {
  A4: { w: '210mm', h: '297mm' },
  Letter: { w: '8.5in', h: '11in' },
} as const;

/**
 * Wraps page bodies into a full HTML document. Each entry of `pages` becomes one fixed-size
 * printed page (overflow hidden), so a template can never spill onto an unplanned extra page.
 */
export function htmlDocument(opts: { format: 'A4' | 'Letter'; css: string; pages: string[]; lang?: string }): string {
  const p = PAPER[opts.format];
  return `<!doctype html>
<html lang="${opts.lang ?? 'en'}"><head><meta charset="utf-8">
<style>
@page { size: ${opts.format}; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; color: #111; }
.sheet { width: ${p.w}; height: ${p.h}; overflow: hidden; position: relative; page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
table { border-collapse: collapse; }
${opts.css}
</style></head>
<body>${opts.pages.map((b) => `<div class="sheet">${b}</div>`).join('\n')}</body></html>`;
}
