/**
 * Element -> pixels. Needs a DOM, so it runs content-script side.
 *
 * Detection uses a grayscale plane at DETECT_SIZE (few hundred KB GPU->CPU readback). 
 * Decoding outputs a base64 PNG at DECODE_SIZE for JSON transfer (see DecodeRequest).
 */

import type { Luma } from './messages';

/** getImageData or toDataURL threw SecurityError: cross-origin image, no CORS. */
export class TaintedCanvasError extends Error {
  constructor(readonly origin: string) {
    super(`tainted canvas: ${origin}`);
    this.name = 'TaintedCanvasError';
  }
}

export type Rasterizable = HTMLImageElement | HTMLCanvasElement | SVGSVGElement;

let canvas: HTMLCanvasElement | undefined;
let ctx: CanvasRenderingContext2D | undefined;

function scratch(width: number, height: number): CanvasRenderingContext2D {
  canvas ??= document.createElement('canvas');
  // willReadFrequently keeps the surface CPU-side; without it every
  // getImageData stalls on a GPU readback.
  ctx ??= canvas.getContext('2d', { willReadFrequently: true }) ?? undefined;
  if (!ctx) throw new Error('no 2d context');
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  // QR PNGs are routinely transparent-background with dark modules. Compositing
  // over white lets the rasterizer handle alpha instead of doing it per pixel.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

/** Scale to fit `max` on the long edge. Never upscales. */
function fit(w: number, h: number, max: number): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function originOf(url: string): string {
  try {
    return new URL(url, location.href).origin;
  } catch {
    return '';
  }
}

/** Wrap the SecurityError a tainted canvas raises, whichever accessor hit it. */
function rethrowIfTainted(err: unknown, origin: string): never {
  if (err instanceof DOMException && err.name === 'SecurityError') {
    throw new TaintedCanvasError(origin);
  }
  throw err;
}

/** Intrinsic (unscaled) pixel size of an element, or undefined if not measurable yet. */
export function intrinsicSize(el: Rasterizable): { w: number; h: number } | undefined {
  if (el instanceof HTMLImageElement) {
    return el.naturalWidth > 0 ? { w: el.naturalWidth, h: el.naturalHeight } : undefined;
  }
  if (el instanceof HTMLCanvasElement) {
    return el.width > 0 ? { w: el.width, h: el.height } : undefined;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 ? { w: Math.round(rect.width), h: Math.round(rect.height) } : undefined;
}

/** Load SVG markup as an image. A data: URL does not taint, so this needs no permission. */
async function loadSvg(markup: string): Promise<HTMLImageElement> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('svg rasterize failed'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
  return img;
}

/**
 * Resolve an element to something drawable plus its intrinsic size. Inline SVG
 * is serialized and reloaded as an image; everything else is drawable as-is.
 */
async function drawable(
  el: Rasterizable,
): Promise<{ source: CanvasImageSource; w: number; h: number; origin: string }> {
  const size = intrinsicSize(el);
  if (!size) throw new Error('element not measurable');

  if (el instanceof SVGSVGElement) {
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(size.w));
    clone.setAttribute('height', String(size.h));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const img = await loadSvg(new XMLSerializer().serializeToString(clone));
    return { source: img, w: img.naturalWidth || size.w, h: img.naturalHeight || size.h, origin: '' };
  }

  const origin =
    el instanceof HTMLImageElement ? originOf(el.currentSrc || el.src) : location.origin;
  return { source: el, w: size.w, h: size.h, origin };
}

function draw(source: CanvasImageSource, sw: number, sh: number, max: number): { w: number; h: number } {
  const { w, h } = fit(sw, sh, max);
  scratch(w, h).drawImage(source, 0, 0, w, h);
  return { w, h };
}

function toLuma(rgba: Uint8ClampedArray, width: number, height: number): Luma {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < data.length; i += 4, p++) {
    // Integer BT.601: (77R + 150G + 29B) >> 8
    data[p] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
  }
  return { data, width, height };
}

/**
 * Rasterize to a grayscale plane at `max` on the long edge, for the prefilter.
 * Throws {@link TaintedCanvasError} for cross-origin images without CORS.
 */
export async function rasterizeLuma(el: Rasterizable, max: number): Promise<Luma> {
  const { source, w, h, origin } = await drawable(el);
  const size = draw(source, w, h, max);
  try {
    const rgba = ctx!.getImageData(0, 0, size.w, size.h);
    return toLuma(rgba.data, size.w, size.h);
  } catch (err) {
    rethrowIfTainted(err, origin);
  }
}

/**
 * Rasterize to base64 PNG at `max` on the long edge, for the decode request.
 * Throws {@link TaintedCanvasError} for cross-origin images without CORS.
 */
export async function rasterizeToPng(el: Rasterizable, max: number): Promise<string> {
  const { source, w, h, origin } = await drawable(el);
  draw(source, w, h, max);
  try {
    const url = canvas!.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
  } catch (err) {
    rethrowIfTainted(err, origin);
  }
}

/** Rasterize remote SVG markup the background fetched for a granted origin. */
export async function rasterizeSvgMarkupToPng(markup: string, max: number): Promise<string> {
  const img = await loadSvg(markup);
  draw(img, img.naturalWidth || max, img.naturalHeight || max, max);
  const url = canvas!.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
}
