'use strict';

// first_api_level — ro.product.first_api_level, the Android SDK the handset
// shipped with — must ride on the /code request and stay coherent with whatever
// device the caller emulates: pinned per profile, derived from osVersion for a
// custom build, overridable, and never leaking onto /register.

const test   = require('node:test');
const assert = require('node:assert/strict');

const Registration = require('../lib/Registration');
const { getRequestVerificationCodeParameters, getRegisterDeviceParameters } = Registration._verify;
const { ANDROID_DEVICE_PROFILES } = require('../lib/constants');
const { getDeviceConfig } = require('../lib/DeviceConfig');
const { createNewStore } = require('../lib/Store');

const META = { mcc: '226', mnc: '010' };

function asObject(pairs) {
  const out = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
  return out;
}

function codeFields(device) {
  const store = createNewStore('40711111111');
  return asObject(getRequestVerificationCodeParameters(store, 'sms', META, device, 3));
}

test('/code carries first_api_level for an Android device', () => {
  const fields = codeFields({ os: 'android', osVersion: '14', ram: '11.55' });
  assert.ok('first_api_level' in fields, 'first_api_level is missing from /code');
  assert.match(fields.first_api_level, /^\d+$/, 'first_api_level must be a bare integer');
});

test('every Android profile pins a plausible first_api_level', () => {
  for (const [name, profile] of Object.entries(ANDROID_DEVICE_PROFILES)) {
    assert.equal(typeof profile.firstApiLevel, 'number', `${name} has no firstApiLevel`);
    // Android 11 (30) through 15 (35) covers every shipping handset here.
    assert.ok(profile.firstApiLevel >= 30 && profile.firstApiLevel <= 35,
      `${name} firstApiLevel ${profile.firstApiLevel} out of range`);
    // The value the wire sends is exactly the profile's pin.
    const fields = codeFields(profile);
    assert.equal(fields.first_api_level, String(profile.firstApiLevel), name);
  }
});

test('first_api_level reflects the shipped SDK, not the current OS', () => {
  // The S23 Ultra ships on Android 13 (API 33) yet the profile now runs 14.
  const s23u = ANDROID_DEVICE_PROFILES['samsung-s23-ultra'];
  assert.equal(s23u.osVersion, '14');
  assert.equal(String(s23u.firstApiLevel), '33');
  assert.equal(codeFields(s23u).first_api_level, '33');

  // The S24 Ultra ships on Android 14 (API 34).
  assert.equal(codeFields(ANDROID_DEVICE_PROFILES['samsung-s24-ultra']).first_api_level, '34');
});

test('a custom device with no pin derives first_api_level from osVersion', () => {
  assert.equal(codeFields({ os: 'android', osVersion: '13', ram: '7.5' }).first_api_level, '33');
  assert.equal(codeFields({ os: 'android', osVersion: '12', ram: '7.5' }).first_api_level, '31');
  assert.equal(codeFields({ os: 'android', osVersion: '14.1', ram: '7.5' }).first_api_level, '34');
});

test('first_api_level falls back to 34 when nothing is known', () => {
  assert.equal(codeFields({ os: 'android', ram: '7.5' }).first_api_level, '34');
  assert.equal(codeFields({ os: 'android', osVersion: 'weird', ram: '7.5' }).first_api_level, '34');
});

test('an explicit firstApiLevel on the device wins over osVersion', () => {
  const fields = codeFields({ os: 'android', osVersion: '14', firstApiLevel: 30, ram: '7.5' });
  assert.equal(fields.first_api_level, '30');
});

test('WA_DEVICE_FIRST_API_LEVEL overrides the active profile', () => {
  const prevOs     = process.env.WA_OS;
  const prevDevice = process.env.WA_DEVICE;
  const prevApi    = process.env.WA_DEVICE_FIRST_API_LEVEL;
  process.env.WA_OS = 'android';
  process.env.WA_DEVICE = 'samsung-s24-ultra';
  process.env.WA_DEVICE_FIRST_API_LEVEL = '31';
  try {
    const device = getDeviceConfig();
    assert.equal(String(device.firstApiLevel), '31');
    assert.equal(codeFields(device).first_api_level, '31');
  } finally {
    if (prevOs === undefined) delete process.env.WA_OS; else process.env.WA_OS = prevOs;
    if (prevDevice === undefined) delete process.env.WA_DEVICE; else process.env.WA_DEVICE = prevDevice;
    if (prevApi === undefined) delete process.env.WA_DEVICE_FIRST_API_LEVEL; else process.env.WA_DEVICE_FIRST_API_LEVEL = prevApi;
  }
});

test('first_api_level stays off the /register device fields', () => {
  const store = createNewStore('40711111111');
  const reg   = asObject(getRegisterDeviceParameters(store, META, { os: 'android', osVersion: '14', ram: '11.55' }));
  assert.ok(!('first_api_level' in reg), 'first_api_level must not appear on /register');
});
