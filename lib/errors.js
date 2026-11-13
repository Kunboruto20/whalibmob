'use strict';

// Every error this library raises itself is a Boom (https://hapi.dev/module/boom)
// rather than a bare Error. A Boom is still an Error — message, stack and
// `instanceof Error` are untouched, and so are the string `code`s some errors
// carry — with an HTTP-style status on top, so a caller can branch on what kind
// of failure it was instead of matching message text:
//
//   err.isBoom                    true for anything raised here
//   err.output.statusCode         the status, see below
//   err.data                      extra detail when there is any, else null
//
// The statuses mean the same thing everywhere in the library:
//
//   400  the caller passed something unusable, or data would not parse
//   401  not authenticated — logged out, wrong code or PIN
//   403  the server refuses this client or account outright
//   404  something that had to exist does not — a session, a key, a file
//   405  the call does not apply to this kind of session
//   408  no answer in time
//   409  it is already there, or already done
//   428  not connected, or no session loaded yet
//   429  too many attempts, wait
//   500  unexpected — a bug, or a failure that fits nothing above
//   501  an optional piece (a package, a driver) is not available
//   502  a server answered, but not with what was asked for
//
// When the WhatsApp server or an HTTP endpoint names its own error status, that
// status is passed through as it came (a 403 stays a 403, a 406 a 406).

const { Boom } = require('@hapi/boom');

// The status a server gave, when it is one Boom accepts (an integer from 400 to
// 599); otherwise the fallback. Server codes arrive as strings, numbers, or not
// at all, and Boom throws on anything below 400.
function statusFrom(code, fallback = 502) {
  const n = typeof code === 'string' && code.trim() !== '' ? Number(code) : code;
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : fallback;
}

module.exports = { Boom, statusFrom };
