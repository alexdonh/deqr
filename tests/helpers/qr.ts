/**
 * Synthetic bitmaps for prefilter tests.
 *
 * The prefilter's contract is narrow: does this bitmap contain a QR finder
 * pattern? So these fixtures build the real 7x7 finder pattern from the spec
 * rather than encoding a full QR code. It keeps the tests offline - the zxing
 * WASM reader/writer would need to be fetched - and tests exactly the property
 * the function claims to detect.
 */

import type { Luma } from '../../src/messages';

/**
 * The QR finder pattern: 7x7, dark ring / light ring / 3x3 dark core. Any line
 * through the centre crosses runs in a 1:1:3:1:1 ratio.
 */
const FINDER = [
  '1111111',
  '1000001',
  '1011101',
  '1011101',
  '1011101',
  '1000001',
  '1111111',
].map((row) => [...row].map((c) => c === '1'));

/** Deterministic PRNG so a failing test is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function blank(modules: number): boolean[][] {
  return Array.from({ length: modules }, () => new Array<boolean>(modules).fill(false));
}

function stamp(grid: boolean[][], top: number, left: number): void {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) grid[top + y]![left + x] = FINDER[y]![x]!;
  }
}

/**
 * A QR-shaped module matrix: three finder patterns in the usual corners plus
 * pseudorandom data modules. Not a decodable code, but structurally what the
 * prefilter looks for.
 */
export function qrLikeMatrix(modules = 25, seed = 7): boolean[][] {
  const grid = blank(modules);
  const rand = lcg(seed);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) grid[y]![x] = rand() < 0.45;
  }
  stamp(grid, 0, 0);
  stamp(grid, 0, modules - 7);
  stamp(grid, modules - 7, 0);
  // Finder patterns are separated from data by a one-module light band.
  for (let i = 0; i < 8; i++) {
    grid[7]![i] = false;
    grid[i]![7] = false;
    grid[7]![modules - 1 - i] = false;
    grid[i]![modules - 8] = false;
    grid[modules - 8]![i] = false;
    grid[modules - 1 - i]![7] = false;
  }
  return grid;
}

/** Render a module matrix into a luminance plane at `scale` px per module. */
export function matrixToLuma(rows: boolean[][], scale: number, quiet = 2): Luma {
  const modules = rows.length;
  const side = (modules + quiet * 2) * scale;
  const data = new Uint8Array(side * side).fill(255);
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < rows[my]!.length; mx++) {
      if (!rows[my]![mx]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          data[((my + quiet) * scale + y) * side + (mx + quiet) * scale + x] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

/** Same as matrixToLuma but low-contrast on a grey ground, to exercise Otsu. */
export function matrixToLowContrastLuma(rows: boolean[][], scale: number): Luma {
  const luma = matrixToLuma(rows, scale);
  for (let i = 0; i < luma.data.length; i++) {
    luma.data[i] = luma.data[i] === 0 ? 92 : 148;
  }
  return luma;
}

/** A smooth gradient: no runs, no finder patterns. */
export function gradient(side: number): Luma {
  const data = new Uint8Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) data[y * side + x] = Math.round((x * 255) / side);
  }
  return { data, width: side, height: side };
}

/** Fine checkerboard: many runs, none in a 1:1:3:1:1 ratio. */
export function checkerboard(side: number, cell = 1): Luma {
  const data = new Uint8Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      data[y * side + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255;
    }
  }
  return { data, width: side, height: side };
}

/** Photo-ish noise, the common false-positive risk. */
export function noise(side: number, seed = 3): Luma {
  const rand = lcg(seed);
  const data = new Uint8Array(side * side);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);
  return { data, width: side, height: side };
}
