'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WhalibmobClient } = require('../lib/Client');
const { createNewStore } = require('../lib/Store');
const { sessionDirFor } = require('../lib/SessionPaths');

// The authentication folder used to reach the client exactly as the caller
// wrote it, so './auth' stayed relative and every path under it followed the
// working directory. Primary linking keeps its journal at an absolute path and
// refused to start on one (PRIMARY_LINK_STORE_REQUIRED).

test('relative sessionDir resolves to absolute', () => {
  const c = new WhalibmobClient({ sessionDir: 'rel/dir', refreshVersion: false });
  assert.equal(c._baseDir, path.resolve('rel/dir'));
  assert.ok(path.isAbsolute(c._sessionDir));
});

test('relative dir with spaces resolves and linking constructs', () => {
  const phone = '15550000123';
  const origin = process.cwd();
  // os.tmpdir() is a symlink on macOS while process.cwd() reports the real path,
  // so take the real one up front for the expected paths to agree.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-dir-absolute-')));
  let c;
  try {
    fs.mkdirSync(path.join(cwd, 'my sessions'));
    process.chdir(cwd);
    c = new WhalibmobClient({ sessionDir: './my sessions/../s', refreshVersion: false });
    c._store = createNewStore(phone);
    c._store.registered = true;
    c._sessionDir = sessionDirFor(c._baseDir, phone, { create: true });

    assert.doesNotThrow(() => c._primaryLinkingForSession());
    assert.ok(fs.existsSync(path.join(path.resolve(cwd, 's'), phone, phone + '.primary-linking.json')));
  } finally {
    // The journal holds a lock file open; release it before the folder goes.
    if (c) c._closePrimaryLinking();
    process.chdir(origin);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a relative WA_SESSION_DIR resolves to absolute too', () => {
  const saved = process.env.WA_SESSION_DIR;
  process.env.WA_SESSION_DIR = 'env/rel';
  try {
    const c = new WhalibmobClient({ refreshVersion: false });
    assert.equal(c._baseDir, path.resolve('env/rel'));
    assert.ok(path.isAbsolute(c._sessionDir));
  } finally {
    if (saved === undefined) delete process.env.WA_SESSION_DIR;
    else process.env.WA_SESSION_DIR = saved;
  }
});
