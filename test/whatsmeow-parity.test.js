'use strict';

// Four things whatsmeow does on the web side that this did not.
//
//   - every media download checks both digests the message carried, not just
//     the MAC and not only when asked
//   - a link preview's thumbnail is a media file of its own and can be fetched
//   - <clean> carries the timestamp the <dirty> announcement named, so the
//     server knows which change is being acknowledged
//   - a vote on a poll can be read
//
// The fifth, logout, needs a live server to mean anything; what is checked here
// is that it refuses the cases it should refuse.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');
const { hkdfSha256 }      = require('../lib/hkdf');
const {
  encryptMedia, downloadMedia, getThumbnailKeyName, getMediaKeyName
} = require('../lib/MediaService');
const {
  decodeMessageContainer, field, str, bytes, WIRE_LEN
} = require('../lib/proto/MessageProto');

// ─── media digests ───────────────────────────────────────────────────────────
//
// A real HTTP server on loopback, so the whole download path runs rather than a
// stub standing in for the half of it that matters.

const http = require('node:http');

const MEDIA_KEY = crypto.randomBytes(32);

let server, base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const buf = server._serve || Buffer.alloc(0);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(buf);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/media.enc';
});

test.after(() => new Promise(r => server.close(r)));

const serve = (buf) => { server._serve = buf; return base; };

test('a download checks the encrypted digest by default, without being asked', async () => {
  const plain = Buffer.from('a picture of a cat');
  const { encrypted, sha256Enc, sha256Plain } =
    encryptMedia(plain, MEDIA_KEY, 'WhatsApp Image Keys');

  const ok = await downloadMedia(serve(encrypted), MEDIA_KEY, 'WhatsApp Image Keys', {
    fileEncSha256: sha256Enc, fileSha256: sha256Plain
  });
  assert.equal(ok.toString(), 'a picture of a cat');
});

test('a blob that is not the one the message described is refused', async () => {
  const { encrypted } = encryptMedia(
    Buffer.from('a picture of a cat'), MEDIA_KEY, 'WhatsApp Image Keys');

  await assert.rejects(
    downloadMedia(serve(encrypted), MEDIA_KEY, 'WhatsApp Image Keys', {
      fileEncSha256: crypto.randomBytes(32)
    }),
    /fileEncSha256 mismatch/);
});

test('a plaintext that is not the file described is refused too', async () => {
  // The MAC is over the ciphertext, so a blob that decrypts cleanly can still
  // be the wrong file. whatsmeow calls this ErrInvalidMediaSHA256; nothing here
  // checked it at all, though every upload writes the digest.
  const { encrypted, sha256Enc } = encryptMedia(
    Buffer.from('a picture of a cat'), MEDIA_KEY, 'WhatsApp Image Keys');

  await assert.rejects(
    downloadMedia(serve(encrypted), MEDIA_KEY, 'WhatsApp Image Keys', {
      fileEncSha256: sha256Enc, fileSha256: crypto.randomBytes(32)
    }),
    /fileSha256 mismatch/);
});

test('a digest of the wrong length is a mismatch, not a crash', async () => {
  // timingSafeEqual throws on unequal lengths rather than returning false.
  const { encrypted } = encryptMedia(
    Buffer.from('x'), MEDIA_KEY, 'WhatsApp Image Keys');

  await assert.rejects(
    downloadMedia(serve(encrypted), MEDIA_KEY, 'WhatsApp Image Keys', {
      fileEncSha256: Buffer.alloc(7)
    }),
    /fileEncSha256 is the wrong length/);
});

test('verify:false skips the digests but never the MAC', async () => {
  const { encrypted } = encryptMedia(
    Buffer.from('a picture of a cat'), MEDIA_KEY, 'WhatsApp Image Keys');

  // Wrong digests, but they are not looked at.
  const out = await downloadMedia(serve(encrypted), MEDIA_KEY, 'WhatsApp Image Keys', {
    verify: false,
    fileEncSha256: crypto.randomBytes(32), fileSha256: crypto.randomBytes(32)
  });
  assert.equal(out.toString(), 'a picture of a cat');

  // The MAC is not optional.
  const tampered = Buffer.from(encrypted);
  tampered[0] ^= 0xff;
  await assert.rejects(
    downloadMedia(serve(tampered), MEDIA_KEY, 'WhatsApp Image Keys', { verify: false }),
    /MAC verification failed/);
});

test('a message with no digests still downloads — there is nothing to check', async () => {
  const { encrypted } = encryptMedia(
    Buffer.from('from history sync, no digests'), MEDIA_KEY, 'WhatsApp Document Keys');

  const out = await downloadMedia(serve(encrypted), MEDIA_KEY, 'WhatsApp Document Keys', {});
  assert.equal(out.toString(), 'from history sync, no digests');
});

// ─── link preview thumbnails ─────────────────────────────────────────────────

test('a thumbnail is keyed under its own name, not the message\'s', () => {
  assert.equal(getThumbnailKeyName('text'), 'WhatsApp Link Thumbnail Keys');
  assert.notEqual(getThumbnailKeyName('text'), getMediaKeyName('image'),
    'reading it as an image is a MAC failure and nothing else');
});

test('a link preview comes off the message with everything needed to fetch it', () => {
  const thumbKey = crypto.randomBytes(32);
  const encSha   = crypto.randomBytes(32);
  const plainSha = crypto.randomBytes(32);

  // ExtendedTextMessage: text=1 matchedText=2 description=5 title=6
  //                      jpegThumbnail=16 thumbnailDirectPath=19
  //                      thumbnailSha256=20 thumbnailEncSha256=21 mediaKey=22
  const ext = Buffer.concat([
    field(1,  WIRE_LEN, str('look at this https://example.com')),
    field(2,  WIRE_LEN, str('https://example.com')),
    field(5,  WIRE_LEN, str('An example domain')),
    field(6,  WIRE_LEN, str('Example')),
    field(16, WIRE_LEN, bytes(Buffer.from([0xff, 0xd8, 0xff]))),
    field(19, WIRE_LEN, str('/v/t62.1234-24/thumb.enc')),
    field(20, WIRE_LEN, bytes(plainSha)),
    field(21, WIRE_LEN, bytes(encSha)),
    field(22, WIRE_LEN, bytes(thumbKey))
  ]);
  const d = decodeMessageContainer(field(6, WIRE_LEN, ext));

  assert.equal(d.type, 'text');
  assert.equal(d.text, 'look at this https://example.com');
  assert.equal(d.title, 'Example');
  assert.equal(d.description, 'An example domain');
  assert.equal(d.matchedText, 'https://example.com');
  assert.ok(d.jpegThumbnail, 'the small inline one needs no download');

  assert.ok(d.thumbnail, 'and the full-size one can be fetched');
  assert.equal(d.thumbnail.directPath, '/v/t62.1234-24/thumb.enc');
  assert.equal(d.thumbnail.mediaKey.toString('hex'), thumbKey.toString('hex'));
  assert.equal(d.thumbnail.thumbnailSha256.toString('hex'), plainSha.toString('hex'));
  assert.equal(d.thumbnail.thumbnailEncSha256.toString('hex'), encSha.toString('hex'));
});

test('a plain text message has no thumbnail to offer', () => {
  const d = decodeMessageContainer(field(1, WIRE_LEN, str('hello')));
  assert.equal(d.type, 'text');
  assert.equal(d.thumbnail, undefined);
});

test('downloadThumbnail refuses a message that carries none', async () => {
  const c = Object.create(WhalibmobClient.prototype);
  await assert.rejects(
    c.downloadThumbnail({ type: 'text', text: 'hello' }),
    /no downloadable thumbnail/);
});

// ─── <clean timestamp> ───────────────────────────────────────────────────────

function dirtyClient() {
  const sent = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true,
    _genMsgId: () => 'ID1',
    _socket: { sendNode: (n) => sent.push(n) },
    _events: {},
    emit() {},
    syncAppState: async () => ({}),
    fetchAllGroups: async () => []
  });
  c.sent = sent;
  c.cleans = () => sent
    .filter(n => n.description === 'iq' && n.attrs.xmlns === 'urn:xmpp:whatsapp:dirty')
    .map(n => n.content[0].attrs);
  return c;
}

test('the timestamp on <dirty> comes back on the <clean> that clears it', async () => {
  const c = dirtyClient();
  c._handleIb(new BinaryNode('ib', {}, [
    new BinaryNode('dirty', { type: 'groups', timestamp: '1788651994' }, null)
  ]));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const [clean] = c.cleans();
  assert.ok(clean, 'the bit was acknowledged');
  assert.equal(clean.type, 'groups');
  assert.equal(clean.timestamp, '1788651994',
    'without it nothing in particular is acknowledged and the server re-announces');
});

test('a dirty bit that names no timestamp is still cleared', () => {
  const c = dirtyClient();
  c._handleIb(new BinaryNode('ib', {}, [
    new BinaryNode('dirty', { type: 'urn:xmpp:whatsapp:account' }, null)
  ]));

  const [clean] = c.cleans();
  assert.equal(clean.type, 'urn:xmpp:whatsapp:account');
  assert.equal(clean.timestamp, undefined);
});

test('markNotDirty builds the node whatsmeow builds', () => {
  const c = dirtyClient();
  assert.equal(c.markNotDirty('account_sync', 1788651994), true);

  const [node] = c.sent;
  assert.equal(node.attrs.xmlns, 'urn:xmpp:whatsapp:dirty');
  assert.equal(node.attrs.type, 'set');
  assert.equal(node.content[0].description, 'clean');
  assert.equal(node.content[0].attrs.type, 'account_sync');
  assert.equal(node.content[0].attrs.timestamp, '1788651994');
});

test('markNotDirty says no rather than throwing when it cannot send', () => {
  const c = dirtyClient();
  c._connected = false;
  assert.equal(c.markNotDirty('groups', 1), false);
});

// ─── poll votes ──────────────────────────────────────────────────────────────

const POLL_ID     = '3EB0ABCDEF0123456789';
const POLL_SENDER = '40711111111@s.whatsapp.net';
const VOTER       = '40722222222@s.whatsapp.net';

// Build the vote the way a real client does, so the test proves the derivation
// rather than restating it.
function castVote(secret, options, chosen, opts) {
  opts = opts || {};
  const pollId = opts.pollId || POLL_ID;
  const sender = opts.pollSender || POLL_SENDER;
  const voter  = opts.voter || VOTER;

  const info = Buffer.concat([
    Buffer.from(pollId), Buffer.from(sender), Buffer.from(voter), Buffer.from('Poll Vote')
  ]);
  const key = hkdfSha256(secret, Buffer.alloc(0), info, 32);
  const aad = Buffer.concat([Buffer.from(pollId), Buffer.from([0]), Buffer.from(voter)]);

  // PollVoteMessage { selectedOptions = 1, repeated bytes }
  const ballot = Buffer.concat(chosen.map(o =>
    field(1, WIRE_LEN, bytes(crypto.createHash('sha256').update(o, 'utf8').digest()))));

  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const enc = Buffer.concat([c.update(ballot), c.final(), c.getAuthTag()]);

  // PollUpdateMessage { pollCreationMessageKey=1, vote=2, senderTimestampMs=3 }
  const msgKey = Buffer.concat([
    field(1, WIRE_LEN, str(sender)),
    field(3, WIRE_LEN, str(pollId))
  ]);
  const voteNode = Buffer.concat([
    field(1, WIRE_LEN, bytes(enc)),
    field(2, WIRE_LEN, bytes(iv))
  ]);
  const upd = Buffer.concat([
    field(1, WIRE_LEN, msgKey),
    field(2, WIRE_LEN, voteNode)
  ]);
  return decodeMessageContainer(field(50, WIRE_LEN, upd));
}

test('a vote decodes with the poll it belongs to, not just the word "pollVote"', () => {
  const d = castVote(crypto.randomBytes(32), ['yes', 'no'], ['yes']);

  assert.equal(d.type, 'pollVote');
  assert.equal(d.pollKey.id, POLL_ID);
  assert.equal(d.pollKey.remoteJid, POLL_SENDER);
  assert.ok(d.encPayload && d.encIv, 'and the ballot is there to be opened');
});

test('the ballot opens and names the option that was chosen', () => {
  const secret = crypto.randomBytes(32);
  const d = castVote(secret, ['pizza', 'pasta', 'salad'], ['pasta']);
  const c = Object.create(WhalibmobClient.prototype);

  const out = c.decryptPollVote({ decoded: d, participant: VOTER, from: VOTER }, {
    encKey: secret, options: ['pizza', 'pasta', 'salad']
  });

  assert.deepEqual(out.selected, ['pasta']);
  assert.equal(out.selectedHashes.length, 1);
});

test('more than one choice comes back in full', () => {
  const secret = crypto.randomBytes(32);
  const d = castVote(secret, ['a', 'b', 'c'], ['a', 'c']);
  const c = Object.create(WhalibmobClient.prototype);

  const out = c.decryptPollVote({ decoded: d, participant: VOTER }, {
    encKey: secret, options: ['a', 'b', 'c']
  });
  assert.deepEqual(out.selected.sort(), ['a', 'c']);
});

test('without the options you still get the hashes to match yourself', () => {
  const secret = crypto.randomBytes(32);
  const d = castVote(secret, ['yes', 'no'], ['no']);
  const c = Object.create(WhalibmobClient.prototype);

  const out = c.decryptPollVote({ decoded: d, participant: VOTER }, { encKey: secret });
  assert.deepEqual(out.selected, []);
  assert.equal(out.selectedHashes[0].toString('hex'),
    crypto.createHash('sha256').update('no', 'utf8').digest('hex'));
});

test('the voter is part of the key, so the wrong one does not open it', () => {
  const secret = crypto.randomBytes(32);
  const d = castVote(secret, ['yes', 'no'], ['yes']);
  const c = Object.create(WhalibmobClient.prototype);

  assert.throws(
    () => c.decryptPollVote({ decoded: d, participant: '40799999999@s.whatsapp.net' },
      { encKey: secret }),
    /would not open/);
});

test('the wrong poll secret does not open it either', () => {
  const d = castVote(crypto.randomBytes(32), ['yes', 'no'], ['yes']);
  const c = Object.create(WhalibmobClient.prototype);

  assert.throws(
    () => c.decryptPollVote({ decoded: d, participant: VOTER },
      { encKey: crypto.randomBytes(32) }),
    /would not open/);
});

test('the device is dropped from both JIDs — a vote belongs to an account', () => {
  const secret = crypto.randomBytes(32);
  const d = castVote(secret, ['yes'], ['yes']);
  const c = Object.create(WhalibmobClient.prototype);

  // Same account, but the stanza named the device it was cast from.
  const out = c.decryptPollVote(
    { decoded: d, participant: '40722222222:7@s.whatsapp.net' },
    { encKey: secret, options: ['yes'] });
  assert.deepEqual(out.selected, ['yes']);
});

test('decryptPollVote refuses what it cannot work with', () => {
  const c = Object.create(WhalibmobClient.prototype);
  assert.throws(() => c.decryptPollVote({ type: 'text', text: 'x' }, { encKey: Buffer.alloc(32) }),
    /not a vote on a poll/);
  assert.throws(() => c.decryptPollVote({ type: 'pollVote' }, { encKey: Buffer.alloc(32) }),
    /no encrypted ballot/);

  const d = castVote(crypto.randomBytes(32), ['yes'], ['yes']);
  assert.throws(() => c.decryptPollVote({ decoded: d, participant: VOTER }, {}),
    /32-byte encKey is required/);
});

// ─── logout ──────────────────────────────────────────────────────────────────

test('logout refuses a session that registered its own number', async () => {
  const c = Object.assign(Object.create(WhalibmobClient.prototype), { _mode: 'mobile' });
  await assert.rejects(c.logout(), /only a companion can unlink itself/);
});

test('logout refuses when there is no connection to ask over', async () => {
  const c = Object.assign(Object.create(WhalibmobClient.prototype),
    { _mode: 'web', _connected: false, _socket: null });
  await assert.rejects(c.logout(), /Not connected/);
});

test('logout asks the server to remove this companion, then drops the connection', async () => {
  let asked = null, disconnected = false;
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _mode: 'web', _connected: true, _socket: { sendNode() {} },
    _genMsgId: () => 'ID1',
    _ownDeviceJid: () => '40711111111:3@s.whatsapp.net',
    _sendIq: async (node) => { asked = node; return new BinaryNode('iq', { type: 'result' }, null); },
    disconnect: () => { disconnected = true; }
  });

  assert.equal(await c.logout(), true);
  assert.equal(asked.attrs.xmlns, 'md');
  assert.equal(asked.attrs.type, 'set');
  const child = asked.content[0];
  assert.equal(child.description, 'remove-companion-device');
  assert.equal(String(child.attrs.jid), '40711111111@s.whatsapp.net', 'named without the device');
  assert.equal(child.attrs.reason, 'user_initiated');
  assert.equal(disconnected, true);
});

test('a refused logout still drops the connection', async () => {
  let disconnected = false;
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _mode: 'web', _connected: true, _socket: { sendNode() {} },
    _genMsgId: () => 'ID1',
    _ownDeviceJid: () => '40711111111:3@s.whatsapp.net',
    _sendIq: async () => new BinaryNode('iq', { type: 'error' }, null),
    disconnect: () => { disconnected = true; }
  });

  assert.equal(await c.logout(), false);
  assert.equal(disconnected, true, 'we asked to be forgotten; staying on is worse');
});
