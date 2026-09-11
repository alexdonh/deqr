/**
 * Risk judgement on a classified payload. Pure, no DOM.
 *
 * Whoever made the QR code is a stranger. The job here is to make the real
 * destination the most legible thing on screen, and to stop helping when the
 * payload is outright deceptive.
 */

import type { Payload, UrlParts } from './classify';

export type RiskLevel = 'danger' | 'caution' | 'info';

export interface Reason {
  code: string;
  title: string;
  detail: string;
}

export interface Assessment {
  level: RiskLevel;
  reasons: Reason[];
  /** False means the UI must not offer to open this at all. */
  openable: boolean;
}

/**
 * Bidi controls can visually reverse a URL so that evil.tld/gnp.selppa reads as
 * apples.png/dlt.live. Zero-width characters hide inside otherwise plausible
 * hostnames. Both are stripped before anything is displayed.
 */
// LRE/RLE/PDF/LRO/RLO, the isolate family, LRM/RLM and ALM.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;
const BIDI_CONTROLS_G = new RegExp(BIDI_CONTROLS.source, 'g');
// ZWSP/ZWNJ/ZWJ, word joiner, the invisible-operator block, and BOM.
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF]/;
const ZERO_WIDTH_G = new RegExp(ZERO_WIDTH.source, 'g');
// C0/C1 controls, minus tab/newline/carriage-return which are legitimate in vCards.
const OTHER_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Cyrillic and Greek letters that render as Latin letters in most fonts. Not the
 * full Unicode confusables table - these are the ones that show up in real
 * homograph attacks, and covering them is worth more than covering none.
 */
const LATIN_CONFUSABLES =
  /[аеорсухіјѕһԁѵԛԁοναρετυικχɡȗ]/;

const SCRIPT_TESTS: ReadonlyArray<[string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Han', /\p{Script=Han}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Cherokee', /\p{Script=Cherokee}/u],
];

/** Schemes that must never be handed to the browser from an untrusted QR code. */
const BLOCKED_SCHEMES = new Set([
  'javascript',
  'data',
  'vbscript',
  'file',
  'blob',
  'about',
  'chrome',
  'chrome-extension',
  'moz-extension',
  'intent',
  'jar',
  'view-source',
]);

const OPENABLE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'smsto', 'geo']);

const SHORTENERS = new Set([
  '1url.cz', 'bit.ly', 'bl.ink', 'buff.ly', 'clck.ru', 'cutt.ly', 'goo.gl', 'is.gd',
  'lnkd.in', 'mcaf.ee', 'ow.ly', 'po.st', 'qr.ae', 'qrco.de', 'rb.gy', 'rebrand.ly',
  's.id', 'short.io', 'shorturl.at', 'soo.gd', 't.co', 't.ly', 'tiny.cc', 'tinyurl.com',
  'trib.al', 'u.to', 'urlr.me', 'urlz.fr', 'v.gd', 'vk.cc', 'x.co',
]);

/** Query keys that commonly carry a second URL, i.e. an open-redirect hop. */
const REDIRECT_KEYS = ['url', 'redirect', 'redirect_uri', 'redirect_url', 'next', 'target', 'dest', 'destination', 'continue', 'return', 'returnurl', 'r', 'u', 'q'];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Strip invisible and bidi-control characters and neutralize other control
 * characters. Every untrusted string must go through this before display.
 */
export function sanitizeForDisplay(value: string): string {
  return value
    .replace(BIDI_CONTROLS_G, '')
    .replace(ZERO_WIDTH_G, '')
    .replace(OTHER_CONTROLS, '\ufffd');
}

function scriptsIn(value: string): string[] {
  const letters = value.replace(/[\p{Nd}\p{P}\p{S}\s]/gu, '');
  return SCRIPT_TESTS.filter(([, re]) => re.test(letters)).map(([name]) => name);
}

function assessUrl(url: UrlParts, reasons: Reason[]): void {
  if (BLOCKED_SCHEMES.has(url.scheme)) {
    reasons.push({
      code: 'blocked-scheme',
      title: `Executable or local-resource link (${url.scheme}:)`,
      detail:
        'This is not a web address. Opening it would run code or read a local resource in your browser. deQR will not open it.',
    });
  }

  if (url.userinfo) {
    reasons.push({
      code: 'userinfo',
      title: 'The visible domain is not where this goes',
      detail: `Everything before the "@" is ignored by the browser. This link resolves to ${url.asciiHost}, not to ${url.userinfo.split(/[:.]/)[0] || 'the name shown first'}.`,
    });
  }

  // unicodeHost, not rawHost: the payload may already carry the punycode form,
  // which is pure ASCII and would show only one script no matter what it means.
  const scripts = scriptsIn(url.unicodeHost);
  if (scripts.length > 1) {
    reasons.push({
      code: 'mixed-script',
      title: 'Domain mixes alphabets',
      detail: `The hostname reads as "${url.unicodeHost}", which combines ${scripts.join(' and ')} characters. Real domains almost never do this; lookalike domains do. The browser will resolve it as ${url.asciiHost}.`,
    });
  } else if (LATIN_CONFUSABLES.test(url.unicodeHost)) {
    // Caution, not danger: a hostname written entirely in one non-Latin script
    // is the normal case for a legitimate Cyrillic or Greek domain, and those
    // alphabets are full of Latin lookalikes. Only *mixing* scripts is the
    // attack signature, and top-level domains are near-always ASCII, so a
    // homograph of a Latin brand trips mixed-script above rather than this.
    reasons.push({
      code: 'confusable',
      title: 'Domain uses letters that imitate Latin ones',
      detail: `Characters in this hostname look like ordinary letters but are not. The browser will resolve it as ${url.asciiHost}. If you expected an all-Latin address, this is not it.`,
    });
  } else if (url.asciiHost.includes('xn--')) {
    reasons.push({
      code: 'punycode',
      title: 'Internationalized domain',
      detail: `Resolves to ${url.asciiHost}. Verify this is the domain you expect.`,
    });
  }

  if (url.scheme === 'http') {
    reasons.push({
      code: 'insecure',
      title: 'Unencrypted connection (http)',
      detail: 'Anything you send to this page can be read and modified in transit.',
    });
  }

  if (SHORTENERS.has(url.registrableDomain)) {
    reasons.push({
      code: 'shortener',
      title: 'Shortened link - real destination hidden',
      detail: `${url.registrableDomain} forwards somewhere else. Nothing in this QR code tells you where.`,
    });
  }

  if (IPV4.test(url.asciiHost) || url.asciiHost.includes(':')) {
    reasons.push({
      code: 'ip-host',
      title: 'Numeric address instead of a domain name',
      detail: 'Legitimate services are normally reached by domain name.',
    });
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    reasons.push({
      code: 'port',
      title: `Non-standard port (${url.port})`,
      detail: 'Web services rarely ask you to connect on an unusual port.',
    });
  }

  // Open-redirect chaining: the visible domain is trustworthy, the payload isn't.
  const query = url.rest.slice(url.rest.indexOf('?') + 1).split('#')[0] ?? '';
  if (url.rest.includes('?')) {
    const params = new URLSearchParams(query);
    for (const key of REDIRECT_KEYS) {
      const value = params.get(key);
      if (value && /^(?:https?:\/\/|\/\/)/i.test(value.trim())) {
        reasons.push({
          code: 'nested-url',
          title: 'Link forwards to another address',
          detail: `${url.asciiHost} is only the first hop. The "${key}" parameter sends you to: ${value}`,
        });
        break;
      }
    }
  }

  if (url.href.length > 512) {
    reasons.push({
      code: 'long-url',
      title: 'Unusually long address',
      detail: `${url.href.length} characters. Length is often used to push the real domain out of view.`,
    });
  }
}

function assessNonUrl(payload: Payload, reasons: Reason[]): void {
  switch (payload.kind) {
    case 'otpauth':
      reasons.push({
        code: 'totp-seed',
        title: 'This is a two-factor authentication seed',
        detail:
          'Scanning this with an authenticator app gives that app a permanent code generator for the account. If you did not just ask a service to enrol a new authenticator, do not use it.',
      });
      break;
    case 'wifi':
      reasons.push({
        code: 'wifi',
        title: 'Joins a wireless network',
        detail:
          'Whoever runs the network can see and alter unencrypted traffic. Only join networks you know.',
      });
      break;
    case 'emv':
    case 'crypto':
    case 'upi':
      reasons.push({
        code: 'payment',
        title: 'This is a payment instruction',
        detail:
          'Check the recipient and amount below against the merchant you are actually dealing with. These transfers are normally irreversible, and swapping the payment QR is a common scam.',
      });
      break;
    case 'sms':
    case 'tel': {
      const number = payload.fields.find((f) => f.name === 'Number')?.value ?? '';
      const hasMessage = payload.fields.some((f) => f.name === 'Message' && f.value);
      if (/^(?:\+?1-?9\d{2}|0?9[0-9]{2}|\+44\s?9|\+49\s?900)/.test(number.replace(/\s/g, ''))) {
        reasons.push({
          code: 'premium-rate',
          title: 'Number may be premium-rate',
          detail: `${number} matches a premium-rate prefix. Calls or messages to these numbers can be charged at a high rate.`,
        });
      }
      if (hasMessage) {
        reasons.push({
          code: 'prefilled-message',
          title: 'Sends a pre-written message on your behalf',
          detail: 'Read the message text below before sending. Premium shortcodes bill on receipt.',
        });
      }
      break;
    }
    case 'whatsapp': {
      if (payload.fields.some((f) => f.name === 'Group invite')) {
        reasons.push({
          code: 'group-invite',
          title: 'Joins a WhatsApp group',
          detail:
            'Joining shows your phone number and profile to everyone already in the group, and there is no way to tell from the invite who that is.',
        });
        break;
      }
      if (payload.fields.some((f) => f.name === 'Message' && f.value)) {
        reasons.push({
          code: 'prefilled-message',
          title: 'Opens a chat with a pre-written message',
          detail:
            'Both the recipient and the message text were chosen by whoever made this QR code. Check the number below - starting the chat reveals your number to it.',
        });
      }
      break;
    }
    case 'mailto': {
      if (payload.fields.some((f) => f.name === 'Body' && f.value)) {
        reasons.push({
          code: 'prefilled-message',
          title: 'Pre-written email',
          detail: 'The message body was chosen by whoever made this QR code, not by you.',
        });
      }
      break;
    }
    default:
      break;
  }
}

export function assess(payload: Payload, text: string): Assessment {
  const reasons: Reason[] = [];

  if (BIDI_CONTROLS.test(text)) {
    reasons.push({
      code: 'bidi',
      title: 'Contains text-direction override characters',
      detail:
        'Invisible characters that reorder how text is displayed. They are used to make a hostile address read as a harmless one. They have been removed from the text shown here.',
    });
  }
  if (ZERO_WIDTH.test(text)) {
    reasons.push({
      code: 'zero-width',
      title: 'Contains invisible characters',
      detail:
        'Zero-width characters are present. They cannot be seen but change what the text actually is.',
    });
  }

  if (payload.url) assessUrl(payload.url, reasons);
  assessNonUrl(payload, reasons);

  const dangerCodes = new Set(['blocked-scheme', 'userinfo', 'mixed-script', 'bidi']);
  const hasDanger = reasons.some((r) => dangerCodes.has(r.code));
  const level: RiskLevel = hasDanger ? 'danger' : reasons.length > 0 ? 'caution' : 'info';

  // tel:/sms:/geo: are handled by the OS, not fetched, so classify() leaves them
  // without a UrlParts. They are still openable; kind is the authority here.
  const OPENABLE_KINDS = new Set(['url', 'mailto', 'tel', 'sms', 'geo', 'whatsapp']);
  const scheme = payload.url?.scheme;
  const openable =
    !hasDanger &&
    OPENABLE_KINDS.has(payload.kind) &&
    (scheme === undefined || (OPENABLE_SCHEMES.has(scheme) && !BLOCKED_SCHEMES.has(scheme)));

  return { level, reasons, openable };
}
