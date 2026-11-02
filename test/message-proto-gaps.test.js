'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// What the decoder used to drop, and a message store cannot do without:
//
//   - the key a revoke or an edit points at, and the protocol type that says
//     which of the two it is;
//   - the edited content, kept as the bytes it arrived in;
//   - the ephemeral setting's duration;
//   - the expiration a disappearing-chat message carries in its contextInfo;
//   - the message inside a DeviceSentMessage, kept as the bytes it arrived in.
//
// The inputs are written with the independent schema in test/fixtures, not with
// the library's own encoder, so the field numbers asserted here are WhatsApp's
// and not whatever the decoder happens to agree with.

const { type } = require('./helpers/history-proto');
const { decodeMessageContainer } = require('../lib/proto/MessageProto');
const { Writer } = require('protobufjs/minimal');

const Message = () => type('Message');
const encode = (obj) => Buffer.from(Message().encode(Message().create(obj)).finish());
// FutureProofMessage { message = 1 }, which the fixture declares as bytes.
const wrapped = (inner) => Buffer.from(Writer.create().uint32((1 << 3) | 2).bytes(inner).finish());

test('revoke exposes the target key', () => {
  const buf = encode({
    protocolMessage: {
      type: 0,
      key: { remoteJID: '4477@s.whatsapp.net', fromMe: true, ID: 'X1' }
    }
  });
  const d = decodeMessageContainer(buf);
  assert.equal(d.type, 'protocol');
  assert.equal(d.subtype, 'revoke');
  assert.equal(d.protocolType, 0);
  assert.deepEqual(d.key, {
    remoteJid: '4477@s.whatsapp.net',
    fromMe: true,
    id: 'X1',
    participant: undefined
  });
});

test('a revoke in a group names the author of the revoked message', () => {
  const buf = encode({
    protocolMessage: {
      type: 0,
      key: {
        remoteJID: '120363000000000001@g.us',
        fromMe: false,
        ID: 'G1',
        participant: '5588@s.whatsapp.net'
      }
    }
  });
  const d = decodeMessageContainer(buf);
  assert.equal(d.key.remoteJid, '120363000000000001@g.us');
  assert.equal(d.key.fromMe, false);
  assert.equal(d.key.id, 'G1');
  assert.equal(d.key.participant, '5588@s.whatsapp.net');
});

test('edit exposes the edited content verbatim', () => {
  const edited = encode({ conversation: 'yeni' });
  const buf = encode({
    protocolMessage: { type: 14, key: { ID: 'X2' }, editedMessage: edited }
  });
  const d = decodeMessageContainer(buf);
  assert.equal(d.type, 'protocol');
  assert.equal(d.subtype, 'message_edit');
  assert.equal(d.protocolType, 14);
  assert.equal(d.key.id, 'X2');
  assert.ok(Buffer.isBuffer(d.editedMessageRaw));
  assert.ok(d.editedMessageRaw.equals(edited));
  // The bytes are a Message in their own right, so they decode as one.
  assert.equal(decodeMessageContainer(d.editedMessageRaw).text, 'yeni');
});

test('ephemeral setting exposes seconds', () => {
  const buf = encode({ protocolMessage: { type: 3, ephemeralExpiration: 86400 } });
  const d = decodeMessageContainer(buf);
  assert.equal(d.subtype, 'ephemeral');
  assert.equal(d.protocolType, 3);
  assert.equal(d.ephemeralExpiration, 86400);
});

test('turning disappearing messages off is reported as zero seconds', () => {
  const buf = encode({ protocolMessage: { type: 3, ephemeralExpiration: 0 } });
  const d = decodeMessageContainer(buf);
  assert.equal(d.ephemeralExpiration, 0);
});

test('a protocol message that carries none of the new fields does not invent them', () => {
  const buf = encode({ protocolMessage: { type: 5 } });
  const d = decodeMessageContainer(buf);
  assert.equal(d.subtype, 'history_sync');
  assert.equal(d.protocolType, 5);
  assert.equal(d.key, undefined);
  assert.equal(d.ephemeralExpiration, undefined);
  assert.equal(d.editedMessageRaw, undefined);
});

test('contextInfo carries expiration', () => {
  const buf = encode({
    extendedTextMessage: { text: 'a', contextInfo: { expiration: 604800 } }
  });
  const d = decodeMessageContainer(buf);
  assert.equal(d.type, 'text');
  assert.equal(d.text, 'a');
  assert.equal(d.contextInfo.expiration, 604800);
});

test('a zero expiration leaves a message without a contextInfo', () => {
  const buf = encode({
    extendedTextMessage: { text: 'a', contextInfo: { expiration: 0 } }
  });
  const d = decodeMessageContainer(buf);
  assert.equal(d.text, 'a');
  assert.equal(d.contextInfo, undefined);
});

test('device-sent message exposes the inner message raw', () => {
  const inner = encode({ conversation: 'hi' });
  const buf = encode({
    deviceSentMessage: { destinationJID: '4477@s.whatsapp.net', message: inner }
  });
  const d = decodeMessageContainer(buf);
  assert.equal(d.type, 'text');
  assert.equal(d.text, 'hi');
  assert.equal(d.deviceSentMeta.destinationJid, '4477@s.whatsapp.net');
  assert.ok(Buffer.isBuffer(d.deviceSentMeta.messageRaw));
  assert.ok(d.deviceSentMeta.messageRaw.equals(inner));
});

test('the flags the envelopes set are unchanged', () => {
  // FutureProofMessage { message = 1 }, which the fixture declares as bytes.
  const wrapped = (inner) => Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
  const hello = encode({ conversation: 'gizli' });

  const viewOnce = decodeMessageContainer(encode({ viewOnceMessage: wrapped(hello) }));
  assert.equal(viewOnce.text, 'gizli');
  assert.equal(viewOnce.viewOnce, true);
  assert.equal(viewOnce.ephemeral, undefined);

  const ephemeral = decodeMessageContainer(encode({ ephemeralMessage: wrapped(hello) }));
  assert.equal(ephemeral.text, 'gizli');
  assert.equal(ephemeral.ephemeral, true);
  assert.equal(ephemeral.viewOnce, undefined);
});

// The envelopes real clients put edits and revokes in. Each must still come out
// as the protocol message inside it, with the key it names: an edit or a revoke
// read as "unknown" would leave the old, or the revoked, content in the store.

test('an edit inside editedMessage (58) is the type-14 protocol message it wraps', () => {
  const edited = encode({ conversation: 'son hali' });
  const inner = encode({ protocolMessage: { type: 14, key: { remoteJID: '4477@s.whatsapp.net', fromMe: false, ID: 'E58' }, editedMessage: edited } });
  const d = decodeMessageContainer(encode({ editedMessage: wrapped(inner) }));
  assert.equal(d.type, 'protocol');
  assert.equal(d.protocolType, 14);
  assert.equal(d.key.id, 'E58');
  assert.ok(d.editedMessageRaw.equals(edited));
  assert.equal(d.edited, true);
});

test('a revoke inside deviceSentMessage (31) keeps its key and the destination', () => {
  const inner = encode({ protocolMessage: { type: 0, key: { remoteJID: '4477@s.whatsapp.net', fromMe: true, ID: 'R31' } } });
  const d = decodeMessageContainer(encode({ deviceSentMessage: { destinationJID: '4477@s.whatsapp.net', message: inner } }));
  assert.equal(d.type, 'protocol');
  assert.equal(d.protocolType, 0);
  assert.deepEqual(d.key, { remoteJid: '4477@s.whatsapp.net', fromMe: true, id: 'R31', participant: undefined });
  assert.equal(d.deviceSentMeta.destinationJid, '4477@s.whatsapp.net');
  assert.ok(d.deviceSentMeta.messageRaw.equals(inner));
});

test('a revoke inside ephemeralMessage (40), as a disappearing chat sends it, keeps its key', () => {
  const inner = encode({ protocolMessage: { type: 0, key: { remoteJID: '4477@s.whatsapp.net', fromMe: false, ID: 'R40' } } });
  const d = decodeMessageContainer(encode({ ephemeralMessage: wrapped(inner) }));
  assert.equal(d.type, 'protocol');
  assert.equal(d.protocolType, 0);
  assert.equal(d.key.id, 'R40');
  assert.equal(d.ephemeral, true);
});
