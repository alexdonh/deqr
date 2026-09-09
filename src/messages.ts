/** Message contract between the content script and the background worker. */

import type { Assessment } from './assess';
import type { Payload } from './classify';

/** Grayscale bitmap. One byte per pixel, row-major, no padding. */
export interface Luma {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Detection working size. Cheap enough to run on every visible candidate. */
export const DETECT_SIZE = 384;
/** Decode working size: QR version 40 (177 modules) lands at ~2.9px/module. */
export const DECODE_SIZE = 512;

/**
 * A decode request. Only sent for images that passed the prefilter.
 *
 * Uses base64 PNG (not pixel buffer) for compatibility: Chrome JSON-serializes,
 * breaking typed arrays; PNG is compact and direct for zxing.
 */
export interface DecodeRequest {
  type: 'decode';
  /** Base64 PNG bytes, without the `data:` prefix. */
  png: string;
}

/** Fetch-and-decode for an origin the user granted on the options page. */
export interface DecodeRemoteRequest {
  type: 'decode-remote';
  url: string;
}

/**
 * Has the user granted this origin? Content scripts have no `browser.permissions`,
 * and the answer is cached per origin so a page full of tainted images from one
 * CDN costs one message, not one per image.
 */
export interface GrantedRequest {
  type: 'granted';
  origin: string;
}

/** Ask the background to open the options page so the user can grant an origin. */
export interface GrantRequest {
  type: 'request-grant';
  origin: string;
}

export type Request = DecodeRequest | DecodeRemoteRequest | GrantedRequest | GrantRequest;

export interface QrResult {
  /** Exact decoded payload. Untrusted third-party input - never render as HTML. */
  text: string;
  payload: Payload;
  assessment: Assessment;
}

export type DecodeResponse =
  | { ok: true; result: QrResult }
  | { ok: false; reason: 'no-code' | 'decode-error' | 'no-permission' | 'fetch-failed' };

/** Remote decode needs the raw SVG back on the main thread - workers cannot rasterize SVG. */
export type DecodeRemoteResponse = DecodeResponse | { ok: false; reason: 'svg'; svg: string };
