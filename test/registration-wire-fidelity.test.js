'use strict';

// Wire fidelity of the registration POST, against the live WhatsApp Android
// capture (WA_REVERSE_2026):
//   • the 50/49 parameters go out in the native client's fixed insertion order;
//   • the request headers match the native set — no Accept, gzip advertised,
//     Keep-Alive, and an UPPERCASE request_token;
//   • a gzip response body is transparently inflated.

const test   = require('node:test');
const assert = require('node:assert/strict');
const zlib   = require('zlib');

const Registration = require('../lib/Registration');
const { buildPayload, registrationHeaders } = Registration._token;
const { getRequestVerificationCodeParameters, getRegisterDeviceParameters } = Registration._verify;
const { decodeBody, reorderRegistrationPairs } = Registration._http;
const { createNewStore } = require('../lib/Store');

const ANDROID = {
  os: 'android', osVersion: '14', manufacturer: 'Samsung',
  model: 'Samsung Galaxy S24 Ultra', modelId: 'SM-S928B', ram: '11.55'
};
const META = { lg: 'en', lc: 'GB', mcc: '234', mnc: '15' };

// The live orders captured from WhatsApp Android.
const CODE_DOC = ['method','backup_token','_gs','sim_mnc','id','mnc','_gg','network_radio_type','lg','rc','pid','_ge','cellular_strength','gpia','hasinrc','aid','mcc','_gp','hasav','device_ram','db','sim_type','prefer_sms_over_flash','access_session_id','sim_mcc','roaming_type','mistyped','airplane_mode_type','e_ident','e_skey_sig','entrypoint','token','in','expid','simnum','cc','education_screen_displayed','e_skey_val','authkey','e_keytype','e_regid','client_metrics','_gi','e_skey_id','feo2_query_status','reason','fdid','recaptcha','_ga','lc'];
const REG_DOC = ['code','backup_token','sim_mnc','_gs','id','device_ram','db','_gg','sim_operator_name','passkey_login_status','lg','rc','network_radio_type','pid','_ge','cellular_strength','gpia','hasinrc','aid','network_operator_name','mcc','_gp','mnc','entered','access_session_id','sim_mcc','roaming_type','mistyped','airplane_mode_type','has_play_store','sim_type','e_ident','e_skey_sig','entrypoint','in','expid','simnum','cc','e_skey_val','authkey','e_keytype','e_regid','_gi','client_metrics','e_skey_id','fdid','recaptcha','_ga','lc'];

const keysOf = (body) => body.split('&').map(p => p.split('=')[0]);

async function withNoPush(fn) {
  const prev = process.env.WA_FCM_PUSH;
  process.env.WA_FCM_PUSH = '0';
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.WA_FCM_PUSH; else process.env.WA_FCM_PUSH = prev; }
}

test('/code sends its documented fields in the exact native order', async () => {
  await withNoPush(async () => {
    const store = createNewStore('447737210946');
    store.device = { ...ANDROID };
    const extra = getRequestVerificationCodeParameters(store, 'sms', META, store.device, 7);
    const body  = await buildPayload(store, '2.26.41.77', false, extra, '/code');
    const keys  = keysOf(body);

    const present      = CODE_DOC.filter(k => keys.includes(k));
    const inBodyOrder  = keys.filter(k => CODE_DOC.includes(k));
    assert.deepEqual(inBodyOrder, present, 'documented /code fields are out of order');

    // The order is a prefix of the body: documented fields come first, extras
    // (push_token and build-specific keys) trail.
    const firstExtra = keys.findIndex(k => !CODE_DOC.includes(k));
    if (firstExtra !== -1) {
      assert.ok(keys.slice(firstExtra).every(k => !CODE_DOC.includes(k)),
        'a documented field appears after a trailing extra');
    }
  });
});

test('/register sends its documented fields in the exact native order', async () => {
  await withNoPush(async () => {
    const store = createNewStore('447737210946');
    store.device = { ...ANDROID };
    store.codeMethod = 'sms';
    const extra = ['code','123456','sim_operator_name','','passkey_login_status','not_attempted',
      'network_operator_name','','entered','1','has_play_store','true','entrypoint','suma',
      ...getRegisterDeviceParameters(store, META, store.device)];
    const body = await buildPayload(store, '2.26.41.77', false, extra, '/register');
    const keys = keysOf(body);

    const present     = REG_DOC.filter(k => keys.includes(k));
    const inBodyOrder = keys.filter(k => REG_DOC.includes(k));
    assert.deepEqual(inBodyOrder, present, 'documented /register fields are out of order');
  });
});

test('reorder leaves non-Android and non-registration endpoints untouched', () => {
  const pairs = ['b', '2', 'a', '1'];
  assert.deepEqual(reorderRegistrationPairs(pairs, '/code', { os: 'ios' }), pairs);
  assert.deepEqual(reorderRegistrationPairs(pairs, '/client_log', { os: 'android' }), pairs);
});

test('the registration headers match the native Android set', () => {
  const h = registrationHeaders(ANDROID, '2.26.41.77');
  assert.equal(h.Accept, undefined);               // the native client sends none
  assert.equal(h['Accept-Encoding'], 'gzip');
  assert.equal(h.Connection, 'Keep-Alive');
  assert.equal(h.WaMsysRequest, '1');
  assert.equal(h['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(h.request_token, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    'request_token must be an UPPERCASE UUID');
});

test('a gzip response body is inflated; anything else passes through', () => {
  const payload = Buffer.from('{"status":"ok"}', 'utf8');
  const gz = zlib.gzipSync(payload);
  assert.equal(decodeBody(gz, 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n').toString('utf8'), '{"status":"ok"}');
  // No content-encoding → returned as-is.
  assert.equal(decodeBody(payload, 'HTTP/1.1 200 OK\r\n').toString('utf8'), '{"status":"ok"}');
  // Header claims gzip but the body is not gzip → falls back to the raw bytes.
  assert.equal(decodeBody(payload, 'content-encoding: gzip\r\n').toString('utf8'), '{"status":"ok"}');
});
