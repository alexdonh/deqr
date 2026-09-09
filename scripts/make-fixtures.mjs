// Generates the QR images the tests and fixture pages load, so decoding is
// exercised against real encoded files rather than synthetic shapes.
//
// JPG and WEBP need an image converter and are only used by the browser fixture
// page, so they are written when the tools are around and skipped when not.
//
// Usage: node scripts/make-fixtures.mjs [--force] [--quiet]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const force = process.argv.includes('--force');
const quiet = process.argv.includes('--quiet');
const log = (...args) => {
  if (!quiet) console.log(...args);
};

const dir = new URL('../tests/fixtures/img/', import.meta.url);
const path = (name) => fileURLToPath(new URL(name, dir));

/** Payloads the tests assert on. Keep in sync with tests/decode.test.ts. */
const CASES = [
  ['safe-link', 'https://www.example.com/help', {}],
  ['shortener', 'https://bit.ly/3xYzQrs', {}],
  ['userinfo', 'https://paypal.com@evil.tld/login', {}],
  ['homograph', 'https://xn--pple-43d.com/verify', {}],
  ['javascript', 'javascript:alert(document.domain)', {}],
  ['wifi', 'WIFI:T:WPA;S:Cafe Guest;P:hunter2;H:false;;', {}],
  ['otpauth', 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub', {}],
  ['vietqr', '000201010211530370454061000005908MY STORE6005HANOI5802VN6304ABCD', {}],
  ['plain-text', 'Table 12 — ask about the daily special', {}],
  ['dense', `https://example.com/receipt?id=${'a1b2c3d4'.repeat(40)}`, {}],
  // Small, to exercise the low end of the size gate.
  ['small', 'https://example.com/s', { scale: 3 }],
];

function hasTool(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(dir, { recursive: true });

  const expected = CASES.flatMap(([name]) => [`${name}.png`, `${name}.svg`]);
  if (!force && expected.every((file) => existsSync(path(file)))) {
    log('make-fixtures: up to date');
    return;
  }

  // The writer's emscripten glue defaults to fetching its .wasm from a CDN.
  // Hand it the local bytes instead.
  const wasmBinary = await readFile(require.resolve('zxing-wasm/writer/zxing_writer.wasm'));
  const { prepareZXingModule, writeBarcode } = await import('zxing-wasm/writer');
  prepareZXingModule({ overrides: { wasmBinary } });

  // sips is macOS-only; cwebp comes from the webp package. Both optional.
  const canJpeg = hasTool('sips', ['--help']);
  const canWebp = hasTool('cwebp', ['-version']);

  log('make-fixtures:');
  for (const [name, text, options] of CASES) {
    const result = await writeBarcode(text, {
      format: 'QRCode',
      scale: options.scale ?? 8,
      withQuietZones: true,
    });
    if (result.error) throw new Error(`${name}: ${result.error}`);
    if (!result.image) throw new Error(`${name}: writer returned no image`);

    await writeFile(path(`${name}.svg`), result.svg);
    await writeFile(path(`${name}.png`), Buffer.from(await result.image.arrayBuffer()));

    // Same pixels, different containers - only the browser fixture page needs these.
    if (canJpeg) {
      execFileSync(
        'sips',
        ['-s', 'format', 'jpeg', path(`${name}.png`), '--out', path(`${name}.jpg`)],
        { stdio: 'ignore' },
      );
    }
    if (canWebp) {
      execFileSync('cwebp', ['-quiet', '-lossless', path(`${name}.png`), '-o', path(`${name}.webp`)]);
    }

    log(`  ${name}: ${text.slice(0, 44)}${text.length > 44 ? '...' : ''}`);
  }

  const skipped = [!canJpeg && 'jpg (needs sips)', !canWebp && 'webp (needs cwebp)'].filter(Boolean);
  if (skipped.length > 0) {
    log(`make-fixtures: skipped ${skipped.join(', ')} - browser fixture page only`);
  }
  log(`make-fixtures: ${CASES.length} codes in tests/fixtures/img/`);
}

await main();
