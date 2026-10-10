/**
 * Simulated phone photo of a printed page: the sheet lies on a desk, slightly rotated, with a
 * soft drop shadow, uneven indoor light (gradient + vignette + warm cast), a little defocus,
 * sensor noise, and is saved as a ~1600 px wide JPEG (much lower resolution than a 300-dpi
 * scan). Everything random comes from a seeded PRNG, so the output is byte-stable.
 */
import sharp from 'sharp';
import { createRng, type Rng } from './prng.js';
import { rasterizePdf, renderStamp, valueNoise } from './scan.js';
import type { PhotoOptions, StampSpec } from './spec.js';

/** Composites rubber stamps onto a rasterized page (same ink model as the scanner simulation). */
async function stampPage(png: Buffer, stamps: StampSpec[], dpi: number, rng: Rng): Promise<Buffer> {
  if (stamps.length === 0) return png;
  const layers = [];
  for (const s of stamps) {
    const st = await renderStamp(s, dpi, rng);
    layers.push({
      input: st.data,
      raw: { width: st.size, height: st.size, channels: 4 as const },
      left: st.left,
      top: st.top,
      blend: 'multiply' as const,
    });
  }
  return sharp(png).removeAlpha().composite(layers).png().toBuffer();
}

/** Turns page 1 of a clean PDF into JPEG bytes that look like a phone photo of the printout. */
export async function photographPdf(pdf: Uint8Array, opts: PhotoOptions): Promise<Buffer> {
  const pages = await rasterizePdf(pdf, opts.dpi);
  if (pages.length !== 1) throw new Error(`photo variant needs a 1-page document, got ${pages.length}`);
  const rng = createRng(opts.seed);
  const W = opts.frameWidth;
  const H = opts.frameHeight;

  // 1. Stamps on the flat page, then scale the sheet to its size in the frame.
  const stamped = await stampPage(pages[0], opts.stamps, opts.dpi, rng);
  const sheet = await sharp(stamped)
    .removeAlpha()
    .resize({ width: opts.paperWidth, kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Paper colour (white → off-white, black stays a little lifted like printer toner on paper).
  const sp = sheet.data;
  for (let p = 0; p < sp.length; p += sheet.info.channels) {
    for (let ch = 0; ch < 3; ch++) sp[p + ch] = Math.round(22 + (sp[p + ch] / 255) * (opts.paper[ch] - 22));
  }

  // 3. Rotate the sheet on a transparent background.
  const rotated = await sharp(sp, { raw: { width: sheet.info.width, height: sheet.info.height, channels: sheet.info.channels } })
    .ensureAlpha()
    .rotate(opts.rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rw = rotated.info.width;
  const rh = rotated.info.height;
  const rc = rotated.info.channels;
  const left = Math.round((W - rw) / 2 + opts.offset[0]);
  const top = Math.round((H - rh) / 2 + opts.offset[1]);

  // 4. Soft drop shadow from the sheet's alpha, offset down-right.
  const alpha = Buffer.alloc(rw * rh);
  for (let i = 0; i < rw * rh; i++) alpha[i] = rotated.data[i * rc + 3];
  const shadow = await sharp(alpha, { raw: { width: rw, height: rh, channels: 1 } }).blur(14).raw().toBuffer();
  const shadowDx = 10;
  const shadowDy = 16;

  // 5. Desk: base colour with a low-frequency mottle and fine grain.
  const out = new Float32Array(W * H * 3);
  const mottle = valueNoise(rng, W, H, 180);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const m = 0.9 + 0.2 * mottle[i] + 0.03 * rng.gauss();
      for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = opts.desk[ch] * m;
    }
  }
  // Shadow darkens the desk under and beside the sheet.
  for (let y = 0; y < rh; y++) {
    const fy = y + top + shadowDy;
    if (fy < 0 || fy >= H) continue;
    for (let x = 0; x < rw; x++) {
      const fx = x + left + shadowDx;
      if (fx < 0 || fx >= W) continue;
      const k = 1 - 0.5 * (shadow[y * rw + x] / 255);
      const i = (fy * W + fx) * 3;
      out[i] *= k;
      out[i + 1] *= k;
      out[i + 2] *= k;
    }
  }
  // Sheet over desk.
  for (let y = 0; y < rh; y++) {
    const fy = y + top;
    if (fy < 0 || fy >= H) continue;
    for (let x = 0; x < rw; x++) {
      const fx = x + left;
      if (fx < 0 || fx >= W) continue;
      const p = (y * rw + x) * rc;
      const a = rotated.data[p + 3] / 255;
      if (a === 0) continue;
      const i = (fy * W + fx) * 3;
      for (let ch = 0; ch < 3; ch++) out[i + ch] = rotated.data[p + ch] * a + out[i + ch] * (1 - a);
    }
  }

  // 6. Uneven light: brighter top-left, falling off to the bottom-right, darker corners,
  //    a gentle uneven wash, and a warm colour cast.
  const wash = valueNoise(rng, W, H, 520);
  const cx = W * 0.42;
  const cy = H * 0.38;
  const rMax = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lin = (0.4 * x) / W + (0.6 * y) / H;
      const r = Math.hypot(x - cx, y - cy) / rMax;
      const light = (1 - opts.gradient * lin) * (1 - opts.vignette * r * r) * (0.97 + 0.06 * wash[i]);
      for (let ch = 0; ch < 3; ch++) {
        rgb[i * 3 + ch] = Math.max(0, Math.min(255, Math.round(out[i * 3 + ch] * light * opts.tint[ch])));
      }
    }
  }

  // 7. Defocus, then sensor noise (stronger in the shadows), then JPEG.
  let focus = sharp(rgb, { raw: { width: W, height: H, channels: 3 } });
  if (opts.blurSigma >= 0.3) focus = focus.blur(opts.blurSigma);
  const blurred = await focus.raw().toBuffer();
  for (let i = 0; i < W * H; i++) {
    const p = i * 3;
    const luma = (blurred[p] + blurred[p + 1] + blurred[p + 2]) / 765;
    const n = rng.gauss() * opts.noiseSigma * (1.4 - 0.6 * luma);
    for (let ch = 0; ch < 3; ch++) blurred[p + ch] = Math.max(0, Math.min(255, Math.round(blurred[p + ch] + n)));
  }
  return sharp(blurred, { raw: { width: W, height: H, channels: 3 } })
    .withMetadata({ density: opts.density })
    .jpeg({ quality: opts.jpegQuality, chromaSubsampling: '4:2:0' })
    .toBuffer();
}
