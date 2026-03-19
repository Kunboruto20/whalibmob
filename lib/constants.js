'use strict';

const WHATSAPP_HOST = 'g.whatsapp.net';
const WHATSAPP_PORT = 443;
const REGISTRATION_ENDPOINT = 'https://v.whatsapp.net/v2';
const REGISTRATION_PUBLIC_KEY = Buffer.from('8e8c0f74c3ebc5d7a6865c6c3c843856b06121cce8ea774d22fb6f122512302d', 'hex');

const MOBILE_PROLOGUE = Buffer.from([0x57, 0x41, 0x05, 0x03]);

// Static tokens used in WhatsApp registration token computation.
// token = MD5( staticToken + MD5hex(waVersion) + nationalNumber )
const IOS_STATIC_TOKEN          = '0a1mLfGUIBVrMKF1RdvLI5lkRBvof6vn0fD2QRSM';
const IOS_BUSINESS_STATIC_TOKEN = 'USUDuDYDeQhY4RF2fCSp5m3F6kJ1M2J8wS7bbNA2';
const ANDROID_STATIC_TOKEN      = 'Y29Cs6AVNR2bj5PBeKSYFd1nAKuvNQ3h';

// WhatsApp version fallbacks — used when live fetch fails.
const IOS_VERSION_FALLBACK     = '2.26.9.75';
const ANDROID_VERSION_FALLBACK = '2.24.13.80';

// Safari UA for the iTunes lookup only.
const IOS_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

// Default iOS device (iPhone 15 Pro, iOS 17.4.1).
// platform 1 = iOS in WhatsApp's ClientPayload.UserAgent proto enum.
const IOS_DEVICE = {
  os:              'ios',
  platform:        1,
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
    os: 'ios', platform: 1,
    model: 'iPhone 15 Pro', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone16,1', deviceModelType: 2
  },
  'iphone15': {
    os: 'ios', platform: 1,
    model: 'iPhone 15', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone15,4', deviceModelType: 2
  },
  'iphone14': {
    os: 'ios', platform: 1,
    model: 'iPhone 14', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone14,2', deviceModelType: 2
  },
  'iphone14pro': {
    os: 'ios', platform: 1,
    model: 'iPhone 14 Pro', manufacturer: 'Apple',
    osVersion: '17.4.1', osBuildNumber: '21E236',
    modelId: 'iPhone15,2', deviceModelType: 2
  },
  'iphone13': {
    os: 'ios', platform: 1,
    model: 'iPhone 13', manufacturer: 'Apple',
    osVersion: '16.7.8', osBuildNumber: '20H343',
    modelId: 'iPhone14,5', deviceModelType: 2
  },
  'iphone12': {
    os: 'ios', platform: 1,
    model: 'iPhone 12', manufacturer: 'Apple',
    osVersion: '15.8.3', osBuildNumber: '19H384',
    modelId: 'iPhone13,2', deviceModelType: 1
  }
};

// ─── Android device profiles ───────────────────────────────────────────────
// Set WA_OS=android  WA_DEVICE=<key>  in .env to select one.
// platform 3 = ANDROID in WhatsApp's ClientPayload.UserAgent proto enum.
const ANDROID_DEVICE_PROFILES = {
  'samsung-s24-ultra': {
    os: 'android', platform: 3,
    model: 'Samsung Galaxy S24 Ultra', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S928B', deviceModelType: 2
  },
  'samsung-s24': {
    os: 'android', platform: 3,
    model: 'Samsung Galaxy S24', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S921B', deviceModelType: 2
  },
  'samsung-s23': {
    os: 'android', platform: 3,
    model: 'Samsung Galaxy S23', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S911B', deviceModelType: 2
  },
  'samsung-s23-ultra': {
    os: 'android', platform: 3,
    model: 'Samsung Galaxy S23 Ultra', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-S918B', deviceModelType: 2
  },
  'samsung-a55': {
    os: 'android', platform: 3,
    model: 'Samsung Galaxy A55', manufacturer: 'Samsung',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'SM-A556B', deviceModelType: 1
  },
  'pixel8pro': {
    os: 'android', platform: 3,
    model: 'Pixel 8 Pro', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'Pixel 8 Pro', deviceModelType: 2
  },
  'pixel8': {
    os: 'android', platform: 3,
    model: 'Pixel 8', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'Pixel 8', deviceModelType: 2
  },
  'pixel7': {
    os: 'android', platform: 3,
    model: 'Pixel 7', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'TP1A.221005.002',
    modelId: 'Pixel 7', deviceModelType: 2
  },
  'pixel7a': {
    os: 'android', platform: 3,
    model: 'Pixel 7a', manufacturer: 'Google',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'Pixel 7a', deviceModelType: 1
  },
  'xiaomi14': {
    os: 'android', platform: 3,
    model: 'Xiaomi 14', manufacturer: 'Xiaomi',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: '23127PN0CG', deviceModelType: 2
  },
  'xiaomi13': {
    os: 'android', platform: 3,
    model: 'Xiaomi 13', manufacturer: 'Xiaomi',
    osVersion: '13', osBuildNumber: 'TQ3A.230901.001',
    modelId: '2211133G', deviceModelType: 2
  },
  'oneplus12': {
    os: 'android', platform: 3,
    model: 'OnePlus 12', manufacturer: 'OnePlus',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'CPH2573', deviceModelType: 2
  },
  'oneplus11': {
    os: 'android', platform: 3,
    model: 'OnePlus 11', manufacturer: 'OnePlus',
    osVersion: '13', osBuildNumber: 'TQ3A.230901.001',
    modelId: 'CPH2449', deviceModelType: 2
  },
  'oppo-find-x7': {
    os: 'android', platform: 3,
    model: 'OPPO Find X7', manufacturer: 'OPPO',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'CPH2599', deviceModelType: 2
  },
  'realme-gt5': {
    os: 'android', platform: 3,
    model: 'realme GT 5 Pro', manufacturer: 'realme',
    osVersion: '14', osBuildNumber: 'UP1A.231005.007',
    modelId: 'RMX3888', deviceModelType: 2
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
  IOS_STATIC_TOKEN,
  IOS_BUSINESS_STATIC_TOKEN,
  ANDROID_STATIC_TOKEN,
  IOS_VERSION_FALLBACK,
  ANDROID_VERSION_FALLBACK,
  IOS_USER_AGENT,
  IOS_DEVICE,
  IOS_DEVICE_PROFILES,
  ANDROID_DEVICE_PROFILES,
  SIGNAL_KEY_TYPE,
  RELEASE_CHANNEL,
  TAG
};
