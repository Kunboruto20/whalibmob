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

const WIRE_32 = 5;

// fixed32 — four little-endian bytes, wire type 5. ARGB colours use this.
function fixed32(fieldNum, value) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE((value >>> 0), 0);
  return Buffer.concat([tag(fieldNum, WIRE_32), buf]);
}

function encodeDouble(fieldNum, value) {
  const t   = tag(fieldNum, WIRE_64);
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([t, buf]);
}

// Plain text goes in conversation (field 1). Text that carries a contextInfo —
// a quoted reply, a mention — has to be an ExtendedTextMessage instead, which is
// field 6 of Message: { text=1, contextInfo=17 }.
//
// The wrapper was being written to field 38, which is orderMessage, so replies
// and mentions arrived as an unreadable order rather than as text.
function encodeText(text, contextInfo) {
  if (contextInfo) {
    const inner = Buffer.concat([
      field(1,  WIRE_LEN, str(text)),
      field(17, WIRE_LEN, encodeContextInfo(contextInfo))
    ]);
    return field(6, WIRE_LEN, inner);
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

// ─── MessageContextInfo (field 35 of Message) ────────────────────────────────
// MessageContextInfo { deviceListMetadata=1, deviceListMetadataVersion=2,
//                      messageSecret=3, ... }
//
// The message secret is what votes on a poll are encrypted against, so a poll
// sent without one can never be voted on.
function encodeMessageContextInfo(opts) {
  const parts = [];
  if (opts.messageSecret) parts.push(field(3, WIRE_LEN, bytes(opts.messageSecret)));
  if (parts.length === 0) return Buffer.alloc(0);
  return field(35, WIRE_LEN, Buffer.concat(parts));
}

function encodePollOption(name) {
  return field(1, WIRE_LEN, str(name));
}

// PollCreationMessage { encKey=1, name=2, options=3, selectableOptionsCount=4 }
//
// The 32-byte secret was being written to encKey, inside the poll itself.
// whatsmeow's BuildPollCreation leaves encKey unset and puts the secret in
// Message.messageContextInfo.messageSecret instead — which is the copy a voter
// derives their vote key from. In the wrong place it reached nobody, so the
// poll could not be voted on.
function encodePollCreationMessage(opts) {
  const messageSecret = opts.messageSecret || opts.encKey ||
    require('crypto').randomBytes(32);
  const parts = [
    field(2, WIRE_LEN,    str(opts.name || opts.question || '')),
  ];
  for (const opt of (opts.options || [])) {
    parts.push(field(3, WIRE_LEN, encodePollOption(String(opt))));
  }
  if (opts.selectableOptionsCount != null) {
    parts.push(field(4, WIRE_VARINT, varint(opts.selectableOptionsCount)));
  }
  // encKey is the historical name this returned it under; kept so callers that
  // stored it keep working.
  return { payload: Buffer.concat(parts), messageSecret, encKey: messageSecret };
}

// ─── LocationMessage (field 5 of Message) ────────────────────────────────────
// LocationMessage { degreesLatitude=1(double), degreesLongitude=2(double),
//                   name=3, address=4, url=5, isLive=6, accuracyInMeters=7,
//                   jpegThumbnail=16, contextInfo=17 }
//
// jpegThumbnail is the map image drawn in the bubble. Without it the location
// arrives as a blank grey card, the same way a photo without a preview does.
function encodeLocationMessage(opts) {
  const parts = [];
  if (opts.latitude  != null) parts.push(encodeDouble(1, opts.latitude));
  if (opts.longitude != null) parts.push(encodeDouble(2, opts.longitude));
  if (opts.name)     parts.push(field(3, WIRE_LEN, str(opts.name)));
  if (opts.address)  parts.push(field(4, WIRE_LEN, str(opts.address)));
  if (opts.url)      parts.push(field(5, WIRE_LEN, str(opts.url)));
  if (opts.isLive)   parts.push(field(6, WIRE_VARINT, bool(true)));
  if (opts.accuracyInMeters != null) {
    parts.push(field(7, WIRE_VARINT, varint(opts.accuracyInMeters)));
  }
  if (opts.jpegThumbnail) parts.push(field(16, WIRE_LEN, bytes(opts.jpegThumbnail)));
  if (opts.contextInfo)   parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

// ─── ContactMessage (field 4 of Message) ─────────────────────────────────────
// ContactMessage { displayName=1, vcard=16, contextInfo=17 }
function encodeContactMessage(opts) {
  const parts = [
    field(1,  WIRE_LEN, str(opts.displayName || opts.name || '')),
    field(16, WIRE_LEN, str(opts.vcard || ''))
  ];
  if (opts.contextInfo) parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
}

// ─── GroupInviteMessage (field 28 of Message) ────────────────────────────────
//
// The bubble you send someone directly when they cannot simply be added to a
// group: it carries the group's JID plus a one-off invite code and the moment
// that code stops working. Tapping it makes their client send the accept IQ.
//
// GroupInviteMessage { groupJid=1, inviteCode=2, inviteExpiration=3,
//                      groupName=4, jpegThumbnail=5, caption=6, contextInfo=7,
//                      groupType=8 }
//
// groupType is 0 for an ordinary group and 1 for a community.
const GROUP_INVITE_TYPE_DEFAULT = 0;
const GROUP_INVITE_TYPE_PARENT  = 1;

function encodeGroupInviteMessage(opts) {
  const parts = [
    field(1, WIRE_LEN,    str(opts.groupJid || '')),
    field(2, WIRE_LEN,    str(opts.inviteCode || '')),
    field(3, WIRE_VARINT, varint(Number(opts.inviteExpiration) || 0))
  ];
  if (opts.groupName)     parts.push(field(4, WIRE_LEN, str(opts.groupName)));
  if (opts.jpegThumbnail) parts.push(field(5, WIRE_LEN, bytes(opts.jpegThumbnail)));
  if (opts.caption)       parts.push(field(6, WIRE_LEN, str(opts.caption)));
  if (opts.contextInfo)   parts.push(field(7, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  if (opts.groupType)     parts.push(field(8, WIRE_VARINT, varint(Number(opts.groupType) || 0)));
  return Buffer.concat(parts);
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
    case 'groupInvite':  return field(28, WIRE_LEN, payload);
    case 'reaction':     return field(46, WIRE_LEN, payload);
    case 'protocol':     return field(12, WIRE_LEN, payload);
    // extendedTextMessage is field 6. It used to be written to field 2, which is
    // senderKeyDistributionMessage — so an edited message went out claiming to be
    // a SenderKey distribution, and field 2 was not free for the real one.
    case 'extendedText': return field(6,  WIRE_LEN, payload);
    // pollCreationMessage is field 49; field 85 is eventCoverImage.
    case 'poll':         return field(49, WIRE_LEN, payload);
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
// ExtendedTextMessage { text=1, textArgb=7, backgroundArgb=8, font=9,
//                        jpegThumbnail=16, contextInfo=17 }
//
// The colour fields are what a text Status is drawn with; both are fixed32
// (wire type 5), not varints, so they are written little-endian in four bytes.
function encodeExtendedText(text, opts) {
  opts = opts || {};
  const parts = [field(1, WIRE_LEN, str(text))];
  if (opts.textArgb != null)       parts.push(fixed32(7, opts.textArgb));
  if (opts.backgroundArgb != null) parts.push(fixed32(8, opts.backgroundArgb));
  if (opts.font != null)           parts.push(field(9, WIRE_VARINT, varint(opts.font)));
  if (opts.contextInfo)            parts.push(field(17, WIRE_LEN, encodeContextInfo(opts.contextInfo)));
  return Buffer.concat(parts);
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

// Varint fields come back from _decodeFields already as numbers; anything else
// (a missing field, or bytes where a number was expected) counts as zero.
function _num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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

    // Field 2: senderKeyDistributionMessage — used to set up sender keys.
    // In WhatsApp Multi-Device, SKDM is bundled WITH the first real message in a new
    // session (even for 1-on-1 DMs). We extract it and continue decoding the real message.
    //
    // This read field 35, which is messageContextInfo. Two things followed: a real
    // distribution from another member (always at field 2) was never seen, so their
    // group messages stayed undecryptable; and the messageContextInfo that ordinary
    // messages carry was fed to processSKDM as if it were a distribution, which
    // writes junk states into the sender-key record.
    let skdmInfo = null;
    if (f[2]) {
      const skdm = _decodeFields(f[2]);
      // field 1 = groupId (string), field 2 = axolotlSenderKeyDistributionMessage (bytes)
      skdmInfo = {
        groupId: _str(skdm[1]),
        axolotlBytes: skdm[2] || null   // raw libsignal SKDM bytes starting with 0x33
      };
    }

    // Field 35: messageContextInfo — carries the message secret a poll's votes
    // are encrypted against. Attached to whatever message is decoded below.
    let messageSecret = null;
    if (f[35] && Buffer.isBuffer(f[35])) {
      try {
        const mci = _decodeFields(f[35]);
        if (mci[3] && Buffer.isBuffer(mci[3])) messageSecret = mci[3];
      } catch (_) {}
    }

    // Decode the actual message payload (independent of SKDM).
    // We use a helper so we can attach skdmInfo to every result.
    let msgResult = null;

    // Field 1: conversation — plain text
    if (!msgResult && f[1] && Buffer.isBuffer(f[1])) {
      const text = _str(f[1]);
      if (text) msgResult = { type: 'text', text };
    }

    // Field 6: extendedTextMessage — field 1 = text
    if (!msgResult && f[6] && Buffer.isBuffer(f[6])) {
      try {
        const ext = _decodeFields(f[6]);
        const text = _str(ext[1]);
        if (text) msgResult = { type: 'text', text };
      } catch (_) {}
    }

    // Field 3: imageMessage
    // url=1 mimetype=2 caption=3 fileSha256=4 fileLength=5 height=6 width=7
    // mediaKey=8 fileEncSha256=9 directPath=11 jpegThumbnail=16
    //
    // Only a handful of these used to be kept. forwardDecodedMessage reads
    // fileSha256, fileEncSha256, fileLength and the dimensions off this object,
    // so a forwarded photo went out with them undefined — unverifiable for the
    // recipient — and downloadMedia had no fileEncSha256 to check against.
    if (!msgResult && f[3] && Buffer.isBuffer(f[3])) {
      try {
        const img = _decodeFields(f[3]);
        msgResult = {
          type: 'image',
          caption: _str(img[3]),
          url: _str(img[1]),
          mimetype: _str(img[2]) || 'image/jpeg',
          fileSha256: img[4] || null,
          fileLength: _num(img[5]),
          height: _num(img[6]),
          width: _num(img[7]),
          mediaKey: img[8] || null,
          fileEncSha256: img[9] || null,
          directPath: _str(img[11]),
          jpegThumbnail: img[16] || null,
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

    // Field 28: groupInviteMessage — groupJid=1, inviteCode=2, inviteExpiration=3,
    // groupName=4, jpegThumbnail=5, caption=6, groupType=8
    //
    // Everything acceptGroupInviteMessage() needs is in here, so an invite that
    // arrives can be acted on without the caller re-parsing the payload.
    if (!msgResult && f[28] && Buffer.isBuffer(f[28])) {
      try {
        const inv = _decodeFields(f[28]);
        msgResult = {
          type:             'groupInvite',
          groupJid:         _str(inv[1]),
          inviteCode:       _str(inv[2]),
          inviteExpiration: _num(inv[3]),
          groupName:        _str(inv[4]),
          jpegThumbnail:    inv[5] || null,
          caption:          _str(inv[6]),
          isCommunity:      _num(inv[8]) === 1
        };
      } catch (_) { msgResult = { type: 'groupInvite', groupJid: '', inviteCode: '' }; }
    }

    // Field 7: documentMessage
    if (!msgResult && f[7] && Buffer.isBuffer(f[7])) {
      try {
        // url=1 mimetype=2 title=3 fileSha256=4 fileLength=5 mediaKey=7
        // fileName=8 fileEncSha256=9 directPath=10 jpegThumbnail=16
        const doc = _decodeFields(f[7]);
        msgResult = {
          type: 'document',
          fileName: _str(doc[8]) || _str(doc[3]) || 'document',
          title: _str(doc[3]),
          url: _str(doc[1]),
          mimetype: _str(doc[2]) || 'application/octet-stream',
          fileSha256: doc[4] || null,
          fileLength: _num(doc[5]),
          mediaKey: doc[7] || null,
          fileEncSha256: doc[9] || null,
          directPath: _str(doc[10]),
          jpegThumbnail: doc[16] || null,
        };
      } catch (_) { msgResult = { type: 'document', fileName: 'document' }; }
    }

    // Field 8: audioMessage
    if (!msgResult && f[8] && Buffer.isBuffer(f[8])) {
      try {
        // url=1 mimetype=2 fileSha256=3 fileLength=4 seconds=5 ptt=6
        // mediaKey=7 fileEncSha256=8 directPath=9
        const aud = _decodeFields(f[8]);
        msgResult = {
          type: aud[6] ? 'voice' : 'audio',
          url: _str(aud[1]),
          mimetype: _str(aud[2]) || 'audio/ogg; codecs=opus',
          fileSha256: aud[3] || null,
          fileLength: _num(aud[4]),
          seconds: _num(aud[5]),
          ptt: !!aud[6],
          mediaKey: aud[7] || null,
          fileEncSha256: aud[8] || null,
          directPath: _str(aud[9]),
        };
      } catch (_) { msgResult = { type: 'audio' }; }
    }

    // Field 9: videoMessage
    if (!msgResult && f[9] && Buffer.isBuffer(f[9])) {
      try {
        // url=1 mimetype=2 fileSha256=3 fileLength=4 seconds=5 mediaKey=6
        // caption=7 gifPlayback=8 height=9 width=10 fileEncSha256=11
        // directPath=13 jpegThumbnail=16
        const vid = _decodeFields(f[9]);
        msgResult = {
          type: 'video',
          caption: _str(vid[7]),
          url: _str(vid[1]),
          mimetype: _str(vid[2]) || 'video/mp4',
          fileSha256: vid[3] || null,
          fileLength: _num(vid[4]),
          seconds: _num(vid[5]),
          mediaKey: vid[6] || null,
          gifPlayback: !!vid[8],
          height: _num(vid[9]),
          width: _num(vid[10]),
          fileEncSha256: vid[11] || null,
          directPath: _str(vid[13]),
          jpegThumbnail: vid[16] || null,
        };
      } catch (_) { msgResult = { type: 'video', caption: '' }; }
    }

    // Field 12: protocolMessage
    if (!msgResult && f[12] && Buffer.isBuffer(f[12])) {
      try {
        const pm = _decodeFields(f[12]);
        const pmType = pm[2];
        const typeNames = {
          0:  'revoke',
          3:  'ephemeral',
          5:  'app_state_sync_key_share',
          6:  'history_sync',
          10: 'app_state_sync'
        };
        const subtype = typeNames[pmType] || String(pmType);
        msgResult = { type: 'protocol', subtype };

        // ── HISTORY_SYNC_NOTIFICATION (pmType=6) ─────────────────────────────
        // ProtocolMessage field 6 holds the HistorySyncNotification bytes.
        if (pmType === 6 && pm[6] && Buffer.isBuffer(pm[6])) {
          try {
            const { decodeHistorySyncNotification } = require('../HistorySyncHandler');
            msgResult.historySyncNotification = decodeHistorySyncNotification(pm[6]);
          } catch (_hse) {}
        }

        // ── APP_STATE_SYNC_KEY_SHARE (pmType=5) ──────────────────────────────
        // ProtocolMessage field 7 holds the AppStateSyncKeyShare bytes.
        if (pmType === 5 && pm[7] && Buffer.isBuffer(pm[7])) {
          try {
            const { decodeAppStateSyncKeyShare } = require('../HistorySyncHandler');
            msgResult.appStateSyncKeyShare = decodeAppStateSyncKeyShare(pm[7]);
          } catch (_ase) {}
        }

      } catch (_) { msgResult = { type: 'protocol', subtype: 'unknown' }; }
    }

    // Field 26: stickerMessage
    if (!msgResult && f[26] && Buffer.isBuffer(f[26])) {
      try {
        // url=1 fileSha256=2 fileEncSha256=3 mediaKey=4 mimetype=5 height=6
        // width=7 directPath=8 fileLength=9 isAnimated=13
        const stk = _decodeFields(f[26]);
        msgResult = {
          type: 'sticker',
          url: _str(stk[1]),
          fileSha256: stk[2] || null,
          fileEncSha256: stk[3] || null,
          mediaKey: stk[4] || null,
          mimetype: _str(stk[5]) || 'image/webp',
          height: _num(stk[6]),
          width: _num(stk[7]),
          directPath: _str(stk[8]),
          fileLength: _num(stk[9]),
          isAnimated: !!stk[13],
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

    // Field 49: pollCreationMessage
    // encKey=1, name=2 (question), options=3 (repeated PollOption{name=1}), selectableOptionsCount=4
    if (!msgResult && f[49] && Buffer.isBuffer(f[49])) {
      try {
        const poll = _decodeFields(f[49]);
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
        // Real clients leave encKey unset — the secret lives in
        // messageContextInfo, picked up above and attached below.
        if (!msgResult.encKey && messageSecret) msgResult.encKey = messageSecret;
      } catch (_) { msgResult = { type: 'poll', question: '', options: [] }; }
    }

    // Field 50: pollUpdateMessage (a vote on an existing poll)
    if (!msgResult && f[50] && Buffer.isBuffer(f[50])) {
      msgResult = { type: 'pollVote' };
    }

    // If we found a real message, attach skdmInfo / messageSecret and return
    if (msgResult) {
      if (messageSecret) msgResult = Object.assign({}, msgResult, { messageSecret });
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

// ─── SenderKeyDistributionMessage (field 2 of Message) ───────────────────────
// SenderKeyDistributionMessage { groupId=1, axolotlSenderKeyDistributionMessage=2 }
//
// This was written to field 35, which in Message is messageContextInfo — an
// entirely different type. Every group SenderKey we distributed was therefore
// labelled as context metadata, so no recipient ever saw a distribution, no
// recipient could open the sender-key session, and every skmsg we sent showed up
// as "Waiting for this message" on their side. It is field 2 in WAProto.
function encodeSenderKeyDistributionMessage(groupId, axolotlBytes) {
  const inner = Buffer.concat([
    field(1, WIRE_LEN, str(groupId)),
    field(2, WIRE_LEN, bytes(axolotlBytes))
  ]);
  return field(2, WIRE_LEN, inner);
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
  encodeGroupInviteMessage,
  encodeMessageKey,
  encodeMessage,
  encodeDeviceSentMessage,
  encodeProtocolMessage,
  encodeExtendedText,
  encodeContextInfo,
  encodeSenderKeyDistributionMessage,
  encodeMessageContextInfo,
  encodeVarint,
  field,
  varint,
  str,
  bytes,
  WIRE_VARINT,
  WIRE_LEN,
  PROTOCOL_MSG_REVOKE,
  PROTOCOL_MSG_EPHEMERAL,
  GROUP_INVITE_TYPE_DEFAULT,
  GROUP_INVITE_TYPE_PARENT,
  decodeMessageContainer
};
