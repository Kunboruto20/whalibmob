'use strict';

// The account-restriction (error 463) state machine. Every function here is
// pure and takes `now` as an argument, so the clock never makes a test flaky.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTimelockPayload,
  remainingMs,
  formatRemaining,
  describe: describeState,
  normalizeEnforcementType,
  ENFORCEMENT_REASONS,
  UNKNOWN_EXPIRY_MS
} = require('../lib/ReachoutTimelock');

const NOW = 1_800_000_000_000;   // a fixed instant, so nothing depends on Date.now()

test('parseTimelockPayload: an inactive payload is not a restriction', () => {
  const s = parseTimelockPayload({ is_active: false }, { now: NOW });
  assert.equal(s.active, false);
  assert.equal(s.endsAt, null);
  assert.equal(s.enforcementType, 'DEFAULT');
  assert.equal(s.reason, ENFORCEMENT_REASONS.DEFAULT);
});

test('parseTimelockPayload: an absent payload is not a restriction', () => {
  assert.equal(parseTimelockPayload(undefined, { now: NOW }).active, false);
  assert.equal(parseTimelockPayload(null, { now: NOW }).active, false);
  assert.equal(parseTimelockPayload({}, { now: NOW }).active, false);
});

test('parseTimelockPayload: the expiry arrives as unix SECONDS, as a string', () => {
  const endsAtSeconds = 1_800_018_000;
  const s = parseTimelockPayload(
    { is_active: true, time_enforcement_ends: String(endsAtSeconds), enforcement_type: 'BIZ_QUALITY' },
    { now: NOW }
  );
  assert.equal(s.active, true);
  assert.equal(s.endsAt, endsAtSeconds * 1000, 'seconds must be scaled to milliseconds');
  assert.equal(s.enforcementType, 'BIZ_QUALITY');
  assert.equal(s.expiryUnknown, false);
});

test('parseTimelockPayload: "0" means "no expiry reported", NOT 1970', () => {
  // Treating "0" as a date would put the end of the restriction in 1970 and
  // make an active restriction look long expired.
  const s = parseTimelockPayload(
    { is_active: true, time_enforcement_ends: '0' },
    { now: NOW }
  );
  assert.equal(s.active, true);
  assert.equal(s.expiryUnknown, true);
  assert.equal(s.endsAt, NOW + UNKNOWN_EXPIRY_MS, 'falls forward, never back to the epoch');
  assert.ok(s.endsAt > NOW, 'an active restriction never ends in the past');
});

test('parseTimelockPayload: a missing or unparseable expiry is also "unknown"', () => {
  for (const raw of [undefined, null, 'not-a-number', '-5']) {
    const s = parseTimelockPayload({ is_active: true, time_enforcement_ends: raw }, { now: NOW });
    assert.equal(s.expiryUnknown, true, `raw=${String(raw)}`);
    assert.equal(s.endsAt, NOW + UNKNOWN_EXPIRY_MS, `raw=${String(raw)}`);
  }
});

test('normalizeEnforcementType: an unknown type falls back to DEFAULT', () => {
  assert.equal(normalizeEnforcementType('BIZ_QUALITY'), 'BIZ_QUALITY');
  assert.equal(normalizeEnforcementType('WEB_COMPANION_ONLY'), 'WEB_COMPANION_ONLY');
  assert.equal(normalizeEnforcementType('SOMETHING_NEW_WHATSAPP_ADDED'), 'DEFAULT');
  assert.equal(normalizeEnforcementType(undefined), 'DEFAULT');
  assert.equal(normalizeEnforcementType(42), 'DEFAULT');
});

test('remainingMs: never goes negative', () => {
  const past = { active: true, endsAt: NOW - 10_000 };
  assert.equal(remainingMs(past, NOW), 0);

  const future = { active: true, endsAt: NOW + 5_000 };
  assert.equal(remainingMs(future, NOW), 5_000);

  assert.equal(remainingMs(null, NOW), 0);
  assert.equal(remainingMs({ active: false, endsAt: NOW + 5_000 }, NOW), 0);
});

test('formatRemaining: HH:MM:SS, and hours are NOT wrapped at 24', () => {
  assert.equal(formatRemaining(0), '00:00:00');
  assert.equal(formatRemaining(1_000), '00:00:01');
  assert.equal(formatRemaining(61_000), '00:01:01');
  assert.equal(formatRemaining(5 * 3600 * 1000), '05:00:00');
  // A two-day restriction has to read as two days, not as a fresh one.
  assert.equal(formatRemaining(48 * 3600 * 1000), '48:00:00');
  assert.equal(formatRemaining(-5_000), '00:00:00', 'negative is clamped');
});

test('describe: an active restriction whose time has passed reports inactive', () => {
  const expired = { active: true, endsAt: NOW - 1, enforcementType: 'BIZ_QUALITY' };
  const d = describeState(expired, NOW);
  assert.equal(d.active, false, 'the countdown, not the flag, decides');
  assert.equal(d.remainingMs, 0);
  assert.equal(d.remaining, '00:00:00');
});

test('describe: fills in every field a caller reads', () => {
  const state = {
    active: true,
    endsAt: NOW + 3_600_000,
    enforcementType: 'BIZ_QUALITY',
    reason: ENFORCEMENT_REASONS.BIZ_QUALITY,
    checkedAt: NOW
  };
  const d = describeState(state, NOW);
  assert.equal(d.active, true);
  assert.equal(d.remaining, '01:00:00');
  assert.equal(d.remainingMs, 3_600_000);
  assert.ok(d.endsAtDate instanceof Date);
  assert.equal(d.endsAtDate.getTime(), state.endsAt);
  assert.equal(d.enforcementType, 'BIZ_QUALITY');
  assert.equal(d.checkedAt, NOW);
  assert.equal(d.expiryUnknown, false);
});

test('describe: survives being handed nothing at all', () => {
  const d = describeState(null, NOW);
  assert.equal(d.active, false);
  assert.equal(d.endsAt, null);
  assert.equal(d.endsAtDate, null);
  assert.equal(d.remaining, '00:00:00');
  assert.equal(d.enforcementType, 'DEFAULT');
});
