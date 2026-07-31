'use strict';

const { warn: _whaWarn, dbg: _whaDbg } = require('./logger');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const curveJs = require('curve25519-js');
const { v4: uuidv4 } = require('uuid');
const { IOS_DEVICE, IOS_VERSION_FALLBACK, ANDROID_VERSION_FALLBACK,
        platformForOs, isBusinessPlatform } = require('./constants');
const { getDeviceConfig } = require('./DeviceConfig');

// ─────────────────────────────────────────────────────────
// Key prefix byte (Signal protocol DH key type)
// ─────────────────────────────────────────────────────────
const KEY_BUNDLE_TYPE = Buffer.from([0x05]);

function prefixPubKey(raw32) {
  return Buffer.concat([KEY_BUNDLE_TYPE, Buffer.from(raw32)]);
}

function stripPubKeyPrefix(pub) {
  if (pub.length === 33 && pub[0] === 0x05) return pub.slice(1);
  if (pub.length === 32) return pub;
  throw new Error('Invalid public key length: ' + pub.length);
}

// ─────────────────────────────────────────────────────────
// Key generation using curve25519-js (XEdDSA-compatible)
// ─────────────────────────────────────────────────────────

function generateKeyPair() {
  const seed = crypto.randomBytes(32);
  const kp = curveJs.generateKeyPair(seed);
  return {
    private: Buffer.from(kp.private),
    public:  prefixPubKey(kp.public)     // 33 bytes: 0x05 || 32
  };
}

// Sign message with X25519 private key using curve25519-js XEdDSA
// message should be the 33-byte public key (with 0x05 prefix) per Signal protocol convention
function sign(privKey32, message) {
  return Buffer.from(curveJs.sign(privKey32, message));
}

// ─────────────────────────────────────────────────────────
// Store creation
// ─────────────────────────────────────────────────────────

function createNewStore(phoneNumber) {
  const noiseKeyPair     = generateKeyPair();
  const identityKeyPair  = generateKeyPair();
  const signedPreKeyPair = generateKeyPair();

  const signedPreKeyId = (crypto.randomBytes(3).readUIntBE(0, 3) & 0xffffff) || 1;
  const signature      = sign(identityKeyPair.private, signedPreKeyPair.public);

  const registrationId = (crypto.randomBytes(2).readUInt16BE(0) & 0x3fff) + 1;
  const fdid           = uuidv4();
  const deviceId       = crypto.randomBytes(16);
  const identityId     = crypto.randomBytes(16);
  // Device fingerprint fields the native client sends on /code (see
  // Registration.js): advertising id (UUID) and the 20-byte backup token.
  const advertisingId  = uuidv4();
  const backupToken    = crypto.randomBytes(20);

  const device  = getDeviceConfig();
  const version = device.os === 'android' ? ANDROID_VERSION_FALLBACK : IOS_VERSION_FALLBACK;

  const normalizedPhone = String(phoneNumber || '').replace(/^\+/, '');

  return {
    phoneNumber: normalizedPhone,
    noiseKeyPair,
    identityKeyPair,
    signedPreKey: {
      id:        signedPreKeyId,
      public:    signedPreKeyPair.public,    // 33 bytes
      private:   signedPreKeyPair.private,   // 32 bytes
      signature                              // 64 bytes
    },
    registrationId,
    fdid,
    deviceId,
    identityId,
    advertisingId,
    backupToken,
    registered:    false,
    codePending:   false,  // true after /code request, cleared on successful /register
    name:          'User',
    version,
    device,
    // ADVSignedDeviceIdentity bytes received from server <success> node.
    // Persisted so device_identity can be attached to pkmsg stanzas after restart.
    advIdentity:   null
  };
}

// ─────────────────────────────────────────────────────────
// Serialisation / deserialisation
// ─────────────────────────────────────────────────────────

// The device profile as it should be announced, whatever a session file happens
// to hold.
//
// `platform` is the number that goes into the handshake, and Android sessions
// written before it was corrected carry 3 — BlackBerry — which the server
// refuses with 405 on every connect. `os` is the part that was ever chosen
// deliberately, so it decides, and a stale number is repaired the moment the
// session is read. Nothing has to be registered again over it.
function normaliseDevice(device) {
  const merged = Object.assign({}, IOS_DEVICE, device || null);

  // Which variant this session is. The flag is what a session written since
  // Business support landed carries; the stored platform number is what one
  // written by hand, or by an older build, can still say. Either is enough, so
  // that repairing the platform below can never turn a Business session into a
  // consumer one.
  const business = merged.business === true || isBusinessPlatform(merged.platform);
  merged.business = business;

  const expected = platformForOs(merged.os, business);
  if (merged.platform !== expected) {
    _whaDbg('[DBG] DEVICE_PLATFORM_FIXED os=' + merged.os +
      (business ? ' business' : '') +
      ' ' + merged.platform + ' → ' + expected);
    merged.platform = expected;
  }
  return merged;
}

function storeToJson(store) {
  if (!store) {
    throw new Error('storeToJson: store is undefined or null');
  }

  const normalizedPhone = store.phoneNumber
    ? String(store.phoneNumber).replace(/^\+/, '')
    : '';

  const name    = store.name || 'User';
  const version = store.version || IOS_VERSION_FALLBACK;
  const device  = normaliseDevice(store.device);

  const advIdentity = store.advIdentity
    ? store.advIdentity.toString('base64')
    : null;

  return {
    phoneNumber:    normalizedPhone,
    noiseKeyPair: {
      private: store.noiseKeyPair.private.toString('base64'),
      public:  store.noiseKeyPair.public.toString('base64')
    },
    identityKeyPair: {
      private: store.identityKeyPair.private.toString('base64'),
      public:  store.identityKeyPair.public.toString('base64')
    },
    signedPreKey: {
      id:        store.signedPreKey.id,
      private:   store.signedPreKey.private.toString('base64'),
      public:    store.signedPreKey.public.toString('base64'),
      signature: store.signedPreKey.signature.toString('base64')
    },
    registrationId: store.registrationId,
    fdid:           store.fdid,
    deviceId:       store.deviceId.toString('base64'),
    identityId:     store.identityId.toString('base64'),
    advertisingId:  store.advertisingId || null,
    backupToken:    store.backupToken ? store.backupToken.toString('base64') : null,
    registered:     !!store.registered,
    codePending:    store.codePending || false,
    name,
    version,
    device,
    advIdentity
  };
}

function storeFromJson(obj) {
  if (!obj) {
    throw new Error('storeFromJson: input object is undefined or null');
  }

  const name    = obj.name || 'User';
  const version = obj.version || IOS_VERSION_FALLBACK;
  const device  = normaliseDevice(obj.device);

  return {
    phoneNumber:    obj.phoneNumber,
    noiseKeyPair: {
      private: Buffer.from(obj.noiseKeyPair.private, 'base64'),
      public:  Buffer.from(obj.noiseKeyPair.public, 'base64')
    },
    identityKeyPair: {
      private: Buffer.from(obj.identityKeyPair.private, 'base64'),
      public:  Buffer.from(obj.identityKeyPair.public, 'base64')
    },
    signedPreKey: {
      id:        obj.signedPreKey.id,
      private:   Buffer.from(obj.signedPreKey.private, 'base64'),
      public:    Buffer.from(obj.signedPreKey.public, 'base64'),
      signature: Buffer.from(obj.signedPreKey.signature, 'base64')
    },
    registrationId: obj.registrationId,
    fdid:           obj.fdid,
    deviceId:       Buffer.from(obj.deviceId, 'base64'),
    identityId:     Buffer.from(obj.identityId, 'base64'),
    // Backward-compat: older stores predate these fields — regenerate so the
    // enriched /code request always has stable values.
    advertisingId:  obj.advertisingId || uuidv4(),
    backupToken:    obj.backupToken ? Buffer.from(obj.backupToken, 'base64') : crypto.randomBytes(20),
    registered:     !!obj.registered,
    codePending:    obj.codePending || false,
    name,
    version,
    device,
    advIdentity:    obj.advIdentity
      ? Buffer.from(obj.advIdentity, 'base64')
      : null
  };
}

function saveStore(store, filePath) {
  // MAIN FIX: avoid crashing when called with undefined/null store
  if (!store) {
    _whaWarn('saveStore: called with empty store, skipping write for ' + filePath);
    return;
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const json = storeToJson(store);
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
}

function loadStore(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  return storeFromJson(JSON.parse(raw));
}

// ─────────────────────────────────────────────────────────
// Six-parts format
// ─────────────────────────────────────────────────────────

function toSixParts(store) {
  if (!store) {
    throw new Error('toSixParts: store is undefined or null');
  }

  const normalizedPhone = store.phoneNumber
    ? String(store.phoneNumber).replace(/^\+/, '')
    : '';

  return [
    normalizedPhone,
    store.noiseKeyPair.public.toString('base64'),
    store.noiseKeyPair.private.toString('base64'),
    store.identityKeyPair.public.toString('base64'),
    store.identityKeyPair.private.toString('base64'),
    store.identityId.toString('base64')
  ].join(',');
}

function fromSixParts(sixParts) {
  const parts = sixParts.replace(/\s+/g, '').split(',');
  if (parts.length !== 6) throw new Error('Invalid six parts — expected 6 comma-separated values');

  const phoneNumber    = parts[0].replace(/^\+/, '');
  const noisePublic    = Buffer.from(parts[1], 'base64');
  const noisePrivate   = Buffer.from(parts[2], 'base64');
  const identPublic    = Buffer.from(parts[3], 'base64');
  const identPrivate   = Buffer.from(parts[4], 'base64');
  const identityId     = Buffer.from(parts[5], 'base64');

  // Regenerate signed pre-key from identity key pair
  const spkPair = generateKeyPair();
  const sig     = sign(identPrivate, spkPair.public);

  return {
    phoneNumber,
    noiseKeyPair:    { private: noisePrivate, public: noisePublic },
    identityKeyPair: { private: identPrivate, public: identPublic },
    signedPreKey: {
      id:        1,
      public:    spkPair.public,
      private:   spkPair.private,
      signature: sig
    },
    registrationId: (crypto.randomBytes(2).readUInt16BE(0) & 0x3fff) + 1,
    fdid:           uuidv4(),
    deviceId:       crypto.randomBytes(16),
    identityId,
    advertisingId:  uuidv4(),
    backupToken:    crypto.randomBytes(20),
    registered:     true,
    name:           'User',
    version:        IOS_VERSION_FALLBACK,
    device:         getDeviceConfig(),
    advIdentity:    null
  };
}

module.exports = {
  createNewStore,
  saveStore,
  loadStore,
  toSixParts,
  fromSixParts,
  storeToJson,
  storeFromJson,
  generateKeyPair,
  sign,
  prefixPubKey,
  stripPubKeyPrefix
};
