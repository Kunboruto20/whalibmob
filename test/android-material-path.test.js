'use strict';

// Where the Android token material is looked for.
//
// The bug, reported from a real setup: `wa apk-material` writes the extracted
// material into the session directory the CLI resolved — WA_SESSION_DIR, or
// --session, or the folder remembered from the setup prompt — but
// androidMaterialPath() read it from a hardcoded ~/.waSession. So a user who
// kept their sessions anywhere else extracted the material successfully,
// registration then reported no material at all, and the only way out was to
// set WA_ANDROID_APK_MATERIAL by hand to point at a file that was already
// exactly where it belonged.
//
// SessionPaths.defaultBaseDir() is the resolver the writer goes through, and
// SHARED_FILES there already declares both material files as belonging to the
// base directory. The reader now goes through the same place.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { androidMaterialPath } = require('../lib/Registration')._token;
const { SHARED_FILES }        = require('../lib/SessionPaths');

const ANDROID  = { os: 'android', business: false };
const BUSINESS = { os: 'android', business: true };

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

// A throwaway directory, so the tests never read or write a real session.
function tmpDir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-material-' + label + '-'));
  return d;
}

const clean = { WA_SESSION_DIR: undefined, WA_ANDROID_APK_MATERIAL: undefined };

// ─── the reported bug ────────────────────────────────────────────────────────

test('the material is read from WA_SESSION_DIR, not from ~/.waSession', () => {
  const dir = tmpDir('sess');
  fs.writeFileSync(path.join(dir, 'android-apk-material.json'), '{}');

  withEnv({ ...clean, WA_SESSION_DIR: dir }, () => {
    const p = androidMaterialPath(ANDROID);
    assert.equal(p, path.join(dir, 'android-apk-material.json'));
    assert.ok(!p.includes(path.join(os.homedir(), '.waSession')),
      'it no longer points at the home default');
  });
});

test('the Business build gets its own file in the same directory', () => {
  const dir = tmpDir('biz');
  fs.writeFileSync(path.join(dir, 'android-apk-material-business.json'), '{}');

  withEnv({ ...clean, WA_SESSION_DIR: dir }, () => {
    assert.equal(androidMaterialPath(BUSINESS),
      path.join(dir, 'android-apk-material-business.json'));
  });
});

test('consumer and Business never resolve to the same file', () => {
  const dir = tmpDir('both');
  withEnv({ ...clean, WA_SESSION_DIR: dir }, () => {
    assert.notEqual(androidMaterialPath(ANDROID), androidMaterialPath(BUSINESS));
  });
});

// ─── the writer and the reader agree ─────────────────────────────────────────

test('both material files are declared as belonging to the base directory', () => {
  // SHARED_FILES is what SessionPaths treats as installation-wide rather than
  // per-number. The reader resolving anywhere else is what the bug was.
  assert.ok(SHARED_FILES.includes('android-apk-material.json'));
  assert.ok(SHARED_FILES.includes('android-apk-material-business.json'));
});

test('the resolved path sits directly in the session directory', () => {
  const dir = tmpDir('layout');
  withEnv({ ...clean, WA_SESSION_DIR: dir }, () => {
    // Same shape `wa apk-material` writes: <sessionDir>/<name>, no nesting.
    assert.equal(path.dirname(androidMaterialPath(ANDROID)), dir);
  });
});

// ─── the explicit override still wins ────────────────────────────────────────

test('WA_ANDROID_APK_MATERIAL still overrides everything', () => {
  const dir  = tmpDir('override');
  const file = path.join(dir, 'somewhere-else.json');

  withEnv({ WA_SESSION_DIR: tmpDir('ignored'), WA_ANDROID_APK_MATERIAL: file }, () => {
    assert.equal(androidMaterialPath(ANDROID), file);
    assert.equal(androidMaterialPath(BUSINESS), file,
      'an explicit file is used for both builds, as before');
  });
});

// ─── backwards compatibility ─────────────────────────────────────────────────

test('with no WA_SESSION_DIR the home default is still used', () => {
  withEnv(clean, () => {
    const p = androidMaterialPath(ANDROID);
    assert.equal(p, path.join(os.homedir(), '.waSession', 'android-apk-material.json'),
      'nothing changes for an installation that never moved its sessions');
  });
});

test('material left in ~/.waSession is still found after the directory moves', () => {
  // Someone who extracted material before the directory could be moved should
  // not be told there is none just because they now set WA_SESSION_DIR.
  const legacyDir  = path.join(os.homedir(), '.waSession');
  const legacyFile = path.join(legacyDir, 'android-apk-material.json');
  const hadLegacy  = fs.existsSync(legacyFile);
  if (!hadLegacy) {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, '{}');
  }

  try {
    const empty = tmpDir('nomaterial');   // configured dir, deliberately empty
    withEnv({ ...clean, WA_SESSION_DIR: empty }, () => {
      assert.equal(androidMaterialPath(ANDROID), legacyFile,
        'it falls back to the old location rather than reporting no material');
    });
  } finally {
    if (!hadLegacy) { try { fs.unlinkSync(legacyFile); } catch (_) {} }
  }
});

test('the configured directory wins when it has material of its own', () => {
  const dir = tmpDir('wins');
  fs.writeFileSync(path.join(dir, 'android-apk-material.json'), '{}');

  withEnv({ ...clean, WA_SESSION_DIR: dir }, () => {
    assert.equal(androidMaterialPath(ANDROID), path.join(dir, 'android-apk-material.json'),
      'the fallback never overrides a file that is actually there');
  });
});

test('an empty directory with no legacy file still names the configured path', () => {
  // Nothing anywhere: the path reported must be the one the user should write
  // to, so the "no material" message points at the right place.
  const dir = tmpDir('nothing');
  withEnv({ ...clean, WA_SESSION_DIR: dir }, () => {
    const p = androidMaterialPath(ANDROID);
    // Only meaningful when the home default happens to be empty too.
    if (!fs.existsSync(path.join(os.homedir(), '.waSession', 'android-apk-material.json'))) {
      assert.equal(p, path.join(dir, 'android-apk-material.json'));
    }
  });
});
