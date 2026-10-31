'use strict';

// On its first login the native client checks the general terms-of-service
// notice (id 20210210) right after <success>. The library now does the same,
// fire-and-forget: query the notice and accept it only if the server reports it
// outstanding. A fresh account is already accepted server-side, so the common
// path sends only the query.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { WhalibmobClient } = require('../lib/Client');

function makeClient(queryResult) {
  const calls = { queried: null, accepted: null };
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    queryTosNotices(ids) { calls.queried = ids; return Promise.resolve(queryResult); },
    acceptTosNotices(ids) { calls.accepted = ids; return Promise.resolve({ ok: true }); }
  });
  return { c, calls };
}

test('the first-login notice id matches the native client', () => {
  assert.equal(WhalibmobClient.FIRST_LOGIN_TOS_NOTICE, '20210210');
});

test('an already-accepted notice is only queried, never re-accepted', async () => {
  const { c, calls } = makeClient({ refresh: 86400, notices: [{ id: '20210210', accepted: true }] });
  c._acceptLoginTos();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.queried, ['20210210']);
  assert.equal(calls.accepted, null, 'no accept when already accepted');
});

test('an outstanding notice is accepted', async () => {
  const { c, calls } = makeClient({ refresh: null, notices: [{ id: '20210210', accepted: false }] });
  c._acceptLoginTos();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.queried, ['20210210']);
  assert.deepEqual(calls.accepted, ['20210210'], 'accepts the outstanding notice');
});

test('a query failure is swallowed, not thrown', async () => {
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    queryTosNotices() { return Promise.reject(new Error('IQ timed out')); },
    acceptTosNotices() { throw new Error('should not be called'); }
  });
  // Must not throw synchronously nor reject unhandled.
  assert.doesNotThrow(() => c._acceptLoginTos());
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
});
