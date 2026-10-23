'use strict';

// The reporting token and the message secret it rides on.
//
// The native client stamps a random 32-byte secret into
// MessageContextInfo.messageSecret on every reportable message and attaches a
// <reporting> node whose token is an HMAC keyed by material derived from that
// secret and the two identities of the exchange. A message sent without the
// secret — and therefore without the token — is a shape no real client
// produces. These tests pin both halves: the secret gets stamped on the
// messages that should carry it and only those, and the token is keyed by the
// sender and the recipient as separate identities rather than the recipient
// twice.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  ensureMessageSecret, buildReportingNode, inspectMessage,
  generateMsgSecretKey, extractReportingTokenContent, COMPILED
} = require('../lib/messages/ReportingToken');
const { encodeText, encodeMessage, encodeMessageContextInfo,
        encodePollCreationMessage, field, str, WIRE_LEN } = require('../lib/proto/MessageProto');
const { BinaryNode } = require('../lib/BinaryNode');

const SENDER = '111@s.whatsapp.net';
const RECIP  = '222@s.whatsapp.net';
const MSG_ID = '3EB0ABCDEF1234567890';

// A plain text message, as sendText builds it.
function textPlaintext(body) {
  return encodeMessage('text', encodeText(body || 'hello'));
}

// Shallow walk counting top-level field-35 (messageContextInfo) tags, to catch
// an accidental double-append.
function field35Occurrences(buf) {
  const { decodeVarint } = require('../lib/messages/ReportingToken');
  let i = 0, n = 0;
  while (i < buf.length) {
    const tag = decodeVarint(buf, i);
    if (!tag.ok) break;
    const fieldNum = tag.value >> 3;
    const wire = tag.value & 7;
    i += tag.bytes;
    if (fieldNum === 35) n++;
    if (wire === 0) { i += decodeVarint(buf, i).bytes; }
    else if (wire === 1) { i += 8; }
    else if (wire === 5) { i += 4; }
    else if (wire === 2) { const l = decodeVarint(buf, i); i += l.bytes + l.value; }
    else break;
  }
  return n;
}

test('ensureMessageSecret stamps a 32-byte secret on plain text that lacks one', () => {
  const before = textPlaintext('hi');
  assert.equal(inspectMessage(before).messageSecret, null, 'text starts with no secret');

  const after = ensureMessageSecret(before);
  const secret = inspectMessage(after).messageSecret;
  assert.ok(secret && secret.length === 32, 'a 32-byte secret is stamped');
  assert.equal(field35Occurrences(after), 1, 'exactly one messageContextInfo');
});

test('ensureMessageSecret is idempotent — never a second secret', () => {
  const once  = ensureMessageSecret(textPlaintext('hi'));
  const twice = ensureMessageSecret(once);
  assert.equal(twice, once, 'already-stamped plaintext is returned unchanged');
  assert.equal(field35Occurrences(twice), 1, 'still exactly one messageContextInfo');
});

test('ensureMessageSecret leaves a poll\'s own secret untouched', () => {
  const pollSecret = crypto.randomBytes(32);
  const poll = encodePollCreationMessage({
    name: 'lunch?', options: ['yes', 'no'], messageSecret: pollSecret
  });
  const plaintext = Buffer.concat([
    encodeMessage('poll', poll.payload),
    encodeMessageContextInfo({ messageSecret: poll.messageSecret })
  ]);

  const after = ensureMessageSecret(plaintext);
  assert.equal(after, plaintext, 'poll plaintext is returned unchanged');
  assert.equal(inspectMessage(after).messageSecret.toString('hex'),
    pollSecret.toString('hex'), 'the poll keeps its own secret');
});

test('ensureMessageSecret adds nothing to a reaction (it carries no token)', () => {
  // ReactionMessage is field 46 of Message — shouldIncludeReportingToken is false.
  const reaction = encodeMessage('reaction', field(2, WIRE_LEN, str('👍')));
  const after = ensureMessageSecret(reaction);
  assert.equal(after, reaction, 'reaction plaintext is returned unchanged');
  assert.equal(inspectMessage(after).messageSecret, null, 'no secret stamped');
});

test('buildReportingNode produces a v2 token once the secret is stamped', () => {
  const plaintext = ensureMessageSecret(textPlaintext('reportable'));
  const node = buildReportingNode({
    plaintext, msgId: MSG_ID, remoteJid: RECIP, senderJid: SENDER, BinaryNode
  });
  assert.ok(node, 'a reporting node is built');
  assert.equal(node.description, 'reporting');
  const tokenNode = node.content[0];
  assert.equal(tokenNode.description, 'reporting_token');
  assert.equal(tokenNode.attrs.v, '2');
  assert.ok(Buffer.isBuffer(tokenNode.content) && tokenNode.content.length === 16,
    'the token is 16 bytes');
});

test('the token is keyed by sender and recipient as separate identities', () => {
  const plaintext = ensureMessageSecret(textPlaintext('bind both'));
  const secret = inspectMessage(plaintext).messageSecret;

  // Recompute the token the way the native client / whatsmeow does:
  // origMsgSender = us, modificationSender = the recipient.
  const key = generateMsgSecretKey('Report Token', MSG_ID, SENDER, RECIP, secret);
  const content = extractReportingTokenContent(plaintext, COMPILED);
  const expected = crypto.createHmac('sha256', key).update(content).digest().subarray(0, 16);

  const node = buildReportingNode({
    plaintext, msgId: MSG_ID, remoteJid: RECIP, senderJid: SENDER, BinaryNode
  });
  assert.equal(node.content[0].content.toString('hex'), expected.toString('hex'),
    'token matches the sender/recipient derivation');

  // Keyed with the recipient on both halves — the old bug — it must differ,
  // which proves the sender identity is actually bound into the key.
  const buggyKey = generateMsgSecretKey('Report Token', MSG_ID, RECIP, RECIP, secret);
  const buggy = crypto.createHmac('sha256', buggyKey).update(content).digest().subarray(0, 16);
  assert.notEqual(buggy.toString('hex'), expected.toString('hex'),
    'the two identities are not collapsed into one');
});
