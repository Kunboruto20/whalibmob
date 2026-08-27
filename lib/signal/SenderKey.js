'use strict';

const { dbg: _whaDbg } = require('../logger');
const { hkdfSha256 } = require('../hkdf');

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { sha256 } = require('@noble/hashes/sha256');
const { hmac }   = require('@noble/hashes/hmac');
const curveJs    = require('../curve');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hmacSha256(key, data) {
  return Buffer.from(hmac(sha256, key, data));
}

// ─── Protobuf mini-encoder ────────────────────────────────────────────────────

function varint(v) {
  const out = [];
  v = Number(v);
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function fieldUint32(fieldNum, value) {
  return Buffer.concat([varint((fieldNum << 3) | 0), varint(value)]);
}

function fieldBytes(fieldNum, buf) {
  return Buffer.concat([varint((fieldNum << 3) | 2), varint(buf.length), buf]);
}

// ─── SenderKey chain helpers ──────────────────────────────────────────────────
//
// Chain advancement uses HMAC-SHA256 per the Signal Group Cipher spec:
//   messageKey  = HMAC-SHA256(chainKey, 0x01)
//   nextChainKey = HMAC-SHA256(chainKey, 0x02)

function advanceChain(chainKey) {
  const messageKey   = hmacSha256(chainKey, Buffer.from([0x01]));
  const nextChainKey = hmacSha256(chainKey, Buffer.from([0x02]));
  return { messageKey, nextChainKey };
}

// Derive encryption keys from a SenderKey message key.
//
// Signal Group Cipher spec :
//   HKDF(ikm=messageKey, salt=32-zero-bytes, info='WhisperGroup', length=48)
//   iv        = derived[0:16]
//   cipherKey = derived[16:48]
//
// No MAC key — the SenderKeyMessage authenticates via an Ed25519 signature
// over the entire message body, not via HMAC.

function deriveMessageKeys(messageKey) {
  const salt    = Buffer.alloc(32);
  const info    = Buffer.from('WhisperGroup');
  const derived = hkdfSha256(messageKey, salt, info, 48);
  return {
    iv:        derived.slice(0, 16),
    cipherKey: derived.slice(16, 48)
  };
}

// ─── SenderKeyStore ───────────────────────────────────────────────────────────
// Key format: "groupId::senderId"
// State: { keyId, iteration, chainKey(b64), signingKey:{pub,priv}(b64), messageKeys:{iter:b64} }

const _SK_DEBOUNCE_MS = 300;

// Bumped whenever a change means the SenderKey distributions we already sent
// were never usable by their recipients. The stored "who already has our key"
// map is then dropped once on load, so the next send to each group distributes
// again instead of trusting a record of deliveries that never landed.
//
// v2: the distribution was written to Message field 35 (messageContextInfo)
//     instead of field 2, so no recipient ever received a readable one.
const SKDM_DISTRIBUTION_FORMAT = 2;
const SKDM_FORMAT_KEY          = '__skdmFormat__';

class SenderKeyStore {
  constructor() {
    this._data      = {};
    this._filePath  = null;
    // _rev counts mutations so an async write that started before a mutation
    // landed cannot clear _dirty on its behalf.
    this._dirty     = false;
    this._rev       = 0;
    this._saveTimer = null;
    // Same three as in SignalStore, for the same reason. The debounced write
    // here was never cancelled or awaited either, so a synchronous flush could
    // be overtaken by an older one still in flight — and this file is where the
    // group sender keys live, including the record of who has already been sent
    // ours. _writtenRev is what the file holds; _writing keeps the async writes
    // to one at a time; _writeAgain remembers one that came due mid-write.
    this._writtenRev = 0;
    this._writing    = false;
    this._writeAgain = false;

    // Detachable, for the same reason as in SignalStore: a replaced store must
    // not keep three process listeners alive for the rest of the run.
    this._onExit    = () => this._flushSync();
    this._onSigTerm = () => { this._flushSync(); process.exit(0); };
    this._onSigInt  = () => { this._flushSync(); process.exit(0); };
    process.once('exit',    this._onExit);
    process.once('SIGTERM', this._onSigTerm);
    process.once('SIGINT',  this._onSigInt);
  }

  /** Flush, stop writing, and stop holding the process open. */
  detach() {
    this._flushSync();
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      process.removeListener('exit',    this._onExit);
      process.removeListener('SIGTERM', this._onSigTerm);
      process.removeListener('SIGINT',  this._onSigInt);
    } catch (_) {}
    // Clearing the path also tells a write still in flight to stand down — it
    // checks the path it started with before renaming. The caller detaches in
    // order to move these files, so leave nothing of ours in the directory it
    // is about to rename.
    const stale = this._filePath ? [this._tmpPath(true), this._tmpPath(false)] : [];
    this._filePath   = null;
    this._writeAgain = false;
    for (const f of stale) { try { fs.unlinkSync(f); } catch (_) {} }
  }

  attachFile(filePath) {
    this._filePath = filePath;
    if (fs.existsSync(filePath)) {
      try {
        this._data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_) {
        this._data = {};
      }
    }
    this._migrateSKDMDistribution();
  }

  // Drop the "already distributed" bookkeeping once when the format changes.
  // The sender keys themselves are kept — only the record of who has them is
  // reset, so the next send to a group re-distributes to every member.
  _migrateSKDMDistribution() {
    if (this._data[SKDM_FORMAT_KEY] === SKDM_DISTRIBUTION_FORMAT) return;
    let dropped = 0;
    for (const key of Object.keys(this._data)) {
      if (key.startsWith('__skdm__')) {
        delete this._data[key];
        dropped++;
      }
    }
    this._data[SKDM_FORMAT_KEY] = SKDM_DISTRIBUTION_FORMAT;
    this._save();
    if (dropped > 0) {
      _whaDbg('[DBG] SKDM_FORMAT_MIGRATION dropped ' + dropped +
        ' stale distribution maps — every group re-distributes on next send');
    }
  }

  // Everything that is persisted, as it goes on disk.
  _snapshot() {
    return JSON.stringify(this._data, null, 2);
  }

  // Where a write assembles the file before it becomes the file. The sync and
  // async writers get separate names so neither can find the other's
  // half-written temp file under it.
  _tmpPath(sync) {
    return this._filePath + (sync ? '.stmp' : '.atmp');
  }

  // A rename replaces the file, so the one that lands carries the temp file's
  // permissions and not the old file's. This holds group signing keys, and an
  // operator who tightened its mode would find it loosened again by the next
  // write — so carry across whatever the file already had.
  _modeOf(file) {
    try { return fs.statSync(file).mode & 0o777; } catch (_) { return null; }
  }

  _flushSync() {
    if (!this._dirty || !this._filePath) return;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const rev  = this._rev;
    const file = this._filePath;
    const tmp  = this._tmpPath(true);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const mode = this._modeOf(file);
      fs.writeFileSync(tmp, this._snapshot(), mode !== null
        ? { encoding: 'utf8', mode } : 'utf8');
      if (mode !== null) fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, file);
      // Take the async writer's temp file away from it. Its "have I been
      // overtaken?" check runs on this thread, but the rename it authorises is
      // carried out on a pool thread afterwards — and at exit the pool is
      // usually busy, so that rename can still be queued now and execute during
      // teardown, putting this snapshot back to an older one. Its callback
      // never runs there, so nothing would notice. Removing the source makes
      // that queued rename fail ENOENT instead.
      try { fs.unlinkSync(this._tmpPath(false)); } catch (_) {}
      this._writtenRev = rev;
      this._dirty      = false;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  _save() {
    this._dirty = true;
    this._rev++;
    if (!this._filePath) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeAsync();
    }, _SK_DEBOUNCE_MS);
  }

  // The debounced write itself: temp file, then rename into place, and only if
  // nothing newer reached the disk in the meantime.
  _writeAsync() {
    if (!this._filePath || !this._dirty) return;
    // Fold a write that comes due mid-write into the one already running rather
    // than starting a second one over the same temp file.
    if (this._writing) { this._writeAgain = true; return; }

    // Read once, here: by the time the callbacks run either may have moved on,
    // and that is exactly what they have to notice.
    const rev  = this._rev;
    const file = this._filePath;
    const tmp  = this._tmpPath(false);

    let data, mode;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      mode = this._modeOf(file);
      data = this._snapshot();
    } catch (_) { return; }

    this._writing    = true;
    this._writeAgain = false;

    const finish = () => {
      this._writing = false;
      // A write came due while this one was running and was folded into it.
      // Every other mutation armed its own debounce timer, which is still
      // pending and will write what is current.
      if (this._writeAgain && this._dirty && this._filePath) this._writeAsync();
    };
    const abandon = () => { fs.unlink(tmp, () => {}); finish(); };

    // Created already tight rather than widening the window in which a file of
    // signing keys sits at the umask default.
    fs.writeFile(tmp, data, mode !== null ? { encoding: 'utf8', mode } : 'utf8', (err) => {
      if (err) return abandon();
      // detach() let the file go, or a synchronous flush wrote newer state
      // while this one was running. Renaming now would put an older snapshot
      // back and take every sender key written since with it.
      if (file !== this._filePath || rev <= this._writtenRev) return abandon();
      if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch (_) {} }
      fs.rename(tmp, file, (renameErr) => {
        if (renameErr) return abandon();
        // Never walk it backwards: a synchronous flush can land — and record a
        // higher revision — between the check above and this callback.
        if (rev > this._writtenRev) this._writtenRev = rev;
        // Only clear the flag when nothing changed while the write was running.
        // A mutation that arrived after the snapshot is not in `data`, and
        // clearing here would make the exit-time _flushSync() skip it and lose
        // it.
        if (this._rev === rev) this._dirty = false;
        finish();
      });
    });
  }

  _key(groupId, senderId) {
    return `${groupId}::${senderId}`;
  }

  load(groupId, senderId) {
    const raw = this._data[this._key(groupId, senderId)];
    if (!raw) return null;
    return {
      keyId:     raw.keyId,
      iteration: raw.iteration,
      chainKey:  Buffer.from(raw.chainKey, 'base64'),
      signingKey: {
        pub:  Buffer.from(raw.signingKey.pub, 'base64'),
        priv: Buffer.from(raw.signingKey.priv, 'base64')
      },
      messageKeys: Object.fromEntries(
        Object.entries(raw.messageKeys || {}).map(([k, v]) => [k, Buffer.from(v, 'base64')])
      )
    };
  }

  save(groupId, senderId, state) {
    this._data[this._key(groupId, senderId)] = {
      keyId:     state.keyId,
      iteration: state.iteration,
      chainKey:  state.chainKey.toString('base64'),
      signingKey: {
        pub:  state.signingKey.pub.toString('base64'),
        priv: state.signingKey.priv.toString('base64')
      },
      messageKeys: Object.fromEntries(
        Object.entries(state.messageKeys || {}).map(([k, v]) => [k, v.toString('base64')])
      )
    };
    this._save();
  }

  delete(groupId, senderId) {
    delete this._data[this._key(groupId, senderId)];
    this._save();
  }

  // ─── SKDM tracking ───────────────────────────────────────────────────────────
  // Tracks which device JIDs have already received our SenderKey for a group,
  // so we don't re-send SKDM on every subsequent message.

  getSKDMMap(groupId) {
    const key = `__skdm__${groupId}`;
    return Object.assign({}, this._data[key] || {});
  }

  setSKDMMap(groupId, map) {
    const key = `__skdm__${groupId}`;
    this._data[key] = Object.assign({}, map);
    this._save();
  }

  markSKDMSent(groupId, jids) {
    const map = this.getSKDMMap(groupId);
    for (const jid of jids) map[jid] = true;
    this.setSKDMMap(groupId, map);
  }

  // Invalidate the SKDM map for a group, forcing re-distribution on next send.
  // Call this when a new member joins the group.
  invalidateSKDM(groupId) {
    const key = `__skdm__${groupId}`;
    delete this._data[key];
    this._save();
  }

  // Raw access for WaSignalGroup SenderKeyRecord storage (JSON-serialized Buffer format)
  loadRecord(key) {
    const v = this._data['wsg:' + key];
    if (!v) return null;
    return typeof v === 'string' ? Buffer.from(v, 'utf-8') : null;
  }

  saveRecord(key, bufOrStr) {
    this._data['wsg:' + key] = Buffer.isBuffer(bufOrStr) ? bufOrStr.toString('utf-8') : String(bufOrStr);
    this._save();
  }
}

// ─── SenderKey crypto ─────────────────────────────────────────────────────────

class SenderKeyCrypto {

  static createState() {
    const keyId    = crypto.randomBytes(4).readUInt32BE(0) & 0xffff;
    const chainKey = crypto.randomBytes(32);
    const seed     = crypto.randomBytes(32);
    const kp       = curveJs.generateKeyPair(seed);
    return {
      keyId,
      iteration: 0,
      chainKey,
      signingKey: {
        pub:  Buffer.from(kp.public),   // 32 raw bytes (no prefix)
        priv: Buffer.from(kp.private)   // 32 bytes
      },
      messageKeys: {}
    };
  }

  // ─── Chain advancement ──────────────────────────────────────────────────────

  static _getMessageKey(state) {
    const cached = state.messageKeys[state.iteration];
    if (cached) {
      const mk = cached;
      delete state.messageKeys[state.iteration];
      return mk;
    }
    const { messageKey, nextChainKey } = advanceChain(state.chainKey);
    state.chainKey = nextChainKey;
    state.iteration++;
    return messageKey;
  }

  static _getMessageKeyAtIteration(state, iteration) {
    // Return from cache if available
    if (state.messageKeys[iteration]) {
      const mk = state.messageKeys[iteration];
      delete state.messageKeys[iteration];
      return mk;
    }
    const currentIter = state.iteration;
    if (iteration < currentIter) {
      throw new Error('SenderKey: old message key not found for iteration ' + iteration);
    }
    if (iteration - currentIter > 2000) {
      throw new Error('SenderKey: message too far ahead (over 2000 iterations)');
    }
    // Advance chain, caching skipped keys
    let chainKey = state.chainKey;
    for (let i = currentIter; i < iteration; i++) {
      const { messageKey, nextChainKey } = advanceChain(chainKey);
      state.messageKeys[i] = messageKey;
      chainKey = nextChainKey;
    }
    const { messageKey, nextChainKey } = advanceChain(chainKey);
    state.chainKey  = nextChainKey;
    state.iteration = iteration + 1;
    return messageKey;
  }

  // ─── SenderKeyMessage encrypt ───────────────────────────────────────────────
  //
  // Wire format (Signal Group Cipher spec)
  //   byte[0]       version  = 0x33  (high nibble = CURRENT_VERSION=3, low nibble = CURRENT_VERSION=3)
  //   byte[1..N]    protobuf { id: keyId, iteration: iter, ciphertext: aes_cbc_output }
  //   byte[N+1..N+64] Ed25519 signature over byte[0..N] (version + proto)
  //
  // There is NO intermediate HMAC-MAC in the Signal spec for SenderKeyMessage.
  // Authentication is provided solely by the 64-byte Ed25519 signature.

  static encrypt(plaintext, state) {
    const iteration  = state.iteration;
    const messageKey = this._getMessageKey(state);
    const { iv, cipherKey } = deriveMessageKeys(messageKey);

    const cipher    = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const protoBody = Buffer.concat([
      fieldUint32(1, state.keyId),
      fieldUint32(2, iteration),
      fieldBytes(3, encrypted)
    ]);

    const versionByte = Buffer.from([0x33]);
    const forSig      = Buffer.concat([versionByte, protoBody]);
    const sig         = Buffer.from(curveJs.sign(state.signingKey.priv, forSig));

    return Buffer.concat([versionByte, protoBody, sig]);
  }

  // ─── SenderKeyMessage decrypt ───────────────────────────────────────────────
  //
  // Parses: version(1) + proto(N) + signature(64)
  // The signature covers version + proto.

  static decrypt(ciphertext, state) {
    if (!Buffer.isBuffer(ciphertext)) ciphertext = Buffer.from(ciphertext);

    const version = ciphertext[0];
    if ((version & 0xf) !== 3) {
      throw new Error('Unknown SenderKeyMessage version: ' + version);
    }

    const SIG_LEN  = 64;
    const body     = ciphertext.slice(1, ciphertext.length - SIG_LEN);
    const sig      = ciphertext.slice(ciphertext.length - SIG_LEN);

    const { keyId, iteration, encrypted } = parseSKMBody(body);

    // Verify signature over (version_byte || proto_body)
    const forVerify = ciphertext.slice(0, ciphertext.length - SIG_LEN);

    // Resolve sender-key state for this iteration
    const senderKeyState = state;
    const sigPub = senderKeyState.signingKey.pub;

    const ok = curveJs.verify(sigPub, forVerify, sig);
    if (!ok) throw new Error('SenderKeyMessage signature verification failed');

    const messageKey = this._getMessageKeyAtIteration(senderKeyState, iteration);
    const { iv, cipherKey } = deriveMessageKeys(messageKey);

    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  // ─── SenderKeyDistributionMessage ──────────────────────────────────────────
  //
  // Wire format:
  //   byte[0]      version = 0x33
  //   byte[1..N]   protobuf { id, iteration, chainKey, signingKey(33 bytes with 0x05 prefix) }

  static buildSKDM(state) {
    const protoBody = Buffer.concat([
      fieldUint32(1, state.keyId),
      fieldUint32(2, state.iteration),
      fieldBytes(3, state.chainKey),
      fieldBytes(4, Buffer.concat([Buffer.from([0x05]), state.signingKey.pub]))
    ]);
    return Buffer.concat([Buffer.from([0x33]), protoBody]);
  }

  static parseSKDM(raw) {
    if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
    // Accept any version byte in the high nibble ≥ 3
    const body = raw.slice(1);
    return parseSKDMBody(body);
  }
}

// ─── Protobuf parsers ─────────────────────────────────────────────────────────

function readVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value: result >>> 0, offset };
}

function parseProtoFields(buf) {
  const fields = {};
  let offset = 0;
  while (offset < buf.length) {
    const tag   = readVarint(buf, offset); offset = tag.offset;
    const field = tag.value >>> 3;
    const wire  = tag.value & 0x07;
    if (wire === 0) {
      const v = readVarint(buf, offset); offset = v.offset;
      fields[field] = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, offset); offset = len.offset;
      fields[field] = buf.slice(offset, offset + len.value); offset += len.value;
    } else {
      break; // unknown wire type — stop parsing
    }
  }
  return fields;
}

function parseSKMBody(body) {
  const f = parseProtoFields(body);
  return {
    keyId:     f[1] !== undefined ? f[1] : 0,
    iteration: f[2] !== undefined ? f[2] : 0,
    encrypted: f[3] || Buffer.alloc(0)
  };
}

function parseSKDMBody(body) {
  const f      = parseProtoFields(body);
  const sigKey = f[4] || Buffer.alloc(33);
  return {
    keyId:      f[1] !== undefined ? f[1] : 0,
    iteration:  f[2] !== undefined ? f[2] : 0,
    chainKey:   f[3] || Buffer.alloc(32),
    signingKey: sigKey.length === 33 && sigKey[0] === 0x05 ? sigKey.slice(1) : sigKey
  };
}

module.exports = { SenderKeyStore, SenderKeyCrypto };
