/**
 * Stage 1: does this grayscale bitmap plausibly hold a QR code?
 *
 * Runs on every visible candidate, so it is the one function whose cost really
 * matters. No DOM, no WASM, no process boundary.
 *
 * A QR code has three 7x7 finder patterns, and any straight line through a
 * finder centre crosses dark/light runs in a 1:1:3:1:1 ratio. That ratio is
 * scale- and rotation-invariant, so a horizontal scan finds them without
 * knowing the code's size or angle.
 */

import type { Luma } from './messages';

/** Rows to sample regardless of image size. */
const TARGET_ROWS = 64;
/** A real finder pattern is 7 modules tall, so it lands on several sampled rows. */
const MIN_ROW_HITS = 3;
/**
 * Cap on vertical confirmations per image. A real symbol needs a handful; an
 * image that needs more than this is noise, and the scan bails out.
 */
const MAX_CROSS_CHECKS = 32;

interface Cross {
  /** Position of the centre of the middle (3-module) run along the line. */
  center: number;
  /** Implied module size in pixels. */
  module: number;
}

/**
 * Otsu's method over a 256-bin histogram. One pass over the pixels plus 256
 * iterations. A fixed threshold would fail on gradients and off-white
 * backgrounds, which are common in real QR images.
 *
 * Returns t such that a pixel is dark when `value <= t`.
 */
export function otsuThreshold(data: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]!]!++;

  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;

  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    weightB += hist[t]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t]!;
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/** Five run lengths against the 1:1:3:1:1 finder ratio. Window starts on dark. */
function isFinderCross(r0: number, r1: number, r2: number, r3: number, r4: number): boolean {
  const total = r0 + r1 + r2 + r3 + r4;
  // At one pixel per module the test is degenerate: a (1,1,3,1,1) run occurs
  // constantly in ordinary photographic noise and passes both scans. Two pixels
  // per module is the floor at which the ratio carries information. DETECT_SIZE
  // is set so that even a 177-module version-40 symbol clears it.
  if (total < 14) return false;
  const module = total / 7;
  // Half a module of slack per run, as zxing does.
  const slack = module / 2;
  return (
    Math.abs(module - r0) < slack &&
    Math.abs(module - r1) < slack &&
    Math.abs(module * 3 - r2) < slack * 3 &&
    Math.abs(module - r3) < slack &&
    Math.abs(module - r4) < slack
  );
}

/**
 * Walk one line of the bitmap, and for every 1:1:3:1:1 window call `onCross`.
 * Stops early and returns true as soon as `onCross` returns true.
 */
function scanLine(
  read: (i: number) => number,
  length: number,
  threshold: number,
  onCross: (cross: Cross) => boolean,
): boolean {
  const runs = new Int32Array(5);
  let filled = 0;
  // Whether runs[0] is a dark run. Seeded by the first run, flipped on each shift.
  let startsDark = read(0) <= threshold;
  let currentDark = startsDark;
  let runLength = 0;
  // Index of the first pixel of runs[0].
  let windowStart = 0;

  for (let i = 0; i < length; i++) {
    const dark = read(i) <= threshold;
    if (dark === currentDark) {
      runLength++;
      continue;
    }

    if (filled === 5) {
      windowStart += runs[0]!;
      runs[0] = runs[1]!;
      runs[1] = runs[2]!;
      runs[2] = runs[3]!;
      runs[3] = runs[4]!;
      startsDark = !startsDark;
    } else {
      filled++;
    }
    runs[filled - 1] = runLength;

    if (filled === 5 && startsDark) {
      const [r0, r1, r2, r3, r4] = [runs[0]!, runs[1]!, runs[2]!, runs[3]!, runs[4]!];
      if (isFinderCross(r0, r1, r2, r3, r4)) {
        const module = (r0 + r1 + r2 + r3 + r4) / 7;
        const center = windowStart + r0 + r1 + r2 / 2;
        if (onCross({ center, module })) return true;
      }
    }

    currentDark = dark;
    runLength = 1;
  }
  return false;
}

/**
 * True if the image plausibly contains a QR finder pattern.
 */
export function looksLikeQr(luma: Luma): boolean {
  const { data, width, height } = luma;
  // Smaller than this cannot hold the 21 modules of a version-1 symbol.
  if (width < 16 || height < 16) return false;

  const threshold = otsuThreshold(data);
  const step = Math.max(1, Math.floor(height / TARGET_ROWS));

  let hits = 0;
  let crossChecks = 0;
  let aborted = false;

  for (let y = 0; y < height; y += step) {
    const row = y * width;
    const confirmed = scanLine(
      (i) => data[row + i]!,
      width,
      threshold,
      ({ center, module }) => {
        if (crossChecks >= MAX_CROSS_CHECKS) {
          aborted = true;
          return true;
        }
        crossChecks++;
        const x = Math.min(width - 1, Math.max(0, Math.round(center)));
        // A finder pattern is symmetric, so the column through its centre shows
        // the same ratio at the same scale. Noise almost never does both.
        return scanLine(
          (j) => data[j * width + x]!,
          height,
          threshold,
          (vertical) => Math.abs(vertical.module - module) <= module / 2,
        );
      },
    );

    if (aborted) return false;
    if (confirmed) {
      hits++;
      if (hits >= MIN_ROW_HITS) return true;
    }
  }
  return false;
}
