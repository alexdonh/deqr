/**
 * Decoded QR text -> structured payload. Pure, no DOM.
 */

import { parse as parseDomain } from 'tldts';

import type { MessageKey } from './i18n';
import { decodePunycodeHost } from './punycode';

export type PayloadKind =
  | 'url'
  | 'mailto'
  | 'tel'
  | 'sms'
  | 'whatsapp'
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
  key: MessageKey;
  args?: string[];
  value: string;
  fallback?: MessageKey;
  fallbackArgs?: string[];
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
  labelKey: MessageKey;
  labelArgs?: string[];
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
  if (entries.has('S')) fields.push({ key: 'fieldNetwork', value: entries.get('S')! });
  if (entries.has('T')) {
    fields.push({ key: 'fieldSecurity', value: entries.get('T')!, fallback: 'valueSecurityNone' });
  }
  if (entries.has('P')) fields.push({ key: 'fieldPassword', value: entries.get('P')!, secret: true });
  if (entries.get('H') === 'true') fields.push({ key: 'fieldHiddenNetwork', value: '', fallback: 'valueYes' });
  return { kind: 'wifi', labelKey: 'payloadWifi', fields };
}

/** `MECARD:N:Doe,John;TEL:123;EMAIL:a@b;;` */
function classifyMecard(text: string): Payload {
  const names: Record<string, MessageKey> = {
    N: 'fieldName',
    TEL: 'fieldPhone',
    EMAIL: 'fieldEmail',
    ADR: 'fieldAddress',
    ORG: 'fieldOrganization',
    URL: 'fieldWebsite',
    NOTE: 'fieldNote',
  };
  const fields: Field[] = [];
  for (const part of splitFields(text.slice('MECARD:'.length))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const key = part.slice(0, colon).toUpperCase();
    // An unrecognized tag is a protocol token, not prose: show it as it came.
    const known = names[key];
    fields.push(
      known
        ? { key: known, value: unescape(part.slice(colon + 1)) }
        : { key: 'fieldVerbatim', args: [key], value: unescape(part.slice(colon + 1)) },
    );
  }
  return { kind: 'contact', labelKey: 'payloadContact', fields };
}

function classifyMatmsg(text: string): Payload {
  const entries = new Map<string, string>();
  for (const part of splitFields(text.slice('MATMSG:'.length))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    entries.set(part.slice(0, colon).toUpperCase(), unescape(part.slice(colon + 1)));
  }
  const params = new URLSearchParams();
  for (const [tag, param] of [
    ['SUB', 'subject'],
    ['BODY', 'body'],
    ['CC', 'cc'],
    ['BCC', 'bcc'],
  ] as const) {
    const value = entries.get(tag);
    if (value) params.set(param, value);
  }
  const query = params.toString();
  const to = encodeURIComponent(entries.get('TO') ?? '');
  return classify(`mailto:${to}${query ? `?${query}` : ''}`);
}

function classifyBizcard(text: string): Payload {
  const entries = new Map<string, string>();
  for (const part of splitFields(text.slice('BIZCARD:'.length))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    entries.set(part.slice(0, colon).toUpperCase(), unescape(part.slice(colon + 1)));
  }
  const fields: Field[] = [];
  // The name arrives split in two and belongs on one line.
  const name = [entries.get('N'), entries.get('X')].filter(Boolean).join(' ');
  if (name) fields.push({ key: 'fieldName', value: name });
  for (const [tag, key] of [
    ['T', 'fieldTitle'],
    ['C', 'fieldOrganization'],
    ['A', 'fieldAddress'],
    ['B', 'fieldPhone'],
    ['M', 'fieldPhone'],
    ['F', 'fieldFax'],
    ['E', 'fieldEmail'],
  ] as const) {
    const value = entries.get(tag);
    if (value) fields.push({ key, value });
  }
  return { kind: 'contact', labelKey: 'payloadContact', fields };
}

function classifyMebkm(text: string): Payload {
  const entries = new Map<string, string>();
  for (const part of splitFields(text.slice('MEBKM:'.length))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    entries.set(part.slice(0, colon).toUpperCase(), unescape(part.slice(colon + 1)));
  }
  const url = entries.get('URL');
  if (!url) return { kind: 'text', labelKey: 'payloadText', fields: [{ key: 'fieldText', value: text }] };
  const payload = classify(url);
  const title = entries.get('TITLE');
  // Second, never first: the title is attacker-chosen prose, the host is the fact.
  if (title) payload.fields = [...payload.fields, { key: 'fieldName', value: title }];
  return payload;
}

/** vCard / iCalendar: `KEY;PARAM:value` per unfolded line. */
function classifyIcalLike(
  text: string,
  kind: 'contact' | 'calendar',
  labelKey: MessageKey,
): Payload {
  const interesting: Record<string, MessageKey> = {
    FN: 'fieldName',
    N: 'fieldName',
    TEL: 'fieldPhone',
    EMAIL: 'fieldEmail',
    ORG: 'fieldOrganization',
    TITLE: 'fieldTitle',
    URL: 'fieldWebsite',
    ADR: 'fieldAddress',
    SUMMARY: 'fieldEvent',
    LOCATION: 'fieldLocation',
    DTSTART: 'fieldStarts',
    DTEND: 'fieldEnds',
    DESCRIPTION: 'fieldDescription',
  };
  const fields: Field[] = [];
  // Unfold continuation lines (RFC 5545/6350: a leading space continues the previous line).
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).split(';')[0]!.toUpperCase();
    const name = interesting[key];
    if (name) fields.push({ key: name, value: line.slice(colon + 1).trim() });
  }
  return { kind, labelKey, fields };
}

/** `otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer` */
function classifyOtpauth(url: URL): Payload {
  const params = url.searchParams;
  const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const fields: Field[] = [];
  fields.push({
    key: 'fieldType',
    value: '',
    fallback: url.host === 'hotp' ? 'valueHotp' : 'valueTotp',
  });
  const issuer = params.get('issuer') ?? (path.includes(':') ? path.split(':')[0]! : '');
  if (issuer) fields.push({ key: 'fieldIssuer', value: issuer });
  fields.push({ key: 'fieldAccount', value: path.includes(':') ? path.slice(path.indexOf(':') + 1) : path });
  const secret = params.get('secret');
  if (secret) fields.push({ key: 'fieldSharedSecret', value: secret, secret: true });
  return { kind: 'otpauth', labelKey: 'payloadOtpauth', fields };
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
  if (name) fields.push({ key: 'fieldMerchant', value: name });
  fields.push(
    amount
      ? { key: 'fieldAmount', value: '', fallback: 'valueEmvAmount', fallbackArgs: [amount, currency ?? '?'] }
      : { key: 'fieldAmount', value: '', fallback: 'valueAmountUnset' },
  );
  if (city) fields.push({ key: 'fieldCity', value: city });
  if (country) fields.push({ key: 'fieldCountry', value: country });
  // Tags 26-51 carry the scheme-specific account identifiers (bank, wallet, IBAN).
  for (let t = 26; t <= 51; t++) {
    const key = String(t).padStart(2, '0');
    const value = tlv.get(key);
    if (value) fields.push({ key: 'fieldEmvAccount', args: [key], value });
  }
  return { kind: 'emv', labelKey: 'payloadPayment', fields };
}

// Maps crypto URI schemes to display names.
const CRYPTO_NETWORKS: Record<string, string> = {
  bitcoin: 'Bitcoin',
  bitcoincash: 'Bitcoin Cash',
  bitcoinsv: 'Bitcoin SV',
  bsv: 'Bitcoin SV',
  litecoin: 'Litecoin',
  dogecoin: 'Dogecoin',
  dash: 'Dash',
  ethereum: 'Ethereum',
  ethereumclassic: 'Ethereum Classic',
  monero: 'Monero',
  zcash: 'Zcash',
  ripple: 'XRP',
  xrp: 'XRP',
  stellar: 'Stellar',
  'web+stellar': 'Stellar',
  cardano: 'Cardano',
  'web+cardano': 'Cardano',
  solana: 'Solana',
  tron: 'TRON',
  polkadot: 'Polkadot',
  algorand: 'Algorand',
  cosmos: 'Cosmos',
  tezos: 'Tezos',
  nano: 'Nano',
  filecoin: 'Filecoin',
  ton: 'TON',
  near: 'NEAR',
  bnb: 'BNB',
  avalanche: 'Avalanche',
  polygon: 'Polygon',
  matic: 'Polygon',
  decred: 'Decred',
  ravencoin: 'Ravencoin',
  digibyte: 'DigiByte',
  groestlcoin: 'Groestlcoin',
  peercoin: 'Peercoin',
  namecoin: 'Namecoin',
  verge: 'Verge',
  kaspa: 'Kaspa',
  iota: 'IOTA',
};

function classifyCrypto(scheme: string, network: string, text: string): Payload {
  const [target, query] = text.slice(scheme.length + 1).split('?');
  const params = new URLSearchParams(query ?? '');
  // EIP-681: `ethereum:[pay-]<address>@<chainId>[/<function>]`
  const [address, afterAt] = (target ?? '').replace(/^pay-/i, '').split('@');
  const [chainId, fn] = (afterAt ?? '').split('/');

  const fields: Field[] = [{ key: 'fieldNetwork', value: network }];
  // With a contract call the address in the path is the token, and the money
  // goes to the `address` parameter. Naming both stops them being read as one.
  fields.push({ key: fn ? 'fieldTokenContract' : 'fieldAddress', value: address ?? '' });
  if (fn) {
    fields.push({ key: 'fieldFunction', value: fn });
    const recipient = params.get('address');
    if (recipient) fields.push({ key: 'fieldRecipient', value: recipient });
  }
  if (chainId) fields.push({ key: 'fieldChainId', value: chainId });
  // BIP-21 says `amount`; EIP-681 uses `value` in wei and `uint256` for tokens.
  const amount = params.get('amount') ?? params.get('value') ?? params.get('uint256');
  if (amount) fields.push({ key: 'fieldAmount', value: amount });
  for (const [param, key] of [
    ['label', 'fieldLabel'],
    ['message', 'fieldMessage'],
  ] as const) {
    const value = params.get(param);
    if (value) fields.push({ key, value });
  }
  return { kind: 'crypto', labelKey: 'payloadCrypto', labelArgs: [network], fields };
}

/** Hosts whose whole purpose is to open a WhatsApp chat. */
const WHATSAPP_HOSTS = new Set([
  'wa.me',
  'api.whatsapp.com',
  'web.whatsapp.com',
  'chat.whatsapp.com',
]);

/**
 * WhatsApp chat links show number and message as fields.
 */
function classifyWhatsapp(url: UrlParts): Payload {
  const params = new URLSearchParams(url.rest.split('?')[1] ?? '');
  const path = decodeURIComponent(url.rest.split('?')[0]!.replace(/^\//, ''));

  if (url.asciiHost === 'chat.whatsapp.com') {
    return {
      kind: 'whatsapp',
      labelKey: 'payloadWhatsappGroup',
      fields: [{ key: 'fieldGroupInvite', value: path }],
      url,
    };
  }

  const fields: Field[] = [];
  const number = params.get('phone') ?? path;
  if (number) fields.push({ key: 'fieldNumber', value: number });
  const message = params.get('text');
  if (message) fields.push({ key: 'fieldMessage', value: message });
  return { kind: 'whatsapp', labelKey: 'payloadWhatsapp', fields, url };
}

/** An https link that is really a WhatsApp chat gets the chat panel, not a bare link. */
function fromUrl(url: UrlParts): Payload {
  if (WHATSAPP_HOSTS.has(url.asciiHost)) return classifyWhatsapp(url);
  return { kind: 'url', labelKey: 'payloadLink', fields: [{ key: 'fieldAddress', value: url.href }], url };
}

export function classify(text: string): Payload {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith('WIFI:')) return classifyWifi(trimmed);
  if (upper.startsWith('MECARD:')) return classifyMecard(trimmed);
  if (upper.startsWith('MATMSG:')) return classifyMatmsg(trimmed);
  if (upper.startsWith('BIZCARD:')) return classifyBizcard(trimmed);
  if (upper.startsWith('MEBKM:')) return classifyMebkm(trimmed);
  if (upper.startsWith('BEGIN:VCARD')) return classifyIcalLike(trimmed, 'contact', 'payloadContact');
  if (upper.startsWith('BEGIN:VCALENDAR') || upper.startsWith('BEGIN:VEVENT')) {
    return classifyIcalLike(trimmed, 'calendar', 'payloadCalendar');
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
    const fields: Field[] = [
      { key: 'fieldTo', value: decodeURIComponent(trimmed.slice(7).split('?')[0]!) },
    ];
    // An explicit map, not a capitalized param name: the names are translated.
    for (const [param, key] of [
      ['subject', 'fieldSubject'],
      ['body', 'fieldBody'],
      ['cc', 'fieldCc'],
      ['bcc', 'fieldBcc'],
    ] as const) {
      const value = params.get(param);
      if (value) fields.push({ key, value });
    }
    return { kind: 'mailto', labelKey: 'payloadEmail', fields, url };
  }

  if (scheme === 'tel') {
    return {
      kind: 'tel',
      labelKey: 'payloadPhone',
      fields: [{ key: 'fieldNumber', value: trimmed.slice(4) }],
    };
  }

  if (scheme === 'sms' || scheme === 'smsto' || scheme === 'mms' || scheme === 'mmsto') {
    const body = trimmed.slice(scheme.length + 1).replace(/^\/\//, '');
    // Both `sms:+123?body=x` and `SMSTO:+123:x` are in the wild; mms is the same
    // shape with attachments the payload cannot carry.
    const [target, ...restParts] = body.split(/[?:]/);
    const message = restParts.join(':').replace(/^body=/, '');
    const fields: Field[] = [{ key: 'fieldNumber', value: target ?? '' }];
    if (message) fields.push({ key: 'fieldMessage', value: decodeURIComponent(message) });
    return { kind: 'sms', labelKey: 'payloadSms', fields };
  }

  if (scheme === 'geo') {
    return {
      kind: 'geo',
      labelKey: 'payloadLocation',
      fields: [{ key: 'fieldCoordinates', value: trimmed.slice(4) }],
    };
  }

  if (scheme === 'upi') {
    const url = parseUrl(trimmed);
    const params = new URLSearchParams(url?.rest.split('?')[1] ?? '');
    const fields: Field[] = [];
    const map: Record<string, MessageKey> = {
      pa: 'fieldPayeeAddress',
      pn: 'fieldPayeeName',
      am: 'fieldAmount',
      cu: 'fieldCurrency',
      tn: 'fieldNote',
    };
    for (const [param, key] of Object.entries(map)) {
      const value = params.get(param);
      if (value) fields.push({ key, value });
    }
    return { kind: 'upi', labelKey: 'payloadPayment', fields, url };
  }

  if (scheme === 'whatsapp') {
    const params = new URLSearchParams(trimmed.split('?')[1] ?? '');
    const fields: Field[] = [];
    const number = params.get('phone');
    if (number) fields.push({ key: 'fieldNumber', value: number });
    const message = params.get('text');
    if (message) fields.push({ key: 'fieldMessage', value: message });
    return { kind: 'whatsapp', labelKey: 'payloadWhatsapp', fields };
  }

  if (scheme && CRYPTO_NETWORKS[scheme]) {
    return classifyCrypto(scheme, CRYPTO_NETWORKS[scheme], trimmed);
  }

  if (scheme) {
    const url = parseUrl(trimmed);
    if (url) return fromUrl(url);
  }

  // Bare hostnames are extremely common on printed and on-page QR codes.
  if (/^(?:www\.)?[a-z0-9\u00a1-\uffff][a-z0-9.\-\u00a1-\uffff]*\.[a-z\u00a1-\uffff]{2,}(?:[/?#].*)?$/i.test(trimmed)) {
    const url = parseUrl(`http://${trimmed}`);
    if (url) return fromUrl(url);
  }

  return { kind: 'text', labelKey: 'payloadText', fields: [{ key: 'fieldText', value: trimmed }] };
}
