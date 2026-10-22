'use strict';

// Two registration details that have to agree with a real handset:
//   _gp — the SHA-256 of the manifest permission list, computed from the APK
//         itself rather than pinned, with the Android-12+ normalization that
//         drops the legacy BLUETOOTH permission.
//   the SIM fields — sim_type, simnum and the operator codes, which must all
//         tell one story: a SIM is present, or it is not.

const test   = require('node:test');
const assert = require('node:assert/strict');

const AndroidApk    = require('../lib/AndroidApk');
const Registration  = require('../lib/Registration');
const { getRequestVerificationCodeParameters } = Registration._verify;

// The 85 requested permissions of WhatsApp 2.26.35.75 plus the legacy
// android.permission.BLUETOOTH the platform hands back beside them; Android 12+
// drops BLUETOOTH when BLUETOOTH_CONNECT is present, leaving the 85 that hash to
// the value captured on the wire.
const PERMS_86 = [
  "android.permission.RECEIVE_SMS", "android.permission.ACCESS_NETWORK_STATE", "android.permission.AUTHENTICATE_ACCOUNTS",
  "android.permission.GET_ACCOUNTS", "android.permission.FOREGROUND_SERVICE_DATA_SYNC", "android.permission.VIBRATE",
  "android.permission.RECEIVE_BOOT_COMPLETED", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.CAMERA", "android.permission.RECORD_AUDIO", "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.DETECT_SCREEN_CAPTURE", "android.permission.INTERNET", "com.google.android.apps.aicore.service.BIND_SERVICE",
  "android.permission.BLUETOOTH_CONNECT", "android.permission.ACCESS_WIFI_STATE", "android.permission.CHANGE_WIFI_STATE",
  "android.permission.NEARBY_WIFI_DEVICES", "android.permission.READ_PHONE_STATE", "android.permission.READ_PHONE_NUMBERS",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE", "android.permission.FOREGROUND_SERVICE_CAMERA", "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "android.permission.FOREGROUND_SERVICE_PHONE_CALL", "android.permission.SCHEDULE_EXACT_ALARM", "android.permission.USE_BIOMETRIC",
  "android.permission.USE_FINGERPRINT", "com.android.vending.BILLING", "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.MANAGE_OWN_CALLS", "android.permission.CALL_PHONE", "android.permission.MODIFY_AUDIO_SETTINGS",
  "com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE", "android.permission.DETECT_SCREEN_RECORDING", "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "android.permission.ACCESS_MEDIA_LOCATION", "android.permission.BROADCAST_STICKY", "android.permission.CHANGE_NETWORK_STATE",
  "android.permission.FOREGROUND_SERVICE_LOCATION", "android.permission.GET_TASKS", "android.permission.INSTALL_SHORTCUT",
  "android.permission.MANAGE_ACCOUNTS", "android.permission.NFC", "android.permission.READ_CONTACTS",
  "android.permission.READ_BASIC_PHONE_STATE", "android.permission.READ_PROFILE", "android.permission.READ_SYNC_SETTINGS",
  "android.permission.READ_SYNC_STATS", "android.permission.SEND_SMS", "android.permission.USE_CREDENTIALS",
  "android.permission.WAKE_LOCK", "android.permission.WRITE_CONTACTS", "android.permission.READ_MEDIA_AUDIO",
  "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
  "android.permission.POST_NOTIFICATIONS", "android.permission.WRITE_SYNC_SETTINGS", "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.FOREGROUND_SERVICE", "android.permission.USE_FULL_SCREEN_INTENT", "com.android.launcher.permission.INSTALL_SHORTCUT",
  "com.android.launcher.permission.UNINSTALL_SHORTCUT", "com.google.android.c2dm.permission.RECEIVE", "com.google.android.gms.permission.AD_ID",
  "com.google.android.providers.gsf.permission.READ_GSERVICES", "com.sec.android.provider.badge.permission.READ", "com.sec.android.provider.badge.permission.WRITE",
  "com.htc.launcher.permission.READ_SETTINGS", "com.htc.launcher.permission.UPDATE_SHORTCUT", "com.sonyericsson.home.permission.BROADCAST_BADGE",
  "com.sonymobile.home.permission.PROVIDER_INSERT_BADGE", "com.huawei.android.launcher.permission.READ_SETTINGS", "com.huawei.android.launcher.permission.WRITE_SETTINGS",
  "com.huawei.android.launcher.permission.CHANGE_BADGE", "com.whatsapp.permission.BROADCAST", "com.whatsapp.permission.MAPS_RECEIVE",
  "com.whatsapp.permission.REGISTRATION", "com.whatsapp.sticker.READ", "android.permission.ANSWER_PHONE_CALLS",
  "android.permission.READ_CALL_LOG", "android.permission.RUN_USER_INITIATED_JOBS", "com.facebook.services.identity.FEO2",
  "com.whatsapp.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION", "android.permission.BLUETOOTH",
];

const GP_LIVE = 'XpccAx8EKQswlTL2MtpCnGIMXTCaUbAf95ElLECc6jk=';

test('permissionsHash reproduces the captured _gp value and drops legacy BLUETOOTH', () => {
  assert.equal(AndroidApk.permissionsHash(PERMS_86), GP_LIVE);

  // Order must not matter — the hash sorts first.
  const shuffled = PERMS_86.slice().reverse();
  assert.equal(AndroidApk.permissionsHash(shuffled), GP_LIVE);

  // Without BLUETOOTH_CONNECT the legacy BLUETOOTH is kept, so the hash differs.
  const noConnect = PERMS_86.filter(p => p !== 'android.permission.BLUETOOTH_CONNECT');
  assert.notEqual(AndroidApk.permissionsHash(noConnect), GP_LIVE);

  assert.equal(AndroidApk.permissionsHash([]), null);
  assert.equal(AndroidApk.permissionsHash(null), null);
});

test('material carries the permission hash through its JSON form', () => {
  const crypto = require('crypto');
  const material = {
    packageName: 'com.whatsapp', secretKey: crypto.randomBytes(20),
    classesDexMd5: crypto.randomBytes(16), certificates: [crypto.randomBytes(8)],
    gpHash: GP_LIVE
  };
  const round = AndroidApk.materialFromJson(AndroidApk.materialToJson(material));
  assert.equal(round.gpHash, GP_LIVE);
});

// ─── SIM consistency ─────────────────────────────────────────────────────────

function asObject(pairs) {
  const out = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
  return out;
}

const { createNewStore } = require('../lib/Store');

const androidParams = (meta) => asObject(getRequestVerificationCodeParameters(
  createNewStore('40711111111'), 'sms', meta, { os: 'android', ram: '11.55' }, 1));

test('a real operator code makes every SIM field say "present"', () => {
  const p = androidParams({ mcc: '226', mnc: '010' });
  assert.equal(p.sim_type, '1');
  assert.equal(p.simnum,   '1');
  assert.equal(p.sim_mcc,  '226');
  assert.equal(p.sim_mnc,  '010');
  assert.equal(p.mcc,      '226');
  assert.equal(p.mnc,      '010');
  assert.match(decodeURIComponent(p.client_metrics), /"is_sim_absent":false/);
});

test('a zero or missing operator code makes every SIM field say "absent"', () => {
  for (const meta of [{ mcc: '000', mnc: '000' }, {}, { mcc: 'xx' }]) {
    const p = androidParams(meta);
    assert.equal(p.sim_type, '0', JSON.stringify(meta));
    assert.equal(p.simnum,   '0', JSON.stringify(meta));
    assert.equal(p.sim_mcc,  '000', JSON.stringify(meta));
    assert.equal(p.sim_mnc,  '000', JSON.stringify(meta));
    assert.equal(p.mcc,      '000', JSON.stringify(meta));
    assert.equal(p.mnc,      '000', JSON.stringify(meta));
    assert.match(decodeURIComponent(p.client_metrics), /"is_sim_absent":true/);
  }
});
