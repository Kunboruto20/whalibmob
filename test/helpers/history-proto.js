'use strict';

// The independent reader for history-sync bytes.
//
// type('WebMessageInfo') hands back a protobufjs reflection type for one of the
// messages in test/fixtures/history-sync.proto, which is written from
// WhatsApp's field numbers and not from the library. Encoding with it, or
// decoding what the library produced with it, is the check that does not agree
// with the library by construction.
//
// Nothing here runs when the file is loaded. `node --test` executes every .js
// under test/, helpers included, so on its own this module has to do nothing:
// the schema is parsed on the first call to type() and kept after that.

const path     = require('node:path');
const protobuf = require('protobufjs');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'history-sync.proto');

let root = null;

function type(name) {
  if (root === null) root = protobuf.loadSync(FIXTURE);
  return root.lookupType('watest.' + name);
}

module.exports = { type };
