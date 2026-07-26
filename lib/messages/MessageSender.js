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
  encodeDeviceSentMessage, encodeProtocolMessage,
  encodeExtendedText,
  encodeSenderKeyDistributionMessage,
  PROTOCOL_MSG_REVOKE, PROTOCOL_MSG_EPHEMERAL
} = require('../proto/MessageProto');
const { uploadMedia } = require('../MediaService');
const { tcTokenExpired, shouldSendNewTcToken, normalizeJidForTcToken } = require('./TcTokenStore');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateMessageId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function msNow() { return Math.floor(Date.now() / 1000); }

function isGroupJid(jid) {
  return jid.endsWith('@g.us') || jid.endsWith('@community');
}

function phoneFromJid(jid) {
  const at    = jid.indexOf('@');
  const user  = at >= 0 ? jid.slice(0, at) : jid;
  const colon = user.indexOf(':');
  return colon >= 0 ? user.slice(0, colon) : user;
}

// ─── Feature 2: ADVSignedDeviceIdentity builder ──────────────────────────────
//
// whalibmob receives device-identity from the server in the
// pair-success IQ.  For primary iOS devices registered via SMS there is no
// pairing IQ — so we construct the ADVSignedDeviceIdentity ourselves from our
// own identity key pair, matching exactly what a real iOS primary device does.
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
  if (store.advIdentity && store.advIdentity.length > 0) return store.advIdentity;

  try {
    const curve   = _getCurve();
    const pubRaw  = Buffer.from(store.identityKeyPair.public,  'base64');
    const privRaw = Buffer.from(store.identityKeyPair.private, 'base64');
    const pub32   = pubRaw.length === 33 ? pubRaw.slice(1) : pubRaw;
    const priv32  = privRaw.length === 32 ? privRaw : privRaw.slice(0, 32);

    const ts      = Math.floor(Date.now() / 1000);
    const regId   = store.registrationId || 0;
    const details = _encodeADVDetails(regId, ts, 0);

    const acctMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, details, pub32]);
    const acctSig = Buffer.from(curve.sign(priv32, acctMsg));

    const devMsg  = Buffer.concat([WA_ADV_DEVICE_SIG_PREFIX, details, pub32, pub32]);
    const devSig  = Buffer.from(curve.sign(priv32, devMsg));

    const adv     = _encodeADVSignedIdentity(details, pub32, acctSig, devSig);
    store.advIdentity = adv;
    _whaDbg('[DBG] ADV_BUILT from primary iOS keys (' + adv.length + 'b)\n');
    return adv;
  } catch (e) {
    _whaDbg('[DBG] ADV_BUILD_ERR: ' + e.message);
    return null;
  }
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

function computePhash(jids) {
  const sorted = [...jids].sort();
  const hash = crypto.createHash('sha256').update(sorted.join('')).digest();
  return '2:' + hash.toString('base64').slice(0, 6);
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
    const upload = cdn ? cdn : await this._uploadMedia('image', imageData);
    const imgBuf = encodeMessage('image', encodeImageMessage({
      url:               upload.url,
      mimetype:          options.mimetype || upload.mimetype || guessMime(imageData, 'image/jpeg'),
      caption:           options.caption  || upload.caption || '',
      fileSha256:        upload.fileSha256,
      fileLength:        upload.fileLength || 0,
      height:            options.height   || upload.height || 0,
      width:             options.width    || upload.width  || 0,
      mediaKey:          upload.mediaKey,
      fileEncSha256:     upload.fileEncSha256,
      directPath:        upload.directPath,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      jpegThumbnail:     options.thumbnail || null,
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
    const upload = cdn ? cdn : await this._uploadMedia('video', videoData);
    const vidBuf = encodeMessage('video', encodeVideoMessage({
      url:               upload.url,
      mimetype:          options.mimetype || upload.mimetype || guessMime(videoData, 'video/mp4'),
      fileSha256:        upload.fileSha256,
      fileLength:        upload.fileLength || 0,
      seconds:           options.seconds   || upload.seconds || 0,
      mediaKey:          upload.mediaKey,
      caption:           options.caption   || upload.caption || '',
      height:            options.height    || upload.height  || 0,
      width:             options.width     || upload.width   || 0,
      fileEncSha256:     upload.fileEncSha256,
      directPath:        upload.directPath,
      mediaKeyTimestamp: upload.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      jpegThumbnail:     options.thumbnail  || null,
      gifPlayback:       options.gifPlayback || false,
      contextInfo:       options.contextInfo
    }));
    return this._sendMessage(toJid, msgId, vidBuf, 'media', { ...options, _mediaSubtype: 'video' });
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
      jpegThumbnail:     options.thumbnail || null,
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
    const stkBuf = encodeMessage('sticker', encodeStickerMessage({
      url:               upload.url,
      fileSha256:        upload.fileSha256,
      fileEncSha256:     upload.fileEncSha256,
      mediaKey:          upload.mediaKey,
      mimetype:          options.mimetype  || upload.mimetype || 'image/webp',
      height:            options.height    || upload.height   || 512,
      width:             options.width     || upload.width    || 512,
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
      encKey: opts.encKey || null
    });
    const pollBuf    = encodeMessage('poll', result.payload);
    const sendResult = await this._sendMessage(toJid, msgId, pollBuf, 'poll', Object.assign({}, opts, { _encKey: result.encKey }));
    return Object.assign({}, sendResult, { encKey: result.encKey });
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
      url:     opts.url     || ''
    }));
    return this._sendMessage(toJid, msgId, locBuf, 'location', opts);
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
    const conBuf = encodeMessage('contact', encodeContactMessage({ displayName, vcard }));
    return this._sendMessage(toJid, msgId, conBuf, 'contact', opts);
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
            mimetype: d.mimetype || 'image/jpeg', caption: d.caption || ''
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
            height: d.height || 0, width: d.width || 0
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
            title: d.fileName || 'file', fileName: d.fileName || 'file'
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
    if (isGroupJid(toJid)) {
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
            await this._clearSignalSessionsForRecipient(phoneFromJid(memberJid)).catch(() => {});
          }
          return this._sendGroupMessage(toJid, msgId, plaintext, mediaType,
            Object.assign({}, options, { _479retry: true }));
        }
        throw err;
      }
    }
    try {
      return await this._sendDMMessage(toJid, msgId, plaintext, mediaType, options);
    } catch (err) {
      // Same phash-mismatch retry for 1-to-1 messages.
      if (err && /\b421\b/.test(err.message)) {
        this._devMgr.clearCache([phoneFromJid(toJid)]);
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
        await this._clearSignalSessionsForRecipient(phoneFromJid(toJid));
        // CRITICAL: generate a NEW msgId — the server already ACK'd (with error=479)
        // the original ID and will close the connection if we re-send the same ID.
        const retryMsgId = generateMessageId();
        _whaDbg('[DBG] 479_RETRY new msgId=' + retryMsgId);
        return this._sendDMMessage(toJid, retryMsgId, plaintext, mediaType,
          Object.assign({}, options, { _479retry: true }));
      }
      // ─────────────────────────────────────────────────────────────────────────
      throw err;
    }
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

    // First, run the phone-based usync (and own devices) in parallel.
    // IMPORTANT: _pnToLid may be empty RIGHT NOW but gets populated during this
    // await — incoming messages from the recipient (which arrive while we wait
    // for the usync timeout) tell us their LID JID via from=LID + sender_pn attrs.
    // We therefore check _pnToLid AFTER this await, not before.
    const [_recipientDevicesByPhone, ownDevices] = await Promise.all([
      this._devMgr.bulkEnsureSessions([recipientPhone], this._signal, allowPkmsg),
      this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal, allowPkmsg)
    ]);

    // ── LID routing fix ───────────────────────────────────────────────────────
    // Check _pnToLid NOW — after the await above, incoming messages from the
    // recipient during the usync wait will have populated this map.
    // For LID-migrated accounts, the message `to` field AND Signal participants
    // must use the LID JID.  Phone-JID messages are silently accepted by the
    // server but never delivered to the recipient's LID-registered device.
    const lidUser      = this._client._pnToLid && this._client._pnToLid.get(recipientPhone);
    const routingToJid = lidUser ? `${lidUser}@lid` : toJid;

    _whaDbg('[DBG] DM_ROUTE phone=' + recipientPhone +
      ' routing=' + routingToJid + (lidUser ? ' (LID)' : ' (PN)'));

    let otherJids;
    if (lidUser) {
      // Fetch bundle + build Signal session for the LID JID.
      // skipUsync=true: we already know the LID from _pnToLid — skip a second
      // 15 s usync round-trip and go straight to bundle fetch (device 0 primary).
      const lidDevices = await this._devMgr.bulkEnsureSessionsForLid(
        lidUser, this._signal, allowPkmsg, /* skipUsync */ true);
      otherJids = lidDevices.length > 0 ? lidDevices : [routingToJid];
    } else {
      otherJids = _recipientDevicesByPhone.length > 0 ? _recipientDevicesByPhone : [toJid];
    }
    // ─────────────────────────────────────────────────────────────────────────

    const ownLinkedJids = ownDevices.filter(j => j !== ownMainJid);

    const allParticipants = [...otherJids, ...ownLinkedJids];
    const phash = allParticipants.length > 1 ? computePhash(allParticipants) : null;

    const dsmBuf = ownLinkedJids.length > 0
      ? encodeDeviceSentMessage(toJid, plaintext, phash)
      : null;

    // Acquire mutex before touching Signal sessions — concurrent sends on the
    // same session corrupt the ratchet chain and produce undecryptable messages.
    const [otherEncrypted, ownEncrypted] = await this._encryptMutex.runExclusive(async () => {
      const other = await this._signal.bulkEncryptForDevices(otherJids, plaintext);
      const own   = ownLinkedJids.length > 0
        ? await this._signal.bulkEncryptForDevices(ownLinkedJids, dsmBuf)
        : [];
      return [other, own];
    });

    const encryptedList = [...otherEncrypted, ...ownEncrypted];

    // Encode the routing JID as a binary JID object (JID_PAIR for @lid / @s.whatsapp.net).
    // Raw UTF-8 strings are not recognised by the server for LID recipients, causing
    // the message to be accepted (server ACK) but never delivered to the device.
    const stanzaAttrs = { to: jidStrToObj(routingToJid), id: msgId, type: mediaType, t: String(msNow()) };
    if (phash) stanzaAttrs.phash = phash;
    if (options.edit) stanzaAttrs.edit = String(options.edit);

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

    // ─── tcToken (error 463 / reachout timelock defense) ─────────────────────
    // WhatsApp counts every DM without a <tctoken> node as a "reaching out"
    // event. Once enough accumulate the server returns error 463 (timelock).
    // We attach the stored trusted-contact token when one exists and is valid.
    const tcStore = this._client._tcTokenStore;
    const tcJid   = normalizeJidForTcToken(routingToJid);
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
    if (this._client._sentMsgCache) {
      this._client._sentMsgCache.set(msgId, {
        plaintext, toJid, msgId, mediaType, options, recipientPhone
      });
      // Keep cache bounded — evict oldest entries beyond 200
      if (this._client._sentMsgCache.size > 200) {
        const firstKey = this._client._sentMsgCache.keys().next().value;
        this._client._sentMsgCache.delete(firstKey);
      }
    }

    const dispatchResult = await this._dispatchAndAck(msgNode, msgId);

    // ─── Fire-and-forget: issue privacy token to contact ─────────────────────
    // After each DM send we ask WhatsApp to issue us a trusted-contact token
    // for this JID (one issuance per 7-day bucket is enough).  The token is
    // stored and attached on future sends so the server does not count them
    // as anonymous "reaching out" events (which would trigger error 463).
    if (tcStore && tcStore.shouldIssue(tcJid) &&
        !this._client._inFlightTcTokenIssuance.has(tcJid)) {
      this._client._inFlightTcTokenIssuance.add(tcJid);
      const issueTs = Math.floor(Date.now() / 1000);
      this._client._issuePrivacyTokens(routingToJid, issueTs)
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

    // Auto-fetch group metadata if member cache is empty (first send to this group)
    let members = this._client._getGroupMembers(groupJid);
    if (members.length === 0 && typeof this._client.getGroupMetadata === 'function') {
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

    // Determine addressing mode for this group (lid = modern groups, pn = legacy)
    const groupAddressingMode = this._client._groupAddressingMode.get(groupJid) || 'lid';
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
    const myLidUser = useLid ? phoneFromJid(this._client._myLid) : null;
    // For LID-mode groups, sender identity is own LID JID; otherwise own PN JID.
    // Normalised to the bare user so it matches the participant targets below.
    const selfJid = useLid ? `${myLidUser}@lid` : ownJid;
    const senderIdentity = selfJid;

    const rawSKDM   = await this._signal.buildSKDM(groupJid, senderIdentity);
    const skdmMsg   = encodeSenderKeyDistributionMessage(groupJid, rawSKDM);

    // Resolve member phones for session/device queries.
    // For LID members without a PN mapping, keep the raw LID user part so
    // bulkEnsureSessionsForLid can still acquire sessions for them.
    const lidMembersWithoutPn = [];
    const memberPhones = [...new Set(
      members.map(jid => {
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
          // We are a member of the group ourselves, so our own devices come out
          // of this same walk — Baileys likewise derives every group target
          // from the participant list and never appends own devices separately.
          lidMembersWithoutPn.push(jid);
          return null;
        }
        return raw;
      }).filter(p => p !== null && p !== ownPhone)
    )];

    const [memberDevices, lidDevices, ownDevices] = await Promise.all([
      memberPhones.length > 0
        ? this._devMgr.bulkEnsureSessions(memberPhones, this._signal)
        : Promise.resolve([]),
      lidMembersWithoutPn.length > 0
        ? Promise.all(lidMembersWithoutPn.map(jid =>
            this._devMgr.bulkEnsureSessionsForLid(phoneFromJid(jid), this._signal)
              .catch(() => [])
          )).then(results => results.flat())
        : Promise.resolve([]),
      this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal)
    ]);

    // Own devices come back as @s.whatsapp.net — re-express them in LID space
    // so every target in a LID stanza shares one address family.  In LID mode
    // the participant walk above already covered us, so this only fills the gap
    // for legacy pn-addressed groups.
    const ownTargets = useLid ? [] : ownDevices;

    // Dedupe: a device reached through more than one path must still appear
    // exactly once in <participants>.
    const allTargets = [...new Set([...memberDevices, ...lidDevices, ...ownTargets])];

    const skStore        = this._signal.senderKeyStore;
    const existingSkdmMap = skStore.getSKDMMap(groupJid);
    // Same exclusions Baileys applies when choosing SenderKey recipients:
    // hosted (bot-side) users and device 99, which is a server placeholder
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
        skdmEncrypted = await this._signal.bulkEncryptForDevices(skdmRecipients, skdmMsg);
        skStore.markSKDMSent(groupJid, skdmRecipients);
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
      // Baileys applies the same extra attrs — mediatype included — to the
      // SenderKey participant nodes as to the skmsg, so an image sent to a
      // group carries mediatype on both. Passing null here left the SKDM
      // <enc> nodes unlabelled.
      msgContent.push(DeviceManager.buildParticipantsNode(skdmEncrypted, mediaSubtype));
    }
    const skmsgAttrs = { type: 'skmsg', v: '2' };
    if (mediaSubtype) skmsgAttrs.mediatype = mediaSubtype;
    msgContent.push(new BinaryNode('enc', skmsgAttrs, Buffer.isBuffer(skmsgCiphertext) ? skmsgCiphertext : Buffer.from(skmsgCiphertext)));

    // No phash on group stanzas. Baileys computes a participant hash only on
    // the 1:1 path; a group message carries id/to/type/addressing_mode and
    // nothing else. Sending a hash the server did not ask for — over a
    // participant set it derives itself from the group — is a way to have the
    // stanza rejected outright.
    const stanzaAttrs = {
      to: jidStrToObj(groupJid),
      id: msgId,
      type: mediaType,
      addressing_mode: groupAddressingMode,
      t:   String(msNow())
    };
    if (options.edit) stanzaAttrs.edit = String(options.edit);

    const msgNode = new BinaryNode('message', stanzaAttrs, msgContent);
    return this._dispatchAndAck(msgNode, msgId);
  }

  // ─── Dispatch and wait for ack ────────────────────────────────────────────
  //
  // Error 463 recovery (mirrors Baileys messages-recv.js inFlight463Recoveries):
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
  // block each other. Matches Baileys pattern exactly.

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
            const ackFrom = ackAttrs.from ? String(ackAttrs.from) : '';
            const tcJid   = normalizeJidForTcToken(
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

            client._issuePrivacyTokens(ackFrom || tcJid, issueTs)
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
            resolve({ id, t: ackAttrs && ackAttrs.t, status: 'sent' });
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
    return this._sendMessage(toJid, msgId, msgBuf, 'protocol', { ...opts, edit: editBit });
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
    return this._sendMessage(toJid, msgId, msgBuf, 'protocol', opts);
  }

  // ─── Utility: mark read, presence, receipt, ping ─────────────────────────

  markRead(jid, messageIds) {
    const ids    = Array.isArray(messageIds) ? messageIds : [messageIds];
    const toJid  = makeJid(jid);
    const extras = ids.slice(0, -1).map(id => new BinaryNode('item', { id }, null));
    this._socket.sendNode(new BinaryNode('receipt', {
      to:   toJid,
      type: 'read',
      id:   ids[ids.length - 1],
      t:    String(msNow())
    }, extras));
  }

  sendPresence(available) {
    this._socket.sendNode(new BinaryNode('presence', {
      name: (this._store && this._store.name) || 'User',
      type: available ? 'available' : 'unavailable'
    }, null));
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

  async _uploadMedia(mediaType, data) {
    if (this._isMediaConnExpired()) {
      await this._fetchMediaConn();
    }
    let buf;
    if (Buffer.isBuffer(data))         buf = data;
    else if (typeof data === 'string') buf = fs.readFileSync(data);
    else throw new Error('Media must be a Buffer or file path');
    // Force-refresh callback: invoked by uploadMedia when a CDN host rejects the
    // auth token mid-upload, so the retry runs with fresh credentials instead of
    // failing with "connection expired".
    const refreshAuth = async () => {
      await this._fetchMediaConn();
      return { hosts: this._mediaHosts, auth: this._mediaAuth };
    };
    return uploadMedia(mediaType, buf, this._mediaHosts, this._mediaAuth, refreshAuth);
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

module.exports = { MessageSender, makeJid, isGroupJid, generateMessageId, buildOrGetAdvIdentity: _buildOrGetAdvIdentity };
