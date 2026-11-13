'use strict';

// Messages that act on another message and are encrypted under that message's
// secret: a vote on a poll, a reaction or a comment in a community announcement
// group, a response to an event, an encrypted edit.
//
// Every one of them is sealed the same way. The message being acted on carries
// a 32-byte secret beside its content (messageContextInfo.messageSecret), and
// the key for one add-on is derived from that secret and from who is involved:
//
//   key = HKDF-SHA256(secret, salt = none,
//                     info = targetId | targetSender | addOnSender | useCase, 32)
//   payload = AES-256-GCM(key, iv, plaintext, aad)
//
// The use case is a fixed label, so a key for a vote cannot open a reaction.
// Two of them also bind the ciphertext to its target with additional data,
// targetId | 0x00 | addOnSender; the others use none. Both JIDs go in without
// a device: an add-on belongs to an account.

const { Boom } = require('@hapi/boom');
const crypto = require('crypto');
const { hkdfSha256 } = require('../hkdf');

const SECRET_TYPE = {
  POLL_VOTE:       'Poll Vote',
  REACTION:        'Enc Reaction',
  COMMENT:         'Enc Comment',
  EVENT_RESPONSE:  'Event Response',
  EVENT_EDIT:      'Event Edit',
  MESSAGE_EDIT:    'Message Edit',
  POLL_EDIT:       'Poll Edit',
  POLL_ADD_OPTION: 'Poll Add Option'
};

// SecretEncryptedMessage.secretEncType → the label its key is derived under.
const SECRET_ENC_TYPE = {
  1: SECRET_TYPE.EVENT_EDIT,
  2: SECRET_TYPE.MESSAGE_EDIT,
  4: SECRET_TYPE.POLL_EDIT,
  // An added option is sealed under the same label as an edit of the poll.
  5: SECRET_TYPE.POLL_EDIT
};

const WITH_AAD = new Set([SECRET_TYPE.POLL_VOTE, SECRET_TYPE.EVENT_RESPONSE]);

function nonAd(jid) {
  const s = String(jid || '');
  const at = s.indexOf('@');
  if (at < 0) return s;
  return s.slice(0, at).split(':')[0] + s.slice(at);
}

function deriveSecretKey(opts) {
  const type = opts.type;
  if (!Object.values(SECRET_TYPE).includes(type)) {
    throw new Boom('message secret: unknown use case ' + JSON.stringify(type), { statusCode: 400 });
  }
  const secret = opts.messageSecret;
  if (!secret || secret.length !== 32) {
    throw new Boom('message secret: the target message\'s 32-byte secret is required', { statusCode: 400 });
  }
  const targetId = String(opts.targetId || '');
  if (!targetId) throw new Boom('message secret: the target message id is required', { statusCode: 400 });
  const targetSender = nonAd(opts.targetSender);
  const sender       = nonAd(opts.sender);
  if (!targetSender || targetSender.startsWith('@')) {
    throw new Boom('message secret: who sent the target message is required', { statusCode: 400 });
  }
  if (!sender || sender.startsWith('@')) {
    throw new Boom('message secret: who sent the add-on is required', { statusCode: 400 });
  }
  const info = Buffer.from(targetId + targetSender + sender + type, 'utf8');
  const key  = hkdfSha256(Buffer.from(secret), Buffer.alloc(0), info, 32);
  const aad  = WITH_AAD.has(type)
    ? Buffer.concat([Buffer.from(targetId, 'utf8'), Buffer.from([0]), Buffer.from(sender, 'utf8')])
    : null;
  return { key, aad };
}

/** Open an add-on. `encPayload` ends with the 16-byte GCM tag. */
function decryptSecret(opts) {
  const { key, aad } = deriveSecretKey(opts);
  const payload = Buffer.from(opts.encPayload || []);
  const iv      = Buffer.from(opts.encIv || []);
  if (payload.length < 16 || iv.length !== 12) {
    throw new Boom('message secret: the add-on carries no usable ciphertext', { statusCode: 400 });
  }
  try {
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad) dec.setAAD(aad);
    dec.setAuthTag(payload.subarray(payload.length - 16));
    return Buffer.concat([dec.update(payload.subarray(0, payload.length - 16)), dec.final()]);
  } catch (_) {
    throw new Boom('message secret: the add-on would not open — wrong secret, ' +
      'or the wrong sender for this target', { statusCode: 400 });
  }
}

/** Seal an add-on. Returns `{ encPayload, encIv }`. */
function encryptSecret(opts) {
  const { key, aad } = deriveSecretKey(opts);
  const iv = opts.iv || crypto.randomBytes(12);
  const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) enc.setAAD(aad);
  const encPayload = Buffer.concat([enc.update(Buffer.from(opts.plaintext)), enc.final(), enc.getAuthTag()]);
  return { encPayload, encIv: iv };
}

/** A poll's options are named in a ballot by the SHA-256 of their text. */
function hashPollOptions(names) {
  return (names || []).map(n => crypto.createHash('sha256').update(String(n), 'utf8').digest());
}

module.exports = {
  SECRET_TYPE, SECRET_ENC_TYPE, nonAd,
  deriveSecretKey, decryptSecret, encryptSecret, hashPollOptions
};
