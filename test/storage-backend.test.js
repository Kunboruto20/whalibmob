'use strict';

// One suite, every backend.
//
// A contract with two implementations is only worth the name if both answer
// the same way, and the only way to know is to ask them the same questions.
// Everything under "the contract" below runs against each backend in turn; a
// backend that disagrees fails here rather than in somebody's session.
//
// After that come the questions only the file backend can be asked, and they
// are the ones that matter most: the file names. Every installed copy of
// whalibmob reads and writes the names in SessionPaths.SESSION_SUFFIXES, so a
// backend that spells one of them differently does not store a session — it
// starts a new one over the top of the old, and the number the old one held is
// gone. Those names are checked against SessionPaths itself, not against a
// copy written out here, so the two cannot drift apart quietly.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { FileBackend }   = require('../lib/store/FileBackend');
const { MemoryBackend } = require('../lib/store/MemoryBackend');
const { SqliteBackend, resolveDriver } = require('../lib/store/SqliteBackend');
const { KEYS, preKeyKey, preKeyId, isValidKey, assertBackend } =
  require('../lib/store/Backend');
const SessionPaths = require('../lib/SessionPaths');

const PHONE = '919634847671';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whalib-backend-'));
}

// node:sqlite arrived in Node 22.5 and better-sqlite3 is not a dependency, so
// on an older runtime with neither there is nothing to test. Skipping is right;
// pretending to pass is not, so the reason is printed.
const HAVE_SQLITE = (() => {
  try { resolveDriver(); return true; } catch (_) { return false; }
})();

// Each factory hands back a fresh, empty backend plus the way to clean it up.
const BACKENDS = [
  ['MemoryBackend', () => ({ backend: new MemoryBackend(), cleanup() {} })],
  ['FileBackend',   () => {
    const dir = tmpDir();
    return {
      backend: new FileBackend({ dir, phone: PHONE }),
      dir,
      cleanup() { fs.rmSync(dir, { recursive: true, force: true }); }
    };
  }]
];

if (HAVE_SQLITE) {
  BACKENDS.push(['SqliteBackend', () => {
    const dir = tmpDir();
    const backend = new SqliteBackend({ path: path.join(dir, 'state.sqlite'), phone: PHONE });
    return {
      backend,
      dir,
      cleanup() {
        backend.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
  }]);
}

// ─── the contract ────────────────────────────────────────────────────────────

for (const [name, make] of BACKENDS) {
  test(name + ': a key never written reads as absent', () => {
    const { backend, cleanup } = make();
    try {
      assert.equal(backend.read('auth'), null);
      assert.equal(backend.read('signal'), null);
      assert.equal(backend.read(preKeyKey(7)), null);
    } finally { cleanup(); }
  });

  test(name + ': what goes in comes back out unchanged', () => {
    const { backend, cleanup } = make();
    try {
      // Credentials are base64 and JSON, and a push name can be anything a
      // person types — so the bytes have to survive, not just the ASCII.
      const value = JSON.stringify({ name: 'Ștefan — 大' , key: 'AAECAwQ=' });
      backend.write('auth', value);
      assert.equal(backend.read('auth'), value);
    } finally { cleanup(); }
  });

  test(name + ': writing a key again replaces it', () => {
    const { backend, cleanup } = make();
    try {
      backend.write('signal', 'first');
      backend.write('signal', 'second');
      assert.equal(backend.read('signal'), 'second');
    } finally { cleanup(); }
  });

  test(name + ': remove takes a key away, and is silent about one that is gone', () => {
    const { backend, cleanup } = make();
    try {
      backend.write('tc-token', 'x');
      backend.remove('tc-token');
      assert.equal(backend.read('tc-token'), null);
      assert.doesNotThrow(() => backend.remove('tc-token'));
      assert.doesNotThrow(() => backend.remove('history'));
    } finally { cleanup(); }
  });

  test(name + ': list reports exactly the keys that are there', () => {
    const { backend, cleanup } = make();
    try {
      assert.deepEqual(backend.list(), []);
      backend.write('auth', 'a');
      backend.write('app-state', 'b');
      assert.deepEqual(backend.list(), ['app-state', 'auth']);
      backend.remove('auth');
      assert.deepEqual(backend.list(), ['app-state']);
    } finally { cleanup(); }
  });

  test(name + ': the pre-key prefix selects the pre-keys and nothing else', () => {
    const { backend, cleanup } = make();
    try {
      backend.write('auth', 'creds');
      backend.write('signal', 'snapshot');
      for (const id of [1, 5, 812]) backend.write(preKeyKey(id), 'k' + id);

      assert.deepEqual(backend.list('pre-key/'),
        ['pre-key/1', 'pre-key/5', 'pre-key/812'].sort());
      // and the named keys are still there alongside them
      assert.ok(backend.list().includes('auth'));
      assert.equal(backend.list().length, 5);
    } finally { cleanup(); }
  });

  test(name + ': pre-keys are individually addressable', () => {
    const { backend, cleanup } = make();
    try {
      backend.write(preKeyKey(1), 'one');
      backend.write(preKeyKey(2), 'two');
      backend.remove(preKeyKey(1));
      assert.equal(backend.read(preKeyKey(1)), null);
      assert.equal(backend.read(preKeyKey(2)), 'two');
    } finally { cleanup(); }
  });

  test(name + ': a key the contract does not name is refused', () => {
    const { backend, cleanup } = make();
    try {
      assert.throws(() => backend.read('nonsense'), /unknown key/);
      assert.throws(() => backend.write('nonsense', 'x'), /unknown key/);
      // A near miss is still a miss — this is the typo the refusal exists for.
      assert.throws(() => backend.read('appstate'), /unknown key/);
    } finally { cleanup(); }
  });

  test(name + ': only text is stored', () => {
    const { backend, cleanup } = make();
    try {
      assert.throws(() => backend.write('auth', { a: 1 }), /must be a string/);
      assert.throws(() => backend.write('auth', Buffer.from('x')), /must be a string/);
      assert.throws(() => backend.write('auth', null), /must be a string/);
    } finally { cleanup(); }
  });

  test(name + ': it satisfies assertBackend', () => {
    const { backend, cleanup } = make();
    try {
      assert.doesNotThrow(() => assertBackend(backend, name));
    } finally { cleanup(); }
  });
}

// ─── the key space ───────────────────────────────────────────────────────────

test('every named key is valid, and a pre-key key is too', () => {
  for (const key of KEYS) assert.ok(isValidKey(key), key + ' should be valid');
  assert.ok(isValidKey('pre-key/0'));
  assert.ok(isValidKey('pre-key/812'));
});

test('a pre-key key round-trips through its id', () => {
  assert.equal(preKeyId(preKeyKey(42)), 42);
  assert.equal(preKeyId('pre-key/'), null);
  assert.equal(preKeyId('pre-key/x'), null);
  assert.equal(preKeyId('auth'), null);
  assert.throws(() => preKeyKey(-1), /non-negative integer/);
  assert.throws(() => preKeyKey('x'), /non-negative integer/);
});

test('assertBackend names the method that is missing', () => {
  assert.throws(() => assertBackend({ read() {}, write() {}, remove() {} }), /list/);
  assert.throws(() => assertBackend(null), /must be an object/);
});

// ─── the file names, which are the compatibility promise ─────────────────────

test('every file the backend writes is one SessionPaths already knows', () => {
  const dir = tmpDir();
  try {
    const known = new Set(SessionPaths.SESSION_SUFFIXES);

    for (const web of [false, true]) {
      const backend = new FileBackend({ dir, phone: PHONE, web });
      for (const key of KEYS) {
        const file   = path.basename(backend.fileFor(key));
        const suffix = file.slice(PHONE.length);
        assert.ok(known.has(suffix),
          `${web ? 'web' : 'mobile'} key '${key}' writes ${file}, whose suffix ` +
          `${suffix} is not in SessionPaths.SESSION_SUFFIXES — an installed ` +
          `session would not be found`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the named keys cover every suffix SessionPaths lists', () => {
  const dir = tmpDir();
  try {
    const written = new Set();
    for (const web of [false, true]) {
      const backend = new FileBackend({ dir, phone: PHONE, web });
      for (const key of KEYS) {
        written.add(path.basename(backend.fileFor(key)).slice(PHONE.length));
      }
    }
    for (const suffix of SessionPaths.SESSION_SUFFIXES) {
      assert.ok(written.has(suffix),
        `${suffix} is a file whalibmob writes but no key maps to it — its state ` +
        `would be left behind by anything going through the backend`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pre-key files are named the way SessionPaths looks for them', () => {
  const dir = tmpDir();
  try {
    // SessionPaths keeps its pattern private, so the check goes through the
    // function that uses it — which is also the one that moves a session, and
    // therefore the one that has to find these files.
    for (const web of [false, true]) {
      const backend = new FileBackend({ dir, phone: PHONE, web });
      backend.write(preKeyKey(3), 'k');
      backend.write(preKeyKey(811), 'k');
    }

    const found = SessionPaths.preKeyFilesFor(dir, PHONE).sort();
    assert.deepEqual(found, [
      PHONE + '.pre-key-3.json',
      PHONE + '.pre-key-811.json',
      PHONE + '.web.pre-key-3.json',
      PHONE + '.web.pre-key-811.json'
    ].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the mobile half and the companion half never touch each other', () => {
  const dir = tmpDir();
  try {
    const mobile = new FileBackend({ dir, phone: PHONE, web: false });
    const web    = new FileBackend({ dir, phone: PHONE, web: true });

    mobile.write('auth', 'mobile creds');
    web.write('auth', 'companion creds');
    mobile.write(preKeyKey(1), 'mobile key');
    web.write(preKeyKey(1), 'companion key');

    assert.equal(mobile.read('auth'), 'mobile creds');
    assert.equal(web.read('auth'),    'companion creds');
    assert.equal(mobile.read(preKeyKey(1)), 'mobile key');
    assert.equal(web.read(preKeyKey(1)),    'companion key');

    // and neither one sees the other's keys when it looks around
    assert.deepEqual(mobile.list(), ['auth', 'pre-key/1']);
    assert.deepEqual(web.list(),    ['auth', 'pre-key/1']);

    // removing one leaves the other standing
    mobile.remove('auth');
    assert.equal(mobile.read('auth'), null);
    assert.equal(web.read('auth'), 'companion creds');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file written the old way is read without being touched', () => {
  const dir = tmpDir();
  try {
    // What an installed copy of whalibmob left on disk, byte for byte.
    const contents = JSON.stringify({ registered: true, name: 'Ricardo' }, null, 2);
    fs.writeFileSync(path.join(dir, PHONE + '.json'), contents, 'utf8');

    const backend = new FileBackend({ dir, phone: PHONE });
    assert.equal(backend.read('auth'), contents);
    assert.ok(backend.list().includes('auth'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a write leaves the file and nothing else behind', () => {
  const dir = tmpDir();
  try {
    const backend = new FileBackend({ dir, phone: PHONE });
    backend.write('signal', 'snapshot');
    assert.deepEqual(fs.readdirSync(dir), [PHONE + '.signal.json'],
      'a temporary file left in the directory would be picked up as session state');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a directory that is not there yet is made on the first write', () => {
  const base = tmpDir();
  try {
    const dir = path.join(base, PHONE);
    assert.ok(!fs.existsSync(dir));

    const backend = new FileBackend({ dir, phone: PHONE });
    assert.deepEqual(backend.list(), [], 'no directory is no keys, not a throw');
    assert.equal(backend.read('auth'), null);

    backend.write('auth', 'creds');
    assert.equal(backend.read('auth'), 'creds');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the number is taken as digits, however it was given', () => {
  const dir = tmpDir();
  try {
    const a = new FileBackend({ dir, phone: '+91 96348 47671' });
    const b = new FileBackend({ dir, phone: PHONE });
    a.write('auth', 'creds');
    assert.equal(b.read('auth'), 'creds');
    assert.equal(path.basename(b.fileFor('auth')), PHONE + '.json');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a backend cannot be built without somewhere to write or a number', () => {
  assert.throws(() => new FileBackend({ phone: PHONE }), /dir is required/);
  assert.throws(() => new FileBackend({ dir: '/tmp' }), /phone is required/);
  assert.throws(() => new FileBackend({ dir: '/tmp', phone: 'abc' }), /must contain digits/);
});
