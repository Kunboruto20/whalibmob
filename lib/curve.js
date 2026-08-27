'use strict';

// X25519, through Node's own OpenSSL rather than a JavaScript field arithmetic
// implementation.
//
// Every session setup and every ratchet step does a Diffie-Hellman, and every
// registration derives 812 pre-keys, so this is the busiest arithmetic in the
// library. Measured on the same machine, over 3000 iterations each:
//
//   sharedKey        curve25519-js  0.765 ms/op    Node  0.040 ms/op   19x
//   generateKeyPair  curve25519-js  0.779 ms/op    Node  0.085 ms/op    9x
//
// The results are byte-identical, which is the only reason this swap is
// allowed to exist — verified over 200 random key pairs in test/curve.test.js
// rather than assumed from the fact that both claim to implement RFC 7748.
//
// Two things are deliberately NOT native:
//
//   sign / verify are XEdDSA — signing with a Montgomery key, which is what
//   Signal specifies and what WhatsApp's device identities are signed with.
//   Node has Ed25519, which is a different scheme over a different encoding of
//   the same curve; swapping one for the other would produce different bytes
//   and every signature this library has ever written would stop verifying.
//   Those two stay on curve25519-js, and that is why it is still a dependency.
//
//   The private half of generateKeyPair is clamped here rather than left as the
//   seed. curve25519-js clamps it before returning, callers store what they are
//   given, and a session written with one and read with the other would not
//   agree. Node clamps internally at use time and hands back the raw seed, so
//   the clamp has to be done explicitly to keep the returned pair identical.
//
// The API is curve25519-js's, unchanged, so this is a drop-in for it.

const crypto  = require('crypto');
const curveJs = require('curve25519-js');

// The DER wrappers Node wants around a bare 32-byte X25519 key. Both are fixed
// prefixes — the algorithm identifier and the length header — so a raw key
// becomes an importable one by concatenation.
const PRIVATE_KEY_DER_PREFIX = Buffer.from([
  48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32
]);
const PUBLIC_KEY_DER_PREFIX = Buffer.from([
  48, 42, 48, 5, 6, 3, 43, 101, 110, 3, 33, 0
]);

// Whether this Node was built with X25519. Everything below falls back to the
// JavaScript implementation when it was not, so an unusual build keeps working
// rather than failing at the first handshake.
const NATIVE = (() => {
  try {
    if (typeof crypto.diffieHellman !== 'function') return false;
    const seed = Buffer.alloc(32, 1);
    _importPrivate(seed);
    return true;
  } catch (_) { return false; }
})();

function _importPrivate(raw32) {
  return crypto.createPrivateKey({
    key:    Buffer.concat([PRIVATE_KEY_DER_PREFIX, raw32]),
    format: 'der',
    type:   'pkcs8'
  });
}

function _importPublic(raw32) {
  return crypto.createPublicKey({
    key:    Buffer.concat([PUBLIC_KEY_DER_PREFIX, raw32]),
    format: 'der',
    type:   'spki'
  });
}

// The clamp RFC 7748 specifies for X25519 private scalars, applied to a copy so
// a caller's seed is never modified underneath it.
function clamp(seed) {
  const k = Buffer.from(seed);
  k[0]  &= 248;
  k[31] &= 127;
  k[31] |= 64;
  return k;
}

/**
 * A key pair from 32 bytes of seed.
 *
 * Returns the same shape and the same bytes as curve25519-js: the private half
 * clamped, the public half derived from it.
 *
 * @param {Buffer|Uint8Array} seed  32 bytes
 * @returns {{private: Buffer, public: Buffer}}
 */
function generateKeyPair(seed) {
  if (!seed || seed.length !== 32) {
    throw new Error('generateKeyPair: seed must be 32 bytes, got ' +
      (seed ? seed.length : 'nothing'));
  }
  if (!NATIVE) {
    const kp = curveJs.generateKeyPair(seed);
    return { private: Buffer.from(kp.private), public: Buffer.from(kp.public) };
  }
  const priv = clamp(seed);
  const pub  = crypto.createPublicKey(_importPrivate(priv))
    .export({ format: 'der', type: 'spki' })
    .subarray(PUBLIC_KEY_DER_PREFIX.length);
  return { private: priv, public: Buffer.from(pub) };
}

/**
 * The X25519 shared secret between our private key and their public key.
 *
 * @param {Buffer|Uint8Array} priv  32 bytes
 * @param {Buffer|Uint8Array} pub   32 bytes
 * @returns {Buffer} 32 bytes
 */
function sharedKey(priv, pub) {
  if (!priv || priv.length !== 32) throw new Error('sharedKey: private key must be 32 bytes');
  if (!pub  || pub.length  !== 32) throw new Error('sharedKey: public key must be 32 bytes');
  if (!NATIVE) return Buffer.from(curveJs.sharedKey(priv, pub));
  return crypto.diffieHellman({
    privateKey: _importPrivate(Buffer.from(priv)),
    publicKey:  _importPublic(Buffer.from(pub))
  });
}

/**
 * XEdDSA signature. Not native — see the note at the top of this file.
 *
 * @returns {Buffer} 64 bytes
 */
function sign(priv, message) {
  return Buffer.from(curveJs.sign(priv, message));
}

/** XEdDSA verification. Not native — see the note at the top of this file. */
function verify(pub, message, signature) {
  return curveJs.verify(pub, message, signature);
}

module.exports = {
  generateKeyPair,
  sharedKey,
  sign,
  verify,
  /** Whether Node's X25519 is being used. `false` means the JS fallback is. */
  NATIVE
};
