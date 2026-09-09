/**
 * Content-side funnel controller.
 *
 *   stage 0  element gate on rendered geometry, no pixels read
 *   stage 1  rasterize at DETECT_SIZE, run the finder-pattern prefilter
 *   stage 2  re-encode at DECODE_SIZE as PNG, hand to the background decoder
 */

import { browser } from 'wxt/browser';

import {
  DECODE_SIZE,
  DETECT_SIZE,
  type DecodeRemoteResponse,
  type DecodeResponse,
  type Luma,
  type QrResult,
} from './messages';
import { looksLikeQr } from './prefilter';
import {
  intrinsicSize,
  rasterizeLuma,
  rasterizeSvgMarkupToPng,
  rasterizeToPng,
  TaintedCanvasError,
  type Rasterizable,
} from './raster';
import type { Settings } from './settings';

/** Minimum rendered edge. Below this it is an icon, a spacer, or a tracking pixel. */
const MIN_EDGE = 40;
/** QR codes are square; allow slack for padding and letterboxing, reject banners. */
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;
const LOCKED_MIN_ASPECT = 0.9;
const LOCKED_MAX_ASPECT = 1.1;
/**
 * Cumulative main-thread budget for stage-1 work on a page.
 *
 * Measured stage 1 cost (~0.3ms/image) allows a few thousand images per page;
 * missing a real QR is worse than spending some extra CPU.
 * Responsiveness is managed by the 4ms idle slices, not this cap.
 */
const MAX_STAGE1_MS = 1000;
/** Ceiling on granted-origin fetches per page. */
const MAX_REMOTE = 50;
/** Main-thread ms per idle slice. */
const SLICE_BUDGET_MS = 4;

const MUTATIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset'],
};

export type Outcome =
  | { status: 'qr'; result: QrResult }
  /** Cross-origin image, canvas tainted, origin not granted. */
  | { status: 'locked'; origin: string }
  | { status: 'none' };

type Idle = (callback: (deadline: { timeRemaining(): number }) => void) => void;

// requestIdleCallback is not everywhere yet; a timeout keeps the same shape.
const idle: Idle =
  typeof requestIdleCallback === 'function'
    ? (callback) => requestIdleCallback(callback)
    : (callback) => setTimeout(() => callback({ timeRemaining: () => SLICE_BUDGET_MS }), 16);

function send<T>(message: unknown): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

/**
 * Funnel instrumentation. The Performance timeline is per-document and shared
 * with the page, so tests/fixtures/perf-test.html can read these back even
 * though the content script runs in an isolated world.
 */
function measureSince(name: string, start: number): void {
  try {
    performance.measure(`deqr:${name}`, { start, end: performance.now() });
  } catch {
    // A page can clear or cap the timeline; never let telemetry break scanning.
  }
}

/** Elements worth looking at at all. */
function isCandidate(el: Element): el is Rasterizable {
  return (
    el instanceof HTMLImageElement ||
    el instanceof HTMLCanvasElement ||
    el instanceof SVGSVGElement
  );
}

/** Stage 0. Rendered geometry only - no pixel access, no allocation. */
function passesGate(el: Rasterizable): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_EDGE || rect.height < MIN_EDGE) return false;
  const aspect = rect.width / rect.height;
  return aspect >= MIN_ASPECT && aspect <= MAX_ASPECT;
}

/** Cache key. Canvas and inline SVG have no stable URL, so they are never cached. */
function cacheKey(el: Rasterizable): string | undefined {
  if (el instanceof HTMLImageElement) return el.currentSrc || el.src || undefined;
  return undefined;
}

export class Scanner {
  private readonly seen = new WeakSet<Element>();
  private readonly results = new Map<string, Outcome>();
  private readonly grantedOrigins = new Map<string, boolean>();
  private readonly queue: Rasterizable[] = [];
  private stage1Ms = 0;
  private remoteAttempts = 0;
  private draining = false;
  private observer?: IntersectionObserver;
  private mutations?: MutationObserver;
  private readonly shadows = new WeakSet<ShadowRoot>();

  constructor(
    private readonly settings: Settings,
    private readonly onOutcome: (el: Rasterizable, outcome: Outcome) => void,
  ) {}

  start(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer!.unobserve(entry.target);
          this.enqueue(entry.target as Rasterizable);
        }
      },
      { rootMargin: '100px' },
    );

    this.mutations = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          // src swapped on an element we already judged: re-examine it.
          this.seen.delete(record.target as Element);
          this.consider(record.target as Element);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) this.considerTree(node);
        }
      }
    });
    this.mutations.observe(document.documentElement, MUTATIONS);

    this.considerTree(document.documentElement);
  }

  stop(): void {
    this.observer?.disconnect();
    this.mutations?.disconnect();
  }

  private considerTree(root: Element | ShadowRoot): void {
    if (root instanceof Element) this.consider(root);
    // One '*' walk rather than a candidate selector plus a second pass for
    // shadow hosts: a QR inside a web component is invisible to any selector
    // run on the document, and several QR generators render theirs that way.
    for (const el of root.querySelectorAll('*')) {
      this.consider(el);
      if (el.shadowRoot) this.watchShadow(el.shadowRoot);
    }
  }

  /**
   * Open shadow roots need their own observer. attachShadow raises no mutation,
   * so this relies on the root already existing when the host is inserted -
   * true for custom elements, which attach it while connecting.
   */
  private watchShadow(root: ShadowRoot): void {
    if (this.shadows.has(root)) return;
    this.shadows.add(root);
    this.mutations?.observe(root, MUTATIONS);
    this.considerTree(root);
  }

  private consider(el: Element): void {
    if (!isCandidate(el) || this.seen.has(el)) return;
    this.seen.add(el);
    // Wait for visibility rather than decoding the whole document up front.
    this.observer?.observe(el);
  }

  private enqueue(el: Rasterizable): void {
    if (this.stage1Ms >= MAX_STAGE1_MS) return;
    this.queue.push(el);
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    idle((deadline) => {
      void this.slice(deadline);
    });
  }

  private async slice(deadline: { timeRemaining(): number }): Promise<void> {
    while (this.queue.length > 0 && deadline.timeRemaining() > 1) {
      const el = this.queue.shift()!;
      try {
        await this.evaluate(el);
      } catch (err) {
        if (!(err instanceof TaintedCanvasError)) console.debug('deQR skip', err);
      }
    }
    this.draining = false;
    if (this.queue.length > 0) this.drain();
  }

  private report(el: Rasterizable, outcome: Outcome, key: string | undefined): void {
    if (key) this.results.set(key, outcome);
    if (outcome.status !== 'none') this.onOutcome(el, outcome);
  }

  private reportLocked(el: Rasterizable, origin: string, key: string | undefined): void {
    const rect = el.getBoundingClientRect();
    const aspect = rect.width / rect.height;
    const square = aspect >= LOCKED_MIN_ASPECT && aspect <= LOCKED_MAX_ASPECT;
    this.report(el, square ? { status: 'locked', origin } : { status: 'none' }, key);
  }

  private async evaluate(el: Rasterizable): Promise<void> {
    if (!el.isConnected) return;
    // Also enforced here, not only in enqueue(): by the time the budget is spent
    // the queue already holds items admitted before it, and an image wall would
    // overshoot by the length of that queue.
    if (this.stage1Ms >= MAX_STAGE1_MS) return;

    // An <img> that hasn't finished loading has no pixels yet, and no useful
    // layout box either, so this has to come before the gate.
    if (el instanceof HTMLImageElement && !el.complete) {
      el.addEventListener('load', () => this.enqueue(el), { once: true });
      return;
    }

    if (!passesGate(el)) return;

    const key = cacheKey(el);
    if (key) {
      const cached = this.results.get(key);
      if (cached) {
        if (cached.status !== 'none') this.onOutcome(el, cached);
        return;
      }
    }

    const size = intrinsicSize(el);
    if (!size) return;

    const stage1Start = performance.now();

    let detect: Luma;
    try {
      detect = await rasterizeLuma(el, DETECT_SIZE);
    } catch (err) {
      if (err instanceof TaintedCanvasError) {
        await this.evaluateRemote(el, err.origin, key);
        return;
      }
      throw err;
    }

    const passed = this.settings.deepScan || looksLikeQr(detect);
    this.stage1Ms += performance.now() - stage1Start;
    measureSince('stage1', stage1Start);
    if (!passed) {
      this.report(el, { status: 'none' }, key);
      return;
    }

    const png = await rasterizeToPng(el, DECODE_SIZE);

    // The count of these is the number the funnel exists to keep small: each one
    // is a serialize-and-copy across the process boundary.
    performance.mark('deqr:decode-request');
    const response = await send<DecodeResponse>({ type: 'decode', png });

    this.report(
      el,
      response.ok ? { status: 'qr', result: response.result } : { status: 'none' },
      key,
    );
  }

  /**
   * Cross-origin image with no CORS headers: the canvas is tainted and the
   * content script cannot read a single pixel. If the user granted this origin,
   * the background fetches and decodes it; otherwise the badge offers the grant.
   */
  private async evaluateRemote(
    el: Rasterizable,
    origin: string,
    key: string | undefined,
  ): Promise<void> {
    if (!origin || !(el instanceof HTMLImageElement)) return;

    let granted = this.grantedOrigins.get(origin);
    if (granted === undefined) {
      granted = await send<boolean>({ type: 'granted', origin });
      this.grantedOrigins.set(origin, granted);
    }
    if (!granted) {
      this.reportLocked(el, origin, key);
      return;
    }
    if (this.remoteAttempts >= MAX_REMOTE) return;
    this.remoteAttempts++;

    const url = el.currentSrc || el.src;
    const response = await send<DecodeRemoteResponse>({ type: 'decode-remote', url });

    if (response.ok) {
      this.report(el, { status: 'qr', result: response.result }, key);
      return;
    }
    // The grant was revoked since we cached it.
    if (response.reason === 'no-permission') {
      this.grantedOrigins.set(origin, false);
      this.reportLocked(el, origin, key);
      return;
    }
    // Remote SVG: workers cannot rasterize SVG, so the background handed back the
    // markup. A data: URL does not taint the canvas, so this decodes normally.
    if (response.reason === 'svg') {
      const png = await rasterizeSvgMarkupToPng(response.svg, DECODE_SIZE);
      const decoded = await send<DecodeResponse>({ type: 'decode', png });
      this.report(
        el,
        decoded.ok ? { status: 'qr', result: decoded.result } : { status: 'none' },
        key,
      );
      return;
    }
    this.report(el, { status: 'none' }, key);
  }
}
