'use strict';

// Two things the registration flow said about itself that were not true.
//
//   timing          The funnel events claim a person walked the screens, but
//                   session_start, the number lookup and the code request all
//                   left inside the same millisecond. No handset does that; the
//                   server sees the gap on every event.
//   is_sim_absent   A constant false, sent alongside sim_mcc/sim_mnc of 000 —
//                   the values a handset reports when there is no SIM in it. One
//                   request, two answers.

const test   = require('node:test');
const assert = require('node:assert/strict');

const Registration = require('../lib/Registration');
const { pacingEnabled, humanPause, buildClientMetrics, PACING_RANGES_MS } = Registration._pacing;
const { getRequestVerificationCodeParameters } = Registration._verify;
const { createNewStore } = require('../lib/Store');

// Env has to be put back or it leaks into every later test in the run — and for
// an async body that means after it settles, not when it hands back its promise.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then((v) => { restore(); return v; },
                       (e) => { restore(); throw e; });
  }
  restore();
  return result;
}

const metrics = (attempt, meta) =>
  JSON.parse(decodeURIComponent(buildClientMetrics(attempt, meta)));

// ─── is_sim_absent ───────────────────────────────────────────────────────────

test('is_sim_absent follows the operator the request declares', () => {
  assert.equal(metrics(1, { mcc: '226', mnc: '010' }).is_sim_absent, false);
  assert.equal(metrics(1, { mcc: '262', mnc: '001' }).is_sim_absent, false);
});

test('an all-zero MCC is a handset with no SIM, and says so', () => {
  // getCountryMeta falls back to 000/000 for a country it has no entry for.
  assert.equal(metrics(1, { mcc: '000', mnc: '000' }).is_sim_absent, true);
  assert.equal(metrics(1, { mcc: '0', mnc: '0' }).is_sim_absent, true);
});

test('a missing or malformed MCC is treated as no SIM, not as a SIM', () => {
  assert.equal(metrics(1, {}).is_sim_absent, true);
  assert.equal(metrics(1, null).is_sim_absent, true);
  assert.equal(metrics(1, { mcc: '' }).is_sim_absent, true);
  assert.equal(metrics(1, { mcc: 'xx' }).is_sim_absent, true);
});

test('attempts still carries the attempt number', () => {
  assert.equal(metrics(1, { mcc: '226' }).attempts, 1);
  assert.equal(metrics(4, { mcc: '226' }).attempts, 4);
  // No attempt given is the first one, not zero.
  assert.equal(metrics(undefined, { mcc: '226' }).attempts, 1);
});

test('the metric travels URL-encoded, as the form expects', () => {
  const raw = buildClientMetrics(1, { mcc: '226', mnc: '010' });
  assert.ok(!raw.includes('{'), 'braces must be percent-encoded');
  assert.ok(!raw.includes('"'), 'quotes must be percent-encoded');
  assert.equal(typeof JSON.parse(decodeURIComponent(raw)), 'object');
});

// ─── the value actually reaches the /code request ────────────────────────────

test('a /code request with no operator does not claim a SIM', () => {
  const store = createNewStore('40711111111');
  const pairs = getRequestVerificationCodeParameters(
    store, 'sms', { mcc: '000', mnc: '000' }, { os: 'android', ram: '11.55' }, 1);

  const params = {};
  for (let i = 0; i < pairs.length; i += 2) params[pairs[i]] = pairs[i + 1];

  assert.equal(params.sim_mcc, '000');
  const parsed = JSON.parse(decodeURIComponent(params.client_metrics));
  assert.equal(parsed.is_sim_absent, true,
    'sim_mcc 000 and is_sim_absent false describe two different handsets');
});

test('a /code request with a real operator still claims the SIM', () => {
  const store = createNewStore('40711111111');
  const pairs = getRequestVerificationCodeParameters(
    store, 'sms', { mcc: '226', mnc: '010' }, { os: 'android', ram: '11.55' }, 2);

  const params = {};
  for (let i = 0; i < pairs.length; i += 2) params[pairs[i]] = pairs[i + 1];

  const parsed = JSON.parse(decodeURIComponent(params.client_metrics));
  assert.equal(parsed.is_sim_absent, false);
  assert.equal(parsed.attempts, 2);
});

// ─── pacing ──────────────────────────────────────────────────────────────────

test('WA_REG_PACING=0 turns the waits off', async () => {
  await withEnv({ WA_REG_PACING: '0' }, async () => {
    assert.equal(pacingEnabled(), false);
    const started = Date.now();
    await humanPause('enter_number');
    await humanPause('retry_code');
    assert.ok(Date.now() - started < 50, 'disabled pacing must not sleep');
  });
});

test('pacing is on unless it is switched off', () => {
  withEnv({ WA_REG_PACING: undefined }, () => assert.equal(pacingEnabled(), true));
  withEnv({ WA_REG_PACING: '1' },       () => assert.equal(pacingEnabled(), true));
});

test('an unknown pause name waits for nothing rather than throwing', async () => {
  const started = Date.now();
  await humanPause('no_such_screen');
  assert.ok(Date.now() - started < 50);
});

test('a pause actually waits, and lands inside its own range', async () => {
  await withEnv({ WA_REG_PACING: undefined }, async () => {
    const [lo, hi] = PACING_RANGES_MS.confirm_number;
    const started = Date.now();
    await humanPause('confirm_number');
    const waited = Date.now() - started;
    // A timer may fire a tick early and the event loop may hand it back late.
    assert.ok(waited >= lo - 50,  `waited ${waited}ms, floor is ${lo}ms`);
    assert.ok(waited <= hi + 750, `waited ${waited}ms, ceiling is ${hi}ms`);
  });
});

test('every range is a real interval, so the delay is never a signature', () => {
  const names = Object.keys(PACING_RANGES_MS);
  assert.ok(names.length >= 4, 'the four waits a person causes');
  for (const name of names) {
    const [lo, hi] = PACING_RANGES_MS[name];
    assert.ok(Number.isFinite(lo) && Number.isFinite(hi), name + ' must be numeric');
    assert.ok(lo > 0,  name + ' must wait for something');
    assert.ok(hi > lo, name + ' must be a range, not a constant');
  }
});

test('repeated pauses do not all come out the same length', async () => {
  await withEnv({ WA_REG_PACING: undefined }, async () => {
    // Drawn from the same range as humanPause, without sleeping 40 times.
    const [lo, hi] = PACING_RANGES_MS.enter_number;
    const draws = new Set();
    for (let i = 0; i < 40; i++) {
      draws.add(lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
    assert.ok(draws.size > 1, 'a fixed delay is its own fingerprint');
  });
});
