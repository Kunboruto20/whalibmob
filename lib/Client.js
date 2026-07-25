'use strict';

const EventEmitter  = require('events');
const path          = require('path');
const crypto        = require('crypto');
const { NoiseSocket }     = require('./noise');
const { MessageSender, generateMessageId, makeJid, buildOrGetAdvIdentity } = require('./messages/MessageSender');
const { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, assertRegistrationKeys, fetchIosVersion, fetchWaVersion } = require('./Registration');
const { getDeviceConfig } = require('./DeviceConfig');
const { createNewStore, saveStore, loadStore, toSixParts, fromSixParts } = require('./Store');
const { BinaryNode }      = require('./BinaryNode');
const { SignalProtocol }  = require('./signal/SignalProtocol');
const { DeviceManager }   = require('./DeviceManager');

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
    this._pingTimer     = null;
    this._keepTimer     = null;
    this._connected     = false;
    this._reconnecting  = false;
    this._reconnectTry  = 0;
    this._phoneNumber   = null;
    this._mediaConn     = null;
    this._pendingIqs       = new Map();   // id → resolve fn
    this._pendingAcks      = new Map();   // msgId → resolve fn
    this._groupMembers     = new Map();   // groupJid → Set<memberJid>
    this._lidToPn          = new Map();   // LID user → phone number
    this._pnToLid          = new Map();   // phone number → LID user
    this._myLid            = null;        // own LID JID received from <success> node
    this._groupAddressingMode = new Map(); // groupJid → 'lid' | 'pn'
    this._retryPending     = new Map();   // msgId → {node, retryCount}
    this._retryPreKeyIdx   = 0;           // rotating index for assigning unique prekeys to retries
    this._appStateVersions = {};          // collectionName → version (int)
    this._sentMsgCache     = new Map();   // msgId → {plaintext, toJid, msgId, mediaType, options, recipientPhone}
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

    const signalFile = path.join(this._sessionDir, `${phoneNumber}.signal.json`);
    const skFile     = path.join(this._sessionDir, `${phoneNumber}.sk.json`);

    this._signal = SignalProtocol.fromStore(this._store, signalFile, skFile);
    this._devMgr = new DeviceManager(this);

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
    process.stderr.write('[DBG] SUCCESS node attrs=' + JSON.stringify(attrs) + '\n');
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (child && child.description) {
          process.stderr.write('[DBG] SUCCESS child tag=' + child.description + ' attrs=' + JSON.stringify(child.attrs || {}) + '\n');
        }
      }
    }
    if (attrs.platform) this._platform = attrs.platform;
    if (attrs.lid)      this._myLid    = String(attrs.lid);

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
    process.stderr.write('[DBG] SEND active IQ id=' + id + '\n');
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
        process.stderr.write('[DBG] ignoring unknown dirty type: ' + type + '\n');
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

    process.stderr.write('[DBG] SEND appStateSync IQ id=' + id + ' collections=' + [...collections].join(',') + '\n');
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
    process.stderr.write('[DBG] _onNode tag=' + tag + ' attrs=' + JSON.stringify(node.attrs || {}) + '\n');
    if (tag === 'iq' && node.attrs && node.attrs.type === 'error') {
      try { process.stderr.write('[DBG] IQ_ERROR content=' + JSON.stringify(node.content) + '\n'); } catch(_) {}
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
      }
    }
    process.stderr.write('[DBG] _handleMessage from=' + from + ' participant=' + participant + ' senderPn=' + senderPn + ' id=' + id + '\n');
    if (Array.isArray(node.content)) {
      for (const c of node.content) {
        if (c && c.description) {
          process.stderr.write('[DBG] MSG_CHILD tag=' + c.description + ' attrs=' + JSON.stringify(c.attrs || {}) + ' contentLen=' + (Buffer.isBuffer(c.content) ? c.content.length : (typeof c.content === 'string' ? c.content.length : 0)) + '\n');
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

    process.stderr.write('[DBG] DM_DECRYPT id=' + id + ' type=' + encType + ' sigJid=' + sigJid + ' cipherLen=' + cipherBuf.length + '\n');

    this._signal.decrypt(sigJid, encType, cipherBuf)
      .then(plaintext => {
        const decoded = this._decodeMsg(plaintext);
        process.stderr.write('[DBG] DM_DECODED id=' + id + ' type=' + decoded.type + ' ptLen=' + (plaintext ? plaintext.length : 0) + ' hasSKDM=' + !!(decoded.skdm || decoded.type === 'senderKeyDistribution') + '\n');

        // Process embedded SKDM when bundled with a real message (WhatsApp MD always does this
        // on the first message of a new session, even for 1-on-1 DMs).
        // axolotlBytes may be absent in newer WA proto versions — that's OK for DM pkmsg flow.
        if (decoded.skdm && decoded.skdm.axolotlBytes && decoded.skdm.axolotlBytes[0] === 0x33) {
          try {
            this._signal.processSKDM(decoded.skdm.groupId, sigJid, decoded.skdm.axolotlBytes);
            process.stderr.write('[DBG] SKDM_PROCESSED groupId=' + decoded.skdm.groupId + ' sender=' + sigJid + '\n');
          } catch (e) {
            process.stderr.write('[DBG] SKDM_ERR ' + e.message + '\n');
          }
        }

        // SKDM-only message (no real content) — ACK and move on
        if (decoded.type === 'senderKeyDistribution') {
          if (decoded.axolotlBytes && decoded.axolotlBytes[0] === 0x33) {
            try {
              this._signal.processSKDM(decoded.groupId, sigJid, decoded.axolotlBytes);
              process.stderr.write('[DBG] SKDM_ONLY_PROCESSED groupId=' + decoded.groupId + ' sender=' + sigJid + '\n');
            } catch (e) {
              process.stderr.write('[DBG] SKDM_ONLY_ERR ' + e.message + '\n');
            }
          }
          this._sendReadReceipt(id, fromRaw, partRaw);
          return;
        }

        // Protocol messages (revoke, ephemeral, etc.) — silent ACK
        if (decoded.type === 'protocol') { process.stderr.write('[DBG] DM_FILTER proto id=' + id + '\n'); return; }

        this.emit('message', { id, from, participant, ts, decoded, node });
        this._sendReadReceipt(id, fromRaw, partRaw);
      })
      .catch(err => {
        process.stderr.write('[DBG] DM_ERR id=' + id + ' err=' + (err && err.message) + '\n');
        this.emit('decrypt_error', { id, from, participant, err });
        this._sendRetryRequest(id, node);
      });
  }

  _decryptGroupMessage({ node, from, participant, fromRaw, partRaw, id, ts, skmsgNode }) {
    const cipherBuf = Buffer.isBuffer(skmsgNode.content)
      ? skmsgNode.content
      : Buffer.from(skmsgNode.content || '');

    try {
      const plaintext = this._signal.senderKeyDecrypt(from, participant, cipherBuf);
      const decoded   = this._decodeMsg(plaintext);
      if (decoded.type === 'senderKeyDistribution') return;
      if (decoded.type === 'protocol') return;
      this.emit('message', { id, from, participant, ts, decoded, isGroup: true, node });
      this._sendReadReceipt(id, fromRaw, partRaw);
    } catch (err) {
      this.emit('decrypt_error', { id, from, participant, err });
    }
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
          .then(decrypted => {
            const decoded = this._decodeMsg(decrypted);
            if (decoded && decoded.type === 'senderKeyDistribution' &&
                decoded.groupId && decoded.axolotlBytes) {
              this._signal.processSKDM(decoded.groupId, senderJid, decoded.axolotlBytes);
            } else if (decoded && decoded.skdm &&
                       decoded.skdm.groupId && decoded.skdm.axolotlBytes) {
              this._signal.processSKDM(decoded.skdm.groupId, senderJid, decoded.skdm.axolotlBytes);
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
      process.stderr.write('[DBG] RETRY_RECV msgId=' + msgId + ' — no cached plaintext, skipping resend\n');
      return;
    }

    const fromStr       = attrs.from ? String(attrs.from) : '';
    // Extract bare phone number: "40756469325@s.whatsapp.net" → "40756469325"
    const recipientPhone = fromStr.split('@')[0].split('.')[0];

    process.stderr.write('[DBG] RETRY_RECV msgId=' + msgId + ' from=' + fromStr + ' — clearing session + resending\n');

    // Delete all Signal sessions for the recipient's devices so next send creates fresh pkmsg
    const sigStore = this._signal && this._signal.store;
    if (sigStore && sigStore._sessions) {
      const sessions = sigStore._sessions;
      Object.keys(sessions).forEach(addr => {
        if (addr.startsWith(recipientPhone + '.')) {
          process.stderr.write('[DBG] RETRY deleting session for ' + addr + '\n');
          delete sessions[addr];
        }
      });
    }

    // Clear device manager cache so we re-fetch devices on next send
    if (this._devMgr) {
      this._devMgr.clearCache([recipientPhone]);
    }

    // Re-send the message — will create fresh pre-key (pkmsg) sessions
    this._sender._sendDMMessage(
      cached.toJid, cached.msgId, cached.plaintext, cached.mediaType, cached.options
    )
      .then(r  => process.stderr.write('[DBG] RETRY_RESEND ok id=' + r.id + '\n'))
      .catch(e => process.stderr.write('[DBG] RETRY_RESEND_ERR: ' + e.message + '\n'));
  }

  _handleAck(node) {
    const attrs  = node.attrs || {};
    const id     = attrs.id   || '';
    const cls    = attrs.class || '';

    if (cls === 'message') {
      const handler = this._pendingAcks.get(id);
      if (handler) {
        this._pendingAcks.delete(id);
        handler(attrs);
      }
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

  // Read receipt — sent after decryption succeeds.
  // Gives sender 2 blue checkmarks.
  // fromJid / partJid are raw JID objects (AD_JID encoding for correct routing).
  _sendReadReceipt(msgId, fromJid, partJid) {
    if (!this._socket || !this._connected) return;
    const node = new BinaryNode('receipt', {
      id:   msgId,
      type: 'read',
      to:   fromJid
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

  _sendRetryRequest(msgId, origNode) {
    const existing = this._retryPending.get(msgId);
    const count    = existing ? existing.count + 1 : 1;
    if (count > 5) return;

    if (!this._socket || !this._connected) return;

    // Assign a stable, unique prekey index per msgId on first retry
    let pkIdx = existing ? existing.pkIdx : -1;
    if (pkIdx < 0 && this._signal) {
      const allKeys = this._signal.getPreKeysForUpload(50);
      pkIdx = this._retryPreKeyIdx++ % Math.max(1, allKeys.length);
    }
    this._retryPending.set(msgId, { node: origNode, count, pkIdx });

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
        const allPreKeys = this._signal.getPreKeysForUpload(50);
        const pk         = allPreKeys[pkIdx] || allPreKeys[0];

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
            process.stderr.write('[DBG] RETRY #' + count + ' for ' + msgId + ' — preKeyId=' + pk.keyId + ' +device-identity(' + advBytes.length + 'b)\n');
          } else {
            process.stderr.write('[DBG] RETRY #' + count + ' for ' + msgId + ' — preKeyId=' + pk.keyId + ' (no advIdentity)\n');
          }

          children.push(new BinaryNode('keys', {}, keysChildren));
        }
      } catch (e) {
        process.stderr.write('[DBG] RETRY prekey bundle error: ' + e.message + '\n');
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

    process.stderr.write('[DBG] RETRY #' + count + ' receipt to=' + JSON.stringify(fromJid) + ' participant=' + JSON.stringify(origAttrs.participant || null) + '\n');
    this._socket.sendNode(new BinaryNode('receipt', receiptAttrs, children));
  }

  // ─── Notification handling ────────────────────────────────────────────────

  _handleNotification(node) {
    const attrs = node.attrs || {};
    const type  = attrs.type || '';

    this.emit('notification', { type, attrs, node });

    if (type === 'encrypt') {
      // Server tells us pre-keys are running low
      this._checkAndReplenishPreKeys();
    }

    if (type === 'devices' || type === 'account_sync') {
      // A contact's (or our own) device list changed. The push notification
      // carries an <add|update|remove> child with <device jid='USER:N@...'/>
      // entries (full JIDs here, unlike the USync query response). The safest
      // correct behaviour — matching WhatsApp Web / Baileys 'update' — is to
      // drop the cached device list for the affected user so the next send
      // re-runs USync and re-enumerates every device.
      this._processDeviceUpdate(node);
    }

    if (type === 'w:gp2') {
      // Group update: member add/remove
      this._processGroupUpdate(node);
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

  // Handle a device-list change notification. Accepts either the full
  // <notification> node or a bare <devices> node.
  _processDeviceUpdate(node) {
    if (!node || !this._devMgr) return;

    const fromUser = node.attrs && node.attrs.from
      ? String(node.attrs.from).split('@')[0].split(':')[0]
      : null;

    // Locate the <devices> wrapper and the action child (add/update/remove).
    const devicesNode = node.description === 'devices'
      ? node
      : findChildDeep(node, 'devices');
    const actionNode = devicesNode && Array.isArray(devicesNode.content)
      ? devicesNode.content.find(c => c &&
          ['add', 'update', 'remove', 'set'].includes(c.description))
      : null;
    const action = actionNode ? actionNode.description : 'update';

    // Collect explicit <device jid='...'/> entries if the server sent them.
    const explicit = [];
    const collect = (n) => {
      if (!n) return;
      if (n.description === 'device' && n.attrs && n.attrs.jid) {
        const jid    = String(n.attrs.jid);
        const phone  = jid.split('@')[0].split(':')[0];
        const device = parseInt((jid.split(':')[1] || '0').split('@')[0], 10);
        explicit.push({ phone, device: Number.isNaN(device) ? 0 : device });
      }
      if (Array.isArray(n.content)) n.content.forEach(collect);
    };
    collect(devicesNode || node);

    // For 'update'/'remove' the device list has changed shape — the reliable
    // fix is to drop the cache for the affected user and let the next send
    // re-enumerate via USync (which now parses linked devices correctly).
    if (action === 'update' || action === 'remove') {
      const users = new Set(explicit.map(e => e.phone));
      if (fromUser) users.add(fromUser);
      if (users.size > 0) this._devMgr.clearCache([...users]);
      return;
    }

    // For 'add' with explicit device JIDs we can update the cache in place.
    if (explicit.length > 0) {
      for (const { phone, device } of explicit) {
        if (!this._devMgr._deviceCache.has(phone)) {
          this._devMgr._deviceCache.set(phone, new Set([0]));
        }
        this._devMgr._deviceCache.get(phone).add(device);
      }
      return;
    }

    // Fallback: nothing parseable → drop the sender's cache to be safe.
    if (fromUser) this._devMgr.clearCache([fromUser]);
  }

  _processGroupUpdate(node) {
    const groupJid = node.attrs && node.attrs.from;
    if (!groupJid) return;
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
    process.stderr.write('[DBG] SEND media_conn IQ id=' + mcId + '\n');
    this._socket.sendNode(new BinaryNode('iq', {
      id:    mcId,
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:m'
    }, [new BinaryNode('media_conn', {}, null)]));
  }

  _onMediaConnectionResult(node) {
    const connNode = findChild(node, 'media_conn');
    if (!connNode) return;
    const auth  = (connNode.attrs && connNode.attrs.auth) || '';
    const hosts = [];
    if (Array.isArray(connNode.content)) {
      for (const child of connNode.content) {
        if (child && child.description === 'host') {
          const hostname = child.attrs && child.attrs.hostname;
          if (hostname) hosts.push(hostname);
        }
      }
    }
    this._mediaConn = { hosts, auth };
    if (this._sender) this._sender.setMediaConnection(hosts, auth);
    this.emit('media_conn', { hosts, auth });
  }

  // ─── Pre-key upload ───────────────────────────────────────────────────────

  _uploadPreKeys() {
    if (!this._signal || !this._socket || !this._connected) return;

    const preKeys  = this._signal.getPreKeysForUpload(50);
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
    process.stderr.write('[DBG] SEND uploadPreKeys IQ id=' + pkId + '\n');
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
          }
        }
        // Case B: participant JID is a PN, lid attribute is their LID
        if (pLid && pLid.endsWith('@lid')) {
          const pnUser  = pJid.split('@')[0].split(':')[0];
          const lidUser = pLid.split('@')[0].split(':')[0];
          this._lidToPn.set(lidUser, pnUser);
          this._pnToLid.set(pnUser, lidUser);
        }
        return { jid: pJid, role: pRole };
      });

    // description
    const descNode = children.find(n => n && n.description === 'description');
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

    return {
      jid,
      subject:    a.subject || '',
      creation:   parseInt(a.creation, 10) || 0,
      creator:    a.creator || null,
      subjectTime: parseInt(a.s_t, 10) || 0,
      subjectBy:  a.s_o || null,
      description,
      ephemeral,
      onlyAdminsSend: announce,
      onlyAdminsEdit: restrict,
      addressingMode,
      participants
    };
  }

  // Query metadata for a single group — returns parsed object
  async getGroupMetadata(groupJid) {
    const jid  = makeJid(groupJid);
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
    return this._parseGroupNode(groupNode);
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
    if (!response) return [];

    // Response content is a list of <group> nodes
    const children = Array.isArray(response.content) ? response.content : [];
    const groups = children
      .filter(n => n && n.description === 'group')
      .map(n => this._parseGroupNode(n))
      .filter(Boolean);
    return groups;
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

  // ─── Public API ───────────────────────────────────────────────────────────

  setPresence(available) {
    if (this._sender) this._sender.sendPresence(available);
  }

  markRead(jid, messageIds) {
    if (this._sender) this._sender.markRead(jid, messageIds);
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

  // Set global online/offline status)
  setOnline(available) {
    if (!this._socket || !this._connected) return;
    const name = (this._store && this._store.pushName) || '';
    this._socket.sendNode(new BinaryNode('presence', {
      name,
      type: available ? 'available' : 'unavailable'
    }, null));
  }

  // Set typing/recording presence in a specific chat)
  // presence: 'composing' | 'paused' | 'recording'
  setChatPresence(chatJid, presence) {
    if (!this._socket || !this._connected) return;
    const jid = makeJid(chatJid);
    if (presence === 'composing' || presence === 'recording') {
      const attrs = {};
      if (presence === 'recording') attrs.media = 'audio';
      this._socket.sendNode(new BinaryNode('chatstate', { to: jid }, [
        new BinaryNode('composing', attrs, null)
      ]));
    } else {
      this._socket.sendNode(new BinaryNode('chatstate', { to: jid }, [
        new BinaryNode('paused', {}, null)
      ]));
    }
  }

  // Subscribe to presence updates for contacts
  subscribeToPresence(jids) {
    if (!this._socket || !this._connected) return;
    const arr = Array.isArray(jids) ? jids : [jids];
    for (const jid of arr) {
      this._socket.sendNode(new BinaryNode('presence', {
        to:   makeJid(jid),
        type: 'subscribe'
      }, null));
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
  async queryPicture(jid) {
    const jidFull = makeJid(jid);
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns:  'w:profile:picture',
      to:     's.whatsapp.net',
      target: jidFull,
      type:   'get'
    }, [
      new BinaryNode('picture', { query: 'url', type: 'image' }, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const pic = findChild(resp, 'picture');
    return (pic && pic.attrs && pic.attrs.url) || null;
  }

  // Query blocked contacts list
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
    const list = findChild(resp, 'list');
    if (!list || !Array.isArray(list.content)) return [];
    return list.content
      .filter(n => n && n.description === 'item' && n.attrs && n.attrs.jid)
      .map(n => n.attrs.jid);
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

  // Change privacy settings
  // type: 'last_seen'|'profile_picture'|'status'|'online'|'read_receipts'|'groups_add'
  // value: 'all'|'contacts'|'contact_blacklist'|'none'|'match_last_seen'
  // excluded: array of JIDs excluded from value (for contact_blacklist)
  async changePrivacySetting(type, value, excluded) {
    const categoryAttrs = { name: type, value };
    const children = [];
    if (excluded && excluded.length > 0) {
      for (const jid of excluded) {
        children.push(new BinaryNode('user', { jid: makeJid(jid) }, null));
      }
    }
    const categoryNode = new BinaryNode('category', categoryAttrs, children.length > 0 ? children : null);
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'privacy',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('privacy', {}, [categoryNode])
    ]);
    return this._sendIq(node);
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

  // Send a WhatsApp Status/Story
  async sendStatus(text, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    return this._sender.sendText('status@broadcast', text, opts);
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

  // Block a contact
  async blockContact(jid) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'blocklist',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('item', { action: 'block', jid: makeJid(jid) }, null)
    ]);
    return this._sendIq(node);
  }

  // Unblock a contact
  async unblockContact(jid) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'blocklist',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('item', { action: 'unblock', jid: makeJid(jid) }, null)
    ]);
    return this._sendIq(node);
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
  // GROUP OPERATIONS
  // ──────────────────────────────────────────────────────────────────────────

  // Create a group
  // participants: array of phone numbers or JIDs
  async createGroup(subject, participants, opts) {
    opts = opts || {};
    const id       = this._genMsgId();
    // participant nodes MUST use attr `jid`, not `value`
    const partNodes = (participants || []).map(p => {
      const jid = makeJid(p);
      return new BinaryNode('participant', { jid }, null);
    });
    const baseAttrs = { subject, key: String(Math.floor(Date.now() / 1000)) };
    const createChildren = opts.ephemeralSeconds
      ? [...partNodes, new BinaryNode('ephemeral', { expiration: String(opts.ephemeralSeconds) }, null)]
      : partNodes;
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'set'
    }, [new BinaryNode('create', baseAttrs, createChildren)]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const createNode = findChild(resp, 'create');
    const groupNode  = createNode ? findChild(createNode, 'group') : findChildDeep(resp, 'group');
    if (!groupNode) return null;
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
    const participantNodes = arr.map(j =>
      new BinaryNode('participant', { jid: makeJid(j) }, null)
    );
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    gJid,
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
  // description: string or null to remove
  async changeGroupDescription(groupJid, description) {
    const id = this._genMsgId();
    const children = description != null
      ? [new BinaryNode('body', {}, Buffer.from(description, 'utf8'))]
      : null;
    const descAttrs = description != null
      ? { id: this._genMsgId() }
      : { delete: 'true' };
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'set'
    }, [
      new BinaryNode('description', descAttrs, children)
    ]);
    return this._sendIq(node);
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

  // Get group invite link
  async queryGroupInviteLink(groupJid) {
    const code = await this._queryGroupInviteCode(groupJid);
    return code ? 'https://chat.whatsapp.com/' + code : null;
  }

  // queryGroupInviteInfo — fetch group metadata from an invite link code
  // Returns parsed group metadata (same shape as getGroupMetadata) or null.
  // inviteCode is the bare code (no URL prefix needed; URL also accepted).
  async queryGroupInviteInfo(inviteCodeOrUrl) {
    const code = String(inviteCodeOrUrl).replace(/.*chat\.whatsapp\.com\//, '').trim();
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

  async _queryGroupInviteCode(groupJid) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'get'
    }, [
      new BinaryNode('invite', {}, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const inv = findChild(resp, 'invite');
    return (inv && inv.attrs && inv.attrs.code) || null;
  }

  // Revoke group invite
  async revokeGroupInvite(groupJid) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'set'
    }, [
      new BinaryNode('invite', {}, null)
    ]);
    return this._sendIq(node);
  }

  // Join group by invite code
  async acceptGroupInvite(inviteCode) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    'g.us',
      type:  'set'
    }, [
      new BinaryNode('invite', { code: inviteCode }, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) return null;
    const grp = findChild(resp, 'group');
    return (grp && grp.attrs && (grp.attrs.jid || grp.attrs.value)) || null;
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
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    makeJid(groupJid),
      type:  'set'
    }, [body]);
    return this._sendIq(node);
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
