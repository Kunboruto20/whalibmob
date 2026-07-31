'use strict';

// Where a session's files live.
//
// Everything a number owns — the store, the Signal sessions, the sender keys,
// the app state, the device cache, the LID maps, the history — used to sit
// side by side in one directory, named after the number:
//
//   ~/.waSession/40756469325.json
//   ~/.waSession/40756469325.signal.json
//   ~/.waSession/40756469325.sk.json
//   ...  × 11 files × every number
//
// Fifty numbers made that five hundred files in one place, with no way to move,
// back up or delete one account without picking its files out of the pile by
// prefix. A number now gets a directory of its own:
//
//   <base>/40756469325/40756469325.json
//   <base>/40756469325/40756469325.signal.json
//   ...
//
// The file names inside are unchanged, so every path built as
// `join(sessionDir, phone + suffix)` keeps working — what changes is which
// directory `sessionDir` points at. Callers ask sessionDirFor() for it.
//
// A directory laid out the old way keeps working exactly as it was. The layout
// is decided per number, by looking for the file that must exist either way, so
// an existing installation is never asked to move anything and a number that
// has been moved is picked up on its own.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// The file every session has, in either layout, and the one whose presence
// decides which layout a number is on.
const STORE_SUFFIX     = '.json';
const WEB_STORE_SUFFIX = '.web.json';

// Every per-number file whalibmob writes. Kept here so that moving a session
// moves all of it — a list that goes out of date silently leaves a number's
// Signal sessions behind and looks like a working move until the first message
// fails to decrypt.
const SESSION_SUFFIXES = [
  '.json',
  '.signal.json',
  '.sk.json',
  '.tctoken.json',
  '.device-cache.json',
  '.lid-mapping.json',
  '.lid-reverse-mapping.json',
  '.history.json',
  '.messages.json',
  '.appState.json',
  '.appStateKeys.json',
  // The companion (pairing-code) half of the same number.
  '.web.json',
  '.web.signal.json',
  '.web.sk.json',
  '.web.tctoken.json',
  '.web.device-cache.json',
  '.web.lid-mapping.json',
  '.web.lid-reverse-mapping.json',
  '.web.history.json',
  '.web.messages.json',
  '.web.appState.json',
  '.web.appStateKeys.json'
];

// Files that belong to the installation rather than to any number, and stay at
// the top of the base directory.
const SHARED_FILES = [
  'android-apk-material.json',
  'android-apk-material-business.json'
];

function defaultBaseDir() {
  return process.env.WA_SESSION_DIR || path.join(os.homedir(), '.waSession');
}

function _isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function _exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

/**
 * Whether this number's files sit loose in the base directory rather than in
 * one of its own.
 *
 * Only true for a number that is already there in the old shape: a number with
 * no files at all is not legacy, it is new, and new numbers get a directory.
 */
function isLegacyLayout(baseDir, phone) {
  phone = String(phone).replace(/\D/g, '');
  if (_exists(path.join(baseDir, phone, phone + STORE_SUFFIX)) ||
      _exists(path.join(baseDir, phone, phone + WEB_STORE_SUFFIX))) {
    return false;
  }
  return _exists(path.join(baseDir, phone + STORE_SUFFIX)) ||
         _exists(path.join(baseDir, phone + WEB_STORE_SUFFIX));
}

/**
 * The directory a number's files belong in.
 *
 * @param {string} baseDir  the authentication folder
 * @param {string} phone    digits
 * @param {object} [opts]   { create } to make the directory if it is missing
 */
function sessionDirFor(baseDir, phone, opts) {
  phone = String(phone).replace(/\D/g, '');
  if (isLegacyLayout(baseDir, phone)) return baseDir;

  const dir = path.join(baseDir, phone);
  if (opts && opts.create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The store file for a number, wherever it lives. */
function storeFileFor(baseDir, phone) {
  phone = String(phone).replace(/\D/g, '');
  return path.join(sessionDirFor(baseDir, phone), phone + STORE_SUFFIX);
}

/** The companion store file for a number, wherever it lives. */
function webStoreFileFor(baseDir, phone) {
  phone = String(phone).replace(/\D/g, '');
  return path.join(sessionDirFor(baseDir, phone), phone + WEB_STORE_SUFFIX);
}

/**
 * Every number the base directory holds, in either layout.
 *
 * @returns {Array<{phone, dir, storeFile, webStoreFile, legacy, hasMobile, hasWeb}>}
 */
function listSessions(baseDir) {
  let entries;
  try { entries = fs.readdirSync(baseDir); } catch (_) { return []; }

  const found = new Map();

  const note = (phone, dir, legacy) => {
    if (!found.has(phone)) {
      found.set(phone, {
        phone,
        dir,
        storeFile:    path.join(dir, phone + STORE_SUFFIX),
        webStoreFile: path.join(dir, phone + WEB_STORE_SUFFIX),
        legacy,
        hasMobile: _exists(path.join(dir, phone + STORE_SUFFIX)),
        hasWeb:    _exists(path.join(dir, phone + WEB_STORE_SUFFIX))
      });
    }
  };

  // A directory named after a number, holding that number's store.
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = path.join(baseDir, entry);
    if (!_isDir(dir)) continue;
    if (_exists(path.join(dir, entry + STORE_SUFFIX)) ||
        _exists(path.join(dir, entry + WEB_STORE_SUFFIX))) {
      note(entry, dir, false);
    }
  }

  // Loose files from the old layout, for numbers not already found above.
  for (const entry of entries) {
    const m = /^(\d+)(\.web)?\.json$/.exec(entry);
    if (!m) continue;
    note(m[1], baseDir, true);
  }

  return [...found.values()].sort((a, b) => a.phone.localeCompare(b.phone));
}

/**
 * Move a number out of the old flat layout into a directory of its own.
 *
 * Every file listed in SESSION_SUFFIXES that exists is moved; anything already
 * present at the destination is left alone and reported rather than
 * overwritten, so a half-finished move can be run again safely.
 *
 * @returns {{phone, from, to, moved: string[], skipped: string[]}}
 */
function migrateSession(baseDir, phone) {
  phone = String(phone).replace(/\D/g, '');
  const to = path.join(baseDir, phone);

  const moved = [], skipped = [];
  fs.mkdirSync(to, { recursive: true });

  for (const suffix of SESSION_SUFFIXES) {
    const from = path.join(baseDir, phone + suffix);
    if (!_exists(from)) continue;
    const dest = path.join(to, phone + suffix);
    if (_exists(dest)) { skipped.push(phone + suffix); continue; }
    fs.renameSync(from, dest);
    moved.push(phone + suffix);
  }

  return { phone, from: baseDir, to, moved, skipped };
}

module.exports = {
  defaultBaseDir,
  isLegacyLayout,
  sessionDirFor,
  storeFileFor,
  webStoreFileFor,
  listSessions,
  migrateSession,
  SESSION_SUFFIXES,
  SHARED_FILES
};
