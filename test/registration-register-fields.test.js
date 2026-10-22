'use strict';

// What the Android app sends on /register beside the code: its device
// description again, with the values it sent on /code, and no setup token.

const test   = require('node:test');
const assert = require('node:assert/strict');

const Registration = require('../lib/Registration');
const { getRequestVerificationCodeParameters, getRegisterDeviceParameters } = Registration._verify;
const { buildPayload } = Registration._token;
const { createNewStore, storeToJson, storeFromJson } = require('../lib/Store');

const ANDROID = { os: 'android', ram: '11.55', osBuildNumber: 'UP1A.231005.007' };
const META    = { mcc: '226', mnc: '010' };

function asObject(pairs) {
  const out = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
  return out;
}

test('/register repeats the /code device fields with the same values', () => {
  const store = createNewStore('40711111111');
  const code  = asObject(getRequestVerificationCodeParameters(store, 'sms', META, ANDROID, 3));
  const reg   = asObject(getRegisterDeviceParameters(store, META, ANDROID));

  const repeated = ['backup_token', 'sim_mnc', 'device_ram', 'db', 'network_radio_type',
    'pid', 'cellular_strength', 'hasinrc', 'aid', 'mcc', 'mnc', 'sim_mcc',
    'roaming_type', 'mistyped', 'airplane_mode_type', 'sim_type', 'simnum', 'recaptcha'];
  for (const k of repeated) assert.equal(reg[k], code[k], k);

  assert.deepEqual(Object.keys(reg).sort(), [...repeated, 'client_metrics'].sort());
});

test('/register restarts the client_metrics attempt counter at 0', () => {
  const store   = createNewStore('40711111111');
  const reg     = asObject(getRegisterDeviceParameters(store, META, ANDROID));
  const metrics = JSON.parse(decodeURIComponent(reg.client_metrics));
  assert.equal(metrics.attempts, 0);
});

test('an iOS /register gets no Android device fields', () => {
  const store = createNewStore('40711111111');
  assert.deepEqual(getRegisterDeviceParameters(store, META, { os: 'ios' }), []);
});

test('_ga and access_session_id survive between /code and /register', async () => {
  const prevPush = process.env.WA_FCM_PUSH;
  process.env.WA_FCM_PUSH = '0';
  try {
    const store = createNewStore('40711111111');
    store.device = ANDROID;
    const first = await buildPayload(store, '2.26.35.75', false, null);

    // The confirmation is normally a separate command that reloads the session.
    const reloaded = storeFromJson(JSON.parse(JSON.stringify(storeToJson(store))));
    reloaded.device = ANDROID;
    const second = await buildPayload(reloaded, '2.26.35.75', false, null);

    const pick = (body, k) => body.split('&').find(p => p.startsWith(k + '='));
    assert.ok(pick(first, '_ga'));
    assert.equal(pick(second, '_ga'), pick(first, '_ga'));
    assert.equal(pick(second, 'access_session_id'), pick(first, 'access_session_id'));
  } finally {
    if (prevPush === undefined) delete process.env.WA_FCM_PUSH;
    else process.env.WA_FCM_PUSH = prevPush;
  }
});
