'use strict';

// What the Android app sends on /register beside the code: its device
// description again, with the values it sent on /code, and no setup token.

const test   = require('node:test');
const assert = require('node:assert/strict');

const Registration = require('../lib/Registration');
const { getRequestVerificationCodeParameters, getRegisterDeviceParameters, getInstallIdentity } = Registration._verify;
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

test('the install identity is the Android shape and belongs to the session', () => {
  const store = createNewStore('40711111111');
  const a = getInstallIdentity(store, { modelId: 'SM-S928B', osBuildNumber: 'UP1A.231005.007' }, 'com.whatsapp');
  const b = getInstallIdentity(storeFromJson(JSON.parse(JSON.stringify(storeToJson(store)))),
    { modelId: 'SM-S928B', osBuildNumber: 'UP1A.231005.007' }, 'com.whatsapp');

  assert.match(a.sourceDir, /^\/data\/app\/~~[A-Za-z0-9_-]{22}==\/com\.whatsapp-[A-Za-z0-9_-]{22}==\/base\.apk$/);
  assert.match(a.did, /^UP1A\.231005\.007\.S928BXXU[1-3][A-C]X[A-L][1-9]$/);
  assert.deepEqual(b, a);

  const pixel = getInstallIdentity(store, { modelId: 'Pixel 8', osBuildNumber: 'UP1A.231005.007' }, 'com.whatsapp');
  assert.match(pixel.did, /^UP1A\.231005\.007\.\d{8}$/);
});

test('_gi carries the ten keys in order, with the fixed library hashes', async () => {
  const crypto = require('crypto');
  const AndroidApk = require('../lib/AndroidApk');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const material = {
    packageName: 'com.whatsapp', secretKey: crypto.randomBytes(20),
    classesDexMd5: crypto.randomBytes(16), classesDexSha256: crypto.randomBytes(32),
    apkSize: 127447992, apkSha256Full: crypto.randomBytes(32),
    apkSha256First10M: crypto.randomBytes(32), certificates: [crypto.randomBytes(822)]
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gi-')), 'material.json');
  fs.writeFileSync(file, JSON.stringify(AndroidApk.materialToJson(material)));

  const saved = { push: process.env.WA_FCM_PUSH, mat: process.env.WA_ANDROID_APK_MATERIAL };
  process.env.WA_FCM_PUSH = '0';
  process.env.WA_ANDROID_APK_MATERIAL = file;
  try {
    const store = createNewStore('40711111111');
    store.device = { ...ANDROID, modelId: 'SM-S928B' };
    const body = await buildPayload(store, '2.26.35.75', false, null);
    const enc  = body.split('&').find(p => p.startsWith('_gi=')).slice(4);

    const pub = Buffer.from(store.noiseKeyPair.public);
    const raw = pub.length === 33 ? pub.subarray(1) : pub;
    const blob = Buffer.from(decodeURIComponent(enc), 'base64');
    const key  = crypto.createHash('sha256').update(raw.toString('base64')).digest();
    const d    = crypto.createDecipheriv('aes-256-cbc', key, blob.subarray(0, 16));
    const json = Buffer.concat([d.update(blob.subarray(16)), d.final()]).toString('utf8');
    const gi   = JSON.parse(json);

    assert.deepEqual(Object.keys(gi), ['_dh', '_iln', '_isb', '_ip', 'did', '_p', '_ln', '_ist', '_icr', '_is']);
    assert.equal(gi._iln, 'i7ls4vAnG2Bvmsp8NDKh7uREGcY4q8Hi4JtdCLix+Cc=');
    assert.equal(gi._ln,  'KMr1FDZ5Qv9UsYvUwaPmFmshuABXLq3rfxeELvAebKk=');
    assert.equal(gi._isb, '127447992');
    assert.equal(gi._dh,  material.classesDexSha256.toString('base64'));
    assert.equal(gi._icr, crypto.createHash('sha1').update(material.certificates[0]).digest('base64'));
    assert.ok(!/[^\\]\//.test(json), 'every / in the plaintext is escaped');
  } finally {
    for (const [k, v] of [['WA_FCM_PUSH', saved.push], ['WA_ANDROID_APK_MATERIAL', saved.mat]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
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
