'use strict';

// Argo — the binary encoding WhatsApp's GraphQL transport answers in.
//
// A w:mex reply can come back as JSON or as Argo; the <result> node says which.
// Argo is normally decoded against the schema of the query that asked, which a
// client outside Meta does not have. But a message can set a SelfDescribing
// flag, and then it carries its own field names and types — which is what
// WhatsApp sends, and what makes this readable at all.
//
// Only the self-describing form is implemented. A schema-typed message is
// refused rather than guessed at.
//
// Layout:
//   [header bitset][block][block]…[core]
// where each block is a length label followed by that many bytes, and the core
// is the last one. Values in the core are Labels — zigzag ULEB128 integers —
// that either carry a small value outright or point into a block.

// ─── labels ──────────────────────────────────────────────────────────────────
//
// A label is one signed integer doing several jobs at once. Non-negative is a
// length or a boolean; the three values below are markers; anything lower is a
// backreference to a value already seen.
const LABEL_NULL   = -1;
const LABEL_ABSENT = -2;
const LABEL_ERROR  = -3;
// -4 is the first backreference and means "the first value in this block".
const BACKREF_BASE = -4;

// Self-describing type markers, as label values.
const MARKER = {
  NULL:   -1,
  FALSE:   0,
  TRUE:    1,
  OBJECT:  2,
  LIST:    3,
  STRING:  4,
  BYTES:   5,
  INT:     6,
  FLOAT:   7
};

// Header flag bit positions.
const FLAG_INLINE_EVERYTHING = 0;
const FLAG_SELF_DESCRIBING   = 1;

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  get done()      { return this.pos >= this.buf.length; }
  byte() {
    if (this.pos >= this.buf.length) throw new Error('argo: ran off the end of the message');
    return this.buf[this.pos++];
  }
  peek()          { return this.buf[this.pos]; }
  take(n) {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new Error('argo: asked for ' + n + ' bytes with ' +
        (this.buf.length - this.pos) + ' left');
    }
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  // ULEB128, then zigzag back to signed.
  label() {
    let value = 0n, shift = 0n;
    for (;;) {
      const b = this.byte();
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
      if (shift > 63n) throw new Error('argo: label is too long to be a number');
    }
    const signed = (value >> 1n) ^ -(value & 1n);
    return Number(signed);
  }
}

function readHeader(reader) {
  let bits = 0, shift = 0, more = true;
  while (more) {
    const b = reader.byte();
    bits |= (b >> 1) << shift;
    shift += 7;
    more = (b & 1) === 1;
  }
  return {
    bits,
    selfDescribing:   !!(bits >> FLAG_SELF_DESCRIBING   & 1),
    inlineEverything: !!(bits >> FLAG_INLINE_EVERYTHING & 1)
  };
}

// A block holds the bulky values — strings, byte arrays, numbers — with the
// core referring to them in order. Blocks are handed out in the order their
// types are first needed, which is why they are taken from a queue rather than
// looked up by name.
class BlockQueue {
  constructor(blocks, core, inlineEverything) {
    this.blocks = blocks;
    this.core   = core;
    this.inline = inlineEverything;
    this.next   = 0;
    this.byKey  = new Map();
    // Inlined, every value comes out of the core in the one order, so they
    // share a single list of what has been read — a backreference counts
    // through that list and would find nothing in a fresh one.
    this.inlineBlock = { reader: core, seen: [] };
  }
  for(key) {
    if (this.inline) return this.inlineBlock;
    if (!this.byKey.has(key)) {
      const buf = this.blocks[this.next++];
      if (buf === undefined) throw new Error('argo: message is missing a block for ' + key);
      this.byKey.set(key, { reader: new Reader(buf), seen: [] });
    }
    return this.byKey.get(key);
  }
}

function decodeArgo(bytes) {
  const buf    = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const reader = new Reader(buf);
  const header = readHeader(reader);

  if (!header.selfDescribing) {
    const err = new Error('argo: this message is encoded against a GraphQL schema ' +
      'rather than describing itself, so it cannot be read without that schema');
    err.needsSchema = true;
    throw err;
  }

  const blocks = [];
  if (header.inlineEverything) {
    blocks.push(reader.take(buf.length - reader.pos));
  } else {
    while (!reader.done) {
      const len = reader.label();
      if (len < 0) throw new Error('argo: block length cannot be ' + len);
      blocks.push(reader.take(len));
    }
  }
  if (!blocks.length) throw new Error('argo: message has no core');

  // The core is the last block, and every other block feeds it.
  const core   = new Reader(blocks[blocks.length - 1]);
  const queue  = new BlockQueue(blocks.slice(0, -1), core, header.inlineEverything);

  return readValue(core, queue);
}

// One length-prefixed value out of a block, with backreferences resolved.
//
// The same string written twice is written once and pointed at the second time,
// which is most of why this format is small. A backreference that points at
// nothing means the message and our reading of it have diverged.
function readBlockValue(core, queue, key, convert) {
  const block = queue.for(key);
  const label = core.label();
  if (label <= BACKREF_BASE) {
    const idx = -label + BACKREF_BASE;
    if (idx < 0 || idx >= block.seen.length) {
      throw new Error('argo: backreference ' + label + ' points outside ' + key);
    }
    return block.seen[idx];
  }
  if (label < 0) throw new Error('argo: ' + key + ' cannot have label ' + label);
  const value = convert(block.reader.take(label));
  block.seen.push(value);
  return value;
}

function readValue(core, queue) {
  const marker = core.label();

  switch (marker) {
    case MARKER.NULL:   return null;
    case MARKER.FALSE:  return false;
    case MARKER.TRUE:   return true;

    case MARKER.OBJECT: {
      const count = core.label();
      if (count < 0) throw new Error('argo: object cannot have ' + count + ' fields');
      const out = {};
      for (let i = 0; i < count; i++) {
        const name = readBlockValue(core, queue, 'String', b => b.toString('utf8'));
        out[name]  = readValue(core, queue);
      }
      return out;
    }

    case MARKER.LIST: {
      const count = core.label();
      if (count < 0) throw new Error('argo: list cannot have ' + count + ' items');
      const out = [];
      for (let i = 0; i < count; i++) out.push(readValue(core, queue));
      return out;
    }

    case MARKER.STRING: return readBlockValue(core, queue, 'String', b => b.toString('utf8'));
    case MARKER.BYTES:  return readBlockValue(core, queue, 'Bytes',  b => Buffer.from(b));

    // An integer lives entirely in its block — the core spends nothing on it.
    case MARKER.INT: {
      const block = queue.for('Varint');
      return block.reader.label();
    }

    case MARKER.FLOAT: {
      const block = queue.for('Float');
      return block.reader.take(8).readDoubleLE(0);
    }

    default:
      if (marker === LABEL_ABSENT) return undefined;
      if (marker === LABEL_ERROR)  return readValue(core, queue);
      throw new Error('argo: unknown type marker ' + marker);
  }
}

/**
 * Decode an Argo message, or return null when it is not one this can read.
 *
 * Never throws: a caller reaching for this already has a reply it could not
 * parse, and a second failure on top of that is not news. `decodeArgo` is there
 * for when the reason matters.
 */
function tryDecodeArgo(bytes) {
  try { return decodeArgo(bytes); }
  catch (_) { return null; }
}

module.exports = {
  decodeArgo,
  tryDecodeArgo,
  MARKER,
  LABEL_NULL,
  LABEL_ABSENT,
  LABEL_ERROR
};
