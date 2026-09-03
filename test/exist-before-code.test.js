'use strict';

// requestSmsCode checks /exist before /code, the way the app does.
//
// The app never opens a registration with /code — it checks the account slot
// first, and that check is where the session-start and exist_check funnel
// events come from. The library used to leave that to the caller (only the CLI
// wired it), so a library consumer calling requestSmsCode directly produced a
// shape the app never does. These tests pin the order and the guards.
//
// The whole flow is driven with the network stubbed: https.request is replaced
// with a recorder that answers each endpoint from a canned table, so nothing
// leaves the machine and no number is touched. iOS is used as the platform
// because it needs no APK token material, which keeps the harness small.

const test   = require('node:test');
const assert = require('node:assert/strict');
const https  = require('node:https');
const { PassThrough } = require('node:stream');

const { createNewStore } = require('../lib/Store');
const { requestSmsCode } = require('../lib/Registration');

// Drive requestSmsCode with the network intercepted. `answers` maps a path
// fragment ('/exist', '/code') to the JSON object the server should return.
// Returns the ordered list of paths that were hit.
async function run(store, method, opts, answers) {
  const realRequest = https.request;
  const hits = [];

  https.request = function (reqOpts, cb) {
    const path = String(reqOpts.path || '');
    const chunks = [];
    const fake = {
      write() { return true; },
      end() {
        hits.push(path);
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = {};
        if (cb) cb(res);
        // Match the first answer whose key appears in the path.
        let body = { status: 'ok' };
        for (const key of Object.keys(answers)) {
          if (path.includes(key)) { body = answers[key]; break; }
        }
        res.end(JSON.stringify(body));
      },
      on() { return fake; },
      setTimeout() { return fake; },
      destroy() {}
    };
    return fake;
  };

  // Pin the version and platform so the flow does no APK / store fetch.
  const prevVersion = process.env.WA_VERSION;
  const prevOs      = process.env.WA_OS;
  const prevFunnel  = process.env.WA_FUNNEL_LOG;
  process.env.WA_VERSION    = '2.25.5.79';
  process.env.WA_OS         = 'ios';
  process.env.WA_FUNNEL_LOG = '0';   // keep the recorder to /exist and /code

  try {
    const result = await requestSmsCode(store, method, opts);
    return { hits, result };
  } catch (err) {
    // Carry the recorded paths on the error so a caller asserting "no /code was
    // sent" can read them even when the flow threw before returning.
    err.hits = hits;
    throw err;
  } finally {
    https.request = realRequest;
    if (prevVersion === undefined) delete process.env.WA_VERSION; else process.env.WA_VERSION = prevVersion;
    if (prevOs === undefined)      delete process.env.WA_OS;      else process.env.WA_OS = prevOs;
    if (prevFunnel === undefined)  delete process.env.WA_FUNNEL_LOG; else process.env.WA_FUNNEL_LOG = prevFunnel;
  }
}

// A fresh /exist answer: reason 'incorrect' means the keys are not registered.
const EXIST_FRESH = { status: 'fail', reason: 'incorrect' };
// A /code answer that says the code went out.
const CODE_SENT   = { status: 'sent', length: 6 };

const firstIndex = (hits, frag) => hits.findIndex(h => h.includes(frag));

// ─── the order ───────────────────────────────────────────────────────────────

test('a fresh registration checks /exist before /code', async () => {
  const store = createNewStore('40712345678', { name: 'Test' });
  const { hits } = await run(store, 'sms', {}, { '/exist': EXIST_FRESH, '/code': CODE_SENT });

  const iExist = firstIndex(hits, '/exist');
  const iCode  = firstIndex(hits, '/code');
  assert.ok(iExist >= 0, '/exist was called');
  assert.ok(iCode  >= 0, '/code was called');
  assert.ok(iExist < iCode, '/exist came before /code');
});

test('spent keys throw KEYS_ALREADY_REGISTERED, and /code is never reached', async () => {
  const store = createNewStore('40712345678', { name: 'Test' });
  // /exist that never says 'incorrect' → keys are taken.
  const err = await run(store, 'sms', {}, { '/exist': { status: 'ok' }, '/code': CODE_SENT })
    .then(() => null, e => e);

  assert.ok(err, 'it threw');
  assert.equal(err.code, 'KEYS_ALREADY_REGISTERED');
});

test('when keys are spent, no /code request is sent', async () => {
  // run() records every path it saw, even on the throw path, because the
  // recorder is filled as each request ends — not on return. So the hits list
  // is available whether requestSmsCode resolved or threw.
  const store = createNewStore('40712345678', { name: 'Test' });
  let hits = [];
  await run(store, 'sms', {}, { '/exist': { status: 'ok' }, '/code': CODE_SENT })
    .then(r => { hits = r.hits; }, e => { hits = e.hits || []; });

  assert.ok(hits.some(h => h.includes('/exist')), '/exist was reached');
  assert.ok(!hits.some(h => h.includes('/code')), 'no /code was sent for spent keys');
});

// ─── the guards ────────────────────────────────────────────────────────────

test('checkExist:false skips /exist entirely', async () => {
  const store = createNewStore('40712345678', { name: 'Test' });
  const { hits } = await run(store, 'sms', { checkExist: false }, { '/exist': EXIST_FRESH, '/code': CODE_SENT });

  assert.ok(!hits.some(h => h.includes('/exist')), '/exist was not called');
  assert.ok(hits.some(h => h.includes('/code')),   '/code was still called');
});

test('a store with codePending skips /exist', async () => {
  const store = createNewStore('40712345678', { name: 'Test' });
  store.codePending = true;   // a code was already requested on this store
  const { hits } = await run(store, 'sms', {}, { '/exist': EXIST_FRESH, '/code': CODE_SENT });

  assert.ok(!hits.some(h => h.includes('/exist')), '/exist was skipped');
  assert.ok(hits.some(h => h.includes('/code')),   '/code was called');
});

test('a registered store skips /exist', async () => {
  const store = createNewStore('40712345678', { name: 'Test' });
  store.registered = true;
  const { hits } = await run(store, 'sms', {}, { '/exist': EXIST_FRESH, '/code': CODE_SENT });

  assert.ok(!hits.some(h => h.includes('/exist')), '/exist was skipped');
});

// ─── the result still flows through ────────────────────────────────────────

test('the /code result is returned unchanged when keys are fresh', async () => {
  const store = createNewStore('40712345678', { name: 'Test' });
  const { result } = await run(store, 'sms', {}, { '/exist': EXIST_FRESH, '/code': CODE_SENT });
  assert.equal(result.status, 'sent');
});
