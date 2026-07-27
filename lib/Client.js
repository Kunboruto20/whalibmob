'use strict';

const { dbg: _whaDbg, configureLogger: _whaConfigLogger } = require('./logger');

const EventEmitter  = require('events');
const path          = require('path');
const crypto        = require('crypto');
const { NoiseSocket }     = require('./noise');
const { MessageSender, generateMessageId, makeJid, buildOrGetAdvIdentity } = require('./messages/MessageSender');
const { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, assertRegistrationKeys, fetchIosVersion, fetchWaVersion } = require('./Registration');
const { getDeviceConfig } = require('./DeviceConfig');
const { createNewStore, saveStore, loadStore, toSixParts, fromSixParts } = require('./Store');
const { BinaryNode }      = require('./BinaryNode');

// How many times a message may be re-sent in answer to retry receipts before
// the client stops. Each resend can itself draw retries, so this is what keeps
// an undecryptable message from turning into a flood.
const MAX_RETRY_RESENDS = 2;
const { NodeCache }       = require('@cacheable/node-cache');

// Group metadata cache lifetime — matches DeviceManager's device cache.
const GROUP_META_CACHE_TTL = '5m';
const { SignalProtocol }  = require('./signal/SignalProtocol');
const { DeviceManager, jidStrToObj } = require('./DeviceManager');
const {
  processHistorySyncNotification,
  decodeHistorySyncNotification,
  decodeAppStateSyncKeyShare,
  saveAppStateSyncKeys,
  HistorySyncType
} = require('./HistorySyncHandler');

// Status posts are messages addressed here.
const STATUS_BROADCAST_JID = 'status@broadcast';

// The two prefixes a call-link token is wrapped in, as WhatsApp Web uses them.
const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/';
const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/';

// whatsmeow's InviteLinkPrefix — the one prefix group invite codes are wrapped in.
const INVITE_LINK_PREFIX = 'https://chat.whatsapp.com/';

// The names privacy settings actually go by on the wire, and the friendly
// aliases this library has always accepted for them. whatsmeow's
// PrivacySettingType constants are the right-hand column.
const PRIVACY_NAME_ALIASES = {
  last_seen: 'last',            last: 'last',
  profile_picture: 'profile',   profile_pic: 'profile',    profile: 'profile',
  status: 'status',
  online: 'online',
  read_receipts: 'readreceipts', readreceipts: 'readreceipts',
  groups_add: 'groupadd',       group_add: 'groupadd',     groupadd: 'groupadd',
  call_add: 'calladd',          calladd: 'calladd',
  messages: 'messages',
  defense: 'defense',
  stickers: 'stickers'
};

// Wire name → the key it is reported under in the settings object.
const PRIVACY_WIRE_TO_KEY = {
  last:         'lastSeen',
  profile:      'profile',
  status:       'status',
  online:       'online',
  readreceipts: 'readReceipts',
  groupadd:     'groupAdd',
  calladd:      'callAdd',
  messages:     'messages',
  defense:      'defense',
  stickers:     'stickers'
};

// Reduce a JID to its bare user — whatsmeow's ToNonAD. Blocking, and anything
// else that names an account rather than one of its devices, wants this form.
function toNonAdJid(input) {
  const s      = String(input || '');
  const at     = s.indexOf('@');
  const user   = at >= 0 ? s.slice(0, at) : s;
  const server = at >= 0 ? s.slice(at + 1) : 's.whatsapp.net';
  const colon  = user.indexOf(':');
  return (colon >= 0 ? user.slice(0, colon) : user) + '@' + server;
}

// Accept a full invite URL or a bare code and return the code.
function stripInviteUrl(codeOrUrl) {
  return String(codeOrUrl || '')
    .trim()
    .replace(/^https?:\/\/chat\.whatsapp\.com\//i, '')
    .replace(/[?#].*$/, '')
    .trim();
}

const PING_INTERVAL_MS    = 25000;
const KEEPALIVE_INTERVAL  = 20000;
const RECONNECT_BACKOFF   = [1000, 2000, 4000, 8000, 15000, 30000];

// ─── Key helpers ──────────────────────────────────────────────────────────────

function intToBytes(n, byteLen) {
  const buf = Buffer.alloc(byteLen);
  for (let i = byteLen - 1; i >= 0; i--) { buf[i] = n & 0xff; n >>= 8; }
  return buf;
}

function stripKeyPrefix(key) {
  if (!key) return Buffer.alloc(32);
  const buf = Buffer.from(key);
  if (buf.length === 33 && buf[0] === 0x05) return buf.slice(1);
  return buf;
}

// Strip ADVSignedDeviceIdentity field 2 (accountSignatureKey) before sending in retry <keys>.
// Mirrors MessageSender.stripAdvSignatureKey — same proto-walk logic.
function _stripAdvField2(buf) {
  if (!buf || !buf.length) return buf;
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tagByte  = buf[i++];
    const fieldNum = tagByte >>> 3;
    const wireType = tagByte & 7;
    if (wireType === 2) {
      let len = 0, shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (fieldNum === 2) {
        i += len; // skip accountSignatureKey
      } else {
        out.push(tagByte);
        let l = len;
        while (l > 0x7f) { out.push((l & 0x7f) | 0x80); l >>>= 7; }
        out.push(l);
        for (let j = 0; j < len; j++) out.push(buf[i + j]);
        i += len;
      }
    } else {
      out.push(tagByte);
    }
  }
  return Buffer.from(out);
}

function findChild(node, desc) {
  if (!node || !Array.isArray(node.content)) return null;
  return node.content.find(c => c && c.description === desc) || null;
}

function findChildDeep(node, desc) {
  if (!node) return null;
  if (node.description === desc) return node;
  if (!Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const found = findChildDeep(child, desc);
    if (found) return found;
  }
  return null;
}

function getNodeContent(node) {
  if (!node) return null;
  if (Buffer.isBuffer(node.content)) return node.content;
  if (typeof node.content === 'string') return Buffer.from(node.content);
  return null;
}

function intFromBuf(buf) {
  if (!buf) return 0;
  let v = 0;
  for (const b of buf) v = (v << 8) | b;
  return v;
}

function toSignalKey(raw) {
  if (!raw) return null;
  if (raw.length === 33 && raw[0] === 0x05) return Buffer.from(raw);
  if (raw.length === 32) return Buffer.concat([Buffer.from([0x05]), raw]);
  return Buffer.from(raw);
}

// ─── WhalibmobClient ──────────────────────────────────────────────────────────

class WhalibmobClient extends EventEmitter {
  constructor(opts) {
    super();
    opts                = opts || {};
    this._store         = null;
    this._socket        = null;
    this._sender        = null;
    this._signal        = null;
    this._devMgr        = null;
    this._sessionDir    = opts.sessionDir || process.env.HOME + '/.waSession';
    this._pingTimer               = null;
    this._keepTimer               = null;
    this._connected     = false;
    this._reconnecting  = false;
    this._reconnectTry  = 0;
    this._hasConnectedOnce = false;   // true after first successful open; used to detect reconnects
    this._phoneNumber   = null;
    this._mediaConn     = null;
    this._pendingIqs       = new Map();   // id → resolve fn
    this._pendingAcks      = new Map();   // msgId → resolve fn
    // groupJid → parsed metadata.  Mirrors DeviceManager's device cache: a TTL
    // so membership changes we never saw a notification for still heal, plus
    // in-flight dedup so a burst of sends to the same group issues one IQ.
    this._groupMetaCache    = new NodeCache({ ttl: GROUP_META_CACHE_TTL });
    this._groupMetaInflight = new Map();  // groupJid → Promise<metadata>
    this._groupMembers     = new Map();   // groupJid → Set<memberJid>
    this._lidToPn          = new Map();   // LID user → phone number
    this._pnToLid          = new Map();   // phone number → LID user
    this._myLid            = null;        // own LID JID received from <success> node
    this._groupAddressingMode = new Map(); // groupJid → 'lid' | 'pn'
    this._retryPending     = new Map();   // msgId → {node, count, pkId}
    this._retryPreKeyIdx   = 0;           // rotating index, fallback when every prekey is reserved
    // keyIds handed out by unresolved retries — never advertise one twice, or
    // the second sender's pkmsg arrives after the key was consumed and deleted.
    this._retryAdvertisedPreKeys = new Set();
    this._appStateVersions = {};          // collectionName → version (int)
    this._sentMsgCache     = new Map();   // msgId → {plaintext, toJid, msgId, mediaType, options, recipientPhone}
    this._tcTokenStore            = null; // TcTokenStore — loaded in init()
    this._inFlightTcTokenIssuance = new Set(); // dedupe concurrent proactive issuePrivacyTokens per JID
    this._inFlight463Recoveries   = new Set(); // dedupe concurrent 463-triggered token issuances per JID (separate from proactive)
    // Blue-tick every message as it arrives. Set to false for whatsmeow's model,
    // where read is only ever sent by an explicit markRead() call.
    this.autoRead = opts.autoRead !== false;
    // Flipped by setOnline(). Delivery receipts sent while this is false carry
    // type="inactive", which the sender's app records but does not render.
    this._sendActiveReceipts = false;
    // Cached privacy settings, as whatsmeow caches them. Warmed after connect
    // and refreshed whenever the server reports a change; markRead reads it.
    this._privacySettings = null;
    if (opts.pino !== undefined) _whaConfigLogger(opts.pino);
  }

  get store()     { return this._store; }
  get sender()    { return this._sender; }
  get connected() { return this._connected; }

  // ─── Registration statics ─────────────────────────────────────────────────

  static async register(phoneNumber, opts) {
    return checkIfRegistered(phoneNumber, opts || {});
  }

  static async requestCode(phoneNumber, method, opts) {
    return requestSmsCode(phoneNumber, method || 'sms', opts || {});
  }

  static async confirmCode(phoneNumber, code, opts) {
    return verifyCode(phoneNumber, code, opts || {});
  }

  // ─── Connect ──────────────────────────────────────────────────────────────

  async connect(phoneNumber) {
    return this.init(phoneNumber);
  }

  async init(phoneNumber) {
    phoneNumber = String(phoneNumber).replace(/\D/g, '');
    this._phoneNumber = phoneNumber;

    const sessionFile = path.join(this._sessionDir, `${phoneNumber}.json`);
    this._store = loadStore(sessionFile);
    if (!this._store) {
      throw new Error(`No session for ${phoneNumber}. Run 'wa registration -R <code>' first.`);
    }

    const signalFile  = path.join(this._sessionDir, `${phoneNumber}.signal.json`);
    const skFile      = path.join(this._sessionDir, `${phoneNumber}.sk.json`);
    const tcTokenFile = path.join(this._sessionDir, `${phoneNumber}.tctoken.json`);

    const { TcTokenStore } = require('./messages/TcTokenStore');
    this._tcTokenStore = new TcTokenStore(tcTokenFile);

    this._signal = SignalProtocol.fromStore(this._store, signalFile, skFile);
    this._devMgr = new DeviceManager(this);
    this._devMgr.attachSession(this._sessionDir, phoneNumber);

    // Restore LID ↔ phone mappings persisted from previous sessions.
    // This ensures we can route to LID JIDs even on fresh connections where no
    // incoming message has yet populated _pnToLid during this session.
    const persistedLid = this._signal.store.getLidMappings
      ? this._signal.store.getLidMappings() : {};
    for (const [phone, lid] of Object.entries(persistedLid)) {
      this._pnToLid.set(phone, lid);
      this._lidToPn.set(lid, phone);
    }
    _whaDbg('[DBG] LID_RESTORED count=' + Object.keys(persistedLid).length);

    await this._connectSocket();
    return this;
  }

  async _connectSocket() {
    const socket = new NoiseSocket(this._store);
    this._socket = socket;

    // Recreate sender with updated socket reference
    this._sender = new MessageSender(this);

    socket.on('open',  (sn)  => this._onOpen(sn));
    socket.on('node',  node  => this._onNode(node));
    socket.on('close', ()    => this._onClose());
    socket.on('error', err   => this.emit('error', err));

    // Pass reconnect attempt count into the Noise handshake ClientPayload
    this._store.connectAttemptCount = this._reconnectTry;
    await socket.connect();
    return socket;
  }

  disconnect() {
    this._reconnecting = false;
    this._reconnectTry = 0;
    this._stopTimers();
    if (this._socket) {
      try { this._socket.close(); } catch (_) {}
      this._socket = null;
    }
    this._connected = false;
    this.emit('close');
  }

  // ─── Reconnection ─────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const delay = RECONNECT_BACKOFF[Math.min(this._reconnectTry, RECONNECT_BACKOFF.length - 1)];
    this._reconnectTry++;
    this.emit('reconnecting', { delay, attempt: this._reconnectTry });

    setTimeout(async () => {
      if (!this._reconnecting) return;
      try {
        await this._connectSocket();
        this._reconnecting = false;
        this._reconnectTry = 0;
        this.emit('reconnected');
      } catch (err) {
        this._reconnecting = false;
        this._scheduleReconnect();
      }
    }, delay);
  }

  // ─── Connection events ────────────────────────────────────────────────────

  _onOpen(successNode) {
    this._connected = true;
    this._startTimers();

    // ── Feature 1: Parse <success> node ──────────────────────────────────────
    // Extract ADVSignedDeviceIdentity, platform, and other account info that
    // the server provides on each successful authentication.
    this._parseSuccessNode(successNode);

    // ── Feature 3 (part A): Send <active> IQ ─────────────────────────────────
    // WhatsApp opens sessions as "passive" — the client must explicitly
    // activate the connection before the server will deliver messages.
    this._sendActiveIq();

    // ── Feature 3 (part B): Send <presence type="available"> ─────────────────
    // This presence node is sent immediately after <success>.
    // Without it, WhatsApp never pushes incoming messages.
    this.setOnline(true);

    this._requestMediaConnection();
    this._uploadPreKeys();

    // Warm the privacy settings so read receipts respect them from the first
    // message rather than from whenever something first asks for them.
    this.queryPrivacySettings({ force: true }).catch(err =>
      _whaDbg('[DBG] PRIVACY_FETCH_FAILED ' + (err && err.message)));

    // ── Reconnect: flush stale device cache + background re-usync ─────────────
    // On first connect _hasConnectedOnce is false — nothing extra to do.
    // On every reconnect (network drop / NAT reset / server restart) we flush the
    // in-memory device cache because contacts may have linked or unlinked devices
    // while we were offline.  Disk files are kept for next restart warm-read;
    // in-memory entries are cleared so the next send triggers a fresh usync IQ.
    if (this._hasConnectedOnce && this._devMgr) {
      const phonesInCache = Object.keys(this._devMgr._cacheSnapshot || {});
      _whaDbg('[DBG] RECONNECT: flushing device cache (' + phonesInCache.length + ' entries) for fresh usync');
      this._devMgr._dcFlush();

      // Immediately re-usync own devices in the background (tablets / linked devices
      // could have been added or unlinked while we were offline).
      if (this._store && this._store.phoneNumber && this._signal) {
        const ownPhone = this._store.phoneNumber;
        setImmediate(() => {
          if (!this._connected || !this._devMgr) return;
          this._devMgr.ensureOwnDeviceSessions(ownPhone, this._signal, false)
            .then(() => _whaDbg('[DBG] RECONNECT own-device usync done'))
            .catch(e  => _whaDbg('[DBG] RECONNECT own-device usync err: ' + e.message));
        });
      }
    }
    this._hasConnectedOnce = true;

    this.emit('connected');
  }

  // ── Feature 1: Parse the <success> node ────────────────────────────────────
  //
  // The <success> node from WhatsApp contains:
  //   attrs.platform  — server-reported client platform
  //   attrs.lid       — linked-device ID (for multi-device)
  //   child <device-identity> — raw ADVSignedDeviceIdentity protobuf bytes
  //
  // ADVSignedDeviceIdentity fields (all bytes / wire type 2):
  //   1: details             — ADVDeviceIdentityDetails proto
  //   2: accountSignatureKey — 32-byte public key (we strip this when sending)
  //   3: accountSignature    — 64-byte Ed25519 signature
  //   4: deviceSignature     — 64-byte Ed25519 signature (empty on primary)
  //
  // We persist the bytes so device_identity nodes can be attached to pkmsg
  // stanzas on every subsequent send — even after a reconnect.
  _parseSuccessNode(node) {
    if (!node) return;
    const attrs = node.attrs || {};
    // Debug: log the full success node structure
    _whaDbg('[DBG] SUCCESS node attrs=' + JSON.stringify(attrs));
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (child && child.description) {
          _whaDbg('[DBG] SUCCESS child tag=' + child.description + ' attrs=' + JSON.stringify(child.attrs || {}));
        }
      }
    }
    if (attrs.platform) this._platform = attrs.platform;
    if (attrs.lid) {
      this._myLid = String(attrs.lid);
      // Record our own PN ↔ LID pair alongside every contact's. Prekey bundles
      // are only ever answered for phone JIDs, so opening a session with one of
      // our own LID-addressed linked devices needs this mapping just as much as
      // a contact's does — without it the bundle IQ goes out addressed to @lid
      // and is never answered.
      const ownLidUser = this._myLid.split('@')[0].split(':')[0];
      const ownPnUser  = String(this._store && this._store.phoneNumber || '');
      if (ownLidUser && ownPnUser) {
        this._lidToPn.set(ownLidUser, ownPnUser);
        this._pnToLid.set(ownPnUser, ownLidUser);
        if (this._signal && this._signal.store && this._signal.store.setLidMapping) {
          this._signal.store.setLidMapping(ownPnUser, ownLidUser);
        }
      }
    }

    const devIdNode = findChild(node, 'device-identity');
    if (devIdNode) {
      const bytes = getNodeContent(devIdNode);
      if (bytes && bytes.length > 0) {
        this._store.advIdentity = bytes;
        // Persist to session file so it survives restart
        const sessionFile = path.join(
          this._sessionDir,
          `${this._store.phoneNumber}.json`
        );
        try {
          const { saveStore } = require('./Store');
          saveStore(this._store, sessionFile);
        } catch (_) {}
      }
    } else if (this._store.advIdentity) {
      // Already have it persisted from a previous session — keep using it
    }
  }

  // ── Feature 3 (part A): Activate the connection ────────────────────────────
  //
  // WhatsApp starts every Noise session in "passive" mode.  The client must
  // send this IQ to become "active" so the server starts delivering messages.
  _sendActiveIq() {
    if (!this._socket) return;
    const id = this._genMsgId();
    _whaDbg('[DBG] SEND active IQ id=' + id);
    this._socket.sendNode(new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'passive'
    }, [new BinaryNode('active', {}, null)]));
  }

  // ── Feature 3 (part B): Handle <ib> dirty-state notifications ──────────────
  //
  // After login the server sends <ib><dirty type="account_sync"…/></ib> to
  // tell the client that its app state is stale.  We respond with a sync IQ
  // for each dirty collection.  We track the version number for each
  // collection in _appStateVersions so we don't repeatedly request version 0.
  _handleIb(node) {
    const children = Array.isArray(node.content) ? node.content : [];

    const dirtyTypes = [];
    for (const child of children) {
      if (!child || child.description !== 'dirty') continue;
      const type = child.attrs && child.attrs.type;
      if (type) dirtyTypes.push(type);
    }

    if (dirtyTypes.length > 0) {
      this._sendAppStateSyncForTypes(dirtyTypes);
    }

    this.emit('ib', { node });
  }

  // ── Feature 3 (part C): Send an app-state-sync IQ ──────────────────────────
  //
  // Maps WhatsApp dirty-type names → the actual collection names used in the
  // sync IQ.  We use return_snapshot=true on the first request (version 0) so
  // the server sends a full snapshot; subsequent requests use the stored
  // version and return_snapshot=false (incremental patches only).
  //
  // We do NOT decrypt the patches — that requires the full LTHASH machinery.
  // We DO update our version counters from the server response so that we
  // never re-request the same snapshot twice.
  _sendAppStateSyncForTypes(dirtyTypes) {
    if (!this._socket || !this._connected) return;

    // Only these are valid WhatsApp app-state collections.
    // Other dirty types (e.g. "groups") use different IQs and must be ignored here.
    const COLLECTION_MAP = {
      account_sync:        ['critical_block', 'critical_unblock_low', 'regular_low', 'regular_high', 'regular'],
      critical_block:      ['critical_block'],
      critical_unblock_low:['critical_unblock_low'],
      regular_low:         ['regular_low'],
      regular_high:        ['regular_high'],
      regular:             ['regular']
    };

    const collections = new Set();
    for (const type of dirtyTypes) {
      const mapped = COLLECTION_MAP[type];
      if (!mapped) {
        _whaDbg('[DBG] ignoring unknown dirty type: ' + type);
        continue;
      }
      for (const c of mapped) collections.add(c);
    }

    if (collections.size === 0) return;

    const id = this._genMsgId();
    const collectionNodes = [...collections].map(name => {
      const version = String(this._appStateVersions[name] || 0);
      return new BinaryNode('collection', {
        name,
        version,
        return_snapshot: 'false'
      }, null);
    });

    _whaDbg('[DBG] SEND appStateSync IQ id=' + id + ' collections=' + [...collections].join(','));
    this._socket.sendNode(new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:sync:app:state'
    }, [new BinaryNode('sync', {}, collectionNodes)]));

    // When the server replies, update our version numbers so future syncs
    // request incremental patches rather than a full snapshot.
    this._pendingIqs.set(id, (resp) => {
      if (!resp || !Array.isArray(resp.content)) return;
      const syncNode = findChild(resp, 'sync');
      if (!syncNode || !Array.isArray(syncNode.content)) return;
      for (const colNode of syncNode.content) {
        if (!colNode || colNode.description !== 'collection') continue;
        const colAttrs = colNode.attrs || {};
        if (colAttrs.name && colAttrs.version !== undefined) {
          this._appStateVersions[colAttrs.name] = parseInt(colAttrs.version, 10) || 0;
        }
      }
    });
  }

  _onClose() {
    this._connected = false;
    this._stopTimers();
    this._socket = null;   // clear dead reference — prevents accidental sends before reconnect
    this.emit('disconnected');

    // Reject all pending IQs / acks
    for (const [, resolve] of this._pendingIqs) {
      resolve(null);
    }
    this._pendingIqs.clear();

    for (const [, resolve] of this._pendingAcks) {
      resolve({ error: 'disconnected' });
    }
    this._pendingAcks.clear();

    this._scheduleReconnect();
  }

  // ─── Timers ───────────────────────────────────────────────────────────────

  _startTimers() {
    this._pingTimer = setInterval(() => {
      if (this._sender && this._connected) this._sender.ping();
    }, PING_INTERVAL_MS);

    this._keepTimer = setInterval(() => {
      if (this._socket && this._connected) {
        this._socket.sendNode(new BinaryNode('iq', {
          id:    this._genMsgId(),
          to:    's.whatsapp.net',
          type:  'get',
          xmlns: 'w:p'
        }, [new BinaryNode('ping', {}, null)]));
      }
    }, KEEPALIVE_INTERVAL);
  }

  _stopTimers() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._keepTimer) { clearInterval(this._keepTimer); this._keepTimer = null; }
  }

  // ─── Node dispatch ────────────────────────────────────────────────────────

  _onNode(node) {
    if (!node || !node.description) return;
    const tag = node.description;
    // Debug: log every node received
    _whaDbg('[DBG] _onNode tag=' + tag + ' attrs=' + JSON.stringify(node.attrs || {}));
    if (tag === 'iq' && node.attrs && node.attrs.type === 'error') {
      try { _whaDbg('[DBG] IQ_ERROR content=' + JSON.stringify(node.content)); } catch(_) {}
    }

    if      (tag === 'iq')           this._handleIq(node);
    else if (tag === 'message')      this._handleMessage(node);
    else if (tag === 'receipt')      this._handleReceipt(node);
    else if (tag === 'ack')          this._handleAck(node);
    else if (tag === 'notification') this._handleNotification(node);
    else if (tag === 'presence')     this._handlePresence(node);
    else if (tag === 'call')         this._handleCall(node);
    else if (tag === 'ib')           this._handleIb(node);
    else if (tag === 'success')      this.emit('session_refresh', { node }); // late success (re-auth)
    else if (tag === 'failure')      this._handleFailure(node);
    else if (tag === 'stream:error') this.emit('stream_error', { reason: node.attrs && node.attrs.reason });
    else                             this.emit('node', node);
  }

  // ─── IQ handling ──────────────────────────────────────────────────────────

  _handleIq(node) {
    const id    = node.attrs && node.attrs.id;
    const type  = node.attrs && node.attrs.type;
    const xmlns = node.attrs && node.attrs.xmlns;

    // Resolve pending IQ
    if (id) {
      const handler = this._pendingIqs.get(id);
      if (handler) {
        this._pendingIqs.delete(id);
        handler(node);
        return;
      }
    }

    // Media connection result
    if (type === 'result' && xmlns === 'w:m') {
      this._onMediaConnectionResult(node);
    }

    // Pre-key upload ack — could also replenish
    if (type === 'result' && xmlns === 'encrypt') {
      this._checkAndReplenishPreKeys();
    }

    this.emit('iq', { id, type, xmlns, node });
  }

  // ─── Message handling ─────────────────────────────────────────────────────

  async _handleMessage(node) {
    const attrs = node.attrs || {};
    const fromRaw = attrs.from  || null;
    const partRaw = attrs.participant || null;
    const from  = String(attrs.from  || '');
    const id    = String(attrs.id    || '');
    const ts    = parseInt(attrs.t || '0', 10);
    const participant = String(attrs.participant || from);
    const senderPn = attrs.sender_pn ? String(attrs.sender_pn) : null;
    if (senderPn) {
      const lidUser = from.split('@')[0].split(':')[0];
      const pnUser  = senderPn.split('@')[0].split(':')[0];
      if (lidUser && pnUser && lidUser !== pnUser) {
        this._lidToPn.set(lidUser, pnUser);
        this._pnToLid.set(pnUser, lidUser);
        // Persist so the mapping survives reconnects / process restarts
        if (this._signal && this._signal.store && this._signal.store.setLidMapping) {
          this._signal.store.setLidMapping(pnUser, lidUser);
        }
      }
    }
    _whaDbg('[DBG] _handleMessage from=' + from + ' participant=' + participant + ' senderPn=' + senderPn + ' id=' + id);
    if (Array.isArray(node.content)) {
      for (const c of node.content) {
        if (c && c.description) {
          _whaDbg('[DBG] MSG_CHILD tag=' + c.description + ' attrs=' + JSON.stringify(c.attrs || {}) + ' contentLen=' + (Buffer.isBuffer(c.content) ? c.content.length : (typeof c.content === 'string' ? c.content.length : 0)));
        }
      }
    }

    const isGroup = from.endsWith('@g.us');

    const encNodes = Array.isArray(node.content)
      ? node.content.filter(c => c && c.description === 'enc')
      : [];

    const participantsNode = findChild(node, 'participants');

    const skmsgNode = encNodes.find(n => n.attrs && n.attrs.type === 'skmsg');

    let dmEncNode = encNodes.find(n => n.attrs && (n.attrs.type === 'msg' || n.attrs.type === 'pkmsg'));

    if (!dmEncNode && participantsNode && Array.isArray(participantsNode.content)) {
      for (const toNode of participantsNode.content) {
        if (!toNode || toNode.description !== 'to') continue;
        const toJid = toNode.attrs && toNode.attrs.jid;
        if (!toJid) continue;
        const toPhone = toJid.split('@')[0].split(':')[0];
        if (toPhone === this._store.phoneNumber) {
          const enc = findChild(toNode, 'enc');
          if (enc) {
            dmEncNode = enc;
            break;
          }
        }
      }
    }

    if (skmsgNode && isGroup) {
      this._sendMessageAck(id, fromRaw, partRaw);
      this._sendDeliveryReceipt(id, fromRaw, partRaw);
      // SKDM must be processed (awaited) before we attempt skmsg decryption,
      // because the first message from a sender always bundles both together.
      if (participantsNode) {
        await this._processSKDMDistribution(from, participant, participantsNode);
      }
      this._decryptGroupMessage({ node, from, participant, fromRaw, partRaw, id, ts, skmsgNode });
      return;
    }

    if (dmEncNode && this._signal) {
      this._sendMessageAck(id, fromRaw, partRaw);
      this._sendDeliveryReceipt(id, fromRaw, partRaw);
      this._decryptDMMessage({ node, from, participant, fromRaw, partRaw, senderPn, id, ts, dmEncNode });
      return;
    }

    const bodyNode = findChild(node, 'body');
    const text = bodyNode ? (
      Buffer.isBuffer(bodyNode.content)
        ? bodyNode.content.toString('utf8')
        : (bodyNode.content || null)
    ) : null;

    this._sendMessageAck(id, fromRaw, partRaw);
    this._sendDeliveryReceipt(id, fromRaw, partRaw);
    this.emit('message', { id, from, participant, ts, text, node });
    this._sendReadReceipt(id, fromRaw, partRaw);
  }

  _decryptDMMessage({ node, from, participant, fromRaw, partRaw, senderPn, id, ts, dmEncNode }) {
    const encType   = dmEncNode.attrs && dmEncNode.attrs.type;
    const cipherBuf = Buffer.isBuffer(dmEncNode.content)
      ? dmEncNode.content
      : Buffer.from(dmEncNode.content || '');

    // WhatsApp LID migration: `from` may be a LID (linked identity) instead of a real phone number
    // not the phone-based JID. The Signal session is stored under the phone-based JID.
    // Use sender_pn (phone JID) when available, otherwise fall back to participant/from.
    const sigJid = senderPn
      || ((participant && participant !== from) ? participant : from);

    _whaDbg('[DBG] DM_DECRYPT id=' + id + ' type=' + encType + ' sigJid=' + sigJid + ' cipherLen=' + cipherBuf.length);

    this._signal.decrypt(sigJid, encType, cipherBuf)
      .then(async plaintext => {
        this._resolveRetry(id);
        const decoded = this._decodeMsg(plaintext);
        _whaDbg('[DBG] DM_DECODED id=' + id + ' type=' + decoded.type + ' ptLen=' + (plaintext ? plaintext.length : 0) + ' hasSKDM=' + !!(decoded.skdm || decoded.type === 'senderKeyDistribution'));

        // Process embedded SKDM when bundled with a real message (WhatsApp MD always does this
        // on the first message of a new session, even for 1-on-1 DMs).
        // axolotlBytes may be absent in newer WA proto versions — that's OK for DM pkmsg flow.
        if (decoded.skdm && decoded.skdm.axolotlBytes && decoded.skdm.axolotlBytes[0] === 0x33) {
          try {
            await this._signal.processSKDM(decoded.skdm.groupId, sigJid, decoded.skdm.axolotlBytes);
            _whaDbg('[DBG] SKDM_PROCESSED groupId=' + decoded.skdm.groupId + ' sender=' + sigJid);
          } catch (e) {
            _whaDbg('[DBG] SKDM_ERR ' + e.message);
          }
        }

        // SKDM-only message (no real content) — ACK and move on
        if (decoded.type === 'senderKeyDistribution') {
          if (decoded.axolotlBytes && decoded.axolotlBytes[0] === 0x33) {
            try {
              await this._signal.processSKDM(decoded.groupId, sigJid, decoded.axolotlBytes);
              _whaDbg('[DBG] SKDM_ONLY_PROCESSED groupId=' + decoded.groupId + ' sender=' + sigJid);
            } catch (e) {
              _whaDbg('[DBG] SKDM_ONLY_ERR ' + e.message);
            }
          }
          this._sendReadReceipt(id, fromRaw, partRaw);
          return;
        }

        // Protocol messages — handle history sync and app-state key share before dropping
        if (decoded.type === 'protocol') {
          _whaDbg('[DBG] PROTO subtype=' + decoded.subtype + ' id=' + id);

          // ── HISTORY_SYNC_NOTIFICATION ─────────────────────────────────────
          if (decoded.subtype === 'history_sync' && decoded.historySyncNotification) {
            this._handleHistorySync(decoded.historySyncNotification, id);
          }

          // ── APP_STATE_SYNC_KEY_SHARE ──────────────────────────────────────
          if (decoded.subtype === 'app_state_sync_key_share' && decoded.appStateSyncKeyShare) {
            this._handleAppStateSyncKeyShare(decoded.appStateSyncKeyShare);
          }

          return;
        }

        this.emit('message', { id, from, participant, ts, decoded, node });
        this._sendReadReceipt(id, fromRaw, partRaw);

        // ── pkmsg = peer opened a new Signal session (identity/device change) ──
        // Re-issue our tcToken to them so the fresh session carries a valid token.
        // Mirrors Baileys' reissueTcTokenAfterIdentityChange (messages-recv.js).
        if (encType === 'pkmsg' && this._tcTokenStore) {
          this._reissueTcTokenAfterIdentityChange(sigJid);
        }
      })
      .catch(err => {
        _whaDbg('[DBG] DM_ERR id=' + id + ' err=' + (err && err.message));
        this.emit('decrypt_error', { id, from, participant, err });
        this._sendRetryRequest(id, node);
      });
  }

  _decryptGroupMessage({ node, from, participant, fromRaw, partRaw, id, ts, skmsgNode }) {
    const cipherBuf = Buffer.isBuffer(skmsgNode.content)
      ? skmsgNode.content
      : Buffer.from(skmsgNode.content || '');

    this._signal.senderKeyDecrypt(from, participant, cipherBuf)
      .then(plaintext => {
        this._resolveRetry(id);
        const decoded = this._decodeMsg(plaintext);
        if (decoded.type === 'senderKeyDistribution') return;
        if (decoded.type === 'protocol') {
          if (decoded.subtype === 'history_sync' && decoded.historySyncNotification) {
            this._handleHistorySync(decoded.historySyncNotification, id);
          }
          if (decoded.subtype === 'app_state_sync_key_share' && decoded.appStateSyncKeyShare) {
            this._handleAppStateSyncKeyShare(decoded.appStateSyncKeyShare);
          }
          return;
        }
        this.emit('message', { id, from, participant, ts, decoded, isGroup: true, node });
        this._sendReadReceipt(id, fromRaw, partRaw);
      })
      .catch(err => {
        _whaDbg('[DBG] GROUP_ERR id=' + id + ' from=' + from +
          ' participant=' + participant + ' err=' + (err && err.message));
        this.emit('decrypt_error', { id, from, participant, err });
        // Ask the sender to re-send with a fresh SenderKey distribution.
        // Without this a group we joined after the sender distributed its key
        // — or any group whose SKDM we missed — stays permanently
        // undecryptable, failing every message with "No session found to
        // decrypt message".  The DM path already does this; groups need it
        // just as much, and the retry must be addressed to the participant
        // that actually encrypted the message, not to the group JID.
        this._sendRetryRequest(id, node);
      });
  }

  _decodeMsg(buf) {
    try {
      const { decodeMessageContainer } = require('./proto/MessageProto');
      return decodeMessageContainer(buf);
    } catch (_) {
      return { type: 'unknown' };
    }
  }

  // Process SKDM messages in participants node.
  // Returns a Promise that resolves when all SKDM decryption+storage is done.
  // Must be awaited before attempting skmsg decryption so the SenderKey state
  // is available when the group cipher runs.
  async _processSKDMDistribution(groupJid, senderJid, participantsNode) {
    if (!Array.isArray(participantsNode.content)) return;
    const ownPhone   = String(this._store.phoneNumber);
    const ownLidUser = this._myLid ? this._myLid.split('@')[0].split(':')[0] : null;

    const tasks = [];

    for (const toNode of participantsNode.content) {
      if (!toNode || toNode.description !== 'to') continue;
      const toJid = toNode.attrs && toNode.attrs.jid;
      if (!toJid) continue;
      const toUser = String(toJid).split('@')[0].split(':')[0];
      const isForUs = (toUser === ownPhone) || (ownLidUser && toUser === ownLidUser);
      if (!isForUs) continue;

      const enc = findChild(toNode, 'enc');
      if (!enc) continue;

      const encType   = enc.attrs && enc.attrs.type;
      const cipherBuf = Buffer.isBuffer(enc.content) ? enc.content : Buffer.from(enc.content || '');

      tasks.push(
        this._signal.decrypt(senderJid, encType, cipherBuf)
          .then(async decrypted => {
            const decoded = this._decodeMsg(decrypted);
            if (decoded && decoded.type === 'senderKeyDistribution' &&
                decoded.groupId && decoded.axolotlBytes) {
              await this._signal.processSKDM(decoded.groupId, senderJid, decoded.axolotlBytes);
            } else if (decoded && decoded.skdm &&
                       decoded.skdm.groupId && decoded.skdm.axolotlBytes) {
              await this._signal.processSKDM(decoded.skdm.groupId, senderJid, decoded.skdm.axolotlBytes);
            }
          })
          .catch(() => {})
      );
    }

    await Promise.all(tasks);
  }

  // ─── Receipt / ack ────────────────────────────────────────────────────────

  _handleReceipt(node) {
    const attrs = node.attrs || {};
    this.emit('receipt', {
      id:   attrs.id   ? String(attrs.id) : '',
      from: attrs.from ? String(attrs.from) : '',
      type: attrs.type ? String(attrs.type) : ''
    });
    // ACK the receipt back to server (include type so server clears from offline queue)
    if (this._socket && this._connected) {
      const ackAttrs = {
        id:    attrs.id || '',
        class: 'receipt',
        to:    attrs.from || ''
      };
      if (attrs.type) ackAttrs.type = String(attrs.type);
      if (attrs.participant) ackAttrs.recipient = String(attrs.participant);
      this._socket.sendNode(new BinaryNode('ack', ackAttrs, null));
    }
    // If the recipient couldn't decrypt our message, re-send with fresh Signal session
    if (String(attrs.type || '') === 'retry') {
      this._handleRetryFromRecipient(attrs);
    }
  }

  _handleRetryFromRecipient(attrs) {
    const msgId = String(attrs.id || '');
    const cached = this._sentMsgCache && this._sentMsgCache.get(msgId);
    if (!cached || !this._sender) {
      _whaDbg('[DBG] RETRY_RECV msgId=' + msgId + ' — no cached plaintext, skipping resend\n');
      return;
    }

    // Consume the entry before doing anything else. Every device that failed to
    // decrypt sends its own retry receipt for the same message, and a group
    // resend already re-addresses all of them — without this, each receipt
    // started its own resend.
    this._sentMsgCache.delete(msgId);

    // Bound the chain. A resend that still cannot be decrypted draws fresh
    // retry receipts of its own, so an unbounded handler answers each one with
    // another send and floods the chat. Give up after a few rounds and leave
    // the message undelivered rather than keep spamming.
    const depth = (cached.retryDepth || 0) + 1;
    if (depth > MAX_RETRY_RESENDS) {
      _whaDbg('[DBG] RETRY_RECV msgId=' + msgId + ' — giving up after ' +
        cached.retryDepth + ' resends\n');
      return;
    }

    const fromStr = attrs.from ? String(attrs.from) : '';
    const isGroup = fromStr.endsWith('@g.us');

    // On a group retry `from` is the group and `participant` is the device that
    // failed to decrypt. Keying off `from` there would have targeted the group
    // id as if it were a contact and cleared nothing.
    const targetJid = isGroup && attrs.participant
      ? String(attrs.participant)
      : fromStr;
    const recipientPhone = targetJid.split('@')[0].split(':')[0].split('.')[0];

    _whaDbg('[DBG] RETRY_RECV msgId=' + msgId + ' from=' + fromStr + ' — clearing session + resending\n');

    // Delete all Signal sessions for the recipient's devices so next send creates fresh pkmsg
    const sigStore = this._signal && this._signal.store;
    if (sigStore && sigStore._sessions) {
      const sessions = sigStore._sessions;
      Object.keys(sessions).forEach(addr => {
        if (addr.startsWith(recipientPhone + '.')) {
          _whaDbg('[DBG] RETRY deleting session for ' + addr);
          delete sessions[addr];
        }
      });
    }

    // Clear device manager cache so we re-fetch devices on next send
    if (this._devMgr) {
      this._devMgr.clearCache([recipientPhone]);
    }

    // Re-send the message — will create fresh pre-key (pkmsg) sessions.
    // A group resend must go back through the group path: it needs a fresh
    // SenderKey distribution, which only _sendGroupMessage builds. Drop the
    // "already distributed" record first, or the resend would carry the same
    // bare skmsg the recipient just told us it could not read.
    // Carry the round count into the resend so its own retry receipts continue
    // the same chain instead of restarting it at zero.
    const opts = Object.assign({}, cached.options, { _retryDepth: depth });

    if (cached.isGroup) {
      const resendId = generateMessageId();
      if (this._signal && this._signal.senderKeyStore) {
        this._signal.senderKeyStore.invalidateSKDM(cached.toJid);
      }
      _whaDbg('[DBG] RETRY_RESEND group round=' + depth + ' newId=' + resendId + '\n');
      this._sender._sendGroupMessage(
        cached.toJid, resendId, cached.plaintext, cached.mediaType, opts
      )
        .then(r  => _whaDbg('[DBG] RETRY_RESEND group ok id=' + (r && r.id) + '\n'))
        .catch(e => _whaDbg('[DBG] RETRY_RESEND_ERR: ' + e.message));
      return;
    }

    this._sender._sendDMMessage(
      cached.toJid, cached.msgId, cached.plaintext, cached.mediaType, opts
    )
      .then(r  => _whaDbg('[DBG] RETRY_RESEND ok id=' + r.id + '\n'))
      .catch(e => _whaDbg('[DBG] RETRY_RESEND_ERR: ' + e.message));
  }

  _handleAck(node) {
    const attrs  = node.attrs || {};
    const id     = attrs.id   || '';
    const cls    = attrs.class || '';
    const error  = attrs.error ? String(attrs.error) : '';

    if (cls === 'message') {
      const handler = this._pendingAcks.get(id);
      if (handler) {
        this._pendingAcks.delete(id);
        handler(attrs);
      }

      // ─── Error 463 ───────────────────────────────────────────────────────
      // 463 recovery is fully handled inside MessageSender._dispatchAndAck:
      // it issues the privacy token then automatically re-sends the message
      // so the caller's promise resolves transparently (no loop).
      // Nothing to do here — the pendingAck handler above already drove the
      // recovery via _inFlight463Recoveries + _issuePrivacyTokens.
      // ────────────────────────────────────────────────────────────────────
    }
  }

  // Delivery ack — sent immediately on message receipt.
  // Signals the server that the message was delivered → gives sender 2 grey checkmarks.
  // fromJid / partJid are raw JID objects so BinaryNode encodes them as AD_JID
  // (agent:device bytes), which is required for correct server-side routing.
  _sendMessageAck(msgId, fromJid, partJid) {
    if (!this._socket || !this._connected) return;
    const attrs = { id: msgId, class: 'message', to: fromJid };
    if (partJid && String(partJid) !== String(fromJid)) attrs.participant = partJid;
    this._socket.sendNode(new BinaryNode('ack', attrs, null));
  }

  // A read receipt only tells the sender we read it when read receipts are on.
  // whatsmeow's MarkRead checks the same setting and downgrades "read" to
  // "read-self", which marks the message read across our own devices without
  // reporting it to the other side. Nothing here looked at the setting, so a
  // user who had turned read receipts off still sent blue ticks.
  _readReceiptType(base) {
    const settings = this._privacySettings;
    if (settings && settings.readReceipts === 'none' && base === 'read') {
      return 'read-self';
    }
    return base;
  }

  // True when a JID names this account, in either address family.
  _isOwnUser(jid) {
    if (!jid) return false;
    const user = String(jid).split('@')[0].split(':')[0];
    if (!user) return false;
    if (user === String(this._store && this._store.phoneNumber)) return true;
    const ownLid = this._myLid ? String(this._myLid).split('@')[0].split(':')[0] : null;
    return !!ownLid && user === ownLid;
  }

  // Delivery receipt — the sender's two grey ticks.
  //
  // Distinct from the <ack> above: the ack tells the server we took the stanza,
  // the receipt tells the sender it reached a device. whatsmeow sends both for
  // every incoming message (sendAck + sendMessageReceipt) and leaves the blue
  // ticks to an explicit MarkRead. whalibmob only ever sent the ack and then
  // jumped straight to type="read", so a sender never saw the grey stage.
  //
  // A client that has not marked itself available sends this with
  // type="inactive": the sender's app records the delivery but does not render
  // it, which is how WhatsApp Web behaves in the background.
  _sendDeliveryReceipt(msgId, fromJid, partJid) {
    if (!this._socket || !this._connected) return;
    const attrs = { id: msgId, to: fromJid };
    if (partJid && String(partJid) !== String(fromJid)) attrs.participant = partJid;
    // A message that came from one of our own other devices is receipted with
    // type="sender", never as a delivery to ourselves.
    if (this._isOwnUser(partJid || fromJid)) {
      attrs.type = 'sender';
    } else if (!this._sendActiveReceipts) {
      attrs.type = 'inactive';
    }
    this._socket.sendNode(new BinaryNode('receipt', attrs, null));
  }

  // Read receipt — the sender's two blue ticks.
  //
  // Sent automatically after a message decodes unless autoRead is turned off, in
  // which case marking a chat read is up to the caller via markRead(). Turning
  // it off gives whatsmeow's model, where read is always explicit.
  // fromJid / partJid are raw JID objects (AD_JID encoding for correct routing).
  _sendReadReceipt(msgId, fromJid, partJid) {
    if (!this._socket || !this._connected) return;
    if (this.autoRead === false) return;
    const node = new BinaryNode('receipt', {
      id:   msgId,
      type: this._readReceiptType('read'),
      to:   fromJid,
      t:    String(Math.floor(Date.now() / 1000))
    }, null);
    if (partJid && String(partJid) !== String(fromJid)) {
      node.attrs.participant = partJid;
    }
    this._socket.sendNode(node);
  }

  // ─── Retry request (when decryption fails) ────────────────────────────────
  // Retry request behaviour:
  //   - <retry count v='1' error='0' t=<orig_t>>
  //   - <registration> 4-byte reg-id
  //   - <keys> block (from retry #1): type + identity + key + skey + device-identity

  // A message we asked to be re-sent finally decrypted (or we gave up on it).
  // Release its reserved prekey so the pool does not drain over a long session.
  _resolveRetry(msgId) {
    const pending = this._retryPending.get(msgId);
    if (!pending) return;
    if (pending.pkId !== null && pending.pkId !== undefined) {
      this._retryAdvertisedPreKeys.delete(pending.pkId);
    }
    this._retryPending.delete(msgId);
  }

  _sendRetryRequest(msgId, origNode) {
    const existing = this._retryPending.get(msgId);
    const count    = existing ? existing.count + 1 : 1;
    if (count > 5) return;

    if (!this._socket || !this._connected) return;

    // Pick a prekey that is not already advertised by another unresolved retry.
    // A prekey is deleted the moment a pkmsg using it is decrypted, so handing
    // the same one to two senders means the second arrives after the key is
    // gone and dies with "Invalid PreKey ID". Indexing modulo the key count
    // could not prevent that: the list shrinks as keys are consumed, so the
    // rotating index wraps back onto ids that are still in flight.
    let pkId = existing ? existing.pkId : null;
    if (pkId === null && this._signal) {
      const allKeys = this._signal.getPreKeysForUpload(800);
      const free = allKeys.find(k => !this._retryAdvertisedPreKeys.has(k.keyId));
      // If every key is already spoken for, fall back to rotating rather than
      // sending no bundle at all — a stale id beats no retry.
      const chosen = free || allKeys[this._retryPreKeyIdx++ % Math.max(1, allKeys.length)];
      if (chosen) {
        pkId = chosen.keyId;
        this._retryAdvertisedPreKeys.add(pkId);
      }
    }
    this._retryPending.set(msgId, { node: origNode, count, pkId });

    // Use original message timestamp (not current time)
    const origAttrs = (origNode && origNode.attrs) || {};
    const origT = origAttrs.t ? String(origAttrs.t) : String(Math.floor(Date.now() / 1000));
    // Raw JID object from original node — AD_JID encoding ensures correct server routing
    const fromJid = origAttrs.from || null;

    const children = [
      new BinaryNode('retry', { count: String(count), id: msgId, t: origT, v: '1', error: '0' }, null),
      new BinaryNode('registration', {}, intToBytes(this._store.registrationId, 4))
    ];

    // Include prekey bundle (from retry #1) so sender re-establishes Signal session (pkmsg)
    if (this._signal) {
      try {
        const spk        = this._signal.getSignedPreKeyForUpload();
        const identKey   = this._signal.getIdentityKey();
        const allPreKeys = this._signal.getPreKeysForUpload(800);
        const pk         = allPreKeys.find(k => k.keyId === pkId) || allPreKeys[0];

        if (spk && identKey && pk) {
          const keysChildren = [
            new BinaryNode('type',     {}, Buffer.from([5])),
            new BinaryNode('identity', {}, stripKeyPrefix(identKey)),
            new BinaryNode('key', {}, [
              new BinaryNode('id',    {}, intToBytes(pk.keyId, 3)),
              new BinaryNode('value', {}, stripKeyPrefix(pk.pubKey))
            ]),
            new BinaryNode('skey', {}, [
              new BinaryNode('id',        {}, intToBytes(spk.keyId, 3)),
              new BinaryNode('value',     {}, stripKeyPrefix(spk.keyPair.pubKey)),
              new BinaryNode('signature', {}, spk.signature)
            ])
          ];

          // device-identity — include WITH accountSignatureKey (no strip)
          const advBytes = buildOrGetAdvIdentity(this._store);
          if (advBytes && advBytes.length > 0) {
            keysChildren.push(new BinaryNode('device-identity', {}, advBytes));
            _whaDbg('[DBG] RETRY #' + count + ' for ' + msgId + ' — preKeyId=' + pk.keyId + ' +device-identity(' + advBytes.length + 'b)\n');
          } else {
            _whaDbg('[DBG] RETRY #' + count + ' for ' + msgId + ' — preKeyId=' + pk.keyId + ' (no advIdentity)\n');
          }

          children.push(new BinaryNode('keys', {}, keysChildren));
        }
      } catch (e) {
        _whaDbg('[DBG] RETRY prekey bundle error: ' + e.message);
      }
    }

    // Mirror participant/recipient from original node attrs if present
    // Use raw JID objects so BinaryNode encodes them as AD_JID (correct routing)
    const receiptAttrs = {
      id:   msgId,
      type: 'retry',
      to:   fromJid,
      t:    String(Math.floor(Date.now() / 1000))
    };
    if (origAttrs.recipient)   receiptAttrs.recipient  = origAttrs.recipient;
    if (origAttrs.participant) receiptAttrs.participant = origAttrs.participant;

    _whaDbg('[DBG] RETRY #' + count + ' receipt to=' + JSON.stringify(fromJid) + ' participant=' + JSON.stringify(origAttrs.participant || null));
    this._socket.sendNode(new BinaryNode('receipt', receiptAttrs, children));
  }

  // ─── Notification handling ────────────────────────────────────────────────

  // <privacy><category name="..." value="..."/></privacy> inside an account_sync
  // notification. The node carries only what changed, so it is folded into the
  // cached settings rather than replacing them.
  _handlePrivacySettingsNotification(node) {
    const changed = this._parsePrivacySettings(node);
    const merged  = Object.assign({}, this._privacySettings || {});
    const changes = {};
    for (const key of Object.keys(changed)) {
      if (changed[key] !== null) { merged[key] = changed[key]; changes[key] = changed[key]; }
    }
    this._privacySettings = merged;
    _whaDbg('[DBG] PRIVACY_CHANGE ' + JSON.stringify(changes));
    this.emit('privacy_settings', { changes, settings: merged });
  }

  // <blocklist action="..." dhash="..." prev_dhash="..."><item jid=... action=.../></blocklist>
  // Mirrors whatsmeow's handleBlocklist: the action on the node describes the
  // whole change, each child names one JID and what happened to it.
  _handleBlocklistNotification(node) {
    const attrs   = node.attrs || {};
    const changes = [];
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (!child || !child.attrs || !child.attrs.jid) continue;
        changes.push({
          jid:    String(child.attrs.jid),
          action: child.attrs.action ? String(child.attrs.action) : null
        });
      }
    }
    _whaDbg('[DBG] BLOCKLIST_CHANGE action=' + (attrs.action || '') +
      ' changes=' + changes.map(c => c.action + ':' + c.jid).join(','));
    this.emit('blocklist', {
      action:    attrs.action     ? String(attrs.action)     : null,
      dhash:     attrs.dhash      ? String(attrs.dhash)      : null,
      prevDhash: attrs.prev_dhash ? String(attrs.prev_dhash) : null,
      changes
    });
  }

  _handleNotification(node) {
    const attrs = node.attrs || {};
    const type  = attrs.type || '';

    this.emit('notification', { type, attrs, node });

    if (type === 'encrypt') {
      // Server tells us pre-keys are running low
      this._checkAndReplenishPreKeys();
    }

    if (type === 'account_sync') {
      // Account sync notification — may contain device list updates
      const devicesNode = findChildDeep(node, 'devices');
      if (devicesNode) this._processDeviceUpdate(devicesNode);
      // ...and block list changes. Blocking someone from the phone arrives
      // here; nothing was watching for it, so the client's idea of who is
      // blocked only ever changed when it did the blocking itself.
      const blocklistNode = findChildDeep(node, 'blocklist');
      if (blocklistNode) this._handleBlocklistNotification(blocklistNode);
      // ...and privacy setting changes, which arrive the same way. whatsmeow
      // re-reads the settings on this and raises an event; nothing was watching
      // the node, so a change made on the phone never reached the cache.
      const privacyNode = findChildDeep(node, 'privacy');
      if (privacyNode) this._handlePrivacySettingsNotification(privacyNode);
    }

    if (type === 'w:gp2') {
      // Group update: member add/remove
      this._processGroupUpdate(node);
    }

    if (type === 'privacy_token') {
      // Incoming trusted-contact token from a conversation partner — store it
      // so we can attach it on next DM send (prevents error 463).
      this._handlePrivacyTokenNotification(node);
    }

    if (type === 'md-msg-hist') {
      // Server signals that history sync data is available.
      // The actual encrypted notification may arrive as:
      //   (a) an encrypted <message> containing HistorySyncNotification (primary path, handled in _decryptDMMessage)
      //   (b) inline in this notification node via an <enc> child (handle here)
      this._handleMdMsgHistNotification(node);
    }

    if (type === 'devices') {
      // Server push: a contact's linked device list changed (they linked or
      // unlinked a tablet, desktop, etc.).  Invalidate that phone's cache entry
      // so the next send triggers a fresh usync IQ and reaches all their devices.
      const fromJid   = attrs.from || '';
      const fromPhone = fromJid.split('@')[0].split(':')[0];
      if (fromPhone && this._devMgr) {
        this._devMgr._dcDel([fromPhone]);
        _whaDbg('[DBG] NOTIF_DEVICES invalidated cache for ' + fromPhone);
        // Also process any inline <devices> list the server included
        const devicesNode = findChildDeep(node, 'devices');
        if (devicesNode) this._processDeviceUpdate(devicesNode);
        // Background re-usync so the cache is warm before the next send
        if (this._signal) {
          setImmediate(() => {
            if (!this._connected || !this._devMgr) return;
            this._devMgr.bulkEnsureSessions([fromPhone], this._signal, false)
              .then(() => _whaDbg('[DBG] NOTIF_DEVICES bg-usync done for ' + fromPhone))
              .catch(e  => _whaDbg('[DBG] NOTIF_DEVICES bg-usync err: ' + e.message));
          });
        }
      }
    }

    if (type === 'identity') {
      // Server push: a contact re-registered WhatsApp (new identity key / new phone).
      // Their old Signal sessions are no longer valid — clear them and the device
      // cache so the next send builds a fresh pkmsg session from scratch.
      const fromJid   = attrs.from || '';
      const fromPhone = fromJid.split('@')[0].split(':')[0];
      if (fromPhone && this._devMgr) {
        this._devMgr._dcDel([fromPhone]);
        _whaDbg('[DBG] NOTIF_IDENTITY flushed device cache for re-registered ' + fromPhone);
      }
      if (fromPhone && this._signal && this._signal.store && this._signal.store._sessions) {
        const sessions = this._signal.store._sessions;
        let cleared = 0;
        for (const addr of Object.keys(sessions)) {
          if (addr.startsWith(fromPhone + '.')) { delete sessions[addr]; cleared++; }
        }
        _whaDbg('[DBG] NOTIF_IDENTITY cleared ' + cleared + ' Signal sessions for ' + fromPhone);
      }
    }

    // Ack the notification
    if (this._socket && this._connected) {
      this._socket.sendNode(new BinaryNode('ack', {
        id:    attrs.id    || '',
        class: 'notification',
        type:  type,
        to:    attrs.from  || 's.whatsapp.net'
      }, null));
    }
  }

  _processDeviceUpdate(devicesNode) {
    // Called from _handleNotification(type='account_sync') and type='devices'.
    // Rebuilds the device cache for the affected phones from the server-provided list.
    // Previous bug: called Set.add() on cache entries that are number[] arrays → silently failed.
    if (!Array.isArray(devicesNode.content) || !this._devMgr) return;

    // Group all device IDs per phone from the notification
    const phoneDevices = new Map();  // phone → number[]
    for (const deviceNode of devicesNode.content) {
      if (!deviceNode || deviceNode.description !== 'device') continue;
      const jid = deviceNode.attrs && deviceNode.attrs.jid;
      if (!jid) continue;
      const phone  = String(jid).split('@')[0].split(':')[0];
      const device = parseInt((String(jid).split(':')[1] || '0').split('@')[0], 10);
      if (!phoneDevices.has(phone)) phoneDevices.set(phone, []);
      const ids = phoneDevices.get(phone);
      if (!ids.includes(device)) ids.push(device);
    }

    // Replace cache entries atomically per phone (server list is authoritative)
    for (const [phone, ids] of phoneDevices) {
      this._devMgr._dcDel([phone]);       // evict stale entry
      for (const id of ids) this._devMgr._dcAdd(phone, id);
      _whaDbg('[DBG] DEV_UPDATE phone=' + phone + ' ids=[' + ids.join(',') + ']');
    }
  }

  _processGroupUpdate(node) {
    const groupJid = node.attrs && node.attrs.from;
    if (!groupJid) return;
    // Membership/settings just changed — the cached metadata is now stale.
    // The live _groupMembers set below stays authoritative for this session;
    // dropping the cache makes the next getGroupMetadata() re-read the server.
    this.invalidateGroupMetadata(groupJid);
    if (!this._groupMembers.has(groupJid)) this._groupMembers.set(groupJid, new Set());
    const members  = this._groupMembers.get(groupJid);
    const actor    = (node.attrs && node.attrs.participant) ? String(node.attrs.participant) : null;
    const ts       = (node.attrs && node.attrs.t) ? parseInt(node.attrs.t, 10) : Math.floor(Date.now() / 1000);

    if (!Array.isArray(node.content)) return;
    for (const child of node.content) {
      if (!child) continue;
      const action  = child.description; // 'add','remove','promote','demote','modify','subject','announce','restrict'
      const targets = [];

      if (['add','remove','promote','demote'].includes(action)) {
        for (const p of (child.content || [])) {
          if (p && p.description === 'participant' && p.attrs && p.attrs.jid) {
            const jid = String(p.attrs.jid);
            targets.push(jid);
            if (action === 'add' || action === 'promote')   members.add(jid);
            if (action === 'remove' || action === 'demote') members.delete(jid);
          }
        }
        if (this._signal) {
          if (action === 'add') {
            this._signal.senderKeyStore.invalidateSKDM(groupJid);
          }
          if (action === 'remove') {
            const groupAddressingMode = this._groupAddressingMode.get(groupJid) || 'lid';
            const senderIdentity = (groupAddressingMode === 'lid' && this._myLid)
              ? this._myLid
              : `${this._store.phoneNumber}@s.whatsapp.net`;
            this._signal.senderKeyStore.delete(groupJid, senderIdentity);
            this._signal.senderKeyStore.invalidateSKDM(groupJid);
          }
        }
        this.emit('group_update', {
          type:       action,
          groupJid,
          actor,
          participants: targets,
          timestamp:  ts
        });
      } else if (action === 'modify' || action === 'subject' || action === 'announce' || action === 'restrict') {
        // settings / subject change
        const newSubject = action === 'subject'
          ? (child.attrs && child.attrs.subject) || null
          : null;
        this.emit('group_update', {
          type:      action,
          groupJid,
          actor,
          subject:   newSubject,
          timestamp: ts
        });
      }
    }
  }

  // ─── Presence ─────────────────────────────────────────────────────────────

  _handlePresence(node) {
    const attrs = node.attrs || {};
    this.emit('presence', {
      from:      attrs.from || '',
      available: attrs.type !== 'unavailable'
    });
  }

  // ─── Call ─────────────────────────────────────────────────────────────────

  _handleCall(node) {
    const attrs = node.attrs || {};

    // A <call> can also be the answer to something we asked for — creating a
    // call link, for one. Those come back on the same tag with the id we sent,
    // so they have to be handed to the waiting caller and not treated as an
    // incoming call to reject.
    if (attrs.id) {
      const handler = this._pendingIqs.get(attrs.id);
      if (handler) {
        this._pendingIqs.delete(attrs.id);
        handler(node);
        return;
      }
    }

    this.emit('call', { from: attrs.from || '', node });
    // Reject call automatically
    if (this._socket && this._connected) {
      const offer = findChild(node, 'offer');
      const callId = offer && offer.attrs && offer.attrs.call_id;
      if (callId) {
        this._socket.sendNode(new BinaryNode('call', {
          to: attrs.from || '',
          id: this._genMsgId()
        }, [new BinaryNode('reject', { call_id: callId, call_creator: attrs.from || '' }, null)]));
      }
    }
  }

  // ─── Auth failure (server forces logout during active session) ──────────────

  _handleFailure(node) {
    const attrs  = (node && node.attrs) || {};
    const reason = attrs.reason || attrs.location || 'unknown';
    this.emit('auth_failure', { reason, node });
    // The session is no longer valid — stop reconnecting and disconnect
    this._reconnecting = false;
    this.disconnect();
  }

  // ─── Media connection ─────────────────────────────────────────────────────

  _requestMediaConnection() {
    if (!this._socket || !this._connected) return;
    const mcId = this._genMsgId();
    _whaDbg('[DBG] SEND media_conn IQ id=' + mcId);
    // Match the reply by request id.  The server echoes back only `from`, `id`
    // and `type='result'` — it does NOT repeat the `xmlns` of the request, so
    // keying off xmlns alone would never fire and every upload would stall
    // until the 15 s "Timeout waiting for media connection".
    this._pendingIqs.set(mcId, (resp) => {
      this._onMediaConnectionResult(resp);
    });
    // Don't leak the handler if the server never answers.
    setTimeout(() => this._pendingIqs.delete(mcId), 20000);
    this._socket.sendNode(new BinaryNode('iq', {
      id:    mcId,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:m'
    }, [new BinaryNode('media_conn', {}, null)]));
  }

  _onMediaConnectionResult(node) {
    const connNode = findChild(node, 'media_conn');
    if (!connNode) {
      // Server answered but refused (or the IQ handler timed out and passed
      // nothing).  Surface it so the waiter fails fast with a real reason
      // instead of sitting out the full media-connection timeout.
      const reason = (node && node.attrs && node.attrs.type === 'error')
        ? ('server returned IQ error' + (node.attrs.code ? ' ' + node.attrs.code : ''))
        : 'no media_conn node in server reply';
      _whaDbg('[DBG] media_conn failed: ' + reason);
      this.emit('media_conn_error', new Error('Media connection refused: ' + reason));
      return;
    }
    const auth  = (connNode.attrs && connNode.attrs.auth) || '';
    const ttl   = connNode.attrs && connNode.attrs.ttl ? parseInt(connNode.attrs.ttl, 10) : 300;
    const hosts = [];
    if (Array.isArray(connNode.content)) {
      for (const child of connNode.content) {
        if (child && child.description === 'host') {
          const hostname = child.attrs && child.attrs.hostname;
          if (hostname) hosts.push(hostname);
        }
      }
    }
    this._mediaConn = { hosts, auth, ttl, fetchDate: Date.now() };
    if (this._sender) this._sender.setMediaConnection(hosts, auth, ttl, Date.now());
    this.emit('media_conn', { hosts, auth, ttl });
  }

  // ─── Pre-key upload ───────────────────────────────────────────────────────

  _uploadPreKeys() {
    if (!this._signal || !this._socket || !this._connected) return;

    const preKeys  = this._signal.getPreKeysForUpload(800);
    const spk      = this._signal.getSignedPreKeyForUpload();
    const identKey = this._signal.getIdentityKey();
    if (!preKeys.length || !spk) return;

    const preKeyNodes = preKeys.map(pk => new BinaryNode('key', {}, [
      new BinaryNode('id',    {}, intToBytes(pk.keyId, 3)),
      new BinaryNode('value', {}, stripKeyPrefix(pk.pubKey))
    ]));

    const skNode = new BinaryNode('skey', {}, [
      new BinaryNode('id',        {}, intToBytes(spk.keyId, 3)),
      new BinaryNode('value',     {}, stripKeyPrefix(spk.keyPair.pubKey)),
      new BinaryNode('signature', {}, spk.signature)
    ]);

    const pkId = this._genMsgId();
    _whaDbg('[DBG] SEND uploadPreKeys IQ id=' + pkId);
    this._socket.sendNode(new BinaryNode('iq', {
      id:    pkId,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'encrypt'
    }, [
      new BinaryNode('registration', {}, intToBytes(this._store.registrationId, 4)),
      new BinaryNode('type',         {}, Buffer.from([5])),
      new BinaryNode('identity',     {}, stripKeyPrefix(identKey)),
      new BinaryNode('list',         {}, preKeyNodes),
      skNode
    ]));
  }

  _checkAndReplenishPreKeys() {
    if (!this._signal) return;
    const count = this._signal.preKeyCount();
    if (count < 20) {
      const newKeys = this._signal.replenishPreKeys();
      if (newKeys.length > 0) this._uploadPreKeys();
    }
  }

  // ─── IQ helper (send + await response) ────────────────────────────────────

  _sendIq(node) {
    return new Promise((resolve, reject) => {
      const id = node.attrs && node.attrs.id;
      if (!id) return reject(new Error('IQ node has no id'));

      const timer = setTimeout(() => {
        this._pendingIqs.delete(id);
        resolve(null);  // Resolve null on timeout rather than reject
      }, 15000);

      this._pendingIqs.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      try {
        this._socket.sendNode(node);
      } catch (err) {
        clearTimeout(timer);
        this._pendingIqs.delete(id);
        reject(err);
      }
    });
  }

  // ─── Group metadata ───────────────────────────────────────────────────────

  // ─── Group metadata parser (shared by getGroupMetadata + fetchAllGroups) ──

  _parseGroupNode(groupNode) {
    if (!groupNode || !groupNode.attrs) return null;
    const a = groupNode.attrs;
    const children = Array.isArray(groupNode.content) ? groupNode.content : [];

    // participants — normalize jid to string (BinaryNode may yield an object)
    // Also parse phone_number and lid attributes used for LID↔PN mapping
    const participants = children
      .filter(n => n && n.description === 'participant' && n.attrs && n.attrs.jid)
      .map(n => {
        const pJid  = String(n.attrs.jid);
        const pRole = n.attrs.type || 'member';
        const pPhone = n.attrs.phone_number ? String(n.attrs.phone_number) : null;
        const pLid   = n.attrs.lid          ? String(n.attrs.lid)          : null;
        // Populate LID↔PN maps from participant attributes
        // Case A: participant JID is a LID, phone_number is their PN
        if (pJid.endsWith('@lid')) {
          const lidUser = pJid.split('@')[0].split(':')[0];
          if (pPhone) {
            const pnUser = pPhone.split('@')[0].split(':')[0];
            this._lidToPn.set(lidUser, pnUser);
            this._pnToLid.set(pnUser, lidUser);
            if (this._signal && this._signal.store && this._signal.store.setLidMapping)
              this._signal.store.setLidMapping(pnUser, lidUser);
          }
        }
        // Case B: participant JID is a PN, lid attribute is their LID
        if (pLid && pLid.endsWith('@lid')) {
          const pnUser  = pJid.split('@')[0].split(':')[0];
          const lidUser = pLid.split('@')[0].split(':')[0];
          this._lidToPn.set(lidUser, pnUser);
          this._pnToLid.set(pnUser, lidUser);
          if (this._signal && this._signal.store && this._signal.store.setLidMapping)
            this._signal.store.setLidMapping(pnUser, lidUser);
        }
        return { jid: pJid, role: pRole };
      });

    // description — the id is the "topic id" the server wants echoed back as
    // prev= on the next edit, so it has to survive the parse.
    const descNode = children.find(n => n && n.description === 'description');
    const descriptionId = (descNode && descNode.attrs && descNode.attrs.id)
      ? String(descNode.attrs.id) : null;
    let description = null;
    if (descNode) {
      const bodyNode = Array.isArray(descNode.content)
        ? descNode.content.find(n => n && n.description === 'body')
        : null;
      const buf = bodyNode && (Buffer.isBuffer(bodyNode.content)
        ? bodyNode.content
        : (Array.isArray(bodyNode.content) && Buffer.isBuffer(bodyNode.content[0])
          ? bodyNode.content[0] : null));
      if (buf) description = buf.toString('utf8');
    }

    // ephemeral
    const ephNode = children.find(n => n && n.description === 'ephemeral');
    const ephemeral = ephNode && ephNode.attrs ? parseInt(ephNode.attrs.expiration, 10) || 0 : 0;

    // settings flags — WA protocol uses 'announcement' and 'locked' node names
    const announce = children.some(n => n && n.description === 'announcement');
    const restrict = children.some(n => n && n.description === 'locked');

    const groupId = a.id || '';
    const jid = groupId.includes('@') ? groupId : groupId + '@g.us';

    // addressing_mode: 'lid' (modern groups) or 'pn' (legacy groups)
    const addressingMode = (a.addressing_mode === 'pn') ? 'pn' : 'lid';

    // update member cache and addressing mode
    this._groupMembers.set(jid, new Set(participants.map(p => p.jid)));
    this._groupAddressingMode.set(jid, addressingMode);

    const meta = {
      jid,
      subject:    a.subject || '',
      creation:   parseInt(a.creation, 10) || 0,
      creator:    a.creator || null,
      subjectTime: parseInt(a.s_t, 10) || 0,
      subjectBy:  a.s_o || null,
      description,
      descriptionId,
      ephemeral,
      onlyAdminsSend: announce,
      onlyAdminsEdit: restrict,
      addressingMode,
      participants
    };

    // Warm the cache from every parse — fetchAllGroups() then primes metadata
    // for every group at once, so the first send to any of them skips its IQ.
    if (this._groupMetaCache) this._groupMetaCache.set(jid, meta);
    return meta;
  }

  // Query metadata for a single group — returns parsed object.
  // Served from cache when available; pass { force: true } to bypass it.
  async getGroupMetadata(groupJid, opts) {
    const jid = makeJid(groupJid);

    if (!opts || !opts.force) {
      const cached = this._groupMetaCache.get(jid);
      if (cached) {
        _whaDbg('[DBG] GROUP_META cache hit ' + jid);
        // Re-seed the member/addressing maps — a reconnect clears them while
        // the metadata cache is still warm.
        this._groupMembers.set(jid, new Set(cached.participants.map(p => p.jid)));
        this._groupAddressingMode.set(jid, cached.addressingMode);
        return cached;
      }
      // Coalesce concurrent lookups for the same group onto one IQ.
      const inflight = this._groupMetaInflight.get(jid);
      if (inflight) {
        _whaDbg('[DBG] GROUP_META joining in-flight query for ' + jid);
        return inflight;
      }
    }

    const promise = (async () => {
      const id   = this._genMsgId();
      const node = new BinaryNode('iq', {
        id,
        to:    jid,
        type:  'get',
        xmlns: 'w:g2'
      }, [new BinaryNode('query', { request: 'interactive' }, null)]);

      const response = await this._sendIq(node);
      if (!response) return null;

      // Response may be the group node itself or wrap it
      const groupNode = (response.description === 'group')
        ? response
        : findChild(response, 'group');
      const meta = this._parseGroupNode(groupNode);
      if (meta) this._groupMetaCache.set(jid, meta);
      return meta;
    })();

    this._groupMetaInflight.set(jid, promise);
    try {
      return await promise;
    } finally {
      this._groupMetaInflight.delete(jid);
    }
  }

  // Drop cached metadata for a group so the next read re-queries the server.
  invalidateGroupMetadata(groupJid) {
    const jid = makeJid(groupJid);
    this._groupMetaCache.del(jid);
    this._groupMetaInflight.delete(jid);
    _whaDbg('[DBG] GROUP_META invalidated ' + jid);
  }

  // Fetch ALL groups the connected account participates in
  // Returns array of parsed group metadata objects (same shape as getGroupMetadata)
  // Protocol: IQ w:g2 to=g.us type=get <participating><participants/><description/></participating>
  async fetchAllGroups() {
    const id   = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      to:    'g.us',
      type:  'get',
      xmlns: 'w:g2'
    }, [
      new BinaryNode('participating', {}, [
        new BinaryNode('participants',  {}, null),
        new BinaryNode('description',   {}, null)
      ])
    ]);

    const response = await this._sendIq(node);
    if (!response) {
      throw new Error('fetchAllGroups: no reply from server (IQ timed out)');
    }
    if (response.attrs && response.attrs.type === 'error') {
      const errNode = findChild(response, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('fetchAllGroups: server returned error' + (code ? ' ' + code : ''));
    }

    // The server wraps the list in a <groups> node: iq > groups > group[].
    // Fall back to scanning the iq body directly in case a server build ever
    // returns them unwrapped.
    const groupsNode = findChild(response, 'groups');
    const container  = groupsNode || response;
    const children   = Array.isArray(container.content) ? container.content : [];
    return children
      .filter(n => n && n.description === 'group')
      .map(n => this._parseGroupNode(n))
      .filter(Boolean);
  }

  // ─── Group member helpers ─────────────────────────────────────────────────

  _getGroupMembers(groupJid) {
    const members = this._groupMembers.get(makeJid(groupJid));
    return members ? [...members] : [];
  }

  async refreshGroupMembers(groupJid) {
    const meta = await this.getGroupMetadata(groupJid);
    return meta ? meta.participants : [];
  }

  getPNForLID(lid) {
    const lidUser = String(lid).split('@')[0].split(':')[0];
    const pnUser  = this._lidToPn.get(lidUser);
    return pnUser ? pnUser + '@s.whatsapp.net' : null;
  }

  getLIDForPN(pn) {
    const pnUser  = String(pn).split('@')[0].split(':')[0];
    const lidUser = this._pnToLid.get(pnUser);
    return lidUser ? lidUser + '@lid' : null;
  }

  // ─── Message ID generator ─────────────────────────────────────────────────

  _genMsgId() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
  }

  // ─── tcToken / privacy token helpers ──────────────────────────────────────

  /**
   * Send a `<iq type='set' xmlns='privacy'>` to issue a trusted-contact token
   * for `jid`. Returns the raw result node (or null on timeout).
   *
   * Mirrors Baileys' `issuePrivacyTokens` in messages-send.js.
   *
   * @param {string} jid          - Bare or full JID of the conversation partner
   * @param {number} timestamp    - Unix seconds to use as the token timestamp
   */
  _issuePrivacyTokens(jid, timestamp) {
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
    const normalizedJid = normalizeJidForTcToken(jid);
    const id            = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'privacy'
    }, [
      new BinaryNode('tokens', {}, [
        new BinaryNode('token', {
          jid:  normalizedJid,
          t:    String(timestamp),
          type: 'trusted_contact'
        })
      ])
    ]);
    _whaDbg('[DBG] ISSUE_PRIVACY_TOKENS jid=' + normalizedJid + ' t=' + timestamp + ' iq_id=' + id);
    return this._sendIq(node);
  }

  /**
   * Parse the IQ result from `_issuePrivacyTokens` and persist the token.
   *
   * The server echoes back:
   *   <iq type='result' ...>
   *     <tokens>
   *       <token type='trusted_contact' jid='X' t='Y'>...bytes...</token>
   *     </tokens>
   *   </iq>
   *
   * @param {object|null} result        - IQ result node (null on timeout)
   * @param {string}      fallbackJid   - Normalized JID to use if not found in result
   * @param {number}      issueTs       - Timestamp supplied to the IQ
   */
  _storeTcTokenFromIqResult(result, fallbackJid, issueTs, opts) {
    const saveSenderTs = !opts || opts.saveSenderTs !== false; // default true
    if (!this._tcTokenStore) return;

    // ── Debug: dump result structure so we can trace server response ─────────
    if (!result) {
      _whaDbg('[DBG] STORE_TCTOKEN result=NULL (IQ timeout or not matched) fallback=' + fallbackJid);
    } else {
      const contentLen = Array.isArray(result.content) ? result.content.length
                       : Buffer.isBuffer(result.content) ? result.content.length
                       : 0;
      _whaDbg('[DBG] STORE_TCTOKEN result type=' + (result.attrs && result.attrs.type) +
        ' id=' + (result.attrs && result.attrs.id) +
        ' contentLen=' + contentLen);
      if (Array.isArray(result.content)) {
        result.content.forEach((c, i) => {
          if (c && c.description) {
            const childContent = Array.isArray(c.content) ? c.content.length + ' children'
                               : Buffer.isBuffer(c.content) ? c.content.length + 'B'
                               : String(c.content);
            _whaDbg('[DBG] STORE_TCTOKEN   child[' + i + '] tag=' + c.description +
              ' attrs=' + JSON.stringify(c.attrs || {}) +
              ' content=' + childContent);
          }
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    let tokenStoredCount = 0;
    if (result) {
      try {
        // Find <tokens> child — may be direct child or nested
        const content = Array.isArray(result.content) ? result.content : [];
        const tokensNode = content.find(n => n && n.description === 'tokens');
        const entries    = tokensNode && Array.isArray(tokensNode.content) ? tokensNode.content : [];
        for (const tokenNode of entries) {
          if (!tokenNode || tokenNode.description !== 'token') continue;
          const a = tokenNode.attrs || {};
          if (a.type !== 'trusted_contact') continue;
          // bytes: server returns raw binary in node content
          const bytes = Buffer.isBuffer(tokenNode.content) ? tokenNode.content
                      : ArrayBuffer.isView(tokenNode.content)
                        ? Buffer.from(tokenNode.content)
                        : (typeof tokenNode.content === 'string' && tokenNode.content.length > 0)
                          ? Buffer.from(tokenNode.content, 'base64')
                          : null;
          // Baileys tc-token-utils.js line 137-138:
          // "In notifications tokenNode.attrs.jid is your own device JID, not the sender's"
          // → always prefer fallbackJid; only fall back to a.jid when fallbackJid is absent
          const jid = fallbackJid || String(a.jid);
          const t   = a.t   ? parseInt(String(a.t), 10) : issueTs;
          if (bytes && bytes.length) {
            this._tcTokenStore.setToken(jid, bytes, t);
            tokenStoredCount++;
            _whaDbg('[DBG] TCTOKEN_STORED jid=' + jid + ' t=' + t + ' len=' + bytes.length);
          } else {
            _whaDbg('[DBG] STORE_TCTOKEN token node has no bytes jid=' + jid);
          }
        }
      } catch (e) {
        _whaDbg('[DBG] STORE_TCTOKEN parse error: ' + e.message);
      }
    }

    // ── CRITICAL: Baileys ALWAYS persists senderTimestamp after issuing, ─────
    // ── regardless of whether server returned token bytes.               ─────
    // ── Without this, shouldSendNewTcToken() returns true every send and ─────
    // ── we flood the server with privacy IQs.                            ─────
    // ── For incoming privacy_token notifications saveSenderTs=false so  ─────
    // ── we don't overwrite our own send-dedupe timestamp with the peer's ─────
    if (saveSenderTs && issueTs != null) {
      try {
        this._tcTokenStore.setSenderTimestamp(fallbackJid, issueTs);
        _whaDbg('[DBG] SENDER_TS_SAVED jid=' + fallbackJid + ' ts=' + issueTs +
          ' tokenBytes=' + tokenStoredCount);
      } catch (_) {}
    }
  }

  /**
   * Handle a server-pushed `<notification type='privacy_token'>`.
   *
   * Wire format (mirrors Baileys' handlePrivacyTokenNotification):
   *   <notification type='privacy_token' from='...' [sender_lid='...@lid']>
   *     <tokens>
   *       <token type='trusted_contact' jid='...' t='...'>…bytes…</token>
   *     </tokens>
   *   </notification>
   *
   * Key rules (from Baileys messages-recv.js lines 996-1015):
   *   1. Must find <tokens> wrapper inside notification; abort if absent.
   *   2. storage key = sender_lid (if present and @lid) else PN→LID lookup else from-JID.
   *   3. senderTimestamp is NOT updated here — only the peer-token bytes + timestamp.
   *
   * @param {object} node  - The full `<notification>` BinaryNode
   */
  _handlePrivacyTokenNotification(node) {
    if (!this._tcTokenStore) return;
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');

    const attrs = node.attrs || {};
    _whaDbg('[DBG] PRIVACY_TOKEN_NOTIF_ENTER from=' + String(attrs.from || '') +
      ' sender_lid=' + String(attrs.sender_lid || ''));

    // ── 1. Require <tokens> wrapper (matches Baileys' getBinaryNodeChild check) ──
    const content    = Array.isArray(node.content) ? node.content : [];
    const tokensNode = content.find(n => n && n.description === 'tokens');
    if (!tokensNode) {
      _whaDbg('[DBG] PRIVACY_TOKEN_NOTIF no <tokens> wrapper — abort\n');
      return;
    }

    // ── 2. Resolve storage JID ─────────────────────────────────────────────────
    // Priority (mirrors Baileys lines 1001-1006):
    //   1. sender_lid attr if it is a @lid JID
    //   2. from user is a known LID user (LID comes as @s.whatsapp.net in notification)
    //   3. from is a PN → look up LID in _pnToLid
    //   4. bare from JID as fallback
    const rawFrom      = String(attrs.from || '');
    const rawSenderLid = attrs.sender_lid ? String(attrs.sender_lid) : null;
    const fromUser     = rawFrom.split('@')[0].split(':')[0];

    let storageJid;
    if (rawSenderLid && rawSenderLid.endsWith('@lid')) {
      // Explicit @lid sender_lid attr
      storageJid = normalizeJidForTcToken(rawSenderLid);
    } else if (this._lidToPn && this._lidToPn.has(fromUser)) {
      // from = LID_USER@s.whatsapp.net — WA sends LID notifications this way.
      // The user part is already the LID user; convert domain to @lid.
      storageJid = fromUser + '@lid';
    } else if (this._pnToLid && this._pnToLid.has(fromUser)) {
      // from is a PN → convert to LID for storage (Baileys always stores under LID)
      storageJid = this._pnToLid.get(fromUser) + '@lid';
    } else {
      storageJid = normalizeJidForTcToken(rawFrom);
    }

    _whaDbg('[DBG] PRIVACY_TOKEN_NOTIF storageJid=' + storageJid);

    // ── 3. Parse <token> children and store bytes (no senderTimestamp update) ──
    // Reuse _storeTcTokenFromIqResult with the full notification node so that its
    // <tokens><token> traversal is identical to the IQ-result code path.
    // Pass { saveSenderTs: false } so we don't overwrite our own senderTimestamp.
    this._storeTcTokenFromIqResult(node, storageJid, null, { saveSenderTs: false });
  }

  /**
   * Fire-and-forget tcToken re-issuance after a peer's device identity changed.
   * Called when we successfully decrypt a pkmsg — the peer opened a fresh Signal
   * session (reset or new device), so we re-issue a privacy token so they can
   * reach us.  Only fires if we've previously issued a token (senderTimestamp
   * present and not expired), mirroring Baileys' reissueTcTokenAfterIdentityChange.
   *
   * @param {string} from  - Signal-session JID (PN or LID JID of the sender)
   */
  _reissueTcTokenAfterIdentityChange(from) {
    if (!this._tcTokenStore || !from) return;
    const { normalizeJidForTcToken, tcTokenExpired } = require('./messages/TcTokenStore');

    void (async () => {
      try {
        // Resolve storage JID: PN→LID if available, otherwise use from as-is
        const fromNorm = normalizeJidForTcToken(from);
        const fromUser = fromNorm.split('@')[0];
        const lidUser  = this._pnToLid && this._pnToLid.get(fromUser);
        const tcJid    = lidUser ? (lidUser + '@lid') : fromNorm;

        const entry    = this._tcTokenStore.get(tcJid);
        const senderTs = entry && entry.senderTimestamp;
        if (!senderTs || tcTokenExpired(senderTs)) {
          // No previous issuance — nothing to re-issue
          return;
        }

        _whaDbg('[DBG] REISSUE_TC_TOKEN_AFTER_IDENTITY_CHANGE jid=' + tcJid +
          ' prevSenderTs=' + senderTs);

        const issueTs = Math.floor(Date.now() / 1000);
        const result  = await this._issuePrivacyTokens(tcJid, issueTs);
        this._storeTcTokenFromIqResult(result, tcJid, issueTs);
      } catch (e) {
        _whaDbg('[DBG] REISSUE_TC_TOKEN_ERR from=' + from +
          ' err=' + (e && e.message));
      }
    })();
  }

  // ─── History sync ─────────────────────────────────────────────────────────

  /**
   * _handleHistorySync — called when a decrypted DM protocol message contains
   * subtype='history_sync' with a HistorySyncNotification.
   *
   * Fires asynchronously (fire-and-forget with error emission).
   * Emits 'history_sync' on success, 'history_sync_error' on failure.
   *
   * @param {object} notification  Decoded HistorySyncNotification
   * @param {string} msgId         Source message ID (for logging)
   */
  _handleHistorySync(notification, msgId) {
    if (!notification) return;
    const phone      = this._store && this._store.phoneNumber;
    const sessionDir = this._sessionDir;

    _whaDbg('[DBG] HIST_SYNC start syncType=' + notification.syncType +
      ' progress=' + notification.progress +
      ' chunk=' + notification.chunkOrder +
      ' inline=' + !!(notification.initialHistBootstrapInlinePayload &&
                       notification.initialHistBootstrapInlinePayload.length) +
      ' msgId=' + msgId);

    processHistorySyncNotification(notification, sessionDir, phone)
      .then(result => {
        _whaDbg('[DBG] HIST_SYNC done syncType=' + result.syncTypeName +
          ' chats=' + result.chats.length +
          ' contacts=' + result.contacts.length +
          ' pushNames=' + (result.pushNames || []).length);

        // Populate in-memory LID ↔ PN mappings from history sync data
        if (result.lidPnMappings && result.lidPnMappings.length) {
          for (const m of result.lidPnMappings) {
            if (m.lidJid && m.pnJid) {
              const lidUser = m.lidJid.split('@')[0].split(':')[0];
              const pnUser  = m.pnJid.split('@')[0].split(':')[0];
              if (lidUser && pnUser) {
                this._lidToPn.set(lidUser, pnUser);
                this._pnToLid.set(pnUser, lidUser);
                if (this._signal && this._signal.store && this._signal.store.setLidMapping) {
                  this._signal.store.setLidMapping(pnUser, lidUser);
                }
              }
            }
          }
        }

        // Seed TcTokenStore from history — populates trusted-contact tokens
        // for all existing conversations so the first send after reconnect
        // already carries a valid <tctoken> node (avoids error 463 on cold start).
        this._seedTcTokensFromHistory(result.merged);

        this.emit('history_sync', result);
      })
      .catch(err => {
        _whaDbg('[DBG] HIST_SYNC_ERR ' + (err && err.message));
        this.emit('history_sync_error', { err, notification });
      });
  }

  /**
   * _seedTcTokensFromHistory — called after each history sync chunk.
   *
   * Reads tcToken/tcTokenTimestamp/tcTokenSenderTimestamp from the merged
   * history store and loads them into TcTokenStore so that the first outbound
   * DM after reconnect already has a valid <tctoken> node attached.
   *
   * Without this, TcTokenStore starts empty on every new connection and the
   * first send to every existing contact is treated as an anonymous reach-out
   * by the WhatsApp server, accumulating toward the error-463 timelock.
   *
   * Rules:
   *  - Only seeds tokens that are not already in TcTokenStore (existing entry wins).
   *  - Skips expired tokens (no point loading a token we'd immediately discard).
   *  - Storage key follows TcTokenStore convention: normalized bare JID.
   *    For LID chats (jid ends in @lid) we use the lid JID directly.
   *    For PN chats we try to look up the LID first (Baileys always stores under LID).
   *
   * @param {object|null} merged  - Return value of mergeHistoryToStore()
   */
  _seedTcTokensFromHistory(merged) {
    if (!merged || !merged.chats) return;
    if (!this._tcTokenStore) return;

    const { normalizeJidForTcToken, tcTokenExpired } = require('./messages/TcTokenStore');

    let seeded = 0;
    for (const [jid, chat] of Object.entries(merged.chats)) {
      // Only chats that actually have a token stored from history
      if (!chat.tcToken) continue;

      // Convert base64 string back to Buffer (mergeHistoryToStore stores as base64)
      const tokenBuf = Buffer.from(chat.tcToken, 'base64');
      if (!tokenBuf.length) continue;

      const ts       = chat.tcTokenTimestamp      || 0;
      const senderTs = chat.tcTokenSenderTimestamp || 0;

      // Skip already-expired tokens — no use loading them
      if (tcTokenExpired(ts)) {
        _whaDbg('[DBG] SEED_TCTOKEN skip expired jid=' + jid + ' ts=' + ts);
        continue;
      }

      // Resolve storage JID: Baileys always stores under LID.
      // If this chat is a @lid jid, use it directly.
      // If it's a PN jid, try to find its LID counterpart.
      let storageJid;
      if (jid.endsWith('@lid')) {
        storageJid = normalizeJidForTcToken(jid);
      } else {
        const pnUser  = jid.split('@')[0].split(':')[0];
        const lidUser = this._pnToLid && this._pnToLid.get(pnUser);
        storageJid    = lidUser
          ? normalizeJidForTcToken(lidUser + '@lid')
          : normalizeJidForTcToken(jid);
      }

      // Don't overwrite a token that was already fetched live this session
      const existing = this._tcTokenStore.get(storageJid);
      if (existing && existing.token && existing.token.length &&
          !tcTokenExpired(existing.timestamp)) {
        _whaDbg('[DBG] SEED_TCTOKEN skip existing jid=' + storageJid);
        continue;
      }

      // Set token + senderTimestamp atomically via the two TcTokenStore setters
      this._tcTokenStore.setToken(storageJid, tokenBuf, ts);
      if (senderTs) {
        this._tcTokenStore.setSenderTimestamp(storageJid, senderTs);
      }
      seeded++;
      _whaDbg('[DBG] SEED_TCTOKEN seeded jid=' + storageJid +
        ' ts=' + ts + ' senderTs=' + senderTs + ' len=' + tokenBuf.length);
    }

    if (seeded > 0) {
      _whaDbg('[DBG] SEED_TCTOKEN total seeded=' + seeded + ' from history');
    }
  }

  /**
   * _handleAppStateSyncKeyShare — saves app-state sync keys received in a
   * ProtocolMessage (type=5 APP_STATE_SYNC_KEY_SHARE).
   * These keys are needed to decrypt app-state patches in _syncAppState.
   *
   * @param {object} keyShare  Decoded AppStateSyncKeyShare { keys: [...] }
   */
  _handleAppStateSyncKeyShare(keyShare) {
    if (!keyShare || !keyShare.keys || !keyShare.keys.length) return;
    const phone      = this._store && this._store.phoneNumber;
    const sessionDir = this._sessionDir;

    _whaDbg('[DBG] APP_STATE_KEY_SHARE keys=' + keyShare.keys.length);

    try {
      saveAppStateSyncKeys(sessionDir, phone, keyShare);
    } catch (e) {
      _whaDbg('[DBG] APP_STATE_KEY_SHARE_SAVE_ERR ' + e.message);
    }

    this.emit('app_state_keys', { keys: keyShare.keys });
  }

  /**
   * _handleMdMsgHistNotification — called when server sends a
   * <notification type="md-msg-hist"> node.
   *
   * On mobile WhatsApp the primary history sync path is via encrypted DM
   * protocol messages (HistorySyncNotification inside a ProtocolMessage type=6).
   * This handler covers the secondary path where the server delivers the
   * notification inline inside the notification node itself with an <enc> child,
   * or simply signals availability so we emit the event.
   *
   * @param {object} node  Full BinaryNode of the notification
   */
  _handleMdMsgHistNotification(node) {
    if (!node) return;
    const attrs = node.attrs || {};

    _whaDbg('[DBG] MD_MSG_HIST from=' + (attrs.from || '') + ' id=' + (attrs.id || ''));

    // Check for inline HistorySyncNotification bytes in an <enc> child
    // (some server versions deliver it this way)
    const encNode = findChild(node, 'enc');
    if (encNode) {
      const encBuf = Buffer.isBuffer(encNode.content)
        ? encNode.content
        : (encNode.content ? Buffer.from(encNode.content) : null);

      if (encBuf && encBuf.length > 0) {
        // Try to decode directly as HistorySyncNotification (unencrypted path)
        try {
          const notification = decodeHistorySyncNotification(encBuf);
          if (notification && (notification.directPath || notification.initialHistBootstrapInlinePayload)) {
            _whaDbg('[DBG] MD_MSG_HIST inline notification directPath=' + notification.directPath);
            this._handleHistorySync(notification, attrs.id || 'md-msg-hist');
            return;
          }
        } catch (_) {}
      }
    }

    // Emit raw event for the caller to inspect if needed
    this.emit('md_msg_hist', { node, attrs });
  }

  /**
   * getHistoryStore — load the persisted history store for this phone.
   * Returns the parsed {phone}.history.json content or null if not yet synced.
   *
   * @returns {object|null}
   */
  getHistoryStore() {
    if (!this._store || !this._store.phoneNumber) return null;
    const fs   = require('fs');
    const file = require('path').join(this._sessionDir, this._store.phoneNumber + '.history.json');
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { return null; }
  }

  /**
   * getMessagesStore — load the persisted messages for this phone.
   * Returns the parsed {phone}.messages.json content or null if not yet synced.
   *
   * @returns {object|null}
   */
  getMessagesStore() {
    if (!this._store || !this._store.phoneNumber) return null;
    const fs   = require('fs');
    const file = require('path').join(this._sessionDir, this._store.phoneNumber + '.messages.json');
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { return null; }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  // Alias kept from the original API — setOnline is the implementation.
  setPresence(available) {
    return this.setOnline(available);
  }

  // Mark messages as read — the sender's two blue ticks.
  //
  // jid        chat the messages are in (the group JID for a group)
  // messageIds one id or an array of ids, all from the SAME sender
  // opts       { participant, type } — participant is who sent them and is
  //            required in a group; type may be 'read' (default) or 'played'
  //            to mark a voice note as listened to.
  //
  // Shaped the way whatsmeow's MarkRead builds it: the FIRST id on the receipt
  // and the rest as <item> children of a <list> node. whalibmob used the last id
  // and put the items straight into <receipt>, which is not a shape the server
  // reads back — the extra ids were silently ignored, so only one message per
  // call was ever marked. The participant was missing entirely, so a group read
  // never told the server whose message had been read.
  markRead(jid, messageIds, opts) {
    if (!this._socket || !this._connected) return;
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(String).filter(Boolean);
    if (ids.length === 0) return;

    opts = opts || {};
    const chatJid = makeJid(jid);
    const isGroup = chatJid.endsWith('@g.us') || chatJid.endsWith('@community')
      || chatJid.endsWith('@broadcast');

    const attrs = {
      id:   ids[0],
      type: this._readReceiptType(opts.type === 'played' ? 'played' : 'read'),
      to:   jidStrToObj(chatJid),
      t:    String(Math.floor(Date.now() / 1000))
    };
    // Only group and broadcast receipts carry a participant; on a 1:1 chat the
    // `to` already identifies the sender.
    if (isGroup && opts.participant) {
      attrs.participant = jidStrToObj(makeJid(opts.participant));
    }

    const children = ids.length > 1
      ? [new BinaryNode('list', {}, ids.slice(1).map(
          id => new BinaryNode('item', { id }, null)))]
      : null;

    this._socket.sendNode(new BinaryNode('receipt', attrs, children));
  }

  async sendText(to, text, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendText(to, text, opts);
  }

  async sendImage(to, data, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendImage(to, data, opts);
  }

  async sendVideo(to, data, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendVideo(to, data, opts);
  }

  async sendAudio(to, data, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendAudio(to, data, opts);
  }

  async sendDocument(to, data, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendDocument(to, data, opts);
  }

  async sendSticker(to, data, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendSticker(to, data, opts);
  }

  async sendReaction(to, messageId, emoji, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendReaction(to, messageId, emoji, opts);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRESENCE
  // ──────────────────────────────────────────────────────────────────────────

  // Our own JID in the family a chat is addressed with — the LID when the chat
  // is LID-addressed, the phone JID otherwise. chatstate carries a `from`, and
  // it has to be in the same space as the `to` beside it.
  _ownJidFor(chatJid) {
    const str = String(chatJid || '');
    if (str.endsWith('@lid') && this._myLid) {
      return String(this._myLid).split('@')[0].split(':')[0] + '@lid';
    }
    return String(this._store && this._store.phoneNumber) + '@s.whatsapp.net';
  }

  // Set global online/offline status.
  //
  // whatsmeow refuses to send this without a push name (ErrNoPushName): the
  // server takes the display name from this node, and sending it empty makes
  // every other user see "-" instead of a name. Going available also flips the
  // client into sending active delivery receipts — see _sendDeliveryReceipt.
  //
  // Returns true when the node went out, false when it was skipped.
  setOnline(available) {
    if (!this._socket || !this._connected) return false;
    const name = (this._store && (this._store.pushName || this._store.name)) || '';
    if (!name) {
      _whaDbg('[DBG] PRESENCE skipped: no push name set — other users would see "-"');
      return false;
    }
    this._sendActiveReceipts = !!available;
    this._socket.sendNode(new BinaryNode('presence', {
      name,
      type: available ? 'available' : 'unavailable'
    }, null));
    return true;
  }

  // Set typing/recording presence in a specific chat.
  // presence: 'composing' | 'paused' | 'recording'
  //
  // whatsmeow's SendChatPresence puts both `from` (our own JID) and `to` on the
  // chatstate node and expresses recording as composing with media="audio" —
  // there is no separate recording state in the protocol. The `from` was missing
  // here, and both JIDs were raw strings, which the server ignores for @lid
  // chats, so the indicator never showed for a LID-addressed contact.
  setChatPresence(chatJid, presence) {
    if (!this._socket || !this._connected) return;
    const jid   = makeJid(chatJid);
    const attrs = {
      from: jidStrToObj(this._ownJidFor(jid)),
      to:   jidStrToObj(jid)
    };
    if (presence === 'composing' || presence === 'recording') {
      const stateAttrs = presence === 'recording' ? { media: 'audio' } : {};
      this._socket.sendNode(new BinaryNode('chatstate', attrs, [
        new BinaryNode('composing', stateAttrs, null)
      ]));
    } else {
      this._socket.sendNode(new BinaryNode('chatstate', attrs, [
        new BinaryNode('paused', {}, null)
      ]));
    }
  }

  // Subscribe to presence updates for contacts.
  //
  // whatsmeow attaches the contact's privacy token when it has one; without it
  // the server may decline to send their presence. It also notes that the server
  // only forwards presence to clients that have marked themselves available, so
  // call setOnline(true) first.
  subscribeToPresence(jids) {
    if (!this._socket || !this._connected) return;
    const arr = Array.isArray(jids) ? jids : [jids];
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
    for (const raw of arr) {
      const jid   = makeJid(raw);
      const entry = this._tcTokenStore && this._tcTokenStore.get(
        normalizeJidForTcToken(jid)
      );
      const children = (entry && entry.token && entry.token.length)
        ? [new BinaryNode('tctoken', {}, entry.token)]
        : null;
      this._socket.sendNode(new BinaryNode('presence', {
        to:   jidStrToObj(jid),
        type: 'subscribe'
      }, children));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PROFILE — hasWhatsapp, queryAbout, queryPicture, changeName, changeAbout,
  //           changeProfilePicture, changePrivacySetting
  // ──────────────────────────────────────────────────────────────────────────

  // Check which phone numbers have WhatsApp)
  // jids: array of phone numbers or JIDs like '123456789' or '123@s.whatsapp.net'
  // Returns array of JIDs that have WhatsApp
  async hasWhatsapp(jids) {
    const arr = Array.isArray(jids) ? jids : [jids];
    const userNodes = arr.map(j => {
      const phone = String(j).replace(/@.*$/, '').replace(/\D/g, '');
      return new BinaryNode('user', {}, [
        new BinaryNode('contact', {}, Buffer.from('+' + phone, 'utf8'))
      ]);
    });
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'get',
      xmlns: 'usync'
    }, [
      new BinaryNode('usync', {
        sid:     this._genMsgId(),
        mode:    'query',
        last:    'true',
        index:   '0',
        context: 'interactive'
      }, [
        new BinaryNode('query', {}, [new BinaryNode('contact', {}, null)]),
        new BinaryNode('list',  {}, userNodes),
        new BinaryNode('side_list', {}, null)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return [];
    const usync = findChild(resp, 'usync');
    if (!usync) return [];
    const list = findChild(usync, 'list');
    if (!list || !Array.isArray(list.content)) return [];
    return list.content
      .filter(u => {
        if (!u || u.description !== 'user') return false;
        const ct = findChild(u, 'contact');
        return ct && ct.attrs && ct.attrs.type === 'in';
      })
      .map(u => u.attrs && u.attrs.jid)
      .filter(Boolean);
  }

  // Query bio/status text of a contact
  async queryAbout(jid) {
    const jidFull = makeJid(jid);
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'get',
      xmlns: 'usync'
    }, [
      new BinaryNode('usync', {
        sid:     this._genMsgId(),
        mode:    'query',
        last:    'true',
        index:   '0',
        context: 'interactive'
      }, [
        new BinaryNode('query', {}, [new BinaryNode('status', {}, null)]),
        new BinaryNode('list',  {}, [new BinaryNode('user', { jid: jidFull }, null)]),
        new BinaryNode('side_list', {}, null)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const usync = findChild(resp, 'usync');
    if (!usync) return null;
    const list = findChild(usync, 'list');
    if (!list || !Array.isArray(list.content)) return null;
    for (const user of list.content) {
      const st = findChild(user, 'status');
      if (st) {
        const buf = getNodeContent(st);
        return buf ? buf.toString('utf8') : null;
      }
    }
    return null;
  }

  // Query profile picture URL
  // Profile picture URL, or null when there is none.
  // Unchanged signature; queryPictureInfo has the rest of what the server sends.
  async queryPicture(jid, opts) {
    const info = await this.queryPictureInfo(jid, opts);
    return (info && info.url) || null;
  }

  // Full profile picture info, the way whatsmeow's GetProfilePictureInfo returns
  // it: { id, url, type, directPath, hash }, or null when the user has no
  // picture or it has not changed since opts.existingId.
  //
  // opts: { preview, existingId, isCommunity }
  //   preview     ask for the small thumbnail instead of the full image
  //   existingId  the id you already hold — the server answers 304 and this
  //               returns null when it still matches
  //   isCommunity resolve a community's picture, which goes through w:g2
  //
  // The target was a raw string before, which the server drops for an @lid, and
  // the reply's status codes were not read at all: a 204 (no picture set) has no
  // url attribute, so it came back as null with no way to tell it apart from a
  // failed query.
  async queryPictureInfo(jid, opts) {
    opts = opts || {};
    const jidFull = makeJid(jid);
    const attrs = {
      query: 'url',
      type:  opts.preview ? 'preview' : 'image'
    };
    if (opts.existingId) attrs.id = String(opts.existingId);
    if (opts.inviteCode) attrs.invite = String(opts.inviteCode);

    let iqAttrs, content;
    if (opts.isCommunity) {
      attrs.parent_group_jid = jidStrToObj(jidFull);
      iqAttrs = { id: this._genMsgId(), xmlns: 'w:g2', to: jidStrToObj(jidFull), type: 'get' };
      content = [new BinaryNode('pictures', {}, [new BinaryNode('picture', attrs, null)])];
    } else {
      const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
      const entry = this._tcTokenStore &&
        this._tcTokenStore.get(normalizeJidForTcToken(jidFull));
      const picChildren = (entry && entry.token && entry.token.length)
        ? [new BinaryNode('tctoken', {}, entry.token)]
        : null;
      iqAttrs = {
        id:     this._genMsgId(),
        xmlns:  'w:profile:picture',
        to:     's.whatsapp.net',
        target: jidStrToObj(jidFull),
        type:   'get'
      };
      content = [new BinaryNode('picture', attrs, picChildren)];
    }

    const resp = await this._sendIq(new BinaryNode('iq', iqAttrs, content));
    if (!resp) return null;
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && String(errNode.attrs.code);
      // 404 = no picture set, 401/403 = their privacy settings hide it. Neither
      // is a failure worth throwing over.
      if (code === '404' || code === '401' || code === '403') return null;
      throw new Error('queryPictureInfo: server rejected the request' +
        (code ? ' (' + code + ')' : ''));
    }

    const wrapper = opts.isCommunity ? findChild(resp, 'pictures') : resp;
    const pic = wrapper ? findChild(wrapper, 'picture') : null;
    if (!pic || !pic.attrs) return null;

    const status = pic.attrs.status ? parseInt(pic.attrs.status, 10) : 0;
    if (status === 304 || status === 204) return null;   // unchanged / not set

    return {
      id:         pic.attrs.id         ? String(pic.attrs.id)         : null,
      url:        pic.attrs.url        ? String(pic.attrs.url)        : null,
      type:       pic.attrs.type       ? String(pic.attrs.type)       : null,
      directPath: pic.attrs.direct_path ? String(pic.attrs.direct_path) : null,
      hash:       pic.attrs.hash
        ? Buffer.from(String(pic.attrs.hash), 'base64')
        : null
    };
  }

  // Download a profile picture and hand back the JPEG bytes, or null when the
  // user has none. Profile pictures are served unencrypted, unlike message
  // media, so this is a plain fetch of the URL the query returns.
  async downloadProfilePicture(jid, opts) {
    const info = await this.queryPictureInfo(jid, opts);
    if (!info || !info.url) return null;
    const { httpGetBuffer } = require('./MediaService');
    return httpGetBuffer(info.url);
  }

  // Parse the <list> a blocklist query or update comes back with.
  //
  // whatsmeow's parseBlocklist walks every child and takes its jid, without
  // caring what the tag is called, and keeps the dhash off the list itself.
  // The JIDs are stringified here: the binary decoder hands them back as JID
  // objects, and while those print correctly they are not strings, so the array
  // this used to return failed any includes() or === against a JID string —
  // which is exactly what the documented shape invites you to do.
  _parseBlocklist(listNode) {
    const jids = [];
    if (listNode && Array.isArray(listNode.content)) {
      for (const child of listNode.content) {
        if (!child || !child.attrs || !child.attrs.jid) continue;
        jids.push(String(child.attrs.jid));
      }
    }
    const dhash = (listNode && listNode.attrs && listNode.attrs.dhash)
      ? String(listNode.attrs.dhash) : null;
    return { dhash, jids };
  }

  // Query blocked contacts list. Returns an array of JID strings; never throws,
  // an unreachable server yields an empty list.
  async queryBlockList() {
    const id   = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'blocklist',
      to:    's.whatsapp.net',
      type:  'get'
    }, null);
    const resp = await this._sendIq(node);
    if (!resp) return [];
    if (resp.attrs && resp.attrs.type === 'error') return [];
    return this._parseBlocklist(findChild(resp, 'list')).jids;
  }

  // Change display name
  // Sends presence node with new name — immediate, no IQ needed.
  changeName(name) {
    if (!this._socket || !this._connected) throw new Error('Not connected');
    this._socket.sendNode(new BinaryNode('presence', {
      name,
      type: 'available'
    }, null));
    if (this._store) this._store.pushName = name;
  }

  // Change bio/about text
  async changeAbout(text) {
    const id   = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'status',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('status', {}, Buffer.from(text, 'utf8'))
    ]);
    return this._sendIq(node);
  }

  // Change profile picture
  // buf: Buffer with JPEG image data
  async changeProfilePicture(buf) {
    if (!this._store) throw new Error('Not connected');
    const selfJid = `${this._store.phoneNumber}@s.whatsapp.net`;
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:profile:picture',
      to:    selfJid,
      type:  'set'
    }, [
      new BinaryNode('picture', { type: 'image' }, buf)
    ]);
    return this._sendIq(node);
  }

  // ─── Privacy settings ─────────────────────────────────────────────────────

  // Read the current privacy settings.
  //
  // Returns { lastSeen, profile, status, online, readReceipts, groupAdd,
  //           callAdd, messages, defense, stickers } — any the server did not
  // report come back null. Served from cache unless opts.force is set.
  //
  // There was no way to read these at all before, which also meant nothing
  // could act on them; see markRead for what that cost.
  async queryPrivacySettings(opts) {
    opts = opts || {};
    if (this._privacySettings && !opts.force) return this._privacySettings;

    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'privacy',
      to:    's.whatsapp.net',
      type:  'get'
    }, [new BinaryNode('privacy', {}, null)]);

    const resp = await this._sendIq(node);
    if (!resp) throw new Error('queryPrivacySettings: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('queryPrivacySettings: server rejected the request' +
        (code ? ' (' + code + ')' : ''));
    }
    const privacyNode = findChild(resp, 'privacy');
    this._privacySettings = this._parsePrivacySettings(privacyNode);
    return this._privacySettings;
  }

  // <privacy><category name="..." value="..."/>...</privacy>
  _parsePrivacySettings(privacyNode) {
    const out = {};
    for (const key of Object.keys(PRIVACY_WIRE_TO_KEY)) out[PRIVACY_WIRE_TO_KEY[key]] = null;
    if (privacyNode && Array.isArray(privacyNode.content)) {
      for (const child of privacyNode.content) {
        if (!child || child.description !== 'category' || !child.attrs) continue;
        const key = PRIVACY_WIRE_TO_KEY[String(child.attrs.name)];
        if (key) out[key] = child.attrs.value ? String(child.attrs.value) : null;
      }
    }
    return out;
  }

  // Change a privacy setting. Returns the settings as they now stand.
  //
  // type:  'last_seen' | 'profile_picture' | 'status' | 'online' |
  //        'read_receipts' | 'groups_add' | 'call_add' | 'messages' |
  //        'defense' | 'stickers'   (the protocol's own spellings work too)
  // value: 'all' | 'contacts' | 'contact_blacklist' | 'contact_allowlist' |
  //        'none' | 'match_last_seen' | 'known' | 'on_standard' | 'off'
  // excluded: JIDs to exclude — see the note below
  //
  // The names above are friendly aliases. What goes on the wire is what
  // whatsmeow sends: last, profile, status, online, readreceipts, groupadd,
  // calladd, messages, defense, stickers. Four of the six names this used to
  // put on the wire — last_seen, profile_picture, read_receipts, groups_add —
  // are not names the server knows, so those settings never changed and the
  // discarded reply meant it never said so either.
  async changePrivacySetting(type, value, excluded) {
    const name = PRIVACY_NAME_ALIASES[String(type)];
    if (!name) {
      throw new Error('changePrivacySetting: unknown setting "' + type + '" — one of ' +
        Object.keys(PRIVACY_NAME_ALIASES).join(', '));
    }

    // Neither whatsmeow nor WhatsApp Web puts <user> children on this IQ; the
    // exclusion list is maintained separately. Kept for callers that pass it,
    // and only emitted when they do.
    const children = [];
    if (excluded && excluded.length > 0) {
      for (const jid of excluded) {
        children.push(new BinaryNode('user', { jid: jidStrToObj(toNonAdJid(makeJid(jid))) }, null));
      }
    }

    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'privacy',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('privacy', {}, [
        new BinaryNode('category', { name, value: String(value) },
          children.length > 0 ? children : null)
      ])
    ]);

    const resp = await this._sendIq(node);
    if (!resp) throw new Error('changePrivacySetting: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error('changePrivacySetting: server rejected ' + name + '=' + value +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }

    // whatsmeow folds the change into its cached copy and hands the whole thing
    // back rather than making the caller re-query.
    const key = PRIVACY_WIRE_TO_KEY[name];
    this._privacySettings = Object.assign({}, this._privacySettings || {},
      { [key]: String(value) });
    return this._privacySettings;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MESSAGING — editMessage, deleteMessage, sendStatus, forwardMessage
  // ──────────────────────────────────────────────────────────────────────────

  // Edit a sent message
  async editMessage(origMsgId, chatJid, newText, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.editMessage(origMsgId, chatJid, newText, opts);
  }

  // Delete a message
  // fromMe: whether the message was sent by us
  // forEveryone: true = revoke for all, false = delete locally only
  async deleteMessage(origMsgId, chatJid, fromMe, forEveryone, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.deleteMessage(origMsgId, chatJid, fromMe, forEveryone, opts);
  }

  // ─── Status / Stories ─────────────────────────────────────────────────────

  // Who your Status posts go to.
  //
  // Returns [{ type, isDefault, list }] with the default first, as whatsmeow's
  // GetStatusPrivacy does. type is 'contacts', 'blacklist' or 'whitelist'; list
  // holds the JIDs the last two are built from. A server that has never been
  // told otherwise answers nothing, which means the default: all contacts.
  async queryStatusPrivacy() {
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'status',
      to:    's.whatsapp.net',
      type:  'get'
    }, [new BinaryNode('privacy', {}, null)]);

    const resp = await this._sendIq(node);
    if (!resp || (resp.attrs && resp.attrs.type === 'error')) {
      return [{ type: 'contacts', isDefault: true, list: [] }];
    }

    const privacyNode = findChild(resp, 'privacy');
    const out = [];
    if (privacyNode && Array.isArray(privacyNode.content)) {
      for (const listNode of privacyNode.content) {
        if (!listNode || listNode.description !== 'list' || !listNode.attrs) continue;
        const entry = {
          type:      listNode.attrs.type ? String(listNode.attrs.type) : 'contacts',
          isDefault: String(listNode.attrs.default) === 'true',
          list:      []
        };
        if (Array.isArray(listNode.content)) {
          for (const u of listNode.content) {
            if (u && u.description === 'user' && u.attrs && u.attrs.jid) {
              entry.list.push(String(u.attrs.jid));
            }
          }
        }
        // The default is always reported first.
        if (entry.isDefault) out.unshift(entry); else out.push(entry);
      }
    }
    return out.length ? out : [{ type: 'contacts', isDefault: true, list: [] }];
  }

  // Resolve the status privacy settings into the JIDs a post actually goes to,
  // the way whatsmeow's getStatusBroadcastRecipients does: a whitelist is the
  // list itself, anything else is every known contact minus the blacklist, and
  // our own JID is added so the post lands on our own devices too.
  //
  // Contacts come from the synced history store — this client has no separate
  // contact database — so a session that has not synced history yet has to be
  // given the list explicitly.
  async _getStatusRecipients() {
    let privacy;
    try {
      privacy = (await this.queryStatusPrivacy())[0];
    } catch (_) {
      privacy = { type: 'contacts', list: [] };
    }

    const ownJid = String(this._store.phoneNumber) + '@s.whatsapp.net';
    let recipients;

    if (privacy.type === 'whitelist') {
      recipients = privacy.list.slice();
    } else {
      const hist = this.getHistoryStore();
      const contacts = (hist && hist.contacts) ? Object.keys(hist.contacts) : [];
      // Only real contacts — an entry the history sync created purely to hold a
      // push name is not somebody you have in your address book.
      const named = contacts.filter(jid => {
        const c = hist.contacts[jid];
        return c && (c.name || c.displayName) && !jid.endsWith('@g.us') &&
          !jid.endsWith('@broadcast');
      });
      const blocked = new Set(privacy.type === 'blacklist' ? privacy.list : []);
      recipients = named.filter(jid => !blocked.has(jid));
    }

    if (!recipients.some(j => this._isOwnUser(j))) recipients.push(ownJid);
    _whaDbg('[DBG] STATUS_RECIPIENTS type=' + privacy.type +
      ' count=' + recipients.length);
    return recipients;
  }

  // Post a Status/Story.
  //
  //   sendStatus('Good morning!')                       text
  //   sendStatus({ image: './a.jpg', caption: 'hi' })   photo
  //   sendStatus({ video: './v.mp4' })                  video
  //   sendStatus({ audio: './v.ogg' })                  voice
  //
  // opts (also accepted as fields of the object form):
  //   recipients      post to these JIDs instead of the privacy-derived list
  //   backgroundArgb  background colour of a text status, e.g. 0xFF25D366
  //   textArgb, font  the rest of a text status' styling
  //
  // Text posted with a background or font becomes an ExtendedTextMessage, which
  // is what carries them; plain text stays a plain conversation.
  async sendStatus(content, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    opts = Object.assign({},
      (content && typeof content === 'object') ? content : {},
      opts || {});

    const recipients = opts.recipients || opts.statusJidList ||
      await this._getStatusRecipients();
    const sendOpts = Object.assign({}, opts, { _statusRecipients: recipients });

    if (opts.image) return this._sender.sendImage(STATUS_BROADCAST_JID, opts.image, sendOpts);
    if (opts.video) return this._sender.sendVideo(STATUS_BROADCAST_JID, opts.video, sendOpts);
    if (opts.audio) return this._sender.sendAudio(STATUS_BROADCAST_JID, opts.audio, sendOpts);

    const text = (typeof content === 'string') ? content : (opts.text || opts.caption || '');
    const styled = opts.backgroundArgb != null || opts.textArgb != null || opts.font != null;
    if (!styled) return this._sender.sendText(STATUS_BROADCAST_JID, text, sendOpts);

    const { encodeMessage, encodeExtendedText } = require('./proto/MessageProto');
    const buf = encodeMessage('extendedText', encodeExtendedText(text, {
      backgroundArgb: opts.backgroundArgb,
      textArgb:       opts.textArgb,
      font:           opts.font
    }));
    return this._sender._sendMessage(STATUS_BROADCAST_JID,
      generateMessageId(), buf, 'text', sendOpts);
  }

  // Forward a message
  // If msg is a string, forward as text.
  // If msg is a decoded message object (from the 'message' event), re-encode the original
  // media/text without re-uploading.
  async forwardMessage(to, msg, contextInfo) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    if (typeof msg === 'string') {
      const ctx = Object.assign({ forwardingScore: 1, isForwarded: true }, contextInfo || {});
      return this._sender.sendText(to, msg, { contextInfo: ctx });
    }
    return this._sender.forwardDecodedMessage(to, msg, { contextInfo: contextInfo || {} });
  }

  // ─── Poll ─────────────────────────────────────────────────────────────────
  //
  // Send a WhatsApp poll (PollCreationMessage).
  // options: array of strings (the answer choices)
  // selectableCount: how many options a voter may pick (0 = any number)
  // opts.id: pre-set message ID
  // Returns: { id, encKey } — encKey is a 32-byte Buffer needed to decrypt votes
  async sendPoll(to, question, options, selectableCount, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendPoll(to, question, options, selectableCount, opts);
  }

  // ─── Location ─────────────────────────────────────────────────────────────
  // sendLocation(to, latitude, longitude, opts)
  // opts: { name, address, url, id, contextInfo }
  async sendLocation(to, latitude, longitude, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendLocation(to, latitude, longitude, opts);
  }

  // ─── Contact (vCard) ──────────────────────────────────────────────────────
  // sendContact(to, displayName, vcard, opts)
  // vcard is a vCard v3 string  e.g. "BEGIN:VCARD\nVERSION:3.0\nFN:Ion Popescu\nTEL:+40712345678\nEND:VCARD"
  async sendContact(to, displayName, vcard, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendContact(to, displayName, vcard, opts);
  }

  // sendReply(to, quotedMsgId, senderJid, text, opts)
  // Sends a text message that quotes/replies to another message.
  // senderJid — JID of the original sender (same as `to` for DMs; member JID for groups).
  async sendReply(to, quotedMsgId, senderJid, text, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendReply(to, quotedMsgId, senderJid, text, opts);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BUSINESS PROFILE — queryBusinessProfile
  // Query business profile (IQ xmlns: w:biz)
  // Returns: { jid, description, email, website, address, category, hours... }
  //          or null if not a business account / no data
  // ──────────────────────────────────────────────────────────────────────────

  async queryBusinessProfile(jid) {
    const jidFull = makeJid(jid);
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:biz',
      to:    's.whatsapp.net',
      type:  'get'
    }, [
      new BinaryNode('business_profile', { v: '116' }, [
        new BinaryNode('profile', { value: jidFull }, null)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const bpNode = findChild(resp, 'business_profile');
    if (!bpNode) return null;
    const pNode = findChild(bpNode, 'profile');
    if (!pNode || !pNode.attrs) return null;
    const a = pNode.attrs;
    const children = Array.isArray(pNode.content) ? pNode.content : [];
    const description = (() => {
      const n = children.find(c => c && c.description === 'description');
      return n ? (getNodeContent(n) || Buffer.alloc(0)).toString('utf8') : null;
    })();
    const email = a.email || null;
    const website = a.website || null;
    const address = a.address || null;
    const category = a.business_type || a.category || null;
    return { jid: jidFull, description, email, website, address, category };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COMMUNITY OPERATIONS — createCommunity / deactivateCommunity /
  //   linkGroupsToCommunity / unlinkGroupFromCommunity
  // Protocol: IQ xmlns='w:g2' — same server as groups (g.us)
  // ──────────────────────────────────────────────────────────────────────────

  // Create a community
  // Returns parsed metadata object (same shape as getGroupMetadata) or null
  async createCommunity(subject, description, opts) {
    opts = opts || {};
    const descId = crypto.randomBytes(12).toString('hex');
    const id     = this._genMsgId();
    const createChildren = [
      new BinaryNode('description', { id: descId }, [
        new BinaryNode('body', {}, Buffer.from(description || '', 'utf8'))
      ]),
      new BinaryNode('parent', { default_membership_approval_mode: 'request_required' }, null),
      new BinaryNode('allow_non_admin_sub_group_creation', {}, null),
      new BinaryNode('create_general_chat', {}, null)
    ];
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'set'
    }, [new BinaryNode('create', { subject }, createChildren)]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const createNode = findChild(resp, 'create');
    const groupNode  = createNode ? findChild(createNode, 'group') : findChildDeep(resp, 'group');
    if (!groupNode) return null;
    return this._parseGroupNode(groupNode);
  }

  // Deactivate (delete) a community
  async deactivateCommunity(communityJid) {
    const jid = makeJid(communityJid);
    const id  = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jid,
      type:  'set'
    }, [new BinaryNode('delete_parent', {}, null)]);
    return this._sendIq(node);
  }

  // Link one or more groups to a community
  // groupJids: string or string[]
  // Returns: array of successfully linked group JIDs
  async linkGroupsToCommunity(communityJid, groupJids) {
    const cJid  = makeJid(communityJid);
    const arr   = Array.isArray(groupJids) ? groupJids : [groupJids];
    const id    = this._genMsgId();
    const groupNodes = arr.map(gj =>
      new BinaryNode('group', { value: makeJid(gj) }, null)
    );
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    cJid,
      type:  'set'
    }, [
      new BinaryNode('links', {}, [
        new BinaryNode('link', { link_type: 'sub_group' }, groupNodes)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return [];
    const linksNode = findChild(resp, 'links');
    if (!linksNode || !Array.isArray(linksNode.content)) return arr.map(makeJid);
    const linked = [];
    for (const linkNode of linksNode.content) {
      if (linkNode && linkNode.description === 'link' &&
          linkNode.attrs && linkNode.attrs.link_type === 'sub_group') {
        const kids = Array.isArray(linkNode.content) ? linkNode.content : [];
        for (const gn of kids) {
          if (gn && gn.description === 'group' && gn.attrs && gn.attrs.value) {
            linked.push(gn.attrs.value);
          }
        }
      }
    }
    return linked.length ? linked : arr.map(makeJid);
  }

  // Unlink a group from a community
  async unlinkGroupFromCommunity(communityJid, groupJid) {
    const cJid = makeJid(communityJid);
    const gJid = makeJid(groupJid);
    const id   = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    cJid,
      type:  'set'
    }, [
      new BinaryNode('unlink', { unlink_type: 'sub_group' }, [
        new BinaryNode('group', { value: gJid }, null)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return false;
    const unlinkNode = findChild(resp, 'unlink');
    if (!unlinkNode) return false;
    const gn = findChild(unlinkNode, 'group');
    return !!(gn && gn.attrs && gn.attrs.value === gJid);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // NEWSLETTER (CHANNEL) OPERATIONS
  // All newsletter IQ calls use xmlns='w:mex' (WhatsApp Meta EXchange / GraphQL)
  // with hardcoded query_id values per operation.
  // The JSON body follows the WhatsApp newsletter request format.
  // ──────────────────────────────────────────────────────────────────────────

  // Create a newsletter / channel
  // query_id: 6996806640408138
  // Returns: { jid, name, description, subscriberCount } or null
  async createNewsletter(name, description) {
    const id   = this._genMsgId();
    const body = JSON.stringify({
      variables: {
        input: {
          name:        name || '',
          description: description || '',
          picture:     null
        }
      }
    });
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:mex',
      to:    's.whatsapp.net',
      type:  'get'
    }, [
      new BinaryNode('query', { query_id: '6996806640408138' },
        Buffer.from(body, 'utf8'))
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    return this._parseNewsletterResponse(resp);
  }

  // Join / subscribe to a newsletter
  // query_id: 9926858900719341
  async joinNewsletter(newsletterJid) {
    const jid  = makeJid(newsletterJid, 'newsletter');
    const id   = this._genMsgId();
    const body = JSON.stringify({ variables: { newsletter_id: jid } });
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:mex',
      to:    's.whatsapp.net',
      type:  'get'
    }, [
      new BinaryNode('query', { query_id: '9926858900719341' },
        Buffer.from(body, 'utf8'))
    ]);
    return this._sendIq(node);
  }

  // Leave / unsubscribe from a newsletter
  // query_id: 6392786840836363
  async leaveNewsletter(newsletterJid) {
    const jid  = makeJid(newsletterJid, 'newsletter');
    const id   = this._genMsgId();
    const body = JSON.stringify({ variables: { newsletter_id: jid } });
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:mex',
      to:    's.whatsapp.net',
      type:  'get'
    }, [
      new BinaryNode('query', { query_id: '6392786840836363' },
        Buffer.from(body, 'utf8'))
    ]);
    return this._sendIq(node);
  }

  // Query newsletter metadata
  // query_id: 6111171595650958
  // Returns: { jid, name, description, subscriberCount } or null
  async queryNewsletterMetadata(newsletterJid) {
    const jid  = makeJid(newsletterJid, 'newsletter');
    const id   = this._genMsgId();
    const body = JSON.stringify({ variables: { newsletter_id: jid } });
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:mex',
      to:    's.whatsapp.net',
      type:  'get'
    }, [
      new BinaryNode('query', { query_id: '6111171595650958' },
        Buffer.from(body, 'utf8'))
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    return this._parseNewsletterResponse(resp);
  }

  // Change newsletter description
  // query_id: 7150902998257522
  async changeNewsletterDescription(newsletterJid, description) {
    const jid  = makeJid(newsletterJid, 'newsletter');
    const id   = this._genMsgId();
    const body = JSON.stringify({
      variables: { newsletter_id: jid, updates: { description: description || '' } }
    });
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:mex',
      to:    's.whatsapp.net',
      type:  'get'
    }, [
      new BinaryNode('query', { query_id: '7150902998257522' },
        Buffer.from(body, 'utf8'))
    ]);
    return this._sendIq(node);
  }

  // Internal: parse newsletter response from w:mex IQ result
  _parseNewsletterResponse(resp) {
    try {
      const resultNode = findChild(resp, 'result');
      if (!resultNode) return null;
      const buf = getNodeContent(resultNode);
      if (!buf) return null;
      const json = JSON.parse(buf.toString('utf8'));
      const nl = json && (json.newsletter || (json.data && json.data.xwa2_newsletter));
      if (!nl) return null;
      const meta = nl.metadata || nl;
      return {
        jid:             nl.id || meta.jid || null,
        name:            meta.name || nl.name || null,
        description:     meta.description || nl.description || null,
        subscriberCount: nl.subscribers_count || meta.subscriber_count || 0,
        creationTime:    nl.creation_time || meta.creation_time || 0
      };
    } catch (_) {
      return null;
    }
  }

  // Send a text message to a newsletter you own
  // Newsletter messages are NOT end-to-end encrypted — they are public channel posts.
  // The stanza differs from regular messages: no <participants> or <enc>, uses
  // <plaintext-body> and carries server_id + edit attributes.
  async sendNewsletterText(newsletterJid, text) {
    if (!this._socket || !this._connected) throw new Error('Not connected');
    const jid    = makeJid(newsletterJid, 'newsletter');
    const msgId  = this._genMsgId();
    const nowSec = Math.floor(Date.now() / 1000);
    const node   = new BinaryNode('message', {
      id:        msgId,
      to:        jid,
      type:      'text',
      server_id: String(nowSec),
      edit:      '0'
    }, [
      new BinaryNode('plaintext-body', {}, Buffer.from(text, 'utf8'))
    ]);
    this._socket.sendNode(node);
    return { id: msgId, to: jid };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CHAT STATE — markChatRead, markChatUnread, muteChat, unmuteChat,
  //              pinChat, unpinChat, archiveChat, unarchiveChat,
  //              starMessage, unstarMessage, markMessagePlayed,
  //              blockContact, unblockContact, changeEphemeralTimer
  // ──────────────────────────────────────────────────────────────────────────

  // Mark entire chat as read — sends IQ to server (xmlns: 'w', count: '-1')
  async markChatRead(jid) {
    const jidFull = makeJid(jid);
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w'
    }, [
      new BinaryNode('read', { jid: jidFull, count: '-1', index: '0', owner: 'false' }, null)
    ]);
    const chat = this._getChatState(jid);
    chat.markedAsUnread = false;
    this.emit('chat_read', { jid: jidFull, read: true });
    return this._sendIq(node);
  }

  // Mark entire chat as unread — local state only (no WhatsApp server equivalent for mobile)
  markChatUnread(jid) {
    const chat = this._getChatState(makeJid(jid));
    chat.markedAsUnread = true;
    this.emit('chat_read', { jid: makeJid(jid), read: false });
  }

  // Mute a chat — sends IQ to server (xmlns: 'w:web')
  // durationMs: milliseconds, 0 or negative = mute indefinitely
  async muteChat(jid, durationMs) {
    const jidFull  = makeJid(jid);
    const muteEnd  = (durationMs && durationMs > 0)
      ? Math.floor((Date.now() + durationMs) / 1000)
      : 0;
    const id = this._genMsgId();
    const attrs = { jid: jidFull, add: '1' };
    if (muteEnd > 0) attrs.t = String(muteEnd);
    const node = new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:web'
    }, [new BinaryNode('mute', attrs, null)]);
    const chat = this._getChatState(jid);
    chat.muted       = true;
    chat.muteUntilMs = muteEnd > 0 ? (muteEnd * 1000) : -1;
    this.emit('chat_muted', { jid: jidFull, muted: true, until: chat.muteUntilMs });
    return this._sendIq(node);
  }

  // Unmute a chat — sends IQ to server (xmlns: 'w:web', add: '0')
  async unmuteChat(jid) {
    const jidFull = makeJid(jid);
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:web'
    }, [new BinaryNode('mute', { jid: jidFull, add: '0' }, null)]);
    const chat = this._getChatState(jid);
    chat.muted       = false;
    chat.muteUntilMs = 0;
    this.emit('chat_muted', { jid: jidFull, muted: false });
    return this._sendIq(node);
  }

  // Block a contact. Returns the updated block list.
  async blockContact(jid) {
    return this._updateBlocklist(jid, 'block');
  }

  // Unblock a contact. Returns the updated block list.
  async unblockContact(jid) {
    return this._updateBlocklist(jid, 'unblock');
  }

  // The one IQ behind both, as whatsmeow's UpdateBlocklist sends it:
  //
  //   <iq xmlns="blocklist" type="set" to="s.whatsapp.net">
  //     <item jid="<JID>" action="block|unblock"/>
  //   </iq>
  //
  // Three things were wrong with the pair this replaces. The jid went out as a
  // raw string rather than a binary JID. It was not reduced to its bare user
  // first, so blocking a contact you happened to name with a device suffix sent
  // the server a device JID it has nothing to block. And the reply was thrown
  // away without being looked at — including a type="error" reply — so a block
  // the server refused came back looking exactly like one that worked.
  async _updateBlocklist(jid, action) {
    const target = toNonAdJid(makeJid(jid));
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'blocklist',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('item', { jid: jidStrToObj(target), action }, null)
    ]);

    const resp = await this._sendIq(node);
    if (!resp) {
      throw new Error(action + 'Contact: no reply from server (IQ timed out)');
    }
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error(action + 'Contact: server rejected the request' +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }
    // The server answers with the whole list as it now stands.
    return this._parseBlocklist(findChild(resp, 'list')).jids;
  }

  // Pin / unpin a chat (mobile: local state)
  pinChat(jid) {
    const chat = this._getChatState(jid);
    chat.pinnedAt = Math.floor(Date.now() / 1000);
    this.emit('chat_pinned', { jid, pinned: true });
  }

  unpinChat(jid) {
    const chat = this._getChatState(jid);
    chat.pinnedAt = 0;
    this.emit('chat_pinned', { jid, pinned: false });
  }

  // Archive / unarchive a chat (mobile: local state)
  archiveChat(jid) {
    const chat = this._getChatState(jid);
    chat.archived = true;
    this.emit('chat_archived', { jid, archived: true });
  }

  unarchiveChat(jid) {
    const chat = this._getChatState(jid);
    chat.archived = false;
    this.emit('chat_archived', { jid, archived: false });
  }

  // Star / unstar a message (mobile: local state)
  starMessage(msgId, chatJid) {
    const key = `${chatJid}:${msgId}`;
    if (!this._starredMessages) this._starredMessages = new Set();
    this._starredMessages.add(key);
    this.emit('message_starred', { msgId, chatJid, starred: true });
  }

  unstarMessage(msgId, chatJid) {
    const key = `${chatJid}:${msgId}`;
    if (!this._starredMessages) this._starredMessages = new Set();
    this._starredMessages.delete(key);
    this.emit('message_starred', { msgId, chatJid, starred: false });
  }

  // Mark a voice/audio message as played (sends 'played' receipt)
  markMessagePlayed(msgId, from) {
    if (!this._socket || !this._connected) return;
    this._socket.sendNode(new BinaryNode('receipt', {
      id:   msgId,
      type: 'played',
      to:   from
    }, null));
  }

  // Set disappearing messages timer
  // seconds: 0 = off, 86400 = 1 day, 604800 = 1 week, 7776000 = 90 days
  async changeEphemeralTimer(jid, seconds) {
    const jidFull = makeJid(jid);
    const isGroup = jidFull.endsWith('@g.us');
    if (isGroup) {
      const id = this._genMsgId();
      const body = seconds === 0
        ? new BinaryNode('not_ephemeral', {}, null)
        : new BinaryNode('ephemeral', { expiration: String(seconds) }, null);
      const node = new BinaryNode('iq', {
        id,
        xmlns: 'w:g2',
        to:    jidFull,
        type:  'set'
      }, [body]);
      return this._sendIq(node);
    } else {
      if (!this._sender || !this._connected) throw new Error('Not connected');
      return this._sender.sendEphemeralTimerDM(jidFull, seconds);
    }
  }

  // Set global default ephemeral timer for new chats
  async changeNewChatsEphemeralTimer(seconds) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'disappearing_mode',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('disappearing_mode', { duration: String(seconds) }, null)
    ]);
    return this._sendIq(node);
  }

  // Helper: get or create per-chat state object (for mobile local operations)
  _getChatState(jid) {
    const key = makeJid(jid);
    if (!this._chatStates) this._chatStates = {};
    if (!this._chatStates[key]) this._chatStates[key] = {};
    return this._chatStates[key];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CALL LINKS
  // ──────────────────────────────────────────────────────────────────────────

  // Ask the server for a call link that can be shared in a chat, so the other
  // side joins by tapping it instead of being rung.
  //
  //   type  'audio' (default) or 'video'
  //   opts  { startTime } — seconds since the epoch, to schedule the call
  //
  // Returns { token, link, type }. The stanza is the one WhatsApp Web sends:
  // <call to="@call"><link_create media="..."/></call>, answered with the token
  // on a link_create of its own.
  async createCallLink(type, opts) {
    opts = opts || {};
    const media = type === 'video' ? 'video' : 'audio';
    const id    = this._genMsgId();
    const children = opts.startTime
      ? [new BinaryNode('event', { start_time: String(opts.startTime) }, null)]
      : null;

    const resp = await this._sendIq(new BinaryNode('call', { id, to: '@call' }, [
      new BinaryNode('link_create', { media }, children)
    ]));

    if (!resp) throw new Error('createCallLink: no reply from server (timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('createCallLink: server rejected the request' +
        (code ? ' (' + code + ')' : ''));
    }
    const created = findChild(resp, 'link_create');
    const token   = created && created.attrs && created.attrs.token;
    if (!token) throw new Error('createCallLink: server reply carried no token');

    const prefix = media === 'video' ? CALL_VIDEO_PREFIX : CALL_AUDIO_PREFIX;
    return { token: String(token), link: prefix + token, type: media };
  }

  // Create a call link and send it as a message in one step.
  // Returns the send result with the link attached.
  async sendCallLink(to, type, opts) {
    opts = opts || {};
    const { link } = await this.createCallLink(type, opts);
    const text = opts.text ? (opts.text + ' ' + link) : link;
    const res  = await this.sendText(to, text, opts);
    return Object.assign({}, res, { link });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP OPERATIONS
  // ──────────────────────────────────────────────────────────────────────────

  // Create a group
  // participants: array of phone numbers or JIDs
  // Create a group.
  //
  // opts: { ephemeralSeconds, announce, locked, joinApprovalRequired,
  //         memberAddMode, parent, linkedParentJid }
  //
  // Built the way whatsmeow's CreateGroup does: every participant is a binary
  // JID (a raw string is dropped for an @lid), a LID participant also carries
  // the phone number the server matches it against, and each carries our privacy
  // token so the invite is not treated as an anonymous reach-out. The setting
  // nodes are siblings of the participants inside <create>.
  async createGroup(subject, participants, opts) {
    opts = opts || {};
    const id       = this._genMsgId();
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
    // participant nodes MUST use attr `jid`, not `value`
    const partNodes = (participants || []).map(p => {
      const jid   = makeJid(p);
      const attrs = { jid: jidStrToObj(jid) };
      if (jid.endsWith('@lid')) {
        const pn = this._lidToPn.get(jid.split('@')[0].split(':')[0]);
        if (pn) attrs.phone_number = jidStrToObj(pn + '@s.whatsapp.net');
      }
      const entry = this._tcTokenStore &&
        this._tcTokenStore.get(normalizeJidForTcToken(jid));
      const children = (entry && entry.token && entry.token.length)
        ? [new BinaryNode('privacy', {}, entry.token)]
        : null;
      return new BinaryNode('participant', attrs, children);
    });

    const settingNodes = [];
    if (opts.parent) {
      settingNodes.push(new BinaryNode('parent', {
        default_membership_approval_mode:
          opts.defaultMembershipApprovalMode || 'request_required'
      }, null));
    } else if (opts.linkedParentJid) {
      settingNodes.push(new BinaryNode('linked_parent', {
        jid: jidStrToObj(makeJid(opts.linkedParentJid))
      }, null));
    }
    if (opts.locked)   settingNodes.push(new BinaryNode('locked', {}, null));
    if (opts.announce) settingNodes.push(new BinaryNode('announcement', {}, null));
    if (opts.ephemeralSeconds) {
      // whatsmeow sends trigger="1" alongside the expiration; without it the
      // server accepts the group but leaves disappearing messages off.
      settingNodes.push(new BinaryNode('ephemeral', {
        expiration: String(opts.ephemeralSeconds),
        trigger:    '1'
      }, null));
    }
    if (opts.joinApprovalRequired) {
      settingNodes.push(new BinaryNode('membership_approval_mode', {}, [
        new BinaryNode('group_join', { state: 'on' }, null)
      ]));
    }
    if (opts.memberAddMode) {
      settingNodes.push(new BinaryNode('member_add_mode', {},
        Buffer.from(String(opts.memberAddMode), 'utf8')));
    }

    const baseAttrs = { subject, key: String(Math.floor(Date.now() / 1000)) };
    const createChildren = [...partNodes, ...settingNodes];
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'set'
    }, [new BinaryNode('create', baseAttrs, createChildren)]);
    const resp = await this._sendIq(node);
    // These used to return null indistinguishably, which surfaced to the CLI as
    // a bare "no response" no matter what actually went wrong.
    if (!resp) {
      throw new Error('createGroup: no reply from server (IQ timed out)');
    }
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error('createGroup: server rejected the request' +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }
    const createNode = findChild(resp, 'create');
    const groupNode  = createNode ? findChild(createNode, 'group') : findChildDeep(resp, 'group');
    if (!groupNode) {
      throw new Error('createGroup: server reply contained no <group> node');
    }
    return this._parseGroupNode(groupNode);
  }

  // Leave a group
  // MUST send to 'g.us', not to the group JID
  async leaveGroup(groupJid) {
    const jid = makeJid(groupJid);
    const id  = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'set'
    }, [
      new BinaryNode('leave', {}, [
        new BinaryNode('group', { id: jid }, null)
      ])
    ]);
    return this._sendIq(node);
  }

  // Add participants to group
  async addGroupParticipants(groupJid, jids) {
    return this._groupParticipantAction(groupJid, 'add', jids);
  }

  // Remove participants from group
  async removeGroupParticipants(groupJid, jids) {
    return this._groupParticipantAction(groupJid, 'remove', jids);
  }

  // Promote participants to admin
  async promoteGroupParticipants(groupJid, jids) {
    return this._groupParticipantAction(groupJid, 'promote', jids);
  }

  // Demote admins to participants
  async demoteGroupParticipants(groupJid, jids) {
    return this._groupParticipantAction(groupJid, 'demote', jids);
  }

  // Internal: execute action on participants (add/remove/promote/demote)
  // participant nodes MUST use attr `jid`, not `value`
  async _groupParticipantAction(groupJid, action, jids) {
    const gJid = makeJid(groupJid);
    const arr  = Array.isArray(jids) ? jids : [jids];
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
    // Same shape whatsmeow's UpdateGroupParticipants builds: binary JIDs, and on
    // an add, the phone number behind a LID plus our privacy token for them.
    const participantNodes = arr.map(j => {
      const jid   = makeJid(j);
      const attrs = { jid: jidStrToObj(jid) };
      let children = null;
      if (action === 'add') {
        if (jid.endsWith('@lid')) {
          const pn = this._lidToPn.get(jid.split('@')[0].split(':')[0]);
          if (pn) attrs.phone_number = jidStrToObj(pn + '@s.whatsapp.net');
        }
        const entry = this._tcTokenStore &&
          this._tcTokenStore.get(normalizeJidForTcToken(jid));
        if (entry && entry.token && entry.token.length) {
          children = [new BinaryNode('privacy', {}, entry.token)];
        }
      }
      return new BinaryNode('participant', attrs, children);
    });
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jidStrToObj(gJid),
      type:  'set'
    }, [
      new BinaryNode(action, {}, participantNodes)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return [];
    const actionNode = findChild(resp, action);
    if (!actionNode || !Array.isArray(actionNode.content)) return [];
    return actionNode.content
      .filter(n => n && n.description === 'participant' && n.attrs && !n.attrs.error)
      .map(n => n.attrs.jid || n.attrs.value)
      .filter(Boolean);
  }

  // Change group name/subject
  async changeGroupSubject(groupJid, subject) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'set'
    }, [
      new BinaryNode('subject', {}, Buffer.from(subject, 'utf8'))
    ]);
    return this._sendIq(node);
  }

  // Change group description
  // description: string or null/'' to remove
  //
  // whatsmeow's SetGroupTopic sends prev=<current topic id> so the server can
  // reject an edit made against a description someone else has already replaced.
  // Without it the change is refused. The current id is looked up from the group
  // metadata when the caller does not supply one.
  async changeGroupDescription(groupJid, description, opts) {
    opts = opts || {};
    const gJid = makeJid(groupJid);
    const id   = this._genMsgId();
    const isDelete = description == null || description === '';

    let prevId = opts.prevId;
    if (prevId === undefined) {
      try {
        const meta = await this.getGroupMetadata(gJid);
        prevId = meta && meta.descriptionId;
      } catch (_) { prevId = null; }
    }

    const descAttrs = { id: opts.newId || this._genMsgId() };
    if (prevId) descAttrs.prev = prevId;
    let children = [new BinaryNode('body', {}, Buffer.from(String(description), 'utf8'))];
    if (isDelete) {
      descAttrs.delete = 'true';
      children = null;
    }

    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jidStrToObj(gJid),
      type:  'set'
    }, [
      new BinaryNode('description', descAttrs, children)
    ]);
    return this._sendIq(node);
  }

  // ─── Group settings ───────────────────────────────────────────────────────
  //
  // Both are a single empty node whose TAG carries the state, exactly as
  // whatsmeow's SetGroupAnnounce / SetGroupLocked send them — there is no
  // attribute form of these.

  // announce=true → only admins can send messages
  async setGroupAnnounce(groupJid, announce) {
    return this._groupSettingIq(groupJid, announce ? 'announcement' : 'not_announcement');
  }

  // locked=true → only admins can edit group info (subject, description, icon)
  async setGroupLocked(groupJid, locked) {
    return this._groupSettingIq(groupJid, locked ? 'locked' : 'unlocked');
  }

  // mode=true → new members must be approved by an admin
  async setGroupJoinApprovalMode(groupJid, mode) {
    return this._groupSettingIq(groupJid, 'membership_approval_mode', [
      new BinaryNode('group_join', { state: mode ? 'on' : 'off' }, null)
    ]);
  }

  // mode: 'all_member_add' | 'admin_add'
  async setGroupMemberAddMode(groupJid, mode) {
    return this._groupSettingIq(groupJid, 'member_add_mode',
      Buffer.from(String(mode), 'utf8'));
  }

  // content is passed to the setting node verbatim: null for the flag settings
  // whose state lives in the tag, child nodes for membership_approval_mode, raw
  // bytes for member_add_mode.
  async _groupSettingIq(groupJid, tag, content) {
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'w:g2',
      to:    jidStrToObj(makeJid(groupJid)),
      type:  'set'
    }, [
      new BinaryNode(tag, {}, content === undefined ? null : content)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) throw new Error(tag + ': no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error(tag + ': server rejected the request' +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }
    // The group's own view of these flags is now stale.
    this.invalidateGroupMetadata(groupJid);
    return resp;
  }

  // Change group picture
  // buf: Buffer with JPEG image data, or null to remove
  async changeGroupPicture(groupJid, buf) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns:  'w:profile:picture',
      target: makeJid(groupJid),
      to:     's.whatsapp.net',
      type:   'set'
    }, [
      new BinaryNode('picture', { type: 'image' }, buf || null)
    ]);
    return this._sendIq(node);
  }

  // Get the group's invite link.
  //
  // reset=true revokes the current link and returns a freshly minted one — the
  // same IQ with type="set" instead of "get", which is how whatsmeow's
  // GetGroupInviteLink handles its reset flag.
  async queryGroupInviteLink(groupJid, reset) {
    const code = await this._queryGroupInviteCode(groupJid, reset);
    return code ? INVITE_LINK_PREFIX + code : null;
  }

  // Revoke the current invite link and return the replacement.
  async revokeGroupInviteLink(groupJid) {
    return this.queryGroupInviteLink(groupJid, true);
  }

  // Join a group from an invite link or bare code.
  // Returns the JID of the group that was joined. When the group requires admin
  // approval the server answers with a membership_approval_request instead, and
  // that JID is returned — the join is pending, not complete.
  async joinGroupWithLink(inviteCodeOrUrl) {
    const code = stripInviteUrl(inviteCodeOrUrl);
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'set'
    }, [new BinaryNode('invite', { code }, null)]);

    const resp = await this._sendIq(node);
    if (!resp) throw new Error('joinGroupWithLink: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const codeAttr = errNode && errNode.attrs && errNode.attrs.code;
      // whatsmeow maps these two specifically: 410 is a revoked link, 406 an
      // invalid one. Anything else is passed through as the server worded it.
      const reason = String(codeAttr) === '410' ? 'the invite link has been revoked'
                   : String(codeAttr) === '406' ? 'the invite link is not valid'
                   : 'server rejected the request' +
                     (codeAttr ? ' (' + codeAttr + ')' : '');
      throw new Error('joinGroupWithLink: ' + reason);
    }
    const pending = findChild(resp, 'membership_approval_request');
    if (pending && pending.attrs && pending.attrs.jid) {
      return { jid: String(pending.attrs.jid), pendingApproval: true };
    }
    const grp = findChild(resp, 'group');
    if (!grp || !grp.attrs || !grp.attrs.jid) {
      throw new Error('joinGroupWithLink: server reply contained no <group> node');
    }
    return { jid: String(grp.attrs.jid), pendingApproval: false };
  }

  // queryGroupInviteInfo — fetch group metadata from an invite link code
  // Returns parsed group metadata (same shape as getGroupMetadata) or null.
  // inviteCode is the bare code (no URL prefix needed; URL also accepted).
  async queryGroupInviteInfo(inviteCodeOrUrl) {
    const code = stripInviteUrl(inviteCodeOrUrl);
    const id   = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'get'
    }, [
      new BinaryNode('invite', { code }, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const grp = findChild(resp, 'group');
    if (!grp) return null;
    return this._parseGroupNode(grp);
  }

  async _queryGroupInviteCode(groupJid, reset) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jidStrToObj(makeJid(groupJid)),
      type:  reset ? 'set' : 'get'
    }, [
      new BinaryNode('invite', {}, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const inv = findChild(resp, 'invite');
    return (inv && inv.attrs && inv.attrs.code) || null;
  }

  // Revoke group invite
  // Revoke the current invite link. Returns the replacement link.
  //
  // This threw the reply away, so a caller had no way to learn the new code and
  // had to query the link again. It is the same IQ revokeGroupInviteLink sends.
  async revokeGroupInvite(groupJid) {
    return this.revokeGroupInviteLink(groupJid);
  }

  // Join a group by invite code or full link. Returns the group JID, or null.
  //
  // Accepts a full https://chat.whatsapp.com/... link as well as a bare code —
  // it used to pass whatever it was given straight through as the code, so a
  // pasted link was rejected. A group that gates joins on admin approval answers
  // with membership_approval_request rather than group; that JID is returned too
  // (use joinGroupWithLink when you need to tell the two apart).
  async acceptGroupInvite(inviteCodeOrUrl) {
    const r = await this.joinGroupWithLink(inviteCodeOrUrl).catch(() => null);
    return r ? r.jid : null;
  }

  // Change group settings
  // setting: 'edit_group_info' | 'send_messages' | 'add_participants' | 'approve_participants'
  // policy:  'admins' | 'all'
  async changeGroupSetting(groupJid, setting, policy) {
    const id     = this._genMsgId();
    const admins = policy === 'admins';
    let   body;
    switch (setting) {
      case 'edit_group_info':
        body = new BinaryNode(admins ? 'locked' : 'unlocked', {}, null);
        break;
      case 'send_messages':
        body = new BinaryNode(admins ? 'announcement' : 'not_announcement', {}, null);
        break;
      case 'add_participants':
        body = new BinaryNode('member_add_mode', {},
          Buffer.from(admins ? 'admin_add' : 'all_member_add', 'utf8'));
        break;
      case 'approve_participants':
        body = new BinaryNode('membership_approval_mode', {}, [
          new BinaryNode('group_join', { state: admins ? 'on' : 'off' }, null)
        ]);
        break;
      default:
        throw new Error('Unknown group setting: ' + setting);
    }
    // Routed through the shared helper so a refusal from the server (not an
    // admin, not a member) surfaces as an error instead of resolving null, and
    // so the group's cached metadata does not keep reporting the old flags.
    return this._groupSettingIq(groupJid, body.description, body.content);
  }

  // Query participants pending approval
  async queryGroupPendingParticipants(groupJid) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'get'
    }, [
      new BinaryNode('membership_approval_requests', {}, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return [];
    const reqNode = findChild(resp, 'membership_approval_requests');
    if (!reqNode || !Array.isArray(reqNode.content)) return [];
    return reqNode.content
      .filter(n => n && n.description === 'membership_approval_request')
      .map(n => n.attrs && (n.attrs.user || n.attrs.jid))
      .filter(Boolean);
  }

  // Approve or reject pending join requests
  async approveGroupParticipants(groupJid, approve, jids) {
    const arr     = Array.isArray(jids) ? jids : [jids];
    const action  = approve ? 'approve' : 'reject';
    const partNodes = arr.map(j =>
      new BinaryNode('participant', { jid: makeJid(j) }, null)
    );
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'set'
    }, [
      new BinaryNode('membership_requests_action', {}, [
        new BinaryNode(action, {}, partNodes)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return [];
    const actionNode = findChildDeep(resp, action);
    if (!actionNode || !Array.isArray(actionNode.content)) return [];
    return actionNode.content
      .filter(n => n && n.description === 'participant' && !n.attrs.error)
      .map(n => n.attrs && (n.attrs.value || n.attrs.jid))
      .filter(Boolean);
  }
}

module.exports = {
  WhalibmobClient,
  checkIfRegistered,
  checkNumberStatus,
  requestSmsCode,
  verifyCode,
  assertRegistrationKeys,
  fetchIosVersion,
  fetchWaVersion,
  getDeviceConfig,
  createNewStore,
  saveStore,
  loadStore,
  toSixParts,
  fromSixParts
};
