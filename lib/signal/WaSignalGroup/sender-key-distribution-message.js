'use strict';

const { CiphertextMessage } = require('./ciphertext-message');

// ─── Minimal protobuf encode/decode for SenderKeyDistributionMessage ──────────
// message SenderKeyDistributionMessage { uint32 id=1; uint32 iteration=2; bytes chainKey=3; bytes signingKey=4; }

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

function encodeSKDM(id, iteration, chainKey, signingKey) {
    return Buffer.concat([
        fieldVarint(1, id),
        fieldVarint(2, iteration),
        fieldBytes(3, Buffer.from(chainKey)),
        fieldBytes(4, Buffer.from(signingKey))
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

function decodeSKDM(buf) {
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
        chainKey: fields[3] || Buffer.alloc(32),
        signingKey: fields[4] || Buffer.alloc(33)
    };
}

// ─── SenderKeyDistributionMessage ─────────────────────────────────────────────

class SenderKeyDistributionMessage extends CiphertextMessage {
    constructor(id, iteration, chainKey, signatureKey, serialized) {
        super();

        if (serialized) {
            try {
                const message = serialized.slice(1);
                const decoded = decodeSKDM(message);
                this.serialized = serialized;
                this.id = decoded.id;
                this.iteration = decoded.iteration;
                this.chainKey = Buffer.isBuffer(decoded.chainKey)
                    ? decoded.chainKey
                    : Buffer.from(decoded.chainKey);
                this.signatureKey = Buffer.isBuffer(decoded.signingKey)
                    ? decoded.signingKey
                    : Buffer.from(decoded.signingKey);
            } catch (e) {
                throw new Error(String(e));
            }
        } else {
            const version = this.intsToByteHighAndLow(this.CURRENT_VERSION, this.CURRENT_VERSION);
            this.id = id;
            this.iteration = iteration;
            this.chainKey = Buffer.from(chainKey);
            this.signatureKey = Buffer.from(signatureKey);
            const message = encodeSKDM(id, iteration, this.chainKey, this.signatureKey);
            this.serialized = Buffer.concat([Buffer.from([version]), message]);
        }
    }

    intsToByteHighAndLow(highValue, lowValue) {
        return (((highValue << 4) | lowValue) & 0xff) % 256;
    }

    serialize() {
        return this.serialized;
    }

    getType() {
        return this.SENDERKEY_DISTRIBUTION_TYPE;
    }

    getIteration() {
        return this.iteration;
    }

    getChainKey() {
        return this.chainKey;
    }

    getSignatureKey() {
        return this.signatureKey;
    }

    getId() {
        return this.id;
    }
}

module.exports = { SenderKeyDistributionMessage };
