'use strict';

// WAM — the stats channel WhatsApp Web reports on.
//
// Same three pieces the reference client ships: the event/global tables, the
// binary encoder, and the BinaryInfo holder an application fills in. Nothing
// here runs on its own; see Client.sendWAMBuffer() for how a buffer is sent.

const { WEB_EVENTS, WEB_GLOBALS, FLAG_BYTE, FLAG_GLOBAL,
        FLAG_EVENT, FLAG_FIELD, FLAG_EXTENDED } = require('./constants');
const { encodeWAM }  = require('./encode');
const { BinaryInfo } = require('./BinaryInfo');

module.exports = {
  WEB_EVENTS, WEB_GLOBALS,
  FLAG_BYTE, FLAG_GLOBAL, FLAG_EVENT, FLAG_FIELD, FLAG_EXTENDED,
  encodeWAM, BinaryInfo
};
