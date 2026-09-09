/**
 * Packs a built extension zip into a signed CRX3, plus the `updates.xml` that
 * Chrome's update checker reads for self-hosted builds.
 *
 * Layout: "Cr24" | uint32 version=3 | uint32 headerLength | CrxFileHeader | zip
 * The signature covers "CRX3 SignedData\0" + uint32(len) + signedHeaderData +
 * zip, so it commits to both the declared extension id and the payload.
 *
 * Usage:
 *   node scripts/pack-crx.mjs --zip=.output/deqr-0.1.0-chrome.zip
 *   node scripts/pack-crx.mjs --genkey=key.pem
 *
 * The key comes from --key=<file> or the CRX_PRIVATE_KEY env var (PEM text).
 */
import { createHash, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const CRX_MAGIC = Buffer.from('Cr24', 'ascii');
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'ascii');

// --- minimal protobuf writers -------------------------------------------------

function varint(value) {
  const bytes = [];
  let n = value;
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

/** A length-delimited (wire type 2) field. */
function field(number, payload) {
  return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]);
}

function uint32le(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

// --- crx id -------------------------------------------------------------------

/** SPKI DER of the public half, which is what Chrome embeds and hashes. */
function publicKeyDer(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
}

/**
 * Chrome's extension id: the first 16 bytes of SHA-256 over the public key,
 * hex-encoded, with each hex digit mapped 0-f -> a-p.
 */
export function extensionId(der) {
  const hash = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(0x61 + Number.parseInt(c, 16))).join('');
}

// --- packing ------------------------------------------------------------------

export function packCrx(zip, privateKeyPem) {
  const der = publicKeyDer(privateKeyPem);
  const id = extensionId(der);

  // SignedData { bytes crx_id = 1 } - the raw 16-byte id, not its a-p spelling.
  const crxId = createHash('sha256').update(der).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);

  const signature = createSign('sha256')
    .update(SIGNATURE_CONTEXT)
    .update(uint32le(signedHeaderData.length))
    .update(signedHeaderData)
    .update(zip)
    .sign(createPrivateKey(privateKeyPem));

  // AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2 }
  const proof = Buffer.concat([field(1, der), field(2, signature)]);
  // CrxFileHeader { repeated ... sha256_with_rsa = 2; bytes signed_header_data = 10000 }
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

  return {
    id,
    crx: Buffer.concat([CRX_MAGIC, uint32le(3), uint32le(header.length), header, zip]),
  };
}

/**
 * Re-read a packed CRX and check the signature over the payload. This is the
 * check that matters: a CRX that Chrome rejects is indistinguishable from a
 * correct one until you try to install it.
 */
export function verifyCrx(crx) {
  if (!crx.subarray(0, 4).equals(CRX_MAGIC)) throw new Error('bad magic');
  if (crx.readUInt32LE(4) !== 3) throw new Error('not CRX3');
  const headerLength = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLength);
  const zip = crx.subarray(12 + headerLength);

  // Walk the header's length-delimited fields rather than a full protobuf parse.
  let offset = 0;
  let proof;
  let signedHeaderData;
  while (offset < header.length) {
    let tag = 0;
    let shift = 1;
    while (header[offset] & 0x80) {
      tag += (header[offset] & 0x7f) * shift;
      shift *= 128;
      offset++;
    }
    tag += header[offset] * shift;
    offset++;
    let length = 0;
    shift = 1;
    while (header[offset] & 0x80) {
      length += (header[offset] & 0x7f) * shift;
      shift *= 128;
      offset++;
    }
    length += header[offset] * shift;
    offset++;
    const value = header.subarray(offset, offset + length);
    offset += length;
    if (tag === 2 * 8 + 2) proof = value;
    if (tag === 10000 * 8 + 2) signedHeaderData = value;
  }
  if (!proof || !signedHeaderData) throw new Error('header missing proof or signed data');

  // proof = field(1, der) + field(2, signature)
  let p = 0;
  const readField = () => {
    p++; // single-byte tag for fields 1 and 2
    let length = 0;
    let shift = 1;
    while (proof[p] & 0x80) {
      length += (proof[p] & 0x7f) * shift;
      shift *= 128;
      p++;
    }
    length += proof[p] * shift;
    p++;
    const value = proof.subarray(p, p + length);
    p += length;
    return value;
  };
  const der = readField();
  const signature = readField();

  const ok = createVerify('sha256')
    .update(SIGNATURE_CONTEXT)
    .update(uint32le(signedHeaderData.length))
    .update(signedHeaderData)
    .update(zip)
    .verify(createPublicKey({ key: der, format: 'der', type: 'spki' }), signature);
  if (!ok) throw new Error('signature does not verify');

  const declared = signedHeaderData.subarray(signedHeaderData.length - 16);
  const expected = createHash('sha256').update(der).digest().subarray(0, 16);
  if (!declared.equals(expected)) throw new Error('crx_id does not match public key');

  return { id: extensionId(der), zipLength: zip.length };
}

/** Chrome's update manifest for a self-hosted CRX. */
export function updatesXml({ id, version, codebase }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${id}">
    <updatecheck codebase="${codebase}" version="${version}" />
  </app>
</gupdate>
`;
}

// --- cli ----------------------------------------------------------------------

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main() {
  const genkey = arg('genkey');
  if (genkey) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(genkey, pem, { mode: 0o600 });
    console.log(`wrote ${genkey}`);
    console.log(`extension id: ${extensionId(publicKeyDer(pem))}`);
    console.log('Keep this file secret. It IS the extension identity: lose it and');
    console.log('every installed copy stops recognising updates as the same extension.');
    return;
  }

  const zipPath = arg('zip');
  if (!zipPath) throw new Error('pass --zip=<path> or --genkey=<path>');

  const keyPath = arg('key');
  const pem = keyPath ? await readFile(keyPath, 'utf8') : process.env.CRX_PRIVATE_KEY;
  if (!pem) throw new Error('no key: pass --key=<file> or set CRX_PRIVATE_KEY');

  const zip = await readFile(zipPath);
  const { id, crx } = packCrx(zip, pem);
  verifyCrx(crx); // never ship one that does not verify

  const out = arg('out') ?? zipPath.replace(/(-chrome)?\.zip$/, '.crx');
  await writeFile(out, crx);
  console.log(`crx:          ${out} (${crx.length} bytes)`);
  console.log(`extension id: ${id}`);

  const codebase = arg('codebase');
  if (codebase) {
    const version = arg('version') ?? '0.0.0';
    const xmlPath = arg('updates') ?? 'updates.xml';
    await writeFile(xmlPath, updatesXml({ id, version, codebase: `${codebase}/${basename(out)}` }));
    console.log(`updates.xml:  ${xmlPath}`);
  }
}

// Importable for tests; only runs as a CLI when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
