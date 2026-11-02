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
  // Empty; its mtime is when the store's disk began refusing writes it has not
  // written down yet. It is the store's, so it goes where the store goes.
  '.primary-messages.write-failed',
  '.primary-history-outbox.json',
  '.primary-linking.json'
];
const MARKER_SUFFIX = '.primary-messages.write-failed';
const MARKER_TIME = new Date('2026-09-03T10:00:00Z');

// Held while a link attempt is in flight. It belongs to a process, not to a
// number, and must never follow a session to a new place.
const LINK_LOCK_SUFFIX = '.primary-linking.json.lock';
// Held by the process that has the message store open. The same: never moved.
const STORE_LOCK_SUFFIX = '.primary-messages.lock';
const LOCK_SUFFIXES = [LINK_LOCK_SUFFIX, STORE_LOCK_SUFFIX];

const PHONE = '919634847671';

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whalibmob-primary-files-'));
}

test('session move carries primary files but not the locks', () => {
  const base = tmpBase();
  try {
    for (const suffix of PRIMARY_SUFFIXES.concat(LOCK_SUFFIXES)) {
      fs.writeFileSync(path.join(base, PHONE + suffix), 'body of ' + suffix);
    }
    fs.utimesSync(path.join(base, PHONE + MARKER_SUFFIX), MARKER_TIME, MARKER_TIME);

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
    // What the marker says is its time, and the move keeps it.
    assert.equal(fs.statSync(path.join(to, PHONE + MARKER_SUFFIX)).mtimeMs, MARKER_TIME.getTime());

    // The locks are not carried: not reported, not at the destination, and
    // still where they were.
    for (const suffix of LOCK_SUFFIXES) {
      const lock = PHONE + suffix;
      assert.ok(!r.moved.includes(lock), lock + ' must not be moved');
      assert.equal(fs.existsSync(path.join(to, lock)), false, lock + ' must not reach the destination');
      assert.equal(fs.readFileSync(path.join(base, lock), 'utf8'), 'body of ' + suffix, lock + ' stays behind, untouched');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the companion half of a session carries its primary files too', () => {
  const base = tmpBase();
  try {
    for (const suffix of PRIMARY_SUFFIXES) {
      fs.writeFileSync(path.join(base, PHONE + '.web' + suffix), 'web ' + suffix);
    }
    for (const suffix of LOCK_SUFFIXES) fs.writeFileSync(path.join(base, PHONE + '.web' + suffix), '');

    const r = SessionPaths.migrateSession(base, PHONE);
    const to = path.join(base, PHONE);

    for (const suffix of PRIMARY_SUFFIXES) {
      const name = PHONE + '.web' + suffix;
      assert.ok(r.moved.includes(name), name + ' must be reported as moved');
      assert.equal(fs.existsSync(path.join(base, name)), false, name + ' must leave the old place');
      assert.equal(fs.readFileSync(path.join(to, name), 'utf8'), 'web ' + suffix);
    }
    for (const suffix of LOCK_SUFFIXES) {
      assert.equal(fs.existsSync(path.join(to, PHONE + '.web' + suffix)), false);
      assert.equal(fs.existsSync(path.join(base, PHONE + '.web' + suffix)), true);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the primary files are in SESSION_SUFFIXES for both halves, the locks in neither', () => {
  const known = new Set(SessionPaths.SESSION_SUFFIXES);
  for (const suffix of PRIMARY_SUFFIXES) {
    assert.ok(known.has(suffix), suffix + ' missing from the mobile half');
    assert.ok(known.has('.web' + suffix), '.web' + suffix + ' missing from the companion half');
  }
  for (const suffix of LOCK_SUFFIXES) {
    assert.ok(!known.has(suffix), suffix);
    assert.ok(!known.has('.web' + suffix), '.web' + suffix);
  }
});

test('the backend keys map to those same suffixes', () => {
  const { KEYS } = require('../lib/store/Backend');
  const { FileBackend } = require('../lib/store/FileBackend');
  const expected = {
    'primary-messages-log':   '.primary-messages.log',
    'primary-messages':       '.primary-messages.json',
    'primary-messages-write-failed': '.primary-messages.write-failed',
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

// The link journal is bound to the number it was written for: its body embeds a
// digest of the phone and the identity key, and the store refuses a file whose
// digest differs. A move to a new directory keeps the number, so it carries the
// journal; re-filing the session under another number must not rename it.
const LINK_JOURNAL_SUFFIX = '.primary-linking.json';

test('re-filing a session under its canonical number renames the message files, leaves the link journal and lock', async () => {
  // adoptCanonicalNumber walks the same list as a move, but renames in place.
  const { WhalibmobClient } = require('../lib/Client');
  const { createNewStore, saveStore } = require('../lib/Store');

  const base = tmpBase();
  try {
    const canonical = PHONE + '0';
    const dir = path.join(base, PHONE);
    const store = createNewStore(PHONE);
    saveStore(store, path.join(dir, PHONE + '.json'));
    for (const suffix of PRIMARY_SUFFIXES.concat(LOCK_SUFFIXES)) {
      fs.writeFileSync(path.join(dir, PHONE + suffix), 'body of ' + suffix);
    }
    fs.utimesSync(path.join(dir, PHONE + MARKER_SUFFIX), MARKER_TIME, MARKER_TIME);

    const client = Object.create(WhalibmobClient.prototype);
    Object.assign(client, { _store: store, _sessionDir: dir, _baseDir: base, _connected: false });
    const r = await client.adoptCanonicalNumber(canonical);
    assert.equal(r.renamed, true);

    // The directory was renamed with the number, so "the old name" is the old
    // number's file name inside the new directory.
    const to = path.join(base, canonical);

    for (const suffix of PRIMARY_SUFFIXES.filter(x => x !== LINK_JOURNAL_SUFFIX)) {
      assert.equal(
        fs.readFileSync(path.join(to, canonical + suffix), 'utf8'), 'body of ' + suffix,
        suffix + ' must follow the number'
      );
      assert.equal(fs.existsSync(path.join(to, PHONE + suffix)), false, suffix + ' must not keep the old name');
    }
    // The store's marker follows the store, its time with it.
    assert.ok(r.files.includes(MARKER_SUFFIX), 'the marker is reported as renamed');
    assert.equal(fs.statSync(path.join(to, canonical + MARKER_SUFFIX)).mtimeMs, MARKER_TIME.getTime());

    // Neither lock is renamed to the new number: each stays under the old name.
    for (const suffix of [LINK_JOURNAL_SUFFIX].concat(LOCK_SUFFIXES)) {
      assert.equal(
        fs.readFileSync(path.join(to, PHONE + suffix), 'utf8'), 'body of ' + suffix,
        suffix + ' stays under the old number, untouched'
      );
      assert.equal(fs.existsSync(path.join(to, canonical + suffix)), false,
        suffix + ' must not appear under the canonical number');
    }
    assert.ok(!r.files.includes(LINK_JOURNAL_SUFFIX), 'the journal is not reported as renamed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a link journal left under the old number does not block linking for the canonical one', async () => {
  const { WhalibmobClient } = require('../lib/Client');
  const { PrimaryLinking } = require('../lib/PrimaryLinking');
  const { createNewStore, saveStore } = require('../lib/Store');

  const base = tmpBase();
  try {
    const canonical = PHONE + '0';
    const dir = path.join(base, PHONE);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = createNewStore(PHONE);
    store.registered = true;
    saveStore(store, path.join(dir, PHONE + '.json'));

    const client = Object.create(WhalibmobClient.prototype);
    Object.assign(client, {
      _store: store, _sessionDir: dir, _baseDir: base, _connected: false, _mode: 'mobile'
    });

    // A journal written for the number as it was.
    const before = new PrimaryLinking(client);
    before.journal.close();
    assert.ok(fs.existsSync(path.join(dir, PHONE + LINK_JOURNAL_SUFFIX)));

    await client.adoptCanonicalNumber(canonical);

    // The journal's binding names the old number, so a journal carried across
    // under the new name would be rejected. Left behind, it is simply not seen.
    let after;
    assert.doesNotThrow(() => { after = new PrimaryLinking(client); });
    try {
      assert.equal(
        after.journal.filename,
        path.join(base, canonical, canonical + LINK_JOURNAL_SUFFIX)
      );
      assert.ok(fs.existsSync(after.journal.filename), 'a fresh journal is created for the canonical number');
    } finally { after.journal.close(); }
    assert.ok(fs.existsSync(path.join(base, canonical, PHONE + LINK_JOURNAL_SUFFIX)),
      'the old number journal is left where it was');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('every phone-bound suffix is a real session suffix', () => {
  // The exclusion is a subset of the one list, not a second list: a suffix
  // that is excluded but not listed would be a typo that excludes nothing.
  assert.ok(Array.isArray(SessionPaths.PHONE_BOUND_SUFFIXES));
  for (const suffix of SessionPaths.PHONE_BOUND_SUFFIXES) {
    assert.ok(SessionPaths.SESSION_SUFFIXES.includes(suffix), suffix + ' is not in SESSION_SUFFIXES');
  }
  assert.ok(SessionPaths.PHONE_BOUND_SUFFIXES.includes(LINK_JOURNAL_SUFFIX));
  assert.ok(SessionPaths.PHONE_BOUND_SUFFIXES.includes('.web' + LINK_JOURNAL_SUFFIX));
  for (const suffix of PRIMARY_SUFFIXES.filter(x => x !== LINK_JOURNAL_SUFFIX)) {
    assert.ok(!SessionPaths.PHONE_BOUND_SUFFIXES.includes(suffix), suffix + ' is not phone-bound');
  }
});
