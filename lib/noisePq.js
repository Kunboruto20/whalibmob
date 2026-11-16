'use strict';

const { Boom } = require('@hapi/boom');

// Post-quantum Noise readiness (ML-KEM-512 / Kyber-512).
//
// WhatsApp Android 2.26.x negotiates a post-quantum Noise handshake when its
// remote config turns it on (NoisePQConfig, pqMode NONE/ENABLE/ENFORCE; the
// WA_REVERSE_2026 reverse documents the wire). The classic client uses
// `Noise_XX_25519_AESGCM_SHA256`; the PQ one layers ML-KEM-512 on top of the
// same X25519 handshake, so a future that cannot be broken by a quantum
// computer still authenticates the account.
//
// This module is the self-contained, testable groundwork for that: the
// ML-KEM-512 primitive, the protocol-name constants, the `pqMode` enum, and the
// PQ TLV codec. It is loaded only when the PQ path is asked for (see noise.js,
// gated by WA_NOISE_PQ) — the default classic handshake neither requires
// @noble/post-quantum nor changes by a byte.
//
// IMPORTANT: the full XX-KEM handshake wiring in noise.js is written to the
// reverse-engineering spec but has NOT been validated against a live server
// that enforces PQ (WhatsApp runs pqMode=ENABLE, which still accepts classic
// XX, so there is nothing to validate against yet). It ships off by default and
// is experimental until a PQ-enforcing server — or a test vector — can confirm
// the KEM mixing order end to end. The ML-KEM primitive itself, the constants,
// and the codec below are tested.

// ─── pqMode: the remote-config PQ switch (ClientHello field 9 enum) ───────────
// The wire enum HANDSHAKE_PQ_MODE (X/C1LT): the values a real client writes.
const PQ_MODE = {
  UNKNOWN:      0,
  XXKEM:        1,   // full handshake, variant IKKEM (the default when PQ is on)
  XXKEM_FS:     2,
  WA_CLASSICAL: 3,
  WA_PQ:        4,
  IKKEM:        5,   // resume
  IKKEM_FS:     6,
  XXKEM_2:      7,
  IKKEM_2:      8,
  XXKEM_EPH:    9
};

// The NoisePQConfig.pqMode the app reads from remote config (X/C1KH).
const PQ_CONFIG_MODE = { NONE: 0, ENABLE: 1, ENFORCE: 2 };

// ─── Protocol names (X/C1KX) ──────────────────────────────────────────────────
// The classic name is exactly 29 bytes and is zero-padded to 32 as the initial
// Noise hash. The KEM names are longer than 32 bytes, so the initial hash is
// their SHA-256 instead — handled by protocolHash() below.
const PROTOCOL_NAME = {
  CLASSIC_XX:  'Noise_XX_25519_AESGCM_SHA256',
  CLASSIC_IK:  'Noise_IK_25519_AESGCM_SHA256',
  XXKEM_FULL:  'Noise_XXkem_25519_MLKEM512_AESGCM_SHA256',
  IKKEM_RESUME:'Noise_IKkem+X25519+MLKEM512+AESGCM256+SHA256'
};

// The ML-KEM algorithm label the server names in the PQ TLV (X/C1KE.A0B).
const KEM_ALG = 'MLKEM512';

// ML-KEM-512 sizes (FIPS 203), the ones the reverse pins on the wire.
const MLKEM512_PUBLIC_KEY_BYTES = 800;
const MLKEM512_CIPHERTEXT_BYTES = 768;
const MLKEM512_SHARED_BYTES     = 32;

// PQ TLV types inside the ServerHello payload / ClientHello extendedEphemeral.
const TLV_TYPE = { KEM_ALGORITHM: 0x01, KEM_PUBLIC_KEY: 0x02, EPHEMERAL_KEM: 0x03 };

// ─── ML-KEM-512 primitive ─────────────────────────────────────────────────────
// Lazily required so the classic path never loads @noble/post-quantum. Kept
// behind one accessor so a missing dependency fails with a clear message rather
// than a bare MODULE_NOT_FOUND halfway through a handshake.
let _mlkem = null;
function mlkem512() {
  if (_mlkem) return _mlkem;
  let lib;
  try {
    lib = require('@noble/post-quantum/ml-kem.js');
  } catch (err) {
    throw new Boom(
      'the post-quantum Noise handshake needs @noble/post-quantum (ML-KEM-512); ' +
      'install it with: npm install @noble/post-quantum  (original error: ' +
      (err && err.message) + ')', { statusCode: 501 });
  }
  if (!lib || !lib.ml_kem512) throw new Boom('@noble/post-quantum has no ml_kem512 export', { statusCode: 501 });
  _mlkem = lib.ml_kem512;
  return _mlkem;
}

// A fresh ML-KEM-512 keypair: { publicKey (800B), secretKey }.
function kemKeygen() {
  const kp = mlkem512().keygen();
  return { publicKey: Buffer.from(kp.publicKey), secretKey: Buffer.from(kp.secretKey) };
}

// Encapsulate against a peer's 800-byte public key → { cipherText (768B),
// sharedSecret (32B) }. The peer decapsulates the ciphertext to the same secret.
function kemEncapsulate(peerPublicKey) {
  if (!Buffer.isBuffer(peerPublicKey) && !(peerPublicKey instanceof Uint8Array)) {
    throw new Boom('kemEncapsulate: public key must be bytes', { statusCode: 400 });
  }
  if (peerPublicKey.length !== MLKEM512_PUBLIC_KEY_BYTES) {
    throw new Boom('kemEncapsulate: ML-KEM-512 public key must be ' +
      MLKEM512_PUBLIC_KEY_BYTES + ' bytes, got ' + peerPublicKey.length, { statusCode: 400 });
  }
  const r = mlkem512().encapsulate(Uint8Array.from(peerPublicKey));
  return { cipherText: Buffer.from(r.cipherText), sharedSecret: Buffer.from(r.sharedSecret) };
}

// Decapsulate a 768-byte ciphertext with our secret key → the 32-byte secret.
function kemDecapsulate(cipherText, secretKey) {
  if (cipherText.length !== MLKEM512_CIPHERTEXT_BYTES) {
    throw new Boom('kemDecapsulate: ML-KEM-512 ciphertext must be ' +
      MLKEM512_CIPHERTEXT_BYTES + ' bytes, got ' + cipherText.length, { statusCode: 400 });
  }
  return Buffer.from(mlkem512().decapsulate(Uint8Array.from(cipherText), Uint8Array.from(secretKey)));
}

// ─── PQ TLV codec ─────────────────────────────────────────────────────────────
// A TLV is type(1 byte) || length(2 bytes big-endian) || value. The ServerHello
// payload carries, before the certificate, the pair { 0x01: "MLKEM512",
// 0x02: <800-byte ML-KEM key> }. buildTlv/readTlvs are symmetric.
function buildTlv(type, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const head = Buffer.alloc(3);
  head[0] = type & 0xff;
  head.writeUInt16BE(v.length, 1);
  return Buffer.concat([head, v]);
}

// Read consecutive TLVs from the front of `buf`, stopping after `count` of them
// (or at the end). Returns { tlvs: [{type, value}], rest }. `rest` is whatever
// followed the TLVs — on the ServerHello payload that is the certificate.
function readTlvs(buf, count) {
  const tlvs = [];
  let p = 0;
  const max = count == null ? Infinity : count;
  while (tlvs.length < max && p + 3 <= buf.length) {
    const type = buf[p];
    const len  = buf.readUInt16BE(p + 1);
    if (p + 3 + len > buf.length) break;
    tlvs.push({ type, value: buf.slice(p + 3, p + 3 + len) });
    p += 3 + len;
  }
  return { tlvs, rest: buf.slice(p) };
}

// Pull the server's ML-KEM public key out of a ServerHello payload that leads
// with the PQ TLV pair. Returns { kemPublicKey, certificate } or null when the
// payload does not start with a well-formed MLKEM512 TLV (a classic payload).
function parseServerPqPayload(payload) {
  if (!payload || payload.length < 3 || payload[0] !== TLV_TYPE.KEM_ALGORITHM) return null;
  const { tlvs, rest } = readTlvs(payload, 2);
  if (tlvs.length !== 2) return null;
  const [alg, pk] = tlvs;
  if (alg.type !== TLV_TYPE.KEM_ALGORITHM || alg.value.toString('utf8') !== KEM_ALG) return null;
  if (pk.type !== TLV_TYPE.KEM_PUBLIC_KEY || pk.value.length !== MLKEM512_PUBLIC_KEY_BYTES) return null;
  return { kemPublicKey: pk.value, certificate: rest };
}

// ─── Initial Noise hash for a given protocol name ─────────────────────────────
// Noise: name ≤ 32 bytes → the name zero-padded to 32; longer → SHA-256(name).
// hash256 is injected so this module stays free of a crypto import of its own.
function protocolHash(name, hash256) {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= 32) {
    const h = Buffer.alloc(32);
    bytes.copy(h);
    return h;
  }
  return hash256(bytes);
}

// Is the PQ path asked for? Off unless WA_NOISE_PQ is a truthy opt-in. Kept here
// so noise.js and the tests read the switch the same way.
function pqEnabled() {
  const v = String(process.env.WA_NOISE_PQ || '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

module.exports = {
  PQ_MODE,
  PQ_CONFIG_MODE,
  PROTOCOL_NAME,
  KEM_ALG,
  TLV_TYPE,
  MLKEM512_PUBLIC_KEY_BYTES,
  MLKEM512_CIPHERTEXT_BYTES,
  MLKEM512_SHARED_BYTES,
  kemKeygen,
  kemEncapsulate,
  kemDecapsulate,
  buildTlv,
  readTlvs,
  parseServerPqPayload,
  protocolHash,
  pqEnabled
};
