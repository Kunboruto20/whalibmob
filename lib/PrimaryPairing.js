'use strict';

// Primary-side companion linking — the inverse of the companion QR / link-code
// path in PairingCode.js and CompanionPairing.js.
//
// A mobile (SMS-registered) session is the account owner. A WhatsApp Web /
// Baileys companion shows an 8-character code or a QR; this module is what the
// primary does after the human pastes that code or QR:
//
//   link code
//     1. companion_hello notification arrives (wrapped companion ephemeral + ref)
//     2. primary unwraps it with the typed code, mints its own ephemeral,
//        sends primary_hello
//     3. companion_finish notification arrives (wrapped key bundle)
//     4. primary derives adv_secret and sends <pair-device>
//
//   QR
//     parse ref,noise,identity,adv[,platform] and send <pair-device> immediately
//
// Stanza shapes and crypto match the yowsup reverse in
// bcheck/app/yowbot_layer.py and bcheck/common/utils.py.

const crypto = require('crypto');
const curveJs = require('./curve');
const {
  generateEphemeralKeyPair,
  decipherLinkPublicKey,
  buildWrappedEphemeralPub,
  aesDecryptGCM,
  hkdf,
  sharedKey,
  stripKeyPrefix
} = require('./PairingCode');

const WA_ADV_ACCOUNT_SIG_PREFIX   = Buffer.from([6, 0]);
const WA_ADV_KEY_INDEX_LIST_PREFIX = Buffer.from([6, 2]);

// ─── minimal protobuf writers ────────────────────────────────────────────────

function varint(n) {
  const out = [];
  let v = Number(n) >>> 0;
  // allow uint64 timestamps that fit in Number safely
  if (typeof n === 'bigint' || n > 0xffffffff) {
    let big = typeof n === 'bigint' ? n : BigInt(n);
    do {
      let b = Number(big & 0x7fn);
      big >>= 7n;
      if (big) b |= 0x80;
      out.push(b);
    } while (big);
    return Buffer.from(out);
  }
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function bytesField(num, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([varint((num << 3) | 2), varint(b.length), b]);
}

function varintField(num, n) {
  return Buffer.concat([varint((num << 3) | 0), varint(n)]);
}

function encodeADVDeviceIdentity(opts) {
  // ADVDeviceIdentity: rawId=1, timestamp=2, keyIndex=3, accountType=4, deviceType=5
  return Buffer.concat([
    varintField(1, opts.rawId >>> 0),
    varintField(2, opts.timestamp >>> 0),
    varintField(3, opts.keyIndex >>> 0),
    varintField(4, opts.accountType || 0),
    varintField(5, opts.deviceType || 0)
  ]);
}

function encodeADVKeyIndexList(opts) {
  // ADVKeyIndexList: rawId=1, timestamp=2, currentIndex=3, validIndexes=4 (repeated)
  const parts = [
    varintField(1, opts.rawId >>> 0),
    varintField(2, opts.timestamp >>> 0),
    varintField(3, opts.currentIndex >>> 0)
  ];
  const indexes = opts.validIndexes || [];
  for (const i of indexes) parts.push(varintField(4, i >>> 0));
  return Buffer.concat(parts);
}

function encodeADVSignedDeviceIdentity(details, accountSignatureKey, accountSignature) {
  // deviceSignature is filled in by the companion — primary omits it
  return Buffer.concat([
    bytesField(1, details),
    bytesField(2, accountSignatureKey),
    bytesField(3, accountSignature)
  ]);
}

function encodeADVSignedDeviceIdentityHMAC(details, hmac) {
  return Buffer.concat([
    bytesField(1, details),
    bytesField(2, hmac)
  ]);
}

function encodeADVSignedKeyIndexList(details, accountSignature) {
  return Buffer.concat([
    bytesField(1, details),
    bytesField(2, accountSignature)
  ]);
}

function signIdentity(priv, message) {
  return Buffer.from(curveJs.sign(stripKeyPrefix(priv), message));
}

/**
 * Stage after companion_hello + typed code: decrypt companion ephemeral,
 * mint primary ephemeral, wrap it for primary_hello.
 *
 * @returns {{
 *   primaryEphemeralKeyPair: {private: Buffer, public: Buffer},
 *   companionEphemeralPub: Buffer,
 *   wrappedPrimaryEphemeral: Buffer,
 *   primaryIdentityPub: Buffer
 * }}
 */
async function buildPrimaryHello(opts) {
  const {
    pairingCode,
    companionWrappedEphemeral,
    primaryIdentityPub
  } = opts;

  const companionEphemeralPub = await decipherLinkPublicKey(
    companionWrappedEphemeral, pairingCode
  );
  const primaryEphemeralKeyPair = generateEphemeralKeyPair();
  const wrappedPrimaryEphemeral = await buildWrappedEphemeralPub(
    pairingCode, primaryEphemeralKeyPair.public
  );

  return {
    primaryEphemeralKeyPair,
    companionEphemeralPub: Buffer.from(companionEphemeralPub),
    wrappedPrimaryEphemeral,
    primaryIdentityPub: stripKeyPrefix(primaryIdentityPub)
  };
}

/**
 * Inverse of buildCompanionFinishBundle. Decrypt the companion's key bundle
 * and derive the shared adv_secret.
 *
 * Bundle layout: salt(32) || iv(12) || AES-GCM(companionIdPub||primaryIdPub||random)
 *
 * @returns {{ advSecretKey: Buffer, companionIdentityPub: Buffer }}
 */
function finishPrimaryFromCompanionBundle(opts) {
  const {
    wrappedKeyBundle,
    companionIdentityPub,
    companionEphemeralPub,
    primaryEphemeralPrivate,
    primaryIdentityKeyPair
  } = opts;

  const buf = Buffer.isBuffer(wrappedKeyBundle)
    ? wrappedKeyBundle : Buffer.from(wrappedKeyBundle);
  if (buf.length < 32 + 12 + 17) {
    throw new Error('companion key bundle too short: ' + buf.length);
  }

  const salt = buf.slice(0, 32);
  const iv   = buf.slice(32, 44);
  const enc  = buf.slice(44);

  const companionSharedKey = sharedKey(primaryEphemeralPrivate, companionEphemeralPub);
  const expanded = hkdf(
    companionSharedKey, 32,
    'link_code_pairing_key_bundle_encryption_key', salt
  );
  const plaintext = aesDecryptGCM(enc, expanded, iv, Buffer.alloc(0));
  // companionId(32) + primaryId(32) + random(32)
  if (plaintext.length < 96) {
    throw new Error('decrypted companion key bundle too short: ' + plaintext.length);
  }

  const bundleCompanionId = plaintext.slice(0, 32);
  const random            = plaintext.slice(64, 96);

  const expectedCompanionId = stripKeyPrefix(companionIdentityPub);
  if (Buffer.compare(bundleCompanionId, expectedCompanionId) !== 0) {
    // Prefer the identity the companion declared on the wire (companion_identity_public);
    // the bundle repeats it — mismatch means a corrupted or spoofed finish.
    throw new Error('companion identity in key bundle does not match companion_identity_public');
  }

  const identitySharedKey = sharedKey(
    primaryIdentityKeyPair.private, expectedCompanionId
  );
  const identityPayload = Buffer.concat([
    companionSharedKey, identitySharedKey, random
  ]);
  const advSecretKey = hkdf(identityPayload, 32, 'adv_secret');

  return {
    advSecretKey,
    companionIdentityPub: expectedCompanionId
  };
}

/**
 * Build the bodies of a primary <pair-device> IQ.
 *
 * @returns {{
 *   ref: Buffer|string,
 *   pubKey: Buffer,
 *   deviceIdentity: Buffer,
 *   keyIndexList: Buffer,
 *   keyIndex: number,
 *   rawId: number
 * }}
 */
function buildPairDevicePayload(opts) {
  const companionNoisePub    = stripKeyPrefix(opts.companionNoisePub);
  const companionIdentityPub = stripKeyPrefix(opts.companionIdentityPub);
  const advSecret            = Buffer.isBuffer(opts.advSecret)
    ? opts.advSecret
    : Buffer.from(opts.advSecret, 'base64');
  const identityPriv = opts.identityKeyPair.private;
  const identityPub  = stripKeyPrefix(opts.identityKeyPair.public);

  const keyIndex = opts.keyIndex >>> 0;
  const rawId = opts.rawId != null
    ? (opts.rawId >>> 0)
    : ((crypto.randomBytes(4).readUInt32BE(0) % 200000000) + 1500000000);
  const timestamp = opts.timestamp != null
    ? (opts.timestamp >>> 0)
    : (Math.floor(Date.now() / 1000) >>> 0);

  const validIndexes = Array.isArray(opts.validIndexes)
    ? opts.validIndexes.map(i => i >>> 0)
    : [];

  const deviceDetails = encodeADVDeviceIdentity({
    rawId, timestamp, keyIndex, accountType: 0, deviceType: 0
  });

  const accountMsg = Buffer.concat([
    WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, companionIdentityPub
  ]);
  const accountSignature = signIdentity(identityPriv, accountMsg);

  const signedIdentity = encodeADVSignedDeviceIdentity(
    deviceDetails, identityPub, accountSignature
  );
  const hmac = crypto.createHmac('sha256', advSecret)
    .update(signedIdentity)
    .digest();
  const deviceIdentity = encodeADVSignedDeviceIdentityHMAC(signedIdentity, hmac);

  const keyIndexDetails = encodeADVKeyIndexList({
    rawId,
    timestamp,
    currentIndex: keyIndex,
    validIndexes
  });
  // Sign the key-index-list details (prefix 0x06 0x02). Matches the ADV
  // message-type convention; yowsup historically signed device-identity
  // details here, which the server still often accepts, but the list itself
  // is what this HMAC authenticates.
  const keyIndexSig = signIdentity(
    identityPriv,
    Buffer.concat([WA_ADV_KEY_INDEX_LIST_PREFIX, keyIndexDetails])
  );
  const keyIndexList = encodeADVSignedKeyIndexList(keyIndexDetails, keyIndexSig);

  let ref = opts.ref;
  if (typeof ref === 'string') ref = Buffer.from(ref, 'utf8');
  else if (!Buffer.isBuffer(ref)) ref = Buffer.from(ref);

  return {
    ref,
    pubKey: companionNoisePub,
    deviceIdentity,
    keyIndexList,
    keyIndex,
    rawId
  };
}

/**
 * Parse a companion QR string (bare CSV or wa.me/settings/linked_devices#…).
 *
 * @returns {{
 *   ref: Buffer,
 *   companionNoisePub: Buffer,
 *   companionIdentityPub: Buffer,
 *   advSecret: Buffer,
 *   platformId: number|null
 * }}
 */
function parseCompanionQr(qrOrUrl) {
  let raw = String(qrOrUrl || '').trim();
  if (!raw) throw new Error('empty QR string');

  // Only peel a wa.me linked_devices URL — refs themselves may contain '#'.
  const linked = raw.match(/linked_devices#(.+)$/i);
  if (linked) {
    raw = linked[1];
  } else if (/^https?:\/\//i.test(raw)) {
    const hashIdx = raw.indexOf('#');
    if (hashIdx >= 0) raw = raw.slice(hashIdx + 1);
  }

  const parts = raw.split(',');
  if (parts.length < 4) {
    throw new Error(
      'QR must have at least 4 comma-separated fields (ref,noise,identity,adv[,platform])'
    );
  }

  const ref = Buffer.from(parts[0], 'utf8');
  const companionNoisePub    = Buffer.from(parts[1], 'base64');
  const companionIdentityPub = Buffer.from(parts[2], 'base64');
  const advSecret            = Buffer.from(parts[3], 'base64');
  const platformId = parts[4] != null && parts[4] !== ''
    ? parseInt(parts[4], 10)
    : null;

  if (companionNoisePub.length !== 32) {
    throw new Error('QR noise pub must be 32 bytes, got ' + companionNoisePub.length);
  }
  if (companionIdentityPub.length !== 32) {
    throw new Error('QR identity pub must be 32 bytes, got ' + companionIdentityPub.length);
  }
  if (advSecret.length !== 32) {
    throw new Error('QR adv secret must be 32 bytes, got ' + advSecret.length);
  }

  return {
    ref,
    companionNoisePub,
    companionIdentityPub,
    advSecret,
    platformId: Number.isFinite(platformId) ? platformId : null
  };
}

/**
 * Next companion device index and the valid_indexes list for key-index-list.
 * Primary is slot 0 and is not listed; companions start at 1.
 */
function allocateCompanionDeviceIndex(linkedDeviceIndexes) {
  const existing = Array.isArray(linkedDeviceIndexes)
    ? linkedDeviceIndexes.map(i => i >>> 0).filter(i => i > 0)
    : [];
  const next = existing.length ? Math.max.apply(null, existing) + 1 : 1;
  // validIndexes MUST contain the new companion's own index. Official clients
  // (phone, WA Web) drop every device whose keyIndex is not in the signed list
  // and never encrypt to it → companion sees "No session" / empty messages.
  return { keyIndex: next, validIndexes: existing.concat([next]) };
}

module.exports = {
  buildPrimaryHello,
  finishPrimaryFromCompanionBundle,
  buildPairDevicePayload,
  parseCompanionQr,
  allocateCompanionDeviceIndex,
  encodeADVDeviceIdentity,
  encodeADVKeyIndexList,
  WA_ADV_ACCOUNT_SIG_PREFIX,
  WA_ADV_KEY_INDEX_LIST_PREFIX
};
