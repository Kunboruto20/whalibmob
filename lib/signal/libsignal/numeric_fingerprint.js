
const crypto = require('./crypto.js');

var VERSION = 0;


// Inputs arrive as ArrayBuffers (createFor requires them) and as strings for
// the identifiers, neither of which Buffer.concat or crypto.hash accept.
function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return Buffer.from(value);
}


async function iterateHash(data, key, count) {
    const combined = Buffer.concat([toBuffer(data), toBuffer(key)]);
    const result = crypto.hash(combined);
    if (--count === 0) {
        return result;
    } else {
        return iterateHash(result, key, count);
    }
}


function shortToArrayBuffer(number) {
    return new Uint16Array([number]).buffer;
}

function getEncodedChunk(hash, offset) {
    var chunk = ( hash[offset]   * Math.pow(2,32) +
                  hash[offset+1] * Math.pow(2,24) +
                  hash[offset+2] * Math.pow(2,16) +
                  hash[offset+3] * Math.pow(2,8) +
                  hash[offset+4] ) % 100000;
    var s = chunk.toString();
    while (s.length < 5) {
        s = '0' + s;
    }
    return s;
}

async function getDisplayStringFor(identifier, key, iterations) {
    const bytes = Buffer.concat([
        toBuffer(shortToArrayBuffer(VERSION)),
        toBuffer(key),
        toBuffer(identifier)
    ]);
    const output = new Uint8Array(await iterateHash(bytes, key, iterations));
    return getEncodedChunk(output, 0) +
        getEncodedChunk(output, 5) +
        getEncodedChunk(output, 10) +
        getEncodedChunk(output, 15) +
        getEncodedChunk(output, 20) +
        getEncodedChunk(output, 25);
}

exports.FingerprintGenerator = function(iterations) {
    this.iterations = iterations;
};

exports.FingerprintGenerator.prototype = {
    createFor: function(localIdentifier, localIdentityKey,
                        remoteIdentifier, remoteIdentityKey) {
        if (typeof localIdentifier !== 'string' ||
            typeof remoteIdentifier !== 'string' ||
            !(localIdentityKey instanceof ArrayBuffer) ||
            !(remoteIdentityKey instanceof ArrayBuffer)) {
          throw new Error('Invalid arguments');
        }

        return Promise.all([
            getDisplayStringFor(localIdentifier, localIdentityKey, this.iterations),
            getDisplayStringFor(remoteIdentifier, remoteIdentityKey, this.iterations)
        ]).then(function(fingerprints) {
            return fingerprints.sort().join('');
        });
    }
};
