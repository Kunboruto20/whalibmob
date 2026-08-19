'use strict';

// Where a number's files live. Two layouts have to coexist: the current one,
// a folder per number, and the legacy one where files sat loose in the base
// directory. Picking the wrong one for an existing session loses it, so these
// tests exercise both against a real temporary directory.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  defaultBaseDir, isLegacyLayout, sessionDirFor, storeFileFor, webStoreFileFor,
  listSessions, migrateSession, preKeyFilesFor, SESSION_SUFFIXES
} = require('../lib/SessionPaths');

const PHONE = '919634847671';

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whalibmob-paths-'));
}
function touch(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body == null ? '{}' : body);
}

test('a number with no files at all is new, not legacy — it gets a folder', () => {
  const base = tmpBase();
  try {
    assert.equal(isLegacyLayout(base, PHONE), false);
    assert.equal(sessionDirFor(base, PHONE), path.join(base, PHONE));
    assert.equal(storeFileFor(base, PHONE), path.join(base, PHONE, PHONE + '.json'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a number whose files sit loose in the base is legacy and is left there', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.json'));
    assert.equal(isLegacyLayout(base, PHONE), true);
    assert.equal(sessionDirFor(base, PHONE), base, 'an existing session is never relocated implicitly');
    assert.equal(storeFileFor(base, PHONE), path.join(base, PHONE + '.json'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a loose companion store alone also counts as legacy', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.web.json'));
    assert.equal(isLegacyLayout(base, PHONE), true);
    assert.equal(webStoreFileFor(base, PHONE), path.join(base, PHONE + '.web.json'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a folder wins over loose files when both somehow exist', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.json'));                 // legacy leftover
    touch(path.join(base, PHONE, PHONE + '.json'));          // the real one
    assert.equal(isLegacyLayout(base, PHONE), false);
    assert.equal(sessionDirFor(base, PHONE), path.join(base, PHONE));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the phone number is normalised — punctuation cannot escape the directory', () => {
  const base = tmpBase();
  try {
    assert.equal(sessionDirFor(base, '+91 963-484 7671'), path.join(base, PHONE));
    assert.equal(storeFileFor(base, '+91-963-4847671'), path.join(base, PHONE, PHONE + '.json'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('sessionDirFor only creates the directory when asked', () => {
  const base = tmpBase();
  try {
    const dir = sessionDirFor(base, PHONE);
    assert.equal(fs.existsSync(dir), false, 'no side effect without { create: true }');
    sessionDirFor(base, PHONE, { create: true });
    assert.equal(fs.existsSync(dir), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('listSessions finds numbers in both layouts and flags which is which', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, '111', '111.json'));               // folder layout, mobile
    touch(path.join(base, '222.web.json'));                  // legacy, companion only
    touch(path.join(base, 'android-apk-material.json'));     // shared, not a session
    touch(path.join(base, 'notanumber.json'));               // ignored

    const found = listSessions(base);
    const byPhone = Object.fromEntries(found.map(s => [s.phone, s]));

    assert.deepEqual(Object.keys(byPhone).sort(), ['111', '222']);

    assert.equal(byPhone['111'].legacy, false);
    assert.equal(byPhone['111'].hasMobile, true);
    assert.equal(byPhone['111'].hasWeb, false);
    assert.equal(byPhone['111'].dir, path.join(base, '111'));

    assert.equal(byPhone['222'].legacy, true);
    assert.equal(byPhone['222'].hasMobile, false);
    assert.equal(byPhone['222'].hasWeb, true);
    assert.equal(byPhone['222'].dir, base);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('listSessions on a missing directory returns nothing rather than throwing', () => {
  assert.deepEqual(listSessions(path.join(os.tmpdir(), 'whalibmob-does-not-exist-' + Date.now())), []);
});

test('listSessions returns numbers in a stable order', () => {
  const base = tmpBase();
  try {
    for (const p of ['333', '111', '222']) touch(path.join(base, p, p + '.json'));
    assert.deepEqual(listSessions(base).map(s => s.phone), ['111', '222', '333']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('migrateSession moves the whole session, pre-keys included', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.json'));
    touch(path.join(base, PHONE + '.signal.json'));
    touch(path.join(base, PHONE + '.pre-key-1.json'));
    touch(path.join(base, PHONE + '.pre-key-2.json'));

    const r = migrateSession(base, PHONE);

    assert.equal(r.phone, PHONE);
    assert.equal(r.to, path.join(base, PHONE));
    assert.ok(r.moved.includes(PHONE + '.json'));
    assert.ok(r.moved.includes(PHONE + '.signal.json'));
    assert.ok(r.moved.includes(PHONE + '.pre-key-1.json'), 'pre-keys must travel with the session');
    assert.ok(r.moved.includes(PHONE + '.pre-key-2.json'));
    assert.deepEqual(r.skipped, []);

    // The originals are gone and the new location resolves.
    assert.equal(fs.existsSync(path.join(base, PHONE + '.json')), false);
    assert.equal(fs.existsSync(path.join(base, PHONE, PHONE + '.json')), true);
    assert.equal(storeFileFor(base, PHONE), path.join(base, PHONE, PHONE + '.json'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('migrateSession never overwrites a file already at the destination', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.json'), '"loose"');
    touch(path.join(base, PHONE, PHONE + '.json'), '"already there"');

    const r = migrateSession(base, PHONE);

    assert.ok(r.skipped.includes(PHONE + '.json'));
    assert.ok(!r.moved.includes(PHONE + '.json'));
    assert.equal(
      fs.readFileSync(path.join(base, PHONE, PHONE + '.json'), 'utf8'), '"already there"',
      'the destination is left intact'
    );
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('migrateSession is safe to run twice', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.json'));
    const first  = migrateSession(base, PHONE);
    const second = migrateSession(base, PHONE);
    assert.equal(first.moved.length, 1);
    assert.deepEqual(second.moved, [], 'nothing left to move');
    assert.deepEqual(second.skipped, []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('preKeyFilesFor lists only that number pre-key files', () => {
  const base = tmpBase();
  try {
    touch(path.join(base, PHONE + '.pre-key-1.json'));
    touch(path.join(base, PHONE + '.pre-key-812.json'));
    touch(path.join(base, '5568936182750.pre-key-1.json'));  // a different number
    touch(path.join(base, PHONE + '.json'));                 // not a pre-key

    const names = preKeyFilesFor(base, PHONE).sort();
    assert.deepEqual(names, [PHONE + '.pre-key-1.json', PHONE + '.pre-key-812.json']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('SESSION_SUFFIXES covers both halves of a number', () => {
  // A list that silently goes out of date leaves Signal state behind on a move.
  for (const needed of ['.json', '.signal.json', '.web.json', '.web.signal.json']) {
    assert.ok(SESSION_SUFFIXES.includes(needed), `missing ${needed}`);
  }
});

test('defaultBaseDir honours WA_SESSION_DIR', () => {
  const before = process.env.WA_SESSION_DIR;
  try {
    process.env.WA_SESSION_DIR = '/tmp/some-explicit-dir';
    assert.equal(defaultBaseDir(), '/tmp/some-explicit-dir');
    delete process.env.WA_SESSION_DIR;
    assert.equal(defaultBaseDir(), path.join(os.homedir(), '.waSession'));
  } finally {
    if (before === undefined) delete process.env.WA_SESSION_DIR;
    else process.env.WA_SESSION_DIR = before;
  }
});
