'use strict';

// The session on disk, as JSON files — what whalibmob has always done.
//
// This is the default and it writes exactly the files the library wrote
// before there was a backend at all: same directory, same names, same
// contents. A session saved by an older version opens here without being
// touched, and one saved here opens in an older version. The file names are
// the contract with everything already installed, so they are settled in the
// table below and not derived anywhere else.
//
// A number has two halves that never share state — the one registered over
// the Mobile API and the companion linked over the Web API — and a backend
// covers one of them. Which one is decided by `web` at construction, and it
// is the whole difference between the two: the companion's files carry .web
// ahead of the suffix, so 919634847671.signal.json and
// 919634847671.web.signal.json sit side by side in one directory without ever
// being confused for each other.
//
// Writes go to a temporary file and are renamed into place. The old code
// wrote some files straight and others through a rename; doing it one way
// everywhere costs nothing and means a session cannot be left half written by
// a process that died mid-write — which, for the file holding a number's
// identity keys, is the difference between a session and a lost number.

const fs   = require('fs');
const path = require('path');

const { preKeyId } = require('./Backend');

// key → the part of the file name that follows the number (and the .web that
// marks the companion half). These are the names in SessionPaths.SESSION_SUFFIXES;
// the two lists describe the same files and have to stay in step.
const KEY_SUFFIX = Object.freeze({
  'auth':                '.json',
  'signal':              '.signal.json',
  'sender-key':          '.sk.json',
  'tc-token':            '.tctoken.json',
  'device-cache':        '.device-cache.json',
  'lid-mapping':         '.lid-mapping.json',
  'lid-reverse-mapping': '.lid-reverse-mapping.json',
  'history':             '.history.json',
  'messages':            '.messages.json',
  'app-state':           '.appState.json',
  'app-state-keys':      '.appStateKeys.json'
});

// The one-time pre-keys are a file each, named by id.
const PRE_KEY_INFIX = '.pre-key-';

function _escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class FileBackend {
  /**
   * @param {object} opts
   * @param {string} opts.dir    the directory this session's files live in
   * @param {string} opts.phone  the number, digits only
   * @param {boolean} [opts.web] the companion half rather than the mobile one
   */
  constructor(opts) {
    if (!opts || !opts.dir) throw new TypeError('FileBackend: dir is required');
    if (!opts.phone)        throw new TypeError('FileBackend: phone is required');

    this.dir   = String(opts.dir);
    this.phone = String(opts.phone).replace(/\D/g, '');
    this.web   = !!opts.web;

    if (!this.phone) throw new TypeError('FileBackend: phone must contain digits');

    // <phone> for the mobile half, <phone>.web for the companion.
    this._stem = this.phone + (this.web ? '.web' : '');
  }

  /** The file a key is kept in. Absolute, whether or not it exists. */
  fileFor(key) {
    const id = preKeyId(key);
    if (id !== null) {
      return path.join(this.dir, this._stem + PRE_KEY_INFIX + id + '.json');
    }
    const suffix = KEY_SUFFIX[key];
    if (!suffix) throw new Error('FileBackend: unknown key ' + JSON.stringify(key));
    return path.join(this.dir, this._stem + suffix);
  }

  read(key) {
    let raw;
    try {
      raw = fs.readFileSync(this.fileFor(key), 'utf8');
    } catch (err) {
      // A key that was never written reads as absent, the way a fresh session
      // reads. Anything else — a permission problem, a directory where a file
      // should be — is the caller's to know about, because silently treating
      // it as absent starts a brand new session over the top of a real one.
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw err;
    }
    return raw;
  }

  write(key, value) {
    if (typeof value !== 'string') {
      throw new TypeError('FileBackend: value must be a string, got ' + typeof value);
    }
    const file = this.fileFor(key);
    const dir  = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Rename is atomic within a filesystem, so a reader sees either the whole
    // old file or the whole new one and never the half-written middle. The
    // temporary name carries the pid so two processes writing one session do
    // not land on each other's scratch file.
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    try {
      fs.writeFileSync(tmp, value, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
  }

  remove(key) {
    try {
      fs.unlinkSync(this.fileFor(key));
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
      throw err;
    }
  }

  list(prefix) {
    const want = prefix == null ? '' : String(prefix);

    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch (_) {
      return [];   // no directory yet is no keys, not an error
    }

    const found = [];

    // The pre-keys, by name. The mobile half must not pick up the companion's:
    // <phone>.pre-key-1.json and <phone>.web.pre-key-1.json both start with the
    // number, so the stem — which carries the .web or does not — is what the
    // pattern is anchored on.
    const preKeyRe = new RegExp(
      '^' + _escapeRe(this._stem + PRE_KEY_INFIX) + '(\\d+)\\.json$');

    for (const name of entries) {
      const m = preKeyRe.exec(name);
      if (!m) continue;
      const key = 'pre-key/' + Number(m[1]);
      if (key.startsWith(want)) found.push(key);
    }

    // The named keys. Read off the file names rather than statted one by one,
    // so a directory of 812 pre-keys is still one readdir.
    const present = new Set(entries);
    for (const key of Object.keys(KEY_SUFFIX)) {
      if (!key.startsWith(want)) continue;
      if (present.has(this._stem + KEY_SUFFIX[key])) found.push(key);
    }

    return found.sort();
  }
}

// The name table hangs off the class rather than travelling as a second export:
// anything that needs it — a tool migrating a session between backends, say —
// has the class already, and a loose export of the same object would be one more
// thing to keep reachable from the package for no gain.
FileBackend.KEY_SUFFIX    = KEY_SUFFIX;
FileBackend.PRE_KEY_INFIX = PRE_KEY_INFIX;

module.exports = { FileBackend };
