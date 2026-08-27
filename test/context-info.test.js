'use strict';

// contextInfo, on the way in.
//
// The encoder has always written it; the decoder never read it back. A reply
// therefore arrived indistinguishable from a message sent on its own — no
// quoted message, no mentions, no stanza id — so anything that acts on what was
// quoted had nothing to act on.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeMessageContainer, decodeContextInfo, encodeContextInfo, encodeText,
  encodeImageMessage, field, str, bytes, varint, WIRE_LEN, WIRE_VARINT,
  MAX_WRAPPER_DEPTH
} = require('../lib/proto/MessageProto');

const QUOTED_ID = '3EB0A1B2C3D4E5F60789';
const AUTHOR    = '40799999999@s.whatsapp.net';

// A Message whose only content is plain text, as the quoted half of a reply.
const quotedText = (t) => field(1, WIRE_LEN, str(t));

test('a text reply reports what it quoted', () => {
  const msg = encodeText('răspunsul meu', {
    quotedMessageId: QUOTED_ID,
    participant:     AUTHOR,
    quotedMessage:   quotedText('mesajul original')
  });

  const d = decodeMessageContainer(msg);
  assert.equal(d.type, 'text');
  assert.equal(d.text, 'răspunsul meu');

  assert.ok(d.contextInfo, 'the context came through');
  assert.equal(d.contextInfo.stanzaId, QUOTED_ID);
  assert.equal(d.contextInfo.participant, AUTHOR);
  assert.equal(d.contextInfo.quotedMessage.type, 'text');
  assert.equal(d.contextInfo.quotedMessage.text, 'mesajul original');
});

test('a quoted image decodes as an image, media keys and all', () => {
  const mediaKey = Buffer.alloc(32, 7);
  const inner = field(3, WIRE_LEN, encodeImageMessage({
    url: 'https://mmg.whatsapp.net/x', mimetype: 'image/jpeg', caption: 'poza',
    fileSha256: Buffer.alloc(32, 1), fileEncSha256: Buffer.alloc(32, 2),
    mediaKey, fileLength: 1234, height: 100, width: 200, directPath: '/v/x'
  }));

  const msg = encodeText('/sticker', {
    quotedMessageId: QUOTED_ID, participant: AUTHOR, quotedMessage: inner
  });

  const q = decodeMessageContainer(msg).contextInfo.quotedMessage;
  assert.equal(q.type, 'image');
  assert.equal(q.caption, 'poza');
  assert.equal(q.mediaKey.toString('hex'), mediaKey.toString('hex'));
  assert.equal(q.directPath, '/v/x');
});

test('mentions come back as a list, one or many', () => {
  const one = decodeMessageContainer(
    encodeText('salut @x', { mentionedJid: ['40700000001@s.whatsapp.net'] }));
  assert.deepEqual(one.contextInfo.mentionedJid, ['40700000001@s.whatsapp.net']);

  const many = decodeMessageContainer(encodeText('salut', {
    mentionedJid: ['40700000001@s.whatsapp.net', '40700000002@s.whatsapp.net']
  }));
  assert.equal(many.contextInfo.mentionedJid.length, 2);
});

test('a message that quotes nothing has no contextInfo', () => {
  const plain = decodeMessageContainer(field(1, WIRE_LEN, str('doar text')));
  assert.equal(plain.type, 'text');
  assert.equal(plain.contextInfo, undefined);
});

test('the context on an image message is read too', () => {
  const img = field(3, WIRE_LEN, encodeImageMessage({
    url: 'https://mmg.whatsapp.net/y', mimetype: 'image/jpeg', caption: 'cu reply',
    fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32),
    mediaKey: Buffer.alloc(32), fileLength: 1, height: 1, width: 1, directPath: '/v/y',
    contextInfo: { quotedMessageId: QUOTED_ID, participant: AUTHOR }
  }));

  const d = decodeMessageContainer(img);
  assert.equal(d.type, 'image');
  assert.equal(d.contextInfo.stanzaId, QUOTED_ID);
});

test('a reply inside a view-once envelope keeps both its flag and its context', () => {
  // viewOnceMessageV2 (field 55) { message = 1 }
  const inner = encodeText('secret', {
    quotedMessageId: QUOTED_ID, quotedMessage: quotedText('original')
  });
  const env = field(55, WIRE_LEN, field(1, WIRE_LEN, inner));

  const d = decodeMessageContainer(env);
  assert.equal(d.type, 'text');
  assert.equal(d.viewOnce, true, 'the envelope still marks it');
  assert.equal(d.contextInfo.stanzaId, QUOTED_ID, 'and the context survived');
});

test('a chain of replies stops at the wrapper bound rather than recursing away', () => {
  // Each level quotes the level below it. Deeper than the bound, the innermost
  // quoted message is simply not decoded — nothing throws, nothing hangs.
  let cur = quotedText('cel mai adânc');
  for (let i = 0; i < MAX_WRAPPER_DEPTH + 4; i++) {
    cur = encodeText('nivel ' + i, { quotedMessageId: QUOTED_ID, quotedMessage: cur });
  }
  const d = decodeMessageContainer(cur);
  assert.equal(d.type, 'text');
  assert.ok(d.contextInfo, 'the outermost level still reports its context');
});

test('decodeContextInfo alone survives junk', () => {
  assert.equal(decodeContextInfo(null), null);
  assert.equal(decodeContextInfo(Buffer.alloc(0)), null);
  assert.equal(decodeContextInfo(Buffer.from([0xff, 0xff, 0xff])), null);
});

test('what the encoder writes is what the decoder reads', () => {
  const ctx = {
    quotedMessageId: QUOTED_ID,
    participant:     AUTHOR,
    remoteJid:       '120363000000000000@g.us',
    mentionedJid:    ['40700000003@s.whatsapp.net']
  };
  const back = decodeContextInfo(encodeContextInfo(ctx));
  assert.equal(back.stanzaId, ctx.quotedMessageId);
  assert.equal(back.participant, ctx.participant);
  assert.equal(back.remoteJid, ctx.remoteJid);
  assert.deepEqual(back.mentionedJid, ctx.mentionedJid);
});
