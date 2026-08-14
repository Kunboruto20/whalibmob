'use strict';

// Asking the sender's phone to upload a media file again.
//
// Media is not carried in the message. The message carries a URL, a SHA-256 of
// the encrypted bytes and the key to decrypt them, and the bytes themselves sit
// on WhatsApp's CDN with a limited life. A file that has aged out, or one whose
// message arrived through history sync long after the fact, answers the
// download with 404 or 410 — and at that point the media is gone as far as this
// client is concerned, however healthy the message looks.
//
// The sender's phone still has the original. This is how it is asked to put it
// back: a <receipt type="server-error"> naming the message, carrying a small
// encrypted payload that proves we are the intended recipient. The phone
// re-uploads, and the answer comes back as a <notification type="mediaretry">
// with a fresh URL — encrypted the same way, so only we can read it.
//
// The proof is what makes this safe. The receipt encrypts the message id under
// a key derived from the message's own media key, which only the sender and the
// recipients hold. Someone who merely knows a message id cannot produce a valid
// one, so this cannot be used to make a phone re-upload anything on request.
//
//   receipt key = HKDF-SHA256(mediaKey, info = "WhatsApp Media Retry Notification", 32)
//   ciphertext  = AES-256-GCM(receipt key, iv = random 12B, ServerErrorReceipt,
//                             aad = message id)
//
// The notification comes back under the same key, with the same message id as
// the additional data.

const crypto     = require('crypto');
const { hkdf }   = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha256');

const RETRY_KEY_INFO = 'WhatsApp Media Retry Notification';
const IV_SIZE        = 12;

// ─── protobuf helpers ───────────────────────────────────────────────────────
//
// Two tiny messages, hand-encoded rather than pulled through the schema — the
// whole of what travels here is one string out and a handful of fields back.

function pbString(field, str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(buf.length), buf]);
}

function varint(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}

function readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
}

// Every field of the notification, by number. Unknown ones are kept rather than
// dropped so a schema that grows does not read as a corrupt message here.
function readFields(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let key; [key, pos] = readVarint(buf, pos);
    const num = key >> 3, wire = key & 7;
    if (wire === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      out[num] = buf.slice(pos, pos + len);
      pos += len;
    } else if (wire === 0) {
      let val; [val, pos] = readVarint(buf, pos);
      out[num] = val;
    } else if (wire === 5) { pos += 4; }
    else if (wire === 1)   { pos += 8; }
    else break;
  }
  return out;
}

// ─── key derivation ─────────────────────────────────────────────────────────

/** The AES key both halves of the exchange are encrypted under. */
function mediaRetryKey(mediaKey) {
  const ikm = Buffer.isBuffer(mediaKey) ? mediaKey : Buffer.from(mediaKey);
  return Buffer.from(
    hkdf(sha256, ikm, Buffer.alloc(0), Buffer.from(RETRY_KEY_INFO, 'utf8'), 32));
}

/**
 * Encrypt the receipt that asks for a re-upload.
 *
 * @param {string} msgId    the message whose media is missing
 * @param {Buffer} mediaKey that message's media key
 * @returns {{ciphertext: Buffer, iv: Buffer}}
 */
function encryptRetryReceipt(msgId, mediaKey) {
  // ServerErrorReceipt { stanzaId = 1 }
  const plaintext = pbString(1, msgId);
  const iv        = crypto.randomBytes(IV_SIZE);
  const cipher    = crypto.createCipheriv('aes-256-gcm', mediaRetryKey(mediaKey), iv);
  // The message id is the additional data, so a receipt cannot be lifted from
  // one message and replayed against another.
  cipher.setAAD(Buffer.from(msgId, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]), iv };
}

/**
 * Decrypt the notification that answers one.
 *
 * @param {object} notif    { messageId, ciphertext, iv } off the wire
 * @param {Buffer} mediaKey the same media key the receipt was sent with
 * @returns {{result: number, directPath: string|null, url: string|null,
 *            handle: string|null, ciphertextSha256: Buffer|null}}
 */
function decryptRetryNotification(notif, mediaKey) {
  const { messageId, ciphertext, iv } = notif;
  if (!ciphertext || !iv) throw new Error('media retry notification carried no payload');

  const key      = mediaRetryKey(mediaKey);
  const tag      = ciphertext.slice(ciphertext.length - 16);
  const body     = ciphertext.slice(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(messageId, 'utf8'));
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);

  // MediaRetryNotification { stanzaId = 1, directPath = 2, result = 3 }
  const fields = readFields(plaintext);
  const result = typeof fields[3] === 'number' ? fields[3] : null;

  return {
    result,
    // 1 = SUCCESS in the enum; anything else means the phone could not oblige.
    ok:         result === 1,
    directPath: fields[2] ? fields[2].toString('utf8') : null,
    stanzaId:   fields[1] ? fields[1].toString('utf8') : messageId
  };
}

/**
 * The <receipt> that asks the sender's phone for a re-upload.
 *
 * @param {object}   info        { id, chatJid, fromMe, participant }
 * @param {Buffer}   mediaKey
 * @param {string}   ownJid      who the receipt is addressed to — ourselves
 * @param {Function} BinaryNode
 */
function buildRetryReceiptNode(info, mediaKey, ownJid, BinaryNode) {
  const { ciphertext, iv } = encryptRetryReceipt(info.id, mediaKey);

  const rmrAttrs = {
    jid:      info.chatJid,
    from_me:  String(!!info.fromMe)
  };
  // Only a group receipt names the member the message came from; on a DM the
  // chat jid already says it, and sending it anyway is a shape no real client
  // produces.
  if (info.participant) rmrAttrs.participant = info.participant;

  return new BinaryNode('receipt', {
    id:   info.id,
    to:   ownJid,
    type: 'server-error'
  }, [
    new BinaryNode('encrypt', {}, [
      new BinaryNode('enc_p',  {}, ciphertext),
      new BinaryNode('enc_iv', {}, iv)
    ]),
    new BinaryNode('rmr', rmrAttrs, null)
  ]);
}

/**
 * Read a <notification type="mediaretry"> into the pieces the caller needs.
 *
 * Returns null when the node is not one, so a caller can hand it every
 * notification without checking first. An `error` in the result means the phone
 * answered but declined — usually because it no longer has the file either.
 */
function parseRetryNotification(node, helpers) {
  const { findChild, getContent } = helpers;
  const attrs = (node && node.attrs) || {};

  const rmr = findChild(node, 'rmr');
  if (!rmr) return null;

  const out = {
    messageId:   attrs.id || null,
    timestamp:   attrs.t ? Number(attrs.t) : null,
    chatJid:     (rmr.attrs && rmr.attrs.jid) || null,
    fromMe:      !!(rmr.attrs && rmr.attrs.from_me === 'true'),
    participant: (rmr.attrs && rmr.attrs.participant) || null,
    error:       null,
    ciphertext:  null,
    iv:          null
  };

  const errNode = findChild(node, 'error');
  if (errNode) {
    out.error = { code: (errNode.attrs && Number(errNode.attrs.code)) || 0 };
    return out;
  }

  const encrypt = findChild(node, 'encrypt');
  if (encrypt) {
    const p  = findChild(encrypt, 'enc_p');
    const ivN = findChild(encrypt, 'enc_iv');
    out.ciphertext = p   ? getContent(p)   : null;
    out.iv         = ivN ? getContent(ivN) : null;
  }
  return out;
}

module.exports = {
  mediaRetryKey,
  encryptRetryReceipt,
  decryptRetryNotification,
  buildRetryReceiptNode,
  parseRetryNotification,
  RETRY_KEY_INFO
};
