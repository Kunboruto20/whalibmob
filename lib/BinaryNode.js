'use strict';

const { TAG } = require('./constants');
const { SINGLE_BYTE, DICTS, tokenToString, dictTokenToString, stringToSingleByte, stringToDictToken } = require('./tokens');

class BinaryNode {
  constructor(description, attrs = {}, content = null) {
    this.description = description;
    this.attrs = attrs;
    this.content = content;
  }
}

function encodeNode(node) {
  const parts = [];
  _writeNode(node, parts);
  const buf = Buffer.concat(parts);
  const out = Buffer.alloc(1 + buf.length);
  out[0] = 0;
  buf.copy(out, 1);
  return out;
}

function _writeNode(node, parts) {
  const attrKeys = Object.keys(node.attrs || {});
  const hasContent = node.content !== null && node.content !== undefined;
  const size = 2 * attrKeys.length + 1 + (hasContent ? 1 : 0);
  _writeListSize(size, parts);
  _writeString(node.description, parts);
  for (const key of attrKeys) {
    _writeString(key, parts);
    _writeValue(node.attrs[key], parts);
  }
  if (hasContent) _writeValue(node.content, parts);
}

function _writeListSize(size, parts) {
  if (size === 0) {
    parts.push(Buffer.from([TAG.LIST_EMPTY]));
  } else if (size < 256) {
    parts.push(Buffer.from([TAG.LIST_8, size]));
  } else {
    parts.push(Buffer.from([TAG.LIST_16, (size >> 8) & 0xff, size & 0xff]));
  }
}

// Servers that make a string an addressable JID rather than free text.
const _JID_SERVERS = new Set([
  's.whatsapp.net', 'g.us', 'lid', 'broadcast', 'call', 'newsletter', 'c.us', 's.us'
]);

// "120363427770886227@g.us" / "919634847671:2@s.whatsapp.net" → JID object.
// Returns null for anything that is not a full JID, so plain strings (and
// bare server tokens like "g.us", which the dictionary already encodes as a
// valid address) keep their existing encoding untouched.
function _jidFromString(str) {
  const at = str.indexOf('@');
  if (at <= 0 || at === str.length - 1) return null;
  const server = str.slice(at + 1);
  if (!_JID_SERVERS.has(server)) return null;
  const raw   = str.slice(0, at);
  const colon = raw.indexOf(':');
  const user  = colon >= 0 ? raw.slice(0, colon) : raw;
  const device = colon >= 0 ? (parseInt(raw.slice(colon + 1), 10) || 0) : 0;
  // Mirrors jidStrToObj in DeviceManager: AD_JID only for multi-device
  // @s.whatsapp.net, and @lid keeps the colon inside the user part.
  if (server === 's.whatsapp.net' && device > 0) return { user, agent: 0, device, server };
  if (server === 'lid' && device > 0)            return { user: raw, server };
  return { user, server };
}

function _writeValue(value, parts) {
  if (value === null || value === undefined) {
    parts.push(Buffer.from([TAG.LIST_EMPTY]));
  } else if (typeof value === 'string') {
    // A full JID written as a plain string would go out as a raw text blob,
    // which the server cannot route — IQs addressed that way simply never get
    // an answer. Encode it as JID_PAIR/AD_JID like an object JID.
    const jid = _jidFromString(value);
    if (jid) _writeJid(jid, parts);
    else     _writeString(value, parts);
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    _writeBytes(buf, parts);
  } else if (typeof value === 'object' && value.user !== undefined) {
    _writeJid(value, parts);
  } else if (Array.isArray(value)) {
    _writeListSize(value.length, parts);
    for (const item of value) _writeNode(item, parts);
  } else if (value instanceof BinaryNode) {
    // Node content always reads back as a list, so a lone child has to go out
    // as a one-element list. Written bare, the child's own list header would be
    // taken for this node's child count and the rest of the node misparsed.
    _writeListSize(1, parts);
    _writeNode(value, parts);
  } else {
    _writeString(String(value), parts);
  }
}

function _writeString(str, parts) {
  const single = stringToSingleByte(str);
  if (single !== -1) {
    parts.push(Buffer.from([single]));
    return;
  }
  const dict = stringToDictToken(str);
  if (dict) {
    parts.push(Buffer.from([TAG.DICTIONARY_0 + dict.dict, dict.index]));
    return;
  }
  const buf = Buffer.from(str, 'utf8');
  _writeBytes(buf, parts);
}

function _writeBytes(buf, parts) {
  if (buf.length < 256) {
    parts.push(Buffer.from([TAG.BINARY_8, buf.length]));
  } else if (buf.length < 1048576) {
    const b1 = (buf.length >> 16) & 0xff;
    const b2 = (buf.length >> 8) & 0xff;
    const b3 = buf.length & 0xff;
    parts.push(Buffer.from([TAG.BINARY_20, b1, b2, b3]));
  } else {
    const b1 = (buf.length >> 24) & 0xff;
    const b2 = (buf.length >> 16) & 0xff;
    const b3 = (buf.length >> 8) & 0xff;
    const b4 = buf.length & 0xff;
    parts.push(Buffer.from([TAG.BINARY_32, b1, b2, b3, b4]));
  }
  parts.push(buf);
}

// AD_JID agent byte ↔ domain. 0 = phone JIDs, 1 = LIDs.
const _AGENT_SERVER = { 0: 's.whatsapp.net', 1: 'lid' };
function _serverForAgent(agent) {
  return _AGENT_SERVER[agent] || 's.whatsapp.net';
}
function _agentForServer(server) {
  return server === 'lid' ? 1 : 0;
}

function _writeJid(jid, parts) {
  // Derive the agent from the domain only when this JID is going out as AD_JID
  // anyway (explicit agent, or a device suffix). A plain LID keeps its
  // JID_PAIR + 'lid' server-token encoding, which is what the server expects
  // and what the rest of the codebase already produces.
  const agent = (jid.agent !== undefined && jid.agent !== null)
    ? jid.agent
    : (jid.device ? _agentForServer(jid.server) : 0);
  if (agent || jid.device) {
    parts.push(Buffer.from([TAG.AD_JID, agent || 0, jid.device || 0]));
    _writeString(jid.user, parts);
  } else {
    parts.push(Buffer.from([TAG.JID_PAIR]));
    if (jid.user) _writeString(jid.user, parts);
    else parts.push(Buffer.from([TAG.LIST_EMPTY]));
    _writeString(jid.server, parts);
  }
}

class NodeDecoder {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
    const flags = this._readByte();
    this.compressed = (flags & 2) !== 0;
    if (this.compressed) {
      const zlib = require('zlib');
      this.buf = zlib.inflateSync(this.buf.slice(this.offset));
      this.offset = 0;
    }
  }

  decode() {
    return this._readNode();
  }

  hasMore() {
    return this.offset < this.buf.length;
  }

  _readByte() {
    return this.buf[this.offset++];
  }

  _readBytes(n) {
    const result = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return result;
  }

  _readNode() {
    const listSize = this._readListSize();
    const descToken = this._readByte();
    const description = this._readString(descToken);

    const attrs = {};
    const numAttrs = Math.floor((listSize - 1) / 2);

    for (let i = 0; i < numAttrs; i++) {
      const keyToken = this._readByte();
      const key = this._readString(keyToken);
      const valToken = this._readByte();
      attrs[key] = this._readString(valToken);
    }

    let content = null;
    if (listSize % 2 === 0) {
      const contentToken = this._readByte();
      content = this._readContent(contentToken);
    }

    return new BinaryNode(description, attrs, content);
  }

  _readListSize() {
    const b = this._readByte();
    if (b === TAG.LIST_EMPTY) return 0;
    if (b === TAG.LIST_8) return this._readByte();
    if (b === TAG.LIST_16) return (this._readByte() << 8) | this._readByte();
    throw new Error(`Unknown list tag: ${b}`);
  }

  _readString(token) {
    if (token >= 3 && token < SINGLE_BYTE.length) {
      return SINGLE_BYTE[token];
    }
    if (token === TAG.DICTIONARY_0) return DICTS[0][this._readByte()];
    if (token === TAG.DICTIONARY_1) return DICTS[1][this._readByte()];
    if (token === TAG.DICTIONARY_2) return DICTS[2][this._readByte()];
    if (token === TAG.DICTIONARY_3) return DICTS[3][this._readByte()];
    if (token === TAG.BINARY_8) {
      const len = this._readByte();
      return this._readBytes(len).toString('utf8');
    }
    if (token === TAG.BINARY_20) {
      const b1 = this._readByte(), b2 = this._readByte(), b3 = this._readByte();
      const len = (b1 << 16) | (b2 << 8) | b3;
      return this._readBytes(len).toString('utf8');
    }
    if (token === TAG.BINARY_32) {
      const b1 = this._readByte(), b2 = this._readByte(), b3 = this._readByte(), b4 = this._readByte();
      const len = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
      return this._readBytes(len).toString('utf8');
    }
    if (token === TAG.NIBBLE_8) return this._readPackedBytes(token);
    if (token === TAG.HEX_8) return this._readPackedBytes(token);
    if (token === TAG.JID_PAIR) return this._readJidPair();
    if (token === TAG.AD_JID) return this._readAdJid();
    if (token === TAG.LIST_EMPTY) return null;
    return null;
  }

  _readContent(token) {
    if (token === TAG.LIST_8 || token === TAG.LIST_16 || token === TAG.LIST_EMPTY) {
      let size;
      if (token === TAG.LIST_EMPTY) size = 0;
      else if (token === TAG.LIST_8) size = this._readByte();
      else size = (this._readByte() << 8) | this._readByte();
      const nodes = [];
      for (let i = 0; i < size; i++) nodes.push(this._readNode());
      return nodes;
    }
    if (token === TAG.BINARY_8) {
      const len = this._readByte();
      return this._readBytes(len);
    }
    if (token === TAG.BINARY_20) {
      const b1 = this._readByte(), b2 = this._readByte(), b3 = this._readByte();
      const len = (b1 << 16) | (b2 << 8) | b3;
      return this._readBytes(len);
    }
    if (token === TAG.BINARY_32) {
      const b1 = this._readByte(), b2 = this._readByte(), b3 = this._readByte(), b4 = this._readByte();
      const len = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
      return this._readBytes(len);
    }
    return this._readString(token);
  }

  _readPackedBytes(token) {
    const startByte = this._readByte();
    const hasPadding = (startByte & 0x80) !== 0;
    const count = startByte & 0x7f;
    const data = this._readBytes(count);
    const alphabet = token === TAG.NIBBLE_8
      ? '0123456789-.\uFFFD\uFFFD\uFFFD\uFFFD'
      : '0123456789ABCDEF';
    let result = '';
    for (const byte of data) {
      result += alphabet[(byte >> 4) & 0x0f];
      result += alphabet[byte & 0x0f];
    }
    if (hasPadding) result = result.slice(0, -1);
    return result;
  }

  _readJidPair() {
    const userToken = this._readByte();
    const user = userToken === TAG.LIST_EMPTY ? null : this._readString(userToken);
    const serverToken = this._readByte();
    const server = this._readString(serverToken);
    return { user, server, toString() { return user ? `${user}@${server}` : `@${server}`; } };
  }

  _readAdJid() {
    const agent = this._readByte();
    const device = this._readByte();
    const userToken = this._readByte();
    const user = this._readString(userToken);
    // The agent byte selects the domain — it is not decoration. Hardcoding
    // s.whatsapp.net turned every LID participant (agent 1) into a phone JID
    // that does not exist, so device queries for it came back empty, no Signal
    // session was ever built, and group sends were rejected with ack 479.
    const server = _serverForAgent(agent);
    // The device must survive stringification. Everything downstream keys off
    // the string form: fetchBundles maps bundles by it, so five devices all
    // rendering as "user@server" collapsed into one entry and left the rest
    // without a session; and jidToAddress parses the ":device" out of it, so
    // dropping it addressed every Signal session as device 0 — which is why a
    // message from a linked device could not be decrypted either.
    return {
      user, agent, device, server,
      toString() { return device ? `${user}:${device}@${server}` : `${user}@${server}`; }
    };
  }
}

function decodeNode(buf) {
  const decoder = new NodeDecoder(buf);
  return decoder.decode();
}

function decodeNodes(buf) {
  const decoder = new NodeDecoder(buf);
  const nodes = [];
  while (decoder.hasMore()) nodes.push(decoder.decode());
  return nodes;
}

module.exports = { BinaryNode, encodeNode, decodeNode, decodeNodes };
