'use strict';

// Three fields of the /code request that described something other than the
// phone the rest of the request declared.
//
// A registration payload is one statement about one handset. When two fields of
// it disagree, the payload is wrong in the same plain way a wrong os_version
// would be — it is not a matter of taste.
//
//   device_ram  was the constant 3.57 while the same request declared a Galaxy
//               S24 Ultra. No such handset exists: the S24 Ultra ships with
//               12 GB and no variant has ever had 3.57.
//   pid         was process.pid — the Node process. In a container that is 1,
//               and pid 1 on Android is init; no app process is ever 1.
//   sim_mcc/mnc named one operator per country and could not be told otherwise,
//               so every Romanian number registered as an Orange subscriber
//               whatever SIM was actually in the phone.

const test   = require('node:test');
const assert = require('node:assert/strict');

const Registration = require('../lib/Registration');
const { getCountryMeta, parsePhone } = Registration;
const { getRequestVerificationCodeParameters } = Registration._verify;
const { createNewStore, storeToJson, storeFromJson } = require('../lib/Store');
const { getDeviceConfig } = require('../lib/DeviceConfig');
const { ANDROID_DEVICE_PROFILES } = require('../lib/constants');

// The params come back as a flat name, value, name, value list.
function asObject(pairs) {
  const out = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
  return out;
}

const androidParams = (store, device, meta) => asObject(
  getRequestVerificationCodeParameters(
    store, 'sms', meta || { mcc: '226', mnc: '010' },
    device || { os: 'android', ram: '11.55' }, 1));

// Env has to be put back or it leaks into every later test in the run.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
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

// ─── device_ram ──────────────────────────────────────────────────────────────

test('device_ram is the declared handset\'s, not a constant', () => {
  const store = createNewStore('40711111111');

  assert.equal(androidParams(store, { os: 'android', ram: '11.55' }).device_ram, '11.55');
  assert.equal(androidParams(store, { os: 'android', ram: '7.53' }).device_ram, '7.53');
  assert.notEqual(androidParams(store, { os: 'android', ram: '7.53' }).device_ram, '3.57');
});

test('every named Android profile carries its own memory', () => {
  const keys = Object.keys(ANDROID_DEVICE_PROFILES);
  assert.ok(keys.length >= 15, 'the profiles are still there');

  for (const key of keys) {
    const p = ANDROID_DEVICE_PROFILES[key];
    assert.ok(p.ram, key + ' has no ram');
    const n = Number(p.ram);
    assert.ok(Number.isFinite(n) && n > 1 && n < 32, key + ' has an implausible ram: ' + p.ram);
  }
});

test('a phone that ships with 12 GB does not report 3.57', () => {
  // The specific contradiction this fixes.
  const ultra = ANDROID_DEVICE_PROFILES['samsung-s24-ultra'];
  assert.equal(ultra.modelId, 'SM-S928B');
  assert.ok(Number(ultra.ram) > 10, 'a 12 GB handset reports somewhere above 10');
});

test('the reported figure sits below the nominal one, as Android reports it', () => {
  // totalMem is what is left after the kernel, the GPU and the secure world
  // take their reservation, so it never lands on a round number.
  for (const p of Object.values(ANDROID_DEVICE_PROFILES)) {
    const n = Number(p.ram);
    assert.notEqual(n, Math.round(n), p.model + ' reports a suspiciously round ' + p.ram);
  }
});

test('device_ram is formatted to two decimals whatever the profile says', () => {
  const store = createNewStore('40711111111');
  assert.equal(androidParams(store, { os: 'android', ram: 8 }).device_ram, '8.00');
  assert.equal(androidParams(store, { os: 'android', ram: '7.5' }).device_ram, '7.50');
});

test('a profile with no memory falls back rather than sending nothing', () => {
  const store = createNewStore('40711111111');
  const ram = androidParams(store, { os: 'android' }).device_ram;
  assert.ok(Number(ram) > 1, 'still a plausible figure: ' + ram);
});

test('WA_DEVICE_RAM overrides a named profile, for a different memory variant', () => {
  withEnv({ WA_OS: 'android', WA_DEVICE: 'pixel8', WA_DEVICE_RAM: '5.62' }, () => {
    assert.equal(getDeviceConfig().ram, '5.62');
  });
  withEnv({ WA_OS: 'android', WA_DEVICE: 'pixel8', WA_DEVICE_RAM: undefined }, () => {
    assert.equal(getDeviceConfig().ram, '7.53', 'and the profile stands without it');
  });
});

// ─── pid ─────────────────────────────────────────────────────────────────────

test('pid is not the Node process id', () => {
  const store = createNewStore('40711111111');
  assert.notEqual(androidParams(store).pid, String(process.pid));
});

test('pid lands inside the range Android hands out', () => {
  // Android counts up from ~300 and wraps at pid_max, 32768 by default. 1 is
  // init and is what a containerised Node process would have sent.
  for (let i = 0; i < 200; i++) {
    const store = createNewStore('4071111' + String(1000 + i));
    const pid = Number(androidParams(store).pid);
    assert.ok(Number.isInteger(pid), 'an integer');
    assert.ok(pid >= 1024 && pid < 32768, 'out of range: ' + pid);
  }
});

test('pid does not change between the requests of one registration', () => {
  // /exist, /code and /register are three requests from one running app, and a
  // process does not change its pid between them.
  const store = createNewStore('40711111111');
  const first = androidParams(store).pid;
  assert.equal(androidParams(store).pid, first);
  assert.equal(androidParams(store).pid, first);
});

test('a restored session keeps the pid it had', () => {
  const store = createNewStore('40711111111');
  const before = androidParams(store).pid;

  const restored = storeFromJson(JSON.parse(JSON.stringify(storeToJson(store))));
  assert.equal(androidParams(restored).pid, before,
    'the app did not restart, so neither did its pid');
});

test('two different registrations do not share a pid by construction', () => {
  const a = androidParams(createNewStore('40711111111')).pid;
  const b = androidParams(createNewStore('40722222222')).pid;
  assert.notEqual(a, b);
});

// ─── sim_mcc / sim_mnc ───────────────────────────────────────────────────────

test('the country table still answers when nothing else is said', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    const meta = getCountryMeta('40');
    assert.equal(meta.mcc, '226');
    assert.equal(meta.mnc, '010');
    assert.equal(meta.lc, 'RO');
  });
});

test('the caller can name the SIM that is actually in the phone', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    // Vodafone Romania rather than the table's Orange.
    const meta = getCountryMeta('40', { simMcc: '226', simMnc: '01' });
    assert.equal(meta.mcc, '226');
    assert.equal(meta.mnc, '01');
    assert.equal(meta.lc, 'RO', 'the country keeps its language and locale');
    assert.equal(meta.lg, 'ro');
  });
});

test('either half can be given on its own', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    assert.equal(getCountryMeta('40', { simMnc: '03' }).mnc, '03');
    assert.equal(getCountryMeta('40', { simMnc: '03' }).mcc, '226', 'the other stands');
  });
});

test('WA_SIM_MCC and WA_SIM_MNC say the same thing from the environment', () => {
  withEnv({ WA_SIM_MCC: '234', WA_SIM_MNC: '15' }, () => {
    const meta = getCountryMeta('40');
    assert.equal(meta.mcc, '234');
    assert.equal(meta.mnc, '15');
  });
});

test('the MNC keeps the width it was given', () => {
  // 226/10 and 226/010 are different networks to the server; normalising one
  // into the other would break whichever it was not.
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    assert.equal(getCountryMeta('40', { simMnc: '10' }).mnc, '10');
    assert.equal(getCountryMeta('40', { simMnc: '010' }).mnc, '010');
  });
});

test('a store carries the declared SIM into the request', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    const store = createNewStore('40711111111', { simMcc: '226', simMnc: '05' });
    const { cc } = parsePhone(store.phoneNumber);
    const meta   = getCountryMeta(cc, store);

    assert.equal(meta.mnc, '05');
    const p = androidParams(store, { os: 'android', ram: '11.55' }, meta);
    assert.equal(p.sim_mnc, '05');
    assert.equal(p.mnc, '05', 'both the SIM and the network fields');
  });
});

test('a declared SIM survives being written down and read back', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    const store = createNewStore('40711111111', { simMcc: '226', simMnc: '05' });
    const back  = storeFromJson(JSON.parse(JSON.stringify(storeToJson(store))));
    assert.equal(getCountryMeta('40', back).mnc, '05');
  });
});

test('a store written before this existed simply keeps the table\'s guess', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    const store = createNewStore('40711111111');
    assert.equal(store.simMcc, null);
    assert.equal(getCountryMeta('40', store).mnc, '010');
  });
});

test('an unknown country still gets a shape the server can parse', () => {
  withEnv({ WA_SIM_MCC: undefined, WA_SIM_MNC: undefined }, () => {
    const meta = getCountryMeta('999');
    assert.equal(meta.mcc, '000');
    assert.equal(meta.mnc, '000');
  });
});
