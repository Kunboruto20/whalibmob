'use strict';

const {
  IOS_DEVICE,
  IOS_DEVICE_PROFILES,
  ANDROID_DEVICE_PROFILES,
  PLATFORM
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

// WA_BUSINESS selects the WhatsApp Business build. It rides on top of the
// device profile rather than replacing it — the same handsets exist for both
// apps — and only changes which platform the profile announces, which package
// the token material is read from, and which store the version comes from.
function _wantsBusiness() {
  const v = String(process.env.WA_BUSINESS || '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function getDeviceConfig() {
  const osType   = (process.env.WA_OS || 'ios').toLowerCase().trim();
  const business = _wantsBusiness();

  if (osType === 'android') {
    const profileKey = _normalise(process.env.WA_DEVICE || 'samsungs24ultra');
    const found = _ANDROID_MAP[profileKey] || null;
    if (found) {
      const picked = Object.assign({}, found, business
        ? { business: true, platform: PLATFORM.ANDROID_BUSINESS }
        : { business: false });
      // A named profile carries the handset's own RAM; WA_DEVICE_RAM overrides
      // it for someone running the same model in a different memory variant.
      if (process.env.WA_DEVICE_RAM) picked.ram = process.env.WA_DEVICE_RAM;
      return picked;
    }

    return {
      os:              'android',
      business,
      platform:        business ? PLATFORM.ANDROID_BUSINESS : PLATFORM.ANDROID,
      model:           process.env.WA_DEVICE_MODEL        || 'Samsung Galaxy S24 Ultra',
      manufacturer:    process.env.WA_DEVICE_MANUFACTURER || 'Samsung',
      osVersion:       process.env.WA_DEVICE_OS_VERSION   || '14',
      osBuildNumber:   process.env.WA_DEVICE_BUILD        || 'UP1A.231005.007',
      modelId:         process.env.WA_DEVICE_MODEL_ID     || 'SM-S928B',
      // What the handset reports as usable RAM, in GiB. Registration sends it,
      // and it has to belong to the handset beside it — see deviceRam().
      ram:             process.env.WA_DEVICE_RAM          || '11.55',
      deviceModelType: 2
    };
  }

  // iOS (default)
  const profileKey = _normalise(process.env.WA_DEVICE || 'iphone15pro');
  const found = _IOS_MAP[profileKey] || null;
  if (found) {
    return Object.assign({}, found, business
      ? { business: true, platform: PLATFORM.IOS_BUSINESS }
      : { business: false });
  }

  return {
    os:              'ios',
    business,
    platform:        business ? PLATFORM.IOS_BUSINESS : PLATFORM.IOS,
    model:           process.env.WA_DEVICE_MODEL        || IOS_DEVICE.model,
    manufacturer:    process.env.WA_DEVICE_MANUFACTURER || IOS_DEVICE.manufacturer,
    osVersion:       process.env.WA_DEVICE_OS_VERSION   || IOS_DEVICE.osVersion,
    osBuildNumber:   process.env.WA_DEVICE_BUILD        || IOS_DEVICE.osBuildNumber,
    modelId:         process.env.WA_DEVICE_MODEL_ID     || IOS_DEVICE.modelId,
    deviceModelType: 2
  };
}

module.exports = { getDeviceConfig };
