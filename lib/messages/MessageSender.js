'use strict';

const { dbg: _whaDbg } = require('../logger');

const crypto         = require('crypto');
const { Mutex }      = require('async-mutex');
const path     = require('path');
const fs       = require('fs');
const { BinaryNode }  = require('../BinaryNode');
const { DeviceManager, jidStrToObj } = require('../DeviceManager');
const {
  encodeMessage,
  encodeText, encodeImageMessage, encodeVideoMessage,
  encodeAudioMessage, encodeDocumentMessage,
  encodeStickerMessage, encodeReactionMessage,
  encodePollCreationMessage,
  encodeLocationMessage, encodeContactMessage,
  encodeGroupInviteMessage,
  GROUP_INVITE_TYPE_DEFAULT, GROUP_INVITE_TYPE_PARENT,
  encodeDeviceSentMessage, encodeProtocolMessage,
  encodeExtendedText,
  encodeSenderKeyDistributionMessage,
  encodeMessageContextInfo,
  PROTOCOL_MSG_REVOKE, PROTOCOL_MSG_EPHEMERAL
} = require('../proto/MessageProto');
const { uploadMedia } = require('../MediaService');
const { imageThumbnail, videoThumbnail, probeImageSize } = require('../MediaThumbnail');
const { tcTokenExpired, shouldSendNewTcToken, normalizeJidForTcToken,
        isRegularTcTokenUser } = require('./TcTokenStore');
const { buildReportingNode } = require('./ReportingToken');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateMessageId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function msNow() { return Math.floor(Date.now() / 1000); }

function isGroupJid(jid) {
  return jid.endsWith('@g.us') || jid.endsWith('@community');
}

// A Status/Story is posted as a message to status@broadcast, and it travels the
// SenderKey path a group message does — one skmsg plus a distribution to every
// recipient — not the 1:1 path. A Status and a group are the same case here.
const STATUS_BROADCAST_JID = 'status@broadcast';

function isStatusBroadcast(jid) {
  return String(jid) === STATUS_BROADCAST_JID;
}

function phoneFromJid(jid) {
  const at    = jid.indexOf('@');
  const user  = at >= 0 ? jid.slice(0, at) : jid;
  const colon = user.indexOf(':');
  return colon >= 0 ? user.slice(0, colon) : user;
}

// ─── ADVSignedDeviceIdentity ─────────────────────────────────────────────────
//
// Received from the server in the pair-success IQ when a companion device is
// linked. A primary device registered over SMS never gets one and must not
// invent one — see _buildOrGetAdvIdentity. The encoders below remain for
// working with a real identity when the server does supply it.
//
// ADVDeviceIdentityDetails (protobuf):
//   field 1 (rawId,      uint32): registration ID
//   field 2 (timestamp,  uint64): Unix epoch (seconds)
//   field 3 (keyIndex,   uint32): 0 for primary device
//   field 4 (accountType, enum ): 0 = E2EE
//   field 5 (deviceType,  enum ): 0 = E2EE
//
// ADVSignedDeviceIdentity (protobuf):
//   field 1 (details,             bytes): encoded ADVDeviceIdentityDetails
//   field 2 (accountSignatureKey, bytes): 32-byte identity pub key
//   field 3 (accountSignature,    bytes): XEdDSA sign([0x06,0x00]+details+pubKey)
//   field 4 (deviceSignature,     bytes): XEdDSA sign([0x06,0x01]+details+pubKey+pubKey)
//
// Signature prefix constants:
//   WA_ADV_ACCOUNT_SIG_PREFIX = [6, 0]
//   WA_ADV_DEVICE_SIG_PREFIX  = [6, 1]

const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0]);
const WA_ADV_DEVICE_SIG_PREFIX  = Buffer.from([6, 1]);

function _pbVarint(n) {
  const out = [];
  n = (typeof n === 'bigint') ? Number(n) : n;
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n & 0x7f);
  return Buffer.from(out);
}
function _pbField(fieldNum, wireType, data) {
  const tag = _pbVarint((fieldNum << 3) | wireType);
  if (wireType === 0) return Buffer.concat([tag, _pbVarint(data)]);
  const len = _pbVarint(data.length);
  return Buffer.concat([tag, len, data]);
}
function _encodeADVDetails(regId, ts, keyIndex) {
  return Buffer.concat([
    _pbField(1, 0, regId),
    _pbField(2, 0, ts),
    _pbField(3, 0, keyIndex),
    _pbField(4, 0, 0),
    _pbField(5, 0, 0)
  ]);
}
function _encodeADVSignedIdentity(details, sigKey, acctSig, devSig) {
  return Buffer.concat([
    _pbField(1, 2, details),
    _pbField(2, 2, sigKey),
    _pbField(3, 2, acctSig),
    _pbField(4, 2, devSig)
  ]);
}

let _curve25519js = null;
function _getCurve() {
  if (!_curve25519js) _curve25519js = require('curve25519-js');
  return _curve25519js;
}

// Build ADVSignedDeviceIdentity for our primary iOS device.
// Returns Buffer of encoded proto WITH accountSignatureKey included.
// Result is cached in store.advIdentity so we only build it once per registration.
function _buildOrGetAdvIdentity(store) {
  // Only ever return an identity the server actually issued.
  //
  // ADVSignedDeviceIdentity is minted during companion pairing: it proves a
  // linked device's identity key was authorised by the primary, and its
  // accountSignature is made with the primary's key. This client registers
  // over SMS as the primary, so no pairing IQ ever runs and there is nothing
  // to attach — which is what the comment above allowPkmsg already says
  // primaries do.
  //
  // This used to fabricate one by self-signing with our own identity key when
  // the store had none. That identity cannot validate: nothing authorised it.
  // Attaching it to every pkmsg is a plausible cause of the server rejecting
  // sends with ack 479 while still delivering messages to us, and it
  // contradicted the documented behaviour a few lines up. If a real
  // device-identity is ever received on <success> it is stored and used here;
  // otherwise the node is simply omitted.
  if (store && store.advIdentity && store.advIdentity.length > 0) {
    return store.advIdentity;
  }
  return null;
}

function makeJid(input, server) {
  server = server || 's.whatsapp.net';
  if (typeof input === 'string' && input.includes('@')) return input;
  const user = String(input).replace(/\D/g, '');
  return `${user}@${server}`;
}

function toSignalKey(raw) {
  if (!raw) return null;
  if (raw.length === 33 && raw[0] === 0x05) return Buffer.from(raw);
  if (raw.length === 32) return Buffer.concat([Buffer.from([0x05]), raw]);
  return Buffer.from(raw);
}

function intFromBuf(buf) {
  if (!buf) return 0;
  let v = 0;
  for (const b of buf) v = (v << 8) | b;
  return v;
}

function findChild(node, desc) {
  if (!node || !Array.isArray(node.content)) return null;
  return node.content.find(c => c && c.description === desc) || null;
}

function getContent(node) {
  if (!node) return null;
  if (Buffer.isBuffer(node.content)) return node.content;
  if (typeof node.content === 'string') return Buffer.from(node.content);
  return null;
}

// The "AD string" form of a JID — user.<agent>:<device>@server — which is what
// the participant hash is computed over. The agent byte is 0 for both
// s.whatsapp.net and lid users, so "40712345678.0:2@s.whatsapp.net" and
// "112713111982325.0:0@lid".
function adString(jid) {
  const str    = String(jid);
  const at     = str.indexOf('@');
  const raw    = at >= 0 ? str.slice(0, at) : str;
  const server = at >= 0 ? str.slice(at + 1) : 's.whatsapp.net';
  const colon  = raw.indexOf(':');
  const user   = colon >= 0 ? raw.slice(0, colon) : raw;
  const device = colon >= 0 ? (parseInt(raw.slice(colon + 1), 10) || 0) : 0;
  return `${user}.0:${device}@${server}`;
}

// Participant-list hash v2: sort the AD strings, sha256 the concatenation, then
// base64 the FIRST SIX BYTES of the digest — eight characters, prefixed "2:".
//
// This previously hashed plain JID strings and took the first six CHARACTERS of
// the base64 of the whole digest, which is a different, six-character value over
// different input. It goes on the wire, so every multi-device send carried a
// hash the server could not match against its own view of the participant
// list.
function computePhash(jids) {
  const sorted = [...new Set(jids.map(adString))].sort();
  const hash   = crypto.createHash('sha256').update(sorted.join('')).digest();
  return '2:' + hash.subarray(0, 6).toString('base64').replace(/=+$/, '');
}

// ─── MessageSender ────────────────────────────────────────────────────────────

class MessageSender {
  constructor(client) {
    this._client       = client;
    this._socket       = client._socket;
    this._store        = client._store;
    this._signal       = client._signal;
    this._devMgr       = client._devMgr;
    this._mediaHosts   = [];
    this._mediaAuth    = '';
    // Mutex that serialises Signal encryption across concurrent sends.
    // Signal session state is shared per-process; concurrent encrypt calls on
    // the same session can corrupt the ratchet chain and produce undecryptable
    // ciphertexts.  Holding the lock for the duration of the encrypt block
    // (not the full send) keeps serialisation cost minimal.
    this._encryptMutex = new Mutex();
  }

  // Called by Client when media connection is established
  setMediaConnection(hosts, auth, ttl, fetchDate) {
    this._mediaHosts     = hosts      || [];
    this._mediaAuth      = auth       || '';
    this._mediaConnTtl   = ttl        || 300;
    this._mediaConnFetch = fetchDate  || Date.now();
  }

  _isMediaConnExpired() {
    if (!this._mediaHosts.length || !this._mediaAuth) return true;
    const elapsed = (Date.now() - (this._mediaConnFetch || 0)) / 1000;
    return elapsed >= (this._mediaConnTtl || 300) - 10;
  }

  // ─── Text ──────────────────────────────────────────────────────────────────

  async sendText(to, text, options) {
    options = options || {};
    const msgId = options.id || generateMessageId();
    const toJid = makeJid(to);

    let ctxInfo = options.contextInfo || null;
    if (options.mentions && options.mentions.length > 0) {
      ctxInfo = Object.assign({}, ctxInfo || {}, { mentionedJid: options.mentions });
    }

    const content = encodeText(text, ctxInfo);
    const msgBuf  = encodeMessage('text', content);
    return this._sendMessage(toJid, msgId, msgBuf, 'text', options);
  }

  // ─── Image ────────────────────────────────────────────────────────────────

  async sendImage(to, imageData, options) {
    options = options || {};
    const msgId  = options.id || generateMessageId();
    const toJid  = makeJid(to);
    const cdn    = options._cdnForward;
    // The inline preview and the dimensions come from the same pass over the
    // source bytes. Without them WhatsApp has nothing to draw and shows the
    // grey download placeholder instead of the photo.
    let upload, meta = {};
    if (cdn) {
      upload = cdn;
    } else {
      const buf = this._toMediaBuffer(imageData);
      [upload, meta] = await Promise.all([
        this._uploadMedia('image', buf),
        imageThumbnail(buf).catch(() => ({}))
      ]);
    }
    const imgBuf = encodeMessage('image', encodeImageMessage({
      url:               upload.url,
      mimetype:          options.mimetype || upload.mimetype || guessMime(imageData, 'image/jpeg'),
      caption:           options.caption  || upload.caption || '',
      fileSha256:        upload.fileSha256,
      fileLength:        upload.fileLength || 0,
      height:            options.height   || upload.height || meta.height || 0,
      width:             options.width    || upload.width  || meta.width  || 0,
      mediaKey:          upload.mediaKey,
      fileEncSha256:     upload.fileEncSha256,
      directPath:        upload.directPath,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      jpegThumbnail:     options.thumbnail || upload.jpegThumbnail || meta.thumbnail || null,
      contextInfo:       options.contextInfo
    }));
    return this._sendMessage(toJid, msgId, imgBuf, 'media', { ...options, _mediaSubtype: 'image' });
  }

  // ─── Video ────────────────────────────────────────────────────────────────

  async sendVideo(to, videoData, options) {
    options = options || {};
    const msgId  = options.id || generateMessageId();
    const toJid  = makeJid(to);
    const cdn    = options._cdnForward;
    // Same as an image, except the preview frame has to be cut by ffmpeg. When
    // ffmpeg is not installed the video still sends — it just arrives without
    // an inline preview.
    let upload, meta = {};
    if (cdn) {
      upload = cdn;
    } else {
      const buf = this._toMediaBuffer(videoData);
      [upload, meta] = await Promise.all([
        this._uploadMedia('video', buf),
        // ffmpeg needs to seek, so hand it the path when we have one rather
        // than making it re-read a copy of the bytes.
        videoThumbnail(typeof videoData === 'string' ? videoData : buf).catch(() => ({}))
      ]);
    }
    const vidBuf = encodeMessage('video', encodeVideoMessage({
      url:               upload.url,
      mimetype:          options.mimetype || upload.mimetype || guessMime(videoData, 'video/mp4'),
      fileSha256:        upload.fileSha256,
      fileLength:        upload.fileLength || 0,
      seconds:           options.seconds   || upload.seconds || meta.seconds || 0,
      mediaKey:          upload.mediaKey,
      caption:           options.caption   || upload.caption || '',
      height:            options.height    || upload.height  || meta.height || 0,
      width:             options.width     || upload.width   || meta.width  || 0,
      fileEncSha256:     upload.fileEncSha256,
      directPath:        upload.directPath,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      jpegThumbnail:     options.thumbnail  || upload.jpegThumbnail || meta.thumbnail || null,
      gifPlayback:       options.gifPlayback || false,
      contextInfo:       options.contextInfo
    }));
    // A video with gifPlayback is labelled mediatype "gif", not "video".
    return this._sendMessage(toJid, msgId, vidBuf, 'media',
      { ...options, _mediaSubtype: options.gifPlayback ? 'gif' : 'video' });
  }

  // ─── Audio / PTT ──────────────────────────────────────────────────────────

  async sendAudio(to, audioData, options) {
    options = options || {};
    const msgId  = options.id || generateMessageId();
    const toJid  = makeJid(to);
    const isPtt  = !!options.ptt;
    const cdn    = options._cdnForward;
    const upload = cdn ? cdn : await this._uploadMedia(isPtt ? 'ptt' : 'audio', audioData);
    const audBuf = encodeMessage('audio', encodeAudioMessage({
      url:               upload.url,
      mimetype:          options.mimetype || upload.mimetype || (isPtt ? 'audio/ogg; codecs=opus' : 'audio/mp4'),
      fileSha256:        upload.fileSha256,
      fileLength:        upload.fileLength || 0,
      seconds:           options.seconds   || upload.seconds || 0,
      ptt:               isPtt,
      mediaKey:          upload.mediaKey,
      fileEncSha256:     upload.fileEncSha256,
      directPath:        upload.directPath,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      contextInfo:       options.contextInfo
    }));
    return this._sendMessage(toJid, msgId, audBuf, 'media', { ...options, _mediaSubtype: isPtt ? 'ptt' : 'audio' });
  }

  // ─── Document ─────────────────────────────────────────────────────────────

  async sendDocument(to, docData, options) {
    options = options || {};
    const msgId  = options.id || generateMessageId();
    const toJid  = makeJid(to);
    const cdn    = options._cdnForward;
    const upload = cdn ? cdn : await this._uploadMedia('document', docData);
    const docBuf = encodeMessage('document', encodeDocumentMessage({
      url:               upload.url,
      mimetype:          options.mimetype  || upload.mimetype || 'application/octet-stream',
      title:             options.title     || upload.title    || options.fileName || upload.fileName || 'document',
      fileSha256:        upload.fileSha256,
      fileLength:        upload.fileLength || 0,
      mediaKey:          upload.mediaKey,
      fileName:          options.fileName  || upload.fileName || 'document',
      fileEncSha256:     upload.fileEncSha256,
      directPath:        upload.directPath,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      jpegThumbnail:     options.thumbnail || upload.jpegThumbnail || null,
      contextInfo:       options.contextInfo
    }));
    return this._sendMessage(toJid, msgId, docBuf, 'media', { ...options, _mediaSubtype: 'document' });
  }

  // ─── Sticker ──────────────────────────────────────────────────────────────

  async sendSticker(to, stickerData, options) {
    options = options || {};
    const msgId  = options.id || generateMessageId();
    const toJid  = makeJid(to);
    const cdn    = options._cdnForward;
    const upload = cdn ? cdn : await this._uploadMedia('sticker', stickerData);
    // A sticker that is not actually 512x512 was being described as if it were,
    // which stretches it in the bubble. The WebP header says what it really is.
    let stkSize = null;
    if (!cdn && (!options.width || !options.height)) {
      try { stkSize = probeImageSize(this._toMediaBuffer(stickerData)); } catch (_) {}
    }
    const stkBuf = encodeMessage('sticker', encodeStickerMessage({
      url:               upload.url,
      fileSha256:        upload.fileSha256,
      fileEncSha256:     upload.fileEncSha256,
      mediaKey:          upload.mediaKey,
      mimetype:          options.mimetype  || upload.mimetype || 'image/webp',
      height:            options.height    || upload.height   || (stkSize && stkSize.height) || 512,
      width:             options.width     || upload.width    || (stkSize && stkSize.width)  || 512,
      directPath:        upload.directPath,
      fileLength:        upload.fileLength || 0,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      isAnimated:        options.isAnimated || false,
      contextInfo:       options.contextInfo
    }));
    return this._sendMessage(toJid, msgId, stkBuf, 'media', { ...options, _mediaSubtype: 'sticker' });
  }

  // ─── Reaction ─────────────────────────────────────────────────────────────

  async sendReaction(to, messageId, emoji, options) {
    options = options || {};
    const msgId = options.id || generateMessageId();
    const toJid = makeJid(to);
    const rxBuf = encodeMessage('reaction', encodeReactionMessage({
      key:               { remoteJid: toJid, fromMe: options.fromMe || false, id: messageId },
      text:              emoji,
      senderTimestampMs: Date.now()
    }));
    return this._sendMessage(toJid, msgId, rxBuf, 'reaction', options);
  }

  // ─── Poll ─────────────────────────────────────────────────────────────────
  //
  // Sends a PollCreationMessage (WhatsApp field 85).  Recipients can vote
  // on it; the votes are encrypted with the encKey returned here.
  //
  // opts.selectableOptionsCount  how many options a voter may choose (0 = any)
  // opts.encKey                  optional pre-seeded 32-byte Buffer

  async sendPoll(to, question, options, selectableCount, opts) {
    opts = opts || {};
    const msgId  = opts.id || generateMessageId();
    const toJid  = makeJid(to);
    const result = encodePollCreationMessage({
      question,
      options: options || [],
      selectableOptionsCount: selectableCount != null ? selectableCount : 0,
      messageSecret: opts.messageSecret || opts.encKey || null
    });
    // The poll has to be paired with a messageContextInfo holding the secret.
    // It is a sibling field of the poll inside Message, not
    // part of the poll — a voter derives their vote key from this copy, so a
    // poll sent without it cannot be voted on.
    const pollBuf = Buffer.concat([
      encodeMessage('poll', result.payload),
      encodeMessageContextInfo({ messageSecret: result.messageSecret })
    ]);
    const sendResult = await this._sendMessage(toJid, msgId, pollBuf, 'poll',
      Object.assign({}, opts, { _encKey: result.messageSecret }));
    return Object.assign({}, sendResult, {
      encKey: result.messageSecret,
      messageSecret: result.messageSecret
    });
  }

  // ─── Location ─────────────────────────────────────────────────────────────
  // sendLocation(to, latitude, longitude, opts)
  // opts: { name, address, url, id, contextInfo }

  async sendLocation(to, latitude, longitude, opts) {
    opts = opts || {};
    const msgId  = opts.id || generateMessageId();
    const toJid  = makeJid(to);
    const locBuf = encodeMessage('location', encodeLocationMessage({
      latitude,
      longitude,
      name:    opts.name    || '',
      address: opts.address || '',
      url:     opts.url     || '',
      isLive:  opts.isLive  || false,
      accuracyInMeters: opts.accuracyInMeters,
      // A map image for the bubble. WhatsApp draws a blank grey card without
      // one, exactly as it does for a photo with no preview.
      jpegThumbnail: opts.thumbnail || opts.jpegThumbnail || null,
      contextInfo:   opts.contextInfo
    }));
    // A location is a plain message as far as the envelope is concerned.
    // The stanza types are text, media, reaction and poll — LocationMessage is
    // in none of the media cases, so it is text. Sending type="location" hands
    // the server a type it has no case for.
    return this._sendMessage(toJid, msgId, locBuf, 'text', opts);
  }

  // ─── Quoted Reply ─────────────────────────────────────────────────────────
  // sendReply(to, quotedMsgId, senderJid, text, opts)
  // quotedMsgId — ID of the message being quoted
  // senderJid   — JID of who sent the quoted message (= to for DMs, member JID for groups)

  async sendReply(to, quotedMsgId, senderJid, text, opts) {
    opts = opts || {};
    const contextInfo = {
      quotedMessageId: quotedMsgId,
      participant:     senderJid || to,
      remoteJid:       to,
    };
    return this.sendText(to, text, Object.assign({}, opts, { contextInfo }));
  }

  // ─── Contact (vCard) ──────────────────────────────────────────────────────
  // sendContact(to, displayName, vcard, opts)
  // vcard — full vCard v3 string

  async sendContact(to, displayName, vcard, opts) {
    opts = opts || {};
    const msgId  = opts.id || generateMessageId();
    const toJid  = makeJid(to);
    const conBuf = encodeMessage('contact', encodeContactMessage({
      displayName, vcard, contextInfo: opts.contextInfo
    }));
    // getMediaTypeFromMessage answers "vcard" for a ContactMessage, which makes
    // getTypeFromMessage answer "media" — so the envelope is a media stanza and
    // the enc nodes carry mediatype="vcard". type="contact" was not a type the
    // server has a case for.
    return this._sendMessage(toJid, msgId, conBuf, 'media',
      Object.assign({}, opts, { _mediaSubtype: 'vcard' }));
  }

  // ─── Group invite ─────────────────────────────────────────────────────────
  // sendGroupInvite(to, groupJid, inviteCode, inviteExpiration, opts)
  //
  // The bubble that carries a personal invitation into a group. It is what you
  // fall back to when adding somebody outright is refused because their privacy
  // settings do not allow it — the server hands back a code with that refusal
  // and this is what turns the code into something the person can tap.
  //
  // opts: { groupName, caption, jpegThumbnail, isCommunity, id, contextInfo }

  async sendGroupInvite(to, groupJid, inviteCode, inviteExpiration, opts) {
    opts = opts || {};
    const msgId  = opts.id || generateMessageId();
    const toJid  = makeJid(to);
    const invBuf = encodeMessage('groupInvite', encodeGroupInviteMessage({
      groupJid:         makeJid(groupJid),
      inviteCode,
      inviteExpiration: inviteExpiration || 0,
      groupName:        opts.groupName || '',
      caption:          opts.caption   || '',
      jpegThumbnail:    opts.jpegThumbnail || opts.thumbnail || null,
      groupType:        opts.isCommunity ? GROUP_INVITE_TYPE_PARENT
                                         : GROUP_INVITE_TYPE_DEFAULT,
      contextInfo:      opts.contextInfo
    }));
    // No media travels with it and it is not a reaction or a poll, so as far as
    // the envelope is concerned this is an ordinary message.
    return this._sendMessage(toJid, msgId, invBuf, 'text', opts);
  }

  // ─── Forward decoded message ───────────────────────────────────────────────
  //
  // Forwards a received message to a new recipient without re-uploading media.
  // The `msg` parameter must be a decoded message object (msg.decoded from a
  // received 'message' event), or an object with the same shape.
  //
  // Supported types: text, image, video, audio, voice, document, sticker
  // For unknown types the method falls back to a text message with type info.

  async forwardDecodedMessage(to, msg, opts) {
    opts = opts || {};
    const d    = (msg && msg.decoded) ? msg.decoded : msg;
    if (!d || !d.type) throw new Error('forwardDecodedMessage: msg.decoded is required');
    const ctx  = Object.assign({ forwardingScore: 1, isForwarded: true }, opts.contextInfo || {});
    const o    = Object.assign({}, opts, { contextInfo: ctx });
    switch (d.type) {
      case 'text':
        return this.sendText(to, d.text || '', o);

      case 'image':
        if (!d.url && !d.directPath) throw new Error('forwardDecodedMessage: image has no CDN data');
        return this.sendImage(to, null, Object.assign({}, o, {
          _cdnForward: {
            url: d.url, directPath: d.directPath, mediaKey: d.mediaKey,
            fileSha256: d.fileSha256, fileEncSha256: d.fileEncSha256,
            fileLength: d.fileLength || 0, height: d.height || 0, width: d.width || 0,
            mimetype: d.mimetype || 'image/jpeg', caption: d.caption || '',
            // Carry the sender's preview across: a forward re-uses their upload,
            // so there are no bytes here to build a new one from.
            jpegThumbnail: d.jpegThumbnail || null
          }
        }));

      case 'video':
        if (!d.url && !d.directPath) throw new Error('forwardDecodedMessage: video has no CDN data');
        return this.sendVideo(to, null, Object.assign({}, o, {
          _cdnForward: {
            url: d.url, directPath: d.directPath, mediaKey: d.mediaKey,
            fileSha256: d.fileSha256, fileEncSha256: d.fileEncSha256,
            fileLength: d.fileLength || 0, mimetype: d.mimetype || 'video/mp4',
            caption: d.caption || '', seconds: d.seconds || 0,
            height: d.height || 0, width: d.width || 0,
            jpegThumbnail: d.jpegThumbnail || null
          }
        }));

      case 'audio':
      case 'voice':
        if (!d.url && !d.directPath) throw new Error('forwardDecodedMessage: audio has no CDN data');
        return this.sendAudio(to, null, Object.assign({}, o, {
          ptt: d.type === 'voice',
          _cdnForward: {
            url: d.url, directPath: d.directPath, mediaKey: d.mediaKey,
            fileSha256: d.fileSha256, fileEncSha256: d.fileEncSha256,
            fileLength: d.fileLength || 0, mimetype: d.mimetype || 'audio/ogg; codecs=opus',
            seconds: d.seconds || 0
          }
        }));

      case 'document':
        if (!d.url && !d.directPath) throw new Error('forwardDecodedMessage: document has no CDN data');
        return this.sendDocument(to, null, Object.assign({}, o, {
          fileName: d.fileName || 'file',
          _cdnForward: {
            url: d.url, directPath: d.directPath, mediaKey: d.mediaKey,
            fileSha256: d.fileSha256, fileEncSha256: d.fileEncSha256,
            fileLength: d.fileLength || 0, mimetype: d.mimetype || 'application/octet-stream',
            title: d.title || d.fileName || 'file', fileName: d.fileName || 'file',
            jpegThumbnail: d.jpegThumbnail || null
          }
        }));

      case 'sticker':
        if (!d.url && !d.directPath) throw new Error('forwardDecodedMessage: sticker has no CDN data');
        return this.sendSticker(to, null, Object.assign({}, o, {
          _cdnForward: {
            url: d.url, directPath: d.directPath, mediaKey: d.mediaKey,
            fileSha256: d.fileSha256, fileEncSha256: d.fileEncSha256,
            fileLength: d.fileLength || 0, mimetype: d.mimetype || 'image/webp',
            height: d.height || 512, width: d.width || 512
          }
        }));

      default:
        return this.sendText(to, '[forwarded ' + d.type + ' message]', o);
    }
  }

  // ─── Core dispatch ────────────────────────────────────────────────────────

  async _sendMessage(toJid, msgId, plaintext, mediaType, options) {
    options = options || {};
    // status@broadcast is neither a group JID nor a user JID. It used to fall
    // through to the 1:1 path, which took "status" for a phone number, ran a
    // usync for it and tried to open a Signal session with status@s.whatsapp.net
    // — so a Status could not be posted at all.
    if (isGroupJid(toJid) || isStatusBroadcast(toJid)) {
      try {
        return await this._sendGroupMessage(toJid, msgId, plaintext, mediaType, options);
      } catch (err) {
        // Error 421 = phash mismatch — server's participant list differs from ours.
        // Refresh group metadata from server, flush device cache, retry once.
        if (err && /\b421\b/.test(err.message)) {
          if (typeof this._client.refreshGroupMembers === 'function') {
            try { await this._client.refreshGroupMembers(toJid); } catch (_) {}
          }
          const members = this._client._getGroupMembers
            ? this._client._getGroupMembers(toJid)
            : [];
          this._devMgr.clearCache(members.map(phoneFromJid));
          return this._sendGroupMessage(toJid, msgId, plaintext, mediaType, options);
        }
        // Error 479 = stale/dead Signal session — clear all sessions for every
        // group member, flush device cache, rebuild from fresh bundles, retry once.
        if (err && /\b479\b/.test(err.message) && !options._479retry) {
          _whaDbg('[DBG] 479_GROUP clearing sessions for group ' + toJid);
          const members = this._client._getGroupMembers
            ? this._client._getGroupMembers(toJid) : [];
          for (const memberJid of members) {
            await this._clearSignalSessionsForJid(memberJid).catch(() => {});
          }
          // The sessions the SenderKey distribution rode in on are gone, so the
          // record of who already holds our key is meaningless — every member
          // needs a fresh distribution on the retry. Without this the retry sent
          // a bare skmsg to devices that had just lost their session and drew the
          // same 479 straight back.
          if (this._signal && this._signal.senderKeyStore) {
            this._signal.senderKeyStore.invalidateSKDM(toJid);
          }
          // A new id for the same reason the DM path uses one: the server has
          // already acked the original, and re-using it makes it drop the
          // connection.
          return this._sendGroupMessage(toJid, generateMessageId(), plaintext, mediaType,
            Object.assign({}, options, { _479retry: true }));
        }
        // No session could be built for a single member — usually a prekey IQ
        // that timed out, leaving the device list cached with nothing behind
        // it. Purge the cached devices and sessions so the retry re-fetches
        // bundles and opens fresh pkmsg sessions instead of failing again.
        if (err && /NO_OPEN_SESSION/.test(err.message) && !options._noSessionRetry) {
          _whaDbg('[DBG] NO_OPEN_SESSION group ' + toJid + ' — forcing fresh pkmsg\n');
          await this._forceSessionRebuild(
            (this._client._getGroupMembers ? this._client._getGroupMembers(toJid) : [])
          );
          if (this._signal && this._signal.senderKeyStore) {
            this._signal.senderKeyStore.invalidateSKDM(toJid);
          }
          return this._sendGroupMessage(toJid, msgId, plaintext, mediaType,
            Object.assign({}, options, { _noSessionRetry: true }));
        }
        throw err;
      }
    }
    try {
      return await this._sendDMMessage(toJid, msgId, plaintext, mediaType, options);
    } catch (err) {
      // Same phash-mismatch retry for 1-to-1 messages. A LID recipient's device
      // list is cached under the "lid:" key, not the bare user.
      if (err && /\b421\b/.test(err.message)) {
        this._devMgr.clearCache([
          toJid.endsWith('@lid') ? 'lid:' + phoneFromJid(toJid) : phoneFromJid(toJid)
        ]);
        return this._sendDMMessage(toJid, msgId, plaintext, mediaType, options);
      }
      // ── Error 479: stale / dead Signal session ────────────────────────────────
      // The server rejected the ciphertext because it was encrypted with a Signal
      // session key the server no longer recognises (recipient re-installed WA,
      // changed device, or their prekey was exhausted / revoked).
      //
      // Recovery:
      //   1. Delete all cached Signal sessions for this recipient (PN + LID).
      //   2. Flush device-ID cache → forces a fresh usync IQ on next send.
      //   3. Re-call _sendDMMessage → re-runs usync + fetchBundles + buildSession
      //      + re-encrypts with a fresh PreKey message (pkmsg).
      //
      // _479retry flag prevents infinite loops: if the fresh session also gets
      // 479 (extremely rare — server bug or banned account) we fail cleanly.
      if (err && /\b479\b/.test(err.message) && !options._479retry) {
        await this._clearSignalSessionsForJid(toJid);
        // CRITICAL: generate a NEW msgId — the server already ACK'd (with error=479)
        // the original ID and will close the connection if we re-send the same ID.
        const retryMsgId = generateMessageId();
        _whaDbg('[DBG] 479_RETRY new msgId=' + retryMsgId);
        return this._sendDMMessage(toJid, retryMsgId, plaintext, mediaType,
          Object.assign({}, options, { _479retry: true }));
      }
      // ── No session at all ────────────────────────────────────────────────────
      // Nothing could be encrypted for any device, so there is no ciphertext to
      // send. This is what a timed-out prekey IQ leaves behind: the device list
      // is cached but no session sits behind it, and every later send fails the
      // same way because the cache hides the gap. Purge both and retry once, so
      // the next attempt re-fetches bundles and opens fresh pkmsg sessions.
      if (err && /NO_OPEN_SESSION/.test(err.message) && !options._noSessionRetry) {
        _whaDbg('[DBG] NO_OPEN_SESSION dm ' + toJid + ' — forcing fresh pkmsg\n');
        await this._forceSessionRebuild([toJid]);
        return this._sendDMMessage(toJid, generateMessageId(), plaintext, mediaType,
          Object.assign({}, options, { _noSessionRetry: true }));
      }
      // ─────────────────────────────────────────────────────────────────────────
      throw err;
    }
  }

  // ─── Encrypt for a device list, closing any gap before it reaches the wire ──
  //
  // Every JID handed in becomes a <to><enc> entry, and a stanza whose
  // participants do not cover the device list the server holds for those users
  // is nacked with ack 479. bulkEncryptForDevices drops whatever it cannot
  // encrypt, so a single unusable session silently shrank the participant list
  // and the whole send failed.
  //
  // Anything that fails gets its session torn down and rebuilt from a fresh
  // prekey bundle, then re-encrypted once. If it still fails there is nothing
  // left to try — the device is genuinely unreachable — and it is logged rather
  // than passed over in silence.
  async _encryptForDevices(jids, plaintext) {
    if (!jids || jids.length === 0) return [];

    const first = await this._signal.bulkEncryptForDevicesDetailed(jids, plaintext);
    if (first.failed.length === 0) return first.encrypted;

    _whaDbg('[DBG] ENCRYPT_GAP ' +
      first.failed.map(f => f.jid + ' (' + f.reason + ')').join(', ') +
      ' — rebuilding sessions');

    const repaired = await this._devMgr
      .rebuildSessionsForJids(first.failed.map(f => f.jid), this._signal)
      .catch(err => {
        _whaDbg('[DBG] ENCRYPT_GAP_REBUILD_ERR ' + (err && err.message));
        return [];
      });
    if (repaired.length === 0) return first.encrypted;

    const second = await this._signal.bulkEncryptForDevicesDetailed(repaired, plaintext);
    if (second.failed.length > 0) {
      _whaDbg('[DBG] ENCRYPT_GAP_UNRESOLVED ' +
        second.failed.map(f => f.jid).join(', '));
    }
    return [...first.encrypted, ...second.encrypted];
  }

  // Drop every cached device list and Signal session for these JIDs so the next
  // send is forced to re-query devices, re-fetch prekey bundles and open new
  // pkmsg sessions from scratch.
  async _forceSessionRebuild(jids) {
    const phones = [...new Set((jids || []).map(phoneFromJid).filter(Boolean))];
    for (const phone of phones) {
      await this._clearSignalSessionsForRecipient(phone).catch(() => {});
    }
    if (this._devMgr && phones.length) {
      this._devMgr.clearCache(phones);
      // LID device lists are cached under a separate key.
      if (typeof this._devMgr._dcDel === 'function') {
        this._devMgr._dcDel(phones.map(p => 'lid:' + p));
      }
    }
    _whaDbg('[DBG] FORCE_SESSION_REBUILD purged ' + phones.join(', ') + '\n');
  }

  // ─── Clear all Signal sessions for a phone-number recipient ─────────────────
  //
  // Called on error 479 (stale session).  Deletes:
  //   • All Signal sessions keyed by phone-number device JIDs (e.g. 40756469325:0)
  //   • The corresponding LID device session if a LID mapping is known
  //
  // Then flushes the device-ID cache for that phone so the next send re-runs
  // usync (gets current device list) and re-fetches fresh prekey bundles.
  async _clearSignalSessionsForRecipient(phone) {
    _whaDbg('[DBG] 479_RECOVERY phone=' + phone + ' — clearing sessions + device cache');
    const signal  = this._signal;
    const devMgr  = this._devMgr;
    const client  = this._client;

    // ── 1. Get all known device JIDs for this phone (from cache) ──────────────
    const devJids = devMgr._jidsFromCache([phone]);
    for (const jid of devJids) {
      try {
        await signal.deleteSession(jid);
        _whaDbg('[DBG] 479_DEL_SESSION jid=' + jid);
      } catch (_) {}
    }

    // ── 2. Clear LID session if we have a LID mapping for this phone ──────────
    // NOTE: LID JIDs use @lid server, NOT @s.whatsapp.net. Cannot use
    // _jidsFromCache() (it hard-codes @s.whatsapp.net) — build JIDs manually.
    const lidUser = client._pnToLid && client._pnToLid.get(phone);
    if (lidUser) {
      // Get all device IDs for this LID from cache (or assume device 0 primary)
      const lidDeviceIds = (devMgr._dcGet && devMgr._dcGet('lid:' + lidUser)) || [0];
      for (const devId of lidDeviceIds) {
        const jid = (devId === 0) ? `${lidUser}@lid` : `${lidUser}:${devId}@lid`;
        try {
          await signal.deleteSession(jid);
          _whaDbg('[DBG] 479_DEL_LID_SESSION jid=' + jid);
        } catch (_) {}
      }
      // Always delete the bare primary JID too (in case it was stored without device suffix)
      try { await signal.deleteSession(`${lidUser}@lid`); } catch (_) {}
      // Flush LID device-ID cache so next send re-runs usync for LID
      devMgr.clearCache(['lid:' + lidUser]);
    }

    // ── 3. Flush phone device cache → usync re-runs on next send ──────────────
    devMgr.clearCache([phone]);
    _whaDbg('[DBG] 479_CACHE_FLUSHED phone=' + phone);
  }

  // ─── Clear Signal sessions for a JID in whichever family it is written in ───
  //
  // _clearSignalSessionsForRecipient takes a phone number. Group recovery used
  // to feed it phoneFromJid(memberJid), which for a LID member is the LID user —
  // it was then looked up as a phone, built @s.whatsapp.net JIDs out of it and
  // deleted nothing at all, so 479 recovery on a LID-addressed group was a
  // no-op that resent the identical stanza. This dispatches on the server part
  // instead.
  async _clearSignalSessionsForJid(jid) {
    const str = String(jid);
    if (!str.endsWith('@lid')) {
      return this._clearSignalSessionsForRecipient(phoneFromJid(str));
    }

    const lidUser = phoneFromJid(str);
    const devIds  = (this._devMgr._dcGet && this._devMgr._dcGet('lid:' + lidUser)) || [0];
    for (const devId of devIds) {
      const devJid = (devId === 0) ? `${lidUser}@lid` : `${lidUser}:${devId}@lid`;
      try {
        await this._signal.deleteSession(devJid);
        _whaDbg('[DBG] 479_DEL_LID_SESSION jid=' + devJid);
      } catch (_) {}
    }
    try { await this._signal.deleteSession(`${lidUser}@lid`); } catch (_) {}
    this._devMgr.clearCache(['lid:' + lidUser]);

    // A LID member we also know by phone has phone-addressed sessions cached
    // under that number too; clear both so the retry cannot pick up a stale one.
    const pn = this._client._lidToPn && this._client._lidToPn.get(lidUser);
    if (pn) await this._clearSignalSessionsForRecipient(pn);
  }

  // ─── 1-to-1 multi-device fanout ───────────────────────────────────────────

  async _sendDMMessage(toJid, msgId, plaintext, mediaType, options) {
    options = options || {};
    const recipientPhone = phoneFromJid(toJid);
    const ownPhone       = String(this._store.phoneNumber);
    const ownMainJid     = `${ownPhone}@s.whatsapp.net`;
    const mediaSubtype   = options._mediaSubtype || null;

    // For primary iOS devices (registered via SMS), advIdentity is never set
    // because the server only sends device-identity for linked secondary devices.
    // Primary devices can always use pkmsg to establish new Signal sessions —
    // they simply omit the device-identity node (server accepts this for primaries).
    const allowPkmsg = true;

    // ── Addressing family ─────────────────────────────────────────────────────
    // The whole address family comes from the JID the caller passed, and the
    // two are never converted between:
    //
    //     const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
    //     const senderIdentity   = isLid && meLid ? <ourLid> : <ourPn>
    //     const sessionDevices   = await getUSyncDevices([senderIdentity, jid])
    //     const finalJid         = jid            // the envelope, unchanged
    //
    // Send to a phone JID and everything — envelope, device enumeration,
    // participant <to> entries — stays on phone JIDs. Send to an @lid and it
    // all stays LID.
    //
    // "Everything" includes OUR OWN devices, which is what was missing here.
    // The recipient's devices followed the caller's JID but ours were always
    // enumerated by phone, so a DM to an @lid went out with @lid recipient
    // entries and @s.whatsapp.net entries for our own linked devices in the same
    // <participants> list. The pair has to be [to, ownID] with ownID switched to
    // our LID for @lid destinations; a participant list the server cannot
    // reconcile is what comes back as 479.
    const isLidTarget  = toJid.endsWith('@lid');
    const routingToJid = toJid;
    const ownLidUser   = this._client._myLid ? phoneFromJid(this._client._myLid) : null;

    if (isLidTarget && !ownLidUser) {
      throw new Error(
        'Cannot send to ' + toJid + ': the recipient is LID-addressed but our own LID ' +
        'is unknown (the server did not supply lid= on <success>). Reconnect so the ' +
        'LID is re-issued.'
      );
    }

    // Enumerate the recipient's devices and our own in parallel, both in the
    // address family the destination JID dictates.
    let otherJids, ownLinkedJids, ownPrimaryJid;
    if (isLidTarget) {
      const lidUser = phoneFromJid(toJid);
      const [lidDevices, ownLidDevices] = await Promise.all([
        this._devMgr.bulkEnsureSessionsForLid(lidUser, this._signal, allowPkmsg, /* skipUsync */ true),
        this._devMgr.ensureOwnLidDeviceSessions(ownLidUser, ownPhone, this._signal, allowPkmsg)
      ]);
      otherJids     = lidDevices.length > 0 ? lidDevices : [toJid];
      ownLinkedJids = ownLidDevices;
      ownPrimaryJid = this._client._ownDeviceLidJid() || `${ownLidUser}@lid`;
    } else {
      const [pnDevices, ownDevices] = await Promise.all([
        this._devMgr.bulkEnsureSessions([recipientPhone], this._signal, allowPkmsg),
        this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal, allowPkmsg)
      ]);
      otherJids     = pnDevices.length > 0 ? pnDevices : [toJid];
      // Every own device except the one doing the sending. As a primary that is
      // device 0 and the list below drops it; as a companion the account's
      // phone is device 0 and must stay in — it is a peer we encrypt to, not
      // ourselves. The filter a few lines down removes whichever one we are.
      ownLinkedJids = ownDevices;
      ownPrimaryJid = this._client._ownDeviceJid();
    }

    // The device doing the sending is never one of its own recipients.
    const ownPrimaryAddr = adString(ownPrimaryJid);
    otherJids     = otherJids.filter(j => adString(j) !== ownPrimaryAddr);
    ownLinkedJids = ownLinkedJids.filter(j => adString(j) !== ownPrimaryAddr);

    // A device appears in <participants> exactly once. Writing to our own chat
    // makes both lists resolve to the same devices; they belong to the own-device
    // list, which sends them the DeviceSentMessage rather than the bare message.
    const ownLinkedAddrs = new Set(ownLinkedJids.map(adString));
    otherJids = otherJids.filter(j => !ownLinkedAddrs.has(adString(j)));

    _whaDbg('[DBG] DM_ROUTE to=' + toJid + ' family=' + (isLidTarget ? 'LID' : 'PN') +
      ' devices=[' + otherJids.join(',') + ']' +
      ' ownLinked=[' + ownLinkedJids.join(',') + ']');
    // ─────────────────────────────────────────────────────────────────────────

    // The hash covers every device the server enumerates for this pair of users,
    // our own primary included — the sending device is skipped only when it
    // comes to encrypting. Excluding it here produced a hash over a different
    // set than the server's.
    //
    // It is not put on the stanza: phash belongs on a group message, not a 1:1
    // one. It is carried inside the (encrypted)
    // DeviceSentMessage for our own devices, and compared against the phash the
    // server echoes back on the ack so a drifted device cache gets flushed.
    const phash = computePhash([...otherJids, ownPrimaryJid, ...ownLinkedJids]);

    const dsmBuf = ownLinkedJids.length > 0
      ? encodeDeviceSentMessage(toJid, plaintext, phash)
      : null;

    // Acquire mutex before touching Signal sessions — concurrent sends on the
    // same session corrupt the ratchet chain and produce undecryptable messages.
    const [otherEncrypted, ownEncrypted] = await this._encryptMutex.runExclusive(async () => {
      const other = await this._encryptForDevices(otherJids, plaintext);
      const own   = ownLinkedJids.length > 0
        ? await this._encryptForDevices(ownLinkedJids, dsmBuf)
        : [];
      return [other, own];
    });

    const encryptedList = [...otherEncrypted, ...ownEncrypted];

    // Encode the routing JID as a binary JID object (JID_PAIR for @lid / @s.whatsapp.net).
    // Raw UTF-8 strings are not recognised by the server for LID recipients, causing
    // the message to be accepted (server ACK) but never delivered to the device.
    const stanzaAttrs = { to: jidStrToObj(routingToJid), id: msgId, type: mediaType, t: String(msNow()) };
    if (options.edit) stanzaAttrs.edit = String(options.edit);
    // A peer message — one this account sends to its own other devices, like a
    // peer-data-operation request. Without category="peer" the server treats it
    // as an ordinary chat message to yourself and it never reaches the phone.
    if (options.category)     stanzaAttrs.category      = String(options.category);
    if (options.pushPriority) stanzaAttrs.push_priority = String(options.pushPriority);

    const hasPkmsg   = encryptedList.some(e => e.type === 'pkmsg');
    const store      = this._client._store;
    const advBytes   = hasPkmsg ? _buildOrGetAdvIdentity(store) : null;
    const devIdNodes = advBytes ? [new BinaryNode('device-identity', {}, advBytes)] : [];

    let msgContent;
    if (encryptedList.length === 0) {
      throw new Error('NO_OPEN_SESSION: no encrypted recipients — need a fresh pkmsg to establish session');
    } else {
      // Always use <participants><to jid=...><enc> structure — required by MD protocol.
      // Old iOS non-MD used direct <enc> in <message>, but the WhatsApp server now
      // enforces the MD participants wrapper even for single-device sends.
      const participantsNode = DeviceManager.buildParticipantsNode(encryptedList, mediaSubtype);
      msgContent = [...devIdNodes, participantsNode];
    }

    // ─── Reporting token ─────────────────────────────────────────────────────
    // Rides on any message carrying a message secret, so a recipient can report
    // it and have the server verify the reported text is what was actually
    // sent. Sending the secret without the token is a combination no real
    // client produces.
    const reportingNode = buildReportingNode({
      plaintext, msgId, remoteJid: routingToJid, BinaryNode
    });
    if (reportingNode) {
      msgContent.push(reportingNode);
      _whaDbg('[DBG] REPORTING_TOKEN attached to=' + routingToJid + ' id=' + msgId);
    }

    // ─── tcToken (error 463 / reachout timelock defense) ─────────────────────
    // WhatsApp counts every DM without a <tctoken> node as a "reaching out"
    // event. Once enough accumulate the server returns error 463 (timelock).
    // We attach the stored trusted-contact token when one exists and is valid.
    const tcStore = this._client._tcTokenStore;
    // Keyed by the contact's LID, which is where a token they issued us was
    // filed when it arrived. Looking it up by the phone JID — which is what
    // this did — never found one, so nothing was ever attached.
    const tcJid   = this._client._resolveTcTokenJid(routingToJid);
    if (tcStore) {
      const tcEntry = tcStore.get(tcJid);
      if (tcEntry && tcEntry.token && tcEntry.token.length) {
        if (!tcTokenExpired(tcEntry.timestamp)) {
          msgContent.push(new BinaryNode('tctoken', {}, tcEntry.token));
          _whaDbg('[DBG] TCTOKEN_ATTACH jid=' + tcJid);
        } else {
          // Expired token — clear it, keep senderTimestamp for dedupe
          tcStore.clearToken(tcJid);
          _whaDbg('[DBG] TCTOKEN_EXPIRED jid=' + tcJid + ' — cleared\n');
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Extra children a caller needs on the stanza — the <meta appdata> a
    // peer-data-operation request carries, for instance.
    for (const extra of options.additionalNodes || []) {
      if (extra) msgContent.push(extra);
    }

    const msgNode = new BinaryNode('message', stanzaAttrs, msgContent);

    // Debug: log outgoing stanza details
    _whaDbg('[DBG] DM_SEND to=' + toJid +
      ' otherJids=[' + otherJids.join(',') + ']' +
      ' ownLinked=[' + ownLinkedJids.join(',') + ']' +
      ' encrypted=' + encryptedList.length +
      ' hasPkmsg=' + hasPkmsg +
      ' hasAdv=' + !!(advBytes));
    if (encryptedList.length > 0) {
      _whaDbg('[DBG] DM_PARTICIPANTS ' +
        encryptedList.map(e => e.jid + '(' + e.type + ')').join(', '));
    }

    // Cache plaintext so Client can re-send with fresh session on recipient retry
    this._client._cacheSentMessage({
      plaintext, toJid, msgId, mediaType, options, recipientPhone,
      retryDepth: options._retryDepth || 0
    });

    const dispatchResult = await this._dispatchAndAck(msgNode, msgId);

    // The server echoes its own participant hash on the ack. A difference means
    // its device list for this chat is not the one we just fanned out to, so the
    // cached list is stale — drop it and let the next send re-run usync.
    if (dispatchResult && dispatchResult.phash && dispatchResult.phash !== phash) {
      _whaDbg('[DBG] PHASH_MISMATCH ours=' + phash + ' server=' + dispatchResult.phash +
        ' to=' + toJid + ' — flushing device cache');
      if (isLidTarget) {
        this._devMgr.clearCache(['lid:' + phoneFromJid(toJid)]);
      } else {
        this._devMgr.clearCache([recipientPhone]);
      }
    }

    // ─── Fire-and-forget: issue privacy token to contact ─────────────────────
    // After each DM send we ask WhatsApp to issue us a trusted-contact token
    // for this JID (one issuance per 7-day bucket is enough).  The token is
    // stored and attached on future sends so the server does not count them
    // as anonymous "reaching out" events (which would trigger error 463).
    //
    // Two targets never get one. WhatsApp's own announcement account
    // (0@s.whatsapp.net) and the bot numbers, including Meta AI, are not
    // contacts you can be "timelocked" against, and no real client issues to
    // them. Protocol messages (a revoke, an ephemeral-timer change) are out
    // too — they are bookkeeping, not a reach-out. Attaching an existing token
    // to them is still correct
    // and still happens above — this only governs asking for a new one.
    const isProtocolMsg = !!(options && options._protocol);
    if (tcStore && isRegularTcTokenUser(tcJid) && !isProtocolMsg &&
        tcStore.shouldIssue(tcJid) &&
        !this._client._inFlightTcTokenIssuance.has(tcJid)) {
      this._client._inFlightTcTokenIssuance.add(tcJid);
      const issueTs  = Math.floor(Date.now() / 1000);
      const issueJid = this._client._resolveTcTokenIssuanceJid(routingToJid);
      this._client._issuePrivacyTokens(issueJid, issueTs)
        .then(result => this._client._storeTcTokenFromIqResult(result, tcJid, issueTs))
        .catch(() => {})
        .finally(() => this._client._inFlightTcTokenIssuance.delete(tcJid));
    }
    // ─────────────────────────────────────────────────────────────────────────

    return dispatchResult;
  }

  // ─── Group SenderKey fanout ────────────────────────────────────────────────

  async _sendGroupMessage(groupJid, msgId, plaintext, mediaType, options) {
    options = options || {};
    const ownPhone     = String(this._store.phoneNumber);
    const ownJid       = `${ownPhone}@s.whatsapp.net`;
    const mediaSubtype = options._mediaSubtype || null;

    const isStatus = isStatusBroadcast(groupJid);

    // A Status has no group metadata; its recipients come from the account's
    // status privacy settings, or from a list the caller supplied.
    let members;
    if (isStatus) {
      members = options._statusRecipients ||
        (typeof this._client._getStatusRecipients === 'function'
          ? await this._client._getStatusRecipients()
          : []);
      // Our own JID is always in the list so the post reaches our own devices,
      // so a list of length one means there is nobody else on it. Counting the
      // raw list let that through: the walk below then dropped us as the
      // sender, left no targets, and the stanza went out as a bare skmsg with
      // no <participants> — a SenderKey message nobody holds the key for, which
      // the server answers with ack 479.
      const others = members.filter(jid => !this._client._isOwnUser(jid));
      if (others.length === 0) {
        throw new Error(
          'Cannot post a Status: it would reach nobody. The contact list is ' +
          'empty — sync history first, or pass { recipients: [...] }.'
        );
      }
    }

    // Auto-fetch group metadata if member cache is empty (first send to this group)
    if (!isStatus) members = this._client._getGroupMembers(groupJid);
    if (!isStatus && members.length === 0 && typeof this._client.getGroupMetadata === 'function') {
      _whaDbg('[DBG] GROUP_SEND auto-fetch metadata for ' + groupJid);
      let metaErr = null;
      try {
        await this._client.getGroupMetadata(groupJid);
        members = this._client._getGroupMembers(groupJid);
      } catch (err) {
        metaErr = err;
        _whaDbg('[DBG] GROUP_SEND metadata fetch failed: ' + (err && err.message));
      }
      // Without the participant list we cannot establish Signal sessions with
      // the members, so the SenderKey distribution would reach nobody and the
      // stanza would carry an <enc type='skmsg'> that no one can decrypt.  The
      // server rejects exactly that shape with ack error 479.  Fail here with a
      // reason the caller can act on instead of emitting a doomed stanza.
      if (members.length === 0) {
        throw new Error(
          'Cannot send to ' + groupJid + ': group metadata unavailable' +
          (metaErr ? ' (' + metaErr.message + ')' : '') +
          ' — no Signal session can be established with the members. ' +
          'Check that the account is still a participant of this group.'
        );
      }
    }

    // Determine addressing mode for this group (lid = modern groups, pn = legacy).
    // A Status carries none: addressing_mode is set only for the group server,
    // and a Status goes to ordinary contacts, so everything below stays in
    // phone space.
    const groupAddressingMode = isStatus
      ? null
      : (this._client._groupAddressingMode.get(groupJid) || 'lid');
    // A stanza addressed with addressing_mode='lid' must carry participants in
    // LID space only. Mixing @s.whatsapp.net targets into it is exactly what
    // DeviceManager warns about, and the server answers it with ack 479.
    const useLid = groupAddressingMode === 'lid';
    if (useLid && !this._client._myLid) {
      throw new Error(
        'Cannot send to ' + groupJid + ': group is LID-addressed but our own LID ' +
        'is unknown (the server did not supply lid= on <success>). ' +
        'Reconnect so the LID is re-issued.'
      );
    }
    // Derived whenever the server has given us a LID, not only in LID mode: it
    // is also what recognises our own entry in a member list that names us by
    // LID while the group itself is still pn-addressed.
    const myLidUser = this._client._myLid ? phoneFromJid(this._client._myLid) : null;
    // For LID-mode groups, sender identity is own LID JID; otherwise own PN JID.
    // Normalised to the bare user so it matches the participant targets below.
    const selfJid = useLid ? `${myLidUser}@lid` : ownJid;
    // The SenderKey is this device's, so the identity it is filed under carries
    // our device index. On a primary that index is 0 and this is exactly the
    // bare JID above; on a companion it keeps our key distinct from the
    // account's phone, which distributes its own.
    const senderIdentity = (useLid
      ? this._client._ownDeviceLidJid()
      : this._client._ownDeviceJid()) || selfJid;

    const rawSKDM   = await this._signal.buildSKDM(groupJid, senderIdentity);
    const skdmMsg   = encodeSenderKeyDistributionMessage(groupJid, rawSKDM);

    // We are a participant of our own group, so our own entry has to be taken
    // out of the member walk and put back through the own-device path below.
    // Left in, the walk enumerates our devices starting at device 0 — the very
    // device doing the sending — and it lands in <participants> as a recipient
    // of our own SenderKey. The exact sender device has to be skipped, matched
    // against both our phone JID and our LID.
    //
    // The phone branch already dropped us via `p !== ownPhone`; the LID branch
    // never did, so this only ever misfired on LID-addressed groups.
    const isSelfMember = (jid) => {
      const raw = phoneFromJid(jid);
      return raw === ownPhone || (myLidUser && raw === myLidUser);
    };

    // Resolve member phones for session/device queries.
    // For LID members without a PN mapping, keep the raw LID user part so
    // bulkEnsureSessionsForLid can still acquire sessions for them.
    const lidMembersWithoutPn = [];
    const memberPhones = [...new Set(
      members.map(jid => {
        if (isSelfMember(jid)) return null;
        const isLid = jid.endsWith('@lid');
        const raw   = phoneFromJid(jid);
        if (isLid) {
          // In a LID-addressed group, resolve LID members through the LID path
          // even when we know their phone number — swapping in the PN would put
          // an @s.whatsapp.net target into a @lid stanza.
          if (!useLid) {
            const pn = this._client._lidToPn && this._client._lidToPn.get(raw);
            if (pn) return pn;
          }
          lidMembersWithoutPn.push(jid);
          return null;
        }
        return raw;
      }).filter(p => p !== null && p !== ownPhone)
    )];

    const [memberDevices, lidDevices, ownTargets] = await Promise.all([
      memberPhones.length > 0
        ? this._devMgr.bulkEnsureSessions(memberPhones, this._signal)
        : Promise.resolve([]),
      lidMembersWithoutPn.length > 0
        ? Promise.all(lidMembersWithoutPn.map(jid =>
            this._devMgr.bulkEnsureSessionsForLid(phoneFromJid(jid), this._signal)
              .catch(() => [])
          )).then(results => results.flat())
        : Promise.resolve([]),
      // Our own linked devices, in the address family the stanza is routed with.
      // ensureOwnDeviceSessions hands back @s.whatsapp.net JIDs, which cannot go
      // into a stanza carrying addressing_mode='lid'; both helpers leave out the
      // device we are, which is device 0 only while we are the primary.
      useLid
        ? this._devMgr.ensureOwnLidDeviceSessions(myLidUser, ownPhone, this._signal)
        : this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal)
    ]);

    // Every device this group resolves to, our own primary included, deduped so
    // a device reached through more than one path is counted once. The hash
    // covers the whole enumeration, sending device and all, with hosted
    // endpoints dropped first since those are bot-side and never real
    // participants.
    const isHostedJid = (jid) => {
      const s = String(jid);
      return s.endsWith('@hosted') || s.endsWith('@hosted.lid');
    };
    // The sending device counts in the enumeration even though it is not a
    // recipient — and that is *this* device, not device 0. On a companion link
    // the bare JID names the owner's phone, which arrives through ownTargets
    // like every other device; adding it here again while leaving our own slot
    // out would hash a set the server never computes.
    const ownSelfJid = (useLid
      ? this._client._ownDeviceLidJid()
      : this._client._ownDeviceJid()) || selfJid;

    const enumeratedDevices = [...new Set(
      [...memberDevices, ...lidDevices, ...ownTargets, ownSelfJid]
    )].filter(jid => !isHostedJid(jid));

    // The participant hash the server checks the fan-out against. It goes on
    // group stanzas and nowhere else, and is computed over the enumeration
    // above rather than over the encryption targets,
    // so the sending device counts here even though it is not a recipient.
    const phash = computePhash(enumeratedDevices);

    // Targets to actually encrypt for: everything but the sending device, and
    // it is skipped at this point rather than earlier.
    // Only the device actually sending. On a companion link that is not the
    // account's phone — the phone is a peer that has to receive the SenderKey
    // like everyone else, so excluding the bare number here would leave the
    // owner's own phone unable to read the message.
    const selfAddrs = new Set([adString(this._client._ownDeviceJid())]);
    const ownLidSelf = this._client._ownDeviceLidJid();
    if (ownLidSelf)     selfAddrs.add(adString(ownLidSelf));
    else if (myLidUser) selfAddrs.add(adString(`${myLidUser}@lid`));
    const allTargets = enumeratedDevices.filter(jid => !selfAddrs.has(adString(jid)));

    // Whatever the member list said, if nothing came back with a session there
    // is no one to hand the SenderKey to and the skmsg below is undeliverable.
    // Better to say so than to emit it and read the 479 back.
    if (isStatus && allTargets.length === 0) {
      throw new Error(
        'Cannot post a Status: no Signal session could be opened with any ' +
        'recipient, so the post would reach nobody.'
      );
    }

    const skStore        = this._signal.senderKeyStore;
    const existingSkdmMap = skStore.getSKDMMap(groupJid);
    // Exclusions when choosing SenderKey recipients: hosted (bot-side) users
    // and device 99, which is a server placeholder
    // rather than a real endpoint, must never receive a distribution.
    const isSkdmEligible = (jid) => {
      const s = String(jid);
      if (s.endsWith('@hosted') || s.endsWith('@hosted.lid')) return false;
      const base  = s.replace(/@.*$/, '');
      const colon = base.indexOf(':');
      return !(colon >= 0 && parseInt(base.slice(colon + 1), 10) === 99);
    };
    const skdmRecipients = allTargets.filter(
      jid => !existingSkdmMap[jid] && isSkdmEligible(jid)
    );

    // Acquire mutex for all group encryption — SKDM fanout and senderKey encrypt
    // share the same Signal session state and must not run concurrently.
    let skdmEncrypted = [];
    let skmsgCiphertext;
    await this._encryptMutex.runExclusive(async () => {
      if (skdmRecipients.length > 0) {
        skdmEncrypted = await this._encryptForDevices(skdmRecipients, skdmMsg);
        // Record only the devices whose SenderKey distribution actually made it
        // into the stanza. Marking the whole intended list meant a device we
        // failed to encrypt for was remembered as already holding our key, so it
        // never got another distribution and could not decrypt anything we sent
        // to the group from then on.
        skStore.markSKDMSent(groupJid, skdmEncrypted.map(e => e.jid));
      }
      skmsgCiphertext = await this._signal.senderKeyEncrypt(groupJid, senderIdentity, plaintext);
    });

    const skdmHasPkmsg = skdmEncrypted.some(e => e.type === 'pkmsg');
    const advBytes     = skdmHasPkmsg ? _buildOrGetAdvIdentity(this._client._store) : null;
    // No device-identity is expected here. ADVSignedDeviceIdentity is issued
    // when a companion device is paired, to prove the companion's identity key
    // was authorised by the primary. This client registers over SMS as the
    // primary device, so its identity key IS the account identity and there is
    // nothing to attach — advBytes stays null and that is correct.

    const msgContent = [];
    if (advBytes) {
      msgContent.push(new BinaryNode('device-identity', {}, advBytes));
    }
    if (skdmEncrypted.length > 0) {
      // The same extra attrs — mediatype included — belong on the SenderKey
      // participant nodes as on the skmsg, so an image sent to a group carries
      // mediatype on both. Passing null here left the SKDM <enc> nodes
      // unlabelled.
      msgContent.push(DeviceManager.buildParticipantsNode(skdmEncrypted, mediaSubtype));
    }
    const skmsgAttrs = { type: 'skmsg', v: '2' };
    if (mediaSubtype) skmsgAttrs.mediatype = mediaSubtype;
    msgContent.push(new BinaryNode('enc', skmsgAttrs, Buffer.isBuffer(skmsgCiphertext) ? skmsgCiphertext : Buffer.from(skmsgCiphertext)));

    // Same reporting token a direct message carries. A poll posted to a group
    // is the common case: it has a message secret, so it needs the token that
    // lets a report on it be verified.
    const groupReportingNode = buildReportingNode({
      plaintext, msgId, remoteJid: groupJid, BinaryNode
    });
    if (groupReportingNode) {
      msgContent.push(groupReportingNode);
      _whaDbg('[DBG] REPORTING_TOKEN attached to=' + groupJid + ' id=' + msgId);
    }

    // phash belongs on a group stanza and only on a group stanza. It tells the
    // server which device set we fanned out to; the server compares it against
    // its own and echoes its hash back on the ack when they differ.
    const stanzaAttrs = {
      to: jidStrToObj(groupJid),
      id: msgId,
      type: mediaType,
      phash,
      t:   String(msNow())
    };
    if (groupAddressingMode) stanzaAttrs.addressing_mode = groupAddressingMode;
    if (options.edit) stanzaAttrs.edit = String(options.edit);

    // Cache the plaintext here too, not just on the DM path. A group recipient
    // that cannot decrypt sends a retry receipt exactly like a DM recipient
    // does, and without this the client had nothing to re-send and dropped it
    // with "no cached plaintext" — so the message was acked by the server and
    // then silently never arrived.
    this._client._cacheSentMessage({
      plaintext, toJid: groupJid, msgId, mediaType, options, isGroup: true,
      retryDepth: options._retryDepth || 0
    });

    const msgNode = new BinaryNode('message', stanzaAttrs, msgContent);
    const dispatchResult = await this._dispatchAndAck(msgNode, msgId);

    // A hash on the ack that differs from ours means the server's participant
    // list for this group is not the one we just fanned out to, so some members
    // did not get the message. The group cache is dropped on exactly this
    // signal, and the device lists behind the members with it, so the next send
    // re-runs group metadata and usync rather than repeating the miss.
    if (dispatchResult && dispatchResult.phash && dispatchResult.phash !== phash) {
      _whaDbg('[DBG] GROUP_PHASH_MISMATCH ours=' + phash +
        ' server=' + dispatchResult.phash + ' group=' + groupJid +
        ' — invalidating group metadata and device caches');
      if (typeof this._client.invalidateGroupMetadata === 'function') {
        this._client.invalidateGroupMetadata(groupJid);
      }
      const staleKeys = [...new Set(enumeratedDevices.map(jid =>
        String(jid).endsWith('@lid') ? 'lid:' + phoneFromJid(jid) : phoneFromJid(jid)
      ))];
      if (staleKeys.length) this._devMgr.clearCache(staleKeys);
    }

    return dispatchResult;
  }

  // ─── Dispatch and wait for ack ────────────────────────────────────────────
  //
  // Error 463 recovery:
  //   1. 463 ack arrives → issue privacy token via _issuePrivacyTokens
  //   2. Wait for token to be stored in _tcTokenStore
  //   3. Re-send the SAME message node with a new msgId — the tctoken node
  //      was already attached by _sendDMMessage, so the re-dispatched node
  //      carries the same content; the token lookup on re-send will succeed.
  //      The re-send uses _isRetry=true to prevent recursive 463 handling.
  //   4. Resolve/reject based on the re-send ack — transparent to the caller.
  //
  // Uses a SEPARATE _inFlight463Recoveries Set (not shared with the proactive
  // _inFlightTcTokenIssuance) so 463 recovery and proactive issuance never
  // block each other.

  _dispatchAndAck(node, msgId, _isRetry) {
    const self   = this;
    const client = this._client;
    const socket = this._socket;

    return new Promise((resolve, reject) => {
      let _timer = null;

      const armTimer = (id) => {
        _timer = setTimeout(() => {
          client._pendingAcks.delete(id);
          resolve({ id, status: 'sent' });
        }, 20000);
      };

      const sendNode = (n, id) => {
        armTimer(id);
        client._pendingAcks.set(id, (ackAttrs) => {
          clearTimeout(_timer);
          _timer = null;
          const error = ackAttrs && ackAttrs.error ? String(ackAttrs.error) : '';

          // ─── Error 463: missing tcToken / reachout timelock ───────────
          // Issue privacy token then automatically re-send once with the
          // token attached. Uses a separate _inFlight463Recoveries Set so
          // concurrent 463 recoveries and proactive issuances don't clash.
          if (error === '463' && !_isRetry) {
            // A 463 is either a missing privacy token for this one contact,
            // which the resend below fixes, or an account-wide restriction,
            // which it cannot. Ask the server which it is — that answer also
            // carries when a restriction ends, which nothing else reports.
            if (typeof client._refreshReachoutTimelockAfter463 === 'function') {
              client._refreshReachoutTimelockAfter463();
            }
            const ackFrom = ackAttrs.from ? String(ackAttrs.from) : '';
            const tcJid   = client._resolveTcTokenJid(
              ackFrom || String(node.attrs && node.attrs.to || '')
            );
            _whaDbg('[DBG] ACK_463 from=' + ackFrom + ' id=' + id +
              ' tcJid=' + tcJid + ' — issuing tctoken then retrying\n');

            if (client._inFlight463Recoveries.has(tcJid)) {
              // Another concurrent recovery in progress for this JID —
              // wait ~3 s for it to finish then retry with whatever token
              // is now stored (may or may not succeed).
              _whaDbg('[DBG] ACK_463 already in-flight for ' + tcJid + ' — retrying after delay\n');
              setTimeout(() => {
                const retryId   = crypto.randomBytes(8).toString('hex').toUpperCase();
                const retryNode = new BinaryNode(
                  node.description,
                  Object.assign({}, node.attrs, { id: retryId }),
                  node.content
                );
                self._dispatchAndAck(retryNode, retryId, /* _isRetry */ true)
                  .then(r => resolve(r))
                  .catch(e => reject(e));
              }, 3000);
              return;
            }

            client._inFlight463Recoveries.add(tcJid);
            const issueTs = Math.floor(Date.now() / 1000);

            // Same address family as every other issuance path — see
            // Client._resolveTcTokenIssuanceJid. This used to hand the server
            // whatever the ack happened to carry.
            const issueJid = client._resolveTcTokenIssuanceJid(
              ackFrom || String(node.attrs && node.attrs.to || '')
            );
            client._issuePrivacyTokens(issueJid, issueTs)
              .then(result => client._storeTcTokenFromIqResult(result, tcJid, issueTs))
              .then(() => {
                // Verify that real token bytes were received from the server.
                // If the IQ timed out (result=NULL) or the server refused to
                // issue (restricted account), tokenBytes=0 — re-sending would
                // just get another 463 immediately.  Reject with a clear message.
                const tcStore = client._tcTokenStore;
                const entry   = tcStore && tcStore.get(tcJid);
                const hasToken = entry && entry.token && entry.token.length > 0;
                if (!hasToken) {
                  _whaDbg('[DBG] ACK_463 IQ timeout or server refused — no token bytes stored for ' +
                    tcJid + ', giving up (account may be restricted)\n');
                  throw new Error(
                    'Send error 463: server did not issue a tctoken for ' + tcJid +
                    ' (IQ timeout or account restricted)'
                  );
                }
                _whaDbg('[DBG] ACK_463 token stored for ' + tcJid + ' — retrying send\n');
                const retryId   = crypto.randomBytes(8).toString('hex').toUpperCase();
                const retryNode = new BinaryNode(
                  node.description,
                  Object.assign({}, node.attrs, { id: retryId }),
                  node.content
                );
                return self._dispatchAndAck(retryNode, retryId, /* _isRetry */ true);
              })
              .then(r => resolve(r))
              .catch(err => {
                _whaDbg('[DBG] ACK_463 recovery failed: ' + (err && err.message));
                reject(new Error('Send error 463: tctoken recovery failed — ' + (err && err.message)));
              })
              .finally(() => client._inFlight463Recoveries.delete(tcJid));
            return;
          }
          // ─────────────────────────────────────────────────────────────

          if (error) {
            reject(new Error('Send error ' + error + ' for ' + id));
          } else {
            resolve({
              id,
              t:      ackAttrs && ackAttrs.t,
              // The server's own participant hash, when it sends one back. The
              // caller compares it against the list it fanned out to and drops
              // its device cache when they disagree.
              phash:  ackAttrs && ackAttrs.phash ? String(ackAttrs.phash) : undefined,
              status: 'sent'
            });
          }
        });

        try {
          socket.sendNode(n);
        } catch (err) {
          clearTimeout(_timer);
          _timer = null;
          client._pendingAcks.delete(id);
          reject(err);
        }
      };

      sendNode(node, msgId);
    });
  }

  // ─── Edit message ─────────────────────────────────────────────────────────
  // Sends the SAME msgId with edit=1 and new ExtendedTextMessage content.
  // Edit bit = 1 signals an edit to the server.

  async editMessage(origMsgId, chatJid, newText, opts) {
    opts = opts || {};
    const toJid = makeJid(chatJid);
    const payload = encodeExtendedText(newText);
    const msgBuf  = encodeMessage('extendedText', payload);
    return this._sendMessage(toJid, origMsgId, msgBuf, 'text', { ...opts, edit: '1' });
  }

  // ─── Delete message ───────────────────────────────────────────────────────
  // forEveryone=true: sends REVOKE ProtocolMessage with edit=7 (DM fromMe) or
  // edit=8 (admin deleting someone else's group message).
  // Delete bit selection logic.

  async deleteMessage(origMsgId, chatJid, fromMe, forEveryone, opts) {
    opts = opts || {};
    const toJid   = makeJid(chatJid);
    const msgId   = generateMessageId();
    const isGroup = isGroupJid(toJid);
    const editBit = (isGroup && !fromMe) ? '8' : '7';

    if (!forEveryone) {
      return { id: origMsgId, status: 'deleted_locally' };
    }

    const revokePayload = encodeProtocolMessage({
      type: PROTOCOL_MSG_REVOKE,
      key:  { remoteJid: toJid, fromMe: !!fromMe, id: origMsgId }
    });
    const msgBuf = encodeMessage('protocol', revokePayload);
    // A ProtocolMessage travels as stanza type "text"; there is no "protocol"
    // stanza type.
    // _protocol marks it for the tcToken issuance gate — see _sendDMMessage.
    return this._sendMessage(toJid, msgId, msgBuf, 'text',
      { ...opts, edit: editBit, _protocol: true });
  }

  // ─── Ephemeral timer DM ───────────────────────────────────────────────────
  // Sends EPHEMERAL_SETTING ProtocolMessage for 1-to-1 chats.

  async sendEphemeralTimerDM(chatJid, seconds, opts) {
    opts = opts || {};
    const toJid  = makeJid(chatJid);
    const msgId  = generateMessageId();
    const payload = encodeProtocolMessage({
      type:                 PROTOCOL_MSG_EPHEMERAL,
      ephemeralExpiration:  seconds
    });
    const msgBuf = encodeMessage('protocol', payload);
    return this._sendMessage(toJid, msgId, msgBuf, 'text', { ...opts, _protocol: true });
  }

  // ─── Utility: mark read, presence, receipt, ping ─────────────────────────

  // Both of these live on Client now — it is the side that knows our LID, the
  // privacy tokens and the online flag the receipt shape depends on. Kept here
  // so anything holding a MessageSender keeps working.
  markRead(jid, messageIds, opts) {
    return this._client.markRead(jid, messageIds, opts);
  }

  sendPresence(available) {
    return this._client.setOnline(available);
  }

  sendReceipt(msgId, from, type) {
    this._socket.sendNode(new BinaryNode('receipt', {
      id:   msgId,
      type: type || 'read',
      to:   from
    }, null));
  }

  ping() {
    this._socket.sendNode(new BinaryNode('iq', {
      id:    generateMessageId(),
      to:    's.whatsapp.net',
      type:  'get',
      xmlns: 'urn:xmpp:ping'
    }, [new BinaryNode('ping', {}, null)]));
  }

  // ─── Media upload ─────────────────────────────────────────────────────────

  // Resolve a caller's media argument to bytes. Shared by the upload and the
  // thumbnail pass so a file on disk is read once, not twice.
  _toMediaBuffer(data) {
    if (Buffer.isBuffer(data))         return data;
    if (typeof data === 'string')      return fs.readFileSync(data);
    throw new Error('Media must be a Buffer or file path');
  }

  async _uploadMedia(mediaType, data) {
    if (this._isMediaConnExpired()) {
      await this._fetchMediaConn();
    }
    const buf = this._toMediaBuffer(data);
    // Force-refresh callback: invoked by uploadMedia when a CDN host rejects the
    // auth token mid-upload, so the retry runs with fresh credentials instead of
    // failing with "connection expired".
    const refreshAuth = async () => {
      await this._fetchMediaConn();
      return { hosts: this._mediaHosts, auth: this._mediaAuth };
    };
    // A companion talks to the CDN as a browser: different endpoint for the
    // types the web client folds together, and an Origin header.
    return uploadMedia(mediaType, buf, this._mediaHosts, this._mediaAuth, refreshAuth,
      { web: this._client && this._client._mode === 'web' });
  }

  async _fetchMediaConn() {
    if (!this._client || !this._client._connected) {
      throw new Error('Cannot fetch media connection: not connected');
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this._client.removeListener('media_conn', onConn);
        this._client.removeListener('media_conn_error', onErr);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for media connection'));
      }, 15000);
      const onConn = ({ hosts, auth, ttl }) => {
        cleanup();
        if (!hosts || !hosts.length) {
          return reject(new Error('Media connection returned no upload hosts'));
        }
        this.setMediaConnection(hosts, auth, ttl, Date.now());
        resolve();
      };
      const onErr = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      this._client.once('media_conn', onConn);
      this._client.once('media_conn_error', onErr);
      try {
        this._client._requestMediaConnection();
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function guessMime(data, fallback) {
  if (typeof data !== 'string') return fallback;
  const ext = path.extname(data).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif',  '.webp': 'image/webp',  '.mp4': 'video/mp4',
    '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',  '.m4a': 'audio/mp4',    '.pdf': 'application/pdf',
    '.webm': 'video/webm'
  };
  return map[ext] || fallback;
}

module.exports = {
  MessageSender, makeJid, isGroupJid, generateMessageId,
  buildOrGetAdvIdentity: _buildOrGetAdvIdentity,
  computePhash, adString
};
