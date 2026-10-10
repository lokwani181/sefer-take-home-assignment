import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentLayout, ExtractedDocument } from '@app/shared';

const dir = join(import.meta.dirname, '..', 'fixtures', 'sample');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

describe('sample fixtures match the shared contracts', () => {
  it.each(['invoice', 'packing-list', 'bill-of-lading'])('%s layout has pages, words and lines', (slug) => {
    const layout = load<DocumentLayout>(`${slug}.layout.json`);
    expect(layout.pages.length).toBeGreaterThan(0);
    for (const page of layout.pages) {
      expect(page.words.length).toBeGreaterThan(100);
      expect(page.lines.length).toBeGreaterThan(10);
      expect(['text', 'ocr']).toContain(page.source);
    }
  });

  it.each(['invoice', 'packing-list', 'bill-of-lading'])('%s ground truth is a well-formed ExtractedDocument', (slug) => {
    const doc = load<ExtractedDocument>(`${slug}.expected.json`);
    expect(doc.docId).toMatch(/^sample-/);
    expect(doc.data.kind).toBeTruthy();
    expect(Array.isArray(doc.observations)).toBe(true);
  });
});
