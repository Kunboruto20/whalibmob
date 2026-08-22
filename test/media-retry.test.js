'use strict';

// The answer to a media-retry request.
//
// What decryptRetryNotification hands back is described in three places — the
// JSDoc, MediaRetryResult in index.d.ts, and the code — and they had drifted:
// the declaration made directPath optional where the code returns null, and the
// JSDoc promised a url, a handle and a ciphertextSha256 that have never been
// returned at all. A caller under --strict who tested for undefined got it
// wrong, because null is what arrives.
//
// So the shape is pinned here, on both paths, against a real round-trip.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  mediaRetryKey, decryptRetryNotification
} = require('../lib/messages/MediaRetry');
const { field, str, varint, WIRE_LEN, WIRE_VARINT } = require('../lib/proto/MessageProto');

const MEDIA_KEY = crypto.randomBytes(32);
const MSG_ID    = '3EB0C767D26B8F4A9A1B';

// MediaRetryNotification { stanzaId = 1, directPath = 2, result = 3 }
function notification(result, directPath) {
  const parts = [field(1, WIRE_LEN, str(MSG_ID))];
  if (directPath) parts.push(field(2, WIRE_LEN, str(directPath)));
  parts.push(field(3, WIRE_VARINT, varint(result)));
  const plaintext = Buffer.concat(parts);

  // Encrypted the way the phone encrypts it: AES-256-GCM under the key derived
  // from the media key, with the message id as the additional data.
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mediaRetryKey(MEDIA_KEY), iv);
  cipher.setAAD(Buffer.from(MSG_ID, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    messageId:  MSG_ID,
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
    iv
  };
}

test('the phone re-uploaded it: a location, and ok', () => {
  const r = decryptRetryNotification(notification(1, '/d/f/fresh.enc'), MEDIA_KEY);

  assert.equal(r.ok, true);
  assert.equal(r.result, 1);
  assert.equal(r.directPath, '/d/f/fresh.enc');
  assert.equal(r.stanzaId, MSG_ID);
});

test('the phone declined: directPath is null, not missing', () => {
  // The distinction the declaration used to get wrong. `directPath?: string`
  // says undefined; what arrives is null, and `!== undefined` lets it through.
  const r = decryptRetryNotification(notification(2, null), MEDIA_KEY);

  assert.equal(r.ok, false);
  assert.equal(r.result, 2);
  assert.equal(r.directPath, null);
  assert.notEqual(r.directPath, undefined, 'null, and not undefined');
  assert.ok('directPath' in r, 'the key is present even when there is no path');
});

test('it returns exactly the keys index.d.ts describes — no url, no handle', () => {
  const r = decryptRetryNotification(notification(1, '/d/f/fresh.enc'), MEDIA_KEY);

  assert.deepEqual(Object.keys(r).sort(), ['directPath', 'ok', 'result', 'stanzaId']);
  // The three the JSDoc used to promise. Nothing has ever set them.
  for (const ghost of ['url', 'handle', 'ciphertextSha256']) {
    assert.equal(r[ghost], undefined, ghost + ' is not something this returns');
  }
});

test('a notification with no payload is refused rather than half-read', () => {
  assert.throws(() => decryptRetryNotification({ messageId: MSG_ID }, MEDIA_KEY),
    /carried no payload/);
});

test('a notification for another message will not decrypt', () => {
  // The message id is the additional data, so a receipt cannot be lifted from
  // one message and replayed against another.
  const n = notification(1, '/d/f/fresh.enc');
  n.messageId = 'SOMEOTHERMESSAGEID00';
  assert.throws(() => decryptRetryNotification(n, MEDIA_KEY));
});
