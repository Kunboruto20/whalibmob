'use strict';

// Where a session's state is kept.
//
// Every piece of state a number owns — the credentials, the Signal sessions,
// the sender keys, the app state, the pre-keys — is a named blob of text. Until
// now each of them knew it was a file and wrote itself to disk with its own
// fs.writeFileSync. That works, and it is what whalibmob still does; what it
// cannot do is be anything other than a file. A session that would rather live
// in one SQLite database than in 834 files has nowhere to say so.
//
// A backend is the one thing standing between the session and wherever its
// state actually goes. It handles four operations on a flat key space:
//
//   read(key)        the blob, or null when there is none
//   write(key, text) put it there, replacing whatever was there before
//   remove(key)      take it away; a key that is not there is not an error
//   list(prefix)     every key that starts with prefix
//
// That is the whole contract. Anything that can do those four can hold a
// session, and the session never learns which one it got.
//
// ─── Keys ───────────────────────────────────────────────────────────────────
//
// Keys are logical names, not file names. `signal` is the Signal snapshot
// whether it ends up as 919634847671.signal.json, a row in a table, or a value
// under a Redis hash — the backend decides. A key naming a file would put the
// file back into the contract and leave every other backend translating paths
// it has no use for.
//
// The names are fixed, because a session written by one backend has to be
// readable by the next:
//
//   auth                  the credentials, the store itself
//   signal                Signal sessions, identities, signed pre-keys
//   sender-key            group sender keys
//   tc-token              trusted-contact tokens
//   device-cache          the device list per contact
//   lid-mapping           phone → LID
//   lid-reverse-mapping   LID → phone
//   history               the history-sync backlog
//   messages              the message archive
//   app-state             app-state collections
//   app-state-keys        app-state sync keys
//   pre-key/<id>          one one-time pre-key, by id
//
// pre-key/<id> is the only key that is generated rather than named, and the
// only reason list() exists: there are 812 of them and they are asked for as a
// group. Hence the slash — a backend that wants to put them somewhere of their
// own has the prefix to key on, and `list('pre-key/')` is the way to find them
// all again.
//
// ─── Sync, not async ────────────────────────────────────────────────────────
//
// read/write/remove/list return values, not promises. Everything that writes
// session state in whalibmob writes it synchronously today, including the exit
// and SIGTERM handlers that flush the Signal store on the way out of the
// process — a handler that awaits is a handler whose write does not land. An
// async contract would mean rewriting all of that, and for what SQLite offers
// it buys nothing: better-sqlite3 is synchronous by design.
//
// It does rule out a backend that is a network round trip, Redis among them.
// That is a real limit and it is the price of not touching the exit path. When
// a network-backed store is worth having, it comes with an async contract
// alongside this one and a major version to go with it.

/**
 * @typedef {object} StorageBackend
 * @property {(key: string) => (string|null)} read
 * @property {(key: string, value: string) => void} write
 * @property {(key: string) => void} remove
 * @property {(prefix?: string) => string[]} list
 */

/** Every key that is a fixed name rather than one generated per record. */
const KEYS = Object.freeze([
  'auth',
  'signal',
  'sender-key',
  'tc-token',
  'device-cache',
  'lid-mapping',
  'lid-reverse-mapping',
  'history',
  'messages',
  'app-state',
  'app-state-keys'
]);

/** The prefix the per-record pre-key keys are built on. */
const PRE_KEY_PREFIX = 'pre-key/';

/** The key one pre-key id is stored under. */
function preKeyKey(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('preKeyKey: id must be a non-negative integer, got ' + id);
  }
  return PRE_KEY_PREFIX + n;
}

/** The id back out of a pre-key key, or null when the key is not one. */
function preKeyId(key) {
  if (typeof key !== 'string' || !key.startsWith(PRE_KEY_PREFIX)) return null;
  const rest = key.slice(PRE_KEY_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

/** Whether a string is a key any backend is required to accept. */
function isValidKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  return KEYS.includes(key) || preKeyId(key) !== null;
}

/**
 * Throw unless `backend` implements the contract.
 *
 * Called where a backend is accepted from outside, so that a missing method is
 * reported at the point it was handed over rather than hours later, from
 * inside a write, with a session half saved.
 */
function assertBackend(backend, what) {
  const label = what || 'backend';
  if (!backend || typeof backend !== 'object') {
    throw new TypeError(label + ' must be an object implementing the storage contract');
  }
  for (const method of ['read', 'write', 'remove', 'list']) {
    if (typeof backend[method] !== 'function') {
      throw new TypeError(label + ' is missing ' + method + '()');
    }
  }
  return backend;
}

module.exports = {
  KEYS,
  PRE_KEY_PREFIX,
  preKeyKey,
  preKeyId,
  isValidKey,
  assertBackend
};
