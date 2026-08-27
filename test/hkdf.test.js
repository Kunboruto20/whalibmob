'use strict';

// HKDF through Node's OpenSSL, against the JavaScript implementation it
// replaces.
//
// Same standard as the curve: a derived key that differs anywhere produces
// ciphertext that decrypts to noise rather than an error, so equality is
// checked byte for byte over random inputs, and over every shape the callers
// in this library actually pass — an empty salt, a 32-zero salt, a string as
// info, an empty Uint8Array as info, and the exact lengths in use.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { hkdf }   = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha256');
const { hkdfSha256, NATIVE } = require('../lib/hkdf');

const ref = (ikm, salt, info, len) => Buffer.from(hkdf(sha256, ikm, salt, info, len));

test('Node HKDF is actually being used', () => {
  assert.equal(NATIVE, true,
    'the native path is not active, so these comparisons prove nothing here');
});

test('it returns a Buffer, not an ArrayBuffer', () => {
  // hkdfSync hands back an ArrayBuffer. Callers here index it, slice it and
  // compare it as a Buffer, so anything else breaks far from the cause.
  const out = hkdfSha256(crypto.randomBytes(32), Buffer.alloc(0), Buffer.alloc(0), 32);
  assert.ok(Buffer.isBuffer(out), 'got ' + out.constructor.name);
  assert.equal(out.length, 32);
});

test('random inputs agree byte for byte', () => {
  for (let i = 0; i < 300; i++) {
    const ikm  = crypto.randomBytes(1 + Math.floor(Math.random() * 64));
    const salt = Math.random() < 0.5 ? Buffer.alloc(0) : crypto.randomBytes(32);
    const info = Math.random() < 0.5 ? Buffer.alloc(0) : crypto.randomBytes(16);
    const len  = 1 + Math.floor(Math.random() * 200);

    assert.equal(
      hkdfSha256(ikm, salt, info, len).toString('hex'),
      ref(ikm, salt, info, len).toString('hex')
    );
  }
});

// ─── every shape this library actually passes ────────────────────────────────

test('the exact call shapes the callers use', () => {
  const ikm = crypto.randomBytes(32);
  const shapes = [
    // MediaService, HistorySyncHandler — empty salt, Buffer info, 112 bytes
    [Buffer.alloc(0), Buffer.from('WhatsApp Image Keys', 'utf8'), 112],
    // SenderKey — random salt, 48 bytes
    [crypto.randomBytes(32), Buffer.from('WhisperGroup', 'utf8'), 48],
    // LTHash — empty salt, a utf8 string turned Buffer, 128 bytes
    [Buffer.alloc(0), Buffer.from('WhatsApp Patch Integrity', 'utf8'), 128],
    // ReportingToken — a 32-byte zero salt, not an empty one
    [Buffer.alloc(32), crypto.randomBytes(16), 32],
    // noise — an empty Uint8Array as info
    [crypto.randomBytes(32), new Uint8Array(0), 64],
    // PairingCode — a plain string as info
    [Buffer.alloc(0), 'adv_secret', 32],
    [crypto.randomBytes(32), 'link_code_pairing_key_bundle_encryption_key', 32]
  ];

  for (const [salt, info, len] of shapes) {
    assert.equal(
      hkdfSha256(ikm, salt, info, len).toString('hex'),
      ref(ikm, salt, info, len).toString('hex'),
      'shape: salt=' + salt.length + ' info=' + (typeof info === 'string' ? info : info.length) + ' len=' + len
    );
  }
});

test('a one-byte output and a long one both agree', () => {
  const ikm  = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  for (const len of [1, 31, 32, 33, 64, 112, 128, 255, 1024]) {
    assert.equal(
      hkdfSha256(ikm, salt, Buffer.from('x'), len).toString('hex'),
      ref(ikm, salt, Buffer.from('x'), len).toString('hex'),
      'length ' + len
    );
  }
});

test('the same inputs always give the same bytes', () => {
  const ikm  = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  const once = hkdfSha256(ikm, salt, Buffer.from('info'), 64);
  for (let i = 0; i < 5; i++) {
    assert.equal(hkdfSha256(ikm, salt, Buffer.from('info'), 64).toString('hex'),
      once.toString('hex'));
  }
});

test('changing any input changes the output', () => {
  const ikm  = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  const base = hkdfSha256(ikm, salt, Buffer.from('a'), 32).toString('hex');

  const other = Buffer.from(ikm); other[0] ^= 1;
  assert.notEqual(hkdfSha256(other, salt, Buffer.from('a'), 32).toString('hex'), base);

  const salt2 = Buffer.from(salt); salt2[0] ^= 1;
  assert.notEqual(hkdfSha256(ikm, salt2, Buffer.from('a'), 32).toString('hex'), base);

  assert.notEqual(hkdfSha256(ikm, salt, Buffer.from('b'), 32).toString('hex'), base);
});

test('no module imports @noble/hashes/hkdf except lib/hkdf.js', () => {
  const { execSync } = require('node:child_process');
  const hits = execSync(
    "grep -rln \"require('@noble/hashes/hkdf')\" lib/ --include=*.js || true",
    { cwd: __dirname + '/..' }
  ).toString().trim().split('\n').filter(Boolean);

  assert.deepEqual(hits, ['lib/hkdf.js'],
    'lib/hkdf.js is the one place that may reach for the JavaScript ' +
    'implementation, and only as a fallback for a Node without hkdfSync');
});
