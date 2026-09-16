'use strict';

// Moving a session from one backend to another.
//
// Somebody with a working number and 834 files who now wants one database has
// to get the first into the second, and the one thing that must not happen on
// the way is losing the credentials in the middle. So nothing is removed: the
// state is copied, the source is left exactly as it was, and if the result is
// wrong the old files are still sitting there to go back to.
//
// A destination that already holds a key is left alone unless `overwrite` says
// otherwise, which makes an interrupted copy safe to run again — it picks up
// what did not make it the first time and does not undo what did.

const { assertBackend } = require('./Backend');

/**
 * Copy every key from one backend to another.
 *
 * @param {object} from  the backend to read from
 * @param {object} to    the backend to write to
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite]  replace keys the destination already has
 * @returns {{copied: string[], skipped: string[], bytes: number}}
 */
function copySession(from, to, opts) {
  assertBackend(from, 'source backend');
  assertBackend(to, 'destination backend');
  if (from === to) throw new Error('copySession: source and destination are the same backend');

  const overwrite = !!(opts && opts.overwrite);
  const copied = [], skipped = [];
  let bytes = 0;

  for (const key of from.list()) {
    if (!overwrite && to.read(key) !== null) { skipped.push(key); continue; }

    const value = from.read(key);
    // A key that list() named and read() will not return has gone since the
    // listing — a pre-key consumed by a message arriving mid-copy. It is not
    // an error and it is not ours to invent a value for.
    if (value === null) { skipped.push(key); continue; }

    to.write(key, value);
    bytes += Buffer.byteLength(value, 'utf8');
    copied.push(key);
  }

  return { copied: copied.sort(), skipped: skipped.sort(), bytes };
}

/**
 * Check that two backends hold the same state, key for key.
 *
 * Worth running after a copy and before deleting anything: it reads both sides
 * rather than trusting that the copy said so.
 *
 * @returns {{ok: boolean, missing: string[], differing: string[], extra: string[]}}
 */
function compareSessions(a, b) {
  assertBackend(a, 'first backend');
  assertBackend(b, 'second backend');

  const aKeys = new Set(a.list());
  const bKeys = new Set(b.list());
  const missing = [], differing = [], extra = [];

  for (const key of aKeys) {
    if (!bKeys.has(key)) { missing.push(key); continue; }
    if (a.read(key) !== b.read(key)) differing.push(key);
  }
  for (const key of bKeys) if (!aKeys.has(key)) extra.push(key);

  return {
    ok: missing.length === 0 && differing.length === 0 && extra.length === 0,
    missing: missing.sort(),
    differing: differing.sort(),
    extra: extra.sort()
  };
}

module.exports = { copySession, compareSessions };
