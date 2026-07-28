'use strict';

// The "reachout timelock" — the temporary restriction WhatsApp puts on an
// account that has started too many chats with people who have never replied.
//
// While it is on, messages to a contact you have no history with are refused
// with error 463 and nothing you do client-side gets them through. The
// restriction is not permanent: the server holds an expiry, and once it passes
// the account goes back to normal on its own. Five hours is the usual first
// one; repeat offences get longer.
//
// The expiry is not on any stanza the client is sent by default — it has to be
// asked for, over the GraphQL-style w:mex transport.

// The reason a restriction was applied. DEFAULT is the one that means "no
// restriction", which is also what the server sends when it is lifting one.
const ENFORCEMENT_TYPES = new Set([
  'DEFAULT',
  'BIZ_QUALITY',
  'WEB_COMPANION_ONLY',
  'BIZ_COMMERCE_VIOLATION_ALCOHOL',
  'BIZ_COMMERCE_VIOLATION_ADULT',
  'BIZ_COMMERCE_VIOLATION_ANIMALS',
  'BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS',
  'BIZ_COMMERCE_VIOLATION_DATING',
  'BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS',
  'BIZ_COMMERCE_VIOLATION_DRUGS',
  'BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC',
  'BIZ_COMMERCE_VIOLATION_GAMBLING',
  'BIZ_COMMERCE_VIOLATION_HEALTHCARE',
  'BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY',
  'BIZ_COMMERCE_VIOLATION_SUPPLEMENTS',
  'BIZ_COMMERCE_VIOLATION_TOBACCO',
  'BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT',
  'BIZ_COMMERCE_VIOLATION_WEAPONS'
]);

// Plain-language reasons for the ones a normal account actually meets.
const ENFORCEMENT_REASONS = {
  DEFAULT:            'no restriction',
  BIZ_QUALITY:        'too many people you messaged blocked or reported you',
  WEB_COMPANION_ONLY: 'restricted to the linked-device app'
};

// When the server says a restriction is on but does not say when it ends, it
// means "ask again shortly" rather than "forever". A minute is what WhatsApp
// Web assumes in the same spot.
const UNKNOWN_EXPIRY_MS = 60 * 1000;

function normalizeEnforcementType(value) {
  return (typeof value === 'string' && ENFORCEMENT_TYPES.has(value)) ? value : 'DEFAULT';
}

/**
 * Turn what the server sent into the shape the rest of the library uses.
 *
 * `time_enforcement_ends` is unix *seconds* as a string, and "0" is the
 * server's way of saying there is no expiry to report — treating it as a date
 * would put the restriction at 1970 and make it look long expired.
 */
function parseTimelockPayload(payload, opts) {
  const p = payload || {};
  const active = !!p.is_active;

  if (!active) {
    return { active: false, endsAt: null, enforcementType: 'DEFAULT', reason: ENFORCEMENT_REASONS.DEFAULT };
  }

  const raw = p.time_enforcement_ends;
  const ts  = (raw != null && String(raw) !== '0') ? parseInt(String(raw), 10) : NaN;
  const endsAt = Number.isFinite(ts) && ts > 0
    ? ts * 1000
    : ((opts && opts.now ? opts.now : Date.now()) + UNKNOWN_EXPIRY_MS);

  const enforcementType = normalizeEnforcementType(p.enforcement_type);
  return {
    active: true,
    endsAt,
    enforcementType,
    reason: ENFORCEMENT_REASONS[enforcementType] || 'account restricted',
    // The server did not tell us when it ends, so this is a guess and the
    // caller should ask again rather than trust the countdown.
    expiryUnknown: !(Number.isFinite(ts) && ts > 0)
  };
}

/** Milliseconds left, floored at zero. */
function remainingMs(state, now) {
  if (!state || !state.active || !state.endsAt) return 0;
  return Math.max(0, state.endsAt - (now == null ? Date.now() : now));
}

/**
 * HH:MM:SS, which is how long a restriction is worth showing to a person.
 * Hours are not wrapped at 24 — a two-day restriction reads "48:00:00" rather
 * than looking like a fresh one.
 */
function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

/** A state object with the derived fields filled in, for handing to a caller. */
function describe(state, now) {
  const base = state || { active: false, endsAt: null, enforcementType: 'DEFAULT' };
  const left = remainingMs(base, now);
  return {
    active:          !!base.active && left > 0,
    endsAt:          base.endsAt || null,
    endsAtDate:      base.endsAt ? new Date(base.endsAt) : null,
    remainingMs:     left,
    remaining:       formatRemaining(left),
    enforcementType: base.enforcementType || 'DEFAULT',
    reason:          base.reason || ENFORCEMENT_REASONS.DEFAULT,
    expiryUnknown:   !!base.expiryUnknown,
    checkedAt:       base.checkedAt || null
  };
}

module.exports = {
  parseTimelockPayload,
  remainingMs,
  formatRemaining,
  describe,
  normalizeEnforcementType,
  ENFORCEMENT_TYPES,
  ENFORCEMENT_REASONS,
  UNKNOWN_EXPIRY_MS
};
