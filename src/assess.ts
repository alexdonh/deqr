/**
 * Risk judgement on a classified payload. Pure, no DOM.
 *
 * Whoever made the QR code is a stranger. The job here is to make the real
 * destination the most legible thing on screen, and to stop helping when the
 * payload is outright deceptive.
 */

import type { Payload, UrlParts } from './classify';
import type { MessageKey } from './i18n';

export type RiskLevel = 'danger' | 'caution' | 'info';

export interface Reason {
  code: string;
  titleKey: MessageKey;
  detailKey: MessageKey;
  titleArgs?: string[];
  detailArgs?: string[];
  scripts?: MessageKey[];
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

const SCRIPT_TESTS: ReadonlyArray<[MessageKey, RegExp]> = [
  ['scriptLatin', /\p{Script=Latin}/u],
  ['scriptCyrillic', /\p{Script=Cyrillic}/u],
  ['scriptGreek', /\p{Script=Greek}/u],
  ['scriptHan', /\p{Script=Han}/u],
  ['scriptArabic', /\p{Script=Arabic}/u],
  ['scriptHebrew', /\p{Script=Hebrew}/u],
  ['scriptArmenian', /\p{Script=Armenian}/u],
  ['scriptCherokee', /\p{Script=Cherokee}/u],
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

function scriptsIn(value: string): MessageKey[] {
  const letters = value.replace(/[\p{Nd}\p{P}\p{S}\s]/gu, '');
  return SCRIPT_TESTS.filter(([, re]) => re.test(letters)).map(([name]) => name);
}

function assessUrl(url: UrlParts, reasons: Reason[]): void {
  if (BLOCKED_SCHEMES.has(url.scheme)) {
    reasons.push({
      code: 'blocked-scheme',
      titleKey: 'reasonBlockedSchemeTitle',
      titleArgs: [url.scheme],
      detailKey: 'reasonBlockedSchemeDetail',
    });
  }

  if (url.userinfo) {
    // The part before the @ is not always a readable name to quote back.
    const shown = url.userinfo.split(/[:.]/)[0] ?? '';
    reasons.push({
      code: 'userinfo',
      titleKey: 'reasonUserinfoTitle',
      detailKey: shown ? 'reasonUserinfoDetail' : 'reasonUserinfoDetailUnnamed',
      detailArgs: shown ? [url.asciiHost, shown] : [url.asciiHost],
    });
  }

  // unicodeHost, not rawHost: the payload may already carry the punycode form,
  // which is pure ASCII and would show only one script no matter what it means.
  const scripts = scriptsIn(url.unicodeHost);
  if (scripts.length > 1) {
    reasons.push({
      code: 'mixed-script',
      titleKey: 'reasonMixedScriptTitle',
      detailKey: 'reasonMixedScriptDetail',
      detailArgs: [url.unicodeHost, url.asciiHost],
      scripts,
    });
  } else if (LATIN_CONFUSABLES.test(url.unicodeHost)) {
    // Caution, not danger: a hostname written entirely in one non-Latin script
    // is the normal case for a legitimate Cyrillic or Greek domain, and those
    // alphabets are full of Latin lookalikes. Only *mixing* scripts is the
    // attack signature, and top-level domains are near-always ASCII, so a
    // homograph of a Latin brand trips mixed-script above rather than this.
    reasons.push({
      code: 'confusable',
      titleKey: 'reasonConfusableTitle',
      detailKey: 'reasonConfusableDetail',
      detailArgs: [url.asciiHost],
    });
  } else if (url.asciiHost.includes('xn--')) {
    reasons.push({
      code: 'punycode',
      titleKey: 'reasonPunycodeTitle',
      detailKey: 'reasonPunycodeDetail',
      detailArgs: [url.asciiHost],
    });
  }

  if (url.scheme === 'http') {
    reasons.push({
      code: 'insecure',
      titleKey: 'reasonInsecureTitle',
      detailKey: 'reasonInsecureDetail',
    });
  }

  if (SHORTENERS.has(url.registrableDomain)) {
    reasons.push({
      code: 'shortener',
      titleKey: 'reasonShortenerTitle',
      detailKey: 'reasonShortenerDetail',
      detailArgs: [url.registrableDomain],
    });
  }

  if (IPV4.test(url.asciiHost) || url.asciiHost.includes(':')) {
    reasons.push({
      code: 'ip-host',
      titleKey: 'reasonIpHostTitle',
      detailKey: 'reasonIpHostDetail',
    });
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    reasons.push({
      code: 'port',
      titleKey: 'reasonPortTitle',
      titleArgs: [url.port],
      detailKey: 'reasonPortDetail',
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
          titleKey: 'reasonNestedUrlTitle',
          detailKey: 'reasonNestedUrlDetail',
          detailArgs: [url.asciiHost, key, value],
        });
        break;
      }
    }
  }

  if (url.href.length > 512) {
    reasons.push({
      code: 'long-url',
      titleKey: 'reasonLongUrlTitle',
      detailKey: 'reasonLongUrlDetail',
      detailArgs: [String(url.href.length)],
    });
  }
}

function assessNonUrl(payload: Payload, reasons: Reason[]): void {
  switch (payload.kind) {
    case 'otpauth':
      reasons.push({
        code: 'totp-seed',
        titleKey: 'reasonTotpSeedTitle',
        detailKey: 'reasonTotpSeedDetail',
      });
      break;
    case 'wifi':
      reasons.push({
        code: 'wifi',
        titleKey: 'reasonWifiTitle',
        detailKey: 'reasonWifiDetail',
      });
      break;
    case 'emv':
    case 'crypto':
    case 'upi':
      reasons.push({
        code: 'payment',
        titleKey: 'reasonPaymentTitle',
        detailKey: 'reasonPaymentDetail',
      });
      break;
    case 'sms':
    case 'tel': {
      const number = payload.fields.find((f) => f.key === 'fieldNumber')?.value ?? '';
      const hasMessage = payload.fields.some((f) => f.key === 'fieldMessage' && f.value);
      if (/^(?:\+?1-?9\d{2}|0?9[0-9]{2}|\+44\s?9|\+49\s?900)/.test(number.replace(/\s/g, ''))) {
        reasons.push({
          code: 'premium-rate',
          titleKey: 'reasonPremiumRateTitle',
          detailKey: 'reasonPremiumRateDetail',
          detailArgs: [number],
        });
      }
      if (hasMessage) {
        reasons.push({
          code: 'prefilled-message',
          titleKey: 'reasonPrefilledSmsTitle',
          detailKey: 'reasonPrefilledSmsDetail',
        });
      }
      break;
    }
    case 'whatsapp': {
      if (payload.fields.some((f) => f.key === 'fieldGroupInvite')) {
        reasons.push({
          code: 'group-invite',
          titleKey: 'reasonGroupInviteTitle',
          detailKey: 'reasonGroupInviteDetail',
        });
        break;
      }
      if (payload.fields.some((f) => f.key === 'fieldMessage' && f.value)) {
        reasons.push({
          code: 'prefilled-message',
          titleKey: 'reasonPrefilledWhatsappTitle',
          detailKey: 'reasonPrefilledWhatsappDetail',
        });
      }
      break;
    }
    case 'mailto': {
      if (payload.fields.some((f) => f.key === 'fieldBody' && f.value)) {
        reasons.push({
          code: 'prefilled-message',
          titleKey: 'reasonPrefilledMailTitle',
          detailKey: 'reasonPrefilledMailDetail',
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
      titleKey: 'reasonBidiTitle',
      detailKey: 'reasonBidiDetail',
    });
  }
  if (ZERO_WIDTH.test(text)) {
    reasons.push({
      code: 'zero-width',
      titleKey: 'reasonZeroWidthTitle',
      detailKey: 'reasonZeroWidthDetail',
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
