'use strict';

const WIRE_VARINT = 0;
const WIRE_64     = 1;
const WIRE_LEN    = 2;

function tag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeVarint(n) {
  // Use Math.floor/% instead of bitwise ops to handle values > 2^31 safely
  // (JavaScript bitwise ops coerce to Int32, breaking timestamps in ms, large file sizes etc.)
  const bytes = [];
  let val = Math.floor(n);
  while (val > 127) {
    bytes.push((val % 128) | 0x80);
    val = Math.floor(val / 128);
  }
  bytes.push(val);
  return Buffer.from(bytes);
}

function encodeVarintSigned(n) {
  if (n < 0) {
    const big = BigInt(n);
    const unsigned = big & 0xffffffffffffffffn;
    const bytes = [];
    let val = unsigned;
    while (val > 127n) {
      bytes.push(Number(val & 0x7fn) | 0x80);
      val = val >> 7n;
    }
    bytes.push(Number(val));
    return Buffer.from(bytes);
  }
  return encodeVarint(n);
}

function field(fieldNum, wireType, data) {
  if (data === null || data === undefined) return Buffer.alloc(0);
  const t = tag(fieldNum, wireType);
  if (wireType === WIRE_VARINT) {
    return Buffer.concat([t, data]);
  }
  const lenBuf = encodeVarint(data.length);
  return Buffer.concat([t, lenBuf, data]);
}

function varint(n)   { return encodeVarint(n); }
function varintS(n)  { return encodeVarintSigned(n); }
function bytes(b)    { return b ? Buffer.from(b) : Buffer.alloc(0); }
function str(s)      { return s ? Buffer.from(s, 'utf8') : Buffer.alloc(0); }
function bool(b)     { return encodeVarint(b ? 1 : 0); }

function encodeDouble(fieldNum, value) {
  const t   = tag(fieldNum, WIRE_64);
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([t, buf]);
}

function encodeText(text, contextInfo) {
  if (contextInfo) {
    const inner = Buffer.concat([
      field(1,  WIRE_LEN, str(text)),
      field(17, WIRE_LEN, encodeContextInfo(contextInfo))
    ]);
    return field(38, WIRE_LEN, inner);
  }
  return field(1, WIRE_LEN, str(text));
}

 function encodeContextInfo(ctx) {
  const parts = [];
  if (ctx.quotedMessageId)  parts.push(field(1, WIRE_LEN, str(ctx.quotedMessageId)));
  if (ctx.participant)      parts.push(field(2, WIRE_LEN, str(ctx.participant)));
  if (ctx.quotedMessage)    parts.push(field(3, WIRE_LEN, ctx.quotedMessage));
  if (ctx.remoteJid)        parts.push(field(4, WIRE_LEN, str(ctx.remoteJid)));
  if (Array.isArray(ctx.mentionedJid)) {
    for (const jid of ctx.mentionedJid) parts.push(field(15, WIRE_LEN, str(jid)));
  }
  return Buffer.concat(parts);
}

function encodeImageMessage(opts) {
  const parts = [
    field(1,  WIRE_LEN,    str(opts.url)),
    field(2,  WIRE_LEN,    str(opts.mimetype || 'image/jpeg')),
    field(3,  WIRE_LEN,    str(opts.caption  || '')),
    field(4,  WIRE_LEN,    bytes(opts.fileSha256)),
    field(5,  WIRE_VARINT, varint(opts.fileLength)),
    field(6,  WIRE_VARINT, varint(opts.height  || 0)),
    field(7,  WIRE_VARINT, varint(opts.width   || 0)),
    field(8,  WIRE_LEN,    bytes(opts.mediaKey)),
    field(9,  WIRE_LEN,    bytes(opts.fileEncSha256)),
    field(11, WIRE_LEN,    str(opts.directPath)),
    field(12, WIRE_VARINT, varintS(opts.mediaKeyTimestamp || Math.floor(Date.now() / 1000)))
  ];
  if (opts.jpegThumbnail) parts.push(field(16, WIRE_LEN, bytes(opts.jpegThumbnail)));
  if (opts.contextInfo)   parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

function encodeVideoMessage(opts) {
  const parts = [
    field(1,  WIRE_LEN,    str(opts.url)),
    field(2,  WIRE_LEN,    str(opts.mimetype || 'video/mp4')),
    field(3,  WIRE_LEN,    bytes(opts.fileSha256)),
    field(4,  WIRE_VARINT, varint(opts.fileLength)),
    field(5,  WIRE_VARINT, varint(opts.seconds || 0)),
    field(6,  WIRE_LEN,    bytes(opts.mediaKey)),
    field(7,  WIRE_LEN,    str(opts.caption || '')),
    field(9,  WIRE_VARINT, varint(opts.height || 0)),
    field(10, WIRE_VARINT, varint(opts.width  || 0)),
    field(11, WIRE_LEN,    bytes(opts.fileEncSha256)),
    field(13, WIRE_LEN,    str(opts.directPath)),
    field(14, WIRE_VARINT, varintS(opts.mediaKeyTimestamp || Math.floor(Date.now() / 1000)))
  ];
  if (opts.gifPlayback)   parts.push(field(8,  WIRE_VARINT, bool(true)));
  if (opts.jpegThumbnail) parts.push(field(16, WIRE_LEN, bytes(opts.jpegThumbnail)));
  if (opts.contextInfo)   parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

function encodeAudioMessage(opts) {
  // ptt (field 6) goes between seconds (5) and mediaKey (7) — must be in field-number order
  const pttField = opts.ptt ? field(6, WIRE_VARINT, bool(true)) : Buffer.alloc(0);
  const parts = [
    field(1,  WIRE_LEN,    str(opts.url)),
    field(2,  WIRE_LEN,    str(opts.mimetype || 'audio/ogg; codecs=opus')),
    field(3,  WIRE_LEN,    bytes(opts.fileSha256)),
    field(4,  WIRE_VARINT, varint(opts.fileLength)),
    field(5,  WIRE_VARINT, varint(opts.seconds || 0)),
    pttField,
    field(7,  WIRE_LEN,    bytes(opts.mediaKey)),
    field(8,  WIRE_LEN,    bytes(opts.fileEncSha256)),
    field(9,  WIRE_LEN,    str(opts.directPath)),
    field(10, WIRE_VARINT, varintS(opts.mediaKeyTimestamp || Math.floor(Date.now() / 1000)))
  ];
  if (opts.contextInfo) parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

function encodeDocumentMessage(opts) {
  const parts = [
    field(1,  WIRE_LEN,    str(opts.url)),
    field(2,  WIRE_LEN,    str(opts.mimetype || 'application/octet-stream')),
    field(3,  WIRE_LEN,    str(opts.title    || opts.fileName || 'file')),
    field(4,  WIRE_LEN,    bytes(opts.fileSha256)),
    field(5,  WIRE_VARINT, varint(opts.fileLength)),
    field(7,  WIRE_LEN,    bytes(opts.mediaKey)),
    field(8,  WIRE_LEN,    str(opts.fileName || 'file')),
    field(9,  WIRE_LEN,    bytes(opts.fileEncSha256)),
    field(10, WIRE_LEN,    str(opts.directPath)),
    field(11, WIRE_VARINT, varintS(opts.mediaKeyTimestamp || Math.floor(Date.now() / 1000)))
  ];
  if (opts.jpegThumbnail) parts.push(field(16, WIRE_LEN, bytes(opts.jpegThumbnail)));
  if (opts.contextInfo)   parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

function encodeStickerMessage(opts) {
  const parts = [
    field(1,  WIRE_LEN,    str(opts.url)),
    field(2,  WIRE_LEN,    bytes(opts.fileSha256)),
    field(3,  WIRE_LEN,    bytes(opts.fileEncSha256)),
    field(4,  WIRE_LEN,    bytes(opts.mediaKey)),
    field(5,  WIRE_LEN,    str(opts.mimetype || 'image/webp')),
    field(6,  WIRE_VARINT, varint(opts.height || 512)),
    field(7,  WIRE_VARINT, varint(opts.width  || 512)),
    field(8,  WIRE_LEN,    str(opts.directPath)),
    field(9,  WIRE_VARINT, varint(opts.fileLength)),
    field(10, WIRE_VARINT, varintS(opts.mediaKeyTimestamp || Math.floor(Date.now() / 1000)))
  ];
  if (opts.isAnimated)  parts.push(field(13, WIRE_VARINT, bool(true)));
  if (opts.contextInfo) parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

// ─── Poll messages (field 85 / 89 of Message) ────────────────────────────────
//
// PollCreationMessage:
//   field 1 = encKey   (bytes, 32 random bytes — used to encrypt votes)
//   field 2 = name     (string, the question text)
//   field 3 = options  (repeated PollOption: field 1 = option name string)
//   field 4 = selectableOptionsCount (uint32 — 0 means any number)
//
// PollUpdateMessage (vote):
//   field 1 = pollCreationMessageKey (MessageKey)
//   field 2 = vote                   (PollVote — encrypted bytes)
//   field 3 = senderTimestampMs      (int64)

function encodePollOption(name) {
  return field(1, WIRE_LEN, str(name));
}

function encodePollCreationMessage(opts) {
  // encKey: 32 random bytes (generate if not provided)
  const encKey = opts.encKey || require('crypto').randomBytes(32);
  const parts = [
    field(1, WIRE_LEN,    bytes(encKey)),
    field(2, WIRE_LEN,    str(opts.name || opts.question || '')),
  ];
  for (const opt of (opts.options || [])) {
    parts.push(field(3, WIRE_LEN, encodePollOption(String(opt))));
  }
  if (opts.selectableOptionsCount != null) {
    parts.push(field(4, WIRE_VARINT, varint(opts.selectableOptionsCount)));
  }
  return { payload: Buffer.concat(parts), encKey };
}

// ─── LocationMessage (field 5 of Message) ────────────────────────────────────
// LocationMessage { degreesLatitude=1(double), degreesLongitude=2(double),
//                   name=3, address=4, url=5 }
function encodeLocationMessage(opts) {
  const parts = [];
  if (opts.latitude  != null) parts.push(encodeDouble(1, opts.latitude));
  if (opts.longitude != null) parts.push(encodeDouble(2, opts.longitude));
  if (opts.name)     parts.push(field(3, WIRE_LEN, str(opts.name)));
  if (opts.address)  parts.push(field(4, WIRE_LEN, str(opts.address)));
  if (opts.url)      parts.push(field(5, WIRE_LEN, str(opts.url)));
  return Buffer.concat(parts);
}

// ─── ContactMessage (field 4 of Message) ─────────────────────────────────────
// ContactMessage { displayName=1, vcard=16 }
function encodeContactMessage(opts) {
  return Buffer.concat([
    field(1,  WIRE_LEN, str(opts.displayName || opts.name || '')),
    field(16, WIRE_LEN, str(opts.vcard || ''))
  ]);
}

function encodeReactionMessage(opts) {
  const parts = [
    field(1, WIRE_LEN,    encodeMessageKey(opts.key)),
    field(2, WIRE_LEN,    str(opts.text || '')),
    field(4, WIRE_VARINT, varintS(opts.senderTimestampMs || Date.now()))
  ];
  return Buffer.concat(parts);
}

function encodeMessageKey(key) {
  return Buffer.concat([
    field(1, WIRE_LEN, str(key.remoteJid)),
    field(2, WIRE_VARINT, bool(key.fromMe || false)),
    field(3, WIRE_LEN, str(key.id))
  ]);
}

function encodeMessage(type, payload) {
  switch (type) {
    case 'text':         return payload;
    case 'image':        return field(3,  WIRE_LEN, payload);
    case 'document':     return field(7,  WIRE_LEN, payload);
    case 'audio':        return field(8,  WIRE_LEN, payload);
    case 'video':        return field(9,  WIRE_LEN, payload);
    case 'sticker':      return field(26, WIRE_LEN, payload);
    case 'reaction':     return field(46, WIRE_LEN, payload);
    case 'protocol':     return field(12, WIRE_LEN, payload);
    case 'extendedText': return field(2,  WIRE_LEN, payload);
    case 'poll':         return field(85, WIRE_LEN, payload);
    case 'location':     return field(5,  WIRE_LEN, payload);
    case 'contact':      return field(4,  WIRE_LEN, payload);
    default:             return payload;
  }
}

// ─── DeviceSentMessage wrapper (field 31 of Message) ─────────────────────────
// Used when sending to own linked devices — wraps the original message so other
// devices know where the message was originally addressed (destinationJid).
// DeviceSentMessage { destinationJid=1, message=2, phash=3 }

function encodeDeviceSentMessage(destinationJid, messageBuf, phash) {
  const inner = Buffer.concat([
    field(1, WIRE_LEN, str(destinationJid)),
    field(2, WIRE_LEN, messageBuf),
    phash ? field(3, WIRE_LEN, str(phash)) : Buffer.alloc(0)
  ]);
  return field(31, WIRE_LEN, inner);
}

// ─── ProtocolMessage (field 12 of Message) ───────────────────────────────────
// ProtocolMessage { key=1, type=2, ephemeralExpiration=4, ... }
// Type enum: REVOKE=0, EPHEMERAL_SETTING=3
const PROTOCOL_MSG_REVOKE    = 0;
const PROTOCOL_MSG_EPHEMERAL = 3;

function encodeProtocolMessage(opts) {
  // opts: { type, key: { remoteJid, fromMe, id }, ephemeralExpiration }
  const parts = [];
  if (opts.key) parts.push(field(1, WIRE_LEN, encodeMessageKey(opts.key)));
  if (opts.type !== undefined) parts.push(field(2, WIRE_VARINT, varint(opts.type)));
  if (opts.ephemeralExpiration !== undefined) parts.push(field(4, WIRE_VARINT, varint(opts.ephemeralExpiration)));
  return Buffer.concat(parts);
}

// ─── Extended text message for editing ───────────────────────────────────────
// ExtendedTextMessage { text=1 } — used when editing a text message
function encodeExtendedText(text) {
  return field(1, WIRE_LEN, str(text));
}

// ─── Protobuf decoder ─────────────────────────────────────────────────────────
// Decodes the raw bytes that come out of Signal decryption into a structured
// message object from MessageContainerSpec.decode()
// + .unbox().

function _readVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value: result, offset };
}

function _decodeFields(buf) {
  const fields = {};
  let offset = 0;
  while (offset < buf.length) {
    if (offset >= buf.length) break;
    const tr = _readVarint(buf, offset);
    offset = tr.offset;
    const fieldNum  = tr.value >> 3;
    const wireType  = tr.value & 0x7;
    if (wireType === 0) {
      const vr = _readVarint(buf, offset);
      fields[fieldNum] = (fields[fieldNum] !== undefined)
        ? [].concat(fields[fieldNum], vr.value)
        : vr.value;
      offset = vr.offset;
    } else if (wireType === 2) {
      const lr = _readVarint(buf, offset);
      offset = lr.offset;
      const data = buf.slice(offset, offset + lr.value);
      offset += lr.value;
      if (fields[fieldNum] !== undefined) {
        if (!Array.isArray(fields[fieldNum])) fields[fieldNum] = [fields[fieldNum]];
        fields[fieldNum].push(data);
      } else {
        fields[fieldNum] = data;
      }
    } else if (wireType === 1) {
      const data = buf.slice(offset, offset + 8);
      fields[fieldNum] = data;
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function _str(buf) {
  if (!buf) return '';
  try { return buf.toString('utf8'); } catch (_) { return ''; }
}

function _dbl(buf) {
  if (!buf || buf.length < 8) return 0;
  return buf.readDoubleLE(0);
}

function decodeMessageContainer(buf) {
  if (!buf || buf.length === 0) return { type: 'unknown' };
  try {
    const f = _decodeFields(buf);

    // Field 31: deviceSentMessage — wraps the real message at field 2
    // (sent to our own linked devices). Unwrap and re-decode.
    if (f[31]) {
      const dsm = _decodeFields(f[31]);
      if (dsm[2]) return decodeMessageContainer(dsm[2]);
    }

    // Field 35: senderKeyDistributionMessage — used to set up sender keys.
    // In WhatsApp Multi-Device, SKDM is bundled WITH the first real message in a new
    // session (even for 1-on-1 DMs). We extract it and continue decoding the real message.
    let skdmInfo = null;
    if (f[35]) {
      const skdm = _decodeFields(f[35]);
      // field 1 = groupId (string), field 2 = axolotlSenderKeyDistributionMessage (bytes)
      skdmInfo = {
        groupId: _str(skdm[1]),
        axolotlBytes: skdm[2] || null   // raw libsignal SKDM bytes starting with 0x33
      };
    }

    // Decode the actual message payload (independent of SKDM).
    // We use a helper so we can attach skdmInfo to every result.
    let msgResult = null;

    // Field 1: conversation — plain text
    if (!msgResult && f[1] && Buffer.isBuffer(f[1])) {
      const text = _str(f[1]);
      if (text) msgResult = { type: 'text', text };
    }

    // Field 2: extendedTextMessage — field 1 = text
    if (!msgResult && f[2] && Buffer.isBuffer(f[2])) {
      try {
        const ext = _decodeFields(f[2]);
        const text = _str(ext[1]);
        if (text) msgResult = { type: 'text', text };
      } catch (_) {}
    }

    // Field 3: imageMessage
    if (!msgResult && f[3] && Buffer.isBuffer(f[3])) {
      try {
        const img = _decodeFields(f[3]);
        msgResult = {
          type: 'image',
          caption: _str(img[3]),
          url: _str(img[1]),
          mimetype: _str(img[2]) || 'image/jpeg',
          mediaKey: img[8] || null,
          directPath: _str(img[11]),
        };
      } catch (_) { msgResult = { type: 'image', caption: '' }; }
    }

    // Field 4: contactMessage — displayName=1, vcard=16
    if (!msgResult && f[4] && Buffer.isBuffer(f[4])) {
      try {
        const c = _decodeFields(f[4]);
        msgResult = { type: 'contact', displayName: _str(c[1]), vcard: _str(c[16]) };
      } catch (_) { msgResult = { type: 'contact', displayName: '', vcard: '' }; }
    }

    // Field 5: locationMessage — lat=1(double), lon=2(double), name=3, address=4, url=5
    if (!msgResult && f[5] && Buffer.isBuffer(f[5])) {
      try {
        const loc = _decodeFields(f[5]);
        msgResult = {
          type:      'location',
          latitude:  _dbl(loc[1]),
          longitude: _dbl(loc[2]),
          name:      _str(loc[3]),
          address:   _str(loc[4]),
          url:       _str(loc[5])
        };
      } catch (_) { msgResult = { type: 'location', latitude: 0, longitude: 0 }; }
    }

    // Field 7: documentMessage
    if (!msgResult && f[7] && Buffer.isBuffer(f[7])) {
      try {
        const doc = _decodeFields(f[7]);
        msgResult = {
          type: 'document',
          fileName: _str(doc[8]) || _str(doc[3]) || 'document',
          url: _str(doc[1]),
          mimetype: _str(doc[2]) || 'application/octet-stream',
          mediaKey: doc[7] || null,
          directPath: _str(doc[10]),
        };
      } catch (_) { msgResult = { type: 'document', fileName: 'document' }; }
    }

    // Field 8: audioMessage
    if (!msgResult && f[8] && Buffer.isBuffer(f[8])) {
      try {
        const aud = _decodeFields(f[8]);
        msgResult = {
          type: aud[6] ? 'voice' : 'audio',
          url: _str(aud[1]),
          mimetype: _str(aud[2]) || 'audio/ogg; codecs=opus',
          mediaKey: aud[7] || null,
          directPath: _str(aud[9]),
        };
      } catch (_) { msgResult = { type: 'audio' }; }
    }

    // Field 9: videoMessage
    if (!msgResult && f[9] && Buffer.isBuffer(f[9])) {
      try {
        const vid = _decodeFields(f[9]);
        msgResult = {
          type: 'video',
          caption: _str(vid[7]),
          url: _str(vid[1]),
          mimetype: _str(vid[2]) || 'video/mp4',
          mediaKey: vid[6] || null,
          directPath: _str(vid[13]),
        };
      } catch (_) { msgResult = { type: 'video', caption: '' }; }
    }

    // Field 12: protocolMessage
    if (!msgResult && f[12] && Buffer.isBuffer(f[12])) {
      try {
        const pm = _decodeFields(f[12]);
        const pmType = pm[2];
        const typeNames = { 0: 'revoke', 3: 'ephemeral', 10: 'app_state_sync' };
        msgResult = { type: 'protocol', subtype: typeNames[pmType] || String(pmType) };
      } catch (_) { msgResult = { type: 'protocol', subtype: 'unknown' }; }
    }

    // Field 26: stickerMessage
    if (!msgResult && f[26] && Buffer.isBuffer(f[26])) {
      try {
        const stk = _decodeFields(f[26]);
        msgResult = {
          type: 'sticker',
          url: _str(stk[1]),
          mimetype: _str(stk[5]) || 'image/webp',
          mediaKey: stk[4] || null,
          directPath: _str(stk[8]),
        };
      } catch (_) { msgResult = { type: 'sticker' }; }
    }

    // Field 46: reactionMessage
    if (!msgResult && f[46] && Buffer.isBuffer(f[46])) {
      try {
        const react = _decodeFields(f[46]);
        msgResult = { type: 'reaction', emoji: _str(react[2]) };
      } catch (_) { msgResult = { type: 'reaction', emoji: '' }; }
    }

    // Field 85: pollCreationMessage
    // encKey=1, name=2 (question), options=3 (repeated PollOption{name=1}), selectableOptionsCount=4
    if (!msgResult && f[85] && Buffer.isBuffer(f[85])) {
      try {
        const poll = _decodeFields(f[85]);
        const question = _str(poll[2]);
        const rawOpts  = poll[3];
        const options  = [];
        if (rawOpts) {
          const optBufs = Array.isArray(rawOpts) ? rawOpts : [rawOpts];
          for (const ob of optBufs) {
            if (Buffer.isBuffer(ob)) {
              const o = _decodeFields(ob);
              options.push(_str(o[1]));
            }
          }
        }
        const selectableOptionsCount = typeof poll[4] === 'number' ? poll[4] : 0;
        msgResult = { type: 'poll', question, options, selectableOptionsCount, encKey: poll[1] || null };
      } catch (_) { msgResult = { type: 'poll', question: '', options: [] }; }
    }

    // Field 89: pollUpdateMessage (a vote on an existing poll)
    if (!msgResult && f[89] && Buffer.isBuffer(f[89])) {
      msgResult = { type: 'pollVote' };
    }

    // If we found a real message, attach skdmInfo (if any) and return
    if (msgResult) {
      return skdmInfo ? Object.assign({}, msgResult, { skdm: skdmInfo }) : msgResult;
    }

    // If we only have an SKDM (no other message content), return senderKeyDistribution
    if (skdmInfo) {
      return { type: 'senderKeyDistribution', groupId: skdmInfo.groupId, axolotlBytes: skdmInfo.axolotlBytes };
    }

    return { type: 'unknown' };
  } catch (_) {
    return { type: 'unknown' };
  }
}

function encodeSenderKeyDistributionMessage(groupId, axolotlBytes) {
  const inner = Buffer.concat([
    field(1, WIRE_LEN, str(groupId)),
    field(2, WIRE_LEN, bytes(axolotlBytes))
  ]);
  return field(35, WIRE_LEN, inner);
}

module.exports = {
  encodeText,
  encodeImageMessage,
  encodeVideoMessage,
  encodeAudioMessage,
  encodeDocumentMessage,
  encodeStickerMessage,
  encodeReactionMessage,
  encodePollCreationMessage,
  encodeLocationMessage,
  encodeContactMessage,
  encodeMessageKey,
  encodeMessage,
  encodeDeviceSentMessage,
  encodeProtocolMessage,
  encodeExtendedText,
  encodeContextInfo,
  encodeSenderKeyDistributionMessage,
  encodeVarint,
  field,
  varint,
  str,
  bytes,
  WIRE_VARINT,
  WIRE_LEN,
  PROTOCOL_MSG_REVOKE,
  PROTOCOL_MSG_EPHEMERAL,
  decodeMessageContainer
};
