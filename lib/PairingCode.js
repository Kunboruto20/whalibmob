'use strict';

// Pairing by 8-character code, the alternative to scanning a QR.
//
// The account owner opens Linked Devices on their phone, picks "Link with phone
// number instead", and types in the code this module generates. That code is
// never sent to the server in the clear: it is a password, and both sides run
// it through PBKDF2 to agree on a key that wraps the ephemeral public keys they
// exchange. Someone who watches the whole conversation still cannot derive the
// shared secret without the eight characters the human typed.
//
// The exchange, in order:
//
//   1. companion_hello   — we send our ephemeral public key, encrypted under
//                          the pairing code, plus our noise public key.
//   2. (human types the code into their phone)
//   3. companion_finish  — the server pushes the primary's wrapped ephemeral
//                          key and identity key. We unwrap, do two Diffie-
//                          Hellmans, and derive adv_secret — the key the
//                          primary's account signature will be verified with.
//   4. pair-success      — the primary's signed device identity arrives; we
//                          verify it, counter-sign, and reply.
//
// After that the server drops the connection with a 515 and the next one logs
// in normally.

const crypto = require('crypto');
const { hkdfSha256 } = require('./hkdf');
const curveJs = require('./curve');

// Crockford base32 minus the ambiguous characters — no I, O, U, and no 0.
// Five random bytes become exactly eight characters.
const CROCKFORD_CHARACTERS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';

function bytesToCrockford(buffer) {
  let value = 0;
  let bitCount = 0;
  const out = [];

  for (const element of buffer) {
    value = (value << 8) | (element & 0xff);
    bitCount += 8;
    while (bitCount >= 5) {
      out.push(CROCKFORD_CHARACTERS.charAt((value >>> (bitCount - 5)) & 31));
      bitCount -= 5;
    }
  }
  if (bitCount > 0) {
    out.push(CROCKFORD_CHARACTERS.charAt((value << (5 - bitCount)) & 31));
  }
  return out.join('');
}

function generatePairingCode() {
  return bytesToCrockford(crypto.randomBytes(5));
}

/**
 * PBKDF2-SHA256 over the pairing code, 2^17 iterations, 32-byte output.
 *
 * The iteration count is what makes the eight characters worth anything: it
 * costs an attacker who captured the handshake roughly that many hashes per
 * guess across a 32^8 space.
 */
function derivePairingCodeKey(pairingCode, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(Buffer.from(String(pairingCode), 'utf8'), salt, 2 << 16, 32, 'sha256',
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function aesEncryptCTR(plaintext, key, iv) {
  const c = crypto.createCipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

function aesDecryptCTR(ciphertext, key, iv) {
  const d = crypto.createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

function aesEncryptGCM(plaintext, key, iv, aad) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad || Buffer.alloc(0));
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function hkdf(input, length, info, salt) {
  return hkdfSha256(
    input,
    salt || Buffer.alloc(32),
    info ? Buffer.from(info, 'utf8') : Buffer.alloc(0),
    length
  );
}

function stripKeyPrefix(pub) {
  if (pub && pub.length === 33 && pub[0] === 0x05) return pub.slice(1);
  return pub;
}

function sharedKey(priv, pub) {
  return Buffer.from(curveJs.sharedKey(stripKeyPrefix(priv), stripKeyPrefix(pub)));
}

function generateEphemeralKeyPair() {
  const kp = curveJs.generateKeyPair(crypto.randomBytes(32));
  return { private: Buffer.from(kp.private), public: Buffer.from(kp.public) };
}

/**
 * Wrap our ephemeral public key for the companion_hello node.
 *
 * Layout: salt(32) || iv(16) || AES-256-CTR(ephemeral public key, 32)
 * The primary reproduces the key from the code the human typed and unwraps it.
 */
async function buildWrappedEphemeralPub(pairingCode, ephemeralPublicKey) {
  const salt     = crypto.randomBytes(32);
  const iv       = crypto.randomBytes(16);
  const key      = await derivePairingCodeKey(pairingCode, salt);
  const ciphered = aesEncryptCTR(stripKeyPrefix(ephemeralPublicKey), key, iv);
  return Buffer.concat([salt, iv, ciphered]);
}

/** The inverse, applied to the primary's wrapped ephemeral key. */
async function decipherLinkPublicKey(data, pairingCode) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 80) {
    throw new Error('link_code_pairing_wrapped_primary_ephemeral_pub too short: ' + buf.length);
  }
  const salt      = buf.slice(0, 32);
  const iv        = buf.slice(32, 48);
  const payload   = buf.slice(48, 80);
  const secretKey = await derivePairingCodeKey(pairingCode, salt);
  return aesDecryptCTR(payload, secretKey, iv);
}

/**
 * Stage 3. Given what the server pushed, derive adv_secret and produce the
 * key bundle the primary needs to finish the link.
 *
 * adv_secret is the whole point of the exchange: every subsequent proof that
 * this device belongs to the account is an HMAC under it.
 *
 * @returns {{advSecretKey: string, wrappedKeyBundle: Buffer}}
 */
async function buildCompanionFinishBundle(opts) {
  const {
    pairingCode,
    pairingEphemeralPrivate,
    primaryEphemeralPubWrapped,
    primaryIdentityPub,
    identityKeyPair
  } = opts;

  const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPubWrapped, pairingCode);
  const companionSharedKey   = sharedKey(pairingEphemeralPrivate, codePairingPublicKey);

  const random       = crypto.randomBytes(32);
  const linkCodeSalt = crypto.randomBytes(32);
  const expanded     = hkdf(companionSharedKey, 32, 'link_code_pairing_key_bundle_encryption_key', linkCodeSalt);

  const encryptPayload = Buffer.concat([
    stripKeyPrefix(identityKeyPair.public),
    stripKeyPrefix(primaryIdentityPub),
    random
  ]);
  const encryptIv = crypto.randomBytes(12);
  const encrypted = aesEncryptGCM(encryptPayload, expanded, encryptIv, Buffer.alloc(0));

  const identitySharedKey = sharedKey(identityKeyPair.private, primaryIdentityPub);
  const identityPayload   = Buffer.concat([companionSharedKey, identitySharedKey, random]);
  const advSecretKey      = hkdf(identityPayload, 32, 'adv_secret').toString('base64');

  return {
    advSecretKey,
    wrappedKeyBundle: Buffer.concat([linkCodeSalt, encryptIv, encrypted])
  };
}

module.exports = {
  CROCKFORD_CHARACTERS,
  bytesToCrockford,
  generatePairingCode,
  generateEphemeralKeyPair,
  derivePairingCodeKey,
  buildWrappedEphemeralPub,
  decipherLinkPublicKey,
  buildCompanionFinishBundle,
  aesEncryptCTR,
  aesDecryptCTR,
  aesEncryptGCM,
  hkdf,
  sharedKey,
  stripKeyPrefix
};
