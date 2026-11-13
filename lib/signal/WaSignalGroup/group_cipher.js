'use strict';

const { Boom } = require('@hapi/boom');
const { decrypt, encrypt } = require('../libsignal/crypto');
const { SenderKeyMessage } = require('./sender-key-message');
const { SenderKeyRecord } = require('./sender-key-record');

class GroupCipher {
    constructor(senderKeyStore, senderKeyName) {
        this.senderKeyStore = senderKeyStore;
        this.senderKeyName = senderKeyName;
    }

    async encrypt(paddedPlaintext) {
        const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName);
        if (!record) {
            throw new Boom('No SenderKeyRecord found for encryption', { statusCode: 404 });
        }
        const senderKeyState = record.getSenderKeyState();
        if (!senderKeyState) {
            throw new Boom('No session to encrypt message', { statusCode: 404 });
        }
        const iteration = senderKeyState.getSenderChainKey().getIteration();
        const senderKey = this.getSenderKey(senderKeyState, iteration === 0 ? 0 : iteration + 1);
        const ciphertext = await this.getCipherText(senderKey.getIv(), senderKey.getCipherKey(), paddedPlaintext);
        const senderKeyMessage = new SenderKeyMessage(
            senderKeyState.getKeyId(),
            senderKey.getIteration(),
            ciphertext,
            senderKeyState.getSigningKeyPrivate()
        );
        await this.senderKeyStore.storeSenderKey(this.senderKeyName, record);
        return senderKeyMessage.serialize();
    }

    async decrypt(senderKeyMessageBytes) {
        const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName);
        if (!record) {
            throw new Boom('No SenderKeyRecord found for decryption', { statusCode: 404 });
        }
        const senderKeyMessage = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes);
        const senderKeyState = record.getSenderKeyState(senderKeyMessage.getKeyId());
        if (!senderKeyState) {
            throw new Boom('No session found to decrypt message', { statusCode: 404 });
        }
        senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic());
        const senderKey = this.getSenderKey(senderKeyState, senderKeyMessage.getIteration());
        const plaintext = await this.getPlainText(senderKey.getIv(), senderKey.getCipherKey(), senderKeyMessage.getCipherText());
        await this.senderKeyStore.storeSenderKey(this.senderKeyName, record);
        return plaintext;
    }

    getSenderKey(senderKeyState, iteration) {
        let senderChainKey = senderKeyState.getSenderChainKey();
        if (senderChainKey.getIteration() > iteration) {
            if (senderKeyState.hasSenderMessageKey(iteration)) {
                const messageKey = senderKeyState.removeSenderMessageKey(iteration);
                if (!messageKey) {
                    throw new Boom('No sender message key found for iteration', { statusCode: 404 });
                }
                return messageKey;
            }
            throw new Boom(`Received message with old counter: ${senderChainKey.getIteration()}, ${iteration}`, { statusCode: 400 });
        }
        if (iteration - senderChainKey.getIteration() > 2000) {
            throw new Boom('Over 2000 messages into the future!', { statusCode: 400 });
        }
        while (senderChainKey.getIteration() < iteration) {
            senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey());
            senderChainKey = senderChainKey.getNext();
        }
        senderKeyState.setSenderChainKey(senderChainKey.getNext());
        return senderChainKey.getSenderMessageKey();
    }

    async getPlainText(iv, key, ciphertext) {
        try {
            return decrypt(key, ciphertext, iv);
        } catch (e) {
            throw new Boom('InvalidMessageException', { statusCode: 400 });
        }
    }

    async getCipherText(iv, key, plaintext) {
        try {
            return encrypt(key, plaintext, iv);
        } catch (e) {
            throw new Boom('InvalidMessageException', { statusCode: 400 });
        }
    }
}

module.exports = { GroupCipher };
