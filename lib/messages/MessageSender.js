'use strict';

const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { BinaryNode }  = require('../BinaryNode');
const { DeviceManager } = require('../DeviceManager');
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
    process.stderr.write('[DBG] ADV_BUILT from primary iOS keys (' + adv.length + 'b)\n');
    return adv;
  } catch (e) {
    process.stderr.write('[DBG] ADV_BUILD_ERR: ' + e.message + '\n');
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
    this._client     = client;
    this._socket     = client._socket;
    this._store      = client._store;
    this._signal     = client._signal;
    this._devMgr     = client._devMgr;
    this._mediaHosts = [];
    this._mediaAuth  = '';
  }

  // Called by Client when media connection is established
  setMediaConnection(hosts, auth) {
    this._mediaHosts = hosts || [];
    this._mediaAuth  = auth  || '';
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
      throw err;
    }
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
    // Preserve the recipient's server: a `@lid` chat must stay LID-addressed,
    // otherwise device enumeration comes back on the wrong domain.
    const recipientTarget = toJid.endsWith('@lid')
      ? `${recipientPhone}@lid`
      : recipientPhone;
    const [recipientDevices, ownDevices] = await Promise.all([
      this._devMgr.bulkEnsureSessions([recipientTarget], this._signal, allowPkmsg),
      this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal, allowPkmsg)
    ]);

    const otherJids     = recipientDevices.length > 0 ? recipientDevices : [toJid];
    const ownLinkedJids = ownDevices.filter(j => j !== ownMainJid);

    const allParticipants = [...otherJids, ...ownLinkedJids];
    const phash = allParticipants.length > 1 ? computePhash(allParticipants) : null;

    const dsmBuf = ownLinkedJids.length > 0
      ? encodeDeviceSentMessage(toJid, plaintext, phash)
      : null;

    const [otherEncrypted, ownEncrypted] = await Promise.all([
      this._signal.bulkEncryptForDevices(otherJids, plaintext),
      ownLinkedJids.length > 0
        ? this._signal.bulkEncryptForDevices(ownLinkedJids, dsmBuf)
        : Promise.resolve([])
    ]);

    const encryptedList = [...otherEncrypted, ...ownEncrypted];

    const stanzaAttrs = { to: toJid, id: msgId, type: mediaType, t: String(msNow()) };
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

    const msgNode = new BinaryNode('message', stanzaAttrs, msgContent);

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

    return this._dispatchAndAck(msgNode, msgId);
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
      try {
        process.stderr.write('[DBG] GROUP_SEND auto-fetch metadata for ' + groupJid + '\n');
        await this._client.getGroupMetadata(groupJid);
        members = this._client._getGroupMembers(groupJid);
      } catch (_) {}
    }

    // Determine addressing mode for this group (lid = modern groups, pn = legacy)
    const groupAddressingMode = this._client._groupAddressingMode.get(groupJid) || 'lid';
    // For LID-mode groups, sender identity is own LID JID; otherwise own PN JID
    const senderIdentity = (groupAddressingMode === 'lid' && this._client._myLid)
      ? this._client._myLid
      : ownJid;

    const rawSKDM   = this._signal.buildSKDM(groupJid, senderIdentity);
    const skdmMsg   = encodeSenderKeyDistributionMessage(groupJid, rawSKDM);

    // Build the recipient list for the sender key.
    //
    // LID-addressed groups expose participants as `<user>@lid`, and many of
    // them have no PN mapping at all. Previously those members were dropped
    // entirely, so they never received the sender key and every message from
    // us showed as "waiting for this message" on their side. LID users are
    // directly addressable, so keep them as LIDs instead of requiring a PN.
    const ownLidUser = this._client._myLid
      ? String(this._client._myLid).split('@')[0].split(':')[0]
      : null;

    const memberTargets = [...new Set(
      members.map(jid => {
        const user = phoneFromJid(jid);
        // Skip ourselves — own devices are handled separately below.
        if (user === ownPhone || (ownLidUser && user === ownLidUser)) return null;
        // Preserve the server so LID members stay LID-addressed.
        return jid.endsWith('@lid') ? `${user}@lid` : user;
      }).filter(Boolean)
    )];

    const [memberDevices, ownDevices] = await Promise.all([
      memberTargets.length > 0
        ? this._devMgr.bulkEnsureSessions(memberTargets, this._signal)
        : Promise.resolve([]),
      this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal)
    ]);

    const allTargets = [...memberDevices, ...ownDevices];

    const phashTargets = allTargets.includes(ownJid)
      ? allTargets
      : [ownJid, ...allTargets];

    const skStore        = this._signal.senderKeyStore;
    const existingSkdmMap = skStore.getSKDMMap(groupJid);
    const skdmRecipients  = allTargets.filter(jid => !existingSkdmMap[jid]);

    let skdmEncrypted = [];
    if (skdmRecipients.length > 0) {
      skdmEncrypted = await this._signal.bulkEncryptForDevices(skdmRecipients, skdmMsg);
      skStore.markSKDMSent(groupJid, skdmRecipients);
    }

    const skmsgCiphertext = this._signal.senderKeyEncrypt(groupJid, senderIdentity, plaintext);
    const phash = phashTargets.length > 0 ? computePhash(phashTargets) : null;

    const skdmHasPkmsg = skdmEncrypted.some(e => e.type === 'pkmsg');
    const advBytes     = skdmHasPkmsg ? _buildOrGetAdvIdentity(this._client._store) : null;

    const msgContent = [];
    if (advBytes) {
      msgContent.push(new BinaryNode('device-identity', {}, advBytes));
    }
    if (skdmEncrypted.length > 0) {
      msgContent.push(DeviceManager.buildParticipantsNode(skdmEncrypted, null));
    }
    const skmsgAttrs = { type: 'skmsg', v: '2' };
    if (mediaSubtype) skmsgAttrs.mediatype = mediaSubtype;
    msgContent.push(new BinaryNode('enc', skmsgAttrs, Buffer.isBuffer(skmsgCiphertext) ? skmsgCiphertext : Buffer.from(skmsgCiphertext)));

    const stanzaAttrs = {
      to: groupJid,
      id: msgId,
      type: mediaType,
      addressing_mode: groupAddressingMode,
      t:   String(msNow())
    };
    if (phash) stanzaAttrs.phash = phash;
    if (options.edit) stanzaAttrs.edit = String(options.edit);

    const msgNode = new BinaryNode('message', stanzaAttrs, msgContent);
    return this._dispatchAndAck(msgNode, msgId);
  }

  // ─── Dispatch and wait for ack ────────────────────────────────────────────

  _dispatchAndAck(node, msgId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._client._pendingAcks.delete(msgId);
        // Resolve anyway — WA often doesn't ack immediately
        resolve({ id: msgId, status: 'sent' });
      }, 20000);

      this._client._pendingAcks.set(msgId, (ackAttrs) => {
        clearTimeout(timer);
        if (ackAttrs && ackAttrs.error) {
          reject(new Error('Send error ' + ackAttrs.error + ' for ' + msgId));
        } else {
          resolve({ id: msgId, t: ackAttrs && ackAttrs.t, status: 'sent' });
        }
      });

      try {
        this._socket.sendNode(node);
      } catch (err) {
        clearTimeout(timer);
        this._client._pendingAcks.delete(msgId);
        reject(err);
      }
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
    let buf;
    if (Buffer.isBuffer(data))         buf = data;
    else if (typeof data === 'string') buf = fs.readFileSync(data);
    else throw new Error('Media must be a Buffer or file path');

    // Ensure a fresh media connection before uploading (re-fetches when the
    // cached auth token is stale, which is what caused uploads to hang and
    // surface as "connection expired").
    await this._ensureMediaConn(false);

    try {
      return await uploadMedia(mediaType, buf, this._mediaHosts, this._mediaAuth);
    } catch (err) {
      // A failed upload is most often a dead auth token or a bad host — force
      // a fresh media connection and retry once, mirroring WA Web behaviour.
      await this._ensureMediaConn(true);
      return uploadMedia(mediaType, buf, this._mediaHosts, this._mediaAuth);
    }
  }

  // Pull a (fresh) media connection from the client and cache the hosts/auth.
  async _ensureMediaConn(forceGet) {
    if (typeof this._client.refreshMediaConn === 'function') {
      const conn = await this._client.refreshMediaConn(forceGet);
      if (conn && conn.hosts && conn.hosts.length) {
        this._mediaHosts = conn.hosts;
        this._mediaAuth  = conn.auth;
      }
      return;
    }
    // Fallback for older clients: event-based one-shot fetch.
    if (!forceGet && this._mediaHosts.length) return;
    await this._fetchMediaConn();
  }

  async _fetchMediaConn() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._client.removeListener('media_conn', onConn);
        reject(new Error('Timeout waiting for media connection'));
      }, 15000);
      const onConn = ({ hosts, auth }) => {
        clearTimeout(timeout);
        if (hosts && hosts.length) {
          this._mediaHosts = hosts;
          this._mediaAuth  = auth;
        }
        resolve();
      };
      this._client.once('media_conn', onConn);
      try { this._client._requestMediaConnection(); } catch (_) {}
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
