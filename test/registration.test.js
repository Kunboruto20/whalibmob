'use strict';

// Tests for the registration form shape. These assert the plaintext form
// parameters the client sends to /code and /register, aligning the request
// with the native mobile client so it is not fingerprinted by missing or
// surplus fields.

const assert = require('assert');
const { _internals } = require('../lib/Registration');
const { createNewStore } = require('../lib/Store');

const { buildPayload } = _internals;

function parseForm(str) {
  const out = {};
  for (const kv of str.split('&')) {
    const i = kv.indexOf('=');
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

function testBasePayloadHasAccessSessionId() {
  const store = createNewStore('4915511497658');
  const form = parseForm(buildPayload(store, '2.24.10.80', true, null));
  assert.ok(form.access_session_id, 'access_session_id present');
  assert.ok(form.access_session_id.length >= 20, 'access_session_id looks like a real id');
  assert.ok(form.cc && form.in && form.token, 'core fields still present');
  console.log('  ✓ base payload includes access_session_id');
}

function testAccessSessionIdStableAcrossCalls() {
  const store = createNewStore('4915511497658');
  const a = parseForm(buildPayload(store, '2.24.10.80', true, null)).access_session_id;
  const b = parseForm(buildPayload(store, '2.24.10.80', true, ['code', '123456'])).access_session_id;
  assert.strictEqual(a, b, 'access_session_id is stable across /code and /register');
  // ...but different registrations get different ids
  const other = parseForm(buildPayload(createNewStore('4915511497658'), '2.24.10.80', true, null)).access_session_id;
  assert.notStrictEqual(a, other, 'a fresh store gets a fresh id');
  console.log('  ✓ access_session_id is stable within a registration, fresh per store');
}

function testCodeParamsShape() {
  const store = createNewStore('4915511497658');
  const extra = [
    'method', 'sms',
    'sim_mcc', '262', 'sim_mnc', '01',
    'jailbroken', '0',
    'cellular_strength', '1',
  ];
  const form = parseForm(buildPayload(store, '2.24.10.80', true, extra));
  assert.strictEqual(form.jailbroken, '0', 'jailbroken=0 present');
  assert.strictEqual(form.method, 'sms', 'method present');
  assert.ok(!('reason' in form), 'empty reason field is not sent');
  console.log('  ✓ /code params include jailbroken and omit empty reason');
}

(() => {
  console.log('Registration form shape:');
  testBasePayloadHasAccessSessionId();
  testAccessSessionIdStableAcrossCalls();
  testCodeParamsShape();
  console.log('\nAll registration tests passed.');
})();
