'use strict';

// HKDF-SHA256, through Node's own OpenSSL.
//
// Every media key, every app-state key, every Noise handshake and every sender
// key goes through this, so it runs on nearly every operation the library
// performs. Measured over 20000 iterations at the 112-byte length the media
// path uses:
//
//   @noble/hashes  20.99 us/op      Node  9.38 us/op      2.2x
//
// Byte-identical over 300 random combinations of key material, salt and info
// at random lengths — checked in test/hkdf.test.js rather than assumed from
// both implementing RFC 5869.
//
// Two details this wrapper exists to get right:
//
//   Node's hkdfSync returns an ArrayBuffer, not a Buffer. Handing one to code
//   that expects a Buffer gives an object with no `.equals`, no `.subarray`
//   returning a Buffer, and a `.length` that is `undefined` — mistakes that
//   surface far from here. A Buffer is what comes back from this.
//
//   The argument order is @noble's, so this is a drop-in for it, with the hash
//   argument dropped since it is always SHA-256 here.

const crypto = require('crypto');

// Whether this Node has hkdfSync. It arrived in Node 15; the fallback keeps an
// older one working rather than failing at the first key derivation.
const NATIVE = typeof crypto.hkdfSync === 'function';

let _nobleHkdf = null, _nobleSha = null;
function _noble() {
  if (!_nobleHkdf) {
    _nobleHkdf = require('@noble/hashes/hkdf').hkdf;
    _nobleSha  = require('@noble/hashes/sha256').sha256;
  }
  return { hkdf: _nobleHkdf, sha256: _nobleSha };
}

/**
 * Expand key material into `length` bytes.
 *
 * @param {Buffer|Uint8Array} ikm     the input key material
 * @param {Buffer|Uint8Array|string} salt  may be empty
 * @param {Buffer|Uint8Array|string} info  may be empty
 * @param {number} length             how many bytes to produce
 * @returns {Buffer}
 */
function hkdfSha256(ikm, salt, info, length) {
  if (!NATIVE) {
    const n = _noble();
    return Buffer.from(n.hkdf(n.sha256, ikm, salt, info, length));
  }
  // Buffer.from(ArrayBuffer) is a view over the same memory rather than a copy,
  // which is fine here because the ArrayBuffer is freshly allocated by
  // hkdfSync and nothing else holds a reference to it.
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

module.exports = {
  hkdfSha256,
  /** Whether Node's HKDF is in use; `false` means the JavaScript fallback is. */
  NATIVE
};
