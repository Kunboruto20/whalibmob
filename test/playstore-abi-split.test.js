'use strict';

// Which splits `wa apk-material --download` pulls from Play.
//
// The density splits carry about_logo.png, the source of the token key, and
// were the only ones fetched. libwhatsapp.so — the file the login
// integrity_payload's _lh hashes — ships in an ABI split (config.arm64_v8a and
// friends), so one ABI split is now fetched too, or _lh falls back to a pinned
// value. These tests pin the picker that chooses it; the density selection is
// unchanged.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { pickAbiSplit } = require('../lib/PlayStore');

const split = (name) => ({ name, url: 'https://play/' + name });

test('prefers the arm64-v8a split', () => {
  const splits = [
    split('config.en'), split('config.xxhdpi'),
    split('config.armeabi_v7a'), split('config.arm64_v8a'), split('config.x86_64')
  ];
  assert.equal(pickAbiSplit(splits).name, 'config.arm64_v8a');
});

test('falls back through the ABI list in order', () => {
  assert.equal(pickAbiSplit([split('config.armeabi_v7a'), split('config.x86')]).name, 'config.armeabi_v7a');
  assert.equal(pickAbiSplit([split('config.x86_64'), split('config.x86')]).name, 'config.x86_64',
    'x86_64 is picked before x86, not shadowed by it');
  assert.equal(pickAbiSplit([split('config.x86')]).name, 'config.x86');
});

test('matches a split whose name carries the .apk suffix', () => {
  assert.equal(pickAbiSplit([split('split_config.arm64_v8a.apk')]).name, 'split_config.arm64_v8a.apk');
});

test('returns null when no ABI split is offered', () => {
  assert.equal(pickAbiSplit([split('config.en'), split('config.xxhdpi'), split('config.xhdpi')]), null);
  assert.equal(pickAbiSplit([]), null);
  assert.equal(pickAbiSplit(undefined), null);
});

test('does not mistake a density split for an ABI one', () => {
  // No density name ends in an ABI token, so the ABI picker never takes one.
  for (const d of ['config.ldpi', 'config.mdpi', 'config.hdpi', 'config.xhdpi',
                   'config.xxhdpi', 'config.xxxhdpi', 'config.tvdpi', 'config.nodpi']) {
    assert.equal(pickAbiSplit([split(d)]), null, d);
  }
});
