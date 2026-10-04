'use strict';

// Reading a flash-call code out of the number that rang.
//
// A flash call delivers no code of its own: WhatsApp rings the handset from a
// one-time caller id and drops the call, and the code is embedded in that
// number. The /code reply says exactly how to read it — cli_filter is a regex
// isolating the code after cli_prefix, and `length` is how many digits it is.
//
// This used to assume the code was simply the last six digits of the caller id.
// That held only by accident, for a caller id whose code sat flush at the end.
// The live case that broke it is pinned below: an Italian +39 373 9799312 has
// seven digits after the "373" prefix, so a blind last-six took "799312" off a
// number the server had actually framed with its own filter — and a wrong slice
// is answered with "mismatch". The fields in these tests are the ones a real
// /code reply carried.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { applyFlashFilter, flashCodeFromCallerId, codeForSubmission } =
  require('../lib/Registration')._verify;

// The real values captured from a live flash /code reply.
const LIVE = {
  caller: '+39 373 9799312',
  filter: '(.*)373(.*)',
  length: 6,
  code:   '799312'
};

// ─── applyFlashFilter ────────────────────────────────────────────────────────

test('the filter isolates the digits after the prefix', () => {
  assert.equal(applyFlashFilter('393739799312', '(.*)373(.*)'), '9799312');
});

test('no filter, a bad regex, or no match all give null so the caller can fall back', () => {
  assert.equal(applyFlashFilter('393739799312', null), null);
  assert.equal(applyFlashFilter('393739799312', '('),  null, 'uncompilable');
  assert.equal(applyFlashFilter('123456', '(.*)999(.*)'), null, 'prefix not present');
});

test('the code is taken from the last capture group, not an earlier one', () => {
  // group 1 holds the country code, group 2 the tail after the prefix.
  assert.equal(applyFlashFilter('393739799312', '(39)(.*)373(.*)'), '9799312');
});

// ─── flashCodeFromCallerId with the server filter ────────────────────────────

test('the live case lands on the code the server expects, not a blind last six', () => {
  assert.equal(
    flashCodeFromCallerId(LIVE.caller, { length: LIVE.length, filter: LIVE.filter }),
    LIVE.code
  );
});

test('typing the whole number or just the code both reach the same code', () => {
  const opts = { length: LIVE.length, filter: LIVE.filter };
  assert.equal(flashCodeFromCallerId('+393739799312', opts), '799312');
  // Already trimmed: no prefix to match, so it falls back and is kept as-is.
  assert.equal(flashCodeFromCallerId('799312', opts), '799312');
});

test('without a filter it is the plain last-length behaviour', () => {
  assert.equal(flashCodeFromCallerId('393739799312', { length: 6 }), '799312');
  assert.equal(flashCodeFromCallerId('393739799312', 6), '799312', 'bare length still works');
});

test('a tail shorter than the length is kept rather than guessed at', () => {
  assert.equal(flashCodeFromCallerId('3731234', { length: 6, filter: '(.*)373(.*)' }), '1234');
});

// ─── codeForSubmission, reading the session the /code reply wrote ─────────────

test('a flash confirm uses the filter and length captured on the session', () => {
  const store = {
    codeMethod:      'flash',
    flashCliFilter:  LIVE.filter,
    flashCodeLength: LIVE.length
  };
  assert.equal(codeForSubmission(store, LIVE.caller, {}), LIVE.code);
});

test('opts can state the filter and length outright for a session that lacks them', () => {
  const store = { codeMethod: 'flash' };
  assert.equal(
    codeForSubmission(store, LIVE.caller, { flashFilter: LIVE.filter, flashCodeLen: LIVE.length }),
    LIVE.code
  );
});

test('WA_FLASH_CODE_LEN overrides the server length', () => {
  const prev = process.env.WA_FLASH_CODE_LEN;
  try {
    process.env.WA_FLASH_CODE_LEN = '4';
    const store = { codeMethod: 'flash', flashCliFilter: LIVE.filter, flashCodeLength: 6 };
    // the tail after the prefix is "9799312"; last four of it.
    assert.equal(codeForSubmission(store, LIVE.caller, {}), '9312');
  } finally {
    if (prev === undefined) delete process.env.WA_FLASH_CODE_LEN;
    else process.env.WA_FLASH_CODE_LEN = prev;
  }
});

test('a non-flash confirm just strips separators, no filtering', () => {
  const store = { codeMethod: 'sms' };
  assert.equal(codeForSubmission(store, '123-456', {}), '123456');
});

test('method from opts overrides the session', () => {
  const store = { codeMethod: 'sms' };
  assert.equal(
    codeForSubmission(store, LIVE.caller, { method: 'flash', flashFilter: LIVE.filter, flashCodeLen: 6 }),
    LIVE.code
  );
});
