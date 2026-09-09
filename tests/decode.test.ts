/**
 * End-to-end over the real decoder: the actual QR images from fixtures/img/ go
 * through zxing with the extension's own reader options, then through classify
 * and assess. This is what catches configuration mistakes that unit tests on
 * hand-written strings cannot - a wrong textMode silently reformatting the
 * payload, or a format restriction that excludes real symbols.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

import { assess } from '../src/assess';
import { classify } from '../src/classify';
import { READER_OPTIONS } from '../src/reader-options';

const require = createRequire(import.meta.url);

beforeAll(async () => {
  // Hand the module its wasm as bytes. The library would otherwise fetch it from
  // a CDN, which is both offline-hostile and not what the extension does.
  const wasmBinary = await readFile(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
});

async function decode(file: string): Promise<string> {
  const bytes = await readFile(new URL(`./fixtures/img/${file}`, import.meta.url));
  const results = await readBarcodes(bytes, READER_OPTIONS);
  const hit = results.find((r) => r.isValid && r.text);
  if (!hit) throw new Error(`no QR decoded from ${file}`);
  return hit.text;
}

/**
 * PNG is the only container asserted unconditionally, because it is the only one
 * scripts/make-fixtures.mjs can produce without a system image converter.
 *
 * WEBP and SVG are absent on purpose, and their absence is not a gap in
 * coverage: the extension never hands encoded bytes to zxing. Both paths
 * rasterize first - canvas in the content script, createImageBitmap in the
 * background - so the browser's own decoder handles the container and zxing only
 * ever sees pixels. WEBP and SVG are therefore verified in the browser against
 * tests/fixtures/qr-test.html, which is where that rasterization happens.
 *
 * JPG *is* decodable from raw bytes by zxing's loader, so it is asserted when the
 * fixture exists rather than failing the suite on a machine without `sips`.
 */
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/img/${name}`, import.meta.url));
const hasJpg = existsSync(fixture('safe-link.jpg'));

describe('decodes the QR image formats deQR claims to support', () => {
  it('reads a QR out of a png', async () => {
    expect(await decode('safe-link.png')).toBe('https://www.example.com/help');
  });

  it.skipIf(!hasJpg)('reads a QR out of a jpg', async () => {
    expect(await decode('safe-link.jpg')).toBe('https://www.example.com/help');
  });

  it('reads a dense symbol', async () => {
    const text = await decode('dense.png');
    expect(text.startsWith('https://example.com/receipt?id=')).toBe(true);
  });

  it('reads a small symbol', async () => {
    expect(await decode('small.png')).toBe('https://example.com/s');
  });
});

describe('payload survives decoding byte-for-byte', () => {
  // textMode 'Plain' matters here: 'HRI' would reformat these.
  it.each([
    ['wifi.png', 'WIFI:T:WPA;S:Cafe Guest;P:hunter2;H:false;;'],
    ['otpauth.png', 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'],
    ['vietqr.png', '000201010211530370454061000005908MY STORE6005HANOI5802VN6304ABCD'],
    ['plain-text.png', 'Table 12 — ask about the daily special'],
    ['userinfo.png', 'https://paypal.com@evil.tld/login'],
    ['javascript.png', 'javascript:alert(document.domain)'],
  ])('%s', async (file, expected) => {
    expect(await decode(file)).toBe(expected);
  });
});

describe('risk verdicts on real decoded images', () => {
  it.each([
    ['safe-link.png', 'info', true],
    ['shortener.png', 'caution', true],
    ['userinfo.png', 'danger', false],
    ['homograph.png', 'danger', false],
    ['javascript.png', 'danger', false],
    ['wifi.png', 'caution', false],
    ['otpauth.png', 'caution', false],
    ['vietqr.png', 'caution', false],
  ] as const)('%s -> %s', async (file, level, openable) => {
    const text = await decode(file);
    const payload = classify(text);
    const assessment = assess(payload, text);
    expect(assessment.level).toBe(level);
    expect(assessment.openable).toBe(openable);
  });
});
