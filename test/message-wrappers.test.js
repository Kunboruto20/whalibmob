'use strict';

// The envelopes in Message that carry another Message inside.
//
// A view-once photo, a message from a disappearing chat and a document sent
// with a caption all reach the decoder wrapped. Nothing about the inner message
// changes, so the whole of what is tested here is that the envelope is opened
// and that nothing riding on it — a sender-key distribution, a poll's secret —
// is dropped on the way.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  decodeMessageContainer, encodeImageMessage, encodeAudioMessage,
  encodeDocumentMessage, encodePollCreationMessage, encodeMessageContextInfo,
  encodeSenderKeyDistributionMessage, field, str, bytes, WIRE_LEN,
  MAX_WRAPPER_DEPTH
} = require('../lib/proto/MessageProto');

// Message { <fieldNum> = <payload> }
const msg = (fieldNum, payload) => field(fieldNum, WIRE_LEN, payload);

// FutureProofMessage { message = 1 } — the shape every envelope but
// DeviceSentMessage has.
const futureProof = (fieldNum, inner) => msg(fieldNum, field(1, WIRE_LEN, inner));

// DeviceSentMessage { destinationJid = 1, message = 2 }
const deviceSent = (inner) => msg(31, Buffer.concat([
  field(1, WIRE_LEN, str('123@s.whatsapp.net')),
  field(2, WIRE_LEN, inner)
]));

const MEDIA_KEY = crypto.randomBytes(32);
const ENC_SHA   = crypto.randomBytes(32);

function imageMessage() {
  return msg(3, encodeImageMessage({
    url:           'https://mmg.whatsapp.net/d/f/abc.enc',
    mimetype:      'image/jpeg',
    caption:       'look once',
    fileSha256:    crypto.randomBytes(32),
    fileEncSha256: ENC_SHA,
    fileLength:    12345,
    height:        1600,
    width:         900,
    mediaKey:      MEDIA_KEY,
    directPath:    '/d/f/abc.enc'
  }));
}

const textMessage = (t) => msg(1, str(t));

// ─── view-once ───────────────────────────────────────────────────────────────

// 37 is what older senders and history sync deliver, 55 what a current client
// produces for a photo, 59 what it produces for a voice note. All three have to
// be read or view-once media stays undownloadable for some senders.
for (const [fieldNum, label] of [[37, 'viewOnceMessage'], [55, 'viewOnceMessageV2'],
                                 [59, 'viewOnceMessageV2Extension']]) {
  test(`a photo inside ${label} decodes as the photo`, () => {
    const d = decodeMessageContainer(futureProof(fieldNum, imageMessage()));

    assert.equal(d.type, 'image');
    assert.equal(d.viewOnce, true);
    assert.equal(d.caption, 'look once');
    // What downloadMedia needs. Before the envelope was opened these were the
    // fields that never arrived.
    assert.equal(d.mediaKey.toString('hex'), MEDIA_KEY.toString('hex'));
    assert.equal(d.fileEncSha256.toString('hex'), ENC_SHA.toString('hex'));
    assert.equal(d.directPath, '/d/f/abc.enc');
    assert.equal(d.url, 'https://mmg.whatsapp.net/d/f/abc.enc');
  });
}

test('a view-once voice note keeps its ptt type, so it derives the right keys', () => {
  const audio = msg(8, encodeAudioMessage({
    url: 'https://mmg.whatsapp.net/d/f/v.enc', mimetype: 'audio/ogg; codecs=opus',
    fileSha256: crypto.randomBytes(32), fileEncSha256: ENC_SHA, fileLength: 900,
    seconds: 3, ptt: true, mediaKey: MEDIA_KEY, directPath: '/d/f/v.enc'
  }));
  const d = decodeMessageContainer(futureProof(59, audio));

  assert.equal(d.type, 'voice');
  assert.equal(d.ptt, true);
  assert.equal(d.viewOnce, true);
});

// ─── ephemeral ───────────────────────────────────────────────────────────────

test('text from a disappearing chat decodes as text', () => {
  const d = decodeMessageContainer(futureProof(40, textMessage('gone in a day')));

  assert.equal(d.type, 'text');
  assert.equal(d.text, 'gone in a day');
  assert.equal(d.ephemeral, true);
});

test('a photo from a disappearing chat is downloadable', () => {
  const d = decodeMessageContainer(futureProof(40, imageMessage()));

  assert.equal(d.type, 'image');
  assert.equal(d.ephemeral, true);
  assert.equal(d.mediaKey.toString('hex'), MEDIA_KEY.toString('hex'));
});

// ─── nesting ─────────────────────────────────────────────────────────────────

test('a view-once photo in a disappearing chat carries both flags', () => {
  const d = decodeMessageContainer(futureProof(40, futureProof(55, imageMessage())));

  assert.equal(d.type, 'image');
  assert.equal(d.viewOnce, true);
  assert.equal(d.ephemeral, true);
  assert.equal(d.mediaKey.toString('hex'), MEDIA_KEY.toString('hex'));
});

test('our own view-once photo, echoed back to this device, still decodes', () => {
  const d = decodeMessageContainer(deviceSent(futureProof(55, imageMessage())));

  assert.equal(d.type, 'image');
  assert.equal(d.viewOnce, true);
});

// Nesting a fixed number of envelopes around a text message.
const nest = (depth) => {
  let payload = textMessage('deep');
  for (let i = 0; i < depth; i++) payload = futureProof(40, payload);
  return payload;
};

test('the depth bound holds exactly where it says it does', () => {
  // Checked at the edge, and against the constant rather than a number copied
  // out of it. Asserting only that deep nesting does not throw proves nothing:
  // forty levels of recursion do not exhaust the stack, so such a test passes
  // just as well with no bound at all.
  assert.equal(decodeMessageContainer(nest(MAX_WRAPPER_DEPTH)).type, 'text',
    'at the bound the message is still reached');

  assert.equal(decodeMessageContainer(nest(MAX_WRAPPER_DEPTH + 1)).type, 'unknown',
    'one past it the envelope is left unopened');
});

test('an envelope nested past all reason is refused, not followed', () => {
  // The bound is what keeps a payload from driving the decoder as deep as it is
  // long. A thousand envelopes are read as far as the bound and no further, so
  // this costs nothing to refuse — which is the whole point of refusing it.
  const hostile = nest(1000);
  let decoded;
  assert.doesNotThrow(() => { decoded = decodeMessageContainer(hostile); });
  assert.equal(decoded.type, 'unknown');
});

// ─── documents and edits ─────────────────────────────────────────────────────

test('a document sent with a caption decodes as the document', () => {
  const doc = msg(7, encodeDocumentMessage({
    url: 'https://mmg.whatsapp.net/d/f/d.enc', mimetype: 'application/pdf',
    title: 'report', fileName: 'report.pdf', fileSha256: crypto.randomBytes(32),
    fileEncSha256: ENC_SHA, fileLength: 4096, mediaKey: MEDIA_KEY,
    directPath: '/d/f/d.enc'
  }));
  const d = decodeMessageContainer(futureProof(53, doc));

  assert.equal(d.type, 'document');
  assert.equal(d.fileName, 'report.pdf');
  assert.equal(d.mediaKey.toString('hex'), MEDIA_KEY.toString('hex'));
});

test('an edited message reaches its protocolMessage', () => {
  const protocolEdit = msg(12, Buffer.concat([
    field(1, WIRE_LEN, field(3, WIRE_LEN, str('MSGID'))),   // key.id
    field(2, 0, Buffer.from([14]))                          // type = MESSAGE_EDIT
  ]));
  const d = decodeMessageContainer(futureProof(58, protocolEdit));

  assert.equal(d.type, 'protocol');
  assert.equal(d.subtype, 'message_edit');
  assert.equal(d.edited, true);
});

// ─── what rides on the envelope ──────────────────────────────────────────────

test('a sender-key distribution beside an envelope is not lost', () => {
  // The distribution sits next to the envelope, not inside it. Unwrapping used
  // to return straight out of the container and drop it, and a group whose
  // distribution arrived this way stayed undecryptable.
  const axolotl = Buffer.concat([Buffer.from([0x33]), crypto.randomBytes(40)]);
  const payload = Buffer.concat([
    encodeSenderKeyDistributionMessage('120363@g.us', axolotl),
    futureProof(40, imageMessage())
  ]);
  const d = decodeMessageContainer(payload);

  assert.equal(d.type, 'image');
  assert.equal(d.ephemeral, true);
  assert.ok(d.skdm, 'the distribution came through');
  assert.equal(d.skdm.groupId, '120363@g.us');
  assert.equal(d.skdm.axolotlBytes.toString('hex'), axolotl.toString('hex'));
});

test('the same holds for deviceSentMessage', () => {
  const axolotl = Buffer.concat([Buffer.from([0x33]), crypto.randomBytes(40)]);
  const payload = Buffer.concat([
    encodeSenderKeyDistributionMessage('120363@g.us', axolotl),
    deviceSent(textMessage('hi'))
  ]);
  const d = decodeMessageContainer(payload);

  assert.equal(d.type, 'text');
  assert.equal(d.skdm.groupId, '120363@g.us');
});

test("a wrapped poll takes its secret from whichever level carries it", () => {
  const secret = crypto.randomBytes(32);
  const poll = msg(49, encodePollCreationMessage({
    question: 'lunch?', options: ['yes', 'no']
  }).payload);
  const payload = Buffer.concat([
    futureProof(40, poll),
    // encodeMessageContextInfo writes field 35 of Message itself.
    encodeMessageContextInfo({ messageSecret: secret })
  ]);
  const d = decodeMessageContainer(payload);

  assert.equal(d.type, 'poll');
  assert.equal(d.question, 'lunch?');
  // Without this the votes on a poll in a disappearing chat cannot be read.
  assert.equal(d.encKey.toString('hex'), secret.toString('hex'));
});

// ─── nothing else moved ──────────────────────────────────────────────────────

test('an unwrapped message decodes exactly as before', () => {
  const d = decodeMessageContainer(imageMessage());

  assert.equal(d.type, 'image');
  assert.equal(d.viewOnce, undefined);
  assert.equal(d.ephemeral, undefined);
});

test('an empty envelope is not mistaken for a message', () => {
  assert.equal(decodeMessageContainer(msg(55, Buffer.alloc(0))).type, 'unknown');
  assert.equal(decodeMessageContainer(futureProof(55, Buffer.alloc(0))).type, 'unknown');
});

test('an envelope holding something this decoder does not know reads as unknown', () => {
  const d = decodeMessageContainer(futureProof(40, msg(200, str('who knows'))));
  assert.equal(d.type, 'unknown');
});
