import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

import { assess } from '../src/assess';
import { classify } from '../src/classify';
import { looksLikeQr } from '../src/prefilter';
import { READER_OPTIONS } from '../src/reader-options';
import {
  DECODE_SIZE,
  DETECT_SIZE,
  type DecodeRemoteRequest,
  type DecodeRemoteResponse,
  type DecodeRequest,
  type DecodeResponse,
  type Luma,
  type QrResult,
  type Request,
} from '../src/messages';


export default defineBackground(() => {
  // zxing-wasm defaults locateFile to the jsDelivr CDN. The extension CSP blocks
  // that, store review rejects remote code, and it would break offline. Point it
  // at the copy scripts/sync-wasm.mjs put in public/.
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm')
          ? browser.runtime.getURL('/wasm/reader/zxing_reader.wasm')
          : prefix + path,
    },
  });

  browser.action.onClicked.addListener(() => {
    browser.runtime.openOptionsPage();
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const request = message as Request;
    switch (request.type) {
      case 'decode':
        void decodePng(request).then(sendResponse);
        return true;
      case 'decode-remote':
        void decodeRemote(request).then(sendResponse);
        return true;
      case 'granted':
        void browser.permissions
          .contains({ origins: [`${request.origin}/*`] })
          .then(sendResponse)
          .catch(() => sendResponse(false));
        return true;
      case 'request-grant':
        void browser.runtime.openOptionsPage();
        return false;
      default:
        return false;
    }
  });
});

function toResult(text: string): QrResult {
  const payload = classify(text);
  return { text, payload, assessment: assess(payload, text) };
}

/** base64 -> bytes. `atob` is available in a service worker; `fetch` on a data: URL is not worth the CSP question. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decodePng(request: DecodeRequest): Promise<DecodeResponse> {
  try {
    // zxing reads encoded image bytes directly, so the PNG needs no decoding here.
    const results = await readBarcodes(base64ToBytes(request.png), READER_OPTIONS);
    const hit = results.find((r) => r.isValid && r.text);
    return hit ? { ok: true, result: toResult(hit.text) } : { ok: false, reason: 'no-code' };
  } catch (err) {
    console.error('deQR decode failed', err);
    return { ok: false, reason: 'decode-error' };
  }
}

/**
 * Fallback for cross-origin images whose canvas is tainted. Only reachable for
 * origins the user granted on the options page; an extension fetch with host
 * permission is not subject to CORS.
 */
async function decodeRemote(request: DecodeRemoteRequest): Promise<DecodeRemoteResponse> {
  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }
  if (!(await browser.permissions.contains({ origins: [`${origin}/*`] }))) {
    return { ok: false, reason: 'no-permission' };
  }

  let blob: Blob;
  try {
    const response = await fetch(request.url, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) return { ok: false, reason: 'fetch-failed' };
    blob = await response.blob();
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }

  // createImageBitmap cannot rasterize SVG off the main thread, so SVG goes back
  // to the content script as markup and is rasterized there via a data: URL.
  if (blob.type.includes('svg')) {
    return { ok: false, reason: 'svg', svg: await blob.text() };
  }

  try {
    const bitmap = await createImageBitmap(blob);
    try {
      // Same funnel as the content-script path: prefilter at 256 before paying
      // for WASM. A granted CDN origin can serve a page's worth of images, and
      // decoding all of them would defeat the point of having a prefilter.
      if (!looksLikeQr(toLuma(draw(bitmap, DETECT_SIZE)))) return { ok: false, reason: 'no-code' };
      const results = await readBarcodes(draw(bitmap, DECODE_SIZE), READER_OPTIONS);
      const hit = results.find((r) => r.isValid && r.text);
      return hit ? { ok: true, result: toResult(hit.text) } : { ok: false, reason: 'no-code' };
    } finally {
      bitmap.close();
    }
  } catch (err) {
    console.error('deQR remote decode failed', err);
    return { ok: false, reason: 'decode-error' };
  }
}

/** Draw a bitmap into an OffscreenCanvas at `max` on the long edge. */
function draw(bitmap: ImageBitmap, max: number): ImageData {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no offscreen 2d context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** RGBA -> grayscale plane, for the prefilter. */
function toLuma({ data: rgba, width, height }: ImageData): Luma {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < data.length; i += 4, p++) {
    data[p] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
  }
  return { data, width, height };
}
