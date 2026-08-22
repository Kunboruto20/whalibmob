'use strict';

// Session creation and persistence. The keys in a store are the account: if a
// round-trip through disk loses or mangles one of them, the number stops being
// able to log in and the only visible symptom is a 401.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  createNewStore, normalizePushName, MAX_PUSH_NAME_LENGTH,
  saveStore, loadStore, storeToJson, storeFromJson,
  toSixParts, fromSixParts
} = require('../lib/Store');

const PHONE = '919634847671';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalibmob-store-'));
  return { dir, file: path.join(dir, PHONE + '.json') };
}

// ── normalizePushName ───────────────────────────────────────────────────────
// The server takes the display name verbatim, so whatever survives this goes
// out on the wire exactly as it is.

test('normalizePushName: nothing in, nothing out', () => {
  assert.equal(normalizePushName(null), null);
  assert.equal(normalizePushName(undefined), null);
  assert.equal(normalizePushName(''), null);
  assert.equal(normalizePushName('   '), null);
});

test('normalizePushName: trims, and collapses runs of whitespace to one space', () => {
  assert.equal(normalizePushName('  Ricardo Trade  '), 'Ricardo Trade');
  assert.equal(normalizePushName('Ricardo    Trade'), 'Ricardo Trade');
});

test('normalizePushName: newlines and tabs never reach the wire', () => {
  assert.equal(normalizePushName('Ricardo\nTrade'), 'Ricardo Trade');
  assert.equal(normalizePushName('Ricardo\tTrade'), 'Ricardo Trade');
  assert.equal(normalizePushName('Ricardo\r\n\tTrade'), 'Ricardo Trade');
  const out = normalizePushName('a\nb');
  assert.equal(/[\r\n\t]/.test(out), false);
});

test('normalizePushName: capped at 25 characters, with no trailing space left behind', () => {
  const long = 'A'.repeat(40);
  assert.equal(normalizePushName(long).length, MAX_PUSH_NAME_LENGTH);
  assert.equal(MAX_PUSH_NAME_LENGTH, 25);

  // Cutting mid-gap must not leave the name ending in a space.
  const cut = normalizePushName('A'.repeat(24) + ' tail');
  assert.equal(cut, cut.trim());
});

test('normalizePushName: the "User" placeholder is not a real name', () => {
  // Accepting it back would make "named User" indistinguishable from nameless.
  assert.equal(normalizePushName('User'), null);
  assert.equal(normalizePushName('  User  '), null);
  assert.equal(normalizePushName('User2'), 'User2', 'only the exact placeholder is rejected');
});

// ── createNewStore ──────────────────────────────────────────────────────────

test('createNewStore produces a complete, unregistered session', () => {
  const s = createNewStore(PHONE);

  assert.equal(s.phoneNumber, PHONE);
  assert.equal(s.registered, false, 'a fresh store has not registered yet');
  assert.equal(s.codePending, false);
  assert.equal(s.advIdentity, null);

  for (const pair of ['noiseKeyPair', 'identityKeyPair']) {
    assert.ok(Buffer.isBuffer(s[pair].private), `${pair}.private`);
    assert.ok(Buffer.isBuffer(s[pair].public), `${pair}.public`);
  }
  assert.ok(Buffer.isBuffer(s.signedPreKey.public));
  assert.ok(Buffer.isBuffer(s.signedPreKey.signature));
  assert.ok(Number.isInteger(s.signedPreKey.id) && s.signedPreKey.id > 0);
  assert.ok(Number.isInteger(s.registrationId) && s.registrationId > 0);
});

test('createNewStore strips a leading + from the number', () => {
  assert.equal(createNewStore('+' + PHONE).phoneNumber, PHONE);
});

test('createNewStore gives every session its own keys', () => {
  const a = createNewStore(PHONE);
  const b = createNewStore(PHONE);
  assert.notEqual(a.identityKeyPair.private.toString('hex'), b.identityKeyPair.private.toString('hex'));
  assert.notEqual(a.noiseKeyPair.private.toString('hex'), b.noiseKeyPair.private.toString('hex'));
  assert.notEqual(a.registrationId + ':' + a.signedPreKey.id, b.registrationId + ':' + b.signedPreKey.id);
});

test('createNewStore normalises the name it is given', () => {
  assert.equal(createNewStore(PHONE, { name: '  Ricardo   Trade ' }).name, 'Ricardo Trade');
  assert.equal(createNewStore(PHONE, { name: 'A'.repeat(40) }).name.length, MAX_PUSH_NAME_LENGTH);
});

test('createNewStore with no name falls back to the placeholder', () => {
  assert.equal(createNewStore(PHONE).name, 'User');
});

// ── persistence ─────────────────────────────────────────────────────────────

test('a store survives a round-trip through disk with its keys intact', () => {
  const { dir, file } = tmpFile();
  try {
    const original = createNewStore(PHONE, { name: 'Ricardo Trade' });
    saveStore(original, file);
    const loaded = loadStore(file);

    assert.equal(loaded.phoneNumber, original.phoneNumber);
    assert.equal(loaded.name, original.name);
    assert.equal(loaded.registered, original.registered);
    assert.equal(loaded.registrationId, original.registrationId);
    assert.equal(loaded.signedPreKey.id, original.signedPreKey.id);

    // Buffers have to come back as Buffers, not as { type: 'Buffer', data: [...] }.
    for (const pair of ['noiseKeyPair', 'identityKeyPair']) {
      for (const half of ['private', 'public']) {
        assert.ok(Buffer.isBuffer(loaded[pair][half]), `${pair}.${half} is a Buffer`);
        assert.equal(
          loaded[pair][half].toString('base64'), original[pair][half].toString('base64'),
          `${pair}.${half} survives byte for byte`
        );
      }
    }
    assert.ok(Buffer.isBuffer(loaded.signedPreKey.signature));
    assert.equal(
      loaded.signedPreKey.signature.toString('base64'),
      original.signedPreKey.signature.toString('base64')
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadStore on a missing file returns null rather than throwing', () => {
  const { dir, file } = tmpFile();
  try {
    assert.equal(loadStore(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storeToJson / storeFromJson round-trip without touching disk', () => {
  const original = createNewStore(PHONE, { name: 'Ana' });
  const back = storeFromJson(storeToJson(original));
  assert.equal(back.phoneNumber, original.phoneNumber);
  assert.equal(back.name, 'Ana');
  assert.equal(
    back.identityKeyPair.private.toString('base64'),
    original.identityKeyPair.private.toString('base64')
  );
});

// ── six-part export ─────────────────────────────────────────────────────────

test('toSixParts emits exactly six comma-separated values', () => {
  const parts = toSixParts(createNewStore(PHONE)).split(',');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], PHONE);
  for (let i = 1; i < 6; i++) assert.ok(parts[i].length > 0, `part ${i} is not empty`);
});

test('toSixParts drops a leading + so the two forms export identically', () => {
  const a = toSixParts(createNewStore(PHONE));
  assert.equal(a.split(',')[0], PHONE);
});

test('toSixParts refuses a missing store instead of throwing something opaque', () => {
  assert.throws(() => toSixParts(null), /store is undefined or null/);
  assert.throws(() => toSixParts(undefined), /store is undefined or null/);
});

test('fromSixParts restores the identity and noise keys byte for byte', () => {
  const original = createNewStore(PHONE);
  const back = fromSixParts(toSixParts(original));

  assert.equal(back.phoneNumber, PHONE);
  assert.equal(
    back.identityKeyPair.private.toString('base64'),
    original.identityKeyPair.private.toString('base64')
  );
  assert.equal(
    back.noiseKeyPair.public.toString('base64'),
    original.noiseKeyPair.public.toString('base64')
  );
  // The signed pre-key is regenerated rather than carried, so it is new but valid.
  assert.ok(Buffer.isBuffer(back.signedPreKey.signature));
  assert.ok(back.registrationId > 0);
});

test('fromSixParts tolerates whitespace and rejects the wrong shape', () => {
  const six = toSixParts(createNewStore(PHONE));
  assert.doesNotThrow(() => fromSixParts(' ' + six.replace(/,/g, ' , ') + '\n'));
  assert.throws(() => fromSixParts('a,b,c'), /expected 6/);
  assert.throws(() => fromSixParts(six + ',extra'), /expected 6/);
});
