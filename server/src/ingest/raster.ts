/**
 * Pixel sources: PDF pages rendered by pdftoppm, and uploaded images decoded by sharp.
 * Everything is kept as raw 8-bit RGB in memory; PNG is only written once, for the UI.
 */
import sharp from 'sharp';
import { IngestError } from './errors.js';
import { DPI } from './textLayer.js';
import { runTool, type ToolPaths } from './tools.js';

export interface Raster {
  width: number;
  height: number;
  /** 3 = interleaved RGB, 1 = gray */
  channels: 1 | 3;
  data: Buffer;
}

/** Parse a binary PNM (P5 gray / P6 RGB, maxval 255) as written by pdftoppm. */
export function parsePnm(buf: Buffer): Raster {
  const magic = buf.toString('latin1', 0, 2);
  if (magic !== 'P6' && magic !== 'P5') throw new IngestError('BAD_INPUT', `Unexpected raster format '${magic}'`);
  const fields: number[] = [];
  let i = 2;
  while (fields.length < 3) {
    const c = buf[i];
    if (c === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i++; // comment to end of line
    } else if (c >= 0x30 && c <= 0x39) {
      let n = 0;
      while (buf[i] >= 0x30 && buf[i] <= 0x39) n = n * 10 + (buf[i++] - 0x30);
      fields.push(n);
      continue;
    } else if (i >= buf.length) {
      throw new IngestError('BAD_INPUT', 'Truncated PNM header');
    }
    i++;
  }
  i++; // single whitespace after maxval
  const [width, height, maxval] = fields;
  if (maxval !== 255) throw new IngestError('BAD_INPUT', `Unsupported PNM maxval ${maxval}`);
  const channels = magic === 'P6' ? 3 : 1;
  const size = width * height * channels;
  if (buf.length - i < size) throw new IngestError('BAD_INPUT', 'Truncated PNM data');
  return { width, height, channels, data: buf.subarray(i, i + size) };
}

/** Rasterize one PDF page at 300 DPI (PPM on stdout: ~40x faster than letting pdftoppm encode PNG). */
export async function renderPdfPage(paths: ToolPaths, pdfPath: string, page: number, dpi = DPI): Promise<Raster> {
  const { stdout } = await runTool(paths, 'pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), pdfPath]);
  return parsePnm(stdout);
}

/** Below this long side (px) an image is upscaled before OCR: the 300 DPI page size, since a photo of a sheet
 * (the page fills only part of the frame) has small text even at 2000+ px. */
export const MIN_LONG_SIDE = 3300;
/** Long side of a Letter/A4 page at 300 DPI, the upscale target when the image has no usable DPI. */
export const TARGET_LONG_SIDE = 3300;
const MAX_UPSCALE = 4;
/** Larger images are scaled down to this long side (memory and OCR time; ~600 DPI on A4). */
export const MAX_LONG_SIDE = 7000;

export interface ImagePage {
  raster: Raster;
  /** Factor applied to the original pixels (1 = untouched, > 1 upscaled, < 1 capped). */
  scale: number;
  /** Best estimate of the effective resolution after scaling, passed to tesseract. */
  dpi: number;
}

/**
 * Pick a scale factor: low-resolution images are brought toward ~300 DPI (using the embedded
 * density when it is plausible for a document page, else assuming a Letter/A4 page); huge ones
 * are capped at MAX_LONG_SIDE. Coordinates are reported in the scaled space.
 */
export function chooseUpscale(width: number, height: number, density?: number): { scale: number; dpi: number } {
  const long = Math.max(width, height);
  const d = density !== undefined && density >= 50 && density <= 1200 && long / density >= 4 && long / density <= 20 ? density : undefined;
  if (long > MAX_LONG_SIDE) {
    const scale = MAX_LONG_SIDE / long;
    return { scale, dpi: d !== undefined ? Math.round(d * scale) : DPI };
  }
  if (long >= MIN_LONG_SIDE) return { scale: 1, dpi: d ? Math.round(d) : DPI };
  const wanted = d !== undefined && d < DPI ? DPI / d : TARGET_LONG_SIDE / long;
  const scale = Math.min(MAX_UPSCALE, Math.max(1, wanted));
  return { scale, dpi: d !== undefined ? Math.round(d * scale) : DPI };
}

/** Number of frames in an image (multi-page TIFF), 1 for everything else. */
export async function imagePageCount(bytes: Uint8Array): Promise<number> {
  const meta = await sharp(bytes, { limitInputPixels: false }).metadata().catch(badImage);
  return meta.format === 'tiff' ? Math.max(1, meta.pages ?? 1) : 1;
}

function badImage(err: unknown): never {
  throw new IngestError('BAD_INPUT', `Could not decode image: ${(err as Error).message}`, undefined, { cause: err });
}

/**
 * Decode one frame of an uploaded image: honour EXIF orientation, flatten transparency onto white,
 * convert to sRGB, and upscale small images (coordinates stay in the upscaled space).
 */
export async function loadImagePage(bytes: Uint8Array, pageIndex = 0): Promise<ImagePage> {
  const base = () => sharp(bytes, { page: pageIndex, limitInputPixels: false });
  const meta = await base().metadata().catch(badImage);
  // EXIF orientations 5–8 swap width and height.
  const swap = (meta.orientation ?? 1) >= 5;
  const w = (swap ? meta.height : meta.width) ?? 0;
  const h = (swap ? meta.width : meta.height) ?? 0;
  if (!w || !h) throw new IngestError('BAD_INPUT', 'Image has no pixels');
  const { scale, dpi } = chooseUpscale(w, h, meta.density);
  let pipeline = base().rotate().flatten({ background: '#ffffff' }).toColourspace('srgb');
  if (scale !== 1) {
    pipeline = pipeline.resize({ width: Math.round(w * scale), height: Math.round(h * scale), kernel: 'lanczos3' });
  }
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true }).catch(badImage);
  if (info.channels !== 3) throw new IngestError('BAD_INPUT', `Unexpected channel count ${info.channels}`);
  return { raster: { width: info.width, height: info.height, channels: 3, data }, scale, dpi };
}

/** Write a raster as PNG (fast compression: these are cache artefacts for the UI). */
export async function savePng(raster: Raster, path: string): Promise<void> {
  await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: raster.channels } })
    .png({ compressionLevel: 3, adaptiveFiltering: false })
    .toFile(path);
}

/** Encode raw pixels as binary PNM (P5 gray / P6 RGB): leptonica reads it with no decode cost. */
export function encodePnm(data: Uint8Array, width: number, height: number, channels: 1 | 3): Buffer {
  const header = Buffer.from(`${channels === 3 ? 'P6' : 'P5'}\n${width} ${height}\n255\n`, 'latin1');
  return Buffer.concat([header, data]);
}

/** Rotate a raster by `deg` (clockwise positive) about its centre, keeping the canvas size (white fill). */
export async function rotateRaster(raster: Raster, deg: number): Promise<Raster> {
  const { width, height, channels } = raster;
  const rotated = await sharp(raster.data, { raw: { width, height, channels } })
    .rotate(deg, { background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // sharp grows the canvas to fit the rotated image (same centre); crop back to the original frame.
  const left = Math.max(0, Math.round((rotated.info.width - width) / 2));
  const top = Math.max(0, Math.round((rotated.info.height - height) / 2));
  let out = sharp(rotated.data, { raw: { width: rotated.info.width, height: rotated.info.height, channels: rotated.info.channels } }).extract({
    left,
    top,
    width: Math.min(width, rotated.info.width),
    height: Math.min(height, rotated.info.height),
  });
  out = channels === 1 ? out.extractChannel(0) : out.removeAlpha();
  const { data, info } = await out.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels, data };
}
