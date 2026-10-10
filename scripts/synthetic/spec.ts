/**
 * Types for a synthetic shipment specification: the documents to render (HTML + how to
 * post-process them) and the hand-checked expectations that go into expected.json.
 */
import type { DocType } from '@app/shared';
import type { ExpectedShipmentInput } from './expected-schema.js';

export interface StampLine {
  text: string;
  /** Cap-height-ish font size in millimetres on the page. */
  sizeMm: number;
  bold?: boolean;
  font?: string;
  /** Stretch the line to the inner width of the frame. */
  fit?: boolean;
}

/** A rubber stamp drawn in SVG and composited onto the rasterized page. */
export interface StampSpec {
  /** 1-based page number (default 1). */
  page?: number;
  /** Centre of the stamp in millimetres from the page's top-left corner. */
  cxMm: number;
  cyMm: number;
  /** Frame size in millimetres (diameter for 'round'). */
  wMm: number;
  hMm: number;
  angleDeg: number;
  lines: StampLine[];
  /** For 'round' stamps: text set along the upper arc. */
  arcText?: string;
  color: string;
  /** 0–1, applied on top of the ink-texture mask. */
  opacity: number;
  frame: 'box' | 'double' | 'round' | 'none';
}

/** Parameters of the simulated scan. Same parameters + same input ⇒ identical bytes. */
export interface ScanOptions {
  seed: string;
  /** Rasterization resolution (pdftoppm -r). */
  dpi: number;
  /** Page rotation in degrees, positive = clockwise. */
  rotateDeg: number;
  /** Std-dev of per-pixel luma noise (0–255 scale). */
  noiseSigma: number;
  /** Gaussian blur sigma in pixels (≥ 0.3 or 0 for none). */
  blurSigma: number;
  /** Paper colour multiplied into the page (off-white). */
  paper: [number, number, number];
  /** Scanner-bed colour visible in the corners after rotation. */
  bed: [number, number, number];
  /** Dark dust specks per megapixel. */
  specklesPerMp: number;
  jpegQuality: number;
  stamps: StampSpec[];
}

/**
 * Parameters of a simulated phone photo of a paper document (variant 'photo'): the page lies
 * on a desk, slightly rotated, lit unevenly, a little out of focus, saved as a JPEG.
 * Same parameters + same input ⇒ identical bytes.
 */
export interface PhotoOptions {
  seed: string;
  /** Rasterization resolution of the clean page before it is scaled into the frame. */
  dpi: number;
  /** Output image size in pixels (phone photos are 3:4). */
  frameWidth: number;
  frameHeight: number;
  /** Width of the sheet inside the frame, in pixels (the rest is desk). */
  paperWidth: number;
  /** Sheet rotation in degrees, positive = clockwise. */
  rotateDeg: number;
  /** Sheet offset from the frame centre in pixels. */
  offset: [number, number];
  /** Paper colour (off-white). */
  paper: [number, number, number];
  /** Desk colour visible around the sheet. */
  desk: [number, number, number];
  /** Brightness lost towards the far (bottom-right) side: 0 = even light. */
  gradient: number;
  /** Brightness lost in the corners (radial vignette). */
  vignette: number;
  /** Colour cast of indoor light, multiplied into every pixel. */
  tint: [number, number, number];
  /** Gaussian blur sigma in pixels (slight defocus). */
  blurSigma: number;
  /** Std-dev of per-pixel luma noise (0–255 scale). */
  noiseSigma: number;
  jpegQuality: number;
  /** JFIF density written into the JPEG (phone cameras write 72). */
  density: number;
  /** Stamps drawn on the sheet before it is photographed (positions in mm on the page). */
  stamps: StampSpec[];
}

export interface DocMeta {
  title: string;
  author: string;
}

export interface DocSpec {
  /** File name written into the shipment folder. */
  file: string;
  docType: DocType;
  /**
   * 'text' keeps the PDF text layer; 'scan' produces an image-only PDF; 'photo' produces a
   * JPEG phone photo of the printed page (single page only, file name must end in .jpg).
   */
  variant: 'text' | 'scan' | 'photo';
  format: 'A4' | 'Letter';
  /** Expected page count; the generator asserts it. */
  pages: number;
  html: string;
  meta: DocMeta;
  scan?: ScanOptions;
  photo?: PhotoOptions;
  /** Key values printed on the document (for OCR token-recall checks). */
  keyTokens: string[];
}

/**
 * Inputs to the valuation policy, taken from the same data the document templates render.
 * Tests recompute every line's entered value from these and compare with the hand-written
 * numbers in expected.json.
 */
export interface ValuationInputs {
  /** Line amounts after arithmetic correction (qty × unit price), invoice currency, in line order. */
  lineAmounts: number[];
  /** Non-dutiable charges included in the line prices (to prorate out by line value). */
  includedNonDutiableCharges: number;
  /** Assists to add, per line (same order); omitted = none. */
  assists?: number[];
  /**
   * Trade discount printed on the invoice and actually granted (it lowers the price actually
   * paid). Prorated by line value and deducted, like included charges; omitted = none.
   */
  discount?: number;
}

export interface ShipmentSpec {
  id: string;
  docs: DocSpec[];
  valuation: ValuationInputs;
  /** expected.json minus `files` (derived from docs). */
  expected: Omit<ExpectedShipmentInput, 'files'>;
}
