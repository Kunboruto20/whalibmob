'use strict';

// ClientPayload encoders for the WhatsApp Web (companion) handshake.
//
// The mobile handshake in proto.js builds a payload around `username` and a
// phone-shaped UserAgent. A companion sends the same message type with a
// different set of fields: on its very first connection it carries
// devicePairingData — the registration bundle the account's primary device
// signs during pairing — and on every connection after that it carries the
// device index the server issued and asks to be caught up.
//
// Written by hand against the wire format for the same reason proto.js is:
// keeping the handshake independent of a protobuf runtime.

const crypto = require('crypto');

// ─── primitives ──────────────────────────────────────────────────────────────

function encodeVarint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

// username is a uint64 — the 32-bit helper above truncates long international
// numbers, so it gets its own encoder.
function encodeVarint64(value) {
  const out = [];
  let v = BigInt(value);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

function field(num, wireType, valueBytes) {
  return Buffer.concat([encodeVarint((num << 3) | wireType), valueBytes]);
}

function bytesField(num, buf)  { return field(num, 2, Buffer.concat([encodeVarint(buf.length), buf])); }
function stringField(num, str) { return bytesField(num, Buffer.from(String(str), 'utf8')); }
function varintField(num, n)   { return field(num, 0, encodeVarint(n)); }
function uint64Field(num, n)   { return field(num, 0, encodeVarint64(n)); }
function boolField(num, v)     { return varintField(num, v ? 1 : 0); }

// WhatsApp encodes registration ids and pre-key ids inside the pairing bundle
// as fixed-width big-endian byte strings, not as varints.
function encodeBigEndian(value, length) {
  length = length || 4;
  const buf = Buffer.alloc(length);
  for (let i = length - 1; i >= 0; i--) {
    buf[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return buf;
}

function stripKeyPrefix(pub) {
  if (pub && pub.length === 33 && pub[0] === 0x05) return pub.slice(1);
  return pub;
}

// ─── DeviceProps ─────────────────────────────────────────────────────────────
//
// How the companion describes itself to the primary. `os` and the platform type
// are what the account owner reads in the linked-devices list on their phone;
// historySyncConfig decides how much of the past the primary ships over once
// the link is established.

const PLATFORM_TYPE = {
  UNKNOWN: 0, CHROME: 1, FIREFOX: 2, IE: 3, OPERA: 4, SAFARI: 5, EDGE: 6,
  DESKTOP: 7, IPAD: 8, ANDROID_TABLET: 9, OHANA: 10, ALOHA: 11, CATALINA: 12,
  TCL_TV: 13, IOS_PHONE: 14, IOS_CATALYST: 15, ANDROID_PHONE: 16,
  ANDROID_AMBIGUOUS: 17, WEAR_OS: 18, AR_WRIST: 19, AR_DEVICE: 20, UWP: 21,
  VR: 22, CLOUD_API: 23, SMARTGLASSES: 24
};

function platformTypeFor(browserName) {
  const key = String(browserName || '').toUpperCase();
  if (key === 'ANDROID') return PLATFORM_TYPE.ANDROID_PHONE;
  return PLATFORM_TYPE[key] !== undefined ? PLATFORM_TYPE[key] : PLATFORM_TYPE.CHROME;
}

// DeviceProps.HistorySyncConfig
function encodeHistorySyncConfig(opts) {
  opts = opts || {};
  const parts = [
    varintField(3, opts.storageQuotaMb != null ? opts.storageQuotaMb : 10240),
    boolField(4, opts.inlineInitialPayloadInE2EeMsg !== false),
    boolField(6, !!opts.supportCallLogHistory),
    boolField(7, opts.supportBotUserAgentChatHistory !== false),
    boolField(8, opts.supportCagReactionsAndPolls !== false),
    boolField(9, opts.supportBizHostedMsg !== false),
    boolField(10, opts.supportRecentSyncChunkMessageCountTuning !== false),
    boolField(11, opts.supportHostedGroupMsg !== false),
    boolField(12, opts.supportFbidBotChatHistory !== false),
    boolField(14, opts.supportMessageAssociation !== false),
    boolField(15, !!opts.supportGroupHistory)
  ];
  if (opts.fullSyncDaysLimit)  parts.unshift(varintField(1, opts.fullSyncDaysLimit));
  if (opts.fullSyncSizeMbLimit) parts.unshift(varintField(2, opts.fullSyncSizeMbLimit));
  return Buffer.concat(parts);
}

// DeviceProps.AppVersion — the companion's own version, not the account's.
function encodeDevicePropsVersion(primary, secondary, tertiary) {
  return Buffer.concat([
    varintField(1, primary),
    varintField(2, secondary),
    varintField(3, tertiary)
  ]);
}

function encodeDeviceProps(opts) {
  opts = opts || {};
  return Buffer.concat([
    stringField(1, opts.os || 'Ubuntu'),
    bytesField(2, encodeDevicePropsVersion(10, 15, 7)),
    varintField(3, platformTypeFor(opts.browserName || 'Chrome')),
    boolField(4, !!opts.requireFullSync),
    bytesField(5, encodeHistorySyncConfig(opts.historySync))
  ]);
}

// ─── ClientPayload.UserAgent ─────────────────────────────────────────────────
//
// Platform 14 = WEB. Carries no phone identifiers at all — no real mcc/mnc, no
// device id, no phone id. That absence is part of what marks the connection as
// a companion rather than a primary.

const PLATFORM_WEB     = 14;
const PLATFORM_ANDROID = 0;

function encodeAppVersion(v) {
  return Buffer.concat([
    varintField(1, v[0]),
    varintField(2, v[1]),
    varintField(3, v[2])
  ]);
}

function encodeWebUserAgent(opts) {
  const version = opts.version || [2, 3000, 1];
  const browser = opts.browser || ['Ubuntu', 'Chrome', '120.0.0.0'];
  const isAndroid = String(browser[1] || '').toLowerCase().includes('android');
  return Buffer.concat([
    varintField(1, isAndroid ? PLATFORM_ANDROID : PLATFORM_WEB),
    bytesField(2, encodeAppVersion(version)),
    stringField(3, '000'),                                  // mcc
    stringField(4, '000'),                                  // mnc
    stringField(5, '0.1'),                                  // osVersion
    stringField(6, 'Desktop'),                              // manufacturer
    stringField(7, 'Desktop'),                              // device
    stringField(8, '0.1'),                                  // osBuildNumber
    varintField(10, 0),                                     // releaseChannel = RELEASE
    stringField(11, 'en'),                                  // localeLanguageIso6391
    stringField(12, String(opts.countryCode || 'US'))       // localeCountryIso31661Alpha2
  ]);
}

// ClientPayload.WebInfo — webSubPlatform (field 4), WEB_BROWSER = 0.
function encodeWebInfo() {
  return varintField(4, 0);
}

// ─── ClientPayload.DevicePairingRegistrationData ─────────────────────────────
//
// The bundle the primary device signs. eIdent is our identity public key, and
// the account signature returned in pair-success is made over it — that is the
// link between this companion and the account.
function encodeDevicePairingData(o) {
  return Buffer.concat([
    bytesField(1, o.eRegid),
    bytesField(2, o.eKeytype),
    bytesField(3, o.eIdent),
    bytesField(4, o.eSkeyId),
    bytesField(5, o.eSkeyVal),
    bytesField(6, o.eSkeySig),
    bytesField(7, o.buildHash),
    bytesField(8, o.deviceProps)
  ]);
}

// ─── ClientPayload ───────────────────────────────────────────────────────────
//
// Field numbers, straight off the schema:
//   1 username · 3 passive · 5 userAgent · 6 webInfo · 7 pushName
//   12 connectType · 13 connectReason · 18 device · 19 devicePairingData
//   33 pull

const CONNECT_TYPE_WIFI_UNKNOWN     = 1;
const CONNECT_REASON_USER_ACTIVATED = 1;

function commonWebPayload(opts) {
  const parts = [
    bytesField(5, encodeWebUserAgent(opts)),
    bytesField(6, encodeWebInfo()),
    varintField(12, CONNECT_TYPE_WIFI_UNKNOWN),
    varintField(13, CONNECT_REASON_USER_ACTIVATED)
  ];
  if (opts.pushName) parts.push(stringField(7, opts.pushName));
  return parts;
}

/**
 * First connection of a brand-new companion. There is no JID yet, so the
 * payload carries the pairing bundle; the server answers with a pair-device
 * (the QR path) or, once a pairing code has been requested and typed into the
 * phone, with a pair-success.
 */
function encodeCompanionRegisterPayload(opts) {
  const version   = opts.version || [2, 3000, 1];
  const buildHash = crypto.createHash('md5').update(version.join('.')).digest();

  const deviceProps = encodeDeviceProps({
    os:              (opts.browser && opts.browser[0]) || 'Ubuntu',
    browserName:     (opts.browser && opts.browser[1]) || 'Chrome',
    requireFullSync: !!opts.syncFullHistory,
    historySync:     opts.historySync
  });

  const pairing = encodeDevicePairingData({
    buildHash,
    deviceProps,
    eRegid:   encodeBigEndian(opts.registrationId, 4),
    eKeytype: Buffer.from([5]),
    eIdent:   stripKeyPrefix(opts.identityKeyPair.public),
    eSkeyId:  encodeBigEndian(opts.signedPreKey.id, 3),
    eSkeyVal: stripKeyPrefix(opts.signedPreKey.public),
    eSkeySig: opts.signedPreKey.signature
  });

  return Buffer.concat([
    ...commonWebPayload(opts),
    boolField(3, false),            // passive
    boolField(33, false),           // pull
    bytesField(19, pairing)         // devicePairingData
  ]);
}

/**
 * Every connection after pairing. `username` is the account's phone number and
 * `device` is the index the server assigned us; together they form the JID the
 * primary lists under Linked Devices.
 */
function encodeCompanionLoginPayload(opts) {
  return Buffer.concat([
    uint64Field(1, opts.username),
    ...commonWebPayload(opts),
    boolField(3, true),             // passive
    boolField(33, true),            // pull
    varintField(18, opts.device || 0)
  ]);
}

module.exports = {
  encodeCompanionRegisterPayload,
  encodeCompanionLoginPayload,
  encodeDeviceProps,
  encodeHistorySyncConfig,
  encodeBigEndian,
  platformTypeFor,
  PLATFORM_TYPE
};
