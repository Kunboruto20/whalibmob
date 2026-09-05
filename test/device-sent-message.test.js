'use strict';

// DeviceSentMessage — the copy of a message that goes to our own other devices.
//
// When this account sends a direct message, every device it owns gets a copy of
// it wrapped in a DeviceSentMessage. The wrapper exists for one reason: the
// stanza those devices receive comes *from* this account, so `from` names the
// sender and nothing names the chat. The chat is written in the envelope, and
// only there.
//
// Two things were wrong with it.
//
// Sending: the message's messageContextInfo stayed buried inside the envelope.
// It is a field of Message, and a recipient reads it from the outer Message —
// so a poll echoed to our own devices reached them with no message secret and
// none of them could decrypt a vote. whatsmeow copies it up beside the envelope
// (`MessageContextInfo: message.MessageContextInfo` in marshalMessage) and so
// does Baileys. This one did not.
//
// Receiving: the envelope was opened and discarded. destinationJid never
// reached the caller, so a message sent from the phone arrived with no way to
// tell which conversation it belonged to. whatsmeow keeps both fields as
// Info.DeviceSentMeta.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  encodeDeviceSentMessage,
  encodeMessage,
  encodeMessageContextInfo,
  encodePollCreationMessage,
  decodeMessageContainer,
  field, str, WIRE_LEN
} = require('../lib/proto/MessageProto');

// Minimal protobuf reader, so these tests read the wire rather than trusting the
// library's own decoder to describe what it wrote.
function fields(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    let key = 0, shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      key |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const num = key >>> 3, wire = key & 7;
    if (wire === 2) {
      let len = 0; shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      out[num] = buf.slice(i, i + len);
      i += len;
    } else if (wire === 0) {
      while (i < buf.length && (buf[i++] & 0x80)) { /* skip */ }
      out[num] = true;
    } else { break; }
  }
  return out;
}

// Message { conversation = 1 }
const text = (s) => field(1, WIRE_LEN, str(s));

test('the envelope carries the chat the message was addressed to', () => {
  const wire = encodeDeviceSentMessage('40712345678@s.whatsapp.net', text('salut'));
  const env  = fields(fields(wire)[31]);

  assert.equal(env[1].toString('utf8'), '40712345678@s.whatsapp.net');
  assert.ok(env[2] && env[2].length, 'and the message itself');
});

test('phash is not written — nothing has ever read it back out of here', () => {
  const wire = encodeDeviceSentMessage('40712345678@s.whatsapp.net', text('salut'));
  assert.equal(fields(fields(wire)[31])[3], undefined);
});

test("a poll's message secret is lifted beside the envelope, not left inside it", () => {
  const secret = crypto.randomBytes(32);
  const poll   = encodePollCreationMessage({
    question: 'lunch?', options: ['yes', 'no'], messageSecret: secret
  });
  const plaintext = Buffer.concat([
    encodeMessage('poll', poll.payload),
    encodeMessageContextInfo({ messageSecret: poll.messageSecret })
  ]);

  const wire = encodeDeviceSentMessage('40712345678@s.whatsapp.net', plaintext);
  const top  = fields(wire);

  assert.ok(top[31], 'the envelope is there');
  assert.ok(top[35], 'and so is the messageContextInfo, at the outer level');
  assert.equal(fields(top[35])[3].toString('hex'), poll.messageSecret.toString('hex'),
    'carrying the same secret the poll was sent with');

  // Still inside as well — the copy is a duplicate, not a move, exactly as
  // whatsmeow and Baileys write it.
  assert.ok(fields(fields(top[31])[2])[35], 'the inner copy is untouched');
});

test('a message with no context info gets no empty field 35', () => {
  const wire = encodeDeviceSentMessage('40712345678@s.whatsapp.net', text('salut'));
  assert.equal(fields(wire)[35], undefined);
});

test('what comes back out names the chat', () => {
  const wire = encodeDeviceSentMessage('40712345678@s.whatsapp.net', text('salut'));
  const d    = decodeMessageContainer(wire);

  assert.equal(d.type, 'text');
  assert.equal(d.text, 'salut');
  assert.ok(d.deviceSentMeta, 'the envelope was not thrown away');
  assert.equal(d.deviceSentMeta.destinationJid, '40712345678@s.whatsapp.net');
});

test('an ordinary message carries no deviceSentMeta at all', () => {
  const d = decodeMessageContainer(text('salut'));
  assert.equal(d.type, 'text');
  assert.equal(d.deviceSentMeta, undefined);
});

test('a poll sent to our own devices survives the round trip with its secret', () => {
  const secret = crypto.randomBytes(32);
  const poll   = encodePollCreationMessage({
    question: 'lunch?', options: ['yes', 'no'], messageSecret: secret
  });
  const plaintext = Buffer.concat([
    encodeMessage('poll', poll.payload),
    encodeMessageContextInfo({ messageSecret: poll.messageSecret })
  ]);
  const d = decodeMessageContainer(
    encodeDeviceSentMessage('40712345678@s.whatsapp.net', plaintext));

  assert.equal(d.type, 'poll');
  assert.equal(d.question, 'lunch?');
  assert.equal(d.deviceSentMeta.destinationJid, '40712345678@s.whatsapp.net');
  assert.equal(Buffer.from(d.encKey).toString('hex'), poll.messageSecret.toString('hex'));
});

test('a phash written by some other client is still reported', () => {
  // Nothing here writes one any more, but a sender that does should not have it
  // silently dropped on the way in.
  const wire = field(31, WIRE_LEN, Buffer.concat([
    field(1, WIRE_LEN, str('40712345678@s.whatsapp.net')),
    field(2, WIRE_LEN, text('hi')),
    field(3, WIRE_LEN, str('2:AB'))
  ]));
  const d = decodeMessageContainer(wire);

  assert.equal(d.type, 'text');
  assert.equal(d.deviceSentMeta.phash, '2:AB');
  assert.equal(d.deviceSentMeta.destinationJid, '40712345678@s.whatsapp.net');
});
