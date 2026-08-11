'use strict';

const fs   = require('fs');
const path = require('path');
const { newState, HASH_BYTES } = require('./LTHash');

// The collections app state is divided into. Which one a change belongs to is
// not ours to choose — the server sorts patches by collection and a mutation
// filed under the wrong one is refused.
const COLLECTIONS = [
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular'
];

/**
 * Where each collection has got to.
 *
 * This has to survive a restart or every reconnect asks for a full snapshot of
 * everything — slow, and it throws away the record of which index carried which
 * value, without which a later mutation cannot displace an earlier one.
 */
class AppStateStore {
  constructor(filePath) {
    this._path   = filePath;
    this._states = new Map();   // collection → { version, hash, indexValueMap }
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._path)) return;
      const raw = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      for (const [name, s] of Object.entries(raw)) {
        const hash = s.hash ? Buffer.from(s.hash, 'base64') : Buffer.alloc(HASH_BYTES);
        const map  = {};
        for (const [k, v] of Object.entries(s.indexValueMap || {})) {
          map[k] = { valueMac: Buffer.from(v, 'base64') };
        }
        this._states.set(name, {
          // A hash of the wrong length is not something to carry forward; the
          // arithmetic would be nonsense. Start that collection over instead.
          version:       hash.length === HASH_BYTES ? (Number(s.version) || 0) : 0,
          hash:          hash.length === HASH_BYTES ? hash : Buffer.alloc(HASH_BYTES),
          indexValueMap: hash.length === HASH_BYTES ? map  : {}
        });
      }
    } catch (_) {}
  }

  _save() {
    try {
      const dir = path.dirname(this._path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [name, s] of this._states) {
        const map = {};
        for (const [k, v] of Object.entries(s.indexValueMap || {})) {
          map[k] = Buffer.from(v.valueMac).toString('base64');
        }
        obj[name] = {
          version:       s.version || 0,
          hash:          Buffer.from(s.hash).toString('base64'),
          indexValueMap: map
        };
      }
      fs.writeFileSync(this._path, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }

  get(name) {
    if (!this._states.has(name)) this._states.set(name, newState());
    return this._states.get(name);
  }

  set(name, state) {
    this._states.set(name, {
      version:       state.version || 0,
      hash:          Buffer.from(state.hash),
      indexValueMap: state.indexValueMap || {}
    });
    this._save();
  }

  /** Forget a collection so the next sync asks for a snapshot of it. */
  reset(name) {
    this._states.set(name, newState());
    this._save();
  }

  versions() {
    const out = {};
    for (const name of COLLECTIONS) out[name] = this.get(name).version;
    return out;
  }
}

module.exports = { AppStateStore, COLLECTIONS };
