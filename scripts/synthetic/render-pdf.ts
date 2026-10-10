/**
 * HTML → PDF with Playwright's Chromium, then a metadata normalization pass with pdf-lib.
 * Chromium stamps the current time and a random /ID into every PDF; replacing those with fixed
 * values is what makes the generator's output byte-stable across runs.
 */
import type { Browser } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';

/** All synthetic PDFs carry this creation/modification date instead of the wall clock. */
export const FIXED_PDF_DATE = new Date('2026-01-01T00:00:00Z');
export const PRODUCER = 'make-synthetic.ts (Chromium + pdf-lib)';

/** Renders one HTML document to PDF bytes. The HTML controls page size via CSS @page. */
export async function renderHtmlToPdf(browser: Browser, html: string, format: 'A4' | 'Letter'): Promise<Uint8Array> {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const pdf = await page.pdf({
      format,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return new Uint8Array(pdf);
  } finally {
    await context.close();
  }
}

export interface PdfMetadata {
  title: string;
  author: string;
  creator: string;
}

/**
 * Rewrites a PDF with fixed metadata: no trailer /ID, no XMP stream, fixed dates and producer.
 * Content streams are untouched, so the text layer is preserved exactly.
 */
export async function normalizePdf(bytes: Uint8Array, meta: PdfMetadata): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  delete doc.context.trailerInfo.ID;
  doc.catalog.delete(PDFName.of('Metadata'));
  doc.setTitle(meta.title);
  doc.setAuthor(meta.author);
  doc.setCreator(meta.creator);
  doc.setProducer(PRODUCER);
  doc.setCreationDate(FIXED_PDF_DATE);
  doc.setModificationDate(FIXED_PDF_DATE);
  return doc.save({ useObjectStreams: false });
}

/** Page count of a PDF (used to assert each document is 1–2 pages as specified). */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}
