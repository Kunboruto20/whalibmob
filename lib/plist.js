'use strict';

// ─── Property lists ───────────────────────────────────────────────────────────
//
// Apple's two registration surfaces both speak plist, and neither speaks
// anything else:
//
//   albert.apple.com  takes an XML plist as the activation body and answers
//                     with an XML plist wrapped in a <Protocol> block.
//   init-p01st…/bag   answers with an XML plist whose "bag" key holds a second,
//                     binary plist carrying the courier hostname.
//
// So a plist reader has to handle both encodings and the writer has to produce
// the XML one. That is the whole scope of this file — it is not a general
// property-list library, and nothing outside ./apns uses it.
//
// The mapping to JavaScript is chosen so that a parsed value can be read with
// ordinary property access and a value to be written needs no wrapper types:
//
//   <string>   ↔ string          <data>    ↔ Buffer
//   <integer>  ↔ number          <real>    ↔ number
//   <true/>    ↔ true            <date>    ↔ Date
//   <array>    ↔ Array           <dict>    ↔ plain object
//
// The one place the mapping is lossy is on the way out: a JS number is written
// as <integer> when it is one and <real> otherwise, which is what every plist
// producer does anyway. Buffer is what separates data from string, and it is
// the reason the parser hands back Buffers rather than base64 text.

const MAGIC = Buffer.from('bplist00', 'ascii');

// Cocoa counts time from 2001-01-01T00:00:00Z rather than the Unix epoch.
const APPLE_EPOCH_OFFSET_MS = 978307200000;

// ─── XML writer ───────────────────────────────────────────────────────────────
//
// Tab-indented, one value per line, base64 on a single line — the shape Apple's
// own tools emit. The activation body is signed over exactly these bytes, so
// the writer is deliberately boring: no reordering, no pretty-printing options,
// nothing that could make the same input serialise two ways.

const XML_PREAMBLE =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

const XML_EPILOGUE = '</plist>\n';

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function writeValue(out, value, depth) {
  const pad = '\t'.repeat(depth);

  if (Buffer.isBuffer(value)) {
    out.push(pad + '<data>' + value.toString('base64') + '</data>');
    return;
  }
  if (value instanceof Date) {
    // The plist date format is ISO 8601 in UTC with no fractional seconds.
    out.push(pad + '<date>' + value.toISOString().replace(/\.\d{3}Z$/, 'Z') + '</date>');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push(pad + '<array/>'); return; }
    out.push(pad + '<array>');
    for (const item of value) writeValue(out, item, depth + 1);
    out.push(pad + '</array>');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(pad + (value ? '<true/>' : '<false/>'));
      return;
    case 'string':
      out.push(pad + '<string>' + escapeXml(value) + '</string>');
      return;
    case 'number':
      out.push(pad + (Number.isInteger(value)
        ? '<integer>' + value + '</integer>'
        : '<real>' + value + '</real>'));
      return;
    case 'bigint':
      out.push(pad + '<integer>' + value.toString() + '</integer>');
      return;
    case 'object': {
      if (value === null) break;
      const keys = Object.keys(value);
      if (keys.length === 0) { out.push(pad + '<dict/>'); return; }
      out.push(pad + '<dict>');
      for (const key of keys) {
        out.push('\t'.repeat(depth + 1) + '<key>' + escapeXml(key) + '</key>');
        writeValue(out, value[key], depth + 1);
      }
      out.push(pad + '</dict>');
      return;
    }
    default:
      break;
  }
  throw new TypeError('plist: cannot serialise ' + (value === null ? 'null' : typeof value));
}

/**
 * Serialise a value as an XML property list.
 *
 * @param {*} value  a plain object, array, string, number, boolean, Date or Buffer
 * @returns {Buffer} the UTF-8 XML document
 */
function writeXml(value) {
  const lines = [];
  writeValue(lines, value, 0);
  return Buffer.from(XML_PREAMBLE + lines.join('\n') + '\n' + XML_EPILOGUE, 'utf8');
}

// ─── XML reader ───────────────────────────────────────────────────────────────
//
// A tag scanner rather than a parser: plists have no attributes worth reading,
// no namespaces and no mixed content, so walking from one angle bracket to the
// next is enough and brings no XML dependency with it.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

class XmlScanner {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  // The next tag, as { name, closing, selfClosing }, or null at end of input.
  // Comments, the XML declaration and the doctype are skipped here so that the
  // value walker only ever sees element tags.
  nextTag() {
    for (;;) {
      const open = this.text.indexOf('<', this.pos);
      if (open < 0) return null;

      if (this.text.startsWith('<!--', open)) {
        const end = this.text.indexOf('-->', open);
        if (end < 0) return null;
        this.pos = end + 3;
        continue;
      }
      if (this.text.startsWith('<?', open) || this.text.startsWith('<!', open)) {
        const end = this.text.indexOf('>', open);
        if (end < 0) return null;
        this.pos = end + 1;
        continue;
      }

      const close = this.text.indexOf('>', open);
      if (close < 0) return null;
      let raw = this.text.slice(open + 1, close).trim();
      this.pos = close + 1;

      const closing = raw[0] === '/';
      if (closing) raw = raw.slice(1).trim();
      const selfClosing = raw.endsWith('/');
      if (selfClosing) raw = raw.slice(0, -1).trim();

      const name = raw.split(/[\s>]/)[0].toLowerCase();
      if (!name) continue;
      return { name, closing, selfClosing };
    }
  }

  // The text between the current position and the next '<'.
  textUntilTag() {
    const open = this.text.indexOf('<', this.pos);
    const raw = open < 0 ? this.text.slice(this.pos) : this.text.slice(this.pos, open);
    this.pos = open < 0 ? this.text.length : open;
    return raw;
  }

  // Consume the closing tag for `name`, tolerating whitespace before it.
  expectClose(name) {
    const tag = this.nextTag();
    if (!tag || !tag.closing || tag.name !== name) {
      throw new Error('plist: expected </' + name + '>');
    }
  }
}

function parseXmlValue(scanner, tag) {
  switch (tag.name) {
    case 'true':  return true;
    case 'false': return false;

    case 'string': {
      if (tag.selfClosing) return '';
      const text = scanner.textUntilTag();
      scanner.expectClose('string');
      return unescapeXml(text);
    }
    case 'key': {
      if (tag.selfClosing) return '';
      const text = scanner.textUntilTag();
      scanner.expectClose('key');
      return unescapeXml(text);
    }
    case 'data': {
      if (tag.selfClosing) return Buffer.alloc(0);
      const text = scanner.textUntilTag();
      scanner.expectClose('data');
      return Buffer.from(text.replace(/\s+/g, ''), 'base64');
    }
    case 'integer': {
      if (tag.selfClosing) return 0;
      const text = scanner.textUntilTag().trim();
      scanner.expectClose('integer');
      return Number(text);
    }
    case 'real': {
      if (tag.selfClosing) return 0;
      const text = scanner.textUntilTag().trim();
      scanner.expectClose('real');
      return Number(text);
    }
    case 'date': {
      if (tag.selfClosing) return new Date(0);
      const text = scanner.textUntilTag().trim();
      scanner.expectClose('date');
      return new Date(text);
    }
    case 'array': {
      const items = [];
      if (tag.selfClosing) return items;
      for (;;) {
        const next = scanner.nextTag();
        if (!next) throw new Error('plist: unterminated <array>');
        if (next.closing && next.name === 'array') return items;
        items.push(parseXmlValue(scanner, next));
      }
    }
    case 'dict': {
      const dict = {};
      if (tag.selfClosing) return dict;
      for (;;) {
        const keyTag = scanner.nextTag();
        if (!keyTag) throw new Error('plist: unterminated <dict>');
        if (keyTag.closing && keyTag.name === 'dict') return dict;
        if (keyTag.name !== 'key') throw new Error('plist: expected <key>, saw <' + keyTag.name + '>');
        const key = parseXmlValue(scanner, keyTag);
        const valueTag = scanner.nextTag();
        if (!valueTag) throw new Error('plist: <key>' + key + '</key> has no value');
        dict[key] = parseXmlValue(scanner, valueTag);
      }
    }
    default:
      throw new Error('plist: unsupported element <' + tag.name + '>');
  }
}

function parseXml(buf) {
  const scanner = new XmlScanner(buf.toString('utf8'));
  for (;;) {
    const tag = scanner.nextTag();
    if (!tag) throw new Error('plist: no root element');
    // <plist> is a container, not a value; step through it to its single child.
    if (tag.name === 'plist' && !tag.closing) continue;
    if (tag.closing) continue;
    return parseXmlValue(scanner, tag);
  }
}

// ─── Binary reader ────────────────────────────────────────────────────────────
//
// bplist00: a header, a flat object table, an offset table, and a 32-byte
// trailer that says how wide the offsets and the inter-object references are.
// Objects reference each other by index, which is why dictionaries are two
// parallel arrays of references rather than inline pairs.

function isBinary(buf) {
  return Buffer.isBuffer(buf) && buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

class BinaryPlistReader {
  constructor(buf) {
    if (buf.length < MAGIC.length + 32) throw new Error('plist: binary plist too short');
    const trailer = buf.length - 32;
    this.buf = buf;
    this.offsetSize = buf[trailer + 6];
    this.refSize = buf[trailer + 7];
    this.count = Number(buf.readBigUInt64BE(trailer + 8));
    this.rootIndex = Number(buf.readBigUInt64BE(trailer + 16));
    this.tableOffset = Number(buf.readBigUInt64BE(trailer + 24));

    if (this.offsetSize < 1 || this.offsetSize > 8 || this.refSize < 1 || this.refSize > 8) {
      throw new Error('plist: implausible binary plist trailer');
    }
    if (this.tableOffset + this.count * this.offsetSize > trailer) {
      throw new Error('plist: binary plist offset table out of range');
    }
  }

  uint(offset, size) {
    let value = 0n;
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(this.buf[offset + i]);
    return value;
  }

  offsetOf(index) {
    if (index < 0 || index >= this.count) throw new Error('plist: object index out of range');
    return Number(this.uint(this.tableOffset + index * this.offsetSize, this.offsetSize));
  }

  // Resolves the element count and payload start for the markers whose low
  // nibble is 0xF, which means the real count is carried by an integer object
  // that immediately follows the marker byte.
  sizeAt(offset, info) {
    if (info !== 0x0f) return { count: info, start: offset + 1 };
    const marker = this.buf[offset + 1];
    if ((marker & 0xf0) !== 0x10) throw new Error('plist: bad extended length marker');
    const width = 1 << (marker & 0x0f);
    return {
      count: Number(this.uint(offset + 2, width)),
      start: offset + 2 + width
    };
  }

  read(index) {
    const offset = this.offsetOf(index);
    const marker = this.buf[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;

    switch (type) {
      case 0x0:
        if (info === 0x00) return null;
        if (info === 0x08) return false;
        if (info === 0x09) return true;
        throw new Error('plist: unsupported singleton 0x0' + info.toString(16));

      case 0x1: {
        const width = 1 << info;
        const raw = this.uint(offset + 1, width);
        // Eight-byte integers are signed in bplist; narrower ones never are.
        const value = width === 8 && raw >= 1n << 63n ? raw - (1n << 64n) : raw;
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value;
      }

      case 0x2:
        if (info === 2) return this.buf.readFloatBE(offset + 1);
        if (info === 3) return this.buf.readDoubleBE(offset + 1);
        throw new Error('plist: unsupported real width');

      case 0x3:
        return new Date(this.buf.readDoubleBE(offset + 1) * 1000 + APPLE_EPOCH_OFFSET_MS);

      case 0x4: {
        const { count, start } = this.sizeAt(offset, info);
        return Buffer.from(this.buf.subarray(start, start + count));
      }

      case 0x5: {
        const { count, start } = this.sizeAt(offset, info);
        return this.buf.toString('latin1', start, start + count);
      }

      case 0x6: {
        const { count, start } = this.sizeAt(offset, info);
        // UTF-16BE, and Node only decodes UTF-16LE — swap in place on a copy.
        const bytes = Buffer.from(this.buf.subarray(start, start + count * 2));
        bytes.swap16();
        return bytes.toString('utf16le');
      }

      case 0x7: {
        const { count, start } = this.sizeAt(offset, info);
        return this.buf.toString('utf8', start, start + count);
      }

      case 0xa:
      case 0xc: {
        const { count, start } = this.sizeAt(offset, info);
        const items = [];
        for (let i = 0; i < count; i++) {
          items.push(this.read(Number(this.uint(start + i * this.refSize, this.refSize))));
        }
        return items;
      }

      case 0xd: {
        const { count, start } = this.sizeAt(offset, info);
        const dict = {};
        for (let i = 0; i < count; i++) {
          const key = this.read(Number(this.uint(start + i * this.refSize, this.refSize)));
          const value = this.read(Number(this.uint(start + (count + i) * this.refSize, this.refSize)));
          dict[String(key)] = value;
        }
        return dict;
      }

      default:
        throw new Error('plist: unsupported marker 0x' + marker.toString(16));
    }
  }
}

function parseBinary(buf) {
  const reader = new BinaryPlistReader(buf);
  return reader.read(reader.rootIndex);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Parse a property list, in either of the two encodings Apple serves.
 *
 * The encoding is taken from the bytes rather than from a caller-supplied hint:
 * the /bag response nests a binary plist inside an XML one, so the same call
 * site genuinely sees both.
 *
 * @param {Buffer|string} data  the document
 * @returns {*} the parsed value
 */
function parse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return isBinary(buf) ? parseBinary(buf) : parseXml(buf);
}

module.exports = {
  parse,
  writeXml,
  // exported for tests
  isBinary,
  parseBinary,
  parseXml,
  escapeXml,
  unescapeXml
};
