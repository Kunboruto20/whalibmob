'use strict';

// The fallback mirror hands back an XAPK — a ZIP of .apk entries. Only the base
// APK and the density config splits are wanted out of it: the base carries
// classes.dex, the manifest and the signature, and a density split carries the
// about_logo.png the token key is drawn from. Architecture and language splits
// are a hundred megabytes nothing here reads, and the base must never be
// mistaken for one of them.

const test   = require('node:test');
const assert = require('node:assert');

const { _classifyBundle } = require('../lib/ApkPureStore');

test('a package-named base is picked over the config splits', () => {
  const names = [
    'com.whatsapp.w4b.apk',
    'split_config.xxhdpi.apk',
    'split_config.arm64_v8a.apk',
    'split_config.en.apk',
    'manifest.json',
    'icon.png'
  ];
  const { baseName, splitNames } = _classifyBundle(names, 'com.whatsapp.w4b');
  assert.equal(baseName, 'com.whatsapp.w4b.apk');
  assert.deepEqual(splitNames, ['split_config.xxhdpi.apk']);
});

test('a base.apk name is recognised when the package name is not used', () => {
  const names = ['base.apk', 'config.xhdpi.apk', 'config.armeabi_v7a.apk'];
  const { baseName, splitNames } = _classifyBundle(names, 'com.whatsapp');
  assert.equal(baseName, 'base.apk');
  assert.deepEqual(splitNames, ['config.xhdpi.apk']);
});

test('only density splits are kept, never architecture or language ones', () => {
  const names = [
    'com.whatsapp.apk',
    'split_config.hdpi.apk',
    'split_config.xxxhdpi.apk',
    'split_config.arm64_v8a.apk',
    'split_config.armeabi_v7a.apk',
    'split_config.es.apk',
    'split_config.pt.apk'
  ];
  const { splitNames } = _classifyBundle(names, 'com.whatsapp');
  assert.deepEqual(splitNames.sort(), ['split_config.hdpi.apk', 'split_config.xxxhdpi.apk']);
});

test('a bundle with no base-like apk reports none', () => {
  const names = ['split_config.xxhdpi.apk', 'split_config.arm64_v8a.apk', 'manifest.json'];
  const { baseName } = _classifyBundle(names, 'com.whatsapp');
  assert.equal(baseName, null);
});

test('entries under a directory prefix are still classified by basename', () => {
  const names = ['unknown/com.whatsapp.apk', 'unknown/split_config.xxhdpi.apk'];
  const { baseName, splitNames } = _classifyBundle(names, 'com.whatsapp');
  assert.equal(baseName, 'unknown/com.whatsapp.apk');
  assert.deepEqual(splitNames, ['unknown/split_config.xxhdpi.apk']);
});
