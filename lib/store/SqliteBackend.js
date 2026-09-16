'use strict';

// The session in one database instead of 834 files.
//
// A number's state is twenty-two named files plus a file for each of its 812
// one-time pre-keys. That works, and on a laptop nobody notices. On a phone
// under Termux, on a container with a small inode budget, or with fifty
// numbers in one folder, it is 40 000 files whose directory has to be read
// every time the pre-key pool is counted.
//
// The same state here is a handful of rows. A write is a transaction, so a
// process that dies mid-write leaves the previous value intact rather than a
// half-written file; and one database can hold every number and both of their
// halves at once, while each backend still sees only its own slice of it.
//
// ─── The driver ─────────────────────────────────────────────────────────────
//
// Node ships SQLite of its own from 22.5 as node:sqlite, synchronous and with
// nothing to install. That is what this uses when it is there, which keeps the
// promise whalibmob makes everywhere else in the library: no native build step,
// nothing for node-gyp to fail at, and Termux stays a place it runs.
//
// better-sqlite3 is accepted as well, for Node older than 22.5, and is used
// when node:sqlite is missing. It is a native module and has to compile, which
// is why it is not the one reached for first and why it is not a dependency of
// this package.
//
// ─── Why the values are BLOBs ───────────────────────────────────────────────
//
// node:sqlite binds a JavaScript string to a TEXT column as a C string, and a
// C string stops at the first NUL. A value carrying one is silently cut short
// — the session still loads, the keys in it are simply wrong from that byte
// on, which is the worst way for a bug like this to present. Bound as a BLOB
// the bytes go in and come back exactly, whatever is in them, so that is what
// the column is and the conversion happens here rather than in the caller.

const path = require('path');
const fs   = require('fs');

const { preKeyId, isValidKey } = require('./Backend');

// Bumped when the shape of the table changes; kept in the file's user_version.
const SCHEMA_VERSION = 1;

const TABLE = 'session_state';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  phone TEXT NOT NULL,
  half  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (phone, half, key)
) WITHOUT ROWID;
`;

// ─── Driver detection ────────────────────────────────────────────────────────

let _driverCache;

/**
 * Load node:sqlite without its ExperimentalWarning reaching the console.
 *
 * The warning is true and it is also not the user's business: they asked
 * whalibmob for a session store, not for a lecture about a Node flag they did
 * not set. Only that one warning is swallowed, and only around this require —
 * anything else Node has to say still gets through.
 */
function _requireNodeSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const name = (rest[0] && rest[0].type) || rest[0];
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (name === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

/**
 * The SQLite driver available here, as a uniform shape.
 *
 * @param {string} [prefer] 'node' or 'better-sqlite3' to demand one
 * @returns {{ name: string, open: (file: string) => object }}
 */
function resolveDriver(prefer) {
  if (!prefer && _driverCache) return _driverCache;

  const tryNode = () => {
    let sqlite;
    try { sqlite = _requireNodeSqlite(); } catch (_) { return null; }
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return null;
    return {
      name: 'node:sqlite',
      open: (file) => new sqlite.DatabaseSync(file)
    };
  };

  const tryBetter = () => {
    let Database;
    try { Database = require('better-sqlite3'); } catch (_) { return null; }
    return {
      name: 'better-sqlite3',
      open: (file) => new Database(file)
    };
  };

  let driver = null;
  if (prefer === 'node')                 driver = tryNode();
  else if (prefer === 'better-sqlite3')  driver = tryBetter();
  else                                   driver = tryNode() || tryBetter();

  if (!driver) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    const tooOld = major < 22 || (major === 22 && minor < 5);
    throw new Error(
      'SqliteBackend: no SQLite driver available.\n' +
      (tooOld
        ? `  Node ${process.versions.node} has no built-in SQLite — it arrives in 22.5.0.\n` +
          '  Either upgrade Node, or install the fallback driver:\n' +
          '      npm install better-sqlite3\n'
        : `  node:sqlite should be present on Node ${process.versions.node} but could not ` +
          'be loaded.\n  Install the fallback driver instead:\n' +
          '      npm install better-sqlite3\n') +
      '  Or leave it out entirely: the default FileBackend needs nothing installed.'
    );
  }

  if (!prefer) _driverCache = driver;
  return driver;
}

// ─── Connections ─────────────────────────────────────────────────────────────
//
// A number's two halves are two backends over one file, and fifty numbers in
// one database are a hundred. Each opening its own handle would be a hundred
// handles onto the same file for no reason, so they are shared by resolved
// path and counted, and the file is closed when the last backend using it
// lets go.

const _open = new Map();   // resolved path → { db, driver, refs }

function _acquire(file, prefer) {
  const key = path.resolve(file);
  const existing = _open.get(key);
  if (existing) { existing.refs++; return existing; }

  const dir = path.dirname(key);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const driver = resolveDriver(prefer);
  const db = driver.open(key);

  // WAL lets a reader and a writer work at once, which is what a client
  // flushing its Signal store while another reads the pre-key pool is doing.
  // NORMAL is the synchronous level WAL is designed around: a crash of the
  // process cannot lose a committed transaction, only a crash of the machine
  // can, and paying FULL for every pre-key write is not worth that.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const found = db.prepare('PRAGMA user_version').get();
  const version = found ? Number(found.user_version) : 0;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `SqliteBackend: ${key} was written by a newer whalibmob (schema ` +
      `${version}, this one understands ${SCHEMA_VERSION}). Upgrade whalibmob ` +
      'rather than letting an older release write to it.'
    );
  }
  if (version < SCHEMA_VERSION) db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);

  const entry = { db, driver, refs: 1, key };
  _open.set(key, entry);
  return entry;
}

// The count belongs to the shared entry; remembering that you have already let
// go belongs to whoever is letting go. Keeping that flag on the entry would
// mean the first backend to close it stopped every other one from ever
// decrementing, and the file would stay open for the life of the process.
function _release(entry) {
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  _open.delete(entry.key);
  try { entry.db.close(); } catch (_) {}
}

// ─── The backend ─────────────────────────────────────────────────────────────

class SqliteBackend {
  /**
   * @param {object} opts
   * @param {string} opts.path     the database file; created if missing
   * @param {string} opts.phone    the number, digits only
   * @param {boolean} [opts.web]   the companion half rather than the mobile one
   * @param {string} [opts.driver] 'node' or 'better-sqlite3' to demand one
   */
  constructor(opts) {
    if (!opts || !opts.path) throw new TypeError('SqliteBackend: path is required');
    if (!opts.phone)         throw new TypeError('SqliteBackend: phone is required');

    this.path  = String(opts.path);
    this.phone = String(opts.phone).replace(/\D/g, '');
    this.web   = !!opts.web;

    if (!this.phone) throw new TypeError('SqliteBackend: phone must contain digits');

    this._half = this.web ? 'web' : 'mobile';
    this._conn = _acquire(this.path, opts.driver);
    this.driver = this._conn.driver.name;

    const db = this._conn.db;
    // Prepared once. A pre-key sweep runs these 812 times and re-preparing the
    // statement each time is most of what it would cost.
    this._get = db.prepare(
      `SELECT value FROM ${TABLE} WHERE phone = ? AND half = ? AND key = ?`);
    this._put = db.prepare(
      `INSERT INTO ${TABLE} (phone, half, key, value) VALUES (?, ?, ?, ?) ` +
      'ON CONFLICT(phone, half, key) DO UPDATE SET value = excluded.value');
    this._del = db.prepare(
      `DELETE FROM ${TABLE} WHERE phone = ? AND half = ? AND key = ?`);
    this._keys = db.prepare(
      `SELECT key FROM ${TABLE} WHERE phone = ? AND half = ?`);
  }

  _assertKey(key) {
    if (!isValidKey(key)) {
      throw new Error('SqliteBackend: unknown key ' + JSON.stringify(key));
    }
    return key;
  }

  read(key) {
    this._assertKey(key);
    const row = this._get.get(this.phone, this._half, key);
    if (!row || row.value == null) return null;
    // node:sqlite hands a BLOB back as a Uint8Array, better-sqlite3 as a
    // Buffer. Buffer.from copes with either without copying twice.
    return Buffer.from(row.value).toString('utf8');
  }

  write(key, value) {
    this._assertKey(key);
    if (typeof value !== 'string') {
      throw new TypeError('SqliteBackend: value must be a string, got ' + typeof value);
    }
    this._put.run(this.phone, this._half, key, Buffer.from(value, 'utf8'));
  }

  remove(key) {
    this._assertKey(key);
    this._del.run(this.phone, this._half, key);
  }

  list(prefix) {
    const want = prefix == null ? '' : String(prefix);
    const out = [];
    for (const row of this._keys.all(this.phone, this._half)) {
      if (row.key.startsWith(want)) out.push(row.key);
    }
    return out.sort();
  }

  // ── beyond the contract ───────────────────────────────────────────────────

  /**
   * Let go of the database.
   *
   * The file is shared between every backend opened on it, so it is closed
   * once the last of them has called this. Calling it twice is harmless; using
   * the backend afterwards is not, and throws.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    _release(this._conn);
  }

  /** Every number the database holds, as `{ phone, half }`. */
  static sessionsIn(file, opts) {
    const conn = _acquire(file, opts && opts.driver);
    try {
      return conn.db
        .prepare(`SELECT DISTINCT phone, half FROM ${TABLE} ORDER BY phone, half`)
        .all()
        .map(r => ({ phone: r.phone, half: r.half, web: r.half === 'web' }));
    } finally {
      _release(conn);
    }
  }
}

SqliteBackend.SCHEMA_VERSION = SCHEMA_VERSION;
SqliteBackend.TABLE = TABLE;
SqliteBackend.resolveDriver = resolveDriver;

module.exports = { SqliteBackend, resolveDriver, SCHEMA_VERSION };
