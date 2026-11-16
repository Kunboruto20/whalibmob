'use strict';

// Post-quantum Noise groundwork (ML-KEM-512).
//
// whalibmob's handshake is the classic Noise_XX_25519_AESGCM_SHA256. WhatsApp
// is moving to a post-quantum variant that layers ML-KEM-512 on top; this is
// the tested foundation for it. The one thing these tests pin hardest is that
// NONE of it changes the classic handshake: the default ClientHello and
// ServerHello bytes, and the NoiseState initial hash, are exactly what they
// were.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sha256 } = require('@noble/hashes/sha256');

const pq    = require('../lib/noisePq');
const wa    = require('../index.js');
const proto = require('../lib/proto');

const hash256 = (d) => Buffer.from(sha256(d));

// ─── the module is exported ───────────────────────────────────────────────────

test('NoisePq is exported from the package', () => {
  assert.equal(wa.NoisePq, require('../lib/noisePq'));
  assert.equal(typeof wa.NoisePq.kemEncapsulate, 'function');
});

// ─── ML-KEM-512 primitive ─────────────────────────────────────────────────────

test('ML-KEM-512 keygen / encapsulate / decapsulate round-trips', () => {
  const kp = pq.kemKeygen();
  assert.equal(kp.publicKey.length, pq.MLKEM512_PUBLIC_KEY_BYTES, '800-byte public key');

  const enc = pq.kemEncapsulate(kp.publicKey);
  assert.equal(enc.cipherText.length, pq.MLKEM512_CIPHERTEXT_BYTES, '768-byte ciphertext');
  assert.equal(enc.sharedSecret.length, pq.MLKEM512_SHARED_BYTES, '32-byte shared secret');

  const back = pq.kemDecapsulate(enc.cipherText, kp.secretKey);
  assert.ok(enc.sharedSecret.equals(back), 'both sides derive the same secret');
});

test('ML-KEM-512 rejects a wrong-sized key or ciphertext', () => {
  assert.throws(() => pq.kemEncapsulate(Buffer.alloc(32)), /must be 800 bytes/);
  assert.throws(() => pq.kemDecapsulate(Buffer.alloc(10), Buffer.alloc(1632)), /must be 768 bytes/);
});

// ─── PQ TLV codec ─────────────────────────────────────────────────────────────

test('a TLV round-trips through build and read', () => {
  const key = crypto.randomBytes(pq.MLKEM512_PUBLIC_KEY_BYTES);
  const buf = Buffer.concat([
    pq.buildTlv(pq.TLV_TYPE.KEM_ALGORITHM, Buffer.from(pq.KEM_ALG, 'utf8')),
    pq.buildTlv(pq.TLV_TYPE.KEM_PUBLIC_KEY, key)
  ]);
  const { tlvs, rest } = pq.readTlvs(buf);
  assert.equal(tlvs.length, 2);
  assert.equal(tlvs[0].value.toString('utf8'), 'MLKEM512');
  assert.ok(tlvs[1].value.equals(key));
  assert.equal(rest.length, 0);
});

test('parseServerPqPayload pulls the ML-KEM key and leaves the certificate', () => {
  const key  = crypto.randomBytes(pq.MLKEM512_PUBLIC_KEY_BYTES);
  const cert = crypto.randomBytes(120);
  const payload = Buffer.concat([
    pq.buildTlv(pq.TLV_TYPE.KEM_ALGORITHM, Buffer.from(pq.KEM_ALG, 'utf8')),
    pq.buildTlv(pq.TLV_TYPE.KEM_PUBLIC_KEY, key),
    cert
  ]);
  const parsed = pq.parseServerPqPayload(payload);
  assert.ok(parsed, 'a PQ payload is recognised');
  assert.ok(parsed.kemPublicKey.equals(key));
  assert.ok(parsed.certificate.equals(cert), 'the certificate is what trails the TLVs');
});

test('parseServerPqPayload returns null for a classic (non-PQ) payload', () => {
  assert.equal(pq.parseServerPqPayload(crypto.randomBytes(200)), null);
  assert.equal(pq.parseServerPqPayload(Buffer.alloc(0)), null);
  // Right lead byte, wrong algorithm name → not accepted.
  const wrong = Buffer.concat([pq.buildTlv(pq.TLV_TYPE.KEM_ALGORITHM, Buffer.from('MLKEM768'))]);
  assert.equal(pq.parseServerPqPayload(wrong), null);
});

// ─── protocol-name initial hash ───────────────────────────────────────────────

test('protocolHash pads a short name and hashes a long one', () => {
  // The classic name (29 bytes) is padded to 32, exactly as the Noise spec says.
  const classic = pq.protocolHash(pq.PROTOCOL_NAME.CLASSIC_XX, hash256);
  const expect  = Buffer.alloc(32);
  Buffer.from(pq.PROTOCOL_NAME.CLASSIC_XX, 'utf8').copy(expect);
  assert.ok(classic.equals(expect), 'short name zero-padded to 32');

  // The XXkem name is longer than 32 bytes → SHA-256 of it.
  const kem = pq.protocolHash(pq.PROTOCOL_NAME.XXKEM_FULL, hash256);
  assert.ok(kem.equals(hash256(Buffer.from(pq.PROTOCOL_NAME.XXKEM_FULL, 'utf8'))));
  assert.equal(kem.length, 32);
});

// ─── pqEnabled reads the opt-in flag ──────────────────────────────────────────

test('pqEnabled is off unless WA_NOISE_PQ opts in', () => {
  const prev = process.env.WA_NOISE_PQ;
  try {
    delete process.env.WA_NOISE_PQ;        assert.equal(pq.pqEnabled(), false);
    process.env.WA_NOISE_PQ = '0';         assert.equal(pq.pqEnabled(), false);
    process.env.WA_NOISE_PQ = 'false';     assert.equal(pq.pqEnabled(), false);
    process.env.WA_NOISE_PQ = '1';         assert.equal(pq.pqEnabled(), true);
    process.env.WA_NOISE_PQ = 'true';      assert.equal(pq.pqEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.WA_NOISE_PQ; else process.env.WA_NOISE_PQ = prev;
  }
});

// ─── the classic handshake is byte-for-byte unchanged ─────────────────────────

test('the default ClientHello is identical with no PQ fields', () => {
  const eph = crypto.randomBytes(32);
  const withoutArg = proto.encodeHandshakeClientHello(eph);
  const withUndef  = proto.encodeHandshakeClientHello(eph, undefined);
  assert.ok(withoutArg.equals(withUndef), 'passing no pq arg changes nothing');
  // The encoding is exactly field(2){ field(1){ ephemeral } } — 2-byte tags, 32-byte key.
  assert.equal(withoutArg.length, 2 + (2 + 32), 'no extra bytes crept in');
});

test('ClientHello carries pqMode and extendedEphemeral only when asked', () => {
  const eph = crypto.randomBytes(32);
  const kem = crypto.randomBytes(pq.MLKEM512_PUBLIC_KEY_BYTES);
  const withPq = proto.encodeHandshakeClientHello(eph, { pqMode: pq.PQ_MODE.XXKEM, extendedEphemeral: kem });
  assert.ok(withPq.length > 2 + (2 + 32), 'the PQ fields add bytes');
  assert.ok(withPq.includes(kem), 'the ML-KEM ephemeral is in there');
});

// A length-delimited protobuf field, with the length as a proper varint (so a
// value longer than 127 bytes is encoded correctly).
function f(n, v) {
  const tag = Buffer.from([(n << 3) | 2]);
  const len = [];
  let x = v.length;
  do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; len.push(b); } while (x);
  return Buffer.concat([tag, Buffer.from(len), v]);
}

test('a classic ServerHello still decodes, with extendedCiphertext null', () => {
  // field(3){ field(1){eph} field(2){static} field(3){payload} } — no field 6.
  const eph = crypto.randomBytes(32), st = crypto.randomBytes(48), pl = crypto.randomBytes(80);
  const inner = Buffer.concat([f(1, eph), f(2, st), f(3, pl)]);
  const hello = f(3, inner);
  const out = proto.decodeServerHello(hello);
  assert.ok(out.ephemeral.equals(eph));
  assert.ok(out.staticEnc.equals(st));
  assert.ok(out.payload.equals(pl));
  assert.equal(out.extendedCiphertext, null, 'no PQ ciphertext on a classic ServerHello');
});

test('a PQ ServerHello exposes the extendedCiphertext (field 6)', () => {
  const eph = crypto.randomBytes(32), ct = crypto.randomBytes(100);
  const inner = Buffer.concat([f(1, eph), f(6, ct)]);
  const out = proto.decodeServerHello(f(3, inner));
  assert.ok(out.extendedCiphertext.equals(ct), 'field 6 is surfaced for the PQ path');
});
