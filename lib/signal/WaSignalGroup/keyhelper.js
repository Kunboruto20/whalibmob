'use strict';

const crypto = require('crypto');
const { generateKeyPair } = require('libsignal/src/curve');

function generateSenderKey() {
    return crypto.randomBytes(32);
}

function generateSenderKeyId() {
    return crypto.randomInt(2147483647);
}

function generateSenderSigningKey(key) {
    if (!key) {
        key = generateKeyPair();
    }
    return {
        public: Buffer.from(key.pubKey),
        private: Buffer.from(key.privKey)
    };
}

module.exports = { generateSenderKey, generateSenderKeyId, generateSenderSigningKey };
