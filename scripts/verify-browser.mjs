/**
 * Loads the built extension into headless Chromium, opens a fixture page, and
 * reports what deQR actually did.
 *
 * Usage:
 *   node scripts/verify-browser.mjs [qr-test.html|perf-test.html]
 *   node scripts/verify-browser.mjs qr-test.html --panel=userinfo.png
 *
 * --panel hovers the matching image, clicks its badge with real mouse events,
 * and screenshots the panel. The badge sits in a closed shadow root and cannot
 * be selected from the page, so it is clicked by coordinates.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Google Chrome blocks --load-extension; use any Chromium build
// (Playwright's is likely present).
const CANDIDATES = [
  process.env.DEQR_CHROMIUM,
  ...[
    `${process.env.HOME}/Library/Caches/ms-playwright`,
    `${process.env.HOME}/.cache/ms-playwright`,
  ].flatMap((cache) =>
    ['chromium-1169', 'chromium']
      .map((v) => `${cache}/${v}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`),
  ),
  `${process.env.HOME}/.cache/puppeteer/chrome/mac-stable/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

const PORT = 9222;
const HTTP_PORT = 8731;
const args = process.argv.slice(2);
const page = args.find((a) => !a.startsWith('--')) ?? 'qr-test.html';
const panelFor = args.find((a) => a.startsWith('--panel='))?.slice('--panel='.length);
const root = fileURLToPath(new URL('..', import.meta.url));
const extension = join(root, '.output/chrome-mv3');
const fixtures = join(root, 'tests/fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Minimal CDP client over one target's WebSocket. */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`websocket error: ${e.message ?? e}`)));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function findBrowser() {
  for (const path of CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {
      /* next */
    }
  }
  throw new Error(
    'no usable Chromium found. Set DEQR_CHROMIUM, or install one:\n' +
      '  npx @puppeteer/browsers install chrome@stable\n' +
      'Google Chrome itself will not work - it rejects --load-extension.',
  );
}

// A missing build looks exactly like a broken extension once Chromium is up
// (no badges, no marks), so say so plainly instead.
try {
  await access(join(extension, 'manifest.json'));
} catch {
  console.error(`no build at ${extension} - run \`pnpm build\` first.`);
  process.exit(1);
}

const browser = await findBrowser();
console.log(`browser:            ${browser}`);
const profile = await mkdtemp(join(tmpdir(), 'deqr-profile-'));
const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT)], {
  cwd: fixtures,
  stdio: 'ignore',
});
const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    // Newer Chromium gates the switch behind this feature.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    '--window-size=1400,2400',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

// Watchdog: a stalled page or a hung CDP call must fail loudly, not sit forever.
const watchdog = setTimeout(() => {
  console.error('verify-browser: timed out after 120s');
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  process.exit(1);
}, 120_000);

let failed = false;
try {
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }, 'chrome devtools');

  const cdp = connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const url = `http://127.0.0.1:${HTTP_PORT}/${page}`;
  await cdp.send('Page.navigate', { url });
  await sleep(1500);

  // Scroll the whole page so the IntersectionObserver releases every candidate,
  // then give the idle queue time to drain.
  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    })()`,
    awaitPromise: true,
  });
  await sleep(4000);

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      stage1: performance.getEntriesByName('deqr:stage1').map(e => +e.duration.toFixed(3)),
      crossings: performance.getEntriesByName('deqr:decode-request').length,
      badges: performance.getEntriesByName('deqr:badge').length,
      locked: performance.getEntriesByName('deqr:badge-locked').length,
      host: document.querySelectorAll('[data-deqr]').length,
      images: document.querySelectorAll('img, canvas, svg').length,
    })`,
    returnByValue: true,
  });
  const stats = JSON.parse(result.value);
  const sorted = [...stats.stage1].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.floor(sorted.length * p)] ?? 0 : 0);

  console.log(`page:               ${page}`);
  console.log(`images on page:     ${stats.images}`);
  console.log(`deQR shadow host:   ${stats.host === 1 ? 'present' : 'MISSING'}`);
  console.log(`stage-1 evaluated:  ${stats.stage1.length}`);
  console.log(`stage-1 p50:        ${at(0.5)} ms`);
  console.log(`stage-1 p95:        ${at(0.95)} ms`);
  console.log(`stage-1 max:        ${sorted.at(-1) ?? 0} ms`);
  console.log(
    `stage-1 total:      ${stats.stage1.reduce((a, b) => a + b, 0).toFixed(1)} ms of main thread`,
  );
  console.log(`boundary crossings: ${stats.crossings}`);
  console.log(`reveal badges:      ${stats.badges}`);
  console.log(`locked badges:      ${stats.locked}`);

  if (stats.host !== 1) failed = true;

  if (panelFor) {
    // Scroll the target into view, hover it, then click where the badge sits:
    // horizontally centred on the image, 13px above its bottom edge.
    const box = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = [...document.querySelectorAll('img')]
          .find((i) => (i.currentSrc || i.src).includes(${JSON.stringify(panelFor)}));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        el.dispatchEvent(new MouseEvent('mouseenter'));
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.bottom - 13 });
      })()`,
      returnByValue: true,
    });
    if (!box.result.value) throw new Error(`no image matching ${panelFor}`);
    const { x, y } = JSON.parse(box.result.value);
    await sleep(300);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
      });
      await sleep(120);
    }
    await sleep(600);
    const panelShot = await cdp.send('Page.captureScreenshot');
    const panelOut = join(tmpdir(), `deqr-panel-${panelFor.replace(/\W/g, '-')}.png`);
    await writeFile(panelOut, Buffer.from(panelShot.data, 'base64'));
    console.log(`panel screenshot:   ${panelOut}`);
    cdp.close();
    clearTimeout(watchdog);
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
    process.exit(0);
  }

  // Badges only appear on hover or focus, so the screenshot has to hover
  // something for the pill to be visible at all. Hover every detected image:
  // only one badge can be under the cursor in reality, but for a static capture
  // this shows that each one places itself correctly.
  const hovered = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const shown = [...document.querySelectorAll('img, canvas, svg')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width >= 40 && r.height >= 40;
        });
      for (const el of shown) el.dispatchEvent(new MouseEvent('mouseenter'));
      return shown.length;
    })()`,
    returnByValue: true,
  });
  console.log(`hover dispatched:   ${hovered.result.value} elements`);
  await sleep(400);

  const shot = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: true });
  const out = join(tmpdir(), `deqr-${page.replace(/\W/g, '-')}.png`);
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot:         ${out}`);

  cdp.close();
} catch (err) {
  console.error(`verify-browser failed: ${err.message}`);
  failed = true;
} finally {
  clearTimeout(watchdog);
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
