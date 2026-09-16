'use strict';

// What the SQLite backend has to get right beyond the shared contract, which
// storage-backend.test.js already runs against it.
//
// Two of these exist because of something the driver does that a test would
// not think to look for. node:sqlite binds a string to a TEXT column as a C
// string, so a value carrying a NUL byte arrives truncated and the session
// loads with keys that are silently wrong from that byte on — which is why the
// column holds BLOBs and why the first test here is about a NUL. The other is
// the file handle: a number's two halves and fifty other numbers are all one
// database, and the handle they share is counted, so one of them finishing
// must not close the file under the rest.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { SqliteBackend, resolveDriver, SCHEMA_VERSION } =
  require('../lib/store/SqliteBackend');
const { FileBackend } = require('../lib/store/FileBackend');
const { MemoryBackend } = require('../lib/store/MemoryBackend');
const { copySession, compareSessions } = require('../lib/store/migrate');
const { preKeyKey } = require('../lib/store/Backend');

const PHONE = '919634847671';
const OTHER = '40712345678';

const HAVE_SQLITE = (() => {
  try { resolveDriver(); return true; } catch (_) { return false; }
})();

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whalib-sqlite-'));
}

// Runs `body(dir, dbPath)` and cleans up, or skips when there is no driver.
function withDb(name, body) {
  test(name, { skip: HAVE_SQLITE ? false : 'no SQLite driver on this Node' }, () => {
    const dir = tmpDir();
    try { body(dir, path.join(dir, 'state.sqlite')); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

// ─── values survive whatever is in them ──────────────────────────────────────

withDb('a value carrying a NUL byte comes back whole', (dir, dbPath) => {
  const backend = new SqliteBackend({ path: dbPath, phone: PHONE });
  try {
    // Bound to a TEXT column this arrives as 'a' and the rest is gone.
    const value = 'a' + String.fromCharCode(0) + 'b';
    backend.write('auth', value);
    assert.equal(backend.read('auth'), value);
    assert.equal(backend.read('auth').length, 3);
  } finally { backend.close(); }
});

withDb('unicode, empty and large values all round-trip exactly', (dir, dbPath) => {
  const backend = new SqliteBackend({ path: dbPath, phone: PHONE });
  try {
    const cases = {
      'auth':           JSON.stringify({ name: 'Răzvan Ștefan', key: 'AAECAwQ=' }),
      'signal':         '大きい — ǆ — \u{1F600}',
      'app-state':      '',
      'messages':       'x'.repeat(200000)
    };
    for (const [key, value] of Object.entries(cases)) {
      backend.write(key, value);
      assert.equal(backend.read(key), value, key + ' did not survive');
    }
  } finally { backend.close(); }
});

withDb('state is still there after the database is closed and opened again',
  (dir, dbPath) => {
    let backend = new SqliteBackend({ path: dbPath, phone: PHONE });
    backend.write('auth', 'creds');
    backend.write(preKeyKey(7), 'key seven');
    backend.close();

    backend = new SqliteBackend({ path: dbPath, phone: PHONE });
    try {
      assert.equal(backend.read('auth'), 'creds');
      assert.equal(backend.read(preKeyKey(7)), 'key seven');
    } finally { backend.close(); }
  });

// ─── one database, many sessions ─────────────────────────────────────────────

withDb('the two halves of one number do not touch each other', (dir, dbPath) => {
  const mobile = new SqliteBackend({ path: dbPath, phone: PHONE });
  const web    = new SqliteBackend({ path: dbPath, phone: PHONE, web: true });
  try {
    mobile.write('auth', 'mobile creds');
    web.write('auth', 'companion creds');
    mobile.write(preKeyKey(1), 'mobile key one');
    web.write(preKeyKey(1), 'companion key one');

    assert.equal(mobile.read('auth'), 'mobile creds');
    assert.equal(web.read('auth'),    'companion creds');
    assert.equal(mobile.read(preKeyKey(1)), 'mobile key one');
    assert.equal(web.read(preKeyKey(1)),    'companion key one');
    assert.deepEqual(mobile.list(), ['auth', 'pre-key/1']);
    assert.deepEqual(web.list(),    ['auth', 'pre-key/1']);

    mobile.remove('auth');
    assert.equal(mobile.read('auth'), null);
    assert.equal(web.read('auth'), 'companion creds');
  } finally { mobile.close(); web.close(); }
});

withDb('two numbers in one database keep to themselves', (dir, dbPath) => {
  const a = new SqliteBackend({ path: dbPath, phone: PHONE });
  const b = new SqliteBackend({ path: dbPath, phone: OTHER });
  try {
    a.write('auth', 'first');
    b.write('auth', 'second');
    assert.equal(a.read('auth'), 'first');
    assert.equal(b.read('auth'), 'second');
    assert.deepEqual(b.list(), ['auth']);
  } finally { a.close(); b.close(); }
});

withDb('sessionsIn reports every number and half the database holds', (dir, dbPath) => {
  const made = [
    new SqliteBackend({ path: dbPath, phone: PHONE }),
    new SqliteBackend({ path: dbPath, phone: PHONE, web: true }),
    new SqliteBackend({ path: dbPath, phone: OTHER })
  ];
  for (const b of made) b.write('auth', 'x');
  for (const b of made) b.close();

  assert.deepEqual(SqliteBackend.sessionsIn(dbPath), [
    { phone: OTHER, half: 'mobile', web: false },
    { phone: PHONE, half: 'mobile', web: false },
    { phone: PHONE, half: 'web',    web: true  }
  ]);
});

// ─── the shared handle ───────────────────────────────────────────────────────

withDb('one backend closing does not close the file under another', (dir, dbPath) => {
  const mobile = new SqliteBackend({ path: dbPath, phone: PHONE });
  const web    = new SqliteBackend({ path: dbPath, phone: PHONE, web: true });
  try {
    mobile.write('auth', 'mobile creds');
    web.write('auth', 'companion creds');

    mobile.close();
    // The handle is shared and counted; the companion is still using it.
    assert.equal(web.read('auth'), 'companion creds');
    assert.doesNotThrow(() => web.write('signal', 'still writable'));
  } finally { web.close(); }
});

withDb('closing twice is harmless', (dir, dbPath) => {
  const backend = new SqliteBackend({ path: dbPath, phone: PHONE });
  backend.write('auth', 'creds');
  backend.close();
  assert.doesNotThrow(() => backend.close());

  // and the count was not driven below zero, so the file still opens cleanly
  const again = new SqliteBackend({ path: dbPath, phone: PHONE });
  try { assert.equal(again.read('auth'), 'creds'); }
  finally { again.close(); }
});

// ─── the file itself ─────────────────────────────────────────────────────────

withDb('the database is created, with its schema version recorded', (dir, dbPath) => {
  const nested = path.join(dir, 'does', 'not', 'exist', 'state.sqlite');
  const backend = new SqliteBackend({ path: nested, phone: PHONE });
  try {
    assert.ok(fs.existsSync(nested), 'the directory should have been made');
    assert.equal(backend.list().length, 0);
    assert.ok(SCHEMA_VERSION >= 1);
  } finally { backend.close(); }
});

withDb('a database from a newer whalibmob is refused rather than written to',
  (dir, dbPath) => {
    const backend = new SqliteBackend({ path: dbPath, phone: PHONE });
    const driver  = backend.driver;
    backend.write('auth', 'creds');
    backend.close();

    // Whatever a future release does to the table, this one must not guess.
    const raw = resolveDriver().open(dbPath);
    raw.exec('PRAGMA user_version = ' + (SCHEMA_VERSION + 1));
    raw.close();

    assert.throws(
      () => new SqliteBackend({ path: dbPath, phone: PHONE }),
      /newer whalibmob/,
      'driver ' + driver + ' should have refused the newer schema');
  });

withDb('the driver in use is reported', (dir, dbPath) => {
  const backend = new SqliteBackend({ path: dbPath, phone: PHONE });
  try {
    assert.ok(['node:sqlite', 'better-sqlite3'].includes(backend.driver),
      'unexpected driver ' + backend.driver);
  } finally { backend.close(); }
});

withDb('a backend cannot be built without a file or a number', () => {
  assert.throws(() => new SqliteBackend({ phone: PHONE }), /path is required/);
  assert.throws(() => new SqliteBackend({ path: '/tmp/x.sqlite' }), /phone is required/);
  assert.throws(() => new SqliteBackend({ path: '/tmp/x.sqlite', phone: 'abc' }),
    /must contain digits/);
});

test('asking for a driver that is not here says what to install',
  { skip: HAVE_SQLITE ? false : 'no SQLite driver on this Node' }, () => {
    // better-sqlite3 is not a dependency, so demanding it is the one failure
    // that can be provoked on a runtime where SQLite otherwise works.
    let threw = null;
    try { resolveDriver('better-sqlite3'); } catch (err) { threw = err; }
    if (threw) {
      assert.match(threw.message, /npm install better-sqlite3/);
      assert.match(threw.message, /FileBackend needs nothing installed/);
    }
  });

// ─── moving a session between backends ───────────────────────────────────────

withDb('a session copies out of files and into the database, byte for byte',
  (dir, dbPath) => {
    const files = new FileBackend({ dir, phone: PHONE });
    files.write('auth',   JSON.stringify({ registered: true, name: 'Ștefan' }));
    files.write('signal', 'snapshot');
    for (const id of [1, 2, 812]) files.write(preKeyKey(id), 'key ' + id);

    const db = new SqliteBackend({ path: dbPath, phone: PHONE });
    try {
      const result = copySession(files, db);
      assert.equal(result.copied.length, 5);
      assert.equal(result.skipped.length, 0);
      assert.ok(result.bytes > 0);

      // Not "the copy said so" — read both sides back and compare.
      assert.deepEqual(compareSessions(files, db),
        { ok: true, missing: [], differing: [], extra: [] });
    } finally { db.close(); }
  });

withDb('the source is left exactly as it was', (dir, dbPath) => {
  const files = new FileBackend({ dir, phone: PHONE });
  files.write('auth', 'creds');
  files.write(preKeyKey(1), 'key one');
  const before = fs.readdirSync(dir).sort();

  const db = new SqliteBackend({ path: dbPath, phone: PHONE });
  try {
    copySession(files, db);
    assert.equal(files.read('auth'), 'creds');
    assert.deepEqual(
      fs.readdirSync(dir).filter(f => !f.startsWith('state.sqlite')).sort(),
      before.filter(f => !f.startsWith('state.sqlite')),
      'copying must not remove or rename anything on the way out');
  } finally { db.close(); }
});

withDb('a copy that was interrupted can simply be run again', (dir, dbPath) => {
  const files = new FileBackend({ dir, phone: PHONE });
  files.write('auth', 'creds');
  files.write('signal', 'snapshot');

  const db = new SqliteBackend({ path: dbPath, phone: PHONE });
  try {
    assert.equal(copySession(files, db).copied.length, 2);

    // Second run: everything is already there, so nothing is touched.
    const again = copySession(files, db);
    assert.equal(again.copied.length, 0);
    assert.deepEqual(again.skipped, ['auth', 'signal']);

    // And what is there is not quietly replaced by a stale source.
    db.write('auth', 'newer creds');
    copySession(files, db);
    assert.equal(db.read('auth'), 'newer creds');
    assert.equal(copySession(files, db, { overwrite: true }).copied.length, 2);
    assert.equal(db.read('auth'), 'creds');
  } finally { db.close(); }
});

test('a session copies between any two backends, not just these two', () => {
  const a = new MemoryBackend();
  const b = new MemoryBackend();
  a.write('auth', 'creds');
  a.write(preKeyKey(3), 'three');

  assert.equal(copySession(a, b).copied.length, 2);
  assert.ok(compareSessions(a, b).ok);

  assert.throws(() => copySession(a, a), /same backend/);
  assert.throws(() => copySession(a, {}), /destination backend is missing/);
  assert.throws(() => copySession(null, b), /source backend must be an object/);
});

test('compareSessions names what is wrong rather than only that something is', () => {
  const a = new MemoryBackend();
  const b = new MemoryBackend();
  a.write('auth', 'creds');
  a.write('signal', 'snapshot');
  b.write('auth', 'different');
  b.write('messages', 'unexpected');

  const diff = compareSessions(a, b);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.missing,   ['signal']);
  assert.deepEqual(diff.differing, ['auth']);
  assert.deepEqual(diff.extra,     ['messages']);
});
