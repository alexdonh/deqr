import { defineConfig } from 'wxt';

/**
 * zxing-wasm's built-in locateFile points at fastly.jsdelivr.net. The background
 * worker overrides it, so it is never called - but the URL string still lands in
 * the bundle, and a remote-code URL in a reviewed extension is a problem whether
 * or not it is reachable. Rewrite the base to the local /wasm/ directory that
 * scripts/sync-wasm.mjs populates, so the dead path is also a correct path.
 */
const stripZxingCdn = {
  name: 'deqr-strip-zxing-cdn',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('zxing-wasm') || !code.includes('jsdelivr.net')) return null;
    return {
      code: code.replace(/https:\/\/[a-z.]*jsdelivr\.net\/npm\/zxing-wasm@[^/]+\/dist\//g, '/wasm/'),
      map: null,
    };
  },
};

export default defineConfig({
  vite: () => ({ plugins: [stripZxingCdn] }),

  // WXT still defaults Firefox to MV2. deQR is MV3 everywhere: optional host
  // permissions and the CSP shape both assume it.
  manifestVersion: 3,

  manifest: ({ browser }) => ({
    name: 'deQR',
    short_name: 'deQR',
    description:
      'Reveal this QR Code - decode QR images on any page and inspect the payload before you trust it.',

    // No host_permissions by default. Pixel access goes through the canvas, and the
    // options page grants individual origins when a cross-origin image taints it.
    permissions: ['storage'],
    optional_host_permissions: ['<all_urls>'],

    action: { default_title: 'deQR - Reveal this QR Code' },
    options_ui: { open_in_tab: true },

    // 'wasm-unsafe-eval' is required to instantiate the bundled zxing reader.
    // Everything is local; no remote code is ever fetched.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },

    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'deqr@sharering.network',
              // optional_host_permissions landed in 127.
              strict_min_version: '127.0',
            },
          },
        }
      : {}),
  }),

  /**
   * AMO rejects bundled code without a source archive that builds standalone.
   *
   * `includeSources` REPLACES the default `["**\/*"]` rather than adding to it -
   * narrowing it to a couple of globs silently shipped a sources zip with no
   * package.json, no src/ and no entrypoints/, which review would bounce.
   */
  zip: {
    excludeSources: [
      'tests/fixtures/img/**', // regenerate with `pnpm fixtures`
      'public/wasm/**', // a prebuilt binary does not belong in a source archive;
      '**/*.zip', // postinstall copies it back out of node_modules
    ],
  },
});
