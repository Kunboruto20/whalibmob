'use strict';

const WHATSAPP_HOST = 'g.whatsapp.net';
const WHATSAPP_PORT = 443;
const REGISTRATION_ENDPOINT = 'https://v.whatsapp.net/v2';
const REGISTRATION_PUBLIC_KEY = Buffer.from('8e8c0f74c3ebc5d7a6865c6c3c843856b06121cce8ea774d22fb6f122512302d', 'hex');

const MOBILE_PROLOGUE = Buffer.from([0x57, 0x41, 0x05, 0x03]);

// ─── WhatsApp Web (companion) transport ──────────────────────────────────────
//
// The mobile client speaks the same Noise handshake and the same binary node
// dictionary over a raw TLS socket to g.whatsapp.net. The web client speaks it
// over a WebSocket to web.whatsapp.com. The only wire-level differences are the
// prologue byte that announces which edition is talking (5 = mobile,
// 6 = web/multi-device) and the ClientPayload that rides inside the handshake.
const WEB_PROLOGUE   = Buffer.from([0x57, 0x41, 0x06, 0x03]);
const WEB_SOCKET_URL = 'wss://web.whatsapp.com/ws/chat';
const WEB_ORIGIN     = 'https://web.whatsapp.com';

// Version the companion announces.
//
// Not an App Store build like the mobile version — this is the web client's
// own revision, and the server is far less tolerant of it than the mobile
// endpoint is: an unrecognised revision is refused during the handshake with
// <failure reason="405">, before any stanza is exchanged. Keep it current, or
// let fetchWaWebVersion() read the live one.
const WEB_VERSION_FALLBACK = [2, 3000, 1035194821];

// [os, browser] pair. Decides the DeviceProps.platformType we register with and
// the name the account owner sees in the linked-devices list on their phone.
const WEB_BROWSER = ['Ubuntu', 'Chrome', '120.0.0.0'];

// Static tokens used in the iOS registration token computation.
// token = MD5( staticToken + MD5hex(waVersion) + nationalNumber )
//
// iOS only. Android has no static token at all — it signs the token with
// material out of its own APK (see AndroidApk.js), and the value that used to
// sit here as ANDROID_STATIC_TOKEN was this same iOS calculation with an
// invented constant in front of it, which the server refused as bad_token.
const IOS_STATIC_TOKEN          = '0a1mLfGUIBVrMKF1RdvLI5lkRBvof6vn0fD2QRSM';
const IOS_BUSINESS_STATIC_TOKEN = 'USUDuDYDeQhY4RF2fCSp5m3F6kJ1M2J8wS7bbNA2';

// WhatsApp version fallbacks — used when live fetch fails.
//
// These are announced to the server, which refuses a build it does not
// recognise, so a fallback that has gone stale is a connection that fails for a
// reason nothing in the error names. Keep them within a few releases of what
// the stores are actually serving; the live lookup is what normally decides.
const IOS_VERSION_FALLBACK     = '2.26.9.75';
const ANDROID_VERSION_FALLBACK = '2.26.31.77';

// Safari UA for the iTunes lookup only.
const IOS_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

// ─── ClientPayload.UserAgent.Platform ────────────────────────────────────────
//
// The enum the handshake announces the client with, straight off the schema:
//
//   ANDROID = 0   IOS = 1   WINDOWS_PHONE = 2   BLACKBERRY = 3   ...   WEB = 14
//
// The server validates the announced app version *against this platform*, so a
// wrong value here does not read as a wrong platform — it reads as an
// impossible version and comes back as <failure reason="405"> ("client
// outdated") before a single stanza is exchanged. Android sat on 3 (BlackBerry,
// a client WhatsApp stopped building in 2017) and every Android session was
// refused on connect with a version that was two weeks old, while iOS on 1 was
// correct and never saw a 405. Nothing in the failure says which field was
// wrong, which is what made it worth this many words.
//
// Anything that needs a platform number takes it from here.
const PLATFORM = {
  ANDROID:          0,
  IOS:              1,
  ANDROID_BUSINESS: 10,
  IOS_BUSINESS:     12,
  WEB:              14
};

// The platform an `os` string announces itself as. Unknown values fall back to
// iOS, which is what a session with no device profile has always been.
//
// The Business builds are their own platforms rather than a flag on top of the
// consumer ones: a WhatsApp Business account is registered, tokenised and
// announced as ANDROID_BUSINESS or IOS_BUSINESS from the first request, and
// mixing the two halves produces an account that neither app can open.
function platformForOs(os, business) {
  const android = String(os).toLowerCase() === 'android';
  if (business) return android ? PLATFORM.ANDROID_BUSINESS : PLATFORM.IOS_BUSINESS;
  return android ? PLATFORM.ANDROID : PLATFORM.IOS;
}

// Whether a stored platform number is one of the Business ones, so a session
// written before this existed keeps answering the same way.
function isBusinessPlatform(platform) {
  return platform === PLATFORM.ANDROID_BUSINESS || platform === PLATFORM.IOS_BUSINESS;
}

// The Play Store packages and the App Store bundle ids, per variant. The
// Android token material is read out of whichever APK the account is being
// registered as, and the two builds sign with different material entirely.
const WHATSAPP_PACKAGE          = 'com.whatsapp';
const WHATSAPP_BUSINESS_PACKAGE = 'com.whatsapp.w4b';
const IOS_BUNDLE_ID             = 'net.whatsapp.WhatsApp';
const IOS_BUSINESS_BUNDLE_ID    = 'net.whatsapp.WhatsAppSMB';

// A note on the `deviceModelType` numbers in the profiles below: nothing reads
// them. The proto's deviceModelType (field 16) is a string and is filled from
// `modelId`; the proto's deviceType (field 15) is the DeviceType enum, which is
// PHONE for every profile here. The numbers are left as they were found.

// Default iOS device (iPhone 15 Pro, iOS 17.4.1).
const IOS_DEVICE = {
  os:              'ios',
  platform:        PLATFORM.IOS,
  model:           'iPhone 15 Pro',
  manufacturer:    'Apple',
  osVersion:       '17.4.1',
  osBuildNumber:   '21E236',
  modelId:         'iPhone16,1',
  deviceModelType: 2
};

// ─── iOS device profiles ───────────────────────────────────────────────────
// Set WA_OS=ios  WA_DEVICE=<key>  in .env to select one.
const IOS_DEVICE_PROFILES = {
  'iphone15pro': {
    os: 'ios', platform: PLATFORM.IOS,
    model: 'iPhone 15 Pro', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone16,1', deviceModelType: 2
  },
  'iphone15': {
    os: 'ios', platform: PLATFORM.IOS,
    model: 'iPhone 15', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone15,4', deviceModelType: 2
  },
  'iphone14': {
    os: 'ios', platform: PLATFORM.IOS,
    model: 'iPhone 14', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone14,2', deviceModelType: 2
  },
  'iphone14pro': {
    os: 'ios', platform: PLATFORM.IOS,
    model: 'iPhone 14 Pro', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone15,2', deviceModelType: 2
  },
  'iphone13': {
    os: 'ios', platform: PLATFORM.IOS,
    model: 'iPhone 13', manufacturer: 'Apple',
    osVersion: '16.7.8', osBuildNumber: '20H343',
    modelId: 'iPhone14,5', deviceModelType: 2
  },
  'iphone12': {
    os: 'ios', platform: PLATFORM.IOS,
    model: 'iPhone 12', manufacturer: 'Apple',
    osVersion: '15.8.3', osBuildNumber: '19H384',
    modelId: 'iPhone13,2', deviceModelType: 1
  }
};

// ─── Android device profiles ───────────────────────────────────────────────
// Set WA_OS=android  WA_DEVICE=<key>  in .env to select one.
const ANDROID_DEVICE_PROFILES = {
  'samsung-s24-ultra': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Samsung Galaxy S24 Ultra', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S928B', deviceModelType: 2, ram: '11.55'
  },
  'samsung-s24': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Samsung Galaxy S24', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S921B', deviceModelType: 2, ram: '7.63'
  },
  'samsung-s23': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Samsung Galaxy S23', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S911B', deviceModelType: 2, ram: '7.63'
  },
  'samsung-s23-ultra': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Samsung Galaxy S23 Ultra', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S918B', deviceModelType: 2, ram: '11.55'
  },
  'samsung-a55': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Samsung Galaxy A55', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-A556B', deviceModelType: 1, ram: '7.44'
  },
  'pixel8pro': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Pixel 8 Pro', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'Pixel 8 Pro', deviceModelType: 2, ram: '11.44'
  },
  'pixel8': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Pixel 8', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'Pixel 8', deviceModelType: 2, ram: '7.53'
  },
  'pixel7': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Pixel 7', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'TP1A.221005.002',
    modelId: 'Pixel 7', deviceModelType: 2, ram: '7.53'
  },
  'pixel7a': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Pixel 7a', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'Pixel 7a', deviceModelType: 1, ram: '7.44'
  },
  'xiaomi14': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Xiaomi 14', manufacturer: 'Xiaomi',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: '23127PN0CG', deviceModelType: 2, ram: '11.36'
  },
  'xiaomi13': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'Xiaomi 13', manufacturer: 'Xiaomi',
    osVersion: '13', osBuildNumber: 'TQ3A.230901.001',
    modelId: '2211133G', deviceModelType: 2, ram: '7.51'
  },
  'oneplus12': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'OnePlus 12', manufacturer: 'OnePlus',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'CPH2573', deviceModelType: 2, ram: '11.48'
  },
  'oneplus11': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'OnePlus 11', manufacturer: 'OnePlus',
    osVersion: '13', osBuildNumber: 'TQ3A.230901.001',
    modelId: 'CPH2449', deviceModelType: 2, ram: '15.32'
  },
  'oppo-find-x7': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'OPPO Find X7', manufacturer: 'OPPO',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'CPH2599', deviceModelType: 2, ram: '11.40'
  },
  'realme-gt5': {
    os: 'android', platform: PLATFORM.ANDROID,
    model: 'realme GT 5 Pro', manufacturer: 'realme',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'RMX3888', deviceModelType: 2, ram: '15.28'
  }
};

const SIGNAL_KEY_TYPE  = 5;
const RELEASE_CHANNEL  = 0;

const TAG = {
  LIST_EMPTY:   0,
  STREAM_END:   2,
  DICTIONARY_0: 236,
  DICTIONARY_1: 237,
  DICTIONARY_2: 238,
  DICTIONARY_3: 239,
  AD_JID:       247,
  LIST_8:       248,
  LIST_16:      249,
  JID_PAIR:     250,
  HEX_8:        251,
  BINARY_8:     252,
  BINARY_20:    253,
  BINARY_32:    254,
  NIBBLE_8:     255
};

module.exports = {
  WHATSAPP_HOST,
  WHATSAPP_PORT,
  REGISTRATION_ENDPOINT,
  REGISTRATION_PUBLIC_KEY,
  MOBILE_PROLOGUE,
  WEB_PROLOGUE,
  WEB_SOCKET_URL,
  WEB_ORIGIN,
  WEB_VERSION_FALLBACK,
  WEB_BROWSER,
  IOS_STATIC_TOKEN,
  IOS_BUSINESS_STATIC_TOKEN,
  IOS_VERSION_FALLBACK,
  ANDROID_VERSION_FALLBACK,
  IOS_USER_AGENT,
  PLATFORM,
  platformForOs,
  isBusinessPlatform,
  WHATSAPP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
  IOS_BUNDLE_ID,
  IOS_BUSINESS_BUNDLE_ID,
  IOS_DEVICE,
  IOS_DEVICE_PROFILES,
  ANDROID_DEVICE_PROFILES,
  SIGNAL_KEY_TYPE,
  RELEASE_CHANNEL,
  TAG
};
