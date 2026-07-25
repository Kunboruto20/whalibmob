'use strict';

const {
  IOS_DEVICE,
  IOS_DEVICE_PROFILES,
  ANDROID_DEVICE_PROFILES
} = require('./constants');

// Pre-build normalised lookup tables so that user-supplied profile keys in any
// separator style (underscores, dashes, spaces, or none) always resolve.
// Normalisation: lowercase, strip underscores / dashes / spaces.
function _normalise(s) { return String(s).toLowerCase().replace(/[\s_-]/g, ''); }

const _IOS_MAP     = {};
const _ANDROID_MAP = {};
for (const k of Object.keys(IOS_DEVICE_PROFILES))     _IOS_MAP[_normalise(k)]     = IOS_DEVICE_PROFILES[k];
for (const k of Object.keys(ANDROID_DEVICE_PROFILES)) _ANDROID_MAP[_normalise(k)] = ANDROID_DEVICE_PROFILES[k];

// ─────────────────────────────────────────────────────────────────────────────
// DeviceConfig — reads environment variables and returns the active device
// profile to be used during registration and connection.
//
// Priority order:
//   1. WA_OS + WA_DEVICE  → pick a named predefined profile
//   2. WA_OS + individual WA_DEVICE_* vars → build a custom profile
//   3. No env vars → default iOS (iPhone 15 Pro)
//
// Env variables:
//   WA_OS                  ios | android                (default: ios)
//   WA_DEVICE              profile key (e.g. samsung-s24-ultra, pixel8, iphone14)
//   WA_DEVICE_MODEL        device display name
//   WA_DEVICE_MANUFACTURER Apple | Samsung | Google …
//   WA_DEVICE_OS_VERSION   OS version string (e.g. 17.4.1 or 14)
//   WA_DEVICE_BUILD        OS build number
//   WA_DEVICE_MODEL_ID     internal model identifier (e.g. SM-S928B, iPhone16,1)
//   WA_VERSION             override WhatsApp version (skips live fetch if set)
//   WA_STATIC_TOKEN        override static registration token
// ─────────────────────────────────────────────────────────────────────────────

function getDeviceConfig() {
  const osType = (process.env.WA_OS || 'ios').toLowerCase().trim();

  if (osType === 'android') {
    const profileKey = _normalise(process.env.WA_DEVICE || 'samsungs24ultra');
    const found = _ANDROID_MAP[profileKey] || null;
    if (found) {
      return Object.assign({}, found);
    }

    return {
      os:              'android',
      platform:        3,
      model:           process.env.WA_DEVICE_MODEL        || 'Samsung Galaxy S24 Ultra',
      manufacturer:    process.env.WA_DEVICE_MANUFACTURER || 'Samsung',
      osVersion:       process.env.WA_DEVICE_OS_VERSION   || '14',
      osBuildNumber:   process.env.WA_DEVICE_BUILD        || 'UP1A.231005.007',
      modelId:         process.env.WA_DEVICE_MODEL_ID     || 'SM-S928B',
      deviceModelType: 2
    };
  }

  // iOS (default)
  const profileKey = _normalise(process.env.WA_DEVICE || 'iphone15pro');
  const found = _IOS_MAP[profileKey] || null;
  if (found) {
    return Object.assign({}, found);
  }

  return {
    os:              'ios',
    platform:        1,
    model:           process.env.WA_DEVICE_MODEL        || IOS_DEVICE.model,
    manufacturer:    process.env.WA_DEVICE_MANUFACTURER || IOS_DEVICE.manufacturer,
    osVersion:       process.env.WA_DEVICE_OS_VERSION   || IOS_DEVICE.osVersion,
    osBuildNumber:   process.env.WA_DEVICE_BUILD        || IOS_DEVICE.osBuildNumber,
    modelId:         process.env.WA_DEVICE_MODEL_ID     || IOS_DEVICE.modelId,
    deviceModelType: 2
  };
}

module.exports = { getDeviceConfig };
