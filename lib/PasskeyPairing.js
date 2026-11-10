'use strict';

// Linking with a passkey, the third way in beside the QR and the 8-character
// code.
//
// An account that has a passkey can ask a new companion to prove the owner is
// present with it instead of having them scan or type anything. The server
// starts it: an unpaired companion receives a WebAuthn challenge, the caller
// has an authenticator sign it, and from there the two devices agree on a key
// the same way the other paths do, with one extra check a human can read.
//
// The exchange, in order:
//
//   1. passkey_prologue_request  the server pushes WebAuthn request options.
//   2. passkey_prologue          we send the signed assertion, and with it a
//                                commitment to an ephemeral public key and a
//                                nonce we keep to ourselves for now.
//   3. crsc_continuation         the primary answers with its own ephemeral
//                                key and nonce.
//   4. companion_nonce           we reveal the nonce, so the primary can check
//                                it against the commitment from step 2. Both
//                                sides now derive the same short code, which
//                                the owner compares by eye.
//   5. encrypted_pairing_request our noise key, identity key and adv secret,
//                                encrypted under the key from the exchange.
//   6. pair-success              as on every other path.
//
// The commitment is what makes the code worth comparing: neither side can pick
// its nonce after seeing the other's, so a matching code means nobody sat in
// the middle swapping keys.
//
// Nothing here talks to the network or to an authenticator. These are the
// encodings and derivations; the client drives them.

const crypto = require('crypto');
const { hkdfSha256 } = require('./hkdf');
const curveJs = require('./curve');
const { CROCKFORD_CHARACTERS, bytesToCrockford, stripKeyPrefix } = require('./PairingCode');

const HANDOFF_INFO     = 'shortcake-passkey-handoff-v1';
const ENCRYPTION_INFO  = 'Pairing Information Encryption Key';
// A handoff key proves this client was the one showing the QR a moment ago.
// It is only honoured for a short while after the request that minted it.
const HANDOFF_TTL_MS   = 5 * 60 * 1000;

// ─── minimal protobuf ────────────────────────────────────────────────────────
//
// Six messages, each two or three fields wide. A reader and a writer are
// cheaper than a schema runtime, as everywhere else in the library.

function varint(n) {
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function bytesField(num, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([varint((num << 3) | 2), varint(b.length), b]);
}

function varintField(num, value) {
  return Buffer.concat([varint((num << 3) | 0), varint(value)]);
}

function readFields(buf) {
  const fields = {};
  let pos = 0;
  const readVarint = () => {
    let v = 0, shift = 0;
    for (;;) {
      if (pos >= buf.length) throw new Error('truncated protobuf');
      const b = buf[pos++];
      v += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) return v;
      shift += 7;
    }
  };
  while (pos < buf.length) {
    const tag = readVarint();
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      fields[num] = readVarint();
    } else if (wire === 2) {
      const len = readVarint();
      if (pos + len > buf.length) throw new Error('truncated protobuf');
      fields[num] = buf.slice(pos, pos + len);
      pos += len;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error('unsupported protobuf wire type ' + wire);
    }
  }
  return fields;
}

// CompanionEphemeralIdentity { publicKey = 1, deviceType = 2, ref = 3 }
function encodeCompanionEphemeralIdentity(o) {
  return Buffer.concat([
    bytesField(1, o.publicKey),
    varintField(2, o.deviceType || 0),
    bytesField(3, Buffer.from(String(o.ref), 'utf8'))
  ]);
}

// ProloguePayload { companionEphemeralIdentity = 1, commitment = 2 { hash = 1 } }
function encodeProloguePayload(identity, commitmentHash) {
  return Buffer.concat([
    bytesField(1, identity),
    bytesField(2, bytesField(1, commitmentHash))
  ]);
}

// PrimaryEphemeralIdentity { publicKey = 1, nonce = 2 }
function decodePrimaryEphemeralIdentity(buf) {
  const f = readFields(Buffer.from(buf));
  const publicKey = f[1], nonce = f[2];
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) {
    throw new Error('primary ephemeral identity: unexpected public key length ' +
      (Buffer.isBuffer(publicKey) ? publicKey.length : 0));
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) {
    throw new Error('primary ephemeral identity: unexpected nonce length ' +
      (Buffer.isBuffer(nonce) ? nonce.length : 0));
  }
  return { publicKey, nonce };
}

// PairingRequest { companionPublicKey = 1, companionIdentityKey = 2, advSecret = 3 }
function encodePairingRequest(o) {
  return Buffer.concat([
    bytesField(1, o.companionPublicKey),
    bytesField(2, o.companionIdentityKey),
    bytesField(3, o.advSecret)
  ]);
}

// EncryptedPairingRequest { encryptedPayload = 1, IV = 2 }
function encodeEncryptedPairingRequest(encryptedPayload, iv) {
  return Buffer.concat([bytesField(1, encryptedPayload), bytesField(2, iv)]);
}

// ─── WebAuthn JSON ───────────────────────────────────────────────────────────
//
// The server speaks the JSON form of WebAuthn: binary members are base64url
// without padding, the shape PublicKeyCredential.toJSON() produces in a
// browser. Callers hand in whatever their authenticator gave them, bytes or
// base64url or plain base64, and it is normalised on the way out.

function toBytes(value, what) {
  if (value == null) throw new Error('passkey response: ' + what + ' is missing');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) {
      throw new Error('passkey response: ' + what + ' is not base64');
    }
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  throw new Error('passkey response: ' + what + ' must be bytes or a base64 string');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Normalise an authenticator's assertion into what goes on the wire.
 *
 * @param {object} response  { id, rawId, type, response: { clientDataJSON,
 *                           authenticatorData, signature, userHandle? } }
 * @returns {{credentialId: Buffer, json: Buffer}}
 */
function encodeWebAuthnResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('passkey response: an assertion object is required');
  }
  const inner = response.response;
  if (!inner || typeof inner !== 'object') {
    throw new Error('passkey response: response.response is missing');
  }
  const rawId = toBytes(response.rawId != null ? response.rawId : response.id, 'rawId');
  if (!rawId.length) throw new Error('passkey response: rawId is empty');

  const body = {
    id:    typeof response.id === 'string' && response.id ? response.id : b64url(rawId),
    rawId: b64url(rawId),
    type:  response.type || 'public-key',
    response: {
      clientDataJSON:    b64url(toBytes(inner.clientDataJSON, 'clientDataJSON')),
      authenticatorData: b64url(toBytes(inner.authenticatorData, 'authenticatorData')),
      signature:         b64url(toBytes(inner.signature, 'signature')),
      userHandle:        inner.userHandle == null ? null : b64url(toBytes(inner.userHandle, 'userHandle'))
    }
  };
  return { credentialId: rawId, json: Buffer.from(JSON.stringify(body), 'utf8') };
}

/**
 * Read the request options the server pushed. They are WebAuthn request
 * options in their JSON form and are handed to the caller as they came, which
 * is what PublicKeyCredential.parseRequestOptionsFromJSON() takes.
 */
function parseRequestOptions(content) {
  if (content == null) throw new Error('passkey request: options are missing');
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { throw new Error('passkey request: options are not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('passkey request: options are not an object');
  }
  if (typeof parsed.challenge !== 'string' || !parsed.challenge) {
    throw new Error('passkey request: options carry no challenge');
  }
  return parsed;
}

// ─── derivations ─────────────────────────────────────────────────────────────

/**
 * The key that ties a passkey response to the QR this client was showing.
 *
 * Derived from the adv secret that was in that QR, just before the secret is
 * replaced. A proof under it lets the phone skip the code comparison: the owner
 * already had this exact client in front of their camera.
 */
function deriveHandoffKey(advSecret) {
  return hkdfSha256(Buffer.from(advSecret), Buffer.alloc(32), Buffer.from(HANDOFF_INFO, 'utf8'), 32);
}

function handoffProof(handoffKey, prologuePayload) {
  return crypto.createHmac('sha256', handoffKey).update(prologuePayload).digest();
}

/**
 * Step 2. An ephemeral key pair, a nonce, and the payload that commits to both.
 *
 * The commitment is SHA-256 over the encoded identity followed by the nonce.
 * The nonce stays here until the primary has answered.
 *
 * @param {object} o  { ref, deviceType, keyPair?, nonce? } — the last two are
 *                    for tests; real use generates them.
 */
function buildPrologue(o) {
  const kp = o.keyPair || (() => {
    const pair = curveJs.generateKeyPair(crypto.randomBytes(32));
    return { private: Buffer.from(pair.private), public: Buffer.from(pair.public) };
  })();
  const companionNonce = o.nonce || crypto.randomBytes(32);
  const identity = encodeCompanionEphemeralIdentity({
    publicKey:  stripKeyPrefix(kp.public),
    deviceType: o.deviceType,
    ref:        o.ref
  });
  const commitment = crypto.createHash('sha256')
    .update(Buffer.concat([identity, companionNonce])).digest();
  return {
    keyPair:         kp,
    companionNonce,
    prologuePayload: encodeProloguePayload(identity, commitment)
  };
}

/**
 * Step 4. From the primary's answer, the key the pairing request is encrypted
 * under and the code both screens show.
 *
 * The code is five bytes: the primary's nonce XORed with a digest of our nonce
 * and its public key, in the same alphabet the 8-character pairing code uses.
 *
 * @returns {{encryptionKey: Buffer, code: string}}  code is "XXXX-XXXX"
 */
function deriveContinuation(o) {
  const primaryPub = Buffer.from(o.primaryPublicKey);
  const sharedSecret = Buffer.from(curveJs.sharedKey(
    stripKeyPrefix(o.ephemeralPrivate), stripKeyPrefix(primaryPub)));
  const salt = 'Companion Pairing ' + (o.deviceType || 0) + ' with ref ' + o.ref;
  const encryptionKey = hkdfSha256(
    sharedSecret, Buffer.from(salt, 'utf8'), Buffer.from(ENCRYPTION_INFO, 'utf8'), 32);

  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(o.companionNonce), primaryPub])).digest();
  const codeBytes = Buffer.alloc(5);
  for (let i = 0; i < 5; i++) codeBytes[i] = o.primaryNonce[i] ^ digest[i];
  const encoded = bytesToCrockford(codeBytes);
  return { encryptionKey, code: encoded.slice(0, 4) + '-' + encoded.slice(4) };
}

/**
 * Step 5. The keys the primary needs to issue our device identity, sealed with
 * AES-256-GCM under the key from the exchange.
 */
function buildEncryptedPairingRequest(o) {
  const iv = o.iv || crypto.randomBytes(12);
  const plain = encodePairingRequest({
    companionPublicKey:   stripKeyPrefix(o.noisePublicKey),
    companionIdentityKey: stripKeyPrefix(o.identityPublicKey),
    advSecret:            Buffer.from(o.advSecret)
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', o.encryptionKey, iv);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return encodeEncryptedPairingRequest(sealed, iv);
}

module.exports = {
  HANDOFF_TTL_MS,
  CROCKFORD_CHARACTERS,
  encodeCompanionEphemeralIdentity,
  encodeProloguePayload,
  decodePrimaryEphemeralIdentity,
  encodePairingRequest,
  encodeEncryptedPairingRequest,
  encodeWebAuthnResponse,
  parseRequestOptions,
  deriveHandoffKey,
  handoffProof,
  buildPrologue,
  deriveContinuation,
  buildEncryptedPairingRequest,
  readFields
};
