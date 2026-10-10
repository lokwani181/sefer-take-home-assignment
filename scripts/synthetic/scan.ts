/**
 * Simulated scanning: rasterize a clean PDF, then make it look like a paper scan
 * (rubber stamps, off-white paper, skew, blur, sensor noise, dust) and wrap the image
 * into an image-only PDF. Everything random comes from a seeded PRNG so output is stable.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createRng, type Rng } from './prng.js';
import { FIXED_PDF_DATE, PRODUCER, type PdfMetadata } from './render-pdf.js';
import type { ScanOptions, StampSpec } from './spec.js';

const execFileP = promisify(execFile);

/** Renders every page of a PDF to PNG with poppler (`pdftoppm -r <dpi>`), in page order. */
export async function rasterizePdf(pdf: Uint8Array, dpi: number): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-raster-'));
  try {
    const input = join(dir, 'in.pdf');
    await writeFile(input, pdf);
    await execFileP('pdftoppm', ['-r', String(dpi), '-png', input, join(dir, 'p')]);
    const pageNo = (f: string): number => Number(/-(\d+)\.png$/.exec(f)?.[1] ?? 0);
    const files = (await readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => pageNo(a) - pageNo(b));
    return Promise.all(files.map((f) => readFile(join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Smooth value noise in [0,1] (bilinear interpolation of a random grid with `cell` px spacing). */
export function valueNoise(rng: Rng, width: number, height: number, cell: number): Float32Array {
  const gw = Math.ceil(width / cell) + 2;
  const gh = Math.ceil(height / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = y / cell;
    const y0 = Math.floor(gy);
    let ty = gy - y0;
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < width; x++) {
      const gx = x / cell;
      const x0 = Math.floor(gx);
      let tx = gx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * width + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rough advance widths (in em) of bold Arial capitals; enough to space glyphs around an arc. */
function glyphEm(ch: string): number {
  if (ch === ' ') return 0.3;
  if ('.,\'I:;'.includes(ch)) return 0.32;
  if ('MW&'.includes(ch)) return 0.86;
  return 0.7;
}

/**
 * Text set around the top of a circle, one glyph per <text> element (librsvg has no textPath).
 * `rOuter` is where the glyph tops should touch; glyphs stand upright, centred on 12 o'clock.
 */
function arcText(text: string, c: number, rOuter: number, fontPx: number, col: string): string[] {
  const rBase = rOuter - fontPx * 0.78;
  const widths = [...text].map((ch) => glyphEm(ch) * fontPx);
  const total = widths.reduce((s, w) => s + w, 0);
  const out: string[] = [];
  let acc = 0;
  for (const [i, ch] of [...text].entries()) {
    const mid = acc + widths[i] / 2;
    acc += widths[i];
    if (ch === ' ') continue;
    const ang = -Math.PI / 2 + (mid - total / 2) / rBase;
    const x = c + rBase * Math.cos(ang);
    const y = c + rBase * Math.sin(ang);
    const deg = (ang * 180) / Math.PI + 90;
    out.push(
      `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" transform="rotate(${deg.toFixed(3)} ${x.toFixed(2)} ${y.toFixed(2)})" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fontPx.toFixed(2)}" fill="${col}">${escapeXml(ch)}</text>`,
    );
  }
  return out;
}

/** Builds the stamp as SVG (frame + text, rotated) on a square canvas big enough for any angle. */
function stampSvg(stamp: StampSpec, pxPerMm: number): { svg: string; size: number } {
  const w = stamp.wMm * pxPerMm;
  const h = stamp.hMm * pxPerMm;
  const size = Math.ceil(Math.hypot(w, h)) + 8;
  const c = size / 2;
  const stroke = 0.75 * pxPerMm;
  const parts: string[] = [];
  const col = stamp.color;
  if (stamp.frame === 'box' || stamp.frame === 'double') {
    parts.push(
      `<rect x="${c - w / 2}" y="${c - h / 2}" width="${w}" height="${h}" rx="${h * 0.08}" fill="none" stroke="${col}" stroke-width="${stroke}"/>`,
    );
    if (stamp.frame === 'double') {
      const inset = 1.3 * pxPerMm;
      parts.push(
        `<rect x="${c - w / 2 + inset}" y="${c - h / 2 + inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${h * 0.06}" fill="none" stroke="${col}" stroke-width="${stroke * 0.45}"/>`,
      );
    }
  } else if (stamp.frame === 'round') {
    const r = w / 2;
    parts.push(`<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke * 1.2}"/>`);
    parts.push(`<circle cx="${c}" cy="${c}" r="${r - 1.6 * pxPerMm}" fill="none" stroke="${col}" stroke-width="${stroke * 0.4}"/>`);
    // five-pointed star in the centre, as on East Asian company chops
    const rs = r * 0.24;
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? rs : rs * 0.42;
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${c + rr * Math.cos(ang)},${c - r * 0.05 + rr * Math.sin(ang)}`);
    }
    parts.push(`<polygon points="${pts.join(' ')}" fill="${col}"/>`);
    if (stamp.arcText) parts.push(...arcText(stamp.arcText, c, r - 2.2 * pxPerMm, 2.5 * pxPerMm, col));
  }
  const lineHeights = stamp.lines.map((l) => l.sizeMm * pxPerMm * 1.18);
  const total = lineHeights.reduce((s, v) => s + v, 0);
  const yOffset = stamp.frame === 'round' ? h * 0.22 : 0;
  let y = c - total / 2 + yOffset;
  for (const [i, line] of stamp.lines.entries()) {
    const fs = line.sizeMm * pxPerMm;
    y += lineHeights[i];
    const fit = line.fit ? ` textLength="${w - 4 * pxPerMm}" lengthAdjust="spacingAndGlyphs"` : '';
    parts.push(
      `<text x="${c}" y="${y - lineHeights[i] * 0.2}" text-anchor="middle" font-family="${line.font ?? 'Arial, Helvetica, sans-serif'}" font-weight="${line.bold ? 'bold' : 'normal'}" font-size="${fs}" fill="${col}"${fit}>${escapeXml(line.text)}</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><g transform="rotate(${stamp.angleDeg} ${c} ${c})">${parts.join('')}</g></svg>`;
  return { svg, size };
}

/** Rasterizes a stamp and gives it uneven ink: soft blotches plus fine grain in the alpha channel. */
export async function renderStamp(
  stamp: StampSpec,
  dpi: number,
  rng: Rng,
): Promise<{ data: Buffer; size: number; left: number; top: number }> {
  const pxPerMm = dpi / 25.4;
  const { svg, size } = stampSvg(stamp, pxPerMm);
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const blotch = valueNoise(rng, size, size, Math.max(8, Math.round(2.2 * pxPerMm)));
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const a = data[p + 3];
    if (a === 0) continue;
    const ink = Math.min(1, Math.max(0, (0.42 + 0.78 * blotch[i]) * (1 + 0.2 * rng.gauss())));
    data[p + 3] = Math.round(a * stamp.opacity * ink);
  }
  const left = Math.round(stamp.cxMm * pxPerMm - size / 2);
  const top = Math.round(stamp.cyMm * pxPerMm - size / 2);
  return { data, size, left, top };
}

/** Applies the full scan look to one rendered page; returns JPEG bytes and pixel size. */
async function scanPage(
  png: Buffer,
  pageIndex: number,
  opts: ScanOptions,
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const rng = createRng(`${opts.seed}#page${pageIndex + 1}`);
  let img = sharp(png).removeAlpha();
  const stamps = opts.stamps.filter((s) => (s.page ?? 1) === pageIndex + 1);
  if (stamps.length > 0) {
    const layers = [];
    for (const s of stamps) {
      const st = await renderStamp(s, opts.dpi, rng);
      layers.push({
        input: st.data,
        raw: { width: st.size, height: st.size, channels: 4 as const },
        left: st.left,
        top: st.top,
        blend: 'multiply' as const,
      });
    }
    img = sharp(await img.composite(layers).png().toBuffer()).removeAlpha();
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // Paper: off-white tint, slightly lifted blacks, gentle uneven illumination, dust specks.
  const illum = valueNoise(rng, width, height, 420);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const light = 0.965 + 0.035 * illum[i];
    for (let ch = 0; ch < 3; ch++) {
      const v = data[p + ch] / 255;
      data[p + ch] = Math.round((16 + v * (opts.paper[ch] - 16)) * light);
    }
  }
  const specks = Math.round((opts.specklesPerMp * width * height) / 1e6);
  for (let k = 0; k < specks; k++) {
    const cx = Math.floor(rng.next() * width);
    const cy = Math.floor(rng.next() * height);
    const r = 0.6 + rng.next() * 1.4;
    const dark = 60 + Math.floor(rng.next() * 110);
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const p = (y * width + x) * channels;
        for (let ch = 0; ch < 3; ch++) data[p + ch] = Math.min(data[p + ch], dark);
      }
    }
  }

  // Skew: rotate on the scanner bed, then crop back to the original page size.
  const [br, bg, bb] = opts.bed;
  const rotated = await sharp(data, { raw: { width, height, channels } })
    .rotate(opts.rotateDeg, { background: { r: br, g: bg, b: bb } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let cropped = sharp(rotated.data, { raw: { width: rotated.info.width, height: rotated.info.height, channels: rotated.info.channels } })
    .extract({
      left: Math.floor((rotated.info.width - width) / 2),
      top: Math.floor((rotated.info.height - height) / 2),
      width,
      height,
    });
  if (opts.blurSigma >= 0.3) cropped = cropped.blur(opts.blurSigma);
  const blurred = await cropped.removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // Sensor noise (luma only).
  const px = blurred.data;
  const bc = blurred.info.channels;
  for (let i = 0, p = 0; i < width * height; i++, p += bc) {
    const n = rng.gauss() * opts.noiseSigma;
    for (let ch = 0; ch < 3; ch++) px[p + ch] = Math.max(0, Math.min(255, Math.round(px[p + ch] + n)));
  }
  const jpeg = await sharp(px, { raw: { width, height, channels: bc } })
    .jpeg({ quality: opts.jpegQuality, chromaSubsampling: '4:2:0' })
    .toBuffer();
  return { jpeg, width, height };
}

/** Turns a clean PDF into an image-only "scanned" PDF (one JPEG per page, no text layer). */
export async function scanPdf(pdf: Uint8Array, opts: ScanOptions, meta: PdfMetadata): Promise<Uint8Array> {
  const pngs = await rasterizePdf(pdf, opts.dpi);
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const [i, png] of pngs.entries()) {
    const { jpeg, width, height } = await scanPage(png, i, opts);
    const image = await doc.embedJpg(jpeg);
    const wPt = (width * 72) / opts.dpi;
    const hPt = (height * 72) / opts.dpi;
    const page = doc.addPage([wPt, hPt]);
    page.drawImage(image, { x: 0, y: 0, width: wPt, height: hPt });
  }
  doc.setTitle(meta.title);
  doc.setAuthor(meta.author);
  doc.setCreator(meta.creator);
  doc.setProducer(PRODUCER);
  doc.setCreationDate(FIXED_PDF_DATE);
  doc.setModificationDate(FIXED_PDF_DATE);
  return doc.save({ useObjectStreams: false });
}
