import { describe, expect, it } from 'vitest';

import { assess, sanitizeForDisplay } from '../src/assess';
import { classify } from '../src/classify';

/** Run the real pipeline: classify then assess, as the background does. */
function check(text: string) {
  const payload = classify(text);
  return { payload, ...assess(payload, text) };
}

const codes = (text: string) => check(text).reasons.map((r) => r.code);

describe('danger - must never be openable', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'view-source:https://example.com',
  ])('blocks %s', (text) => {
    const result = check(text);
    expect(result.level).toBe('danger');
    expect(result.openable).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('blocked-scheme');
  });

  it('catches the userinfo trick, where the visible domain is not the host', () => {
    const result = check('https://paypal.com@evil.tld/login');
    expect(result.level).toBe('danger');
    expect(result.openable).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('userinfo');
    // The panel leads with the host that actually resolves.
    expect(result.payload.url?.asciiHost).toBe('evil.tld');
  });

  it.each([
    ['https://аpple.com/verify', 'Cyrillic а'],
    ['https://gоogle.com/', 'Cyrillic о'],
    ['https://xn--pple-43d.com/', 'punycode form of the same'],
  ])('catches a homograph of a real domain (%s)', (text) => {
    // A Latin brand spelled with one lookalike letter always mixes scripts,
    // because the top-level domain stays ASCII. That mix is the attack
    // signature, and it is what makes this danger rather than caution.
    const result = check(text);
    expect(result.level).toBe('danger');
    expect(result.openable).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('mixed-script');
  });

  it('catches a bidi override used to disguise the payload', () => {
    const result = check('https://example.com/\u202Egnp.exe');
    expect(result.level).toBe('danger');
    expect(result.reasons.map((r) => r.code)).toContain('bidi');
  });
});

describe('caution - openable, but never on the first click', () => {
  it('flags a shortener as hiding its destination', () => {
    const result = check('https://bit.ly/3xYz');
    expect(result.level).toBe('caution');
    expect(result.openable).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain('shortener');
  });

  it('surfaces a nested URL in a redirect parameter', () => {
    const result = check('https://accounts.example.com/sso?next=https://evil.tld/harvest');
    expect(result.reasons.map((r) => r.code)).toContain('nested-url');
    // The detail has to actually name the second hop, not just warn abstractly.
    const reason = result.reasons.find((r) => r.code === 'nested-url');
    expect(reason?.detail).toContain('evil.tld');
  });

  it('flags plain http', () => {
    expect(codes('http://example.com/')).toContain('insecure');
  });

  it('flags a numeric host and an odd port', () => {
    const found = codes('http://192.168.1.9:8080/setup');
    expect(found).toContain('ip-host');
    expect(found).toContain('port');
  });

  it('warns that an otpauth URI is a 2FA seed, and masks the secret', () => {
    const text = 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
    const result = check(text);
    expect(result.payload.kind).toBe('otpauth');
    expect(result.reasons.map((r) => r.code)).toContain('totp-seed');
    expect(result.openable).toBe(false);
    const secret = result.payload.fields.find((f) => f.name === 'Shared secret');
    expect(secret?.value).toBe('JBSWY3DPEHPK3PXP');
    expect(secret?.secret).toBe(true);
  });

  it('masks a Wi-Fi password', () => {
    const result = check('WIFI:T:WPA;S:CoffeeShop;P:hunter2\\;pass;H:true;;');
    expect(result.payload.kind).toBe('wifi');
    const password = result.payload.fields.find((f) => f.name === 'Password');
    // The escaped semicolon belongs to the password, not the field separator.
    expect(password?.value).toBe('hunter2;pass');
    expect(password?.secret).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain('wifi');
  });

  it('warns that a VietQR/EMVCo payload is an irreversible payment', () => {
    // 000201 payload-format-indicator, then flat TLV: 2-digit tag, 2-digit
    // length, value. Lengths here are exact - parseEmv rejects the whole payload
    // if any of them disagree with the value that follows.
    const text =
      '000201010211' +
      '5303704' +
      '5406100000' +
      '5908MY STORE' +
      '6005HANOI' +
      '5802VN' +
      '6304ABCD';
    const result = check(text);
    expect(result.payload.kind).toBe('emv');
    expect(result.reasons.map((r) => r.code)).toContain('payment');
    expect(result.payload.fields.find((f) => f.name === 'Merchant')?.value).toBe('MY STORE');
  });

  it('warns on a crypto transfer', () => {
    const result = check('bitcoin:bc1qexampleaddress?amount=0.05');
    expect(result.payload.kind).toBe('crypto');
    expect(result.reasons.map((r) => r.code)).toContain('payment');
    expect(result.openable).toBe(false);
  });

  it('warns when an sms payload carries a pre-written message', () => {
    const result = check('sms:+18005551234?body=SUBSCRIBE');
    expect(result.payload.kind).toBe('sms');
    expect(result.reasons.map((r) => r.code)).toContain('prefilled-message');
  });
});

describe('legitimate internationalized domains are not treated as attacks', () => {
  it.each([
    ['https://сбербанк.рф/', 'all-Cyrillic host and TLD'],
    ['https://xn--80abap1arsf.xn--p1ai/', 'the same, pre-encoded'],
    ['https://münchen.de/', 'German umlaut'],
  ])('does not mark %s as danger (%s)', (text) => {
    // A single-script non-Latin hostname is the normal case for a real domain in
    // that language. Flagging these as danger would make deQR useless outside
    // ASCII, so they get an informational note and stay openable.
    const result = check(text);
    expect(result.level).not.toBe('danger');
    expect(result.openable).toBe(true);
  });
});

describe('info - nothing to warn about', () => {
  it('passes an ordinary https link', () => {
    const result = check('https://www.example.com/help');
    expect(result.level).toBe('info');
    expect(result.reasons).toEqual([]);
    expect(result.openable).toBe(true);
  });

  it('passes plain text', () => {
    const result = check('Table 12 - ask for the daily special');
    expect(result.payload.kind).toBe('text');
    expect(result.level).toBe('info');
    // Nothing to open, so no open button.
    expect(result.openable).toBe(false);
  });

  it('reads a bare hostname as a link', () => {
    const result = check('example.org/menu');
    expect(result.payload.kind).toBe('url');
    expect(result.payload.url?.asciiHost).toBe('example.org');
  });
});

describe('registrable domain', () => {
  it.each([
    ['https://a.b.example.co.uk/x', 'example.co.uk'],
    ['https://shop.example.com/x', 'example.com'],
    ['https://example.com/x', 'example.com'],
  ])('%s -> %s', (text, expected) => {
    // A last-two-labels heuristic gets .co.uk wrong; this is the one string the
    // user's decision hinges on, so it comes from the public suffix list.
    expect(check(text).payload.url?.registrableDomain).toBe(expected);
  });
});

describe('sanitizeForDisplay', () => {
  it('strips bidi overrides and zero-width characters', () => {
    expect(sanitizeForDisplay('ex\u202Eample\u200B.com')).toBe('example.com');
  });

  it('neutralizes control characters', () => {
    expect(sanitizeForDisplay('a\u0000b')).toBe('a\ufffdb');
  });

  it('keeps newlines and tabs, which vCards legitimately contain', () => {
    expect(sanitizeForDisplay('a\nb\tc')).toBe('a\nb\tc');
  });
});
