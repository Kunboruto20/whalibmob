'use strict';

// What the reference web client does that this did not, beyond linking.
//
//   - add-ons sealed under a message secret can be read and written: a vote, a
//     reaction or comment in an announcement group, an event response
//   - a Message the caller encoded can be sent, and a vote and a pin with it
//   - a keepalive ping that goes unanswered is noticed
//   - the server's offline-sync, ban, picture and about announcements surface
//   - channels can be read, reacted to and followed along
//   - labels and delete-for-me travel through app state
//   - sub groups, links and bots can be asked about
//
// The client is a prototype instance over a stub socket. Where a derivation is
// checked, the other side of it is computed here with node's own crypto.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');
const MS    = require('../lib/messages/MessageSecret');
const Proto = require('../lib/proto/MessageProto');
const Syncd = require('../lib/appstate/SyncdProto');
const Mut   = require('../lib/appstate/Mutations');
const { MessageSender } = require('../lib/messages/MessageSender');

const SERVER = 's.whatsapp.net';
const child = (node, desc) =>
  (Array.isArray(node && node.content) ? node.content.find(c => c.description === desc) : null) || null;
const flush = () => new Promise(r => setImmediate(r));

function varint(v) {
  const out = [];
  do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
const lenField = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), Buffer.from(buf)]);
const intField = (num, v)   => Buffer.concat([varint(num << 3), varint(v)]);

function client(opts) {
  opts = opts || {};
  const sent = [], iqs = [], emitted = [], raw = [], patches = [];
  let n = 0;
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _mode: 'web', _connected: true,
    _store: { phoneNumber: '40712345678', deviceIndex: 7 },
    _myLid: '112713111982325:7@lid',
    _lidToPn: new Map(), _pnToLid: new Map(),
    _socket: { sendNode: (node) => sent.push(node) },
    _sender: { sendRaw: async (to, message, o) => { raw.push({ to, message, opts: o }); return { id: 'SENT' }; } },
    _genMsgId: () => 'IQ' + (++n),
    _sendIq: async (node, o) => { iqs.push({ node, opts: o }); return opts.reply ? opts.reply(node) : ok(node); },
    _sendAppStatePatch: async (desc) => { patches.push(desc); }
  });
  c.emit = (name, payload) => { emitted.push({ name, payload }); return true; };
  Object.assign(c, { sent, iqs, emitted, raw, patches });
  c.events = (name) => emitted.filter(e => e.name === name).map(e => e.payload);
  return c;
}
const ok = (node, children) => new BinaryNode('iq', { type: 'result', id: node.attrs.id, from: SERVER }, children || null);
const refused = (node, code, text) => new BinaryNode('iq', { type: 'error', id: node.attrs.id },
  [new BinaryNode('error', { code: String(code), text }, null)]);

// ─── message secrets ─────────────────────────────────────────────────────────

const SECRET = crypto.randomBytes(32);
const ME   = '40712345678@s.whatsapp.net';
const THEM = '40799999999@s.whatsapp.net';

// The other side, with node's crypto only.
function seal(type, targetId, targetSender, sender, plaintext, withAad) {
  const key = Buffer.from(crypto.hkdfSync('sha256', SECRET, Buffer.alloc(0),
    Buffer.from(targetId + targetSender + sender + type), 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (withAad) c.setAAD(Buffer.concat([Buffer.from(targetId), Buffer.from([0]), Buffer.from(sender)]));
  return { encPayload: Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]), encIv: iv };
}
const keyBuf = (k) => Buffer.concat([lenField(1, Buffer.from(k.remoteJid)), intField(2, k.fromMe ? 1 : 0),
  lenField(3, Buffer.from(k.id))].concat(k.participant ? [lenField(4, Buffer.from(k.participant))] : []));
const addOn = (field, key, sealed, extra) => lenField(field, Buffer.concat(
  [lenField(1, keyBuf(key)), lenField(2, sealed.encPayload), lenField(3, sealed.encIv)].concat(extra || [])));

test('the key is HKDF over the target, both senders and the use case, device stripped', () => {
  const { key, aad } = MS.deriveSecretKey({
    type: MS.SECRET_TYPE.POLL_VOTE, messageSecret: SECRET, targetId: 'POLL1',
    targetSender: '40799999999:3@s.whatsapp.net', sender: '40712345678:7@s.whatsapp.net'
  });
  assert.deepEqual(key, Buffer.from(crypto.hkdfSync('sha256', SECRET, Buffer.alloc(0),
    Buffer.from('POLL1' + THEM + ME + 'Poll Vote'), 32)));
  assert.deepEqual(aad, Buffer.concat([Buffer.from('POLL1'), Buffer.from([0]), Buffer.from(ME)]));
  assert.equal(MS.deriveSecretKey({ type: MS.SECRET_TYPE.REACTION, messageSecret: SECRET,
    targetId: 'X', targetSender: THEM, sender: ME }).aad, null, 'a reaction binds nothing extra');
  assert.throws(() => MS.deriveSecretKey({ type: 'Nope', messageSecret: SECRET, targetId: 'X', targetSender: THEM, sender: ME }), /unknown use case/);
  assert.throws(() => MS.deriveSecretKey({ type: MS.SECRET_TYPE.REACTION, messageSecret: Buffer.alloc(8), targetId: 'X', targetSender: THEM, sender: ME }), /32-byte secret/);
});

test('what one side seals the other opens, and a wrong sender does not', () => {
  const sealed = MS.encryptSecret({ type: MS.SECRET_TYPE.EVENT_RESPONSE, messageSecret: SECRET,
    targetId: 'EV1', targetSender: THEM, sender: ME, plaintext: Buffer.from('hello') });
  assert.equal(sealed.encIv.length, 12);
  assert.equal(MS.decryptSecret(Object.assign({ type: MS.SECRET_TYPE.EVENT_RESPONSE, messageSecret: SECRET,
    targetId: 'EV1', targetSender: THEM, sender: ME }, sealed)).toString(), 'hello');
  assert.throws(() => MS.decryptSecret(Object.assign({ type: MS.SECRET_TYPE.EVENT_RESPONSE, messageSecret: SECRET,
    targetId: 'EV1', targetSender: THEM, sender: THEM }, sealed)), /would not open/);
  assert.throws(() => MS.decryptSecret({ type: MS.SECRET_TYPE.REACTION, messageSecret: SECRET,
    targetId: 'X', targetSender: THEM, sender: ME, encPayload: Buffer.alloc(4), encIv: Buffer.alloc(12) }), /no usable ciphertext/);
});

test('an encrypted reaction is decoded as an add-on and read with the target\'s secret', () => {
  const group = '120363000000000000@g.us';
  const key = { remoteJid: group, fromMe: false, id: 'ANN1', participant: THEM };
  const reaction = Buffer.concat([lenField(2, Buffer.from('👍')), intField(4, 1700000000000)]);
  const wire = addOn(56, key, seal('Enc Reaction', 'ANN1', THEM, ME, reaction, false));

  const decoded = Proto.decodeMessageContainer(wire);
  assert.equal(decoded.type, 'encReaction');
  assert.deepEqual(decoded.targetKey, { remoteJid: group, fromMe: false, id: 'ANN1', participant: THEM });

  const c = client();
  const out = c.decryptReaction({ decoded, from: group, participant: '40712345678:2@s.whatsapp.net' }, { messageSecret: SECRET });
  assert.equal(out.text, '👍');
  assert.equal(out.senderTimestampMs, 1700000000000);
  assert.throws(() => c.decryptComment({ decoded, participant: ME }, { messageSecret: SECRET }), /not an encrypted comment/);
  assert.throws(() => c.decryptReaction({ decoded, participant: ME }, { messageSecret: crypto.randomBytes(32) }), /would not open/);
});

test('a comment, an event response and an encrypted edit are read the same way', () => {
  const c = client();
  const group = '120363000000000000@g.us';
  const key = { remoteJid: group, fromMe: false, id: 'T1', participant: THEM };

  const comment = lenField(1, lenField(1, Buffer.from('nice one')));
  const dc = Proto.decodeMessageContainer(addOn(71, key, seal('Enc Comment', 'T1', THEM, ME, comment, false)));
  assert.equal(dc.type, 'encComment');
  assert.equal(c.decryptComment({ decoded: dc, participant: ME }, { messageSecret: SECRET }).decoded.text, 'nice one');

  const response = Buffer.concat([intField(1, 3), intField(2, 1700000000000)]);
  const de = Proto.decodeMessageContainer(addOn(76, key, seal('Event Response', 'T1', THEM, ME, response, true)));
  assert.equal(de.type, 'encEventResponse');
  const ev = c.decryptEventResponse({ decoded: de, participant: ME }, { messageSecret: SECRET });
  assert.equal(ev.response, 'maybe');
  assert.equal(ev.timestampMs, 1700000000000);

  // An edit is sealed by whoever sent the original, so both senders are them.
  const edit = lenField(1, Buffer.from('fixed text'));
  const ds = Proto.decodeMessageContainer(addOn(82, key, seal('Message Edit', 'T1', THEM, THEM, edit, false), [intField(4, 2)]));
  assert.equal(ds.type, 'secretEncrypted');
  assert.equal(ds.secretEncType, 2);
  const out = c.decryptSecretMessage({ decoded: ds, participant: THEM }, { messageSecret: SECRET });
  assert.equal(out.secretType, 'Message Edit');
  assert.equal(out.decoded.text, 'fixed text');

  assert.throws(() => c.decryptSecretMessage({ decoded: { type: 'text' } }, {}), /not an encrypted add-on/);
  assert.throws(() => c.decryptSecretMessage({ decoded: Object.assign({}, ds, { secretEncType: 3 }), participant: THEM },
    { messageSecret: SECRET }), /unsupported secretEncType/);
});

test('a pin and a keep are decoded with their target', () => {
  const key = keyBuf({ remoteJid: THEM, fromMe: true, id: 'M1' });
  const pin = Proto.decodeMessageContainer(lenField(63, Buffer.concat([lenField(1, key), intField(2, 1), intField(3, 5)])));
  assert.deepEqual([pin.type, pin.pinned, pin.targetKey.id, pin.senderTimestampMs], ['pinInChat', true, 'M1', 5]);
  const unpin = Proto.decodeMessageContainer(lenField(63, Buffer.concat([lenField(1, key), intField(2, 2)])));
  assert.equal(unpin.pinned, false);
  const keep = Proto.decodeMessageContainer(lenField(51, Buffer.concat([lenField(1, key), intField(2, 1)])));
  assert.deepEqual([keep.type, keep.kept], ['keepInChat', true]);
});

test('a vote reads its timestamp from the right field', () => {
  const upd = Buffer.concat([lenField(1, keyBuf({ remoteJid: THEM, fromMe: false, id: 'P' })),
    lenField(3, lenField(1, Buffer.alloc(32))), intField(4, 1700000000123)]);
  assert.equal(Proto.decodeMessageContainer(lenField(50, upd)).senderTimestampMs, 1700000000123);
});

// ─── sending ─────────────────────────────────────────────────────────────────

test('a vote we cast opens for the poll\'s owner, and says it is a vote', async () => {
  const c = client();
  await c.sendPollVote(THEM, { id: 'POLL1', sender: THEM, encKey: SECRET }, ['Pizza', 'Sushi']);
  const { to, message, opts } = c.raw[0];
  assert.equal(to, THEM);
  assert.deepEqual([opts.type, opts.pollType, opts.hide], ['poll', 'vote', true]);

  const decoded = Proto.decodeMessageContainer(message);
  assert.equal(decoded.type, 'pollVote');
  assert.deepEqual(decoded.pollKey, { remoteJid: THEM, fromMe: false, id: 'POLL1' });
  // Read back the way a vote from anybody is read.
  const vote = c.decryptPollVote({ decoded, from: ME }, { encKey: SECRET, pollSender: THEM, options: ['Pizza', 'Sushi', 'Tacos'] });
  assert.deepEqual(vote.selected, ['Pizza', 'Sushi']);
  assert.deepEqual(MS.hashPollOptions(['Pizza'])[0], crypto.createHash('sha256').update('Pizza').digest());
});

test('a vote in a group names the poll\'s author, and a LID poll is answered from our LID', async () => {
  const c = client();
  const group = '120363000000000000@g.us', author = '250139683860650@lid';
  await c.sendPollVote(group, { id: 'P2', sender: author, encKey: SECRET }, ['A']);
  const decoded = Proto.decodeMessageContainer(c.raw[0].message);
  const key = Proto.decodeFields(Proto.decodeFields(Proto.decodeFields(c.raw[0].message)[50])[1]);
  assert.equal(key[4].toString(), author);
  const vote = c.decryptPollVote({ decoded, from: group, participant: '112713111982325@lid' },
    { encKey: SECRET, pollSender: author, options: ['A', 'B'] });
  assert.deepEqual(vote.selected, ['A']);

  await assert.rejects(c.sendPollVote(group, { sender: author, encKey: SECRET }, ['A']), /message id is required/);
  await assert.rejects(c.sendPollVote(group, { id: 'P', encKey: SECRET }, ['A']), /poll.sender is required/);
});

test('a pin is a pinInChat message with the edit attribute and a duration', async () => {
  const c = client();
  const group = '120363000000000000@g.us';
  await c.pinMessage(group, { id: 'M9', fromMe: false, participant: '40799999999:4@s.whatsapp.net' }, { durationSecs: 86400 });
  const { message, opts } = c.raw[0];
  assert.deepEqual([opts.type, opts.edit], ['text', '2']);
  const top = Proto.decodeFields(message);
  const pin = Proto.decodeFields(top[63]);
  assert.equal(pin[2], 1);
  assert.equal(Proto.decodeFields(pin[1])[4].toString(), THEM, 'the author, without a device');
  assert.equal(Proto.decodeFields(top[35])[5], 86400);

  await c.unpinMessage(group, { id: 'M9', fromMe: true });
  const un = Proto.decodeFields(c.raw[1].message);
  assert.equal(Proto.decodeFields(un[63])[2], 2);
  assert.equal(un[35], undefined, 'an unpin has no duration');
  await assert.rejects(c.pinMessage(group, {}), /target message id is required/);
});

test('a raw send validates what the stanza will say, and passes the rest on', async () => {
  const calls = [];
  const sender = Object.assign(Object.create(MessageSender.prototype), {
    _sendMessage: async (...args) => { calls.push(args); return { id: args[1] }; }
  });
  await assert.rejects(sender.sendRaw(THEM, 'text'), /non-empty Buffer/);
  await assert.rejects(sender.sendRaw(THEM, Buffer.from([1]), { type: 'nope' }), /type must be/);
  await assert.rejects(sender.sendRaw(THEM, Buffer.from([1]), { type: 'media' }), /needs opts.mediaType/);

  await sender.sendRaw(THEM, Buffer.from([10, 0]), { id: 'A', type: 'media', mediaType: 'image', edit: '1' });
  await sender.sendRaw(THEM, Buffer.from([10, 0]), { type: 'poll', pollType: 'vote', hide: true });
  await sender.sendRaw(THEM, Buffer.from([10, 0]));
  assert.deepEqual(calls.map(a => [a[3], a[4]._mediaSubtype, a[4]._pollType, a[4]._hide, a[4].edit]),
    [['media', 'image', undefined, undefined, '1'], ['poll', undefined, 'vote', true, undefined],
     ['text', undefined, undefined, undefined, undefined]]);
  assert.equal(calls[0][1], 'A');
  assert.equal(calls[0][4].type, undefined, 'the caller\'s type does not leak into the send options');

  const c = client();
  c._connected = false;
  await assert.rejects(c.sendRawMessage(THEM, Buffer.from([1])), /Not connected/);
});

// ─── connection ──────────────────────────────────────────────────────────────

test('a keepalive that goes unanswered is announced, and its return too', async () => {
  let mode = 'timeout';
  const c = client();
  c._sendIq = async (node, o) => {
    assert.equal(node.attrs.xmlns, 'w:p');
    assert.equal(o.rejectOnNoReply, true);
    if (mode === 'timeout') { const e = new Error('deadline'); e.code = 'IQ_TIMEOUT'; throw e; }
    if (mode === 'closed')  { const e = new Error('closed');   e.code = 'IQ_DISCONNECTED'; throw e; }
    return ok(node);
  };
  c._keepAliveLastOk = 1234;
  c._keepAlivePing(); await flush();
  c._keepAlivePing(); await flush();
  assert.deepEqual(c.events('keepalive_timeout'), [{ errorCount: 1, lastSuccess: 1234 }, { errorCount: 2, lastSuccess: 1234 }]);

  mode = 'closed';
  c._keepAlivePing(); await flush();
  assert.equal(c.events('keepalive_timeout').length, 2, 'a closed connection is not a silent one');

  mode = 'ok';
  c._keepAlivePing(); await flush();
  assert.deepEqual(c.events('keepalive_restored'), [{ missed: 2 }]);
  c._keepAlivePing(); await flush();
  assert.equal(c.events('keepalive_restored').length, 1, 'only the first answer after a miss');
});

test('offline sync, a scan without multi-device and a temporary ban are events', () => {
  const c = client();
  c._sendAppStateSyncForTypes = () => {};
  c._handleIb(new BinaryNode('ib', { from: SERVER }, [
    new BinaryNode('offline_preview', { count: '12', appdata: '1', message: '8', notification: '2', receipt: '1' }, null)]));
  c._handleIb(new BinaryNode('ib', { from: SERVER }, [new BinaryNode('offline', { count: '12' }, null)]));
  c._handleIb(new BinaryNode('ib', { from: SERVER }, [new BinaryNode('downgrade_webclient', {}, null)]));
  assert.deepEqual(c.events('offline_sync_preview'), [{ total: 12, appDataChanges: 1, messages: 8, notifications: 2, receipts: 1 }]);
  assert.deepEqual(c.events('offline_sync_completed'), [{ count: 12 }]);
  assert.equal(c.events('qr_scanned_without_multidevice').length, 1);

  c.disconnect = () => {};
  const before = Date.now();
  c._handleFailure(new BinaryNode('failure', { reason: '402', code: '101', expire: '3600' }, null));
  const ban = c.events('temporary_ban')[0];
  assert.deepEqual([ban.code, ban.expireSecs], ['101', 3600]);
  assert.ok(ban.expiresAt >= before + 3600000);
  assert.equal(c.events('auth_failure')[0].loggedOut, false, 'the session survives a temporary ban');
});

const notif = (type, attrs, children) =>
  new BinaryNode('notification', Object.assign({ from: SERVER, type, id: 'N1' }, attrs), children);

test('picture and about changes are announced', () => {
  const c = client();
  c._handlePictureNotification(notif('picture', { from: THEM, t: '1700000000' }, [
    new BinaryNode('set', { jid: THEM, id: '99', author: ME }, null),
    new BinaryNode('delete', { jid: '120363000000000000@g.us' }, null),
    new BinaryNode('other', {}, null)]));
  assert.deepEqual(c.events('picture_update'), [
    { jid: THEM, author: ME, removed: false, pictureId: '99', ts: 1700000000 },
    { jid: '120363000000000000@g.us', author: null, removed: true, pictureId: null, ts: 1700000000 }]);

  c._handleAboutNotification(notif('status', { from: THEM, t: '1700000001' }, [new BinaryNode('set', {}, Buffer.from('busy'))]));
  c._handleAboutNotification(notif('status', { from: THEM }, []));
  assert.deepEqual(c.events('about_update'), [{ jid: THEM, about: 'busy', ts: 1700000001 }]);
});

// ─── channels ────────────────────────────────────────────────────────────────

const NL = '120363111111111111@newsletter';
const post = (serverId, text, extra) => new BinaryNode('message', { server_id: String(serverId), id: 'P' + serverId, type: 'text', t: '1700000000' },
  [new BinaryNode('plaintext', {}, lenField(1, Buffer.from(text)))].concat(extra || []));

test('channel posts are read with their counts', async () => {
  const c = client({ reply: (node) => ok(node, [new BinaryNode('messages', {}, [
    post(100, 'first', [new BinaryNode('views_count', { count: '42' }, null),
      new BinaryNode('reactions', {}, [new BinaryNode('reaction', { code: '❤️', count: '3' }, null)])]),
    post(101, 'second')])]) });
  const posts = await c.getNewsletterMessages(NL, { count: 2, before: 200 });
  const q = child(c.iqs[0].node, 'messages');
  assert.deepEqual([c.iqs[0].node.attrs.xmlns, q.attrs.jid, q.attrs.count, q.attrs.before], ['newsletter', NL, '2', '200']);
  assert.deepEqual(posts.map(p => [p.serverId, p.id, p.decoded.text, p.viewsCount]), [[100, 'P100', 'first', 42], [101, 'P101', 'second', 0]]);
  assert.deepEqual(posts[0].reactionCounts, { '❤️': 3 });
  assert.equal(posts[1].reactionCounts, null);

  const empty = client({ reply: (node) => ok(node) });
  await assert.rejects(empty.getNewsletterMessages(NL), /no messages/);
  const no = client({ reply: (node) => refused(node, 403, 'forbidden') });
  await assert.rejects(no.getNewsletterMessages(NL), (e) => e.code === '403' && /refused/.test(e.message));
});

test('channel updates, live updates, views and reactions', async () => {
  const c = client({ reply: (node) => {
    const first = node.content[0].description;
    if (first === 'message_updates') return ok(node, [new BinaryNode('message_updates', {}, [new BinaryNode('messages', {}, [post(7, 'x')])])]);
    if (first === 'live_updates') return ok(node, [new BinaryNode('live_updates', { duration: '300' }, null)]);
    return ok(node);
  } });
  const updates = await c.getNewsletterMessageUpdates(NL, { since: 1700000000.9, after: 5 });
  assert.deepEqual([c.iqs[0].node.attrs.to, child(c.iqs[0].node, 'message_updates').attrs.since], [NL, '1700000000']);
  assert.equal(updates[0].serverId, 7);
  assert.deepEqual(await c.subscribeNewsletterLiveUpdates(NL), { durationSecs: 300 });

  await c.markNewsletterViewed(NL, [100, 101]);
  const receipt = c.sent[0];
  assert.deepEqual([receipt.description, receipt.attrs.type, receipt.attrs.to], ['receipt', 'view', NL]);
  assert.deepEqual(child(receipt, 'list').content.map(i => i.attrs.server_id), ['100', '101']);
  await assert.rejects(c.markNewsletterViewed(NL, []), /at least one server id/);

  await c.sendNewsletterReaction(NL, 100, '🔥');
  await c.sendNewsletterReaction(NL, 100, '');
  assert.deepEqual([c.sent[1].attrs.type, c.sent[1].attrs.server_id, child(c.sent[1], 'reaction').attrs.code, c.sent[1].attrs.edit],
    ['reaction', '100', '🔥', undefined]);
  assert.deepEqual([c.sent[2].attrs.edit, child(c.sent[2], 'reaction').attrs.code], ['7', undefined]);
});

test('a channel post goes out, and comes in, as a Message in plaintext', async () => {
  const c = client();
  await c.sendNewsletterText(NL, 'hello channel');
  const out = c.sent[0];
  assert.deepEqual([out.attrs.to, out.attrs.type, out.attrs.server_id], [NL, 'text', undefined]);
  assert.equal(Proto.decodeMessageContainer(child(out, 'plaintext').content).text, 'hello channel');
  await c.sendNewsletterMessage(NL, Buffer.from([10, 0]), { type: 'media', mediaType: 'image', mediaId: 'MID' });
  assert.deepEqual([c.sent[1].attrs.media_id, child(c.sent[1], 'plaintext').attrs.mediatype], ['MID', 'image']);
  await assert.rejects(c.sendNewsletterMessage(NL, 'x'), /non-empty Buffer/);

  c._sendMessageAck = (id) => c.sent.push({ ack: id });
  const incoming = post(55, 'news');
  incoming.attrs.from = NL;
  await c._handleMessage(incoming);
  const m = c.events('message')[0];
  assert.deepEqual([m.from, m.newsletter, m.serverId, m.decoded.text, m.id], [NL, true, 55, 'news', 'P55']);
  assert.deepEqual(c.sent[2], { ack: 'P55' });

  c._handleNewsletterNotification(notif('newsletter', { from: NL, t: '1700000002' },
    [new BinaryNode('live_updates', {}, [new BinaryNode('messages', {}, [post(56, 'live')])])]));
  const live = c.events('newsletter_live_update')[0];
  assert.deepEqual([live.jid, live.ts, live.messages[0].serverId], [NL, 1700000002, 56]);
});

test('mute, the followed list and invite lookup go through mex', async () => {
  const c = client();
  const calls = [];
  c._mexQuery = async (id, vars, path) => { calls.push([id, vars, path]); return path === 'xwa2_newsletter_subscribed' ? [{ id: NL }] : { id: NL }; };
  await c.muteNewsletter(NL); await c.unmuteNewsletter(NL);
  assert.deepEqual(await c.getSubscribedNewsletters(), [{ id: NL }]);
  await c.getNewsletterInfoWithInvite('https://whatsapp.com/channel/0029VaABC');
  assert.deepEqual(calls.map(x => x[0]), ['6274038279359549', '6068417879924485', '6388546374527196', '6563316087068696']);
  assert.deepEqual(calls[0][1], { newsletter_id: NL });
  assert.deepEqual(calls[3][1].input, { key: '0029VaABC', type: 'INVITE' });
  await assert.rejects(c.getNewsletterInfoWithInvite(''), /invite link or code/);
});

// ─── app state ───────────────────────────────────────────────────────────────

test('labels and delete-for-me round-trip through the action codec', () => {
  const round = (action) => Syncd.decodeSyncActionValue(Syncd.encodeSyncActionValue(action, 1700000000000));
  assert.deepEqual(round({ labelEditAction: { name: 'VIP', color: 3, deleted: false } }).labelEditAction,
    { name: 'VIP', color: 3, predefinedId: null, deleted: false });
  assert.deepEqual(round({ labelAssociationAction: { labeled: true } }).labelAssociationAction, { labeled: true });
  assert.deepEqual(round({ deleteMessageForMeAction: { deleteMedia: true, messageTimestamp: 1700000000 } }).deleteMessageForMeAction,
    { deleteMedia: true, messageTimestamp: 1700000000 });
  assert.deepEqual(round({ userStatusMuteAction: { muted: true } }).userStatusMuteAction, { muted: true });
  assert.deepEqual(round({ unarchiveChatsSetting: { unarchiveChats: true } }).unarchiveChatsSetting, { unarchiveChats: true });
});

test('label and delete-for-me patches are filed where the reference files them', async () => {
  assert.deepEqual(Mut.labelEditPatch(5, 'VIP', 3, false),
    { name: 'regular', index: ['label_edit', '5'], apiVersion: 3, action: { labelEditAction: { name: 'VIP', color: 3, deleted: false } } });
  assert.deepEqual(Mut.labelChatPatch(THEM, 5, true).index, ['label_jid', '5', THEM]);
  assert.deepEqual(Mut.labelMessagePatch(THEM, 5, 'M1', true).index, ['label_message', '5', THEM, 'M1', '0', '0']);
  const del = Mut.deleteMessageForMePatch(THEM, 'M1', true, 1700000000, false);
  assert.deepEqual([del.name, del.index, del.apiVersion], ['regular_high', ['deleteMessageForMe', THEM, 'M1', '1', '0'], 3]);

  assert.deepEqual(Mut.describeIndex(['label_message', '5', THEM, 'M1', '0', '0']), { kind: 'labelMessage', labelId: '5', jid: THEM, msgId: 'M1' });
  assert.deepEqual(Mut.describeIndex(['label_jid', '5', THEM]), { kind: 'labelChat', labelId: '5', jid: THEM });
  assert.deepEqual(Mut.describeIndex(['deleteMessageForMe', THEM, 'M1', '1', '0']), { kind: 'deleteForMe', jid: THEM, msgId: 'M1', fromMe: true });

  const c = client();
  await c.editLabel(5, { name: 'VIP', color: 3 });
  await c.labelChat(THEM, 5);
  await c.labelMessage(THEM, 5, 'M1', false);
  await c.deleteMessageForMe(THEM, 'M1', true, { timestamp: 1700000000 });
  assert.deepEqual(c.patches.map(p => p.index[0]), ['label_edit', 'label_jid', 'label_message', 'deleteMessageForMe']);
  assert.equal(c.patches[2].action.labelAssociationAction.labeled, false);
  assert.deepEqual(c.events('label_association').map(e => [e.msgId, e.labeled]), [[null, true], ['M1', false]]);
  await assert.rejects(c.editLabel(''), /label id is required/);
  await assert.rejects(c.deleteMessageForMe(THEM, ''), /message id is required/);
});

test('label and delete-for-me changes made elsewhere are announced', () => {
  const c = client();
  const n = c._applyAppStateMutations('regular', [
    { index: ['label_edit', '5'], operation: 0, action: { labelEditAction: { name: 'VIP', color: 3, deleted: false } } },
    { index: ['label_jid', '5', THEM], operation: 0, action: { labelAssociationAction: { labeled: true } } },
    { index: ['label_message', '5', THEM, 'M1', '0', '0'], operation: 1, action: {} },
    { index: ['deleteMessageForMe', THEM, 'M1', '1', '0'], operation: 0, action: { deleteMessageForMeAction: { deleteMedia: true } } },
    { index: ['userStatusMute', THEM], operation: 0, action: { userStatusMuteAction: { muted: true } } },
    { index: ['setting_unarchiveChats'], operation: 0, action: { unarchiveChatsSetting: { unarchiveChats: true } } }]);
  assert.equal(n, 6);
  assert.deepEqual(c.events('label_edit'), [{ labelId: '5', name: 'VIP', color: 3, deleted: false, remote: true }]);
  assert.deepEqual(c.events('label_association').map(e => [e.jid, e.msgId, e.labeled]), [[THEM, null, true], [THEM, 'M1', false]]);
  assert.deepEqual(c.events('message_deleted_for_me'), [{ jid: THEM, msgId: 'M1', fromMe: true, deleteMedia: true, remote: true }]);
  assert.deepEqual(c.events('status_muted'), [{ jid: THEM, muted: true, remote: true }]);
  assert.deepEqual(c.events('unarchive_chats_setting'), [{ unarchiveChats: true, remote: true }]);
});

// ─── communities, links, bots ────────────────────────────────────────────────

test('sub groups and a community\'s participants', async () => {
  const community = '120363222222222222@g.us';
  const c = client({ reply: (node) => node.content[0].description === 'sub_groups'
    ? ok(node, [new BinaryNode('sub_groups', {}, [
        new BinaryNode('group', { id: '120363333', subject: 'General', s_t: '1700000000', size: '12' }, [new BinaryNode('default_sub_group', {}, null)]),
        new BinaryNode('group', { id: '120363444@g.us', subject: 'Other' }, null)])])
    : ok(node, [new BinaryNode('linked_groups_participants', {}, [
        new BinaryNode('participant', { jid: '250139683860650@lid', phone_number: THEM }, null),
        new BinaryNode('participant', { jid: ME }, null)])]) });
  assert.deepEqual(await c.getSubGroups(community), [
    { jid: '120363333@g.us', subject: 'General', subjectTime: 1700000000, size: 12, isDefaultSubGroup: true },
    { jid: '120363444@g.us', subject: 'Other', subjectTime: 0, size: null, isDefaultSubGroup: false }]);
  assert.deepEqual([c.iqs[0].node.attrs.to, c.iqs[0].node.attrs.xmlns], [community, 'w:g2']);

  const people = await c.getLinkedGroupsParticipants(community);
  assert.deepEqual(people, [{ jid: '250139683860650@lid', phoneNumber: THEM, lid: null }, { jid: ME, phoneNumber: null, lid: null }]);
  assert.equal(c._lidToPn.get('250139683860650'), '40799999999', 'the pairing a reply states is kept');
});

test('business and contact links, the bot list and web push', async () => {
  const c = client({ reply: (node) => {
    const q = node.content[0];
    if (q.description === 'qr' && q.attrs.action) return ok(node, [new BinaryNode('qr', { code: 'NEWCODE' }, null)]);
    if (q.description === 'qr' && q.attrs.code === 'BIZ') return ok(node, [new BinaryNode('qr', { jid: THEM, notify: 'Shop' }, [
      new BinaryNode('message', {}, Buffer.from('Hi!')), new BinaryNode('business', { is_signed: 'true', verified_name: 'Shop SRL' }, null)])]);
    if (q.description === 'qr') return ok(node, [new BinaryNode('qr', { jid: THEM, notify: 'Ana', type: 'contact' }, null)]);
    if (q.description === 'bot') return ok(node, [new BinaryNode('bot', {}, [
      new BinaryNode('section', { type: 'all' }, [new BinaryNode('bot', { jid: '13135550002@bot', persona_id: 'p1' }, null)]),
      new BinaryNode('section', { type: 'featured' }, [new BinaryNode('bot', { jid: 'x@bot' }, null)])])]);
    if (q.description === 'settings') return ok(node, [new BinaryNode('settings', { platform: 'web' }, null)]);
    return ok(node);
  } });
  assert.deepEqual(await c.resolveBusinessMessageLink('https://wa.me/message/BIZ?src=qr'),
    { jid: THEM, pushName: 'Shop', message: 'Hi!', isSigned: true, verifiedName: 'Shop SRL', verifiedLevel: null });
  assert.deepEqual(await c.getContactQrLink(true), { code: 'NEWCODE', link: 'https://wa.me/qr/NEWCODE' });
  assert.equal(child(c.iqs[1].node, 'qr').attrs.action, 'revoke');
  assert.deepEqual(await c.resolveContactQrLink('https://wa.me/qr/ABC'), { jid: THEM, pushName: 'Ana', type: 'contact' });
  assert.deepEqual(await c.getBotList(), [{ jid: '13135550002@bot', personaId: 'p1' }]);

  await c.registerWebPush({ endpoint: 'https://push.example/x', auth: Buffer.from('auth'), p256dh: 'cDI1Ng' });
  const cfg = child(c.iqs[4].node, 'config').attrs;
  assert.deepEqual([c.iqs[4].node.attrs.xmlns, cfg.platform, cfg.auth, cfg.p256dh],
    ['urn:xmpp:whatsapp:push', 'web', Buffer.from('auth').toString('base64'), 'cDI1Ng==']);
  assert.deepEqual(await c.getPushConfig(), { platform: 'web' });
  await assert.rejects(c.registerWebPush({ endpoint: 'x' }), /endpoint, auth and p256dh/);
  await assert.rejects(c.resolveContactQrLink(''), /link or code/);
  await assert.rejects(c.fetchStickerPack('../etc'), /sticker pack id is required/);
});

test('a history-sync server-error receipt goes to our own account as a peer', async () => {
  const c = client();
  await c.sendHistorySyncServerErrorReceipt('HIST1', crypto.randomBytes(32));
  const r = c.sent[0];
  assert.deepEqual([r.attrs.type, r.attrs.to, r.attrs.category, r.attrs.id], ['server-error', '40712345678@s.whatsapp.net', 'peer', 'HIST1']);
  assert.deepEqual(child(r, 'encrypt').content.map(n => n.description), ['enc_p', 'enc_iv']);
});
