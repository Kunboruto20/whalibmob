'use strict';

const { SenderKeyState } = require('./sender-key-state');

// JSON reviver that restores Buffers from their serialized form.
// Records are written with a plain JSON.stringify, so Node's default
// Buffer.toJSON() shape ({ type: 'Buffer', data: [..] }) is the one produced
// here; the base64-string form is also accepted so records written by any
// other serializer still load.
function bufferReviver(key, value) {
    if (value && typeof value === 'object' && value.type === 'Buffer') {
        if (Array.isArray(value.data)) return Buffer.from(value.data);
        if (typeof value.data === 'string') return Buffer.from(value.data, 'base64');
    }
    return value;
}

class SenderKeyRecord {
    constructor(serialized) {
        this.MAX_STATES = 5;
        this.senderKeyStates = [];
        if (serialized) {
            for (const structure of serialized) {
                this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, structure));
            }
        }
    }

    isEmpty() {
        return this.senderKeyStates.length === 0;
    }

    getSenderKeyState(keyId) {
        if (keyId === undefined && this.senderKeyStates.length) {
            return this.senderKeyStates[this.senderKeyStates.length - 1];
        }
        return this.senderKeyStates.find(state => state.getKeyId() === keyId);
    }

    addSenderKeyState(id, iteration, chainKey, signatureKey) {
        this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey));
        if (this.senderKeyStates.length > this.MAX_STATES) {
            this.senderKeyStates.shift();
        }
    }

    setSenderKeyState(id, iteration, chainKey, keyPair) {
        this.senderKeyStates.length = 0;
        this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair));
    }

    serialize() {
        return this.senderKeyStates.map(state => state.getStructure());
    }

    static deserialize(data) {
        const str = Buffer.from(data).toString('utf-8');
        const parsed = JSON.parse(str, bufferReviver);
        return new SenderKeyRecord(parsed);
    }
}

module.exports = { SenderKeyRecord };
