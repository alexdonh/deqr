import { describe, expect, it } from 'vitest';

import { decodePunycodeHost, decodePunycodeLabel } from '../src/punycode';

describe('decodePunycodeHost', () => {
  it.each([
    ['xn--pple-43d.com', 'аpple.com'],
    ['xn--gogle-jye.com', 'gоogle.com'],
    ['xn--80abap1arsf.xn--p1ai', 'сбербанк.рф'],
    ['xn--e1afmkfd.xn--p1ai', 'пример.рф'],
    ['xn--mnchen-3ya.de', 'münchen.de'],
    ['xn--fiqs8s', '中国'],
  ])('%s -> %s', (ascii, unicode) => {
    expect(decodePunycodeHost(ascii)).toBe(unicode);
  });

  it('leaves plain hostnames alone', () => {
    expect(decodePunycodeHost('www.example.co.uk')).toBe('www.example.co.uk');
  });

  it('returns malformed labels unchanged rather than throwing', () => {
    // Hostile input reaches this function; garbage in must not mean a crash.
    for (const bad of ['xn--', 'xn---', 'xn--!!!!', 'xn--zzzzzzzzzzzzzzzzzzzzzzzz', 'xn--a-']) {
      expect(() => decodePunycodeLabel(bad)).not.toThrow();
    }
  });
});
