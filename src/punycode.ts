/**
 * Punycode decoding (RFC 3492), decode direction only.
 *
 * The script checks in assess.ts need to see what a hostname looks like, not
 * its ASCII form. A payload can carry the encoded host directly, and
 * `xn--pple-43d.com` is pure Latin text, so without decoding it first a
 * homograph would slip from a danger verdict down to a mild one.
 */

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

/** Digit value of a basic code point: a-z => 0..25, 0-9 => 26..35. */
function digitValue(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30 + 26;
  if (cp >= 0x61 && cp <= 0x7a) return cp - 0x61;
  if (cp >= 0x41 && cp <= 0x5a) return cp - 0x41;
  return -1;
}

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

/** Decode one label. Returns the input unchanged if it is not valid punycode. */
export function decodePunycodeLabel(label: string): string {
  if (!/^xn--/i.test(label)) return label;
  const input = label.slice(4);

  // Everything before the last delimiter is literal ASCII; the rest is encoded.
  const split = input.lastIndexOf('-');
  const basic = split > 0 ? input.slice(0, split) : '';
  const encoded = split > 0 ? input.slice(split + 1) : input;
  if (/[^\x00-\x7f]/.test(basic)) return label;

  const output = [...basic].map((ch) => ch.codePointAt(0)!);
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;

  for (let at = 0; at < encoded.length; ) {
    const previousI = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (at >= encoded.length) return label;
      const digit = digitValue(encoded.charCodeAt(at++));
      if (digit < 0) return label;
      i += digit * weight;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      weight *= BASE - t;
      // Malformed or hostile input should not spin here.
      if (weight > Number.MAX_SAFE_INTEGER) return label;
    }
    bias = adapt(i - previousI, output.length + 1, previousI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return label;
    output.splice(i, 0, n);
    i++;
  }

  try {
    return String.fromCodePoint(...output);
  } catch {
    return label;
  }
}

/** Decode every label of a hostname. */
export function decodePunycodeHost(host: string): string {
  if (!host.toLowerCase().includes('xn--')) return host;
  return host.split('.').map(decodePunycodeLabel).join('.');
}
