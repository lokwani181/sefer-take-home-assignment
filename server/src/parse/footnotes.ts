/**
 * Footnotes and notes: splitting a notes block into paragraphs by their markers
 * ("(*)", "**", "(1)", "1.", "Note 2:") and finding the markers attached to table rows,
 * so that remarks such as "(*) Style X: buyer supplied fabric ..." reach the right line.
 */

export interface NoteParagraph {
  /** Normalized marker: "*", "**", "1", ... (undefined for unmarked paragraphs). */
  marker?: string;
  text: string;
}

const NOTE_START_RE = /^(?:\((\*{1,3})\)|(\*{1,3})(?=\s)|\((\d{1,2})\)|(\d{1,2})[.)](?=\s)|NOTE\s*(\d{1,2})\s*[:.]|\[(\d{1,2})\])\s*/i;

/** Normalizes a marker token: "(*)" → "*", "(2)" → "2", "**" → "**". */
export function normalizeMarker(m: string): string {
  return m.replace(/[()[\]\s]/g, '');
}

/** Splits note lines into paragraphs: a marker at the start of a line opens a new paragraph. */
export function splitNotes(lines: string[]): NoteParagraph[] {
  const out: NoteParagraph[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = NOTE_START_RE.exec(line);
    if (m) {
      const marker = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
      out.push({ marker, text: line });
    } else if (out.length) out[out.length - 1].text += ` ${line}`;
    else out.push({ text: line });
  }
  return out;
}

/** Footnote markers attached to a row: standalone "*", "**", "(*)" and "see note (1)". */
export function findMarkers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)(\(\*{1,3}\)|\*{1,3})(?=\s|$|[.,;])/g)) out.add(normalizeMarker(m[1]));
  for (const m of text.matchAll(/\b(?:SEE\s+)?(?:NOTE|REMARK|FOOTNOTE)S?\s*(?:NO\.?\s*)?\(?(\d{1,2}|\*{1,3})\)?/gi)) out.add(normalizeMarker(m[1]));
  return [...out];
}

/** Markers that a remark itself carries anywhere in its text (e.g. "3. ** Carton No. 138: ..."). */
export function markersInNote(p: NoteParagraph): string[] {
  const out = new Set<string>();
  if (p.marker) out.add(p.marker);
  for (const m of p.text.matchAll(/(?:^|\s)(\*{1,3})(?=\s)/g)) out.add(m[1]);
  return [...out];
}
