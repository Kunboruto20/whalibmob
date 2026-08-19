'use strict';

// Media encryption. A mistake here does not throw — it produces bytes that
// decrypt to garbage, or a download the CDN refuses — so the round-trip, the
// tamper check and the key-name mapping are all worth pinning down.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  encryptMedia, decryptMedia, deriveMediaKeyData, getMediaKeyName, MEDIA_PATH
} = require('../lib/MediaService');

const KEY  = crypto.randomBytes(32);
const NAME = 'WhatsApp Image Keys';

test('what is encrypted comes back exactly', () => {
  const plaintext = crypto.randomBytes(4096);
  const { encrypted } = encryptMedia(plaintext, KEY, NAME);

  assert.notEqual(encrypted.toString('hex'), plaintext.toString('hex'), 'it is actually encrypted');

  const back = decryptMedia(encrypted, KEY, NAME);
  assert.equal(back.toString('hex'), plaintext.toString('hex'));
});

test('an empty file round-trips too', () => {
  const { encrypted } = encryptMedia(Buffer.alloc(0), KEY, NAME);
  assert.equal(decryptMedia(encrypted, KEY, NAME).length, 0);
});

test('a file that is an exact multiple of the AES block still round-trips', () => {
  // CBC pads, so 16 bytes in becomes 32 out plus the MAC. An off-by-one in the
  // padding handling only shows up on exact block boundaries.
  const plaintext = crypto.randomBytes(16);
  const { encrypted } = encryptMedia(plaintext, KEY, NAME);
  assert.equal(decryptMedia(encrypted, KEY, NAME).toString('hex'), plaintext.toString('hex'));
});

test('encryptMedia reports both digests, over the right bytes', () => {
  const plaintext = crypto.randomBytes(1024);
  const r = encryptMedia(plaintext, KEY, NAME);

  assert.equal(
    r.sha256Plain.toString('hex'),
    crypto.createHash('sha256').update(plaintext).digest('hex'),
    'fileSha256 is over the plaintext'
  );
  assert.equal(
    r.sha256Enc.toString('hex'),
    crypto.createHash('sha256').update(r.encrypted).digest('hex'),
    'fileEncSha256 is over the ciphertext including its MAC'
  );
});

test('the ciphertext carries a 10-byte MAC on the end', () => {
  const plaintext = crypto.randomBytes(100);
  const { encrypted } = encryptMedia(plaintext, KEY, NAME);
  // 100 bytes padded to 112, plus 10 bytes of MAC.
  assert.equal(encrypted.length, 112 + 10);
});

test('a tampered ciphertext is refused, not silently decrypted to garbage', () => {
  const { encrypted } = encryptMedia(crypto.randomBytes(512), KEY, NAME);

  const flipped = Buffer.from(encrypted);
  flipped[0] ^= 0x01;
  assert.throws(() => decryptMedia(flipped, KEY, NAME), /MAC verification failed/);
});

test('a tampered MAC is refused', () => {
  const { encrypted } = encryptMedia(crypto.randomBytes(512), KEY, NAME);
  const flipped = Buffer.from(encrypted);
  flipped[flipped.length - 1] ^= 0x01;
  assert.throws(() => decryptMedia(flipped, KEY, NAME), /MAC verification failed/);
});

test('a truncated download is refused', () => {
  const { encrypted } = encryptMedia(crypto.randomBytes(512), KEY, NAME);
  assert.throws(() => decryptMedia(encrypted.slice(0, encrypted.length - 20), KEY, NAME));
});

test('the wrong media key does not decrypt', () => {
  const { encrypted } = encryptMedia(crypto.randomBytes(512), KEY, NAME);
  assert.throws(() => decryptMedia(encrypted, crypto.randomBytes(32), NAME), /MAC verification failed/);
});

test('the wrong key NAME does not decrypt — the info string is part of the key', () => {
  // This is the mistake behind "the download worked but the file is garbage":
  // a voice note decrypted with the video info string.
  const { encrypted } = encryptMedia(crypto.randomBytes(512), KEY, 'WhatsApp Image Keys');
  assert.throws(() => decryptMedia(encrypted, KEY, 'WhatsApp Video Keys'), /MAC verification failed/);
});

test('deriveMediaKeyData expands to 112 bytes and is deterministic', () => {
  const a = deriveMediaKeyData(KEY, NAME);
  const b = deriveMediaKeyData(KEY, NAME);
  assert.equal(a.length, 112, '16 IV + 32 cipher + 32 MAC, with room to spare');
  assert.equal(a.toString('hex'), b.toString('hex'));

  const other = deriveMediaKeyData(KEY, 'WhatsApp Video Keys');
  assert.notEqual(a.toString('hex'), other.toString('hex'), 'the info string changes the output');
});

test('getMediaKeyName follows the reference client, not the endpoint name', () => {
  assert.equal(getMediaKeyName('image'), 'WhatsApp Image Keys');
  assert.equal(getMediaKeyName('video'), 'WhatsApp Video Keys');
  assert.equal(getMediaKeyName('audio'), 'WhatsApp Audio Keys');
  assert.equal(getMediaKeyName('document'), 'WhatsApp Document Keys');
  // A sticker is keyed as an image and a voice note as audio — their own names
  // are not HKDF info strings anywhere.
  assert.equal(getMediaKeyName('sticker'), 'WhatsApp Image Keys');
  assert.equal(getMediaKeyName('ptt'), 'WhatsApp Audio Keys');
  assert.equal(getMediaKeyName('gif'), 'WhatsApp Video Keys');
  assert.equal(getMediaKeyName('nonsense'), null);
});

test('a sticker encrypted as a sticker is readable as an image, and vice versa', () => {
  const plaintext = crypto.randomBytes(256);
  const { encrypted } = encryptMedia(plaintext, KEY, getMediaKeyName('sticker'));
  const back = decryptMedia(encrypted, KEY, getMediaKeyName('image'));
  assert.equal(back.toString('hex'), plaintext.toString('hex'));
});

test('every media type has an upload path and a key name', () => {
  for (const [type, info] of Object.entries(MEDIA_PATH)) {
    assert.ok(info.path, `${type} has an upload path`);
    assert.ok(info.keyName, `${type} has a key name`);
    assert.match(info.keyName, /^WhatsApp .+ Keys$/, `${type} key name is well formed`);
  }
});
