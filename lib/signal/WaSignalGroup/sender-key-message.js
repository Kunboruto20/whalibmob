'use strict';

const { calculateSignature, verifySignature } = require('libsignal/src/curve');
const { CiphertextMessage } = require('./ciphertext-message');

// ─── Minimal protobuf encode/decode for SenderKeyMessage ─────────────────────
// message SenderKeyMessage { uint32 id=1; uint32 iteration=2; bytes ciphertext=3; }

function encodeVarint(n) {
    const out = [];
    n = n >>> 0;
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return Buffer.from(out);
}

function fieldVarint(num, val) {
    return Buffer.concat([encodeVarint((num << 3) | 0), encodeVarint(val >>> 0)]);
}

function fieldBytes(num, buf) {
    return Buffer.concat([encodeVarint((num << 3) | 2), encodeVarint(buf.length), buf]);
}

function encodeSKM(id, iteration, ciphertext) {
    return Buffer.concat([
        fieldVarint(1, id),
        fieldVarint(2, iteration),
        fieldBytes(3, Buffer.from(ciphertext))
    ]);
}

function readVarint(buf, offset) {
    let result = 0, shift = 0;
    while (offset < buf.length) {
        const byte = buf[offset++];
        result |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) break;
    }
    return { value: result >>> 0, offset };
}

function decodeSKM(buf) {
    const fields = {};
    let offset = 0;
    while (offset < buf.length) {
        const tag = readVarint(buf, offset); offset = tag.offset;
        const fieldNum = tag.value >>> 3;
        const wire = tag.value & 0x07;
        if (wire === 0) {
            const v = readVarint(buf, offset); offset = v.offset;
            fields[fieldNum] = v.value;
        } else if (wire === 2) {
            const len = readVarint(buf, offset); offset = len.offset;
            fields[fieldNum] = buf.slice(offset, offset + len.value);
            offset += len.value;
        } else {
            break;
        }
    }
    return {
        id: fields[1] !== undefined ? fields[1] : 0,
        iteration: fields[2] !== undefined ? fields[2] : 0,
        ciphertext: fields[3] || Buffer.alloc(0)
    };
}

// ─── SenderKeyMessage ─────────────────────────────────────────────────────────

class SenderKeyMessage extends CiphertextMessage {
    constructor(keyId, iteration, ciphertext, signatureKey, serialized) {
        super();
        this.SIGNATURE_LENGTH = 64;

        if (serialized) {
            const version = serialized[0];
            const message = serialized.slice(1, serialized.length - this.SIGNATURE_LENGTH);
            const signature = serialized.slice(-1 * this.SIGNATURE_LENGTH);
            const decoded = decodeSKM(message);
            this.serialized = serialized;
            this.messageVersion = (version & 0xff) >> 4;
            this.keyId = decoded.id;
            this.iteration = decoded.iteration;
            this.ciphertext = Buffer.isBuffer(decoded.ciphertext)
                ? decoded.ciphertext
                : Buffer.from(decoded.ciphertext);
            this.signature = signature;
        } else {
            const version = (((this.CURRENT_VERSION << 4) | this.CURRENT_VERSION) & 0xff) % 256;
            const ciphertextBuffer = Buffer.from(ciphertext);
            const message = encodeSKM(keyId, iteration, ciphertextBuffer);
            const signature = this.getSignature(signatureKey, Buffer.concat([Buffer.from([version]), message]));
            this.serialized = Buffer.concat([Buffer.from([version]), message, Buffer.from(signature)]);
            this.messageVersion = this.CURRENT_VERSION;
            this.keyId = keyId;
            this.iteration = iteration;
            this.ciphertext = ciphertextBuffer;
            this.signature = signature;
        }
    }

    getKeyId() {
        return this.keyId;
    }

    getIteration() {
        return this.iteration;
    }

    getCipherText() {
        return this.ciphertext;
    }

    verifySignature(signatureKey) {
        const part1 = this.serialized.slice(0, this.serialized.length - this.SIGNATURE_LENGTH);
        const part2 = this.serialized.slice(-1 * this.SIGNATURE_LENGTH);
        const res = verifySignature(signatureKey, part1, part2);
        if (!res) throw new Error('Invalid signature!');
    }

    getSignature(signatureKey, serialized) {
        return Buffer.from(calculateSignature(signatureKey, serialized));
    }

    serialize() {
        return this.serialized;
    }

    getType() {
        return 4;
    }
}

module.exports = { SenderKeyMessage };
