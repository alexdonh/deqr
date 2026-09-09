/**
 * The hover badge and the reveal panel.
 *
 * Both live in one closed shadow root, so page scripts get null from
 * element.shadowRoot and page CSS cannot restyle a warning into invisibility.
 */

import { browser } from 'wxt/browser';

import { sanitizeForDisplay, type RiskLevel } from './assess';
import { ICONS, type IconName } from './icons';
import type { Field } from './classify';
import type { QrResult } from './messages';
import type { Outcome } from './scan';
import type { Rasterizable } from './raster';

/** Longer than this and the panel shows a prefix with an expand control. */
const DISPLAY_LIMIT = 4096;

const STYLE = `
:host { all: initial; }
.layer {
  position: fixed; inset: 0; pointer-events: none;
  z-index: 2147483647;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color-scheme: light dark;
}
/*
 * Badges stay in the DOM but invisible until their image is hovered, so a page
 * with many QR codes is not covered in pills. They remain real focusable
 * buttons: revealing on :focus-visible as well as hover is what keeps the
 * feature reachable without a pointer, and costs nothing but this selector.
 */
.badge {
  position: absolute; pointer-events: none;
  opacity: 0; transition: opacity .12s ease;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 9px; border: 0; border-radius: 999px;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  letter-spacing: .01em; cursor: pointer;
  background: #101114; color: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.14) inset;
  transform: translate(-50%, 0);
}
.badge.show, .badge:focus-visible { opacity: 1; pointer-events: auto; }
.badge:focus-visible { outline: 2px solid #7fd1ff; outline-offset: 2px; }
.badge:hover { background: #26282e; }
.badge.locked { background: #6b5010; }
.badge svg { display: block; }

.scrim {
  position: fixed; inset: 0; pointer-events: auto;
  background: rgba(8,9,11,.55);
  display: grid; place-items: center; padding: 24px;
}
.card {
  width: min(560px, 100%); max-height: min(80vh, 720px);
  overflow: auto; box-sizing: border-box;
  background: #fbfbfc; color: #16181d;
  border-radius: 12px; padding: 0;
  box-shadow: 0 24px 64px rgba(0,0,0,.4);
}
@media (prefers-color-scheme: dark) {
  .card { background: #16181d; color: #eceef2; }
}

.head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px; }
.head h2 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px; border-radius: 999px;
  font: 650 10px/1.4 inherit; text-transform: uppercase; letter-spacing: .06em;
}
.chip svg { flex: none; }
.chip.danger { background: #fde4e2; color: #8a1c10; }
.chip.caution { background: #fdf0d5; color: #7a5106; }
.chip.info { background: #e3ecfd; color: #1c437f; }
@media (prefers-color-scheme: dark) {
  .chip.danger { background: #4a1712; color: #ffc9c1; }
  .chip.caution { background: #402f08; color: #ffe1a3; }
  .chip.info { background: #14294a; color: #c3d8ff; }
}
.close {
  display: inline-flex; border: 0; background: transparent; cursor: pointer;
  color: inherit; opacity: .55; padding: 2px;
}
.close:hover { opacity: 1; }

.dest { margin: 0 18px 14px; padding: 12px 14px; border-radius: 9px; background: rgba(127,127,127,.1); }
.dest .label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; opacity: .6; }
.dest .host { font: 650 17px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; margin-top: 4px; }
.dest .rest { font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .6; word-break: break-all; }

.warn {
  margin: 0 18px 10px; padding: 11px 13px; border-radius: 9px;
  border-left: 3px solid;
  display: flex; gap: 9px; align-items: flex-start;
}
.warn > svg { flex: none; margin-top: 1px; opacity: .8; }
.warn.danger { background: #fdeceb; border-color: #c0392b; }
.warn.caution { background: #fdf6e6; border-color: #b8860b; }
@media (prefers-color-scheme: dark) {
  .warn.danger { background: #2c1310; }
  .warn.caution { background: #2a2208; }
}
.warn strong { display: block; font-size: 12.5px; }
.warn span { display: block; margin-top: 3px; font-size: 12px; opacity: .8; }

dl.fields { margin: 0 18px 14px; display: grid; grid-template-columns: minmax(0, max-content) 1fr; gap: 7px 16px; }
dl.fields dt { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .55; }
dl.fields dd { margin: 0; font-size: 13px; word-break: break-word; }
dd .mask { display: inline-flex; gap: 8px; align-items: baseline; }
button.reveal {
  display: inline-flex; align-items: center; gap: 4px;
  border: 0; background: rgba(127,127,127,.18); border-radius: 5px;
  cursor: pointer; font: 600 10px/1 inherit; padding: 5px 8px; color: inherit;
}
.raw-hidden { display: flex; align-items: center; gap: 10px; margin: 0 18px 14px; }
.raw-hidden .note { font-size: 11.5px; opacity: .6; }

pre.raw {
  margin: 0 18px 14px; padding: 11px 13px; border-radius: 9px;
  background: rgba(127,127,127,.1);
  font: 400 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto;
}
.actions { display: flex; gap: 8px; padding: 0 18px 18px; flex-wrap: wrap; }
.actions button {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0; border-radius: 7px; cursor: pointer; padding: 8px 13px;
  font: 600 12px/1 inherit;
  background: rgba(127,127,127,.16); color: inherit;
}
.actions button svg { flex: none; }
.actions button.primary { background: #1b6ef3; color: #fff; }
.actions button.risky { background: #b8860b; color: #fff; }
.actions .note { font-size: 11.5px; opacity: .65; align-self: center; }
`;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, always. Payload strings never become markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Render one of the inlined Circum glyphs at `size` px. */
function icon(name: IconName, size = 12): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const spec = ICONS[name];
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', spec.viewBox);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of spec.paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * The QR mark on the Reveal badge, kept hand-drawn: it matches the extension
 * icon, and three solid finder blocks stay legible at 11px where a thin-stroke
 * glyph turns to mush.
 */
function qrIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 9 9');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y, size] of [
    [0, 0, 3],
    [6, 0, 3],
    [0, 6, 3],
    [6, 6, 2],
  ] as const) {
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(size));
    rect.setAttribute('height', String(size));
    rect.setAttribute('rx', '0.7');
    svg.append(rect);
  }
  return svg;
}

interface Tracked {
  el: Rasterizable;
  badge: HTMLButtonElement;
}

function covers(rect: DOMRect, at: { x: number; y: number }): boolean {
  return at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom;
}

export class Ui {
  private readonly root: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private readonly tracked: Tracked[] = [];
  private scrim?: HTMLDivElement;
  private frame = 0;
  /** Last known pointer position in viewport coordinates. */
  private pointer?: { x: number; y: number };
  /** The badge currently revealed by hover or focus, if any. */
  private active?: Tracked;

  constructor(private readonly revealSecrets: boolean) {
    const host = make('div');
    host.setAttribute('data-deqr', '');
    // Closed: the page cannot reach in via element.shadowRoot.
    this.root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.layer = make('div', 'layer');
    this.root.append(style, this.layer);
    document.documentElement.append(host);

    // Hover uses hit-testing rects, not mouseenter, 
    // since overlays can block pointer events to images.
    addEventListener(
      'pointermove',
      (event) => {
        this.pointer = { x: event.clientX, y: event.clientY };
        this.schedule();
      },
      { passive: true, capture: true },
    );
    document.addEventListener(
      'pointerleave',
      () => {
        this.pointer = undefined;
        this.schedule();
      },
      { passive: true },
    );

    const reposition = () => this.schedule();
    addEventListener('scroll', reposition, { passive: true, capture: true });
    addEventListener('resize', reposition, { passive: true });
  }

  add(el: Rasterizable, outcome: Outcome): void {
    if (outcome.status === 'none') return;
    if (this.tracked.some((t) => t.el === el)) return;

    const badge = make('button', 'badge');
    badge.type = 'button';
    if (outcome.status === 'locked') {
      badge.classList.add('locked');
      badge.append(icon('lock', 13), make('span', undefined, 'Allow deQR'));
      badge.title = `deQR cannot read this image because it is served from ${outcome.origin} without CORS headers. Click to grant access to that origin.`;
      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void browser.runtime.sendMessage({ type: 'request-grant', origin: outcome.origin });
      });
    } else {
      badge.append(qrIcon(), make('span', undefined, 'Reveal'));
      badge.title = 'deQR - Reveal this QR Code';
      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.open(outcome.result);
      });
    }

    // A mark, not a DOM attribute: the tests get their count through the same
    // channel as the other funnel counters, and no payload leaks out.
    performance.mark(outcome.status === 'locked' ? 'deqr:badge-locked' : 'deqr:badge');

    this.layer.append(badge);
    const tracked: Tracked = { el, badge };
    this.tracked.push(tracked);

    badge.addEventListener('focus', () => this.reveal(tracked));
    badge.addEventListener('blur', () => this.conceal(tracked));
    this.schedule();
  }

  private reveal(tracked: Tracked): void {
    this.active = tracked;
    this.place(tracked);
    tracked.badge.classList.add('show');
  }

  private conceal(tracked: Tracked): void {
    // Keep it up while the panel is open or the button still has focus.
    if (this.scrim || tracked.badge.matches(':focus-visible')) return;
    tracked.badge.classList.remove('show');
    if (this.active === tracked) this.active = undefined;
  }

  /** Coalesce pointer, scroll and resize into one frame of layout reads. */
  private schedule(): void {
    if (this.frame !== 0 || this.tracked.length === 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.hitTest();
      if (this.active) this.place(this.active);
    });
  }

  private hitTest(): void {
    const at = this.pointer;
    const hit =
      at &&
      this.tracked.find(
        (t) =>
          t.el.isConnected &&
          (covers(t.el.getBoundingClientRect(), at) ||
            // The badge hangs past the image edge; moving onto it is not leaving.
            (t.badge.classList.contains('show') && covers(t.badge.getBoundingClientRect(), at))),
      );
    if (hit) {
      if (this.active !== hit) this.reveal(hit);
      return;
    }
    if (this.active) this.conceal(this.active);
  }

  /** Badges sit in viewport coordinates, so they follow scroll on the next frame. */
  private place({ el, badge }: Tracked): void {
    if (!el.isConnected) {
      badge.remove();
      return;
    }
    const rect = el.getBoundingClientRect();
    badge.style.left = `${rect.left + rect.width / 2}px`;
    badge.style.top = `${Math.max(2, rect.bottom - 26)}px`;
  }

  private close(): void {
    this.scrim?.remove();
    this.scrim = undefined;
  }

  open(result: QrResult): void {
    this.close();

    const scrim = make('div', 'scrim');
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim) this.close();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.close();
        removeEventListener('keydown', onKey, true);
      }
    };
    addEventListener('keydown', onKey, true);

    const card = make('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'deQR - decoded QR code');
    card.append(
      this.head(result),
      ...this.destination(result),
      ...this.warnings(result),
      this.fields(result.payload.fields),
      this.raw(result),
      this.actions(result),
    );
    scrim.append(card);
    this.layer.append(scrim);
    this.scrim = scrim;
    card.querySelector<HTMLButtonElement>('.close')?.focus();
  }

  private head(result: QrResult): HTMLElement {
    const head = make('div', 'head');
    const chipText: Record<RiskLevel, string> = {
      danger: 'Do not open',
      caution: 'Check first',
      info: 'No warnings',
    };
    const level = result.assessment.level;
    const chip = make('span', `chip ${level}`);
    chip.append(icon(level === 'info' ? 'info' : 'warning', 11), make('span', undefined, chipText[level]));
    head.append(make('h2', undefined, result.payload.label), chip);
    const close = make('button', 'close');
    close.append(icon('close', 18));
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    head.append(close);
    return head;
  }

  /**
   * The registrable domain is the one string the user's decision hinges on, so
   * it gets the largest type on the card and everything else is dimmed.
   */
  private destination(result: QrResult): HTMLElement[] {
    const url = result.payload.url;
    if (!url) return [];
    const box = make('div', 'dest');
    box.append(make('div', 'label', 'This link actually goes to'));
    // The host the browser will actually resolve gets the largest type, never the
    // prettier form the payload wanted to show.
    box.append(make('div', 'host', sanitizeForDisplay(url.asciiHost || url.rawHost)));
    if (url.unicodeHost && url.unicodeHost !== url.asciiHost) {
      box.append(
        make('div', 'rest', `Displays as: ${sanitizeForDisplay(url.unicodeHost)}`),
      );
    }
    if (url.registrableDomain && url.registrableDomain !== url.asciiHost) {
      box.append(make('div', 'rest', `Registered domain: ${url.registrableDomain}`));
    }
    if (url.rest && url.rest !== '/') {
      box.append(make('div', 'rest', sanitizeForDisplay(url.rest)));
    }
    return [box];
  }

  private warnings(result: QrResult): HTMLElement[] {
    return result.assessment.reasons.map((reason) => {
      const box = make(
        'div',
        `warn ${result.assessment.level === 'danger' ? 'danger' : 'caution'}`,
      );
      const text = make('div', 'text');
      text.append(make('strong', undefined, reason.title), make('span', undefined, reason.detail));
      box.append(icon('warning', 15), text);
      return box;
    });
  }

  private fields(fields: Field[]): HTMLElement {
    const list = make('dl', 'fields');
    for (const field of fields) {
      list.append(make('dt', undefined, field.name));
      const dd = make('dd');
      if (field.secret && !this.revealSecrets) {
        const wrap = make('span', 'mask');
        const dots = make('span', undefined, '**********');
        const button = make('button', 'reveal');
        button.type = 'button';
        button.append(icon('reveal', 12), make('span', undefined, 'Show'));
        button.addEventListener('click', () => {
          dots.textContent = sanitizeForDisplay(field.value);
          button.remove();
        });
        wrap.append(dots, button);
        dd.append(wrap);
      } else {
        dd.textContent = sanitizeForDisplay(field.value);
      }
      list.append(dd);
    }
    return list;
  }

  /**
   * The exact payload, for anyone who wants to read it rather than trust our
   * parse of it.
   */
  private raw(result: QrResult): HTMLElement {
    const text = result.text;
    const clipped = text.length > DISPLAY_LIMIT;
    const body =
      sanitizeForDisplay(clipped ? text.slice(0, DISPLAY_LIMIT) : text) +
      (clipped ? `\n... ${text.length - DISPLAY_LIMIT} more characters` : '');

    const hasSecret = result.payload.fields.some((field) => field.secret);
    if (!hasSecret || this.revealSecrets) return make('pre', 'raw', body);

    const holder = make('div', 'raw-hidden');
    const button = make('button', 'reveal');
    button.type = 'button';
    button.append(icon('reveal', 12), make('span', undefined, 'Show raw payload'));
    button.addEventListener('click', () => holder.replaceWith(make('pre', 'raw', body)));
    holder.append(button, make('span', 'note', 'contains the secret shown above'));
    return holder;
  }

  private actions(result: QrResult): HTMLElement {
    const bar = make('div', 'actions');

    const copy = make('button');
    copy.type = 'button';
    const copyLabel = make('span', undefined, 'Copy text');
    copy.append(icon('copy', 13), copyLabel);
    copy.addEventListener('click', () => {
      // User gesture, and the exact payload - not the sanitized display form.
      void navigator.clipboard.writeText(result.text).then(
        () => {
          copyLabel.textContent = 'Copied';
        },
        () => {
          copyLabel.textContent = 'Copy blocked';
        },
      );
    });
    bar.append(copy);

    if (result.assessment.openable) {
      const href = result.payload.url?.href ?? result.text;
      const open = make('button', 'primary');
      open.type = 'button';
      const openLabel = make('span', undefined, 'Open');
      open.append(icon('open', 13), openLabel);
      if (result.assessment.level === 'caution') {
        // Caution never opens on the first click.
        open.className = 'risky';
        openLabel.textContent = 'Open anyway';
        let armed = false;
        open.addEventListener('click', () => {
          if (!armed) {
            armed = true;
            openLabel.textContent = 'Really open - click again';
            return;
          }
          window.open(href, '_blank', 'noopener,noreferrer');
        });
      } else {
        open.addEventListener('click', () => {
          window.open(href, '_blank', 'noopener,noreferrer');
        });
      }
      bar.append(open);
    } else if (result.assessment.level === 'danger') {
      bar.append(
        make('span', 'note', 'deQR will not open this. Copy the text if you need to inspect it.'),
      );
    }
    return bar;
  }
}
