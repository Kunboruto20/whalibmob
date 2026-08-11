'use strict';

// What an outgoing WAM buffer is assembled from.
//
// Identical to Baileys' BinaryInfo: a protocol version, a sequence number that
// the server uses to order buffers, the events queued for the next flush, and
// the scratch list the encoder fills with byte chunks.

class BinaryInfo {
    constructor(options = {}) {
        this.protocolVersion = 5;
        this.sequence = 0;
        this.events = [];
        this.buffer = [];
        Object.assign(this, options);
    }
}

module.exports = { BinaryInfo };
