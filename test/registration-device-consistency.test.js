'use strict';

// A registration session keeps one device identity from start to finish.
//
// The bug, straight out of a real log: /exist went out as
//   WhatsApp/2.26.34.74 Android/14 Device/Samsung-SM-S928B
// and /code, the very next request for the same number in the same run, as
//   WhatsApp/2.26.34.74 iOS/17.4.1 Device/iPhone 15 Pro
//
// The cause was the gate in deviceForRegistration: it only returned the stored
// device once `registered || codePending` was set. On the first /code of a
// session both are false, so the stored device (Android, loaded from the
// session file) was discarded and re-read from the environment — which, with no
// WA_OS set, defaults to iOS. /exist had already used the Android device, so the
// two requests disagreed. One number, two phones, in one flow.
//
// The fix freezes the device the session was created with. These tests pin that
// down across the paths a registration takes.

const test   = require('node:test');
const assert = require('node:assert/strict');

const Registration = require('../lib/Registration');
const { deviceForRegistration, registrationHeaders } = Registration._token;
const { createNewStore, storeToJson, storeFromJson } = require('../lib/Store');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// A store created under one environment, then round-tripped through disk, the
// way loadStore reads it back on a later run.
function sessionCreatedAs(env) {
  return withEnv(env, () => {
    const s = createNewStore('40756211903');
    return storeFromJson(JSON.parse(JSON.stringify(storeToJson(s))));
  });
}

const ua = (device) => registrationHeaders(device, '2.26.34.74')['User-Agent'];

// ─── the exact scenario from the log ─────────────────────────────────────────

test('an Android session loaded with no WA_OS stays Android at /code', () => {
  const store = sessionCreatedAs({ WA_OS: 'android' });
  assert.equal(store.device.os, 'android', 'the session was created as Android');

  // The run that reproduced the bug: WA_OS unset, so the environment default is
  // iOS. Before the fix this returned the iOS default and overwrote the store.
  withEnv({ WA_OS: undefined }, () => {
    const chosen = deviceForRegistration(store, {});
    assert.equal(chosen.os, 'android', 'the frozen device wins over the env default');
    assert.equal(chosen.modelId, 'SM-S928B');
  });
});

test('the /exist device and the /code device are the same object of truth', () => {
  const store = sessionCreatedAs({ WA_OS: 'android' });

  withEnv({ WA_OS: undefined }, () => {
    // /exist reads store.device directly (buildPayload: store.device || env).
    const existDevice = store.device;
    // /code reads whatever deviceForRegistration returns, which requestSmsCode
    // then writes back to store.device.
    const codeDevice = deviceForRegistration(store, {});

    assert.equal(existDevice.os, codeDevice.os);
    assert.equal(ua(existDevice), ua(codeDevice),
      'the two requests put the same User-Agent on the wire');
    assert.match(ua(codeDevice), /Android\/14 Device\/Samsung-SM-S928B/);
    assert.doesNotMatch(ua(codeDevice), /iPhone/);
  });
});

// ─── the freeze holds whichever way the mismatch runs ────────────────────────

test('an iOS session stays iOS even when WA_OS=android is set later', () => {
  const store = sessionCreatedAs({ WA_OS: undefined });   // default iOS
  assert.equal(store.device.os, 'ios');

  withEnv({ WA_OS: 'android' }, () => {
    const chosen = deviceForRegistration(store, {});
    assert.equal(chosen.os, 'ios', 'the session keeps the identity it was created with');
    assert.match(ua(chosen), /iOS\/.*Device\/iPhone/);
  });
});

test('a frozen device does not depend on codePending or registered', () => {
  const store = sessionCreatedAs({ WA_OS: 'android' });

  withEnv({ WA_OS: undefined }, () => {
    // The old gate keyed off exactly these two flags. Every combination must
    // now return the stored Android device.
    for (const [codePending, registered] of [[false, false], [true, false], [false, true], [true, true]]) {
      store.codePending = codePending;
      store.registered  = registered;
      assert.equal(deviceForRegistration(store, {}).os, 'android',
        `codePending=${codePending} registered=${registered}`);
    }
  });
});

// ─── retries and re-registration keep the identity ───────────────────────────

test('a second code request in the same run gets the same device', () => {
  const store = sessionCreatedAs({ WA_OS: 'android' });

  withEnv({ WA_OS: undefined }, () => {
    // requestSmsCode does `store.device = deviceForRegistration(...)`. Simulate
    // two passes (sms, then wa_old) and confirm the device never drifts.
    store.device = deviceForRegistration(store, {});
    const first = ua(store.device);
    store.codePending = true;              // first request marked the session
    store.device = deviceForRegistration(store, {});
    const second = ua(store.device);

    assert.equal(first, second, 'the retry is the same phone');
    assert.match(second, /Android/);
  });
});

test('re-registering after a reset re-reads the environment', () => {
  // Deleting the session file and starting over is the documented way to change
  // platform. A brand-new store with no device falls through to the env.
  withEnv({ WA_OS: 'android' }, () => {
    const bare = {};   // no .device at all
    assert.equal(deviceForRegistration(bare, {}).os, 'android');
  });
  withEnv({ WA_OS: undefined }, () => {
    const bare = {};
    assert.equal(deviceForRegistration(bare, {}).os, 'ios');
  });
});

// ─── both platforms are still supported ──────────────────────────────────────

test('Android stays Android and iOS stays iOS across a disk round-trip', () => {
  const android = sessionCreatedAs({ WA_OS: 'android' });
  const ios     = sessionCreatedAs({ WA_OS: undefined });

  // Whatever the ambient env is now, each keeps its own identity.
  withEnv({ WA_OS: 'ios' }, () => {
    assert.equal(deviceForRegistration(android, {}).os, 'android');
  });
  withEnv({ WA_OS: 'android' }, () => {
    assert.equal(deviceForRegistration(ios, {}).os, 'ios');
  });
});

test('a Business session stays Business', () => {
  const store = sessionCreatedAs({ WA_OS: 'android', WA_BUSINESS: '1' });
  assert.equal(store.device.business, true);

  withEnv({ WA_OS: 'android', WA_BUSINESS: undefined }, () => {
    assert.equal(deviceForRegistration(store, {}).business, true,
      'WA_BUSINESS=0 does not downgrade a session that already registered as Business');
  });
});

test('the mismatch note is reported through onProgress, once, without changing the device', () => {
  const store = sessionCreatedAs({ WA_OS: 'android' });
  const notes = [];

  withEnv({ WA_OS: undefined }, () => {
    const chosen = deviceForRegistration(store, { onProgress: (m) => notes.push(m) });
    assert.equal(chosen.os, 'android');
    assert.ok(notes.some(n => /started as android/.test(n)), 'it explains why WA_OS was ignored');
  });
});
