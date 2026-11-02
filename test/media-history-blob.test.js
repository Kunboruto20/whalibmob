'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https  = require('node:https');
const { EventEmitter } = require('node:events');
const { MEDIA_PATH, encryptMedia, getMediaKeyName, uploadMedia } = require('../lib/MediaService');
const { decryptHistoryBlob } = require('../lib/HistorySyncHandler');

// A history blob (over 64 KiB deflated) is uploaded as its own media type. The
// receive side already decrypts one under "WhatsApp History Keys"; registering
// the type lets a primary produce the same thing.

test('history blob encrypted for upload decrypts with the history decryptor', () => {
  const key   = crypto.randomBytes(32);
  const plain = crypto.randomBytes(100 * 1024);
  const { encrypted } = encryptMedia(plain, key, MEDIA_PATH['md-msg-hist'].keyName);
  assert.ok(decryptHistoryBlob(encrypted, key).equals(plain));
});

test('md-msg-hist is registered with its own upload path and key name', () => {
  assert.deepEqual(MEDIA_PATH['md-msg-hist'], {
    path: 'mms/md-msg-hist',
    keyName: 'WhatsApp History Keys'
  });
  assert.equal(getMediaKeyName('md-msg-hist'), 'WhatsApp History Keys');
});

test('uploadMedia posts a history blob to mms/md-msg-hist under the history keys', async () => {
  const plain = crypto.randomBytes(80 * 1024);
  let seen = null;

  const realRequest = https.request;
  https.request = (options, onResponse) => {
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => { chunks.push(Buffer.from(c)); };
    req.end = () => {
      seen = { path: options.path, body: Buffer.concat(chunks) };
      const res = new EventEmitter();
      res.statusCode = 200;
      onResponse(res);
      res.emit('data', Buffer.from(JSON.stringify({ url: 'https://mmg/x', direct_path: '/v/t/x' })));
      res.emit('end');
    };
    return req;
  };

  let up;
  try {
    up = await uploadMedia('md-msg-hist', plain, ['media.example'], 'AUTH');
  } finally {
    https.request = realRequest;
  }

  assert.match(seen.path, /^\/mms\/md-msg-hist\//);
  assert.equal(up.directPath, '/v/t/x');
  assert.equal(up.fileLength, plain.length);
  assert.ok(up.fileSha256.equals(crypto.createHash('sha256').update(plain).digest()));
  assert.ok(up.fileEncSha256.equals(crypto.createHash('sha256').update(seen.body).digest()));
  assert.ok(decryptHistoryBlob(seen.body, up.mediaKey).equals(plain));
});
