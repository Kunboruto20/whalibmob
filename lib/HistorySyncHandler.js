'use strict';

/**
 * HistorySyncHandler — full WhatsApp history sync for whalibmob mobile client.
 *
 * Flow:
 *  1. Server sends encrypted <message> containing ProtocolMessage (type=6)
 *     with HistorySyncNotification in field 6.
 *  2. Client decrypts via Signal; MessageProto decoder returns:
 *       { type:'protocol', subtype:'history_sync', historySyncNotification: {...} }
 *  3. Client calls processHistorySyncNotification() which:
 *       a) Uses inline payload if present, otherwise downloads CDN blob
 *       b) Decrypts with AES-256-CBC (HKDF key "WhatsApp History Keys")
 *       c) Inflates zlib
 *       d) Decodes HistorySync protobuf
 *       e) Persists to {phone}.history.json + {phone}.messages.json
 *  4. Returns result; Client emits 'history_sync' event.
 *
 * App-state sync key share (ProtocolMessage type=5):
 *  Keys are saved to {phone}.appStateKeys.json for later use in app-state decryption.
 *
 * Persistence files (all in sessionDir):
 *   {phone}.history.json    — chats, contacts, push names, LID↔PN mappings
 *   {phone}.messages.json   — flat map of msgId → message metadata
 *   {phone}.appStateKeys.json — app-state sync keys received from server
 */

const crypto = require('crypto');
const { hkdfSha256 } = require('./hkdf');
const https  = require('https');
const http   = require('http');
const zlib   = require('zlib');
const fs     = require('fs');
const path   = require('path');

const { sha256 } = require('@noble/hashes/sha256');

// ─── Constants ────────────────────────────────────────────────────────────────

const HISTORY_HKDF_INFO = 'WhatsApp History Keys';
const EXPANDED_SIZE     = 112;
const IV_LEN            = 16;
const KEY_LEN           = 32;
const MAC_LEN           = 10;
const CDN_HOST          = 'mmg.whatsapp.net';

/** HistorySync.HistorySyncType enum — matches WhatsApp proto definition */
const HistorySyncType = {
  INITIAL_BOOTSTRAP: 0,
  INITIAL_STATUS_V3: 1,
  FULL:              2,
  RECENT:            3,
  PUSH_NAME:         4,
  NON_BLOCKING_DATA: 5,
  ON_DEMAND:         6,
  // The server says these two outright rather than sending a payload, so a
  // chunk of either kind has nothing to download and is not an error.
  NO_HISTORY:            7,
  MESSAGE_ACCESS_STATUS: 8
};

// Sync types that never carry a blob. Asking for one is the server telling us
// there is nothing to fetch, not a chunk we failed to read.
const PAYLOADLESS_SYNC_TYPES = new Set([7, 8]);

const HistorySyncTypeName = Object.fromEntries(
  Object.entries(HistorySyncType).map(([k, v]) => [v, k])
);

// ─── Mini protobuf helpers (no external deps) ─────────────────────────────────

function _readVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift  += 7;
    if (!(b & 0x80)) break;
  }
  return { value: result, offset };
}

function _decodeFields(buf) {
  const fields = {};
  let offset   = 0;
  while (offset < buf.length) {
    const tr = _readVarint(buf, offset);
    if (!tr || tr.offset === offset) break;
    offset = tr.offset;
    const fieldNum = tr.value >> 3;
    const wireType = tr.value & 0x7;
    if (wireType === 0) {
      const vr = _readVarint(buf, offset);
      fields[fieldNum] = (fields[fieldNum] !== undefined)
        ? [].concat(fields[fieldNum], vr.value)
        : vr.value;
      offset = vr.offset;
    } else if (wireType === 2) {
      const lr = _readVarint(buf, offset);
      offset   = lr.offset;
      const data = buf.slice(offset, offset + lr.value);
      offset  += lr.value;
      if (fields[fieldNum] !== undefined) {
        if (!Array.isArray(fields[fieldNum])) fields[fieldNum] = [fields[fieldNum]];
        fields[fieldNum].push(data);
      } else {
        fields[fieldNum] = data;
      }
    } else if (wireType === 1) {
      fields[fieldNum] = buf.slice(offset, offset + 8);
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
  if (typeof buf === 'string') return buf;
  try { return buf.toString('utf8'); } catch (_) { return ''; }
}

function _uint64(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  return 0;
}

// ─── HistorySyncNotification proto decoder ────────────────────────────────────
//
// HistorySyncNotification {
//   bytes  fileSha256                         = 1;
//   uint64 fileLength                         = 2;
//   bytes  mediaKey                           = 3;
//   bytes  fileEncSha256                      = 4;
//   string directPath                         = 5;
//   HistorySyncType syncType                  = 6;
//   uint32 chunkOrder                         = 7;
//   string originalMessageId                  = 8;
//   uint32 progress                           = 9;
//   bytes  initialHistBootstrapInlinePayload  = 10;
// }

function decodeHistorySyncNotification(buf) {
  if (!buf || !buf.length) return null;
  try {
    const f = _decodeFields(buf);
    return {
      fileSha256:                        f[1]  || null,
      fileLength:                        _uint64(f[2]),
      mediaKey:                          f[3]  || null,
      fileEncSha256:                     f[4]  || null,
      directPath:                        _str(f[5]),
      syncType:                          typeof f[6] === 'number' ? f[6] : 0,
      chunkOrder:                        typeof f[7] === 'number' ? f[7] : 0,
      originalMessageId:                 _str(f[8]),
      progress:                          typeof f[9] === 'number' ? f[9] : 0,
      oldestMsgInChunkTimestampSec:      _uint64(f[10]),
      // Field 11, not 10.
      //
      // Ten is oldestMsgInChunkTimestampSec — a varint — so reading the inline
      // payload from it never produced a Buffer, and the check that guards the
      // inline path (`payload && payload.length > 0`) was therefore never true.
      // Every chunk fell through to the download branch instead.
      //
      // That is fatal for exactly the chunk that matters. WhatsApp sends the
      // initial bootstrap — the one carrying the conversations, and with them
      // every contact's trusted-contact token — with its payload inline and no
      // directPath at all. The download branch has nothing to download, throws
      // 'missing directPath or mediaKey', and the whole history is lost. What
      // survived was the chunks that do have a directPath, which are the ones
      // with no conversations in them.
      initialHistBootstrapInlinePayload: Buffer.isBuffer(f[11]) ? f[11] : null,
      peerDataRequestSessionId:          _str(f[12]),
      encHandle:                         _str(f[14])
    };
  } catch (e) {
    return null;
  }
}

// ─── AppStateSyncKeyShare decoder ─────────────────────────────────────────────
//
// AppStateSyncKeyShare  { repeated AppStateSyncKeyData keys=1 }
// AppStateSyncKeyData   { AppStateSyncKeyId keyId=1; AppStateSyncKey data=2 }
// AppStateSyncKeyId     { bytes keyId=1 }
// AppStateSyncKey       { bytes keyData=1; bytes fingerprint=2; int64 timestamp=3 }

function decodeAppStateSyncKeyShare(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f    = _decodeFields(buf);
    const keys = [];
    if (f[1]) {
      const kBufs = Array.isArray(f[1]) ? f[1] : [f[1]];
      for (const kb of kBufs) {
        if (!Buffer.isBuffer(kb)) continue;
        const kf      = _decodeFields(kb);
        const idFields   = kf[1] ? _decodeFields(kf[1]) : null;
        const dataFields = kf[2] ? _decodeFields(kf[2]) : null;
        const keyId  = idFields   ? (idFields[1]   ? Buffer.from(idFields[1]).toString('hex')   : null) : null;
        const keyData = dataFields ? (dataFields[1] ? Buffer.from(dataFields[1])                 : null) : null;
        const ts      = dataFields ? _uint64(dataFields[3]) : 0;
        if (keyId && keyData) keys.push({ keyId, keyData, timestamp: ts });
      }
    }
    return { keys };
  } catch (_) { return null; }
}

// ─── HistorySync proto decoder ────────────────────────────────────────────────

function decodeMessageKey(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f = _decodeFields(buf);
    return {
      remoteJid:   _str(f[1]),
      fromMe:      !!f[2],
      id:          _str(f[3]),
      participant: _str(f[4]) || undefined
    };
  } catch (_) { return null; }
}

function decodeWebMessageInfo(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f = _decodeFields(buf);
    return {
      key:              decodeMessageKey(f[1]),
      messageTimestamp: _uint64(f[3]),
      status:           typeof f[4] === 'number' ? f[4] : 0,
      pushName:         _str(f[5]) || undefined
    };
  } catch (_) { return null; }
}

function decodeHistorySyncMsg(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f = _decodeFields(buf);
    if (!f[1]) return null;
    return decodeWebMessageInfo(f[1]);
  } catch (_) { return null; }
}

//
// Conversation — field numbers verified against WAProto.proto v2.3000.1029496320
//
//   string           id                        = 1
//   HistorySyncMsg[] messages                  = 2
//   string           newJid                    = 3
//   string           oldJid                    = 4
//   uint64           lastMsgTimestamp          = 5
//   uint32           unreadCount               = 6
//   bool             readOnly                  = 7
//   bool             endOfHistoryTransfer      = 8
//   uint32           ephemeralExpiration       = 9   <-- was 17 (WRONG old proto)
//   int64            ephemeralSettingTimestamp = 10
//   EndOfHistoryTransferType                   = 11
//   uint64           conversationTimestamp     = 12
//   string           name                      = 13  <-- was 11 (WRONG old proto)
//   string           pHash                     = 14
//   bool             notSpam                   = 15
//   bool             archived                  = 16
//   DisappearingMode disappearingMode          = 17
//   uint32           unreadMentionCount        = 18
//   bool             markedAsUnread            = 19
//   GroupParticipant participant[]             = 20
//   bytes            tcToken                   = 21  <-- NEW, was missing
//   uint64           tcTokenTimestamp          = 22  <-- NEW, was missing
//   bytes            contactPrimaryIdentityKey = 23
//   uint32           pinned                    = 24
//   uint64           muteEndTime               = 25
//   WallpaperSettings wallpaper               = 26
//   MediaVisibility  mediaVisibility          = 27
//   uint64           tcTokenSenderTimestamp    = 28  <-- NEW (was wrongly used as 'username')
//   bool             suspended                 = 29
//   bool             terminated               = 30
//   uint64           createdAt                = 31
//   string           createdBy               = 32
//   string           description              = 33
//   bool             support                  = 34
//   bool             isParentGroup            = 35
//   bool             isDefaultSubgroup        = 36
//   string           parentGroupId            = 37
//   string           displayName              = 38  <-- was 12 (WRONG old proto)
//   string           pnJid                    = 39  <-- was 18 (WRONG old proto)
//   bool             shareOwnPn               = 40
//   bool             pnhDuplicateLidThread    = 41
//   string           lidJid                   = 42  <-- was 19/24 (WRONG old proto)
//   string           username                 = 43  <-- was 28 (WRONG — collided with tcTokenSenderTimestamp!)
//   string           lidOriginType            = 44
//
function decodeConversation(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f = _decodeFields(buf);
    const messages = [];
    if (f[2]) {
      const msgBufs = Array.isArray(f[2]) ? f[2] : [f[2]];
      for (const mb of msgBufs) {
        if (Buffer.isBuffer(mb)) {
          const m = decodeHistorySyncMsg(mb);
          if (m) messages.push(m);
        }
      }
    }
    return {
      id:               _str(f[1]),
      messages,
      newJid:           _str(f[3])  || undefined,
      oldJid:           _str(f[4])  || undefined,
      lastMsgTimestamp: _uint64(f[5]),
      unreadCount:      typeof f[6]  === 'number' ? f[6]  : 0,

      // Ephemeral: field 9 in v2.3000.x (was 17 in old proto — FIXED)
      ephemeralExpiry:  typeof f[9]  === 'number' ? f[9]  : undefined,

      // Name / display: fields 13 and 38 in v2.3000.x (were 11/12 — FIXED)
      name:             _str(f[13]) || undefined,
      displayName:      _str(f[38]) || undefined,

      // tcToken fields — all three were completely missing before (ADDED)
      // field 21: raw trusted-contact token bytes (Buffer), attached to <tctoken> node on send
      // field 22: server-assigned timestamp for the token (used for expiry check)
      // field 28: sender-side timestamp (used by shouldSendNewTcToken bucket check)
      tcToken:               Buffer.isBuffer(f[21]) && f[21].length ? f[21] : undefined,
      tcTokenTimestamp:      f[22] != null ? _uint64(f[22]) : undefined,
      tcTokenSenderTimestamp: f[28] != null ? _uint64(f[28]) : undefined,

      // Identity key for the contact's primary device (field 23)
      contactPrimaryIdentityKey: Buffer.isBuffer(f[23]) && f[23].length ? f[23] : undefined,

      // pnJid / lidJid / username: fields 39/42/43 in v2.3000.x (were 18/19/28 — FIXED)
      // NOTE: field 28 was previously read as 'username' — that was wrong AND collided
      // with tcTokenSenderTimestamp above. username is correctly at field 43.
      pnJid:    _str(f[39]) || undefined,
      lidJid:   _str(f[42]) || undefined,
      username: _str(f[43]) || undefined,

      // Extra useful flags
      archived:   !!f[16],
      pinned:     typeof f[24] === 'number' ? f[24] : undefined,
      suspended:  !!f[29],
      terminated: !!f[30],
    };
  } catch (_) { return null; }
}

function decodePushName(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f = _decodeFields(buf);
    return { id: _str(f[1]), pushname: _str(f[2]) };
  } catch (_) { return null; }
}

function decodeLidPnMapping(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  try {
    const f = _decodeFields(buf);
    return { pnJid: _str(f[1]), lidJid: _str(f[2]) };
  } catch (_) { return null; }
}

//
// HistorySync {
//   HistorySyncType syncType                        = 1
//   repeated Conversation conversations             = 2
//   repeated object statusV3Messages                = 3
//   repeated PushName pushnames                     = 4
//   uint32 progress                                 = 5
//   repeated PhoneNumberToLidMapping lidPnMappings  = 10
// }
//
function decodeHistorySync(buf) {
  if (!buf || !buf.length) return null;
  try {
    const f = _decodeFields(buf);

    // Five is chunkOrder and six is progress — this read five as the progress
    // and never looked at six, so every chunk reported its ordinal as a
    // percentage.
    const syncType   = typeof f[1] === 'number' ? f[1] : 0;
    const chunkOrder = typeof f[5] === 'number' ? f[5] : 0;
    const progress   = typeof f[6] === 'number' ? f[6] : 0;

    const conversations = [];
    if (f[2]) {
      const convBufs = Array.isArray(f[2]) ? f[2] : [f[2]];
      for (const cb of convBufs) {
        if (Buffer.isBuffer(cb)) {
          const c = decodeConversation(cb);
          if (c && c.id) conversations.push(c);
        }
      }
    }

    // Pushnames are field 7. Four is not a field of HistorySync at all, so this
    // read undefined every time and a PUSH_NAME sync — whose entire content is
    // this list — always arrived empty.
    const pushnames = [];
    if (f[7]) {
      const pnBufs = Array.isArray(f[7]) ? f[7] : [f[7]];
      for (const pb of pnBufs) {
        if (Buffer.isBuffer(pb)) {
          const p = decodePushName(pb);
          if (p && p.id) pushnames.push(p);
        }
      }
    }

    // phoneNumberToLidMappings is field 15. Ten is threadDsTimeframeOffset, a
    // uint32, so the loop below was handed a number, found it was not a Buffer
    // and skipped it — the mappings history carries were never read, and every
    // LID had to be learnt again from live traffic.
    const lidPnMappings = [];
    if (f[15]) {
      const mapBufs = Array.isArray(f[15]) ? f[15] : [f[15]];
      for (const mb of mapBufs) {
        if (Buffer.isBuffer(mb)) {
          const m = decodeLidPnMapping(mb);
          if (m && (m.pnJid || m.lidJid)) lidPnMappings.push(m);
        }
      }
    }

    return { syncType, progress, chunkOrder, conversations, pushnames, lidPnMappings };
  } catch (e) {
    return null;
  }
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function deriveHistoryKeys(mediaKeyBuf) {
  const ikm  = Buffer.isBuffer(mediaKeyBuf) ? mediaKeyBuf : Buffer.from(mediaKeyBuf);
  const info = Buffer.from(HISTORY_HKDF_INFO, 'utf8');
  const expanded = hkdfSha256(ikm, Buffer.alloc(0), info, EXPANDED_SIZE);
  return {
    iv:        expanded.slice(0, IV_LEN),
    cipherKey: expanded.slice(IV_LEN, IV_LEN + KEY_LEN),
    macKey:    expanded.slice(IV_LEN + KEY_LEN, IV_LEN + KEY_LEN * 2)
  };
}

function decryptHistoryBlob(encryptedWithMac, mediaKeyBuf) {
  const { iv, cipherKey, macKey } = deriveHistoryKeys(mediaKeyBuf);
  const ciphertext = encryptedWithMac.slice(0, -MAC_LEN);
  const mac        = encryptedWithMac.slice(-MAC_LEN);

  const expectedMac = crypto.createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .slice(0, MAC_LEN);

  if (!crypto.timingSafeEqual(mac, expectedMac)) {
    throw new Error('History blob MAC verification failed — wrong key or corrupted data');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Network helpers ──────────────────────────────────────────────────────────

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const driver = parsed.protocol === 'https:' ? https : http;
    const chunks = [];

    // History only ever reaches a companion device, and the CDN treats a
    // companion as a browser: it wants an Origin, and a mobile WhatsApp
    // User-Agent against a web-issued blob is a mismatch it can refuse.
    const req = driver.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin':     'https://web.whatsapp.com',
        'Accept':     '*/*'
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers['location'];
        res.resume();
        if (location) return resolve(downloadUrl(location));
        return reject(new Error('Redirect with no Location header'));
      }
      if (res.statusCode !== 200) {
        reject(new Error('History CDN download failed: HTTP ' + res.statusCode));
        res.resume();
        return;
      }
      res.on('data',  c  => chunks.push(c));
      res.on('end',   () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('History CDN download timed out')));
  });
}

function inflateBuffer(buf) {
  return new Promise((resolve, reject) => {
    zlib.inflate(buf, (err, result) => {
      if (!err) return resolve(result);
      zlib.inflateRaw(buf, (err2, result2) => {
        if (!err2) return resolve(result2);
        reject(new Error('zlib inflate failed: ' + err.message));
      });
    });
  });
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) { return null; }
}

function _writeJsonSafe(filePath, data) {
  try {
    _ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Persist app-state sync keys to {phone}.appStateKeys.json
 */
function saveAppStateSyncKeys(sessionDir, phone, keyShare) {
  if (!keyShare || !keyShare.keys || !keyShare.keys.length) return;
  const file     = path.join(sessionDir, phone + '.appStateKeys.json');
  const existing = _readJsonSafe(file) || {};
  for (const k of keyShare.keys) {
    if (k.keyId && k.keyData) {
      existing[k.keyId] = {
        keyData:   Buffer.from(k.keyData).toString('base64'),
        timestamp: k.timestamp || 0
      };
    }
  }
  _writeJsonSafe(file, existing);
}

/**
 * Load all persisted app-state sync keys.
 * Returns { [keyIdHex]: { keyData: Buffer, timestamp: number } }
 */
function loadAppStateSyncKeys(sessionDir, phone) {
  const file = path.join(sessionDir, phone + '.appStateKeys.json');
  const raw  = _readJsonSafe(file) || {};
  const out  = {};
  for (const [id, v] of Object.entries(raw)) {
    out[id] = {
      keyData:   Buffer.from(v.keyData, 'base64'),
      timestamp: v.timestamp || 0
    };
  }
  return out;
}

/**
 * Merge HistorySync data into on-disk files.
 *
 * {phone}.history.json schema:
 * {
 *   phone, syncTime,
 *   chats:     { [jid]: { id, name, displayName, unreadCount, lastMsgTimestamp, messageCount,
 *                          tcToken, tcTokenTimestamp, tcTokenSenderTimestamp } }
 *   contacts:  { [jid]: { id, name, displayName, username, pnJid, lidJid } }
 *   pushNames: { [jid]: string }
 *   lidPnMap:  { [lid]: pn }
 *   pnLidMap:  { [pn]: lid }
 * }
 *
 * {phone}.messages.json schema:
 * {
 *   [msgId]: { id, chatId, fromMe, fromJid, timestamp, pushName, status }
 * }
 *
 * NOTE: tcToken is stored as base64 string so it survives JSON serialization.
 * TcTokenStore reads it back as Buffer — see _seedTcTokensFromHistory() in Client.js.
 */
function mergeHistoryToStore(sessionDir, phone, syncData) {
  const histFile = path.join(sessionDir, phone + '.history.json');
  const msgFile  = path.join(sessionDir, phone + '.messages.json');

  const hist = _readJsonSafe(histFile) || {
    phone,
    syncTime:  null,
    chats:     {},
    contacts:  {},
    pushNames: {},
    lidPnMap:  {},
    pnLidMap:  {}
  };

  const msgs = _readJsonSafe(msgFile) || {};

  // Push names
  for (const pn of (syncData.pushnames || [])) {
    if (pn.id && pn.pushname) hist.pushNames[pn.id] = pn.pushname;
  }

  // LID ↔ PN mappings
  for (const m of (syncData.lidPnMappings || [])) {
    if (m.lidJid && m.pnJid) {
      hist.lidPnMap[m.lidJid] = m.pnJid;
      hist.pnLidMap[m.pnJid]  = m.lidJid;
    }
  }

  // Conversations
  for (const conv of (syncData.conversations || [])) {
    if (!conv.id) continue;
    const jid = conv.id;

    // Upsert contact
    if (!hist.contacts[jid]) hist.contacts[jid] = { id: jid };
    const ct = hist.contacts[jid];
    if (conv.name)        ct.name        = conv.name;
    if (conv.displayName) ct.displayName = conv.displayName;
    if (conv.username)    ct.username    = conv.username;
    if (conv.pnJid)       ct.pnJid       = conv.pnJid;
    if (conv.lidJid)      ct.lidJid      = conv.lidJid;

    // Cross-populate LID ↔ PN from conversation
    if (conv.pnJid && conv.lidJid) {
      hist.lidPnMap[conv.lidJid] = conv.pnJid;
      hist.pnLidMap[conv.pnJid]  = conv.lidJid;
    }

    // Upsert chat
    if (!hist.chats[jid]) hist.chats[jid] = { id: jid, messageCount: 0 };
    const chat = hist.chats[jid];
    if (conv.name)             chat.name             = conv.name;
    if (conv.displayName)      chat.displayName      = conv.displayName;
    if (conv.lastMsgTimestamp) chat.lastMsgTimestamp = conv.lastMsgTimestamp;
    if (conv.unreadCount)      chat.unreadCount      = conv.unreadCount;
    if (conv.ephemeralExpiry)  chat.ephemeralExpiry  = conv.ephemeralExpiry;

    // Persist tcToken from history so Client._seedTcTokensFromHistory() can
    // populate TcTokenStore on connect — prevents error 463 on first send
    // to contacts that already have an established conversation.
    // Stored as base64 to survive JSON round-trip; TcTokenStore converts back to Buffer.
    if (conv.tcToken) {
      chat.tcToken               = conv.tcToken.toString('base64');
      chat.tcTokenTimestamp      = conv.tcTokenTimestamp      || 0;
      chat.tcTokenSenderTimestamp = conv.tcTokenSenderTimestamp || 0;
    }

    // Messages
    for (const msgInfo of (conv.messages || [])) {
      if (!msgInfo || !msgInfo.key || !msgInfo.key.id) continue;
      const msgId = msgInfo.key.id;
      if (msgs[msgId]) continue;
      msgs[msgId] = {
        id:        msgId,
        chatId:    jid,
        fromMe:    !!msgInfo.key.fromMe,
        fromJid:   msgInfo.key.fromMe
          ? (phone + '@s.whatsapp.net')
          : (msgInfo.key.participant || jid),
        timestamp: msgInfo.messageTimestamp,
        pushName:  msgInfo.pushName || undefined,
        status:    msgInfo.status   || 0
      };
      chat.messageCount = (chat.messageCount || 0) + 1;
    }
  }

  hist.syncTime = new Date().toISOString();

  _writeJsonSafe(histFile, hist);
  _writeJsonSafe(msgFile,  msgs);

  return hist;
}

// ─── Main processing entry point ──────────────────────────────────────────────

/**
 * processHistorySyncNotification — download/decrypt/parse/save one history chunk.
 *
 * @param {object} notification   Decoded HistorySyncNotification (from MessageProto decoder)
 * @param {string} sessionDir     whalibmob session directory
 * @param {string} phone          Phone number digits only
 * @returns {Promise<object>}     Result object emitted in 'history_sync' event
 */
async function processHistorySyncNotification(notification, sessionDir, phone) {
  if (!notification) throw new Error('processHistorySyncNotification: missing notification');

  const typeName = HistorySyncTypeName[notification.syncType] || String(notification.syncType);

  let decompressed;

  if (notification.initialHistBootstrapInlinePayload &&
      notification.initialHistBootstrapInlinePayload.length > 0) {
    // Inline payload — no network call needed (zlib-compressed HistorySync proto)
    decompressed = await inflateBuffer(notification.initialHistBootstrapInlinePayload);
  } else if (PAYLOADLESS_SYNC_TYPES.has(notification.syncType)) {
    // NO_HISTORY and MESSAGE_ACCESS_STATUS are statements, not chunks. There is
    // nothing to fetch and nothing went wrong, so answer with an empty result
    // rather than raising an error the caller can only log.
    return {
      syncType: notification.syncType,
      syncTypeName: typeName,
      progress: notification.progress || 0,
      chunkOrder: notification.chunkOrder || 0,
      chats: [], contacts: [], pushNames: [], lidPnMappings: [], merged: null
    };
  } else {
    if (!notification.directPath || !notification.mediaKey) {
      throw new Error('HistorySyncNotification missing directPath or mediaKey' +
        ' (syncType=' + typeName + ')');
    }

    const cdnUrl        = 'https://' + CDN_HOST + notification.directPath;
    const encryptedBlob = await downloadUrl(cdnUrl);

    // Verify fileEncSha256
    if (notification.fileEncSha256 && notification.fileEncSha256.length > 0) {
      const actualSha = crypto.createHash('sha256').update(encryptedBlob).digest();
      if (!actualSha.equals(notification.fileEncSha256)) {
        throw new Error('History blob fileEncSha256 mismatch — data corrupted or wrong key');
      }
    }

    const plaintext = decryptHistoryBlob(encryptedBlob, notification.mediaKey);

    // Verify fileSha256
    if (notification.fileSha256 && notification.fileSha256.length > 0) {
      const actualSha = crypto.createHash('sha256').update(plaintext).digest();
      if (!actualSha.equals(notification.fileSha256)) {
        throw new Error('History blob fileSha256 mismatch after decryption');
      }
    }

    decompressed = await inflateBuffer(plaintext);
  }

  const syncData = decodeHistorySync(decompressed);
  if (!syncData) throw new Error('Failed to decode HistorySync protobuf');

  const merged = mergeHistoryToStore(sessionDir, phone, syncData);

  // Build lightweight summary for the event payload
  const chatSummary = (syncData.conversations || []).map(c => ({
    id:               c.id,
    name:             c.name || c.displayName || undefined,
    unreadCount:      c.unreadCount,
    lastMsgTimestamp: c.lastMsgTimestamp,
    messageCount:     (c.messages || []).length
  }));

  const contactSummary = (syncData.conversations || [])
    .filter(c => c.id)
    .map(c => ({
      id:          c.id,
      name:        c.name || c.displayName || undefined,
      username:    c.username || undefined,
      pnJid:       c.pnJid   || undefined,
      lidJid:      c.lidJid  || undefined
    }));

  return {
    syncType:      notification.syncType,
    syncTypeName:  typeName,
    progress:      notification.progress,
    chunkOrder:    notification.chunkOrder,
    chats:         chatSummary,
    contacts:      contactSummary,
    pushNames:     syncData.pushnames,
    lidPnMappings: syncData.lidPnMappings,
    merged
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  processHistorySyncNotification,
  decodeHistorySyncNotification,
  decodeHistorySync,
  decodeAppStateSyncKeyShare,
  saveAppStateSyncKeys,
  loadAppStateSyncKeys,
  mergeHistoryToStore,
  decryptHistoryBlob,
  deriveHistoryKeys,
  downloadUrl,
  inflateBuffer,
  HistorySyncType,
  HistorySyncTypeName
};
