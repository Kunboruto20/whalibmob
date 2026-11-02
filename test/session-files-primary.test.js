'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SessionPaths = require('../lib/SessionPaths');

// The files the primary-side message store and the link journal leave beside a
// number's other state. A move that does not carry them strands a number's
// message history and its half-finished link attempts in the old place.
const PRIMARY_SUFFIXES = [
  '.primary-messages.log',
  '.primary-messages.json',
  '.primary-history-outbox.json',
  '.primary-linking.json'
];

// Held while a link attempt is in flight. It belongs to a process, not to a
// number, and must never follow a session to a new place.
const LINK_LOCK_SUFFIX = '.primary-linking.json.lock';

const PHONE = '919634847671';

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whalibmob-primary-files-'));
}

test('session move carries primary files but not the link lock', () => {
  const base = tmpBase();
  try {
    for (const suffix of PRIMARY_SUFFIXES.concat(LINK_LOCK_SUFFIX)) {
      fs.writeFileSync(path.join(base, PHONE + suffix), 'body of ' + suffix);
    }

    const r = SessionPaths.migrateSession(base, PHONE);
    const to = path.join(base, PHONE);

    for (const suffix of PRIMARY_SUFFIXES) {
      const name = PHONE + suffix;
      assert.ok(r.moved.includes(name), name + ' must be reported as moved');
      assert.equal(fs.existsSync(path.join(base, name)), false, name + ' must leave the old place');
      assert.equal(
        fs.readFileSync(path.join(to, name), 'utf8'), 'body of ' + suffix,
        name + ' must arrive intact'
      );
    }

    // The lock is not carried: it is not reported, not at the destination, and
    // still where it was.
    const lock = PHONE + LINK_LOCK_SUFFIX;
    assert.ok(!r.moved.includes(lock), 'the lock must not be moved');
    assert.equal(fs.existsSync(path.join(to, lock)), false, 'the lock must not reach the destination');
    assert.equal(fs.existsSync(path.join(base, lock)), true, 'the lock stays behind');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the companion half of a session carries its primary files too', () => {
  const base = tmpBase();
  try {
    for (const suffix of PRIMARY_SUFFIXES) {
      fs.writeFileSync(path.join(base, PHONE + '.web' + suffix), 'web ' + suffix);
    }
    fs.writeFileSync(path.join(base, PHONE + '.web' + LINK_LOCK_SUFFIX), '');

    const r = SessionPaths.migrateSession(base, PHONE);
    const to = path.join(base, PHONE);

    for (const suffix of PRIMARY_SUFFIXES) {
      const name = PHONE + '.web' + suffix;
      assert.ok(r.moved.includes(name), name + ' must be reported as moved');
      assert.equal(fs.existsSync(path.join(base, name)), false, name + ' must leave the old place');
      assert.equal(fs.readFileSync(path.join(to, name), 'utf8'), 'web ' + suffix);
    }
    assert.equal(fs.existsSync(path.join(to, PHONE + '.web' + LINK_LOCK_SUFFIX)), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the primary files are in SESSION_SUFFIXES for both halves, the lock in neither', () => {
  const known = new Set(SessionPaths.SESSION_SUFFIXES);
  for (const suffix of PRIMARY_SUFFIXES) {
    assert.ok(known.has(suffix), suffix + ' missing from the mobile half');
    assert.ok(known.has('.web' + suffix), '.web' + suffix + ' missing from the companion half');
  }
  assert.ok(!known.has(LINK_LOCK_SUFFIX));
  assert.ok(!known.has('.web' + LINK_LOCK_SUFFIX));
});

test('the backend keys map to those same suffixes', () => {
  const { KEYS } = require('../lib/store/Backend');
  const { FileBackend } = require('../lib/store/FileBackend');
  const expected = {
    'primary-messages-log':   '.primary-messages.log',
    'primary-messages':       '.primary-messages.json',
    'primary-history-outbox': '.primary-history-outbox.json',
    'primary-linking':        '.primary-linking.json'
  };
  const dir = tmpBase();
  try {
    for (const web of [false, true]) {
      const backend = new FileBackend({ dir, phone: PHONE, web });
      for (const [key, suffix] of Object.entries(expected)) {
        assert.ok(KEYS.includes(key), key + ' must be a fixed key');
        assert.equal(
          path.basename(backend.fileFor(key)),
          PHONE + (web ? '.web' : '') + suffix
        );
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-filing a session under its canonical number renames the primary files, not the lock', async () => {
  // adoptCanonicalNumber walks the same list as a move, but renames in place.
  const { WhalibmobClient } = require('../lib/Client');
  const { createNewStore, saveStore } = require('../lib/Store');

  const base = tmpBase();
  try {
    const canonical = PHONE + '0';
    const dir = path.join(base, PHONE);
    const store = createNewStore(PHONE);
    saveStore(store, path.join(dir, PHONE + '.json'));
    for (const suffix of PRIMARY_SUFFIXES.concat(LINK_LOCK_SUFFIX)) {
      fs.writeFileSync(path.join(dir, PHONE + suffix), 'body of ' + suffix);
    }

    const client = Object.create(WhalibmobClient.prototype);
    Object.assign(client, { _store: store, _sessionDir: dir, _baseDir: base, _connected: false });
    const r = await client.adoptCanonicalNumber(canonical);
    assert.equal(r.renamed, true);

    const to = path.join(base, canonical);
    for (const suffix of PRIMARY_SUFFIXES) {
      assert.equal(
        fs.readFileSync(path.join(to, canonical + suffix), 'utf8'), 'body of ' + suffix,
        suffix + ' must follow the number'
      );
      assert.equal(fs.existsSync(path.join(to, PHONE + suffix)), false, suffix + ' must not keep the old name');
    }
    assert.equal(fs.existsSync(path.join(to, canonical + LINK_LOCK_SUFFIX)), false,
      'the lock is never renamed to the new number');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
