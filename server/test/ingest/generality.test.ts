/**
 * Generality checks on synthetic pages (nothing from the sample shipment): coloured print vs
 * stamps, and deskew of a page rotated by a known angle. Pages are drawn as SVG and rasterized by
 * sharp at 300 DPI.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentLayout } from '@app/shared';
import { BLUE_PREFIX, createIngest } from '../../src/ingest/index.js';
import { recall } from './tokens.js';

const W = 2480;
const H = 3508;

/** An A4 page: red letterhead, blue form label, black body, a rotated red and a rotated blue stamp. */
function pageSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#fbf8f0"/>
  <text x="200" y="300" font-family="Helvetica, Arial, sans-serif" font-size="90" font-weight="bold" fill="#c62828">COMMERCIAL INVOICE</text>
  <text x="200" y="480" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#1f3c99">Consignee (name and address)</text>
  <g font-family="Courier New, monospace" font-size="46" fill="#111">
    <text x="200" y="560">ORCHARD HOME GOODS LLC</text>
    <text x="200" y="700">Invoice No: ACME-7731</text>
    <text x="200" y="800">Date: 2026-03-14</text>
    <text x="200" y="1000">Qty 120  Unit Price 4.25  Amount 510.00</text>
    <text x="200" y="1100">Qty 300  Unit Price 1.10  Amount 330.00</text>
    <text x="200" y="1300">TOTAL USD 840.00</text>
    <text x="200" y="1500">Payment terms: 30 days net</text>
    <text x="200" y="1600">Country of origin: Portugal</text>
  </g>
  <g transform="rotate(-12 1500 1150)">
    <rect x="1150" y="1050" width="700" height="200" fill="none" stroke="#d32f2f" stroke-width="12"/>
    <text x="1500" y="1180" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="110" font-weight="bold" fill="#d32f2f" fill-opacity="0.85">PAID</text>
  </g>
  <g transform="rotate(7 1400 2100)">
    <rect x="950" y="1980" width="900" height="240" fill="none" stroke="#2438a8" stroke-width="10"/>
    <text x="1400" y="2085" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="90" font-weight="bold" fill="#2438a8">RECEIVED</text>
    <text x="1400" y="2180" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="60" fill="#2438a8">MAR 20 2026</text>
  </g>
</svg>`;
}

async function pagePng(rotateDeg = 0): Promise<Uint8Array> {
  let img = sharp(Buffer.from(pageSvg()), { density: 72 }).flatten({ background: '#fbf8f0' });
  if (rotateDeg) {
    const flat = await img.png().toBuffer();
    img = sharp(flat).rotate(rotateDeg, { background: '#fbf8f0' }).resize({ width: W, height: H, fit: 'cover' });
  }
  return new Uint8Array(await img.png().withMetadata({ density: 300 }).toBuffer());
}

const lineTexts = (l: DocumentLayout) => l.pages[0].lines.map((x) => x.text);

let dir: string;
let straight: DocumentLayout;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-general-'));
  straight = await createIngest({ cache: false, cacheDir: dir })({ name: 'synthetic.png', mime: 'image/png', bytes: await pagePng() });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('coloured print vs stamps (synthetic page)', () => {
  it('reads the black body text', () => {
    const words = straight.pages[0].words;
    expect(recall(words, ['ACME-7731', '2026-03-14', '510.00', '330.00', '840.00', 'Portugal', 'ORCHARD'], 80).missing).toEqual([]);
  });

  it('keeps a red letterhead on the page even though red ink is suppressed for OCR', () => {
    expect(lineTexts(straight)).toContain('COMMERCIAL INVOICE');
  });

  it('keeps blue form labels on the page (blue is not suppressed)', () => {
    expect(lineTexts(straight).some((t) => /Consignee/.test(t))).toBe(true);
  });

  it('reads the rotated red stamp and the rotated blue stamp into stamps', () => {
    const stamps = straight.pages[0].stamps ?? [];
    expect(stamps.some((s) => !s.startsWith(BLUE_PREFIX) && /PAID/.test(s))).toBe(true);
    expect(stamps.some((s) => s.startsWith(BLUE_PREFIX) && /RECEIVED/.test(s))).toBe(true);
    // The blue label is ordinary print read well by the main pass, so it is not a stamp.
    expect(stamps.some((s) => /Consignee/.test(s))).toBe(false);
  });

  it('without the colour pass, nothing is suppressed, so the letterhead is still read', async () => {
    const plain = await createIngest({ cache: false, cacheDir: dir, stamps: false })({ name: 'synthetic.png', mime: 'image/png', bytes: await pagePng() });
    expect(lineTexts(plain)).toContain('COMMERCIAL INVOICE');
    expect(plain.pages[0].stamps).toBeUndefined();
  });
});

describe('deskew (synthetic page rotated by a known angle)', () => {
  it.each([1.5, -2])('measures %s° and straightens the rows', async (deg) => {
    const layout = await createIngest({ cache: false, cacheDir: dir, stamps: false, secondPass: false })({ name: `rot${deg}.png`, mime: 'image/png', bytes: await pagePng(deg) });
    const [p] = layout.pages;
    expect(Math.abs(p.skewDeg - deg)).toBeLessThanOrEqual(0.3);
    // After deskew each printed row is one line: every value of a row lands on the same line.
    const sameLine = (...tokens: string[]) => p.lines.some((l) => recall(l.words, tokens, 0).missing.length === 0);
    expect(sameLine('Qty', '120', '4.25', '510.00')).toBe(true);
    expect(sameLine('Qty', '300', '1.10', '330.00')).toBe(true);
    expect(sameLine('120', '330.00')).toBe(false);
  });
});
