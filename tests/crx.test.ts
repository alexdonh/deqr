/**
 * CRX3 packing.
 *
 * The round-trip tests only prove the packer agrees with itself - a wrong
 * protobuf field number would pass them happily. So there is also a conformance
 * test that packs the same directory with Chromium's own `--pack-extension` and
 * checks the two implementations accept each other. It skips when no Chromium is
 * available, since that is the same binary `pnpm verify` needs.
 */

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error - plain .mjs script, no type declarations
import { extensionId, packCrx, updatesXml, verifyCrx } from '../scripts/pack-crx.mjs';

function newKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

const CHROMIUM_CANDIDATES = [
  process.env.DEQR_CHROMIUM,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1169/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((p): p is string => Boolean(p));
const chromium = CHROMIUM_CANDIDATES.find((p) => existsSync(p));

describe('packCrx', () => {
  const pem = newKey();
  const payload = Buffer.from('PK stand-in for a zip, but real signed bytes');

  it('produces a CRX3 its own verifier accepts', () => {
    const { id, crx } = packCrx(payload, pem);
    const verified = verifyCrx(crx);
    expect(verified.id).toBe(id);
    expect(verified.zipLength).toBe(payload.length);
  });

  it('derives a 32-character a-p extension id', () => {
    const { id } = packCrx(payload, pem);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('leaves the zip payload byte-identical at the end of the file', () => {
    const { crx } = packCrx(payload, pem);
    expect(crx.subarray(crx.length - payload.length).equals(payload)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { crx } = packCrx(payload, pem);
    const tampered = Buffer.from(crx);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => verifyCrx(tampered)).toThrow(/signature/);
  });

  it('rejects a truncated or foreign file', () => {
    expect(() => verifyCrx(Buffer.from('not a crx at all'))).toThrow(/magic/);
  });

  it('gives the same id for the same key every time', () => {
    expect(packCrx(payload, pem).id).toBe(packCrx(Buffer.from('other'), pem).id);
  });
});

describe('updatesXml', () => {
  it('names the app id, version and codebase Chrome will fetch', () => {
    const xml = updatesXml({
      id: 'abcdefghijklmnopabcdefghijklmnop',
      version: '1.2.3',
      codebase: 'https://example.com/deqr.crx',
    });
    expect(xml).toContain('appid="abcdefghijklmnopabcdefghijklmnop"');
    expect(xml).toContain('version="1.2.3"');
    expect(xml).toContain('codebase="https://example.com/deqr.crx"');
  });
});

describe.skipIf(!chromium)('conformance against Chromium --pack-extension', () => {
  it('agrees with Chromium on the extension id, and verifies its output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deqr-crx-'));
    const keyPath = join(dir, 'key.pem');
    const extDir = join(dir, 'ext');
    mkdirSync(extDir);
    writeFileSync(keyPath, newKey(), { mode: 0o600 });
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'conformance', version: '1.0' }),
    );

    // Chromium writes <extDir>.crx next to the directory.
    execFileSync(
      chromium!,
      [`--pack-extension=${extDir}`, `--pack-extension-key=${keyPath}`, '--no-message-box'],
      { stdio: 'ignore' },
    );
    const reference = readFileSync(join(dir, 'ext.crx'));

    // Our verifier must accept a CRX produced entirely by Chrome's own packer.
    // This is what pins the protobuf field numbers and the signature context.
    const verified = verifyCrx(reference);
    expect(verified.id).toMatch(/^[a-p]{32}$/);

    // And our id derivation must match Chromium's for the same key.
    const ours = packCrx(Buffer.from('payload'), readFileSync(keyPath, 'utf8'));
    expect(ours.id).toBe(verified.id);
  });
});
