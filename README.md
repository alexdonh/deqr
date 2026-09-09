# deQR

**Reveal this QR Code.**

A browser extension that finds QR codes in the images on a page, marks them, and
on click shows you the decoded payload as text you can read - with a note on
whether it looks safe. It never opens anything for you.

Pointing your phone at an unknown QR code is how quishing works: you can't see
where it goes until you're already there. deQR shows you the destination first,
on the machine you're already using.

Works on Chromium (Chrome, Edge, Brave, Opera, Vivaldi) and Firefox from one
codebase.

## How it works

Three stages, each roughly ten times cheaper and ten times pickier than the one
after it. "Is this image a QR code?" can only really be answered by decoding it,
so the whole point of the funnel is to make answering *no* cheap.

```
content script (isolated world, all_urls)          ~50 images/page
  scan.ts       candidates, IntersectionObserver, size/aspect gate
  raster.ts     -> 384px luminance plane
  prefilter.ts  finder-pattern 1:1:3:1:1 scan, cross-checked vertically
        |  base64 PNG, only on a prefilter pass      ~0-2 images/page
        v             ^ {payload, risk}
background (service worker / Firefox event page)
  zxing-wasm decode (one instance, lazy, local .wasm)
  classify.ts + assess.ts
  fetch fallback for user-granted origins
```

The message boundary sits *inside* the funnel rather than at its mouth, and
that's the whole performance story. Every crossing costs a serialize-and-copy,
so the prefilter exists to make the number of crossings match the number of QR
codes on the page instead of the number of images.

Measured on `tests/fixtures/perf-test.html` (500 images, 3 real QR codes): stage
1 costs **0.3 ms p50 / 0.5 ms p95** per image, 172 ms of main thread for the
whole page, and exactly **3** crossings.

### What it can read

`<img>` (PNG, JPG, WEBP, SVG), inline `<svg>`, `<canvas>`, and `data:` URLs. CSS
`background-image` isn't scanned yet.

Cross-origin images served without CORS headers taint the canvas, which means
the content script can't read a single pixel of them. Those get an **Allow
deQR** badge instead; grant that one origin on the options page and the
background will fetch and decode it. deQR ships with **no host permissions** -
only optional ones you grant per origin.

## Security model

The payload was written by someone you have no relationship with, so treat it as
hostile input. There are two separate things to protect.

**The page and the extension.** The reveal panel lives in a *closed* shadow
root, so page scripts get `null` from `element.shadowRoot` and page CSS can't
restyle a warning into invisibility. Every untrusted string reaches the DOM
through `textContent` - no `innerHTML` anywhere in the UI, and no payload is
ever written into an `href`. The content script runs in the isolated world. The
extension makes **no network requests of its own**, sends no telemetry, and
never transmits a decoded payload; the WASM decoder is bundled locally and the
CSP allows no remote code.

**You, from the payload.** `classify.ts` parses it, `assess.ts` judges it. Both
are pure functions and unit-tested.

Refused outright (`danger`, no Open button at all):

- `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `view-source:` and friends
- userinfo spoofing - `https://paypal.com@evil.tld` actually goes to `evil.tld`
- IDN homographs, checked against the *decoded* hostname so an already-punycoded
  payload (`xn--pple-43d.com`) can't slip past
- bidi override characters, which can visually reverse a URL

Flagged (`caution`, and opening takes a second click): URL shorteners, plain
`http`, raw-IP hosts, odd ports, a nested URL in a redirect parameter,
zero-width characters, and - with secrets hidden behind a click - `otpauth://`
2FA seeds and `WIFI:` passwords. Payment payloads (EMVCo/VietQR, crypto URIs,
UPI) get called out as irreversible.

The registrable domain comes from the public suffix list via `tldts` rather than
a last-two-labels guess, because it's the one string your decision hinges on. A
hostname written entirely in one non-Latin script is *not* treated as an attack
- that's just a normal Cyrillic or Greek domain. Mixing scripts is the homograph
signature.

## Development

### Build

```sh
pnpm install          # also copies the zxing .wasm into public/ and generates types
pnpm dev              # Chromium, with reload
pnpm dev:firefox      # Firefox, via web-ext
```

`pnpm build` / `pnpm build:firefox` produce `.output/chrome-mv3` and
`.output/firefox-mv3`. `pnpm zip` packages them.

### Testing

```sh
pnpm check         # sync wasm, generate types, typecheck, unit tests
pnpm verify        # load the built extension in headless Chromium, decode fixtures
pnpm verify:perf   # the 500-image performance gate
pnpm verify -- qr-test.html --panel=userinfo.png   # screenshot one reveal panel
```

`tests/decode.test.ts` runs the real zxing decoder over the real fixture images
in `tests/fixtures/img/`, so decode -> classify -> assess is covered end to end
and not just over hand-written strings. `tests/crx.test.ts` checks the CRX
packer against Chromium's own `--pack-extension`, so the hand-rolled protobuf is
measured against a reference implementation instead of only against itself.

Two things still need a human: the Firefox pass, and granting an origin on the
options page to watch a locked badge turn into a Reveal badge.

## Credits

deQR is a thin, opinionated shell around some excellent work by other people.
The hard part - actually decoding a QR symbol - isn't mine.

- **[zxing-cpp](https://github.com/zxing-cpp/zxing-cpp)** (Apache-2.0) - the
  barcode decoding engine. Every payload deQR shows you was read by this. Its
  `FinderPatternFinder` is also where the prefilter comes from: the 1:1:3:1:1
  row scan with a vertical cross-check is that algorithm boiled down to a
  yes/no answer.
- **[zxing-wasm](https://github.com/Sec-ant/zxing-wasm)** by Ze-Zheng Wu (MIT) -
  the WebAssembly build and JavaScript bindings that make zxing-cpp usable in a
  browser extension, plus the writer that generates the test fixtures.
- **[tldts](https://github.com/remusao/tldts)** by Thomas Parisot and Rémi
  Berson (MIT) - public suffix list lookup. It answers "what's the registrable
  domain here?", which is the most important string in the risk panel and the
  one a naive last-two-labels guess gets wrong.
- **[Circum Icons](https://circumicons.com)** by Klarr Agency (MPL-2.0) - the
  glyphs in the reveal panel. Only the handful actually used are inlined, in
  `src/icons.ts`, since the extension CSP blocks remote fetches. That file is
  the one part of deQR under MPL-2.0 rather than Apache-2.0, which MPL section
  3.3 allows.
- **[WXT](https://wxt.dev)** (MIT) - the extension framework and build tooling,
  and the reason one codebase can produce both Chromium and Firefox packages.

The homograph and bidi-control checks draw on the
[Unicode security](https://www.unicode.org/reports/tr36/) and
[IDNA](https://www.unicode.org/reports/tr46/) technical reports.

## Licence

[Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).

Bundled third-party components keep their own licences, reproduced in full in
[public/THIRD-PARTY-NOTICES.txt](public/THIRD-PARTY-NOTICES.txt). That file, the
licence and the notice all ship inside every built package, because those
components' terms require it.

## Lessons learnt

Four things that cost real debugging time and would be easy to hit again:

1. **Chrome's `runtime.sendMessage` is JSON-serialized, not structured-clone.** A
   `Uint8Array` arrives as `{"0":12,"1":255,...}`, quietly loses `.length`, and
   decodes as a black image without throwing. Firefox *does* use structured
   clone, which hides it. That's why decode requests cross as base64 PNG.
2. **`zxing-wasm` points `locateFile` at a jsDelivr CDN by default.** The
   extension CSP blocks it, store review rejects remote code, and it breaks
   offline. The background overrides it, and a Vite plugin rewrites the URL out
   of the bundle so the string isn't even present.
3. **Google Chrome refuses `--load-extension`** ("not allowed in Google Chrome,
   ignoring"). `scripts/verify-browser.mjs` needs a plain Chromium build; set
   `DEQR_CHROMIUM` if it can't find one.
4. **The prefilter needs its vertical cross-check.** A horizontal-only 1:1:3:1:1
   scan happily accepts photographic noise, because at one pixel per module that
   run pattern turns up constantly. `tests/prefilter.test.ts` guards it.
