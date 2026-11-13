'use strict';

// pair-success: the moment a companion becomes part of the account.
//
// The primary device sends back an ADVSignedDeviceIdentity — a small record
// saying "this identity key is mine, at this key index, from this timestamp" —
// wrapped in an HMAC under adv_secret, the key both sides derived during the
// pairing exchange. Three checks have to pass before we accept it:
//
//   1. the HMAC, which proves it came from someone holding adv_secret;
//   2. the account signature over our own identity public key, which proves the
//      primary really did authorise *this* device and not some other one;
//   3. nothing about our own key material has changed underneath us.
//
// Then we counter-sign with our identity key and hand it back. That signed
// record is what rides on every pkmsg we send from then on: it is how the
// recipient's client knows a message from device 7 of an account is genuinely
// from that account.

const { Boom } = require('@hapi/boom');
const { statusFrom } = require('./errors');
const crypto  = require('crypto');
const curveJs = require('./curve');

const WA_ADV_ACCOUNT_SIG_PREFIX        = Buffer.from([6, 0]);
const WA_ADV_DEVICE_SIG_PREFIX         = Buffer.from([6, 1]);
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5]);

const ADV_ENCRYPTION_TYPE_HOSTED = 1;

// ─── minimal protobuf reader ─────────────────────────────────────────────────
//
// Same approach the rest of the library takes: these messages are four fields
// wide and never change, so a reader is cheaper than a schema runtime.

function readVarint(buf, off) {
  let v = 0, shift = 0;
  while (off.pos < buf.length) {
    const b = buf[off.pos++];
    v += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return v;
}

function readFields(buf) {
  const fields = {};
  const off = { pos: 0 };
  while (off.pos < buf.length) {
    const tag = readVarint(buf, off);
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      fields[fieldNum] = readVarint(buf, off);
    } else if (wireType === 2) {
      const len = readVarint(buf, off);
      fields[fieldNum] = buf.slice(off.pos, off.pos + len);
      off.pos += len;
    } else if (wireType === 5) {
      fields[fieldNum] = buf.slice(off.pos, off.pos + 4);
      off.pos += 4;
    } else if (wireType === 1) {
      fields[fieldNum] = buf.slice(off.pos, off.pos + 8);
      off.pos += 8;
    } else {
      break;
    }
  }
  return fields;
}

function varint(n) {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function bytesField(num, buf) {
  return Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
}

/**
 * Re-encode an ADVSignedDeviceIdentity, optionally without the account
 * signature key.
 *
 * The reply we send back omits it — the primary already has its own key and
 * echoing it adds nothing — while the copy we keep for pkmsg attachment keeps
 * it, because recipients need it to verify our device signature.
 */
function encodeSignedDeviceIdentity(account, includeSignatureKey) {
  const parts = [bytesField(1, account.details)];
  if (includeSignatureKey && account.accountSignatureKey && account.accountSignatureKey.length) {
    parts.push(bytesField(2, account.accountSignatureKey));
  }
  if (account.accountSignature) parts.push(bytesField(3, account.accountSignature));
  if (account.deviceSignature)  parts.push(bytesField(4, account.deviceSignature));
  return Buffer.concat(parts);
}

function stripKeyPrefix(pub) {
  if (pub && pub.length === 33 && pub[0] === 0x05) return pub.slice(1);
  return pub;
}

// What the server is told when a pair-success is turned down. It hears the
// reason as a code and a short word, the same pair the reference client sends,
// so the phone can stop waiting instead of timing out.
const PAIR_ERROR = {
  HMAC:      { code: 401, text: 'hmac-mismatch' },
  SIGNATURE: { code: 401, text: 'signature-mismatch' },
  INTERNAL:  { code: 500, text: 'internal-error' }
};

function pairFailure(message, kind) {
  const err = new Boom(message, { statusCode: statusFrom(kind && kind.code, 500) });
  err.pairError = kind;
  return err;
}

/**
 * The <iq type="error"> that answers a pair-success we could not accept.
 */
function buildPairErrorReply(id, kind, BinaryNode) {
  const k = kind || PAIR_ERROR.INTERNAL;
  return new BinaryNode('iq', { to: 's.whatsapp.net', type: 'error', id }, [
    new BinaryNode('error', { code: String(k.code), text: k.text }, null)
  ]);
}

function findChild(node, desc) {
  if (!node || !Array.isArray(node.content)) return null;
  return node.content.find(c => c && c.description === desc) || null;
}

function jidToString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  // BinaryNode decodes JIDs into { user, device, server }
  const user   = v.user != null ? String(v.user) : '';
  const server = v.server || 's.whatsapp.net';
  const device = v.device ? ':' + v.device : '';
  return user + device + '@' + server;
}

/**
 * Validate a <pair-success> stanza and build the reply.
 *
 * @param {object} stanza        the full <iq> containing <pair-success>
 * @param {object} creds         { advSecretKey, identityKeyPair }
 * @returns {{reply: object, me: object, account: object, accountEnc: Buffer,
 *            platform: string|null, deviceIndex: number, keyIndex: number}}
 */
function configureSuccessfulPairing(stanza, creds, BinaryNode) {
  const msgId = stanza.attrs && stanza.attrs.id;

  const pairSuccess = findChild(stanza, 'pair-success');
  if (!pairSuccess) throw pairFailure('pair-success: node missing from stanza', PAIR_ERROR.INTERNAL);

  const deviceIdentityNode = findChild(pairSuccess, 'device-identity');
  const platformNode       = findChild(pairSuccess, 'platform');
  const deviceNode         = findChild(pairSuccess, 'device');
  const businessNode       = findChild(pairSuccess, 'biz');

  if (!deviceIdentityNode || !deviceNode) {
    throw pairFailure('pair-success: missing device-identity or device', PAIR_ERROR.INTERNAL);
  }

  if (!creds || !creds.advSecretKey) {
    throw pairFailure('pair-success: no adv secret to verify against', PAIR_ERROR.INTERNAL);
  }

  const hmacMsg = readFields(Buffer.from(deviceIdentityNode.content));
  const details = hmacMsg[1];
  const hmac    = hmacMsg[2];
  const accountType = hmacMsg[3];
  if (!details || !hmac) throw pairFailure('pair-success: malformed ADVSignedDeviceIdentityHMAC', PAIR_ERROR.INTERNAL);

  // 1. HMAC — proves the record came from a holder of adv_secret.
  const hmacPrefix = accountType === ADV_ENCRYPTION_TYPE_HOSTED
    ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
    : Buffer.alloc(0);
  const advSign = crypto.createHmac('sha256', Buffer.from(creds.advSecretKey, 'base64'))
    .update(Buffer.concat([hmacPrefix, details]))
    .digest();
  if (hmac.length !== advSign.length || !crypto.timingSafeEqual(hmac, advSign)) {
    throw pairFailure('pair-success: invalid account signature HMAC — pairing code mismatch', PAIR_ERROR.HMAC);
  }

  const account = readFields(details);
  const accountSignatureKey = account[2];
  const accountSignature    = account[3];
  const deviceDetails       = account[1];
  if (!accountSignatureKey || !accountSignature || !deviceDetails) {
    throw pairFailure('pair-success: malformed ADVSignedDeviceIdentity', PAIR_ERROR.INTERNAL);
  }

  const deviceIdentity = readFields(deviceDetails);
  const keyIndex   = deviceIdentity[3] || 0;
  const deviceType = deviceIdentity[5];

  // 2. Account signature over our identity key — proves the primary authorised
  //    this exact device.
  const ourIdentityPub = stripKeyPrefix(creds.identityKeyPair.public);
  const accountSigPrefix = deviceType === ADV_ENCRYPTION_TYPE_HOSTED
    ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
    : WA_ADV_ACCOUNT_SIG_PREFIX;
  const accountMsg = Buffer.concat([accountSigPrefix, deviceDetails, ourIdentityPub]);
  let signatureOk = false;
  try {
    signatureOk = stripKeyPrefix(accountSignatureKey).length === 32 && accountSignature.length === 64 &&
      !!curveJs.verify(stripKeyPrefix(accountSignatureKey), accountMsg, accountSignature);
  } catch (_) { signatureOk = false; }
  if (!signatureOk) {
    throw pairFailure('pair-success: failed to verify account signature', PAIR_ERROR.SIGNATURE);
  }

  // 3. Counter-sign. This is the signature recipients check on our pkmsgs.
  const deviceMsg = Buffer.concat([
    WA_ADV_DEVICE_SIG_PREFIX,
    deviceDetails,
    ourIdentityPub,
    stripKeyPrefix(accountSignatureKey)
  ]);
  const deviceSignature = Buffer.from(
    curveJs.sign(creds.identityKeyPair.private, deviceMsg)
  );

  const signedAccount = {
    details:             deviceDetails,
    accountSignatureKey: stripKeyPrefix(accountSignatureKey),
    accountSignature,
    deviceSignature
  };

  const jid = jidToString(deviceNode.attrs && deviceNode.attrs.jid);
  const lid = jidToString(deviceNode.attrs && deviceNode.attrs.lid);
  const deviceIndex = jid && jid.includes(':')
    ? parseInt(jid.split('@')[0].split(':')[1], 10) || 0
    : 0;

  const reply = new BinaryNode('iq', {
    to:   's.whatsapp.net',
    type: 'result',
    id:   msgId
  }, [
    new BinaryNode('pair-device-sign', {}, [
      new BinaryNode('device-identity', { 'key-index': String(keyIndex) },
        encodeSignedDeviceIdentity(signedAccount, false))
    ])
  ]);

  return {
    reply,
    me: {
      id:   jid,
      lid:  lid,
      name: (businessNode && businessNode.attrs && businessNode.attrs.name) || null
    },
    account:    signedAccount,
    // What gets persisted and attached to outgoing pkmsg stanzas — with the
    // account signature key, since recipients need it to check our signature.
    accountEnc: encodeSignedDeviceIdentity(signedAccount, true),
    platform:   (platformNode && platformNode.attrs && platformNode.attrs.name) || null,
    businessName: (businessNode && businessNode.attrs && businessNode.attrs.name) || null,
    // A hosted account's signature key is the host's, not a phone's identity.
    hosted:     deviceType === ADV_ENCRYPTION_TYPE_HOSTED || accountType === ADV_ENCRYPTION_TYPE_HOSTED,
    deviceIndex,
    keyIndex
  };
}

module.exports = {
  configureSuccessfulPairing,
  buildPairErrorReply,
  PAIR_ERROR,
  encodeSignedDeviceIdentity,
  readFields,
  WA_ADV_ACCOUNT_SIG_PREFIX,
  WA_ADV_DEVICE_SIG_PREFIX,
  WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
};
