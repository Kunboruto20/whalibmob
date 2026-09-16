'use strict';

// A session that is never written down.
//
// It exists for two reasons. The first is tests: a contract this small is only
// worth having if every backend behaves the same way, and the way to know that
// is to run one suite against all of them — which needs a second backend that
// is obviously correct, so that a disagreement points at the one being judged
// rather than at the referee.
//
// The second is throwaway sessions. A companion link opened to read one thing
// and dropped, a number being tried out, a test against the live server — none
// of them want 834 files left behind in ~/.waSession. Handed this, they leave
// nothing at all; when the process ends the session is simply gone, and the
// device is unlinked or has to re-pair the next time.
//
// Which is also the warning. Nothing here survives the process. A registered
// number whose credentials only ever lived in memory is not recoverable — the
// registration is spent, the number is taken, and the keys that proved it was
// yours are gone. Use it for sessions that were never meant to outlive the run.

const { isValidKey } = require('./Backend');

class MemoryBackend {
  constructor() {
    this._data = new Map();
  }

  read(key) {
    this._assertKey(key);
    const v = this._data.get(key);
    return v === undefined ? null : v;
  }

  write(key, value) {
    this._assertKey(key);
    if (typeof value !== 'string') {
      throw new TypeError('MemoryBackend: value must be a string, got ' + typeof value);
    }
    this._data.set(key, value);
  }

  remove(key) {
    this._assertKey(key);
    this._data.delete(key);
  }

  list(prefix) {
    const want = prefix == null ? '' : String(prefix);
    return [...this._data.keys()].filter(k => k.startsWith(want)).sort();
  }

  /** How many keys are held. Not part of the contract — for tests. */
  get size() {
    return this._data.size;
  }

  /** Drop everything. Not part of the contract — for tests. */
  clear() {
    this._data.clear();
  }

  // The file backend rejects a key it has no file name for, so this one has to
  // reject it too — otherwise a typo passes in tests and fails in production,
  // which is the one failure a second implementation exists to catch.
  _assertKey(key) {
    if (!isValidKey(key)) {
      throw new Error('MemoryBackend: unknown key ' + JSON.stringify(key));
    }
  }
}

module.exports = { MemoryBackend };
