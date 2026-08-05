'use strict';

const { dbg: _whaDbg, configureLogger: _whaConfigLogger } = require('./logger');

const EventEmitter  = require('events');
const path          = require('path');
const fs            = require('fs');
const crypto        = require('crypto');
const { Mutex }     = require('async-mutex');
const { NoiseSocket }     = require('./noise');
const { MessageSender, generateMessageId, makeJid, buildOrGetAdvIdentity } = require('./messages/MessageSender');
const { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, assertRegistrationKeys, fetchIosVersion, fetchWaVersion } = require('./Registration');
const { defaultBaseDir, sessionDirFor, isLegacyLayout,
        SESSION_SUFFIXES } = require('./SessionPaths');
const { getDeviceConfig } = require('./DeviceConfig');
const { prepareProfilePicture, probeImageSize, canDecodeImage } = require('./MediaThumbnail');
const { createNewStore, saveStore, loadStore, toSixParts, fromSixParts } = require('./Store');
const { BinaryNode }      = require('./BinaryNode');
const { AppStateStore, COLLECTIONS } = require('./appstate/AppStateStore');
const ReachoutTimelock = require('./ReachoutTimelock');
const { decodeArgo }   = require('./argo/ArgoDecoder');
const AppStateSync  = require('./appstate/AppStateSync');
const SyncdProto    = require('./appstate/SyncdProto');
const AppMutations  = require('./appstate/Mutations');
const {
  GroupParticipantResult, GroupJoinRequest,
  parseParticipantNodes, parseJoinRequestNode
} = require('./GroupParticipant');

// How many times a message may be re-sent in answer to retry receipts before
// the client stops. Each resend can itself draw retries, so this is what keeps
// an undecryptable message from turning into a flood.
//
// Matched to the cap on retries we ask for ourselves (5, in _sendRetryRequest):
// a device that keeps failing is worth the same number of rounds in either
// direction. Two rounds gave up while the recipient was still asking.
const MAX_RETRY_RESENDS = 5;

// How many sent messages keep their plaintext for answering a retry receipt.
// A receipt naming a message no longer held here cannot be answered at all —
// the message is acked by the server and then silently never arrives. The
// bound exists for memory, and an entry is small (the encoded Message, not the
// media it points at), so it is set well above a busy sender's in-flight window
// rather than at the smallest number that usually works.
const SENT_CACHE_SIZE = 2000;
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
  loadAppStateSyncKeys,
  HistorySyncType
} = require('./HistorySyncHandler');

// Status posts are messages addressed here.
const STATUS_BROADCAST_JID = 'status@broadcast';

// The two prefixes a call-link token is wrapped in, as WhatsApp Web uses them.
const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/';
const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/';

// The one prefix group invite codes are wrapped in.
const INVITE_LINK_PREFIX = 'https://chat.whatsapp.com/';

// The w:mex query that reports whether this account is restricted and until
// when. The id is the server's handle for that stored GraphQL document; there
// is no way to derive it, and a wrong one is answered with an error rather than
// with a different query.
const MEX_QUERY_REACHOUT_TIMELOCK = '23983697327930364';

// How long an about is allowed to be. The apps stop you at this length; the
// server takes a longer one, answers <iq type="result"/> and keeps the old text.
const ABOUT_MAX_LENGTH = 139;

// The names privacy settings actually go by on the wire, and the friendly
// aliases this library has always accepted for them. The wire names are the
// right-hand column.
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

// What each setting will actually accept. The server does not argue with a
// value it does not know — it drops the stanza and never answers, so a typo
// looks exactly like a network problem. Checking here turns that into a
// sentence naming the choices.
const PRIVACY_ALLOWED_VALUES = {
  last:         ['all', 'contacts', 'contact_blacklist', 'none'],
  profile:      ['all', 'contacts', 'contact_blacklist', 'none'],
  status:       ['all', 'contacts', 'contact_blacklist', 'none'],
  groupadd:     ['all', 'contacts', 'contact_blacklist', 'none'],
  readreceipts: ['all', 'none'],
  online:       ['all', 'match_last_seen'],
  calladd:      ['all', 'known'],
  messages:     ['all', 'contacts'],
  defense:      ['on_standard', 'off'],
  stickers:     ['contacts', 'contact_allowlist', 'none']
};

// The words people reach for, mapped to the ones the protocol uses. "on" and
// "off" are the obvious things to type for read receipts and mean nothing on
// the wire, which is exactly the mistake worth absorbing.
const PRIVACY_VALUE_ALIASES = {
  everyone:            'all',
  my_contacts:         'contacts',
  contacts_except:     'contact_blacklist',
  contact_whitelist:   'contact_allowlist',
  nobody:              'none',
  off:                 'none',
  on:                  'all',
  same_as_last_seen:   'match_last_seen',
  last_seen:           'match_last_seen',
  standard:            'on_standard'
};

// Where a word means something different for one setting than for the rest.
// "on" is "all" everywhere except defense, whose on-state has its own name.
const PRIVACY_VALUE_ALIASES_BY_NAME = {
  defense: { on: 'on_standard' },
  online:  { on: 'all', off: 'match_last_seen' }
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

// Reduce a JID to its bare user. Blocking, and anything else that names an
// account rather than one of its devices, wants this form.
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

// When the server is down to this many one-time keys or fewer, send it more.
// The number is small on purpose: the server tells us when it is running low,
// and this is the floor for the case where that notice never arrives.
const PRE_KEY_SERVER_MIN  = 5;

// How often to ask the server how many it has left. The drain is invisible from
// here — every bundle handed out is a key gone, and none of that reaches this
// side — so on a session that stays up for days this is the only thing that
// notices before the pool is empty and the account stops being reachable.
const PRE_KEY_CHECK_INTERVAL = 30 * 60 * 1000;   // 30 minutes

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

// A one-line sketch of a stanza, for an error message that has to be useful to
// somebody who cannot see the wire. Shows the tag tree and a short preview of
// any content, so an unexpected reply can be reported rather than guessed at.
function describeNodeBriefly(node, depth) {
  if (!node) return '(nothing)';
  depth = depth || 0;
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => k + '=' + String(v))
    .join(' ');
  let out = '<' + node.description + (attrs ? ' ' + attrs : '');

  if (Array.isArray(node.content)) {
    if (depth >= 3) return out + ' …>';
    const kids = node.content
      .filter(c => c && c.description)
      .map(c => describeNodeBriefly(c, depth + 1));
    return out + '>' + kids.join('');
  }

  const buf = getNodeContent(node);
  if (buf && buf.length) {
    const text = buf.toString('utf8');
    // Printable content is far more use than hex; fall back to hex when it is
    // not text at all.
    const printable = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text);
    const shown = printable
      ? JSON.stringify(text.length > 120 ? text.slice(0, 120) + '…' : text)
      : '0x' + buf.slice(0, 40).toString('hex') + (buf.length > 40 ? '…' : '');
    return out + '>' + buf.length + 'B ' + shown;
  }
  return out + '/>';
}

// Say why a picture was turned down, from what can be read off the file.
//
// "not acceptable" is all the server offers, so the useful part is what we can
// work out ourselves: what the image is, whether it is square, and whether
// anything was available to fix it before it went out.
function _pictureRejected(what, picture, original, opts) {
  const size = picture ? probeImageSize(picture) : null;
  const bits = ['the server would not take this image (406 not-acceptable)'];

  if (size && size.width && size.height) {
    bits.push('it went out as ' + size.width + 'x' + size.height +
      (size.width === size.height ? '' : ', which is not square'));
  }
  const isJpeg = picture && picture[0] === 0xff && picture[1] === 0xd8;
  if (picture && !isJpeg) bits.push('and it is not a JPEG');

  if (opts && opts.raw) {
    bits.push('this call passed { raw: true }, so the file was sent exactly as given');
  } else if (!isJpeg && original && !canDecodeImage(original)) {
    // WebP, HEIC and the like need an outside converter; everything ordinary
    // is handled without one.
    bits.push('this format could not be converted here — install ffmpeg, or ' +
      'save the picture as a JPEG or PNG first');
  } else {
    bits.push('the picture was cropped square and re-encoded before sending, ' +
      'so the file itself is unlikely to be the problem — the account may not ' +
      'be allowed to set one');
  }

  return what + ': ' + bits.join('. ') + '.';
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
    // The authentication folder the caller chose. `_sessionDir` below is the
    // directory this one number's files live in, which is a directory inside
    // it — see SessionPaths. Both are kept: the base is what listing and
    // renaming work against, the per-number one is what every file path is
    // built from.
    this._baseDir       = opts.sessionDir || defaultBaseDir();
    this._sessionDir    = this._baseDir;
    // 'mobile' — registered over SMS as the account's primary device (default,
    // and what every existing caller gets). 'web' — linked to an existing
    // account as a companion, via pairing code.
    this._mode          = 'mobile';
    this._webSessionFile = null;
    // Set once the server has told us to stop trying: an account logout, or a
    // client the server will not accept. Suppresses the reconnect loop.
    this._fatal          = false;
    this._closing        = false;
    // A session whose number is not in WhatsApp's canonical form is re-filed
    // automatically on the first refused login. Set { autoFixNumber: false } to
    // be told about it instead.
    this._autoFixNumber  = opts.autoFixNumber !== false;
    this._numberFixAttempted = false;
    this._pingTimer               = null;
    this._keepTimer               = null;
    // Both pre-key checks ask the server a question, wait for the answer, and
    // top the account up if they do not like it. Three things start them —
    // login, the half-hourly timer, and the server saying it is running low —
    // and nothing stopped two from being in the air at once. Overlapping runs
    // each saw the same shortage and each answered it, so the account
    // generated and uploaded two batches for one gap. Serialised, the second
    // run asks after the first has finished: the count it gets back is the one
    // the first run just produced, so it stands down instead of repeating it.
    // One mutex per client — two accounts in the same process are unrelated
    // and must not wait on each other.
    this._preKeyMutex             = new Mutex();
    // Incoming work runs one item at a time, in arrival order.
    //
    // Stanzas arrive faster than they are handled, and the handling is
    // asynchronous, so without these each one raced the ones before it: two
    // messages from the same contact could decrypt at once and advance the
    // same ratchet from the same starting point, and two retry receipts could
    // tear a session down while the resend for the previous one was still
    // building it back up.
    //
    // Three separate locks, not one. A message whose decryption waits on
    // something that only arrives as a notification would deadlock against a
    // shared lock — the notification could never be processed to release it.
    // Keeping them apart means each queue only ever waits on its own kind.
    this._messageMutex            = new Mutex();
    this._receiptMutex            = new Mutex();
    this._notificationMutex       = new Mutex();
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
    // `stdTTL`, not `ttl` — see the note in DeviceManager. Written the other
    // way this held a group's participant list for the life of the connection,
    // so anyone who joined or left after it was first read stayed wrong until
    // a reconnect or an explicit { force: true }.
    this._groupMetaCache    = new NodeCache({ stdTTL: GROUP_META_CACHE_TTL });
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
    this._sentMsgCache     = new Map();   // msgId → {plaintext, toJid, msgId, mediaType, options, recipientPhone}
    // A sender that keeps more messages in flight than the cache holds outruns
    // its own ability to answer retries, so both bounds are open to being
    // raised for that kind of load.
    this._sentCacheSize    = Number(opts.sentCacheSize)  > 0 ? Number(opts.sentCacheSize)  : SENT_CACHE_SIZE;
    this._maxRetryResends  = Number(opts.maxRetryResends) > 0 ? Number(opts.maxRetryResends) : MAX_RETRY_RESENDS;
    this._tcTokenStore            = null; // TcTokenStore — loaded in init()
    this._inFlightTcTokenIssuance = new Set(); // dedupe concurrent proactive issuePrivacyTokens per JID
    this._inFlight463Recoveries   = new Set(); // dedupe concurrent 463-triggered token issuances per JID (separate from proactive)
    // Last known account restriction, or null until one is fetched or pushed.
    this._reachoutTimelock        = null;
    this._reachoutTimelockInFlight = null;
    // Blue-tick every message as it arrives. Set to false to make read receipts
    // explicit, sent only by a markRead() call.
    this.autoRead = opts.autoRead !== false;
    // Flipped by setOnline(). Delivery receipts sent while this is false carry
    // type="inactive", which the sender's app records but does not render.
    this._sendActiveReceipts = false;
    // Cached privacy settings. Warmed after connect and refreshed whenever the
    // server reports a change; markRead reads it.
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
    // A fresh attempt clears whatever made the last one fatal, and whatever
    // deliberate disconnect came before it. Only the public entry points reset
    // these — the reconnect loop must not clear its own guards.
    this._fatal   = false;
    this._closing = false;

    this._sessionDir = sessionDirFor(this._baseDir, phoneNumber);

    const sessionFile = path.join(this._sessionDir, `${phoneNumber}.json`);
    this._store = loadStore(sessionFile);
    if (!this._store) {
      // Say what is missing, and say it accurately. The old text pointed at
      // 'wa registration -R', a flag this CLI has never accepted, so anyone who
      // followed it got a second error instead of a registered number. A
      // library has no business teaching CLI syntax either — the caller knows
      // which interface it is; this only has to name the state.
      const hasWeb = fs.existsSync(path.join(this._sessionDir, `${phoneNumber}.web.json`));
      throw new Error(
        hasWeb
          ? `No primary session for ${phoneNumber}, but it is linked as a ` +
            'companion device — use connectWeb() rather than init().'
          : `No session for ${phoneNumber} — register the number first, or ` +
            'link it to an existing account with connectWeb().'
      );
    }

    const signalFile  = path.join(this._sessionDir, `${phoneNumber}.signal.json`);
    const skFile      = path.join(this._sessionDir, `${phoneNumber}.sk.json`);
    const tcTokenFile = path.join(this._sessionDir, `${phoneNumber}.tctoken.json`);

    const { TcTokenStore } = require('./messages/TcTokenStore');
    this._tcTokenStore = new TcTokenStore(tcTokenFile);
    this._appState = new AppStateStore(
      path.join(this._sessionDir, `${phoneNumber}.appState.json`));

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

    try {
      await this._connectSocket();
    } catch (err) {
      // A session filed under a number WhatsApp does not use fails here and
      // only here, with a 401 that says nothing about the number. Since we can
      // ask the server which form it uses, there is no reason to make anyone
      // find that out by hand.
      const fixed = await this._tryCorrectPhoneNumber(err);
      if (!fixed) throw err;
      return this.init(fixed);
    }
    return this;
  }

  /**
   * Last resort before reporting a refused login: check whether the session is
   * simply filed under the wrong form of the number, and re-file it if so.
   *
   * Returns the corrected number when it did something, null otherwise. Only
   * ever runs once per client — a second 401 after a rename is a real one.
   */
  async _tryCorrectPhoneNumber(err) {
    if (this._autoFixNumber === false) return null;
    if (this._numberFixAttempted) return null;
    if (!err || !err.loggedOut || String(err.code) !== '401') return null;
    this._numberFixAttempted = true;

    let probe;
    try {
      probe = await this.checkSessionAlive();
    } catch (_) {
      return null;
    }
    if (!probe || !probe.mismatch || !probe.canonical) return null;

    _whaDbg('[DBG] AUTO_FIX_NUMBER ' + probe.current + ' → ' + probe.canonical);

    // Let go of the session files before moving them. The Signal store writes
    // on a debounce, so a pending write would recreate the old file moments
    // after the rename and leave two half-sessions on disk.
    this._releaseSessionFiles();

    try {
      await this.adoptCanonicalNumber(probe.canonical);
    } catch (renameErr) {
      _whaDbg('[DBG] AUTO_FIX_NUMBER failed: ' + renameErr.message);
      return null;
    }

    this.emit('number_corrected', {
      from: probe.current,
      to:   probe.canonical,
      reason: 'WhatsApp files this account under a different form of the number'
    });
    return probe.canonical;
  }

  // Flush and detach whatever is holding the current session's files open, so
  // they can be renamed without a queued write putting one of them back.
  _releaseSessionFiles() {
    for (const store of [this._signal && this._signal.store,
                         this._signal && this._signal.senderKeyStore]) {
      if (!store) continue;
      try {
        if (typeof store.detach === 'function') store.detach();
        else {
          if (typeof store._flushSync === 'function') store._flushSync();
          if (store._saveTimer) { clearTimeout(store._saveTimer); store._saveTimer = null; }
          store._filePath = null;
        }
      } catch (_) {}
    }
    this._signal       = null;
    this._devMgr       = null;
    this._tcTokenStore = null;
  }

  async _connectSocket() {
    if (this._mode === 'web') return this._connectWebSocket();

    const socket = new NoiseSocket(this._store);
    this._socket = socket;

    // Recreate sender with updated socket reference
    this._sender = new MessageSender(this);

    socket.on('open',  (sn)  => this._onOpen(sn));
    socket.on('node',  node  => this._onNode(node));
    socket.on('close', ()    => this._onClose());
    socket.on('error', err   => this._onSocketError(err));

    // Pass reconnect attempt count into the Noise handshake ClientPayload
    this._store.connectAttemptCount = this._reconnectTry;
    await socket.connect();
    return socket;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WHATSAPP WEB (companion) MODE
  //
  // Same library, same public API, different way in. Instead of registering a
  // number over SMS as the account's primary device, we link to an account that
  // already exists — the way the web client and the desktop apps do. Everything
  // above the connection is unchanged: the Signal layer, the sender, the group
  // and media code all read the same store fields.
  //
  // Two things do differ once connected, and both are handled below:
  //   · our own JID carries a device index, so we are no longer device 0 and
  //     the account's phone becomes just another device we encrypt to;
  //   · the primary ships history over, which a primary device never receives.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Connect as a companion device.
   *
   * If the session has never been paired this resolves as soon as the encrypted
   * channel is up, leaving the caller to call requestPairingCode(). If it has,
   * it behaves like connect(): resolves once the server sends <success>.
   *
   * @param {string} phoneNumber  account phone number, digits only
   * @param {object} [opts]       { syncFullHistory, browser }
   */
  async connectWeb(phoneNumber, opts) {
    return this.initWeb(phoneNumber, opts);
  }

  async initWeb(phoneNumber, opts) {
    opts = opts || {};
    phoneNumber = String(phoneNumber).replace(/\D/g, '');
    this._phoneNumber = phoneNumber;
    this._mode = 'web';
    // Same as init(): a fresh attempt lifts both guards from the last one.
    this._fatal   = false;
    this._closing = false;

    const { createNewWebStore, loadWebStore, saveWebStore, webSessionPath } =
      require('./WebStore');

    this._sessionDir = sessionDirFor(this._baseDir, phoneNumber, { create: true });
    this._webSessionFile = webSessionPath(this._sessionDir, phoneNumber);
    this._store = loadWebStore(this._webSessionFile) || createNewWebStore(phoneNumber);

    if (opts.syncFullHistory !== undefined) this._store.syncFullHistory = !!opts.syncFullHistory;
    if (opts.browser) this._store.browser = opts.browser;

    // Announce the revision the web client is actually on.
    //
    // The web endpoint rejects an unrecognised version during the handshake
    // with <failure reason="405"> and says nothing about why, so a version
    // pinned in source is a connection that stops working on WhatsApp's
    // schedule rather than ours. Read the live one, keep the pinned value as
    // the fallback, and let a caller override both.
    if (opts.version) {
      this._store.webVersion = opts.version;
    } else if (opts.fetchVersion !== false) {
      const { fetchWaWebVersion } = require('./WebVersion');
      const res = await fetchWaWebVersion();
      this._store.webVersion = res.version;
      _whaDbg('[DBG] WEB_VERSION ' + res.version.join('.') +
        (res.isLatest ? ' (live)' : ' (pinned fallback: ' +
          (res.error && res.error.message) + ')'));
    }

    saveWebStore(this._store, this._webSessionFile);

    // Signal state lives in its own files so a web link and an SMS
    // registration for the same number never share sessions or pre-keys.
    const signalFile  = path.join(this._sessionDir, `${phoneNumber}.web.signal.json`);
    const skFile      = path.join(this._sessionDir, `${phoneNumber}.web.sk.json`);
    const tcTokenFile = path.join(this._sessionDir, `${phoneNumber}.web.tctoken.json`);

    const { TcTokenStore } = require('./messages/TcTokenStore');
    this._tcTokenStore = new TcTokenStore(tcTokenFile);
    this._appState = new AppStateStore(
      path.join(this._sessionDir, `${phoneNumber}.web.appState.json`));

    this._signal = SignalProtocol.fromStore(this._store, signalFile, skFile);
    this._devMgr = new DeviceManager(this);
    this._devMgr.attachSession(this._sessionDir, phoneNumber + '.web');

    const persistedLid = this._signal.store.getLidMappings
      ? this._signal.store.getLidMappings() : {};
    for (const [phone, lid] of Object.entries(persistedLid)) {
      this._pnToLid.set(phone, lid);
      this._lidToPn.set(lid, phone);
    }

    if (this._store.me && this._store.me.lid) this._myLid = this._store.me.lid;

    await this._connectWebSocket();
    return this;
  }

  _saveWebStore() {
    if (this._mode !== 'web' || !this._webSessionFile) return;
    const { saveWebStore } = require('./WebStore');
    saveWebStore(this._store, this._webSessionFile);
  }

  // Write the session back to disk, whichever kind it is. A change that only
  // lives in memory is a change that is gone at the next start.
  _persistStore() {
    try {
      if (this._mode === 'web') { this._saveWebStore(); return; }
      if (!this._sessionDir || !this._store || !this._store.phoneNumber) return;
      const { saveStore } = require('./Store');
      saveStore(this._store, path.join(this._sessionDir, `${this._store.phoneNumber}.json`));
    } catch (err) {
      _whaDbg('[DBG] STORE persist failed: ' + (err && err.message));
    }
  }

  async _connectWebSocket() {
    const { encodeCompanionRegisterPayload, encodeCompanionLoginPayload } =
      require('./webproto');

    const store      = this._store;
    const registered = !!store.registered && !!(store.me && store.me.id);

    const payloadOpts = {
      version:         store.webVersion,
      browser:         store.browser,
      countryCode:     'US',
      pushName:        store.name && store.name !== 'User' ? store.name : undefined,
      syncFullHistory: store.syncFullHistory !== false,
      registrationId:  store.registrationId,
      identityKeyPair: store.identityKeyPair,
      signedPreKey:    store.signedPreKey
    };

    const socket = new NoiseSocket(store, {
      transport:     'web',
      // An unpaired companion never gets <success> on this connection — the
      // server answers with pair-device and waits for a human to act.
      expectSuccess: registered,
      buildPayload:  () => registered
        ? encodeCompanionLoginPayload(Object.assign({}, payloadOpts, {
            username: store.phoneNumber,
            device:   store.deviceIndex || 0
          }))
        : encodeCompanionRegisterPayload(payloadOpts)
    });

    this._socket = socket;
    this._sender = new MessageSender(this);

    socket.on('open',    (sn) => this._onOpen(sn));
    socket.on('secured', ()   => {
      _whaDbg('[DBG] WEB_CHANNEL_SECURED — awaiting pairing');
      this.emit('web_ready_for_pairing');
    });
    socket.on('node',  node => this._onNode(node));
    socket.on('close', ()   => this._onClose());
    socket.on('error', err  => this._onSocketError(err));

    await socket.connect();
    return socket;
  }

  /**
   * A socket-level error, which includes the server refusing the handshake.
   *
   * The refusal arrives here rather than as a <failure> stanza — it happens
   * before the stream is open, so _handleFailure never sees it and never set
   * the flag that stops the reconnect. The result was a client that retried a
   * rejected login every second, forever, printing the same 401 each time.
   * Anything the handshake marked as a spent session stops the loop here.
   */
  _onSocketError(err) {
    // The server declined the client, not the session. The next attempt
    // announces exactly the same thing and is refused exactly the same way, so
    // this stops here instead of retrying once a second forever. _handleFailure
    // already reads a 405 this way, but it only runs once a stream is open — a
    // 405 during the handshake never reached it, which is why a refused client
    // reconnected in a loop.
    if (err && String(err.code) === '405') {
      _whaDbg('[DBG] HANDSHAKE_REJECTED code=405 — client refused, not a dead session');
      this._fatal       = true;
      this._reconnecting = false;
      this.emit('client_rejected', {
        reason:   '405',
        location: null,
        message:  err.message,
        node:     null
      });
      this.emit('error', err);
      return;
    }

    if (err && err.loggedOut) {
      _whaDbg('[DBG] HANDSHAKE_REJECTED code=' + err.code + ' — not retrying');
      this._fatal = true;
      this.emit('auth_failure', {
        reason: String(err.code || '401'),
        location: null,
        loggedOut: true,
        message: err.message
      });
    }
    this.emit('error', err);
  }

  /**
   * Ask WhatsApp for an 8-character pairing code.
   *
   * The account owner enters it on their phone under
   * Settings → Linked Devices → Link a device → Link with phone number instead.
   * The code is a password, not an identifier: it never travels to the server
   * in the clear, and both sides run it through PBKDF2 to wrap the ephemeral
   * keys they exchange.
   *
   * Resolves with the code as soon as the request is on the wire. The link
   * itself completes later — wait for the 'paired' or 'open' event.
   *
   * @param {string} [phoneNumber]  defaults to the number initWeb was given
   * @param {string} [customCode]   exactly 8 characters, if you want to choose
   * @returns {Promise<string>}
   */
  async requestPairingCode(phoneNumber, customCode) {
    if (this._mode !== 'web') {
      throw new Error('requestPairingCode is only available in web mode — call connectWeb() first');
    }
    if (!this._socket || !this._socket.secured) {
      throw new Error('Not connected — call connectWeb() before requesting a pairing code');
    }
    if (this._store.registered) {
      throw new Error('This session is already linked — no pairing code needed');
    }

    const { generatePairingCode, buildWrappedEphemeralPub, generateEphemeralKeyPair } =
      require('./PairingCode');
    const { platformTypeFor } = require('./webproto');

    if (customCode != null && String(customCode).length !== 8) {
      throw new Error('A custom pairing code must be exactly 8 characters');
    }

    const phone = String(phoneNumber || this._phoneNumber || this._store.phoneNumber)
      .replace(/\D/g, '');
    if (!phone) throw new Error('requestPairingCode: a phone number is required');

    const code = customCode ? String(customCode).toUpperCase() : generatePairingCode();

    // A fresh ephemeral pair per attempt: a code that was requested and never
    // used must not be able to complete a later exchange.
    this._store.pairingEphemeralKeyPair = generateEphemeralKeyPair();
    this._store.pairingCode = code;
    this._store.phoneNumber = phone;
    this._store.me = { id: phone + '@s.whatsapp.net', name: '~', lid: null };
    this._saveWebStore();

    const browser  = this._store.browser || ['Ubuntu', 'Chrome', '120.0.0.0'];
    const wrapped  = await buildWrappedEphemeralPub(code, this._store.pairingEphemeralKeyPair.public);

    // The bare 32-byte curve point, not the 33-byte Signal form.
    //
    // whalibmob stores every public key with the 0x05 type prefix, and the
    // Noise handshake strips it on the way out. This node had no such strip, so
    // the primary would have hashed 33 bytes where it expected 32 and the link
    // would fail with nothing to point at.
    const { stripKeyPrefix } = require('./PairingCode');
    const noisePub = stripKeyPrefix(this._store.noiseKeyPair.public);

    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'md'
    }, [
      new BinaryNode('link_code_companion_reg', {
        jid:   this._store.me.id,
        stage: 'companion_hello',
        should_show_push_notification: 'true'
      }, [
        new BinaryNode('link_code_pairing_wrapped_companion_ephemeral_pub', {}, wrapped),
        new BinaryNode('companion_server_auth_key_pub', {}, noisePub),
        new BinaryNode('companion_platform_id', {}, Buffer.from(
          String(platformTypeFor(browser[1])), 'utf8')),
        new BinaryNode('companion_platform_display', {}, Buffer.from(
          `${browser[1]} (${browser[0]})`, 'utf8')),
        new BinaryNode('link_code_pairing_nonce', {}, Buffer.from('0', 'utf8'))
      ])
    ]);

    _whaDbg('[DBG] REQUEST_PAIRING_CODE phone=' + phone + ' code=' + code);
    this._socket.sendNode(node);
    this.emit('pairing_code', { code, phoneNumber: phone });
    return code;
  }

  /**
   * Stage 3 of the pairing exchange, driven by the server.
   *
   * Arrives once the account owner has typed the code into their phone. We
   * unwrap the primary's ephemeral key with the key derived from that code, do
   * the two Diffie-Hellmans, and store adv_secret — the key pair-success will
   * be verified under.
   */
  async _handleCompanionFinish(node) {
    const { buildCompanionFinishBundle } = require('./PairingCode');

    const reg = findChild(node, 'link_code_companion_reg');
    if (!reg) return;

    const childBuf = (desc) => {
      const c = findChild(reg, desc);
      if (!c) return null;
      return Buffer.isBuffer(c.content) ? c.content
           : ArrayBuffer.isView(c.content) ? Buffer.from(c.content)
           : typeof c.content === 'string' ? Buffer.from(c.content, 'utf8')
           : null;
    };

    const ref                = childBuf('link_code_pairing_ref');
    const primaryIdentityPub = childBuf('primary_identity_pub');
    const wrappedEphemeral   = childBuf('link_code_pairing_wrapped_primary_ephemeral_pub');

    if (!ref || !primaryIdentityPub || !wrappedEphemeral) {
      _whaDbg('[DBG] COMPANION_FINISH missing fields — aborting');
      this.emit('error', new Error('Pairing failed: incomplete companion_finish from server'));
      return;
    }

    try {
      const { advSecretKey, wrappedKeyBundle } = await buildCompanionFinishBundle({
        pairingCode:                this._store.pairingCode,
        pairingEphemeralPrivate:    this._store.pairingEphemeralKeyPair.private,
        primaryEphemeralPubWrapped: wrappedEphemeral,
        primaryIdentityPub,
        identityKeyPair:            this._store.identityKeyPair
      });

      this._store.advSecretKey = advSecretKey;
      this._saveWebStore();
      _whaDbg('[DBG] COMPANION_FINISH adv_secret derived');

      // Awaited rather than fired and forgotten, so a server rejection surfaces
      // as an error here instead of as a silent stall waiting for a
      // pair-success that is never coming.
      const finishResult = await this._sendIq(new BinaryNode('iq', {
        to:    's.whatsapp.net',
        type:  'set',
        id:    this._genMsgId(),
        xmlns: 'md'
      }, [
        new BinaryNode('link_code_companion_reg', {
          jid:   this._store.me.id,
          stage: 'companion_finish'
        }, [
          new BinaryNode('link_code_pairing_wrapped_key_bundle', {}, wrappedKeyBundle),
          new BinaryNode('companion_identity_public', {},
            require('./PairingCode').stripKeyPrefix(this._store.identityKeyPair.public)),
          new BinaryNode('link_code_pairing_ref', {}, ref)
        ])
      ]));

      if (finishResult && finishResult.attrs && finishResult.attrs.type === 'error') {
        const errNode = findChild(finishResult, 'error');
        const code = errNode && errNode.attrs && errNode.attrs.code;
        throw new Error('server rejected companion_finish' + (code ? ' (' + code + ')' : ''));
      }
      _whaDbg('[DBG] COMPANION_FINISH accepted — awaiting pair-success');
    } catch (err) {
      _whaDbg('[DBG] COMPANION_FINISH_ERR ' + (err && err.message));
      this.emit('error', new Error('Pairing failed: ' + (err && err.message)));
    }
  }

  /**
   * <iq><pair-success> — the primary has authorised us.
   *
   * Verify what it sent, counter-sign it, reply, and persist. The server closes
   * the connection right after with a 515; the reconnect logs in normally and
   * that is when history starts arriving.
   */
  _handlePairSuccess(node) {
    const { configureSuccessfulPairing } = require('./CompanionPairing');
    try {
      const result = configureSuccessfulPairing(node, {
        advSecretKey:    this._store.advSecretKey,
        identityKeyPair: this._store.identityKeyPair
      }, BinaryNode);

      this._store.me          = result.me;
      this._store.deviceIndex = result.deviceIndex;
      this._store.platform    = result.platform;
      // The same field the mobile path fills from <success>: the signed device
      // identity that rides on outgoing pkmsg stanzas.
      this._store.advIdentity = result.accountEnc;
      this._store.registered  = true;
      this._store.pairingCode = null;
      if (result.me && result.me.name) this._store.name = result.me.name;
      this._saveWebStore();

      if (result.me && result.me.lid) {
        this._myLid = result.me.lid;
        const lidUser = String(result.me.lid).split('@')[0].split(':')[0];
        const pnUser  = String(result.me.id).split('@')[0].split(':')[0];
        this._lidToPn.set(lidUser, pnUser);
        this._pnToLid.set(pnUser, lidUser);
      }

      this._socket.sendNode(result.reply);
      this._sendUnifiedSession();
      _whaDbg('[DBG] PAIR_SUCCESS jid=' + result.me.id + ' lid=' + result.me.lid +
        ' device=' + result.deviceIndex);
      this.emit('paired', {
        jid:         result.me.id,
        lid:         result.me.lid,
        deviceIndex: result.deviceIndex,
        platform:    result.platform
      });
    } catch (err) {
      _whaDbg('[DBG] PAIR_SUCCESS_ERR ' + (err && err.message));
      this.emit('error', err);
    }
  }

  /**
   * <iq><pair-device> — the QR path.
   *
   * We do not display QR codes, but the node still has to be acknowledged or
   * the server keeps re-sending refs. The refs are surfaced as an event so a
   * caller that wants to render a QR can.
   */
  _handlePairDevice(node) {
    const id = node.attrs && node.attrs.id;
    if (id) {
      this._socket.sendNode(new BinaryNode('iq', {
        to: 's.whatsapp.net', type: 'result', id
      }, null));
    }
    const pairDevice = findChild(node, 'pair-device');
    const refs = pairDevice && Array.isArray(pairDevice.content)
      ? pairDevice.content
          .filter(c => c && c.description === 'ref')
          .map(c => (Buffer.isBuffer(c.content) ? c.content.toString('utf8') : String(c.content)))
      : [];
    this.emit('pair_device', { refs });
  }

  /**
   * The JID this device sends as.
   *
   * A primary is device 0 and its JID is the bare number. A companion occupies
   * a numbered slot, and the account's phone is then a peer we encrypt to like
   * any other linked device — which is exactly the difference the fan-out code
   * needs to know about.
   */
  _ownDeviceJid() {
    const phone = String(this._store.phoneNumber);
    const idx   = (this._mode === 'web' && this._store.deviceIndex) || 0;
    return idx > 0 ? `${phone}:${idx}@s.whatsapp.net` : `${phone}@s.whatsapp.net`;
  }

  // <ib><unified_session/> — the telemetry ping a web client emits after
  // pairing and after each login. It carries no state we need; sending it keeps
  // our traffic shaped like the client we are claiming to be. Failures are
  // ignored, as they are in the reference.
  _sendUnifiedSession() {
    if (this._mode !== 'web' || !this._socket) return;
    try {
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      const id = ((Date.now() + 3 * 24 * 60 * 60 * 1000) % WEEK_MS).toString();
      this._socket.sendNode(new BinaryNode('ib', {}, [
        new BinaryNode('unified_session', { id }, null)
      ]));
    } catch (_) {}
  }

  /** Same, in LID space. */
  _ownDeviceLidJid() {
    if (!this._myLid) return null;
    const lidUser = String(this._myLid).split('@')[0].split(':')[0];
    const idx = (this._mode === 'web' && this._store.deviceIndex) || 0;
    return idx > 0 ? `${lidUser}:${idx}@lid` : `${lidUser}@lid`;
  }

  /**
   * Close the connection, and keep it closed.
   *
   * Connect again through init() / initWeb() — those are where the caller says
   * it wants a connection, and where the guard below is lifted.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.reconnect=false]  drop the current socket but leave
   *        the reconnect loop armed. For a failure the server has told us is
   *        temporary, where coming back is the right answer.
   */
  disconnect(opts) {
    // Closing the socket makes it emit 'close', which lands in _onClose and
    // schedules a reconnect. That is right for a dropped connection and wrong
    // for a deliberate teardown — and it is what turned a single <failure> into
    // an endless retry loop, since clearing _reconnecting was not enough to
    // stop the handler that sets it again.
    //
    // For that to work the guard has to still be set when the 'close' arrives,
    // and it arrives on a later tick — a socket is destroyed now and reports it
    // afterwards. Clearing it at the end of this method, which is what it used
    // to do, meant _scheduleReconnect() never once saw it set: every deliberate
    // disconnect dialled straight back in a second later, and /reconnect ended
    // up with the old session live alongside the new one.
    //
    // Only ever set here, never cleared, so a teardown that means it cannot be
    // undone by a later one that does not.
    if (!(opts && opts.reconnect)) this._closing = true;
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

  /**
   * Ask the server whether this session's registration is still alive.
   *
   * The read-only /exist probe, run with the credentials already on disk. It
   * answers the question a 401 leaves open: whether the number is still
   * registered and only this device was cut loose, or whether the registration
   * is gone entirely. Sends nothing to the phone and requests no code, so it
   * is safe to run on a failure.
   *
   * @returns {Promise<{alive: boolean, status: string|null, raw: object|null, error?: string}>}
   */
  async checkSessionAlive() {
    if (!this._store) throw new Error('No session loaded');
    try {
      const res    = await checkIfRegistered(this._store);
      const status = (res && (res.status || res.reason)) || null;

      // The server answers with the number in its own canonical form. When that
      // differs from what the session is filed under, the handshake has been
      // presenting a username no registration matches — which is a 401 with a
      // completely different remedy from "register again".
      //
      // Brazil is where this bites: mobile numbers gained a ninth digit, and
      // WhatsApp keeps older accounts under the eight-digit form. Type the
      // number as it appears on the phone and you get a session whose username
      // the server has never heard of.
      const canonical = res && res.login ? String(res.login).replace(/\D/g, '') : null;
      const current   = String(this._store.phoneNumber || '');
      const mismatch  = !!(canonical && canonical !== current);

      return {
        alive: status === 'ok',
        status,
        canonical,
        current,
        mismatch,
        raw: res
      };
    } catch (err) {
      return { alive: false, status: null, raw: null, error: err.message };
    }
  }

  /**
   * Re-file this session under the number the server actually knows it by.
   *
   * Renames the session and every file that hangs off it, then reloads. Only
   * touches the primary (SMS) session — a companion link is keyed by the
   * account, not by the form of the number.
   *
   * @param {string} canonical  the digits the server returned as `login`
   */
  async adoptCanonicalNumber(canonical) {
    canonical = String(canonical || '').replace(/\D/g, '');
    if (!canonical) throw new Error('adoptCanonicalNumber: no number given');
    const current = String(this._store && this._store.phoneNumber || '');
    if (canonical === current) return { renamed: false, phoneNumber: current };

    const wasConnected = this._connected;
    if (wasConnected) this.disconnect();

    // Every per-session file shares the phone number as its stem.
    // Both layouts: the files are renamed where they sit, and when they sit in
    // a directory named after the old number that directory is renamed too —
    // otherwise +<canonical> would live in a folder called +<current> and the
    // next lookup would not find it.
    const fromDir = this._sessionDir;
    const toDir   = isLegacyLayout(this._baseDir, current)
      ? this._baseDir
      : path.join(this._baseDir, canonical);

    if (toDir !== fromDir && fs.existsSync(toDir)) {
      throw new Error('Cannot rename session: ' + toDir +
        ' already exists. Move it aside first.');
    }

    const moved = [];
    for (const suffix of SESSION_SUFFIXES) {
      const from = path.join(fromDir, current + suffix);
      const to   = path.join(fromDir, canonical + suffix);
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        throw new Error('Cannot rename session: ' + canonical + suffix +
          ' already exists. Move it aside first.');
      }
      fs.renameSync(from, to);
      moved.push(suffix);
    }
    if (!moved.length) throw new Error('No session files found for ' + current);

    if (toDir !== fromDir) {
      fs.renameSync(fromDir, toDir);
      this._sessionDir = toDir;
    }

    // The number is inside the store as well as in the filename.
    const sessionFile = path.join(this._sessionDir, canonical + '.json');
    const store = loadStore(sessionFile);
    if (!store) throw new Error('Session file unreadable after rename');
    store.phoneNumber = canonical;
    saveStore(store, sessionFile);

    _whaDbg('[DBG] ADOPT_CANONICAL ' + current + ' → ' + canonical +
      ' files=' + moved.length);

    this._store = store;
    this._phoneNumber = canonical;
    this._fatal = false;
    return { renamed: true, phoneNumber: canonical, files: moved };
  }

  // ─── Reconnection ─────────────────────────────────────────────────────────

  _scheduleReconnect() {
    // A fatal failure — the account logged us out, or the server refused the
    // client outright — will fail identically every time. Retrying it only
    // fills the terminal.
    if (this._closing || this._fatal) return;
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
    // Ask what the server still has rather than uploading blind. It answers
    // with a number this side has no other way of learning, and then with the
    // bundle it is serving, which is the thing that goes quietly wrong and
    // takes the account's reachability with it.
    this._ensureServerPreKeys('login')
      .then(() => this._verifyServerKeyBundle('login'));

    // Same telemetry ping the web client sends on every completed login.
    this._sendUnifiedSession();

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

    // The one place the server ever tells us what it thinks this account is
    // called. Nothing else answers that question — there is no request that
    // reads a push name back — so this is both how the local name is kept
    // honest and the only way to find out whether a rename was accepted.
    if (attrs.display_name) {
      const serverName = String(attrs.display_name);
      if (this._store && this._store.name !== serverName) {
        _whaDbg('[DBG] SUCCESS display_name="' + serverName + '" — server disagrees with the ' +
          'stored name "' + this._store.name + '"; taking the server\'s');
        this._store.name = serverName;
        if (!this._store.pushName) this._store.pushName = serverName;
        this._persistStore();
      } else {
        _whaDbg('[DBG] SUCCESS display_name="' + serverName + '" — matches the stored name');
      }
    } else {
      _whaDbg('[DBG] SUCCESS carried no display_name — the server did not say what this ' +
        'account is called');
    }
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
        if (this._mode === 'web') {
          this._saveWebStore();
        } else {
          const sessionFile = path.join(
            this._sessionDir,
            `${this._store.phoneNumber}.json`
          );
          try {
            const { saveStore } = require('./Store');
            saveStore(this._store, sessionFile);
          } catch (_) {}
        }
      }
    } else if (this._store.advIdentity) {
      // Already have it persisted from a previous session — keep using it
    }

    // A companion learns its own LID from pair-success, not from <success>, so
    // keep what pairing established rather than leaving it unset on reconnect.
    if (this._mode === 'web') {
      if (!this._myLid && this._store.me && this._store.me.lid) {
        this._myLid = this._store.me.lid;
      }
      if (attrs.lid && this._store.me) {
        this._store.me.lid = String(attrs.lid);
        this._saveWebStore();
      }
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

  // ── <ib> dirty-state notifications ────────────────────────────────────────
  //
  // After login the server sends <ib><dirty type="account_sync"/></ib> to say
  // our app state is behind. Each dirty type names what has moved on; the sync
  // that follows asks for it from the version we last stored.
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
  /**
   * Acknowledge a dirty bit so the server stops announcing it.
   *
   * `<ib><dirty type="..."/></ib>` is the server saying something changed while
   * we were away. Whatever the client does about it, the bit has to be cleared
   * or the same announcement arrives on every connection.
   *
   * @param {string} type            the dirty type, e.g. 'groups'
   * @param {number|string} [fromTs] the timestamp the announcement carried
   */
  _cleanDirtyBits(type, fromTs) {
    if (!this._socket || !this._connected) return;
    const attrs = { type: String(type) };
    if (fromTs) attrs.timestamp = String(fromTs);
    _whaDbg('[DBG] CLEAN_DIRTY type=' + type + (fromTs ? ' t=' + fromTs : ''));
    this._socket.sendNode(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'urn:xmpp:whatsapp:dirty'
    }, [new BinaryNode('clean', attrs, null)]));
  }

  /**
   * Re-read every group we belong to, then acknowledge the dirty bit.
   *
   * Best effort on purpose: the bit has to be cleared either way, or the server
   * announces the same change on every connection from now on.
   */
  _refreshGroupsAfterDirty(type) {
    Promise.resolve()
      .then(() => this.fetchAllGroups())
      .then(groups => {
        _whaDbg('[DBG] DIRTY groups — refreshed ' + (groups ? groups.length : 0) + ' group(s)');
      })
      .catch(err => {
        _whaDbg('[DBG] DIRTY groups — refresh failed: ' + (err && err.message));
      })
      .then(() => this._cleanDirtyBits(type));
  }

  _sendAppStateSyncForTypes(dirtyTypes) {
    if (!this._socket || !this._connected) return;

    // "account_sync" means everything; the rest name one collection each.
    // Anything not in here is a dirty bit that travels by some other route.
    const COLLECTION_MAP = {
      account_sync:         COLLECTIONS.slice(),
      critical_block:       ['critical_block'],
      critical_unblock_low: ['critical_unblock_low'],
      regular_low:          ['regular_low'],
      regular_high:         ['regular_high'],
      regular:              ['regular']
    };

    const collections = new Set();
    for (const type of dirtyTypes) {
      const mapped = COLLECTION_MAP[type];
      if (!mapped) {
        if (type === 'groups') {
          // The bit means something about our groups changed while we were
          // away. Clearing it without looking leaves every cached group sitting
          // on the membership and settings it had before we disconnected, so
          // re-read them first and acknowledge after.
          this._refreshGroupsAfterDirty(type);
          continue;
        }
        // Not an app-state collection, but still a dirty bit the server expects
        // to be cleared. Ignoring it meant the server re-announced it on every
        // single connection, forever.
        _whaDbg('[DBG] DIRTY type=' + type + ' — not an app-state collection, clearing the bit');
        this._cleanDirtyBits(type);
        continue;
      }
      for (const c of mapped) collections.add(c);
    }

    if (collections.size === 0) return;

    // The bit has to be cleared whatever came of the sync. A session that
    // cannot sync at all — no key has ever been shared with it, which is every
    // session that registered its own number — would otherwise leave it set
    // forever and be told about the same change on every single connection.
    const clearAll = () => {
      for (const type of dirtyTypes) {
        if (COLLECTION_MAP[type]) this._cleanDirtyBits(type);
      }
    };

    this.syncAppState([...collections])
      .then(clearAll)
      .catch(err => {
        _whaDbg('[DBG] APP_STATE sync failed: ' + (err && err.message));
        clearAll();
      });
  }

  /**
   * Pull app state down from the server and apply it.
   *
   * This is how everything that is not a message reaches a linked device:
   * which chats are pinned, archived, muted or marked unread, which messages
   * are starred, what your contacts are called. It is also the only way those
   * changes travel *back* — see the chat methods further down, which write
   * patches rather than mutating anything locally.
   *
   * A collection is asked for from the version we hold, and the server answers
   * with the patches since then. From version 0 it sends a snapshot instead:
   * the whole collection, which is also what we fall back to when the running
   * hash stops agreeing with the server's.
   *
   * @param {string[]} [names]  collections to sync; all of them by default
   * @param {object}   [opts]   { snapshot: true } to force a full re-read
   * @returns {Promise<{applied: number, collections: object}>}
   */
  async syncAppState(names, opts) {
    opts = opts || {};
    if (!this._socket || !this._connected) throw new Error('Not connected');
    if (!this._appState) throw new Error('No session — call init() first');

    const wanted = (names && names.length ? names : COLLECTIONS)
      .filter(n => COLLECTIONS.includes(n));
    if (!wanted.length) return { applied: 0, collections: {} };

    const keys = this._appStateKeys();
    if (!Object.keys(keys).length) {
      // The keys arrive from the primary device in an encrypted message. Until
      // one has, there is nothing that can be decrypted and asking would only
      // throw the patches away.
      _whaDbg('[DBG] APP_STATE no sync keys yet — skipping');
      return { applied: 0, collections: {}, waitingForKeys: true };
    }

    const nodes = wanted.map(name => {
      const st = this._appState.get(name);
      const wantSnapshot = !!opts.snapshot || !st.version;
      return new BinaryNode('collection', {
        name,
        version:         String(wantSnapshot ? 0 : st.version),
        return_snapshot: wantSnapshot ? 'true' : 'false'
      }, null);
    });

    const resp = await this._sendIq(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:sync:app:state'
    }, [new BinaryNode('sync', {}, nodes)]));

    if (!resp) throw new Error('syncAppState: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('syncAppState: server rejected the request' +
        (code ? ' (' + code + ')' : ''));
    }

    return this._applyAppStateResponse(resp, opts);
  }

  /**
   * The sync keys the primary device has shared, keyed by base64 id.
   *
   * They are stored under their hex id but every reference on the wire is
   * base64, so both spellings are returned and a lookup either way works.
   */
  _appStateKeys() {
    if (!this._store || !this._store.phoneNumber) return {};
    let raw;
    try { raw = loadAppStateSyncKeys(this._sessionDir, this._store.phoneNumber) || {}; }
    catch (_) { raw = {}; }
    const out = {};
    for (const [hexId, v] of Object.entries(raw)) {
      out[hexId] = v;
      try { out[Buffer.from(hexId, 'hex').toString('base64')] = v; } catch (_) {}
    }
    return out;
  }

  async _applyAppStateResponse(resp, opts) {
    const syncNode = findChild(resp, 'sync');
    const cols     = (syncNode && Array.isArray(syncNode.content))
      ? syncNode.content.filter(n => n && n.description === 'collection') : [];

    const keys    = this._appStateKeys();
    const getKey  = (b64) => keys[b64] || null;
    const summary = {};
    let   applied = 0;
    let   more    = [];

    for (const col of cols) {
      const name = col.attrs && col.attrs.name;
      if (!name || !COLLECTIONS.includes(name)) continue;

      const mutations = [];
      const collect   = (m) => mutations.push(m);
      let   result    = null;
      let   snapshotted = false;

      try {
        const snapNode = findChild(col, 'snapshot');
        if (snapNode && snapNode.content) {
          const blob = await this._fetchAppStateBlob(
            SyncdProto.decodeExternalBlobReference(getNodeContent(snapNode)));
          const snap = SyncdProto.decodeSnapshot(blob);
          result = AppStateSync.decodeSnapshot(name, snap, getKey, collect, true);
          snapshotted = true;
        } else {
          const patchesNode = findChild(col, 'patches') || col;
          const raw = (Array.isArray(patchesNode.content) ? patchesNode.content : [])
            .filter(n => n && n.description === 'patch' && getNodeContent(n))
            .map(n => SyncdProto.decodePatch(getNodeContent(n)));

          // A patch too big to inline is moved into a CDN blob and referenced.
          for (const p of raw) {
            if (!p.externalMutations) continue;
            const blob = await this._fetchAppStateBlob(p.externalMutations);
            p.mutations = p.mutations.concat(SyncdProto.decodeMutations(blob));
          }
          if (!raw.length) { summary[name] = { patches: 0, applied: 0 }; continue; }
          result = AppStateSync.decodePatches(
            name, raw, this._appState.get(name), getKey, collect, true);
        }
      } catch (err) {
        if (err && err.isMissingKey) {
          // Nothing can be read until the primary shares that key. Leave the
          // collection where it is so the next sync picks up from here.
          _whaDbg('[DBG] APP_STATE ' + name + ' waiting for key ' + err.keyId);
          summary[name] = { waitingForKey: err.keyId };
          this.emit('app_state_key_missing', { collection: name, keyId: err.keyId });
          continue;
        }
        throw err;
      }

      // Our hash and the server's have parted company. Every patch after the
      // break would be applied to the wrong base, so throw our copy away and
      // ask for the whole collection instead — once. If the snapshot itself
      // does not verify, keep what we could read and say so.
      if (result.macFailed && !snapshotted && !opts.snapshot) {
        _whaDbg('[DBG] APP_STATE ' + name + ' hash mismatch — refetching as snapshot');
        this._appState.reset(name);
        more.push(name);
        continue;
      }

      this._appState.set(name, result.state);
      applied += this._applyAppStateMutations(name, mutations);
      summary[name] = {
        version: result.state.version,
        applied: mutations.length,
        skipped: result.skipped || 0,
        snapshot: snapshotted,
        macOk: snapshotted ? result.macOk !== false : !result.macFailed
      };

      if (col.attrs && col.attrs.has_more_patches === 'true') more.push(name);
    }

    if (more.length && !opts._retried) {
      const again = await this.syncAppState(more, Object.assign({}, opts, { _retried: true }));
      applied += again.applied;
      Object.assign(summary, again.collections);
    }

    this.emit('app_state_sync', { collections: summary, applied });
    return { applied, collections: summary };
  }

  /** Fetch and decrypt an app-state blob the server pushed to the CDN. */
  async _fetchAppStateBlob(ref) {
    if (!ref || !ref.mediaKey) throw new Error('app state blob reference is incomplete');
    const { downloadMedia, resolveMediaUrl } = require('./MediaService');
    const url = resolveMediaUrl(null, ref.directPath);
    if (!url) throw new Error('app state blob has no directPath');
    return downloadMedia(url, ref.mediaKey, 'WhatsApp App State Keys', {
      web: this._mode === 'web'
    });
  }

  /**
   * Fold decoded mutations into the local view and announce them.
   *
   * These are changes made somewhere else — on the phone, or on another linked
   * device — so they are applied without being echoed back as patches of our
   * own, which would bounce between devices forever.
   */
  _applyAppStateMutations(collection, mutations) {
    let count = 0;
    for (const m of mutations) {
      const what = AppMutations.describeIndex(m.index);
      if (!what) continue;
      const removed = m.operation === SyncdProto.REMOVE;
      const a       = m.action || {};
      const jid     = what.jid ? makeJid(what.jid) : null;

      switch (what.kind) {
        case 'pin': {
          const pinned = !removed && !!(a.pinAction && a.pinAction.pinned);
          this._getChatState(jid).pinnedAt = pinned ? (a.timestamp ? Math.floor(a.timestamp / 1000) : Math.floor(Date.now() / 1000)) : 0;
          this.emit('chat_pinned', { jid, pinned, remote: true });
          break;
        }
        case 'archive': {
          const archived = !removed && !!(a.archiveChatAction && a.archiveChatAction.archived);
          this._getChatState(jid).archived = archived;
          this.emit('chat_archived', { jid, archived, remote: true });
          break;
        }
        case 'mute': {
          const mute    = a.muteAction || {};
          const muted   = !removed && !!mute.muted;
          const chat    = this._getChatState(jid);
          chat.muted       = muted;
          chat.muteUntilMs = muted ? (Number(mute.muteEndTimestamp) || -1) : 0;
          this.emit('chat_muted', { jid, muted, until: chat.muteUntilMs, remote: true });
          break;
        }
        case 'markRead': {
          const read = !removed && !!(a.markChatAsReadAction && a.markChatAsReadAction.read);
          this._getChatState(jid).markedAsUnread = !read;
          this.emit('chat_read', { jid, read, remote: true });
          break;
        }
        case 'star': {
          const starred = !removed && !!(a.starAction && a.starAction.starred);
          if (!this._starredMessages) this._starredMessages = new Set();
          const key = jid + ':' + what.msgId;
          if (starred) this._starredMessages.add(key); else this._starredMessages.delete(key);
          this.emit('message_starred', {
            msgId: what.msgId, chatJid: jid, starred, fromMe: what.fromMe, remote: true
          });
          break;
        }
        case 'contact': {
          const c = a.contactAction || {};
          this.emit('contact_update', {
            jid,
            name:      c.fullName || c.firstName || null,
            firstName: c.firstName || null,
            lid:       c.lidJid || null,
            username:  c.username || null,
            removed,
            remote:    true
          });
          break;
        }
        case 'pushName': {
          const name = (a.pushNameSetting && a.pushNameSetting.name) || null;
          // Both fields, and to disk. Only `pushName` was set here, and it is
          // the one the store does not carry — so a rename made on another
          // device took effect until the process restarted, and never reached
          // the handshake, which announces `name`.
          if (name && this._store) {
            this._store.name     = name;
            this._store.pushName = name;
            this._persistStore();
          }
          this.emit('push_name_update', { name, remote: true });
          break;
        }
        case 'clear':
        case 'delete':
          this.emit('chat_removed', { jid, kind: what.kind, remote: true });
          break;
        default:
          // Something the server tracks that this library does not model yet.
          // Reported rather than dropped, so it is visible that it happened.
          this.emit('app_state_mutation', {
            collection, index: m.index, action: a, removed
          });
          break;
      }
      count++;
    }
    return count;
  }

  /**
   * Whether this session can write app state at all.
   *
   * App-state keys travel one way: the primary device shares them with the
   * companions it has linked. A companion always gets one. A session that
   * registered over SMS *is* the primary, so unless it has linked a companion
   * of its own there is no key in existence and nothing to sign a patch with.
   */
  canSyncAppState() {
    return !!this._newestAppStateKey(this._appStateKeys());
  }

  /**
   * Write a change into app state when that is possible, and fall back to
   * whatever the connection can do otherwise.
   *
   * Without this, every chat setting would throw on an SMS session — which is
   * exactly the connection least able to do anything about it, since the key it
   * is being asked for is one only it could ever create.
   *
   * @returns {Promise<boolean>} whether the change was written to app state,
   *                             and so will reach other devices
   */
  async _appStatePatchOrFallback(desc, fallback) {
    if (this.canSyncAppState()) {
      await this._sendAppStatePatch(desc);
      return true;
    }
    if (typeof fallback === 'function') await fallback();
    return false;
  }

  /**
   * Write one change into app state, so it reaches the phone and every other
   * linked device.
   *
   * The local view is updated from the same description that goes on the wire,
   * so what a caller sees immediately is what the other devices will see.
   */
  async _sendAppStatePatch(desc) {
    if (!this._socket || !this._connected) throw new Error('Not connected');
    if (!this._appState) throw new Error('No session — call init() first');

    const chosen = this._newestAppStateKey(this._appStateKeys());
    if (!chosen) {
      throw new Error('cannot write app state yet: the primary device has not ' +
        'shared a sync key with this session');
    }

    const state = this._appState.get(desc.name);
    const { patch, state: next } = AppStateSync.buildPatch(
      desc, chosen.id, chosen.keyData, state);

    const resp = await this._sendIq(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:sync:app:state'
    }, [
      new BinaryNode('sync', {}, [
        new BinaryNode('collection', {
          name:            desc.name,
          version:         String(next.version - 1),
          return_snapshot: 'false'
        }, [new BinaryNode('patch', {}, patch)])
      ])
    ]));

    if (!resp) throw new Error('app state patch: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      // The server did not take it, so our state must not move on either.
      throw new Error('app state patch rejected by server' + (code ? ' (' + code + ')' : ''));
    }

    this._appState.set(desc.name, next);
    return next.version;
  }

  // The most recently shared key, which is the one to sign new patches with.
  //
  // Both spellings of every id are in the map, so the hex ones are passed over
  // — a patch names its key in base64.
  _newestAppStateKey(keys) {
    let best = null;
    for (const [id, v] of Object.entries(keys || {})) {
      if (!v || !v.keyData) continue;
      if (/^[0-9a-f]+$/i.test(id)) continue;
      if (!best || (v.timestamp || 0) > (best.timestamp || 0)) {
        best = { id, keyData: v.keyData, timestamp: v.timestamp || 0 };
      }
    }
    return best;
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

    // The server is supposed to say when it is running out of one-time keys,
    // and mostly does. This is for when it does not: a session that stays up
    // long enough can be drained without a word, and the first sign of it is
    // that nobody can reach the account any more.
    this._preKeyTimer = setInterval(() => {
      if (this._socket && this._connected) this._ensureServerPreKeys('periodic');
    }, PRE_KEY_CHECK_INTERVAL);
  }

  _stopTimers() {
    if (this._pingTimer)   { clearInterval(this._pingTimer);   this._pingTimer   = null; }
    if (this._keepTimer)   { clearInterval(this._keepTimer);   this._keepTimer   = null; }
    if (this._preKeyTimer) { clearInterval(this._preKeyTimer); this._preKeyTimer = null; }
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

    // One malformed stanza must not take the connection down with it.
    //
    // A throw here propagates out through the socket's frame reader, which
    // reports it as a socket error — so a single unhandled shape in one
    // notification looked like the transport failing, and every stanza queued
    // behind it in the same offline batch was lost. Contain it: log the stanza
    // that did it, tell the caller, carry on reading.
    try {
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
      else if (tag === 'stream:error') this._handleStreamError(node);
      else                             this.emit('node', node);
    } catch (err) {
      _whaDbg('[DBG] NODE_HANDLER_ERR tag=' + tag + ' err=' + (err && err.message) +
        ' attrs=' + JSON.stringify(node.attrs || {}));
      this.emit('node_error', { tag, node, err });
    }
  }

  // A stream error ends the connection; the reconnect in _onClose picks it up.
  //
  // 515 is not a failure. The server sends it immediately after a companion
  // finishes pairing to say "you are linked now, start over as a normal
  // client" — the next connection carries the login payload instead of the
  // pairing bundle, and that is the one that receives history.
  _handleStreamError(node) {
    const attrs  = (node && node.attrs) || {};
    const code   = attrs.code ? String(attrs.code) : null;

    if (code === '515') {
      _whaDbg('[DBG] STREAM_ERROR 515 — restart required after pairing, reconnecting');
      this.emit('restart_required', { reason: '515' });
      return;
    }

    // Most stream errors carry no code at all — the reason is a child element,
    // and for <conflict> the type attribute on it says which kind. Reading only
    // the attributes reported every one of these as "code=null reason=unknown",
    // which is the same message for a session someone else took over and a
    // session that was deleted.
    const child       = Array.isArray(node.content) && node.content[0] ? node.content[0] : null;
    const childTag    = child && child.description ? child.description : null;
    const conflictType = childTag === 'conflict' && child.attrs
      ? String(child.attrs.type || '') : null;

    if (conflictType === 'replaced') {
      // Another client opened a session for this account and the server handed
      // it over. Reconnecting immediately just takes it back, and the two ends
      // trade the session until one of them is stopped — so this one stands
      // down and says why.
      _whaDbg('[DBG] STREAM_ERROR conflict/replaced — another client took the session');
      this._fatal = true;
      this.emit('connection_replaced', {
        message: 'Another client connected with this number and took over the ' +
                 'session. Reconnecting would take it back and the two would ' +
                 'keep displacing each other, so this connection has stopped. ' +
                 'Close the other client, then connect again.'
      });
      this.disconnect();
      return;
    }

    if (conflictType === 'device_removed') {
      // The companion was unlinked from the phone. Same meaning as a 401.
      _whaDbg('[DBG] STREAM_ERROR conflict/device_removed — unlinked');
      this._fatal = true;
      this.emit('auth_failure', {
        reason: '401', location: null, loggedOut: true, node
      });
      this.disconnect();
      return;
    }

    const reason = attrs.reason || conflictType || childTag || code || 'unknown';
    _whaDbg('[DBG] STREAM_ERROR code=' + code + ' child=' + childTag +
      ' conflict=' + conflictType + ' reason=' + reason);
    this.emit('stream_error', { reason, code, conflictType, childTag, node });
  }

  // ─── IQ handling ──────────────────────────────────────────────────────────

  _handleIq(node) {
    const id    = node.attrs && node.attrs.id;
    const type  = node.attrs && node.attrs.type;
    const xmlns = node.attrs && node.attrs.xmlns;

    // Companion pairing — these arrive unsolicited, so they are checked before
    // the pending-IQ table rather than after it.
    //
    // pair-device is matched on type=set; pair-success is matched on any type.
    // Requiring type=set on pair-success would drop the stanza that completes
    // the link.
    if (this._mode === 'web') {
      if (type === 'set' && findChild(node, 'pair-device')) { this._handlePairDevice(node);  return; }
      if (findChild(node, 'pair-success'))                  { this._handlePairSuccess(node); return; }
    }

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

  // Put work on one of the incoming queues.
  //
  // Never rejects, and never awaited by the caller: the socket reader must keep
  // reading, and one stanza that fails must not take the ones queued behind it
  // with it. What the lock buys is order, not delivery of a result.
  _queueIncoming(mutex, label, fn) {
    return mutex.runExclusive(fn).catch(err =>
      _whaDbg('[DBG] ' + label + '_QUEUE_ERR ' + (err && err.message)));
  }

  async _handleMessage(node) {
    const attrs = node.attrs || {};
    const fromRaw = attrs.from  || null;
    const partRaw = attrs.participant || null;
    const from  = String(attrs.from  || '');
    const id    = String(attrs.id    || '');
    const ts    = parseInt(attrs.t || '0', 10);
    const participant = String(attrs.participant || from);
    const senderPn  = attrs.sender_pn  ? String(attrs.sender_pn)  : null;
    const senderLid = attrs.sender_lid ? String(attrs.sender_lid) : null;

    // Learn the LID ↔ phone pairing from whichever side the stanza names.
    //
    // Decryption needs it: a message addressed by LID has to be able to find a
    // session filed under the phone JID, and the other way round. The pairing
    // is only ever visible on a stanza that carries both names, so every such
    // stanza is worth reading — sender_pn against a LID `from`, and sender_lid
    // against a phone one.
    const fromUser = from.split('@')[0].split(':')[0];
    let learnedLid = null, learnedPn = null;
    if (senderPn && from.endsWith('@lid')) {
      learnedLid = fromUser;
      learnedPn  = senderPn.split('@')[0].split(':')[0];
    } else if (senderLid && !from.endsWith('@lid')) {
      learnedPn  = fromUser;
      learnedLid = senderLid.split('@')[0].split(':')[0];
    }
    if (learnedLid && learnedPn && learnedLid !== learnedPn) {
      this._lidToPn.set(learnedLid, learnedPn);
      this._pnToLid.set(learnedPn, learnedLid);
      // Persist so the mapping survives reconnects / process restarts
      if (this._signal && this._signal.store && this._signal.store.setLidMapping) {
        this._signal.store.setLidMapping(learnedPn, learnedLid);
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

    // The acknowledgement goes out first and stays outside the queue below.
    // It tells the server the stanza arrived, and it has to be prompt whatever
    // the decryption goes on to do — holding it behind a queue of other
    // people's messages is how a client stops looking like it is listening.
    if (skmsgNode && isGroup) {
      this._sendMessageAck(id, fromRaw, partRaw);
      this._sendDeliveryReceipt(id, fromRaw, partRaw);
      this._queueIncoming(this._messageMutex, 'MSG', async () => {
        // SKDM must be processed (awaited) before we attempt skmsg decryption,
        // because the first message from a sender always bundles both together.
        if (participantsNode) {
          await this._processSKDMDistribution(from, participant, participantsNode);
        }
        await this._decryptGroupMessage({ node, from, participant, fromRaw, partRaw, id, ts, skmsgNode });
      });
      return;
    }

    if (dmEncNode && this._signal) {
      this._sendMessageAck(id, fromRaw, partRaw);
      this._sendDeliveryReceipt(id, fromRaw, partRaw);
      this._queueIncoming(this._messageMutex, 'MSG', () =>
        this._decryptDMMessage({ node, from, participant, fromRaw, partRaw, senderPn, id, ts, dmEncNode }));
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

  // The other name this contact answers to, with the device kept.
  //
  // A Signal address is user plus device, so the device has to survive the
  // translation — 250139683860650:5@lid and 40752248147:5@s.whatsapp.net are
  // the same device, 40752248147:0 is a different one.
  //
  // Returns null when there is no mapping for this user yet.
  _counterpartJid(jid) {
    if (!jid) return null;
    const str  = String(jid);
    const user = str.split('@')[0].split(':')[0];
    if (!user) return null;
    const colon  = str.split('@')[0].indexOf(':');
    const device = colon >= 0 ? str.split('@')[0].slice(colon) : '';

    if (str.endsWith('@lid')) {
      const pn = this._lidToPn && this._lidToPn.get(user);
      return pn ? pn + device + '@s.whatsapp.net' : null;
    }
    const lid = this._pnToLid && this._pnToLid.get(user);
    return lid ? lid + device + '@lid' : null;
  }

  // Every address this message's session might be filed under, best first.
  _signalJidCandidates(from, participant, senderPn) {
    const out = [];
    const add = (jid) => {
      if (!jid) return;
      const str = String(jid);
      if (str && !out.includes(str)) out.push(str);
    };

    // Unchanged from before: the phone JID the stanza named, or the sender.
    add(senderPn || ((participant && participant !== from) ? participant : from));
    // Then the other name for each of them.
    add(this._counterpartJid(out[0]));
    add(participant && participant !== from ? participant : null);
    add(from);
    add(this._counterpartJid(participant && participant !== from ? participant : from));

    return out;
  }

  // Every address a group participant might be filed under.
  //
  // Deliberately not _signalJidCandidates: that one starts from the stanza's
  // `from`, which in a group is the group itself and is not a Signal address at
  // all. Here the sender is the only subject, under both of the names the same
  // person answers to.
  _senderAddressCandidates(senderJid, senderPn) {
    const out = [];
    const add = (jid) => {
      if (!jid) return;
      const str = String(jid);
      if (str && !out.includes(str)) out.push(str);
    };
    add(senderJid);
    add(this._counterpartJid(senderJid));
    add(senderPn);
    add(this._counterpartJid(senderPn));
    return out;
  }

  // The sender key for a group message, under whichever name it was filed.
  //
  // A SenderKeyName keeps the user and the device and drops the domain, so the
  // LID form and the phone form of one person are two different names for one
  // key. Which of them a message arrives under is the server's choice and it
  // varies, so a key stored under the name one stanza used is invisible to the
  // next stanza that names the other. That is the whole of "No session found to
  // decrypt message" on a group we have only just joined.
  async _senderKeyDecryptWithCandidates(groupJid, candidates, cipherBuf, id) {
    let firstErr = null;
    for (let i = 0; i < candidates.length; i++) {
      try {
        const plaintext = await this._signal.senderKeyDecrypt(groupJid, candidates[i], cipherBuf);
        if (i > 0) {
          _whaDbg('[DBG] GROUP_DECRYPT id=' + id + ' recovered under ' + candidates[i] +
            ' after ' + candidates[0] + ' held no sender key');
        }
        return plaintext;
      } catch (err) {
        if (!firstErr) firstErr = err;
        // Only "we hold nothing under this name" is worth asking another name
        // about. A record that exists and refuses the message is a different
        // problem, and the answer to that is a retry receipt, not another
        // lookup.
        if (!/no session found|no senderkeyrecord/i.test(String(err && err.message))) break;
      }
    }
    throw firstErr || new Error('senderKeyDecrypt: no address to try');
  }

  // Try each address in turn and return the first plaintext.
  //
  // A failed attempt leaves nothing behind — libsignal either returns the
  // plaintext or throws, and it only commits the advanced session on success —
  // so trying the second address after the first misses is safe. The error
  // reported on total failure is the first one, which is the one about the
  // address the message actually named.
  async _decryptWithCandidates(candidates, encType, cipherBuf, id) {
    let firstErr = null;

    for (let i = 0; i < candidates.length; i++) {
      try {
        const plaintext = await this._signal.decrypt(candidates[i], encType, cipherBuf);
        if (i > 0) {
          _whaDbg('[DBG] DM_DECRYPT id=' + id + ' recovered under ' + candidates[i] +
            ' after ' + candidates[0] + ' had no session');
        }
        return plaintext;
      } catch (err) {
        if (!firstErr) firstErr = err;
        // Only a missing session is worth asking a different address about.
        // A session that exists and refuses the ciphertext is a different
        // problem, and the answer is a retry receipt, not another lookup.
        if (!/no matching sessions|no session/i.test(String(err && err.message))) break;
      }
    }

    throw firstErr || new Error('decrypt: no address to try');
  }

  _decryptDMMessage({ node, from, participant, fromRaw, partRaw, senderPn, id, ts, dmEncNode }) {
    const encType   = dmEncNode.attrs && dmEncNode.attrs.type;
    const cipherBuf = Buffer.isBuffer(dmEncNode.content)
      ? dmEncNode.content
      : Buffer.from(dmEncNode.content || '');

    // The same contact is reachable under two names — a phone JID and a LID —
    // and a Signal address keeps only the user and the device, never the
    // domain. So 250139683860650:5@lid and 40752248147:5@s.whatsapp.net are
    // two different addresses for one person, and a session filed under either
    // one is invisible from the other.
    //
    // Which name a message arrives under is the server's choice and it varies
    // between messages from the same device. When the session was built under
    // the phone JID and the next message comes addressed by LID, the lookup
    // finds nothing and decryption fails with "No matching sessions found for
    // message" — while the very next message from the same contact decrypts.
    //
    // The stanza's own name is tried first, so nothing that already works
    // changes. The counterpart follows, from the LID↔phone mapping we keep.
    const candidates = this._signalJidCandidates(from, participant, senderPn);
    const sigJid     = candidates[0];

    _whaDbg('[DBG] DM_DECRYPT id=' + id + ' type=' + encType + ' sigJid=' + sigJid +
      (candidates.length > 1 ? ' alts=' + candidates.slice(1).join(',') : '') +
      ' cipherLen=' + cipherBuf.length);

    // Returned, not discarded: _handleMessage runs this behind the message
    // queue, and the queue can only hold the next message back for as long as
    // it can see this one is still running.
    return this._decryptWithCandidates(candidates, encType, cipherBuf, id)
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

          // Keyed off what the message actually carried rather than off the
          // type that announced it. A payload that is present is the payload,
          // whatever the type number turns out to mean.
          if (decoded.historySyncNotification) {
            this._handleHistorySync(decoded.historySyncNotification, id);
          }
          if (decoded.appStateSyncKeyShare) {
            this._handleAppStateSyncKeyShare(decoded.appStateSyncKeyShare);
          }

          return;
        }

        this.emit('message', { id, from, participant, ts, decoded, node });
        this._sendReadReceipt(id, fromRaw, partRaw);

        // ── pkmsg = peer opened a new Signal session (identity/device change) ──
        // Re-issue our tcToken to them so the fresh session carries a valid
        // token.
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

    const senderCandidates = this._senderAddressCandidates(participant);
    _whaDbg('[DBG] GROUP_DECRYPT id=' + id + ' group=' + from + ' sender=' + participant +
      (senderCandidates.length > 1 ? ' alts=' + senderCandidates.slice(1).join(',') : '') +
      ' cipherLen=' + cipherBuf.length);

    // Returned for the same reason as the direct-message path above.
    return this._senderKeyDecryptWithCandidates(from, senderCandidates, cipherBuf, id)
      .then(plaintext => {
        this._resolveRetry(id);
        const decoded = this._decodeMsg(plaintext);
        if (decoded.type === 'senderKeyDistribution') return;
        if (decoded.type === 'protocol') {
          if (decoded.historySyncNotification) {
            this._handleHistorySync(decoded.historySyncNotification, id);
          }
          if (decoded.appStateSyncKeyShare) {
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

      // The sender key rides inside a 1-to-1 message, so opening it needs the
      // session with that participant — and the session may be filed under the
      // other name they answer to. Addressing only the name this stanza used is
      // how joining a group ended with every message failing: the distribution
      // could not be opened, so no sender key was ever stored, so every skmsg
      // after it had nothing to decrypt with.
      const senderCandidates = this._senderAddressCandidates(senderJid);

      tasks.push(
        this._decryptWithCandidates(senderCandidates, encType, cipherBuf, 'skdm')
          .then(async decrypted => {
            const decoded = this._decodeMsg(decrypted);
            // Filed under the name this stanza used, which is the name the
            // group message that follows will look it up under.
            if (decoded && decoded.type === 'senderKeyDistribution' &&
                decoded.groupId && decoded.axolotlBytes) {
              await this._signal.processSKDM(decoded.groupId, senderJid, decoded.axolotlBytes);
              _whaDbg('[DBG] SKDM_DIST_STORED group=' + decoded.groupId + ' sender=' + senderJid);
            } else if (decoded && decoded.skdm &&
                       decoded.skdm.groupId && decoded.skdm.axolotlBytes) {
              await this._signal.processSKDM(decoded.skdm.groupId, senderJid, decoded.skdm.axolotlBytes);
              _whaDbg('[DBG] SKDM_DIST_STORED group=' + decoded.skdm.groupId + ' sender=' + senderJid);
            } else {
              _whaDbg('[DBG] SKDM_DIST_NONE sender=' + senderJid +
                ' — the <to> entry for us carried no distribution');
            }
          })
          // Said out loud rather than swallowed. This failing is the reason the
          // group messages that follow cannot be read, and it used to leave no
          // trace at all — only the downstream failures were visible, which
          // pointed at the wrong thing.
          .catch(err => {
            _whaDbg('[DBG] SKDM_DIST_ERR sender=' + senderJid +
              ' tried=[' + senderCandidates.join(',') + ']' +
              ' err=' + (err && err.message));
            this.emit('skdm_error', { group: groupJid, sender: senderJid, err });
          })
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
    if (depth > this._maxRetryResends) {
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

    _whaDbg('[DBG] RETRY_RECV msgId=' + msgId + ' from=' + fromStr +
      ' — clearing session + resending\n');

    // Everything above this point stays synchronous on purpose. Every device
    // that could not read the message sends its own receipt, and the cache
    // entry taken above is what makes only the first of them resend — put an
    // await in front of it and they all pass the check together.
    //
    // From here on it is one at a time. Tearing a contact's sessions down and
    // building them back up is not something two receipts can be doing at once:
    // the second purge lands in the middle of the first resend and deletes the
    // session it had just created, so the resend goes out under a session the
    // recipient no longer has and draws another retry.
    return this._queueIncoming(this._receiptMutex, 'RETRY', async () => {
      this._purgeContactSessions(recipientPhone, 'RETRY');

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
        // Awaited inside the queue, so the next receipt's purge cannot land
        // while this resend is still choosing and building sessions.
        await this._sender._sendGroupMessage(
          cached.toJid, resendId, cached.plaintext, cached.mediaType, opts
        )
          .then(r  => _whaDbg('[DBG] RETRY_RESEND group ok id=' + (r && r.id) + '\n'))
          .catch(e => _whaDbg('[DBG] RETRY_RESEND_ERR: ' + e.message));
        return;
      }

      await this._sender._sendDMMessage(
        cached.toJid, cached.msgId, cached.plaintext, cached.mediaType, opts
      )
        .then(r  => _whaDbg('[DBG] RETRY_RESEND ok id=' + r.id + '\n'))
        .catch(e => _whaDbg('[DBG] RETRY_RESEND_ERR: ' + e.message));
    });
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
  // With them off, "read" is downgraded to "read-self", which marks the message
  // read across our own devices without reporting it to the other side. Nothing
  // here looked at the setting, so a user who had turned read receipts off
  // still sent blue ticks.
  _readReceiptType(base) {
    const settings = this._privacySettings;
    if (settings && settings.readReceipts === 'none' && base === 'read') {
      return 'read-self';
    }
    return base;
  }

  // The key a privacy token is stored and looked up under.
  //
  // It resolves to the contact's LID, falling back to the plain JID only when
  // no LID is known:
  //
  //     if (isLidUser(jid)) return jid
  //     const lid = await getLIDForPN(jid)
  //     return lid ?? jid
  //
  // whalibmob resolved it on the receiving side but not on the sending side,
  // which put the two halves out of step: a token a contact issued us arrived
  // on a privacy_token notification and was filed under their LID, while every
  // send looked it up under their phone JID and found nothing. The token was
  // therefore never attached to anything, and the server kept counting our
  // messages as anonymous reach-outs — which is what error 463 is.
  _resolveTcTokenJid(jid) {
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
    const norm = normalizeJidForTcToken(jid);
    if (norm.endsWith('@lid')) return norm;

    const pnUser = norm.split('@')[0];
    let lidUser = this._pnToLid && this._pnToLid.get(pnUser);

    // The in-memory map starts empty and is filled by usync and by incoming
    // messages, so a send early in a process — or one that hits a warm device
    // cache and never runs usync — could find nothing and fall back to the
    // phone JID. The mapping is on disk in the Signal store either way, so
    // consult that before giving up. The consequence of not doing so is not
    // cosmetic: the lookup lands on
    // a key with no token while a live one sits under the LID, and the message
    // goes out without one.
    if (!lidUser) {
      const store = this._signal && this._signal.store;
      const persisted = store && typeof store.getLidMappings === 'function'
        ? store.getLidMappings() : null;
      const fromDisk = persisted && persisted[pnUser];
      if (fromDisk) {
        lidUser = String(fromDisk);
        if (this._pnToLid) this._pnToLid.set(pnUser, lidUser);
        if (this._lidToPn) this._lidToPn.set(lidUser, pnUser);
        _whaDbg('[DBG] TCTOKEN_LID_FROM_DISK pn=' + pnUser + ' lid=' + lidUser);
      }
    }

    if (!lidUser) return norm;

    const lidJid = lidUser + '@lid';

    // Anything already filed under the phone JID belongs with the LID entry.
    // Left split, the two halves each hold part of the state and neither is
    // complete. Cheap when there is nothing to move, which is the usual case.
    if (this._tcTokenStore && this._tcTokenStore.mergeEntry(norm, lidJid)) {
      _whaDbg('[DBG] TCTOKEN_MERGED ' + norm + ' → ' + lidJid);
    }

    return lidJid;
  }

  // The JID a token is *issued* to, which is not the JID it is *stored* under.
  //
  // Storage is always the LID. Issuance follows AB prop 14303
  // (lid_trusted_token_issue_to_lid), whose WA Web default is off — so the IQ
  // names the phone JID. We follow WA Web, and more importantly we now follow
  // it in one place: the
  // send path, the 463 recovery and the post-identity-change re-issue used to
  // each pick a different address family for the same contact.
  _resolveTcTokenIssuanceJid(jid) {
    const { normalizeJidForTcToken } = require('./messages/TcTokenStore');
    const norm = normalizeJidForTcToken(jid);
    if (!norm.endsWith('@lid')) return norm;
    const pnUser = this._lidToPn && this._lidToPn.get(norm.split('@')[0]);
    return pnUser ? pnUser + '@s.whatsapp.net' : norm;
  }

  // The one way to read a token that is safe to put on the wire.
  //
  // Every attach site goes through here, and an expired token returns nothing.
  // The expiry check used to be on the message path only; presence subscribe,
  // group create, participant add and the
  // profile-picture query each tested `token.length` and nothing else, so once
  // a token aged past the 28-day window those four kept sending it. Same rule
  // everywhere now, and the dead token gets cleared on the way out.
  _tcTokenFor(jid) {
    if (!this._tcTokenStore) return null;
    const { tcTokenExpired } = require('./messages/TcTokenStore');
    const tcJid = this._resolveTcTokenJid(jid);
    const entry = this._tcTokenStore.get(tcJid);
    if (!entry || !entry.token || !entry.token.length) return null;
    if (tcTokenExpired(entry.timestamp)) {
      this._tcTokenStore.clearToken(tcJid);
      _whaDbg('[DBG] TCTOKEN_EXPIRED jid=' + tcJid + ' — cleared');
      return null;
    }
    return entry.token;
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
  // the receipt tells the sender it reached a device. Both go out for every
  // incoming message, with the blue ticks left to markRead. Only the ack used
  // to be sent, jumping straight to type="read", so a sender never saw the grey
  // stage.
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
  // it off makes read receipts always explicit.
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

  // Drop every Signal session and cached device list a contact owns, so the
  // next send to them has to fetch a prekey bundle and open a fresh session.
  //
  // A contact holds a session under each address family: a Signal address is
  // (user, device) with the server stripped, and the LID user and the phone
  // user are different strings, so one session is not reachable under the
  // other's name. Clearing only the family whose name happened to be at hand
  // leaves the other in place, and the next send picks it straight back up —
  // which is how a message stayed undecryptable on a device that had already
  // said it could not read it.
  //
  // Device lists are filed the same way, LID ones under a "lid:" key, so both
  // spellings of both users have to go.
  //
  // Returns the set of users it resolved, for callers that want to log it.
  _purgeContactSessions(user, tag) {
    const label = tag || 'PURGE';
    const users = new Set([String(user)]);
    const mappedPn  = this._lidToPn && this._lidToPn.get(user);
    const mappedLid = this._pnToLid && this._pnToLid.get(user);
    if (mappedPn)  users.add(mappedPn);
    if (mappedLid) users.add(mappedLid);

    const sigStore = this._signal && this._signal.store;
    if (sigStore && sigStore._sessions) {
      const sessions = sigStore._sessions;
      for (const addr of Object.keys(sessions)) {
        // Match on the address's user segment rather than a bare string
        // prefix: a purge for "407" must not take "4071.0" with it.
        const addrUser = addr.slice(0, addr.lastIndexOf('.'));
        if (users.has(addrUser)) {
          _whaDbg('[DBG] ' + label + ' deleting session for ' + addr);
          // Through the store rather than off the object it hands back: a bare
          // `delete` leaves the file alone and the store unmarked, so nothing
          // is written on the way out and a restart loads every purged session
          // straight back — the one case the purge exists to prevent. Not
          // awaited on purpose; the method's body is synchronous, so the
          // delete and the save have both happened by the time it returns.
          sigStore.deleteSession(addr);
        }
      }
    }

    if (this._devMgr) {
      const cacheKeys = [];
      for (const u of users) cacheKeys.push(u, 'lid:' + u);
      this._devMgr.clearCache(cacheKeys);
    }

    _whaDbg('[DBG] ' + label + ' purged users=[' + [...users].join(',') + ']');
    return users;
  }

  // Hold a sent message's plaintext so a retry receipt naming it can be
  // answered. Both send paths file their entry here so the bound lives in one
  // place instead of being repeated as a literal at each call site.
  _cacheSentMessage(entry) {
    if (!this._sentMsgCache || !entry || !entry.msgId) return;
    this._sentMsgCache.set(entry.msgId, entry);
    // Map preserves insertion order, so the first key is the oldest entry.
    while (this._sentMsgCache.size > this._sentCacheSize) {
      this._sentMsgCache.delete(this._sentMsgCache.keys().next().value);
    }
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
  // The action on the node describes the whole change; each child names one JID
  // and what happened to it.
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
      // ...and privacy setting changes, which arrive the same way. The settings
      // are re-read on this and an event raised; nothing was watching the node,
      // so a change made on the phone never reached the cache.
      const privacyNode = findChildDeep(node, 'privacy');
      if (privacyNode) this._handlePrivacySettingsNotification(privacyNode);
    }

    if (type === 'w:gp2') {
      // Group update: member add/remove
      this._processGroupUpdate(node);
    }

    if (type === 'mex') {
      this._handleMexNotification(node);
    }

    if (type === 'privacy_token') {
      // Incoming trusted-contact token from a conversation partner — store it
      // so we can attach it on next DM send (prevents error 463).
      this._handlePrivacyTokenNotification(node);
    }

    if (type === 'link_code_companion_reg') {
      // The account owner just typed our pairing code into their phone.
      this._handleCompanionFinish(node);
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
      // BinaryNode decodes an AD-encoded JID into an object, not a string, so
      // this has to be stringified before it can be split. It was not, and a
      // <notification type="devices"> from a LID-addressed contact threw
      // "fromJid.split is not a function" out of the node handler — taking the
      // whole dispatch down with it, so every notification behind it in the
      // offline queue was dropped too.
      const fromJid   = String(attrs.from || '');
      const fromUser  = fromJid.split('@')[0].split(':')[0];
      // The user segment of a LID is not a phone number, and usync only takes
      // phone numbers — asking it about a LID comes back "invalid" and the
      // device list is never actually refreshed. Translate first when we know
      // the mapping, and when we do not, invalidate the cache and stop there
      // rather than spending an IQ on a question that cannot be answered.
      const isLid     = fromJid.endsWith('@lid');
      const mappedPn  = isLid && this._lidToPn ? this._lidToPn.get(fromUser) : null;
      const fromPhone = isLid ? mappedPn : fromUser;
      if (fromUser && this._devMgr) {
        this._devMgr._dcDel(isLid ? [fromUser, 'lid:' + fromUser] : [fromUser]);
        if (mappedPn) this._devMgr._dcDel([mappedPn]);
        _whaDbg('[DBG] NOTIF_DEVICES invalidated cache for ' + fromUser +
          (isLid ? (mappedPn ? ' (lid → ' + mappedPn + ')' : ' (lid, no phone known)') : ''));
        // Also process any inline <devices> list the server included
        const devicesNode = findChildDeep(node, 'devices');
        if (devicesNode) this._processDeviceUpdate(devicesNode);
        // Background re-usync so the cache is warm before the next send. Only
        // when there is a phone number to ask about — the cache is already
        // cleared, so a LID with no known number simply gets looked up the next
        // time something sends to it.
        if (this._signal && fromPhone) {
          // Queued rather than fired loose. A contact that changes devices
          // several times in a row — leaving and rejoining a group does it —
          // sends one of these per change, and two overlapping warm-ups race
          // each other's session building for the same contact.
          this._queueIncoming(this._notificationMutex, 'NOTIF', async () => {
            if (!this._connected || !this._devMgr) return;
            await this._devMgr.bulkEnsureSessions([fromPhone], this._signal, false)
              .then(() => _whaDbg('[DBG] NOTIF_DEVICES bg-usync done for ' + fromPhone))
              .catch(e  => _whaDbg('[DBG] NOTIF_DEVICES bg-usync err: ' + e.message));
          });
        }
      }
    }

    if (type === 'identity') {
      // Server push: a contact re-registered WhatsApp (new identity key / new
      // phone). Every session we hold with them is anchored in an identity key
      // that no longer exists, so all of them have to go — under both the
      // number and the LID, or the next send reaches for the survivor and the
      // contact receives ciphertext nothing on their side can open. A retry
      // receipt cannot rescue that: the session is not stale, it is dead.
      const fromJid   = String(attrs.from || '');
      const fromPhone = fromJid.split('@')[0].split(':')[0];
      if (fromPhone) this._purgeContactSessions(fromPhone, 'NOTIF_IDENTITY');
      this.emit('identity_change', { jid: fromJid, user: fromPhone });
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

  // <failure> ends the connection, but not every reason means the session died.
  //
  // 401, 403 and 419 are the ones that do: the account logged us out, or the
  // owner removed the device. Those are unrecoverable and reconnecting only
  // burns attempts.
  //
  // 405 is different, and reading it as "session revoked" sent people looking
  // in the wrong place. It means the server declined the client itself — on the
  // web endpoint, almost always because the announced version is one it does
  // not recognise. Nothing about the session is wrong; retrying with the same
  // version will fail identically, so say what it is instead.
  _handleFailure(node) {
    const attrs  = (node && node.attrs) || {};
    const reason = String(attrs.reason || attrs.location || 'unknown');
    const loc    = attrs.location ? String(attrs.location) : null;

    if (reason === '405') {
      const detail = this._mode === 'web'
        ? 'WhatsApp refused this client (405). The web version we announced (' +
          ((this._store && this._store.webVersion) || []).join('.') +
          ') is not one the server accepts — it changes on their schedule. ' +
          'Reconnect to pick up the current one, or pass { version: [2, 3000, N] } ' +
          'to connectWeb().'
        : 'WhatsApp refused this client (405) — the announced app version is ' +
          'not accepted. Update the version in the session store.';
      _whaDbg('[DBG] FAILURE 405 location=' + loc + ' — client refused, not a dead session');
      this._fatal = true;
      this._reconnecting = false;
      this.emit('client_rejected', { reason, location: loc, message: detail, node });
      this.emit('error', new Error(detail));
      this.disconnect();
      return;
    }

    // Not every failure kills the session. These five do — 401, 403, 405, 406,
    // 409 — and the rest are worth another attempt. A 500 or a 503 is the
    // server having a bad minute; giving
    // up on the session for that would be throwing away a working registration.
    const LOGGED_OUT = ['401', '403', '405', '406', '409'];
    const spent = LOGGED_OUT.includes(reason);

    _whaDbg('[DBG] FAILURE reason=' + reason + ' location=' + loc +
      ' loggedOut=' + spent);
    this.emit('auth_failure', { reason, location: loc, loggedOut: spent, node });
    this._fatal = spent;
    this._reconnecting = false;
    // A reason that did not kill the session is one to come back from, so this
    // teardown leaves the reconnect loop armed — a 503 is the server having a
    // bad minute, not a reason to abandon a working registration. A reason that
    // did kill it is fatal, and _scheduleReconnect() stands down on that itself.
    this.disconnect({ reconnect: !spent });
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

  // How many one-time keys the server is still holding for us.
  //
  // This is the number that matters and the one we could not see. The local
  // store only loses a key when a pkmsg using it is actually decrypted, while
  // the server hands one out to everybody who asks for a bundle — including the
  // ones who then never write. So the two drift apart, and the local count can
  // sit at its full 800 while the server has none left. With none left nobody
  // can open a session with this account at all: the messages are not delayed,
  // they are never sent, which is why nothing arrives and nothing is queued.
  //
  // The two client families ask differently, so each is asked its own way. A
  // companion asks for a count and is told a number. A primary asks for the
  // digest and is given the ids it holds, which is the same answer with the
  // arithmetic left to us.
  async _queryServerPreKeyCount() {
    if (!this._socket || !this._connected) return null;

    const web  = this._mode === 'web';
    const resp = await this._sendIq(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'get',
      xmlns: 'encrypt'
    }, [new BinaryNode(web ? 'count' : 'digest', {}, null)]));

    if (!resp) return null;                                   // timed out
    if (resp.attrs && resp.attrs.type === 'error') return null;

    if (web) {
      const countNode = findChild(resp, 'count');
      const value     = countNode && countNode.attrs && countNode.attrs.value;
      const n         = value === undefined ? NaN : Number(value);
      return Number.isFinite(n) ? n : null;
    }

    // <digest><list><...one child per key we still have there...></list></digest>
    const digest = findChild(resp, 'digest');
    const list   = digest && findChild(digest, 'list');
    if (!list) return null;
    return Array.isArray(list.content) ? list.content.length : 0;
  }

  // What the server believes this account's key bundle is.
  //
  // The digest is the only way to see it. Everything else here is a guess about
  // what was uploaded once and assumed to have stuck — and when the server's
  // idea of the bundle and ours part company, nobody can open a session with
  // this account and there is no error anywhere to say so. It is the state that
  // registering the number again clears, which is why registering again is what
  // has been fixing it.
  async _queryKeyDigest() {
    if (!this._socket || !this._connected) return null;

    const resp = await this._sendIq(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'get',
      xmlns: 'encrypt'
    }, [new BinaryNode('digest', {}, null)]));

    if (!resp) return null;
    if (resp.attrs && resp.attrs.type === 'error') return null;

    const digest = findChild(resp, 'digest');
    if (!digest) return { missing: true };

    const bytesOf = (parent, tag) => {
      const n = parent && findChild(parent, tag);
      if (!n) return null;
      if (Buffer.isBuffer(n.content)) return n.content;
      return n.content ? Buffer.from(n.content) : null;
    };

    const skey = findChild(digest, 'skey');
    const list = findChild(digest, 'list');
    return {
      missing:    false,
      identity:   bytesOf(digest, 'identity'),
      skeyId:     bytesOf(skey, 'id'),
      skeyValue:  bytesOf(skey, 'value'),
      preKeyCount: list && Array.isArray(list.content) ? list.content.length : 0
    };
  }

  // Compare that bundle against the one we hold, and re-upload when they differ.
  //
  // Only values the server states outright are compared — the identity key and
  // the signed pre-key it is serving — so nothing here depends on guessing how
  // it hashes them. A mismatch means the bundle other people are handed is not
  // the one this session can answer for, and no amount of waiting fixes that.
  //
  // Shares _preKeyMutex with _ensureServerPreKeys: both end in the same
  // replenish-and-upload, so protecting only one of them would leave the same
  // double upload reachable through the other.
  async _verifyServerKeyBundle(reason) {
    if (!this._signal) return;
    return this._preKeyMutex.runExclusive(() => this._verifyServerKeyBundleLocked(reason));
  }

  async _verifyServerKeyBundleLocked(reason) {
    // Re-checked inside the lock: the session can be released while a caller
    // is still waiting its turn.
    if (!this._signal) return;
    try {
      const digest = await this._queryKeyDigest();
      if (!digest) return;                       // no answer; nothing to conclude

      if (digest.missing) {
        _whaDbg('[DBG] KEYBUNDLE server returned no digest (' + reason + ') — re-uploading');
        this._replenishLocalPreKeys();
        this._uploadPreKeys();
        return;
      }

      const bare      = (b) => (b && b.length === 33 && b[0] === 0x05) ? b.slice(1) : b;
      const ourIdent  = bare(this._signal.getIdentityKey());
      const ourSpk    = this._signal.getSignedPreKeyForUpload();
      const ourSpkPub = ourSpk && bare(ourSpk.keyPair.pubKey);

      const mismatches = [];
      if (digest.identity && ourIdent &&
          Buffer.compare(digest.identity, ourIdent) !== 0) {
        mismatches.push('identity key');
      }
      if (digest.skeyValue && ourSpkPub &&
          Buffer.compare(digest.skeyValue, ourSpkPub) !== 0) {
        mismatches.push('signed pre-key');
      }
      if (digest.skeyId && ourSpk) {
        let served = 0;
        for (const b of digest.skeyId) served = (served << 8) | b;
        if (served !== ourSpk.keyId) mismatches.push('signed pre-key id (' + served +
          ' vs ' + ourSpk.keyId + ')');
      }

      if (!mismatches.length) {
        _whaDbg('[DBG] KEYBUNDLE matches the server (' + reason + '), ' +
          digest.preKeyCount + ' one-time key(s) there');
        return;
      }

      _whaDbg('[DBG] KEYBUNDLE server disagrees on ' + mismatches.join(' and ') +
        ' (' + reason + ') — re-uploading');
      this._replenishLocalPreKeys();
      this._uploadPreKeys();
    } catch (err) {
      _whaDbg('[DBG] KEYBUNDLE check failed (' + reason + '): ' + (err && err.message));
    }
  }

  // Top the server back up when it is running out. Never throws: a session that
  // cannot ask is left exactly as it was rather than losing its connection over
  // a bookkeeping query.
  //
  // Runs one at a time — see _preKeyMutex in the constructor.
  async _ensureServerPreKeys(reason) {
    if (!this._signal) return;
    return this._preKeyMutex.runExclusive(() => this._ensureServerPreKeysLocked(reason));
  }

  async _ensureServerPreKeysLocked(reason) {
    if (!this._signal) return;
    try {
      const serverCount = await this._queryServerPreKeyCount();
      if (serverCount === null) {
        // No usable answer. Fall back to the old behaviour — an upload we may
        // not have needed costs nothing next to an account nobody can reach.
        _whaDbg('[DBG] PREKEY server count unavailable (' + reason + ') — uploading anyway');
        this._replenishLocalPreKeys();
        this._uploadPreKeys();
        return;
      }

      _whaDbg('[DBG] PREKEY server holds ' + serverCount + ' (' + reason + ')');
      if (serverCount > PRE_KEY_SERVER_MIN) return;

      _whaDbg('[DBG] PREKEY server low (' + serverCount + ' <= ' + PRE_KEY_SERVER_MIN +
        ') — uploading');
      this._replenishLocalPreKeys();
      this._uploadPreKeys();
    } catch (err) {
      _whaDbg('[DBG] PREKEY check failed (' + reason + '): ' + (err && err.message));
    }
  }

  // Make sure there is something to upload before uploading.
  _replenishLocalPreKeys() {
    if (!this._signal) return;
    if (this._signal.preKeyCount() < 20) this._signal.replenishPreKeys();
  }

  _checkAndReplenishPreKeys() {
    if (!this._signal) return;
    // The server said it is running low, so ask it how low and act on that
    // rather than on the local count, which does not move when the server
    // hands a key out.
    this._ensureServerPreKeys('server asked');
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
        return {
          jid:  pJid,
          role: pRole,
          // Both address families, whichever way round the server named them,
          // so a caller does not have to reach into the LID maps to find out
          // who a participant is.
          phoneNumber:  pJid.endsWith('@lid') ? pPhone : pJid,
          lid:          pJid.endsWith('@lid') ? pJid   : pLid,
          displayName:  n.attrs.display_name ? String(n.attrs.display_name) : null,
          username:     n.attrs.participant_username ? String(n.attrs.participant_username)
                      : n.attrs.username ? String(n.attrs.username) : null,
          isAdmin:      pRole === 'admin' || pRole === 'superadmin',
          isSuperAdmin: pRole === 'superadmin'
        };
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

    const descriptionBy = (descNode && descNode.attrs && descNode.attrs.participant)
      ? toNonAdJid(String(descNode.attrs.participant)) : null;
    const descriptionByPn = (descNode && descNode.attrs && descNode.attrs.participant_pn)
      ? toNonAdJid(String(descNode.attrs.participant_pn)) : null;
    const descriptionTime = (descNode && descNode.attrs)
      ? parseInt(descNode.attrs.t, 10) || 0 : 0;

    // ephemeral
    const ephNode = children.find(n => n && n.description === 'ephemeral');
    const ephemeral = ephNode && ephNode.attrs ? parseInt(ephNode.attrs.expiration, 10) || 0 : 0;

    // settings flags — WA protocol uses 'announcement' and 'locked' node names
    const announce = children.some(n => n && n.description === 'announcement');
    const restrict = children.some(n => n && n.description === 'locked');

    // The rest of the flags the server reports. These used to be dropped, which
    // meant a group's join-approval and member-add settings could be written but
    // never read back — changing one and then asking for the metadata reported
    // nothing at all about it.
    const joinApprovalMode = children.some(n => n && n.description === 'membership_approval_mode');
    const parentNode       = children.find(n => n && n.description === 'parent');
    const linkedParentNode = children.find(n => n && n.description === 'linked_parent');
    const memberAddNode    = children.find(n => n && n.description === 'member_add_mode');
    const memberAddBuf     = memberAddNode ? getNodeContent(memberAddNode) : null;
    const memberAddMode    = memberAddBuf ? memberAddBuf.toString('utf8') : null;
    // An incognito group hides members' phone numbers from each other, and a
    // suspended one has been taken down — both are things a caller has to be
    // able to see rather than discover by having every send refused.
    const isIncognito      = children.some(n => n && n.description === 'incognito');
    const isSuspended      = children.some(n => n && n.description === 'suspended');

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
      descriptionBy,
      descriptionByPn,
      descriptionTime,
      ephemeral,
      onlyAdminsSend: announce,
      onlyAdminsEdit: restrict,
      // Whether new members have to be waved through by an admin.
      joinApprovalMode,
      // 'admin_add' | 'all_member_add' | null when the server did not say.
      memberAddMode,
      // A community's own node, and the community a plain group belongs to.
      isCommunity: !!parentNode,
      // How a community waves its incoming sub-group members through by default.
      defaultMembershipApprovalMode:
        (parentNode && parentNode.attrs && parentNode.attrs.default_membership_approval_mode)
          ? String(parentNode.attrs.default_membership_approval_mode) : null,
      isCommunityAnnounce: children.some(n => n && n.description === 'default_sub_group'),
      linkedParent: (linkedParentNode && linkedParentNode.attrs && linkedParentNode.attrs.jid)
        ? String(linkedParentNode.attrs.jid) : null,
      isIncognito,
      isSuspended,
      // The phone-number and username forms of the two people named in the
      // header, when the server sends them alongside the addresses it used.
      creatorPn:        a.creator_pn ? toNonAdJid(String(a.creator_pn)) : null,
      creatorUsername:  a.creator_username || null,
      creatorCountry:   a.creator_country_code || null,
      subjectByPn:      a.s_o_pn ? toNonAdJid(String(a.s_o_pn)) : null,
      subjectByUsername: a.s_o_username || null,
      notify:           a.notify || null,
      // Version stamps the server bumps whenever the participant list or the
      // announce flag changes; a cache can compare them instead of re-reading.
      participantVersion: a.p_v_id || null,
      announceVersion:    a.a_v_id || null,
      // The server's own count, which can exceed the participant list it sent.
      size: a.size ? parseInt(a.size, 10) || participants.length : participants.length,
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
    const { isRegularTcTokenUser } = require('./messages/TcTokenStore');

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
          // In a notification, tokenNode.attrs.jid is our own device JID rather
          // than the sender's, so fallbackJid wins whenever it is present.
          const jid = fallbackJid || String(a.jid);
          const t   = a.t   ? parseInt(String(a.t), 10) : issueTs;
          // Anything that is not a regular user is dropped here, guarding
          // against a malformed or spoofed notification filing a token under
          // the PSA account or a bot.
          if (!isRegularTcTokenUser(jid)) {
            _whaDbg('[DBG] STORE_TCTOKEN skipped non-user jid=' + jid);
            continue;
          }
          if (bytes && bytes.length) {
            // setToken refuses a timestamp-less or older-than-stored token.
            if (this._tcTokenStore.setToken(jid, bytes, t)) {
              tokenStoredCount++;
              _whaDbg('[DBG] TCTOKEN_STORED jid=' + jid + ' t=' + t + ' len=' + bytes.length);
            } else {
              _whaDbg('[DBG] STORE_TCTOKEN rejected (no/older timestamp) jid=' + jid + ' t=' + t);
            }
          } else {
            _whaDbg('[DBG] STORE_TCTOKEN token node has no bytes jid=' + jid);
          }
        }
      } catch (e) {
        _whaDbg('[DBG] STORE_TCTOKEN parse error: ' + e.message);
      }
    }

    // ── CRITICAL: senderTimestamp is ALWAYS persisted after issuing,     ─────
    // ── regardless of whether the server returned token bytes.           ─────
    // ── Without this, shouldSendNewTcToken() returns true every send and ─────
    // ── we flood the server with privacy IQs.                            ─────
    // ── For incoming privacy_token notifications saveSenderTs=false so  ─────
    // ── we don't overwrite our own send-dedupe timestamp with the peer's ─────
    // Same user gate as the token itself — no dedupe row for the PSA account
    // or a bot, since we never issue to them in the first place.
    if (saveSenderTs && issueTs != null && isRegularTcTokenUser(fallbackJid)) {
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
   * Wire format:
   *   <notification type='privacy_token' from='...' [sender_lid='...@lid']>
   *     <tokens>
   *       <token type='trusted_contact' jid='...' t='...'>…bytes…</token>
   *     </tokens>
   *   </notification>
   *
   * Key rules:
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

    // ── 1. Require the <tokens> wrapper ────────────────────────────────────────
    const content    = Array.isArray(node.content) ? node.content : [];
    const tokensNode = content.find(n => n && n.description === 'tokens');
    if (!tokensNode) {
      _whaDbg('[DBG] PRIVACY_TOKEN_NOTIF no <tokens> wrapper — abort\n');
      return;
    }

    // ── 2. Resolve storage JID ─────────────────────────────────────────────────
    // Priority:
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
    } else {
      // Same resolver the send side uses, so both halves agree on the key.
      storageJid = this._resolveTcTokenJid(rawFrom);
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
   * present and not expired).
   *
   * @param {string} from  - Signal-session JID (PN or LID JID of the sender)
   */
  _reissueTcTokenAfterIdentityChange(from) {
    if (!this._tcTokenStore || !from) return;
    const { normalizeJidForTcToken, tcTokenExpired } = require('./messages/TcTokenStore');

    void (async () => {
      try {
        const tcJid = this._resolveTcTokenJid(from);

        const entry    = this._tcTokenStore.get(tcJid);
        const senderTs = entry && entry.senderTimestamp;
        if (!senderTs || tcTokenExpired(senderTs)) {
          // No previous issuance — nothing to re-issue
          return;
        }

        _whaDbg('[DBG] REISSUE_TC_TOKEN_AFTER_IDENTITY_CHANGE jid=' + tcJid +
          ' prevSenderTs=' + senderTs);

        // The re-issue carries the *previous* senderTimestamp, not a fresh one,
        // and the result is stored without touching the dedupe state. That
        // matters: this is a repair of an existing grant after the peer's
        // device changed, not a new grant, so it must not move the 7-day
        // bucket that governs regular issuance. We were stamping it with
        // Date.now(), which silently skipped the next scheduled issuance.
        const issueJid = this._resolveTcTokenIssuanceJid(from);
        const result   = await this._issuePrivacyTokens(issueJid, senderTs);
        this._storeTcTokenFromIqResult(result, tcJid, senderTs, { saveSenderTs: false });
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
    // Web-mode history lands in its own files. A number can be registered over
    // SMS and separately linked as a companion, and only the companion ever
    // receives history — merging the two would be merging different accounts'
    // views of the same number.
    const phone = (this._store && this._store.phoneNumber) +
                  (this._mode === 'web' ? '.web' : '');
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
   *    For PN chats we try to look up the LID first, since storage is by LID.
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

      // Resolve storage JID — storage is always by LID.
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

    // The key is what app state was waiting on. Anything the server has been
    // holding for us can be read now, so go and get it rather than sitting on
    // it until the next dirty bit happens along.
    if (this._connected && this._appState) {
      this.syncAppState().catch(err => {
        _whaDbg('[DBG] APP_STATE sync after key share failed: ' + (err && err.message));
      });
    }
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
  // The FIRST id goes on the receipt and the rest as <item> children of a
  // <list> node. The last id used to be used instead, with the items straight
  // inside <receipt>, which is not a shape the server
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
  // This is refused without a push name: the server takes the display name from
  // this node, and sending it empty makes
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
  // Both `from` (our own JID) and `to` go on the chatstate node, and recording
  // is expressed as composing with media="audio" — there is no separate
  // recording state in the protocol. The `from` was missing
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
  // The contact's privacy token is attached when there is one; without it the
  // server may decline to send their presence. The server also only forwards
  // presence to clients that have marked themselves available, so call
  // setOnline(true) first.
  subscribeToPresence(jids) {
    if (!this._socket || !this._connected) return;
    const arr = Array.isArray(jids) ? jids : [jids];
    const { isRegularTcTokenUser } = require('./messages/TcTokenStore');
    for (const raw of arr) {
      const jid   = makeJid(raw);
      // Groups and newsletters have no privacy token.
      const token = isRegularTcTokenUser(jid) ? this._tcTokenFor(jid) : null;
      const children = token ? [new BinaryNode('tctoken', {}, token)] : null;
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

  // Full profile picture info: { id, url, type, directPath, hash }, or null
  // when the user has no
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
      const picToken    = this._tcTokenFor(jidFull);
      const picChildren = picToken ? [new BinaryNode('tctoken', {}, picToken)] : null;
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
    return httpGetBuffer(info.url, { web: this._mode === 'web' });
  }

  // Download and decrypt the media on a received message.
  //
  // Pass the decoded message straight through — `msg.decoded` from a `message`
  // event, or the object itself:
  //
  //   client.on('message', async (msg) => {
  //     if (msg.decoded && msg.decoded.mediaKey) {
  //       fs.writeFileSync('out.jpg', await client.downloadMedia(msg.decoded))
  //     }
  //   })
  //
  // The CDN applies the same browser check on the way down as on the way up, so
  // a companion has to identify itself as one here too. Doing it by hand means
  // knowing that, and knowing which key name each media type derives from — get
  // either wrong and the download is refused or the decryption produces garbage.
  //
  // A file already saved from a previous run can be verified against the
  // message with { verify: true }, which checks fileEncSha256 before decrypting.
  async downloadMedia(decoded, opts) {
    opts = opts || {};
    const d = (decoded && decoded.decoded) ? decoded.decoded : decoded;
    if (!d || !d.type) throw new Error('downloadMedia: a decoded message is required');
    if (!d.mediaKey)   throw new Error('downloadMedia: this message carries no media');


    // A voice note is an audio message with PTT set, and a GIF a video with the
    // playback flag — both derive from the plain type's keys.
    const KEY_NAME = {
      image: 'image', video: 'video', audio: 'audio', voice: 'ptt',
      ptt: 'ptt', document: 'document', sticker: 'sticker', gif: 'gif'
    };
    const { downloadMedia, getMediaKeyName, resolveMediaUrl } = require('./MediaService');
    const url = resolveMediaUrl(d.url, d.directPath);
    if (!url) throw new Error('downloadMedia: the message has no CDN location');
    const keyName = getMediaKeyName(KEY_NAME[d.type] || d.type);
    if (!keyName) throw new Error('downloadMedia: unsupported media type "' + d.type + '"');

    return downloadMedia(url, d.mediaKey, keyName, {
      web:           this._mode === 'web',
      fileEncSha256: opts.verify ? d.fileEncSha256 : undefined
    });
  }

  // Parse the <list> a blocklist query or update comes back with.
  //
  // Every child is walked and its jid taken, whatever the tag is called, with
  // the dhash kept off the list itself.
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
  // The push name lives in two places, and only one of them survives.
  //
  // The presence node announces it to whoever is looking right now — it is how
  // a contact who has not saved the number sees a name at all. But it says
  // nothing lasting: the server treats it as the state of this connection, so a
  // name sent only that way is gone by the next login, and the account keeps
  // whatever the profile actually holds.
  //
  // What persists is an app state write, filed under 'setting_pushName' in the
  // critical_block collection. That is the record the phone and every other
  // linked device read, and the one the profile is served from.
  //
  // Both are sent: the presence so the change shows immediately, the patch so
  // it is still there tomorrow.
  //
  // Returns a promise for the patch that resolves true when it was written and
  // false when app state was not writable (no sync key shared yet) or the
  // server refused it. It never rejects, so a caller that ignores the return —
  // as every caller did when this only sent presence — cannot end up with an
  // unhandled rejection. The connection check still throws synchronously.
  changeName(name) {
    if (!this._socket || !this._connected) throw new Error('Not connected');
    // A presence node carrying only a name is a name republish: it says what
    // this account is called without also describing whether it is online.
    // Carrying a type turns it into an availability update that happens to
    // mention a name, which is a different thing to ask for and is not what a
    // rename is. The bare form goes first, on its own.
    this._socket.sendNode(new BinaryNode('presence', { name }, null));

    // And the same name again on an availability node, unconditionally. The
    // bare form above is what a browser client sends, but the implementation
    // with the longest production record only ever sends this one, and ties the
    // server learning your name to it: announce it at least once after
    // connecting or other people see a placeholder instead. Making it
    // conditional on already being marked available would leave a session that
    // renames before going online with only the form that may be ignored.
    this._socket.sendNode(new BinaryNode('presence', {
      name,
      type: 'available'
    }, null));

    // `name` is the field the handshake reads when it announces this account,
    // and it is the one the session file carries. Writing only `pushName` left
    // the store's `name` at its default, so every login announced that default
    // again and undid the change — the account went on being called "User" no
    // matter how often the presence went out. Both are set: `name` because the
    // handshake and the file are keyed off it, `pushName` because the presence
    // helper reads that one first.
    if (this._store) {
      this._store.name     = name;
      this._store.pushName = name;
      this._persistStore();
    }

    return this._appStatePatchOrFallback(AppMutations.pushNamePatch(name))
      .then(synced => {
        _whaDbg(synced
          ? '[DBG] PUSHNAME persisted in app state: ' + name
          : '[DBG] PUSHNAME announced but NOT persisted — no app state sync key yet');
        return synced;
      })
      .catch(err => {
        _whaDbg('[DBG] PUSHNAME app state write failed: ' + (err && err.message));
        return false;
      });
  }

  // Change bio/about text
  //
  // The <status> child is byte-for-byte what Baileys and whatsmeow send. The
  // envelope was not: both of them address this IQ to the server as a *JID*
  // with nobody in the user part — Baileys writes '@s.whatsapp.net', whatsmeow
  // uses types.ServerJID — which goes out as JID_PAIR + empty user + the server
  // token. This wrote the bare string 's.whatsapp.net', and a bare string is
  // encoded as a plain dictionary token, so where every other client puts an
  // address the server was reading text. That is the whole of the difference,
  // and it is invisible in a stanza log, which prints the node before it is
  // encoded: both spellings read `to="s.whatsapp.net"` on screen.
  //
  // The reply was thrown away as well. _sendIq answers null on a timeout and
  // hands back error stanzas unread, so a refusal, a silence and a success all
  // returned the same thing — which is how "about updated" came to be printed
  // for a change that never happened.
  async changeAbout(text) {
    const body = String(text == null ? '' : text);
    // The limit the apps impose. A longer one is dropped rather than refused,
    // so it would otherwise look exactly like this bug.
    if (Array.from(body).length > ABOUT_MAX_LENGTH) {
      throw new Error('changeAbout: an about is limited to ' + ABOUT_MAX_LENGTH +
        ' characters — the server drops a longer one instead of refusing it');
    }

    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'status',
      to:    jidStrToObj('@s.whatsapp.net'),
      type:  'set'
    }, [
      new BinaryNode('status', {}, Buffer.from(body, 'utf8'))
    ]);

    const resp = await this._sendIq(node);
    if (!resp) throw new Error('changeAbout: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const errText = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error('changeAbout: server rejected the change' +
        (code ? ' (' + code + (errText ? ' ' + errText : '') + ')' : ''));
    }
    return resp;
  }

  // The about this account currently has, as the server reports it.
  //
  // The set IQ is answered before the new text has to be visible anywhere, so
  // an empty result proves only that the stanza was understood. Reading it back
  // is the only way to tell an about the server stored from one it took and
  // dropped — and it is asked exactly the way a contact's is.
  async queryOwnAbout() {
    const me = this._store &&
      (this._store.phoneNumber || (this._store.me && this._store.me.id));
    if (!me) throw new Error('queryOwnAbout: not connected');
    return this.queryAbout(String(me));
  }

  // Change profile picture
  // buf: Buffer with JPEG image data
  // Change your own profile picture.
  //
  // buf: a Buffer holding any image, or null to remove the current picture.
  // Returns the new picture id, or 'remove' when it was taken down.
  //
  // The image is re-encoded to the square 640x640 JPEG the server expects
  // before it goes out. Sending a file as it came off disk is what a person
  // naturally tries and what the server silently drops — pass { raw: true } to
  // skip that if you have already prepared it yourself.
  //
  // `target` names *whose* picture is being set, and is left off entirely when
  // it is your own — the server infers that from the session. A group picture
  // carries a target and works; the same IQ with your own JID in target does
  // not, and the server's answer to that is silence rather than a refusal.
  //
  // This has now been wrong in both directions: first addressed *to* the
  // account, then addressed about it. It is neither — it is addressed to the
  // server with nothing named at all.
  async changeProfilePicture(buf, opts) {
    if (!this._store) throw new Error('Not connected');
    opts = opts || {};
    const picture = (buf && !opts.raw) ? await prepareProfilePicture(buf, opts) : buf;

    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'w:profile:picture',
      to:    's.whatsapp.net',
      type:  'set'
    }, picture ? [new BinaryNode('picture', { type: 'image' }, picture)] : null);

    const resp = await this._sendIq(node);
    if (!resp) {
      throw new Error('changeProfilePicture: no reply from server (IQ timed out). ' +
        'The server drops a picture it will not take rather than refusing it, so ' +
        'this usually means the image was not in the form it wants' +
        (opts.raw ? ' — this call passed { raw: true }, so nothing was re-encoded'
                  : '') + '.');
    }
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      if (String(code) === '406') {
        throw new Error(_pictureRejected('changeProfilePicture', picture, buf, opts));
      }
      throw new Error('changeProfilePicture: ' +
        (String(code) === '401' ? 'not authorised to change this picture'
       : 'server rejected the request' + (code ? ' (' + code + ')' : '')));
    }

    if (!buf) return 'remove';
    const picNode = findChild(resp, 'picture');
    return (picNode && picNode.attrs && picNode.attrs.id)
      ? String(picNode.attrs.id) : null;
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
  // The names above are friendly aliases. What goes on the wire is: last,
  // profile, status, online, readreceipts, groupadd, calladd, messages,
  // defense, stickers. Four of the six names this used to
  // put on the wire — last_seen, profile_picture, read_receipts, groups_add —
  // are not names the server knows, so those settings never changed and the
  // discarded reply meant it never said so either.
  async changePrivacySetting(type, value, excluded) {
    const name = PRIVACY_NAME_ALIASES[String(type)];
    if (!name) {
      throw new Error('changePrivacySetting: unknown setting "' + type + '" — one of ' +
        Object.keys(PRIVACY_NAME_ALIASES).join(', '));
    }

    const wireValue = this._privacyWireValue(name, value);

    // WhatsApp Web does not put <user> children on this IQ; the exclusion list
    // is maintained separately. Kept for callers that pass it,
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
        new BinaryNode('category', { name, value: wireValue },
          children.length > 0 ? children : null)
      ])
    ]);

    const resp = await this._sendIq(node);
    if (!resp) throw new Error('changePrivacySetting: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error('changePrivacySetting: server rejected ' + name + '=' + wireValue +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }

    // The change is folded into the cached copy and the whole thing handed back
    // rather than making the caller re-query.
    const key = PRIVACY_WIRE_TO_KEY[name];
    this._privacySettings = Object.assign({}, this._privacySettings || {},
      { [key]: wireValue });
    return this._privacySettings;
  }

  // Resolve what the caller typed to what this particular setting accepts.
  //
  // The allowed set differs per setting — read receipts are all-or-none, online
  // is all-or-match-last-seen — so "contacts" is right for one and meaningless
  // for another. Sending a meaningless one gets no reply at all.
  _privacyWireValue(name, value) {
    const allowed = PRIVACY_ALLOWED_VALUES[name];
    const raw     = String(value == null ? '' : value).trim().toLowerCase();
    const perName = PRIVACY_VALUE_ALIASES_BY_NAME[name] || {};
    const mapped  = allowed && allowed.includes(raw)
      ? raw
      : (perName[raw] || PRIVACY_VALUE_ALIASES[raw] || raw);

    if (allowed && !allowed.includes(mapped)) {
      throw new Error('changePrivacySetting: "' + value + '" is not a value ' +
        name + ' accepts — use one of ' + allowed.join(', ') +
        '. The server ignores anything else without answering.');
    }
    return mapped;
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
  // Returns [{ type, isDefault, list }] with the default first. type is
  // 'contacts', 'blacklist' or 'whitelist'; list
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
  // a whitelist is the list itself, anything else is every known contact minus
  // the blacklist, and
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
    let recipients, source;

    if (privacy.type === 'whitelist') {
      recipients = privacy.list.slice();
      source = 'whitelist';
    } else {
      const hist = this.getHistoryStore() || {};
      const isPerson = (jid) => !jid.endsWith('@g.us') && !jid.endsWith('@broadcast') &&
        !jid.endsWith('@newsletter') && !this._isOwnUser(jid);

      // Contacts proper: entries the history sync gave a name to.
      const contacts = Object.keys(hist.contacts || {}).filter(jid => {
        const c = hist.contacts[jid];
        return c && (c.name || c.displayName) && isPerson(jid);
      });

      // A named contact list is what WhatsApp itself posts to. When history has
      // not brought one — a fresh session, or a sync that carried chats without
      // names — the people you actually have conversations with are the next
      // best thing, and far better than posting to nobody.
      let pool = contacts;
      source = 'contacts';
      if (pool.length === 0) {
        pool = Object.keys(hist.chats || {}).filter(isPerson);
        source = 'chats';
      }

      const blocked = new Set(privacy.type === 'blacklist' ? privacy.list : []);
      recipients = pool.filter(jid => !blocked.has(jid));
    }

    if (!recipients.some(j => this._isOwnUser(j))) recipients.push(ownJid);
    _whaDbg('[DBG] STATUS_RECIPIENTS type=' + privacy.type + ' source=' + source +
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

  // ──────────────────────────────────────────────────────────────────────────
  // ACCOUNT RESTRICTION (reachout timelock)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Ask the server whether this account is currently restricted, and until when.
   *
   * A restriction is what error 463 means when it will not go away: WhatsApp
   * has decided the account is starting too many chats with people who never
   * reply, and refuses new ones until it expires. Existing chats keep working,
   * which is why the account otherwise looks fine.
   *
   * The expiry is not pushed to the client — this is the only way to learn it.
   *
   * @returns {Promise<object>} { active, remaining, remainingMs, endsAtDate,
   *                              enforcementType, reason, expiryUnknown }
   */
  async fetchReachoutTimelock() {
    const payload = await this._mexQuery(MEX_QUERY_REACHOUT_TIMELOCK, {},
      'xwa2_fetch_account_reachout_timelock');

    // Some servers answer this one tersely: a bare boolean rather than the
    // object with the expiry in it. `false` is a definite "no restriction" and
    // is taken at face value; `true` says there is one but not when it ends, so
    // it is marked as an expiry we do not know and the announcement supplies
    // the countdown.
    if (typeof payload === 'boolean') {
      return this._setReachoutTimelock(
        ReachoutTimelock.parseTimelockPayload({ is_active: payload }), 'query');
    }

    if (payload == null || typeof payload !== 'object') {
      const err = new Error('the server answered ' + JSON.stringify(payload) +
        ', which says nothing about a restriction either way');
      err.mexDecoded = payload;
      throw err;
    }

    return this._setReachoutTimelock(
      ReachoutTimelock.parseTimelockPayload(payload), 'query');
  }

  /**
   * What we last learned about the restriction, without asking again.
   *
   * The countdown is computed fresh on every call, so this is what a ticking
   * display reads once a second. Returns an inactive state when nothing has
   * been fetched yet — call fetchReachoutTimelock() for that.
   */
  getReachoutTimelock() {
    return ReachoutTimelock.describe(this._reachoutTimelock);
  }

  /**
   * Refresh the restriction after a send was refused, at most once a minute.
   *
   * A 463 has two causes that look identical on the wire: a contact we simply
   * hold no privacy token for, which the resend recovers from, and an account
   * restriction, which no resend will fix. Asking the server tells the two
   * apart, and it is the only way to learn when the restriction ends.
   *
   * Rate-limited because a burst of refused sends would otherwise fire one
   * query each, and a restricted account is exactly where a burst happens.
   */
  _refreshReachoutTimelockAfter463() {
    if (!this._connected) return;
    const last = this._reachoutTimelock && this._reachoutTimelock.checkedAt;
    if (last && Date.now() - last < 60000) return;
    if (this._reachoutTimelockInFlight) return;

    this._reachoutTimelockInFlight = this.fetchReachoutTimelock()
      .then(state => {
        if (state.active) {
          _whaDbg('[DBG] ACCOUNT_RESTRICTED for ' + state.remaining +
            ' (' + state.enforcementType + ')');
        }
      })
      .catch(err => _whaDbg('[DBG] REACHOUT_TIMELOCK fetch failed: ' + (err && err.message)))
      .then(() => { this._reachoutTimelockInFlight = null; });
  }

  _setReachoutTimelock(state, source) {
    this._reachoutTimelock = Object.assign({}, state, { checkedAt: Date.now() });
    const described = ReachoutTimelock.describe(this._reachoutTimelock);
    this.emit('account_restriction', Object.assign({ source }, described));
    return described;
  }

  /**
   * One w:mex GraphQL call.
   *
   * The reply is JSON inside <result>. GraphQL reports failures in the body
   * with a 200-shaped envelope, so an errors array has to be checked for
   * separately — otherwise a refused query reads as an empty result and the
   * caller concludes the account is fine.
   */
  async _mexQuery(queryId, variables, dataPath) {
    const body = Buffer.from(JSON.stringify({ variables: variables || {} }), 'utf8');

    // The <query> node carries the query id and nothing else.
    //
    // Asking for a format here was tried and is wrong: a `format="json"`
    // attribute makes the server drop the stanza on the floor — no reply at
    // all, where without it there is at least an answer. It does not ignore
    // what it does not recognise, so nothing speculative belongs on this node.
    const resp = await this._sendIq(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'get',
      xmlns: 'w:mex'
    }, [new BinaryNode('query', { query_id: String(queryId) }, body)]));

    if (!resp) throw new Error('mex query ' + queryId + ': no reply from server (IQ timed out)');

    // An <error> child is the refusal whether or not the iq is typed as one.
    const errNode = (resp.attrs && resp.attrs.type === 'error')
      ? findChildDeep(resp, 'error') : findChild(resp, 'error');
    if (errNode) {
      const a    = errNode.attrs || {};
      const code = a.code ? String(a.code) : null;
      const text = a.text ? String(a.text) : null;
      throw new Error('mex query ' + queryId + ': server rejected the request' +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }

    // The JSON normally sits in <result>, but not every build wraps it the same
    // way, so take it from wherever in the reply it turns up rather than from
    // one fixed path.
    const json = this._mexJsonFrom(resp);
    if (json) {
      if (json.errors && json.errors.length) {
        throw new Error('mex query ' + queryId + ': ' +
          json.errors.map(e => (e && e.message) || 'unknown error').join(', '));
      }
      return dataPath ? (json.data && json.data[dataPath]) : json.data;
    }

    // Not JSON, so the other encoding this transport uses: Argo, which is what
    // newer servers answer with. It carries its own field names, so it decodes
    // without the GraphQL schema the query was written against.
    const resultNode = findChildDeep(resp, 'result');
    const format     = resultNode && resultNode.attrs && resultNode.attrs.format;
    const raw        = resultNode ? getNodeContent(resultNode) : null;

    // Only when the server said so. Guessing that unlabelled bytes are Argo
    // turns "this reply is not what I expected" into a misleading complaint
    // about a format that was never claimed.
    if (raw && raw.length && format && String(format).toLowerCase() === 'argo') {
      let decoded;
      try {
        decoded = decodeArgo(raw);
      } catch (e) {
        const err = new Error('mex query ' + queryId + ': the reply is ' +
          (format ? '"' + format + '"' : 'binary') + ' and could not be decoded — ' +
          e.message + ' (' + raw.length + ' bytes: ' + raw.toString('hex') + ')');
        err.mexFormat  = format ? String(format) : null;
        err.mexPayload = raw;
        throw err;
      }
      _whaDbg('[DBG] MEX_ARGO decoded ' + JSON.stringify(decoded));

      if (decoded && typeof decoded === 'object') {
        if (decoded.errors && decoded.errors.length) {
          throw new Error('mex query ' + queryId + ': ' +
            decoded.errors.map(e => (e && e.message) || 'unknown error').join(', '));
        }
        if (decoded.data !== undefined) {
          return dataPath ? (decoded.data && decoded.data[dataPath]) : decoded.data;
        }
        return dataPath ? decoded[dataPath] : decoded;
      }

      // Not a GraphQL envelope but still an answer — a bare boolean, most
      // often. Handed back as-is for the caller to interpret, since only the
      // caller knows what its own query means.
      return decoded;
    }

    if (format && String(format).toLowerCase() !== 'json') {
      const err = new Error('mex query ' + queryId + ': the server answered in "' +
        format + '", which this library cannot read' +
        (raw ? ' (' + raw.length + ' bytes: ' + raw.toString('hex') + ')' : ''));
      err.mexFormat  = String(format);
      err.mexPayload = raw || null;
      _whaDbg('[DBG] MEX_REPLY_FORMAT ' + format + ' — cannot decode');
      throw err;
    }

    _whaDbg('[DBG] MEX_REPLY_UNPARSED ' + JSON.stringify(describeNodeBriefly(resp)));
    throw new Error('mex query ' + queryId + ': the reply carried no JSON — ' +
      describeNodeBriefly(resp));
  }

  // Walk the reply for the first node whose content parses as a JSON object.
  //
  // Content arrives as bytes for a long payload and as a plain string when the
  // encoder had a token for it, so both are tried.
  _mexJsonFrom(node) {
    if (!node) return null;
    const raw = getNodeContent(node);
    if (raw && raw.length) {
      const text = raw.toString('utf8').trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) { /* not this node */ }
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const found = this._mexJsonFrom(child);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * <notification type="mex"> — a GraphQL push rather than a reply.
   *
   * The restriction is the one that matters here: the server announces both
   * when it starts and when it is lifted, so a client that listens does not
   * have to poll to know it can send again.
   */
  _handleMexNotification(node) {
    const update = findChild(node, 'update');
    if (!update) return;
    const opName = (update.attrs && update.attrs.op_name) || '';
    const buf    = getNodeContent(update);
    if (!buf) return;

    let json;
    try { json = JSON.parse(buf.toString('utf8')); }
    catch (_) { _whaDbg('[DBG] MEX_NOTIF ' + opName + ' — body was not JSON'); return; }
    if (json.errors && json.errors.length) return;
    const data = json.data;
    if (!data) return;

    if (opName === 'NotificationUserReachoutTimelockUpdate') {
      const payload = data.xwa2_notify_account_reachout_timelock;
      if (!payload) return;
      const state = ReachoutTimelock.parseTimelockPayload(payload);
      _whaDbg('[DBG] MEX_NOTIF restriction ' + (state.active ? 'set' : 'lifted'));
      this._setReachoutTimelock(state, 'notification');
      return;
    }

    // Anything else the server pushes this way, passed on rather than dropped.
    this.emit('mex_notification', { opName, data });
  }

  // Internal: parse newsletter response from w:mex IQ result
  //
  // Every newsletter call travels the same transport as the restriction query,
  // so a server that answers that one in Argo answers these in Argo too. This
  // used to swallow that and return null, which reads as "no such newsletter"
  // rather than "this reply is in an encoding nothing here can read" — the
  // difference between a shrug and something a caller can act on.
  _parseNewsletterResponse(resp) {
    try {
      const json = this._mexJsonFrom(resp);
      if (!json) {
        const resultNode = findChildDeep(resp, 'result');
        const format     = resultNode && resultNode.attrs && resultNode.attrs.format;
        if (format && String(format).toLowerCase() !== 'json') {
          _whaDbg('[DBG] NEWSLETTER reply format=' + format + ' — cannot decode');
          const err = new Error('the server answered in "' + format +
            '" rather than JSON, which this library cannot read');
          err.mexFormat = String(format);
          throw err;
        }
        return null;
      }
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
    } catch (err) {
      if (err && err.mexFormat) throw err;
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

  // Clears the unread badge on a chat. This is the chat's own read flag — to
  // send read receipts for particular messages, use markRead().
  async markChatRead(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(
      AppMutations.markReadPatch(jidFull, true),
      () => this._sendIq(new BinaryNode('iq', {
        id: this._genMsgId(), to: 's.whatsapp.net', type: 'set', xmlns: 'w'
      }, [new BinaryNode('read',
        { jid: jidFull, count: '-1', index: '0', owner: 'false' }, null)])));
    this._getChatState(jidFull).markedAsUnread = false;
    this.emit('chat_read', { jid: jidFull, read: true, synced });
    return synced;
  }

  async markChatUnread(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(
      AppMutations.markReadPatch(jidFull, false));
    this._getChatState(jidFull).markedAsUnread = true;
    this.emit('chat_read', { jid: jidFull, read: false, synced });
    return synced;
  }

  // durationMs is how long from now to stay muted; 0 or omitted means until
  // it is unmuted by hand. The wire carries an absolute end in milliseconds.
  async muteChat(jid, durationMs) {
    const jidFull = makeJid(jid);
    const endMs   = (durationMs && durationMs > 0) ? Date.now() + durationMs : 0;
    const synced  = await this._appStatePatchOrFallback(
      AppMutations.mutePatch(jidFull, endMs || 1),
      () => this._muteIq(jidFull, endMs ? Math.floor(endMs / 1000) : 0));
    const chat = this._getChatState(jidFull);
    chat.muted       = true;
    chat.muteUntilMs = endMs || -1;
    this.emit('chat_muted', { jid: jidFull, muted: true, until: chat.muteUntilMs, synced });
    return synced;
  }

  async unmuteChat(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(
      AppMutations.mutePatch(jidFull, 0),
      () => this._muteIq(jidFull, null));
    const chat = this._getChatState(jidFull);
    chat.muted       = false;
    chat.muteUntilMs = 0;
    this.emit('chat_muted', { jid: jidFull, muted: false, synced });
    return synced;
  }

  // The mute a primary sends for itself. A companion never uses this — its
  // mutes travel as app state so the phone learns about them.
  _muteIq(jidFull, untilSeconds) {
    const attrs = { jid: jidFull, add: untilSeconds === null ? '0' : '1' };
    if (untilSeconds) attrs.t = String(untilSeconds);
    return this._sendIq(new BinaryNode('iq', {
      id:    this._genMsgId(),
      to:    's.whatsapp.net',
      type:  'set',
      xmlns: 'w:web'
    }, [new BinaryNode('mute', attrs, null)]));
  }

  // Block a contact. Returns the updated block list.
  async blockContact(jid) {
    return this._updateBlocklist(jid, 'block');
  }

  // Unblock a contact. Returns the updated block list.
  async unblockContact(jid) {
    return this._updateBlocklist(jid, 'unblock');
  }

  // Work out the LID a block list item has to be addressed with, and the phone
  // JID that goes beside it.
  //
  // The server only accepts LID-addressed items on a LID account: a phone JID
  // comes back as <error code="400" text="bad-request" addressing_mode="lid"/>,
  // the attribute being the server saying which addressing it wanted. When the
  // mapping is not known yet a contact usync fetches it.
  async _resolveBlockTarget(jid) {
    const norm = toNonAdJid(makeJid(jid));
    const user = norm.split('@')[0];

    if (norm.endsWith('@lid')) {
      const pn = this._lidToPn.get(user);
      return { lid: norm, pn: pn ? pn + '@s.whatsapp.net' : null };
    }

    let lidUser = this._pnToLid.get(user);
    if (!lidUser && this._devMgr) {
      _whaDbg('[DBG] BLOCK_LID_LOOKUP ' + user);
      try { await this._devMgr._doContactUsync([user]); } catch (_) {}
      lidUser = this._pnToLid.get(user);
    }
    return { lid: lidUser ? lidUser + '@lid' : null, pn: norm };
  }

  // The one IQ behind both:
  //
  //   <iq xmlns="blocklist" type="set" to="s.whatsapp.net">
  //     <item action="block" jid="<LID>" pn_jid="<phone JID>"/>
  //   </iq>
  //
  // The item is addressed by LID, and a block carries the phone number beside
  // it; an unblock carries only the LID. That is the shape this server accepts
  // — sending the plain JID it was handed, which is what this used to do, got a
  // 400 bad-request back.
  //
  // Three other things were wrong with the pair this replaces. The jid went out
  // as a raw string rather than a binary JID. It was not reduced to its bare
  // user first, so naming a contact with a device suffix sent a device JID
  // there is nothing to block. And the reply was thrown away without being
  // looked at, so a refusal came back looking exactly like a success.
  async _updateBlocklist(jid, action) {
    const { lid, pn } = await this._resolveBlockTarget(jid);
    if (!lid) {
      throw new Error(action + 'Contact: could not resolve a LID for ' + jid +
        ' — the server only accepts LID-addressed block list items. ' +
        'Check the number is on WhatsApp.');
    }
    const attrs = { action, jid: jidStrToObj(lid) };
    if (action === 'block') {
      if (!pn) {
        throw new Error('blockContact: no phone number known for ' + lid +
          ' — a block has to carry pn_jid beside the LID.');
      }
      attrs.pn_jid = jidStrToObj(pn);
    }

    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'blocklist',
      to:    's.whatsapp.net',
      type:  'set'
    }, [
      new BinaryNode('item', attrs, null)
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

  // ─── Chat state ───────────────────────────────────────────────────────────
  //
  // Pinning, archiving, muting, marking read and starring are not local
  // preferences — they are app state, which is how a change reaches the phone
  // and every other linked device. Each of these writes a patch and waits for
  // the server to take it; the local view only moves once it has.
  //
  // These used to set a field on an in-memory object and emit an event, so a
  // pin lasted until the process exited and never appeared anywhere else.

  async pinChat(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(AppMutations.pinPatch(jidFull, true));
    this._getChatState(jidFull).pinnedAt = Math.floor(Date.now() / 1000);
    this.emit('chat_pinned', { jid: jidFull, pinned: true, synced });
    return synced;
  }

  async unpinChat(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(AppMutations.pinPatch(jidFull, false));
    this._getChatState(jidFull).pinnedAt = 0;
    this.emit('chat_pinned', { jid: jidFull, pinned: false, synced });
    return synced;
  }

  async archiveChat(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(AppMutations.archivePatch(jidFull, true));
    this._getChatState(jidFull).archived = true;
    this.emit('chat_archived', { jid: jidFull, archived: true, synced });
    return synced;
  }

  async unarchiveChat(jid) {
    const jidFull = makeJid(jid);
    const synced  = await this._appStatePatchOrFallback(AppMutations.archivePatch(jidFull, false));
    this._getChatState(jidFull).archived = false;
    this.emit('chat_archived', { jid: jidFull, archived: false, synced });
    return synced;
  }

  // fromMe says whether the message being starred is one of ours. It is part of
  // the index, so getting it wrong stars a different message — or nothing.
  async starMessage(msgId, chatJid, fromMe) {
    return this._setStar(msgId, chatJid, fromMe, true);
  }

  async unstarMessage(msgId, chatJid, fromMe) {
    return this._setStar(msgId, chatJid, fromMe, false);
  }

  async _setStar(msgId, chatJid, fromMe, starred) {
    const jidFull = makeJid(chatJid);
    const synced  = await this._appStatePatchOrFallback(
      AppMutations.starPatch(jidFull, msgId, !!fromMe, starred));
    if (!this._starredMessages) this._starredMessages = new Set();
    const key = jidFull + ':' + msgId;
    if (starred) this._starredMessages.add(key); else this._starredMessages.delete(key);
    this.emit('message_starred',
      { msgId, chatJid: jidFull, starred, fromMe: !!fromMe, synced });
    return synced;
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
  // Every participant goes out as a binary JID (a raw string is dropped for an
  // @lid), a LID participant also carries the phone number the server matches it
  // against, and each carries our privacy token so the invitation is not treated
  // as an anonymous reach-out. The setting nodes are siblings of the
  // participants inside <create>.
  async createGroup(subject, participants, opts) {
    opts = opts || {};
    const id       = this._genMsgId();
    // participant nodes MUST use attr `jid`, not `value`
    const partNodes = (participants || []).map(p => {
      // A participant is the person, never one of their devices — a JID that
      // still carries a device suffix is not one the server will match.
      const jid   = toNonAdJid(makeJid(p));
      const attrs = { jid: jidStrToObj(jid) };
      if (jid.endsWith('@lid')) {
        const pn = this._lidToPn.get(jid.split('@')[0].split(':')[0]);
        if (pn) attrs.phone_number = jidStrToObj(pn + '@s.whatsapp.net');
      }
      const token    = this._tcTokenFor(jid);
      const children = token ? [new BinaryNode('privacy', {}, token)] : null;
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
      // trigger="1" has to travel alongside the expiration; without it the
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

    // `key` is what the server echoes back on the group-create notification so
    // the client can tell its own creation apart from one it merely witnessed.
    // A per-second value collides when two groups are made in the same second;
    // a message id does not.
    const baseAttrs = { subject, key: this._genMsgId() };
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

  // Add participants to group.
  //
  // Returns one result per participant, successes and failures alike — see
  // _groupParticipantAction. A participant refused with 403 usually carries an
  // `addRequest`, which sendGroupInvite() turns into an invitation they can act
  // on themselves.
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
    // Binary JIDs, and on an add, the phone number behind a LID plus our
    // privacy token for them.
    const participantNodes = arr.map(j => {
      const jid   = toNonAdJid(makeJid(j));
      const attrs = { jid: jidStrToObj(jid) };
      let children = null;
      if (action === 'add') {
        if (jid.endsWith('@lid')) {
          const pn = this._lidToPn.get(jid.split('@')[0].split(':')[0]);
          if (pn) attrs.phone_number = jidStrToObj(pn + '@s.whatsapp.net');
        }
        const token = this._tcTokenFor(jid);
        if (token) children = [new BinaryNode('privacy', {}, token)];
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
    if (!resp) throw new Error(action + ': no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error(action + ': server rejected the request' +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }
    const actionNode = findChild(resp, action);
    if (!actionNode) {
      throw new Error(action + ': server reply contained no <' + action + '> node');
    }
    // The membership changed, so anything we have cached about the group is now
    // one edit behind.
    this.invalidateGroupMetadata(gJid);
    return parseParticipantNodes(actionNode);
  }

  // Change group name/subject
  async changeGroupSubject(groupJid, subject) {
    const gJid = makeJid(groupJid);
    const id   = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jidStrToObj(gJid),
      type:  'set'
    }, [
      new BinaryNode('subject', {}, Buffer.from(subject, 'utf8'))
    ]);
    const resp = await this._sendIq(node);
    this.invalidateGroupMetadata(gJid);
    return resp;
  }

  // Change group description
  // description: string or null/'' to remove
  //
  // prev=<current topic id> has to go out with the edit so the server can reject
  // one made against a description someone else has already replaced. Without it
  // the change is refused. The current id is looked up from the group metadata
  // when the caller does not supply one.
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
    const resp = await this._sendIq(node);
    this.invalidateGroupMetadata(gJid);
    return resp;
  }

  // ─── Group settings ───────────────────────────────────────────────────────
  //
  // Both are a single empty node whose TAG carries the state — there is no
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

  // Change group picture.
  //
  // buf: Buffer with JPEG image data, or null to remove the current picture.
  // Returns the new picture id, or 'remove' when the picture was taken down.
  //
  // Removal is the IQ with no body at all — an empty <picture> node is a
  // malformed upload rather than a delete, and the server answers 406 for it.
  //
  // The image is re-encoded to a square 640x640 JPEG first, on the same terms
  // as a profile picture; { raw: true } skips that.
  async changeGroupPicture(groupJid, buf, opts) {
    opts = opts || {};
    const picture = (buf && !opts.raw) ? await prepareProfilePicture(buf, opts) : buf;
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns:  'w:profile:picture',
      target: jidStrToObj(makeJid(groupJid)),
      to:     's.whatsapp.net',
      type:   'set'
    }, picture ? [new BinaryNode('picture', { type: 'image' }, picture)] : null);
    const resp = await this._sendIq(node);
    if (!resp) {
      throw new Error('changeGroupPicture: no reply from server (IQ timed out). ' +
        'The server drops a picture it will not take rather than refusing it, so ' +
        'this usually means the image was not in the form it wants.');
    }
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      if (String(code) === '406') {
        throw new Error(_pictureRejected('changeGroupPicture', picture, buf, opts));
      }
      throw new Error('changeGroupPicture: ' +
        (String(code) === '403' ? 'you are not allowed to change this group picture'
       : 'server rejected the request' + (code ? ' (' + code + ')' : '')));
    }
    if (!buf) return 'remove';
    const picNode = findChild(resp, 'picture');
    return (picNode && picNode.attrs && picNode.attrs.id)
      ? String(picNode.attrs.id) : null;
  }

  // Get the group's invite link.
  //
  // reset=true revokes the current link and returns a freshly minted one — the
  // same IQ with type="set" instead of "get".
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
      // 410 is a revoked link, 406 an invalid one. Anything else is passed
      // through as the server worded it.
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

  // Query participants pending approval.
  //
  // Each entry stringifies to the JID and also carries `requestedAt`, the unix
  // second the person asked to join, so a list can be shown oldest-first.
  async queryGroupPendingParticipants(groupJid) {
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jidStrToObj(makeJid(groupJid)),
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
      .map(parseJoinRequestNode)
      .filter(Boolean);
  }

  // Approve or reject pending join requests.
  //
  // Returns one result per participant, refusals included, on the same terms as
  // the add/remove/promote/demote actions.
  async approveGroupParticipants(groupJid, approve, jids) {
    const gJid    = makeJid(groupJid);
    const arr     = Array.isArray(jids) ? jids : [jids];
    const action  = approve ? 'approve' : 'reject';
    const partNodes = arr.map(j =>
      new BinaryNode('participant', { jid: jidStrToObj(toNonAdJid(makeJid(j))) }, null)
    );
    const id = this._genMsgId();
    const node = new BinaryNode('iq', {
      id,
      xmlns: 'w:g2',
      to:    jidStrToObj(gJid),
      type:  'set'
    }, [
      new BinaryNode('membership_requests_action', {}, [
        new BinaryNode(action, {}, partNodes)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) throw new Error(action + ': no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const code    = errNode && errNode.attrs && errNode.attrs.code;
      const text    = errNode && errNode.attrs && errNode.attrs.text;
      throw new Error(action + ': server rejected the request' +
        (code ? ' (' + code + (text ? ' ' + text : '') + ')' : ''));
    }
    const actionNode = findChildDeep(resp, action);
    if (!actionNode) {
      throw new Error(action + ': server reply contained no <' + action + '> node');
    }
    this.invalidateGroupMetadata(gJid);
    return parseParticipantNodes(actionNode);
  }

  // ─── Personal group invitations ───────────────────────────────────────────
  //
  // A group invite link is public: anyone holding it can join. These three are
  // the other kind — an invitation minted for one named person, which is the
  // only way into a group for someone whose privacy settings stop them from
  // being added outright. The code comes back attached to the refusal from
  // addGroupParticipants (`result.addRequest`), travels to them as a message
  // built by sendGroupInvite, and is spent by acceptGroupInviteMessage.

  // Send someone a personal invitation to a group.
  //
  // opts: { groupName, caption, jpegThumbnail, isCommunity, id, contextInfo }
  //
  // The group name is filled in from the group's own metadata when the caller
  // does not supply one, so the bubble does not arrive nameless.
  async sendGroupInvite(to, groupJid, inviteCode, inviteExpiration, opts) {
    if (!this._sender || !this._connected) throw new Error('Not connected');
    opts = opts || {};
    const gJid = makeJid(groupJid);
    let groupName = opts.groupName;
    if (groupName === undefined) {
      try {
        const meta = await this.getGroupMetadata(gJid);
        groupName = (meta && meta.subject) || '';
      } catch (_) { groupName = ''; }
    }
    return this._sender.sendGroupInvite(to, gJid, inviteCode, inviteExpiration,
      Object.assign({}, opts, { groupName }));
  }

  // Look at a group behind a personal invitation without accepting it.
  //
  // inviterJid is who sent the invitation; code and expiration come from the
  // invite message itself.
  async queryGroupInviteMessageInfo(groupJid, inviterJid, code, expiration) {
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'w:g2',
      to:    jidStrToObj(makeJid(groupJid)),
      type:  'get'
    }, [
      new BinaryNode('query', {}, [
        new BinaryNode('add_request', {
          code:       String(code),
          expiration: String(expiration || 0),
          admin:      jidStrToObj(makeJid(inviterJid))
        }, null)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) throw new Error('queryGroupInviteMessageInfo: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const errCode = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('queryGroupInviteMessageInfo: ' +
        (String(errCode) === '410' ? 'the invitation has expired'
       : String(errCode) === '406' ? 'the invitation is not valid'
       : 'server rejected the request' + (errCode ? ' (' + errCode + ')' : '')));
    }
    const grp = findChild(resp, 'group');
    if (!grp) throw new Error('queryGroupInviteMessageInfo: server reply contained no <group> node');
    return this._parseGroupNode(grp);
  }

  // Accept a personal invitation. Returns the JID of the group joined.
  async acceptGroupInviteMessage(groupJid, inviterJid, code, expiration) {
    const gJid = makeJid(groupJid);
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'w:g2',
      to:    jidStrToObj(gJid),
      type:  'set'
    }, [
      new BinaryNode('accept', {
        code:       String(code),
        expiration: String(expiration || 0),
        admin:      jidStrToObj(makeJid(inviterJid))
      }, null)
    ]);
    const resp = await this._sendIq(node);
    if (!resp) throw new Error('acceptGroupInviteMessage: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const errCode = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('acceptGroupInviteMessage: ' +
        (String(errCode) === '410' ? 'the invitation has expired'
       : String(errCode) === '406' ? 'the invitation is not valid'
       : 'server rejected the request' + (errCode ? ' (' + errCode + ')' : '')));
    }
    this.invalidateGroupMetadata(gJid);
    return (resp.attrs && resp.attrs.from) ? String(resp.attrs.from) : gJid;
  }

  // Withdraw a personal invitation you sent, before it is used.
  async revokeGroupInviteForParticipant(groupJid, invitedJid) {
    const node = new BinaryNode('iq', {
      id:    this._genMsgId(),
      xmlns: 'w:g2',
      to:    jidStrToObj(makeJid(groupJid)),
      type:  'set'
    }, [
      new BinaryNode('revoke', {}, [
        new BinaryNode('participant', { jid: jidStrToObj(toNonAdJid(makeJid(invitedJid))) }, null)
      ])
    ]);
    const resp = await this._sendIq(node);
    if (!resp) throw new Error('revokeGroupInviteForParticipant: no reply from server (IQ timed out)');
    if (resp.attrs && resp.attrs.type === 'error') {
      const errNode = findChild(resp, 'error');
      const errCode = errNode && errNode.attrs && errNode.attrs.code;
      throw new Error('revokeGroupInviteForParticipant: server rejected the request' +
        (errCode ? ' (' + errCode + ')' : ''));
    }
    return true;
  }

  // Add participants, and for every one the server refuses because they cannot
  // be added directly, send them a personal invitation instead.
  //
  // Returns the same list addGroupParticipants returns, with `invited` set on
  // the entries an invitation went out to.
  async addGroupParticipantsOrInvite(groupJid, jids, opts) {
    opts = opts || {};
    const gJid    = makeJid(groupJid);
    const results = await this.addGroupParticipants(gJid, jids);
    const pending = results.filter(r => r.needsInvite);
    if (!pending.length) return results;

    let groupName = opts.groupName;
    if (groupName === undefined) {
      try {
        const meta = await this.getGroupMetadata(gJid);
        groupName = (meta && meta.subject) || '';
      } catch (_) { groupName = ''; }
    }

    for (const r of pending) {
      try {
        await this.sendGroupInvite(r.jid, gJid, r.addRequest.code,
          r.addRequest.expiration, Object.assign({}, opts, { groupName }));
        r.invited = true;
      } catch (err) {
        r.invited = false;
        r.inviteError = err.message || String(err);
      }
    }
    return results;
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
