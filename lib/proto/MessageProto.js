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
// encKey has to stay unset; the secret belongs in
// Message.messageContextInfo.messageSecret, which is the copy a voter derives
// their vote key from. In the wrong place it reached nobody, so the poll could
// not be voted on.
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
//
// The envelope is not the whole outer Message. Whatever messageContextInfo the
// message carries is copied up beside the envelope as well, because that is
// where a recipient reads it from: it is a field of Message, and once the
// message is buried inside a DeviceSentMessage the copy inside it is a level
// too deep for anything that does not know to go looking. A poll echoed to our
// own devices reached them without a message secret, so none of them could ever
// decrypt a vote on it. whatsmeow (`MessageContextInfo: message.MessageContextInfo`
// in marshalMessage) and Baileys both duplicate it for the same reason.
//
// phash is left unset, as it is by every other implementation: it describes the
// participant list, the server checks that against the hash on the stanza, and
// no client has ever read it back out of here.
function encodeDeviceSentMessage(destinationJid, messageBuf) {
  const inner = Buffer.concat([
    field(1, WIRE_LEN, str(destinationJid)),
    field(2, WIRE_LEN, messageBuf)
  ]);

  let contextInfo = Buffer.alloc(0);
  try {
    const mci = _decodeFields(messageBuf)[35];
    if (Buffer.isBuffer(mci) && mci.length) contextInfo = field(35, WIRE_LEN, mci);
  } catch (_) { /* nothing to lift */ }

  return Buffer.concat([field(31, WIRE_LEN, inner), contextInfo]);
}

// ─── ProtocolMessage (field 12 of Message) ───────────────────────────────────
// ProtocolMessage { key=1, type=2, ephemeralExpiration=4,
//                   appStateSyncKeyShare=6, appStateSyncKeyRequest=8, ... }
// Type enum: REVOKE=0, EPHEMERAL_SETTING=3, APP_STATE_SYNC_KEY_REQUEST=7
const PROTOCOL_MSG_REVOKE    = 0;
const PROTOCOL_MSG_EPHEMERAL = 3;

/** ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST */
const PROTOCOL_TYPE_APP_STATE_SYNC_KEY_REQUEST = 7;

function encodeProtocolMessage(opts) {
  // opts: { type, key: { remoteJid, fromMe, id }, ephemeralExpiration,
  //         appStateSyncKeyRequest, peerDataOperationRequestMessage }
  const parts = [];
  if (opts.key) parts.push(field(1, WIRE_LEN, encodeMessageKey(opts.key)));
  if (opts.type !== undefined) parts.push(field(2, WIRE_VARINT, varint(opts.type)));
  if (opts.ephemeralExpiration !== undefined) parts.push(field(4, WIRE_VARINT, varint(opts.ephemeralExpiration)));
  if (opts.appStateSyncKeyRequest) {
    parts.push(field(8, WIRE_LEN, opts.appStateSyncKeyRequest));
  }
  // Field 16, and the Type enum value that goes with it is also 16 — a
  // coincidence in the schema, not a mistake here.
  if (opts.peerDataOperationRequestMessage) {
    parts.push(field(16, WIRE_LEN, opts.peerDataOperationRequestMessage));
  }
  return Buffer.concat(parts);
}

// ─── AppStateSyncKeyRequest ──────────────────────────────────────────────────
//
// Asking the primary device for an app-state key it never shared. Mutations are
// encrypted under a key the phone hands out over an encrypted message; if that
// message was missed, every patch signed with that key is unreadable and stays
// unreadable — nothing later in the collection can be decoded either. The only
// way out is to ask, which is what this carries.
//
//   AppStateSyncKeyRequest { keyIds = 1 (repeated) }
//   AppStateSyncKeyId      { keyId  = 1 }
function encodeAppStateSyncKeyRequest(keyIds) {
  return Buffer.concat((keyIds || []).map(
    id => field(1, WIRE_LEN, field(1, WIRE_LEN, bytes(id)))));
}

// ─── PeerDataOperationRequestMessage ─────────────────────────────────────────
//
// The channel a companion asks its own phone for something over. It travels as
// a ProtocolMessage addressed to yourself, with the stanza marked
// category="peer" so the server routes it to your other devices rather than
// treating it as a chat message.
//
//   PeerDataOperationRequestMessage {
//     peerDataOperationRequestType     = 1   (enum)
//     historySyncOnDemandRequest       = 4
//     placeholderMessageResendRequest  = 5   (repeated)
//   }
//   PlaceholderMessageResendRequest { messageKey = 1 }
//   HistorySyncOnDemandRequest {
//     chatJid = 1, oldestMsgId = 2, oldestMsgFromMe = 3,
//     onDemandMsgCount = 4, oldestMsgTimestampMs = 5
//   }
//
// Field numbers are the schema's, unchanged.

const PeerDataOperationRequestType = {
  UPLOAD_STICKER:                 0,
  SEND_RECENT_STICKER_BOOTSTRAP:  1,
  GENERATE_LINK_PREVIEW:          2,
  HISTORY_SYNC_ON_DEMAND:         3,
  PLACEHOLDER_MESSAGE_RESEND:     4,
  WAFFLE_LINKING_NONCE_FETCH:     5,
  FULL_HISTORY_SYNC_ON_DEMAND:    6,
  COMPANION_META_NONCE_FETCH:     7
};

/** ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE */
const PROTOCOL_TYPE_PEER_DATA_OPERATION_REQUEST = 16;

function encodePeerDataOperationRequestMessage(opts) {
  const parts = [];

  if (opts.peerDataOperationRequestType !== undefined) {
    parts.push(field(1, WIRE_VARINT, varint(opts.peerDataOperationRequestType)));
  }

  if (opts.historySyncOnDemandRequest) {
    const h = opts.historySyncOnDemandRequest;
    const inner = [];
    if (h.chatJid)              inner.push(field(1, WIRE_LEN,    str(h.chatJid)));
    if (h.oldestMsgId)          inner.push(field(2, WIRE_LEN,    str(h.oldestMsgId)));
    if (h.oldestMsgFromMe !== undefined) inner.push(field(3, WIRE_VARINT, bool(h.oldestMsgFromMe)));
    if (h.onDemandMsgCount)     inner.push(field(4, WIRE_VARINT, varint(h.onDemandMsgCount)));
    if (h.oldestMsgTimestampMs) inner.push(field(5, WIRE_VARINT, varint(h.oldestMsgTimestampMs)));
    parts.push(field(4, WIRE_LEN, Buffer.concat(inner)));
  }

  // Repeated: one entry per message being asked for.
  for (const req of opts.placeholderMessageResendRequest || []) {
    if (!req || !req.messageKey) continue;
    parts.push(field(5, WIRE_LEN,
      field(1, WIRE_LEN, encodeMessageKey(req.messageKey))));
  }

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

// ─── Envelopes ───────────────────────────────────────────────────────────────
//
// Several entries in Message carry no content of their own. They hold another
// Message and exist only to say something about it: that a photo may be opened
// once, that a message belongs to a disappearing chat, that a document was sent
// with a caption. The inner message is an ordinary ImageMessage or
// DocumentMessage — nothing about it changes.
//
// A decoder that does not open the envelope sees a field it has no branch for
// and calls the whole thing unknown. That is why view-once and disappearing
// media could not be downloaded at all: the mediaKey never reached the caller,
// and downloadMedia had no message to work from.
//
// Every one of these but DeviceSentMessage is a FutureProofMessage — one shape,
// { message = 1 }, under several names.
//
//   field  inner  what it is
//     31     2    DeviceSentMessage { destinationJid=1, message=2, phash=3 }
//     37     1    viewOnceMessage
//     55     1    viewOnceMessageV2
//     59     1    viewOnceMessageV2Extension
//     40     1    ephemeralMessage
//     53     1    documentWithCaptionMessage
//     58     1    editedMessage
//
// All three view-once fields are read, not just the current one: V2 is what
// today's clients produce for a photo or a video and the extension what they
// produce for a voice note, but the original 37 is still what older senders and
// history sync deliver.
const MESSAGE_WRAPPERS = [
  { field: 31, inner: 2, flag: null },
  { field: 37, inner: 1, flag: 'viewOnce' },
  { field: 55, inner: 1, flag: 'viewOnce' },
  { field: 59, inner: 1, flag: 'viewOnce' },
  { field: 40, inner: 1, flag: 'ephemeral' },
  { field: 53, inner: 1, flag: null },
  { field: 58, inner: 1, flag: 'edited' }
];

// Real messages nest two or three deep at the most — a view-once photo inside a
// disappearing chat, echoed to our own devices. Each level is a length-
// delimited field of the one above it, so the buffer strictly shrinks and this
// cannot run away; the bound is only here so a malformed payload cannot recurse
// deep enough to exhaust the stack.
const MAX_WRAPPER_DEPTH = 8;

// The Message inside an envelope, or null when the field is absent, is not an
// envelope after all, or holds nothing.
function _unwrap(envelope, innerField) {
  if (!envelope || !Buffer.isBuffer(envelope)) return null;
  try {
    const inner = _decodeFields(envelope)[innerField];
    return (Buffer.isBuffer(inner) && inner.length) ? inner : null;
  } catch (_) { return null; }
}

// ─── ContextInfo, on the way in ──────────────────────────────────────────────
//
// Every message that can be a reply carries one, always at field 17 of its own
// content field — and field 7 for a group invite, which numbers its own fields.
// It is what says the message quotes another, and what the quoted message was:
//
//   ContextInfo { stanzaId=1, participant=2, quotedMessage=3, remoteJid=4,
//                 mentionedJid=15 }
//
// Without it a reply is indistinguishable from a message sent on its own, so
// anything that acts on what was quoted — re-sending a view-once, turning a
// photo into a sticker — has nothing to act on.
const CONTEXT_BEARING_FIELDS = [
  [6, 17],   // extendedTextMessage
  [3, 17],   // imageMessage
  [4, 17],   // contactMessage
  [5, 17],   // locationMessage
  [7, 17],   // documentMessage
  [8, 17],   // audioMessage
  [9, 17],   // videoMessage
  [26, 17],  // stickerMessage
  [49, 17],  // pollCreationMessage
  [28, 7]    // groupInviteMessage — its contextInfo is field 7
];

function decodeContextInfo(buf, depth) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const c   = _decodeFields(buf);
    const out = {};

    const stanzaId = _str(c[1]);
    if (stanzaId) out.stanzaId = stanzaId;
    const participant = _str(c[2]);
    if (participant) out.participant = participant;
    const remoteJid = _str(c[4]);
    if (remoteJid) out.remoteJid = remoteJid;

    // Mentions are a repeated string, so one mention decodes to a bare value
    // rather than to a list of one.
    if (c[15] != null) {
      const raw = Array.isArray(c[15]) ? c[15] : [c[15]];
      const jids = raw.map(_str).filter(Boolean);
      if (jids.length) out.mentionedJid = jids;
    }

    // The quoted message is a Message of its own, decoded the same way as any
    // other. The depth bound is shared with the envelope unwrapping so a chain
    // of replies quoting replies cannot recurse without end.
    if (Buffer.isBuffer(c[3]) && c[3].length && (depth || 0) < MAX_WRAPPER_DEPTH) {
      out.quotedMessageRaw = c[3];
      const quoted = decodeMessageContainer(c[3], (depth || 0) + 1);
      if (quoted && quoted.type !== 'unknown') out.quotedMessage = quoted;
    }

    return Object.keys(out).length ? out : null;
  } catch (_) { return null; }
}

// Whichever content field the message turned out to be, its contextInfo.
function _contextInfoOf(f, depth) {
  for (const [contentField, ctxField] of CONTEXT_BEARING_FIELDS) {
    const content = f[contentField];
    if (!Buffer.isBuffer(content)) continue;
    try {
      const inner = _decodeFields(content)[ctxField];
      if (!Buffer.isBuffer(inner) || !inner.length) continue;
      const ctx = decodeContextInfo(inner, depth);
      if (ctx) return ctx;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

function decodeMessageContainer(buf, depth) {
  if (!buf || buf.length === 0) return { type: 'unknown' };
  try {
    const f = _decodeFields(buf);
    const level = depth || 0;

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
    // What the envelopes said about it, raised on the result below.
    let envelopeFlags = null;

    // An envelope is opened before anything else is looked at: whatever is
    // inside it is the message, and the fields beside it here are the
    // envelope's own. A distribution or a message secret riding on this level
    // still belongs to what comes out, which is why both are read first and
    // carried onto the result — unwrapping used to return straight out of here
    // and lose them.
    // What a DeviceSentMessage envelope said about itself, kept for the caller.
    let deviceSentMeta = null;

    if (level < MAX_WRAPPER_DEPTH) {
      for (const w of MESSAGE_WRAPPERS) {
        const inner = _unwrap(f[w.field], w.inner);
        if (!inner) continue;
        const decoded = decodeMessageContainer(inner, level + 1);
        // Nothing this decoder knows was in there. Leave msgResult unset so the
        // branches below still get their turn, rather than reporting an empty
        // envelope as the whole message.
        if (!decoded || decoded.type === 'unknown') continue;
        msgResult = decoded;
        if (w.flag) envelopeFlags = Object.assign({}, envelopeFlags, { [w.flag]: true });
        // A DeviceSentMessage is a message this account sent from one of its
        // other devices, echoed back to us. The stanza's `from` is therefore our
        // own JID and names nothing: the conversation it belongs to is only ever
        // written here, in the envelope. It was being opened and thrown away, so
        // a message sent from the phone arrived with no way to tell which chat
        // it was in. whatsmeow keeps the same two fields as Info.DeviceSentMeta.
        if (w.field === 31) {
          try {
            const env  = _decodeFields(f[31]);
            const dest = _str(env[1]);
            const ph   = _str(env[3]);
            if (dest || ph) {
              deviceSentMeta = {};
              if (dest) deviceSentMeta.destinationJid = dest;
              if (ph)   deviceSentMeta.phash          = ph;
            }
          } catch (_) { /* the envelope named nothing */ }
        }
        break;
      }
    }

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
        // ProtocolMessage.Type. These are not the field numbers the payloads
        // live in and the two must not be confused: HISTORY_SYNC_NOTIFICATION
        // is type 5 carried in field 6, APP_STATE_SYNC_KEY_SHARE is type 6
        // carried in field 7. Having those two the wrong way round meant a key
        // share was read as a history notification, looked in the field it does
        // not use, found nothing, and was dropped — so app state could never be
        // decrypted at all.
        const typeNames = {
          0:  'revoke',
          3:  'ephemeral',
          4:  'ephemeral_sync_response',
          5:  'history_sync',
          6:  'app_state_sync_key_share',
          7:  'app_state_sync_key_request',
          9:  'initial_security_notification_setting_sync',
          10: 'app_state_fatal_exception',
          11: 'share_phone_number',
          14: 'message_edit'
        };
        const subtype = typeNames[pmType] || String(pmType);
        msgResult = { type: 'protocol', subtype };

        // The payloads are read by the field they occupy rather than by the
        // type that announced them, so a type number this list does not know
        // about still delivers what it carried.
        if (pm[6] && Buffer.isBuffer(pm[6])) {
          try {
            const { decodeHistorySyncNotification } = require('../HistorySyncHandler');
            msgResult.historySyncNotification = decodeHistorySyncNotification(pm[6]);
          } catch (_hse) {}
        }
        if (pm[7] && Buffer.isBuffer(pm[7])) {
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

    // If we found a real message, attach skdmInfo / messageSecret and return.
    //
    // Anything the inner message already carries stays as it is: a nested
    // envelope has set its own flags and read its own secret on the way up, and
    // this level only fills in what is still missing.
    if (msgResult) {
      if (envelopeFlags) msgResult = Object.assign({}, msgResult, envelopeFlags);
      if (deviceSentMeta && !msgResult.deviceSentMeta) {
        msgResult = Object.assign({}, msgResult, { deviceSentMeta });
      }
      if (messageSecret && !msgResult.messageSecret) {
        msgResult = Object.assign({}, msgResult, { messageSecret });
      }
      // A poll inside an envelope keeps its messageContextInfo out here, beside
      // the envelope rather than beside the poll. Its votes cannot be decrypted
      // without that secret, so it is taken from whichever level carried it.
      if (msgResult.type === 'poll' && !msgResult.encKey && messageSecret) {
        msgResult = Object.assign({}, msgResult, { encKey: messageSecret });
      }
      if (skdmInfo && !msgResult.skdm) msgResult = Object.assign({}, msgResult, { skdm: skdmInfo });
      // What this message was a reply to, if anything. Read at the level that
      // actually carried the content, so an envelope does not overwrite the
      // context the message inside it already found.
      if (!msgResult.contextInfo) {
        const ctx = _contextInfoOf(f, level);
        if (ctx) msgResult = Object.assign({}, msgResult, { contextInfo: ctx });
      }
      return msgResult;
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
  encodePeerDataOperationRequestMessage,
  PeerDataOperationRequestType,
  PROTOCOL_TYPE_PEER_DATA_OPERATION_REQUEST,
  PROTOCOL_TYPE_APP_STATE_SYNC_KEY_REQUEST,
  encodeAppStateSyncKeyRequest,
  encodeExtendedText,
  encodeContextInfo,
  encodeSenderKeyDistributionMessage,
  encodeMessageContextInfo,
  encodeVarint,
  // The generic field walker, for the protobufs that live outside this file.
  decodeFields: _decodeFields,
  // Exported so a test can check the bound at its edge rather than guess where
  // the edge is: a test that hardcodes the number goes on passing after the
  // constant moves, which is the same as not testing it.
  MAX_WRAPPER_DEPTH,
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
  decodeMessageContainer,
  decodeContextInfo
};
