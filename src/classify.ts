/**
 * Decoded QR text -> structured payload. Pure, no DOM.
 */

import { parse as parseDomain } from 'tldts';

import { decodePunycodeHost } from './punycode';

export type PayloadKind =
  | 'url'
  | 'mailto'
  | 'tel'
  | 'sms'
  | 'wifi'
  | 'contact'
  | 'geo'
  | 'otpauth'
  | 'calendar'
  | 'crypto'
  | 'emv'
  | 'upi'
  | 'text';

export interface Field {
  name: string;
  value: string;
  /** Masked in the UI until the user explicitly reveals it. */
  secret?: boolean;
}

export interface UrlParts {
  /** Scheme, lowercased, no colon. */
  scheme: string;
  /** Host exactly as written in the payload - may be unicode, may be a lie. */
  rawHost: string;
  /** Host as the browser will actually resolve it (punycode, lowercased). */
  asciiHost: string;
  /**
   * asciiHost with punycode labels decoded - what the hostname *looks* like,
   * regardless of which form the payload used. This is what the script checks in
   * assess.ts must run on: an attacker can supply the encoded form directly.
   */
  unicodeHost: string;
  /** eTLD+1 via the public suffix list, or '' when there isn't one (IP, intranet). */
  registrableDomain: string;
  /** Anything before '@' in the authority. Present means the visible host is bait. */
  userinfo: string;
  port: string;
  /** Path + query + fragment. */
  rest: string;
  href: string;
}

export interface Payload {
  kind: PayloadKind;
  /** Short human label for the panel header. */
  label: string;
  fields: Field[];
  url?: UrlParts;
}

const SCHEME_RE = /^([a-z][a-z0-9+.\-]*):/i;

/** Authority substring straight out of the payload, before any URL normalization. */
function rawAuthority(text: string): string {
  const m = /^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i.exec(text);
  return m?.[1] ?? '';
}

export function parseUrl(text: string): UrlParts | undefined {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return undefined;
  }
  const authority = rawAuthority(text);
  const at = authority.lastIndexOf('@');
  const rawHostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const rawHost = rawHostPort.replace(/:\d*$/, '');
  const parsed = parseDomain(u.hostname);
  return {
    scheme: u.protocol.replace(/:$/, '').toLowerCase(),
    rawHost: rawHost || u.hostname,
    asciiHost: u.hostname.toLowerCase(),
    unicodeHost: decodePunycodeHost(u.hostname.toLowerCase()),
    registrableDomain: parsed.domain ?? '',
    userinfo: at >= 0 ? authority.slice(0, at) : '',
    port: u.port,
    rest: `${u.pathname}${u.search}${u.hash}`,
    href: u.href,
  };
}

/** Unescape a QR structured-append field body (`\;` `\:` `\,` `\\`). */
function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Split on unescaped `;`. Used by WIFI: and MECARD:, which share the syntax.
 */
function splitFields(body: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      current += ch + body[i + 1];
      i++;
    } else if (ch === ';') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** `WIFI:T:WPA;S:ssid;P:password;H:true;;` */
function classifyWifi(text: string): Payload {
  const entries = new Map<string, string>();
  for (const part of splitFields(text.slice('WIFI:'.length))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    entries.set(part.slice(0, colon).toUpperCase(), unescape(part.slice(colon + 1)));
  }
  const fields: Field[] = [];
  if (entries.has('S')) fields.push({ name: 'Network', value: entries.get('S')! });
  if (entries.has('T')) fields.push({ name: 'Security', value: entries.get('T')! || 'none' });
  if (entries.has('P')) fields.push({ name: 'Password', value: entries.get('P')!, secret: true });
  if (entries.get('H') === 'true') fields.push({ name: 'Hidden network', value: 'yes' });
  return { kind: 'wifi', label: 'Wi-Fi network', fields };
}

/** `MECARD:N:Doe,John;TEL:123;EMAIL:a@b;;` */
function classifyMecard(text: string): Payload {
  const names: Record<string, string> = {
    N: 'Name',
    TEL: 'Phone',
    EMAIL: 'Email',
    ADR: 'Address',
    ORG: 'Organization',
    URL: 'Website',
    NOTE: 'Note',
  };
  const fields: Field[] = [];
  for (const part of splitFields(text.slice('MECARD:'.length))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const key = part.slice(0, colon).toUpperCase();
    fields.push({ name: names[key] ?? key, value: unescape(part.slice(colon + 1)) });
  }
  return { kind: 'contact', label: 'Contact card', fields };
}

/** vCard / iCalendar: `KEY;PARAM:value` per unfolded line. */
function classifyIcalLike(text: string, kind: 'contact' | 'calendar', label: string): Payload {
  const interesting: Record<string, string> = {
    FN: 'Name',
    N: 'Name',
    TEL: 'Phone',
    EMAIL: 'Email',
    ORG: 'Organization',
    TITLE: 'Title',
    URL: 'Website',
    ADR: 'Address',
    SUMMARY: 'Event',
    LOCATION: 'Location',
    DTSTART: 'Starts',
    DTEND: 'Ends',
    DESCRIPTION: 'Description',
  };
  const fields: Field[] = [];
  // Unfold continuation lines (RFC 5545/6350: a leading space continues the previous line).
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).split(';')[0]!.toUpperCase();
    const name = interesting[key];
    if (name) fields.push({ name, value: line.slice(colon + 1).trim() });
  }
  return { kind, label, fields };
}

/** `otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer` */
function classifyOtpauth(url: URL): Payload {
  const params = url.searchParams;
  const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const fields: Field[] = [];
  fields.push({ name: 'Type', value: url.host === 'hotp' ? 'HOTP counter' : 'TOTP time-based' });
  const issuer = params.get('issuer') ?? (path.includes(':') ? path.split(':')[0]! : '');
  if (issuer) fields.push({ name: 'Issuer', value: issuer });
  fields.push({ name: 'Account', value: path.includes(':') ? path.slice(path.indexOf(':') + 1) : path });
  const secret = params.get('secret');
  if (secret) fields.push({ name: 'Shared secret', value: secret, secret: true });
  return { kind: 'otpauth', label: 'Two-factor authentication seed', fields };
}

/**
 * EMVCo merchant-presented QR (the family VietQR, PromptPay, PIX and friends
 * belong to). Flat TLV: 2-digit tag, 2-digit length, value.
 */
export function parseEmv(text: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= text.length) {
    const tag = text.slice(i, i + 2);
    const len = Number.parseInt(text.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(len) || len < 0) return undefined;
    const start = i + 4;
    if (start + len > text.length) return undefined;
    out.set(tag, text.slice(start, start + len));
    i = start + len;
  }
  return i === text.length && out.size > 0 ? out : undefined;
}

function classifyEmv(tlv: Map<string, string>): Payload {
  const fields: Field[] = [];
  const name = tlv.get('59');
  const amount = tlv.get('54');
  const currency = tlv.get('53');
  const city = tlv.get('60');
  const country = tlv.get('58');
  if (name) fields.push({ name: 'Merchant', value: name });
  fields.push({ name: 'Amount', value: amount ? `${amount} (currency code ${currency ?? '?'})` : 'not fixed - set by the payer' });
  if (city) fields.push({ name: 'City', value: city });
  if (country) fields.push({ name: 'Country', value: country });
  // Tags 26-51 carry the scheme-specific account identifiers (bank, wallet, IBAN).
  for (let t = 26; t <= 51; t++) {
    const key = String(t).padStart(2, '0');
    const value = tlv.get(key);
    if (value) fields.push({ name: `Account (tag ${key})`, value });
  }
  return { kind: 'emv', label: 'Payment request', fields };
}

const CRYPTO_SCHEMES = new Set([
  'bitcoin',
  'bitcoincash',
  'ethereum',
  'litecoin',
  'dogecoin',
  'monero',
  'ripple',
  'solana',
  'tron',
]);

export function classify(text: string): Payload {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith('WIFI:')) return classifyWifi(trimmed);
  if (upper.startsWith('MECARD:')) return classifyMecard(trimmed);
  if (upper.startsWith('BEGIN:VCARD')) return classifyIcalLike(trimmed, 'contact', 'Contact card');
  if (upper.startsWith('BEGIN:VCALENDAR') || upper.startsWith('BEGIN:VEVENT')) {
    return classifyIcalLike(trimmed, 'calendar', 'Calendar event');
  }

  // EMVCo payloads always open with payload-format-indicator 00 02 01.
  if (trimmed.startsWith('000201')) {
    const tlv = parseEmv(trimmed);
    if (tlv) return classifyEmv(tlv);
  }

  const scheme = SCHEME_RE.exec(trimmed)?.[1]?.toLowerCase();

  if (scheme === 'otpauth') {
    try {
      return classifyOtpauth(new URL(trimmed));
    } catch {
      /* fall through to text */
    }
  }

  if (scheme === 'mailto') {
    const url = parseUrl(trimmed);
    const params = new URLSearchParams(url?.rest.split('?')[1] ?? '');
    const fields: Field[] = [{ name: 'To', value: decodeURIComponent(trimmed.slice(7).split('?')[0]!) }];
    for (const key of ['subject', 'body', 'cc', 'bcc'] as const) {
      const value = params.get(key);
      if (value) fields.push({ name: key[0]!.toUpperCase() + key.slice(1), value });
    }
    return { kind: 'mailto', label: 'Email', fields, url };
  }

  if (scheme === 'tel') {
    return {
      kind: 'tel',
      label: 'Phone number',
      fields: [{ name: 'Number', value: trimmed.slice(4) }],
    };
  }

  if (scheme === 'sms' || scheme === 'smsto') {
    const body = trimmed.slice(scheme.length + 1).replace(/^\/\//, '');
    // Both `sms:+123?body=x` and `SMSTO:+123:x` are in the wild.
    const [target, ...restParts] = body.split(/[?:]/);
    const message = restParts.join(':').replace(/^body=/, '');
    const fields: Field[] = [{ name: 'Number', value: target ?? '' }];
    if (message) fields.push({ name: 'Message', value: decodeURIComponent(message) });
    return { kind: 'sms', label: 'Text message', fields };
  }

  if (scheme === 'geo') {
    return {
      kind: 'geo',
      label: 'Location',
      fields: [{ name: 'Coordinates', value: trimmed.slice(4) }],
    };
  }

  if (scheme === 'upi') {
    const url = parseUrl(trimmed);
    const params = new URLSearchParams(url?.rest.split('?')[1] ?? '');
    const fields: Field[] = [];
    const map: Record<string, string> = { pa: 'Payee address', pn: 'Payee name', am: 'Amount', cu: 'Currency', tn: 'Note' };
    for (const [key, name] of Object.entries(map)) {
      const value = params.get(key);
      if (value) fields.push({ name, value });
    }
    return { kind: 'upi', label: 'Payment request', fields, url };
  }

  if (scheme && CRYPTO_SCHEMES.has(scheme)) {
    const withoutScheme = trimmed.slice(scheme.length + 1);
    const [address, query] = withoutScheme.split('?');
    const params = new URLSearchParams(query ?? '');
    const fields: Field[] = [
      { name: 'Network', value: scheme },
      { name: 'Address', value: address ?? '' },
    ];
    const amount = params.get('amount') ?? params.get('value');
    if (amount) fields.push({ name: 'Amount', value: amount });
    return { kind: 'crypto', label: 'Cryptocurrency transfer', fields };
  }

  if (scheme) {
    const url = parseUrl(trimmed);
    if (url) {
      return { kind: 'url', label: 'Link', fields: [{ name: 'Address', value: url.href }], url };
    }
  }

  // Bare hostnames are extremely common on printed and on-page QR codes.
  if (/^(?:www\.)?[a-z0-9\u00a1-\uffff][a-z0-9.\-\u00a1-\uffff]*\.[a-z\u00a1-\uffff]{2,}(?:[/?#].*)?$/i.test(trimmed)) {
    const url = parseUrl(`http://${trimmed}`);
    if (url) {
      return {
        kind: 'url',
        label: 'Link',
        fields: [{ name: 'Address', value: url.href }],
        url: { ...url, scheme: 'http', href: url.href },
      };
    }
  }

  return { kind: 'text', label: 'Plain text', fields: [{ name: 'Text', value: trimmed }] };
}
