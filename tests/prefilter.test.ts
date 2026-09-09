import { describe, expect, it } from 'vitest';

import { looksLikeQr, otsuThreshold } from '../src/prefilter';
import {
  checkerboard,
  gradient,
  matrixToLowContrastLuma,
  matrixToLuma,
  noise,
  qrLikeMatrix,
} from './helpers/qr';

describe('otsuThreshold', () => {
  it('splits a two-peak histogram between the peaks', () => {
    const data = new Uint8Array(1000);
    data.fill(30, 0, 500);
    data.fill(220, 500);
    // Dark means value <= t, so returning the dark peak itself is correct.
    const t = otsuThreshold(data);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });

  it('survives a low-contrast pair', () => {
    const data = new Uint8Array(1000);
    data.fill(92, 0, 500);
    data.fill(148, 500);
    const t = otsuThreshold(data);
    expect(t).toBeGreaterThanOrEqual(92);
    expect(t).toBeLessThan(148);
  });
});

describe('looksLikeQr - must not miss a QR', () => {
  // A false negative means the badge never appears, so these are the tests that
  // actually protect the feature.
  it.each([2, 3, 4, 6, 10])('accepts a QR-shaped matrix at %ipx per module', (scale) => {
    expect(looksLikeQr(matrixToLuma(qrLikeMatrix(25), scale))).toBe(true);
  });

  it.each([21, 25, 33, 57, 101])('accepts a %i-module symbol', (modules) => {
    expect(looksLikeQr(matrixToLuma(qrLikeMatrix(modules), 4))).toBe(true);
  });

  it('accepts a low-contrast symbol on a grey ground', () => {
    expect(looksLikeQr(matrixToLowContrastLuma(qrLikeMatrix(25), 4))).toBe(true);
  });

  it.each([1, 5, 11, 42, 99])('accepts symbols with data seed %i', (seed) => {
    expect(looksLikeQr(matrixToLuma(qrLikeMatrix(25, seed), 4))).toBe(true);
  });

  it('accepts the densest symbol at the detect size', () => {
    // Version 40 is 177 modules. DETECT_SIZE (384) over 181 modules with the
    // quiet zone leaves ~2px per module, which is the floor isFinderCross
    // accepts - this is the case that sets DETECT_SIZE.
    const luma = matrixToLuma(qrLikeMatrix(177), 2, 2);
    expect(luma.width).toBeLessThanOrEqual(384);
    expect(looksLikeQr(luma)).toBe(true);
  });
});

describe('looksLikeQr - should reject non-QR images', () => {
  it('rejects a gradient', () => {
    expect(looksLikeQr(gradient(256))).toBe(false);
  });

  it('rejects a fine checkerboard', () => {
    expect(looksLikeQr(checkerboard(256))).toBe(false);
  });

  it('rejects a solid image', () => {
    const data = new Uint8Array(256 * 256).fill(200);
    expect(looksLikeQr({ data, width: 256, height: 256 })).toBe(false);
  });

  it('rejects an image too small to hold a symbol', () => {
    const data = new Uint8Array(8 * 8).fill(0);
    expect(looksLikeQr({ data, width: 8, height: 8 })).toBe(false);
  });

  // Regression guard. A horizontal-only scan accepted every one of these: at one
  // pixel per module, (1,1,3,1,1) runs occur constantly in noise. The fix was the
  // vertical cross-check plus the two-pixel module floor.
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 17, 64, 128, 999])(
    'rejects pixel noise (seed %i)',
    (seed) => {
      expect(looksLikeQr(noise(300, seed))).toBe(false);
    },
  );

  it.each([2, 3, 5])('rejects coarse checkerboards (cell %ipx)', (cell) => {
    expect(looksLikeQr(checkerboard(256, cell))).toBe(false);
  });
});

describe('looksLikeQr - documented ceilings', () => {
  it('misses a symbol rendered at one pixel per module', () => {
    // Known false negative, and the reason the options page offers Deep scan:
    // below two pixels per module the ratio test cannot separate signal from
    // noise, so the filter declines rather than guess.
    expect(looksLikeQr(matrixToLuma(qrLikeMatrix(25), 1))).toBe(false);
  });
});
