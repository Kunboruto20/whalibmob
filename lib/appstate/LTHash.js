'use strict';

const { hkdf }   = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha256');

// A summation hash that survives being edited out of order.
//
// App state is a stream of mutations that the server hands out in pieces, and a
// client has to be able to prove the state it ended up with is the state the
// server meant it to have — without replaying every mutation ever made. An
// ordinary hash cannot do that: it only tells you about a sequence you fed it
// front to back.
//
// This one can, because it is addition. Every value is expanded into 128 bytes
// and folded into the running hash as 64 little-endian 16-bit words, each added
// with wraparound. Addition commutes, so the order the mutations arrive in does
// not matter, and it inverts, so a mutation that is replaced can be subtracted
// back out without touching the rest.
//
// The salt is the domain separator; it is what makes these hashes mean
// "WhatsApp app state" and not something else expanded from the same bytes.
const HASH_BYTES  = 128;
const PATCH_SALT  = 'WhatsApp Patch Integrity';

class LTHash {
  constructor(salt) {
    this.salt = salt;
  }

  // 128 bytes of key material for one value.
  _expand(value) {
    const ikm = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.from(
      hkdf(sha256, ikm, Buffer.alloc(0), Buffer.from(this.salt, 'utf8'), HASH_BYTES)
    );
  }

  // Word-by-word, 16 bits at a time, little-endian, wrapping at 2^16.
  //
  // The wraparound is not a defect to guard against — it is what keeps the
  // hash a fixed 128 bytes no matter how many mutations are folded in, and
  // what makes subtraction the exact inverse of addition.
  _pointwise(base, other, add) {
    const a   = Buffer.isBuffer(base) ? base : Buffer.from(base);
    const out = Buffer.alloc(HASH_BYTES);
    for (let i = 0; i < HASH_BYTES; i += 2) {
      const x = a.readUInt16LE(i);
      const y = other.readUInt16LE(i);
      out.writeUInt16LE((add ? (x + y) : (x - y)) & 0xffff, i);
    }
    return out;
  }

  add(hash, values) {
    let out = hash;
    for (const v of values) out = this._pointwise(out, this._expand(v), true);
    return out;
  }

  subtract(hash, values) {
    let out = hash;
    for (const v of values) out = this._pointwise(out, this._expand(v), false);
    return out;
  }

  // Retire the old values first, then fold the new ones in. Doing it the other
  // way round is arithmetically the same, but this order matches how a patch
  // reads: what it replaces, then what it puts there.
  subtractThenAdd(hash, toAdd, toSubtract) {
    return this.add(this.subtract(hash, toSubtract || []), toAdd || []);
  }
}

const PATCH_INTEGRITY = new LTHash(PATCH_SALT);

// Folds a run of mutations into a state, keeping track of which index each
// value is filed under so a later mutation can displace it.
//
// indexValueMap is index MAC (base64) → { valueMac }. It is the reason a
// mutation can be replaced at all: without knowing the value an index used to
// carry, there is nothing to subtract back out.
function makeGenerator(state) {
  const indexValueMap = Object.assign({}, state.indexValueMap || {});
  const hash    = Buffer.isBuffer(state.hash) ? state.hash : Buffer.alloc(HASH_BYTES);
  const addBufs = [];
  const subBufs = [];

  return {
    mix({ indexMac, valueMac, remove }) {
      const key    = Buffer.from(indexMac).toString('base64');
      const prev   = indexValueMap[key];
      if (remove) {
        // A remove for something we never had is the server telling us about a
        // mutation we missed. There is nothing to subtract; the hash will not
        // match at the end, and that mismatch is the signal to resync from a
        // snapshot rather than something to paper over here.
        if (!prev) return;
        delete indexValueMap[key];
      } else {
        addBufs.push(Buffer.from(valueMac));
        indexValueMap[key] = { valueMac: Buffer.from(valueMac) };
      }
      if (prev) subBufs.push(Buffer.from(prev.valueMac));
    },

    finish() {
      return {
        hash: PATCH_INTEGRITY.subtractThenAdd(hash, addBufs, subBufs),
        indexValueMap
      };
    }
  };
}

function newState() {
  return { version: 0, hash: Buffer.alloc(HASH_BYTES), indexValueMap: {} };
}

module.exports = { LTHash, PATCH_INTEGRITY, makeGenerator, newState, HASH_BYTES };
