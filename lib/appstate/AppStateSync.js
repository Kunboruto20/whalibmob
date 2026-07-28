'use strict';

const crypto     = require('crypto');
const { hkdf }   = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha256');
const { makeGenerator, newState } = require('./LTHash');
const S = require('./SyncdProto');

// The five keys every app-state mutation is worked with, expanded from the one
// key the primary device shares over an encrypted message.
//
//   indexKey            HMACs the index, so the same index always MACs the same
//   valueEncryptionKey  AES-256-CBC over the mutation body
//   valueMacKey         authenticates that body
//   snapshotMacKey      authenticates the state as a whole at a version
//   patchMacKey         authenticates one patch against that state
const KEY_EXPANSION_INFO = 'WhatsApp Mutation Keys';
const KEY_EXPANSION_LEN  = 160;

function mutationKeys(keyData) {
  const ikm = Buffer.isBuffer(keyData) ? keyData : Buffer.from(keyData);
  const e   = Buffer.from(hkdf(sha256, ikm, Buffer.alloc(0),
    Buffer.from(KEY_EXPANSION_INFO, 'utf8'), KEY_EXPANSION_LEN));
  return {
    indexKey:           e.subarray(0, 32),
    valueEncryptionKey: e.subarray(32, 64),
    valueMacKey:        e.subarray(64, 96),
    snapshotMacKey:     e.subarray(96, 128),
    patchMacKey:        e.subarray(128, 160)
  };
}

function hmac(data, key, alg) {
  return crypto.createHmac(alg || 'sha256', key).update(data).digest();
}

// The value MAC covers the operation, the key it was encrypted under, the
// ciphertext, and the length of that prefix. Binding the operation in is what
// stops a SET being replayed as a REMOVE.
function valueMac(operation, encContent, keyId, key) {
  const id     = Buffer.isBuffer(keyId) ? keyId : Buffer.from(keyId, 'base64');
  const prefix = Buffer.concat([Buffer.from([operation === S.REMOVE ? 0x02 : 0x01]), id]);
  const last   = Buffer.alloc(8);
  last[7]      = prefix.length;
  return hmac(Buffer.concat([prefix, encContent, last]), key, 'sha512').subarray(0, 32);
}

// Version numbers go into the MACs as 8 bytes, big-endian.
function versionBytes(version) {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(version >>> 0, 4);
  return b;
}

function snapshotMac(hash, version, name, key) {
  return hmac(Buffer.concat([hash, versionBytes(version), Buffer.from(name, 'utf8')]), key);
}

function patchMac(snapMac, valueMacs, version, name, key) {
  return hmac(Buffer.concat([snapMac, ...valueMacs, versionBytes(version),
    Buffer.from(name, 'utf8')]), key);
}

function aesDecrypt(buf, key) {
  const iv = buf.subarray(0, 16);
  const d  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]);
}

function aesEncrypt(buf, key) {
  const iv = crypto.randomBytes(16);
  const c  = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, c.update(buf), c.final()]);
}

class MissingAppStateKeyError extends Error {
  constructor(keyId) {
    super('app state key "' + keyId + '" has not been shared with this device yet');
    this.name         = 'MissingAppStateKeyError';
    this.isMissingKey = true;
    this.keyId        = keyId;
  }
}

// ─── decoding ────────────────────────────────────────────────────────────────

/**
 * Walk a run of mutations, decrypting each and folding it into the hash.
 *
 * getKey(base64KeyId) → { keyData } | null
 * onMutation({ index, action, operation }) is called for every one that decodes.
 *
 * A record that fails its own MAC or its own decryption is skipped rather than
 * abandoning the run: one corrupt row should not cost the whole collection. A
 * missing key is different — nothing after it can be read either, and the fix
 * is to wait for the key rather than to carry on — so that one is thrown.
 */
function decodeMutations(mutations, state, getKey, onMutation, validateMacs) {
  const gen   = makeGenerator(state);
  const cache = new Map();
  let skipped = 0;

  const keysFor = (keyId) => {
    const b64 = Buffer.from(keyId).toString('base64');
    if (cache.has(b64)) return cache.get(b64);
    const rec = getKey(b64);
    if (!rec || !rec.keyData) throw new MissingAppStateKeyError(b64);
    const k = mutationKeys(rec.keyData);
    cache.set(b64, k);
    return k;
  };

  for (const m of mutations) {
    if (!m || !m.valueBlob || !m.keyId) { skipped++; continue; }
    const keys = keysFor(m.keyId);

    const encContent = m.valueBlob.subarray(0, -32);
    const theirMac   = m.valueBlob.subarray(-32);

    if (validateMacs) {
      const ours = valueMac(m.operation, encContent, m.keyId, keys.valueMacKey);
      if (!ours.equals(theirMac)) { skipped++; continue; }
    }

    let plain;
    try { plain = aesDecrypt(encContent, keys.valueEncryptionKey); }
    catch (_) { skipped++; continue; }

    let data;
    try { data = S.decodeSyncActionData(plain); }
    catch (_) { skipped++; continue; }

    if (validateMacs && m.indexBlob) {
      const ours = hmac(data.index, keys.indexKey);
      if (!ours.equals(m.indexBlob)) { skipped++; continue; }
    }

    let index;
    try { index = JSON.parse(data.index.toString('utf8')); }
    catch (_) { skipped++; continue; }

    onMutation({ index, action: data.value, operation: m.operation });
    gen.mix({
      indexMac: m.indexBlob,
      valueMac: theirMac,
      remove:   m.operation === S.REMOVE
    });
  }

  return Object.assign(gen.finish(), { skipped });
}

/**
 * Decode a snapshot — the whole collection, at one version, from nothing.
 *
 * A snapshot whose MAC does not check out is reported rather than thrown: the
 * usual cause is a record we had to skip above, which leaves our hash short of
 * the server's through no fault of the rest. The caller decides whether partial
 * state is worth keeping.
 */
function decodeSnapshot(name, snapshot, getKey, getMutation, validateMacs) {
  const state = newState();
  state.version = snapshot.version;

  const res = decodeMutations(snapshot.records, state, getKey, getMutation, validateMacs);
  state.hash          = res.hash;
  state.indexValueMap = res.indexValueMap;

  let macOk = true;
  if (validateMacs && snapshot.keyId) {
    const b64 = Buffer.from(snapshot.keyId).toString('base64');
    const rec = getKey(b64);
    if (!rec || !rec.keyData) throw new MissingAppStateKeyError(b64);
    const k = mutationKeys(rec.keyData);
    macOk = snapshotMac(state.hash, state.version, name, k.snapshotMacKey)
      .equals(snapshot.mac || Buffer.alloc(0));
  }

  return { state, macOk, skipped: res.skipped };
}

/**
 * Apply a run of patches on top of a state we already hold.
 *
 * Stops at the first patch whose snapshot MAC does not match: from that point
 * on our state and the server's have diverged, so everything after it would be
 * applied to the wrong base. The caller's answer to that is to ask for a fresh
 * snapshot.
 */
function decodePatches(name, patches, initial, getKey, getMutation, validateMacs) {
  const state = {
    version:       initial.version || 0,
    hash:          Buffer.from(initial.hash),
    indexValueMap: Object.assign({}, initial.indexValueMap || {})
  };

  let macFailed = false;
  let skipped   = 0;

  for (const p of patches) {
    if (p.version != null) state.version = p.version;

    if (validateMacs && p.keyId) {
      const b64 = Buffer.from(p.keyId).toString('base64');
      const rec = getKey(b64);
      if (!rec || !rec.keyData) throw new MissingAppStateKeyError(b64);
      const k    = mutationKeys(rec.keyData);
      const macs = p.mutations.map(m => m.valueBlob.subarray(-32));
      if (!patchMac(p.snapshotMac, macs, state.version, name, k.patchMacKey)
            .equals(p.patchMac || Buffer.alloc(0))) {
        macFailed = true;
        break;
      }
    }

    const res = decodeMutations(p.mutations, state, getKey, getMutation, validateMacs);
    state.hash          = res.hash;
    state.indexValueMap = res.indexValueMap;
    skipped            += res.skipped;

    if (validateMacs && p.keyId) {
      const k = mutationKeys(getKey(Buffer.from(p.keyId).toString('base64')).keyData);
      if (!snapshotMac(state.hash, state.version, name, k.snapshotMacKey)
            .equals(p.snapshotMac || Buffer.alloc(0))) {
        macFailed = true;
        break;
      }
    }
  }

  return { state, macFailed, skipped };
}

// ─── encoding (the write path) ───────────────────────────────────────────────

/**
 * Turn one change into a patch, and advance the state it applies to.
 *
 * The state has to move forward here rather than when the server answers: the
 * patch is signed against the version it produces, so a second change made
 * before the first is acknowledged still has to build on it.
 */
function buildPatch({ name, index, action, apiVersion, operation }, keyId, keyData, state) {
  const keys       = mutationKeys(keyData);
  const encKeyId   = Buffer.isBuffer(keyId) ? keyId : Buffer.from(keyId, 'base64');
  const indexBuf   = Buffer.from(JSON.stringify(index), 'utf8');
  const op         = operation == null ? S.SET : operation;

  const body     = S.encodeSyncActionData({
    index: indexBuf, value: action, apiVersion, timestampMs: Date.now()
  });
  const encValue = aesEncrypt(body, keys.valueEncryptionKey);
  const vMac     = valueMac(op, encValue, encKeyId, keys.valueMacKey);
  const iMac     = hmac(indexBuf, keys.indexKey);

  const next = {
    version:       state.version || 0,
    hash:          Buffer.from(state.hash),
    indexValueMap: Object.assign({}, state.indexValueMap || {})
  };
  const gen = makeGenerator(next);
  gen.mix({ indexMac: iMac, valueMac: vMac, remove: op === S.REMOVE });
  const mixed = gen.finish();
  next.hash          = mixed.hash;
  next.indexValueMap = mixed.indexValueMap;
  next.version      += 1;

  const sMac = snapshotMac(next.hash, next.version, name, keys.snapshotMacKey);

  const patch = S.encodePatch({
    version:     next.version,
    snapshotMac: sMac,
    patchMac:    patchMac(sMac, [vMac], next.version, name, keys.patchMacKey),
    keyId:       encKeyId,
    mutations: [{
      operation: op,
      indexMac:  iMac,
      valueBlob: Buffer.concat([encValue, vMac]),
      keyId:     encKeyId
    }]
  });

  return { patch, state: next };
}

module.exports = {
  mutationKeys, valueMac, snapshotMac, patchMac, versionBytes,
  aesEncrypt, aesDecrypt,
  decodeMutations, decodeSnapshot, decodePatches, buildPatch,
  MissingAppStateKeyError,
  KEY_EXPANSION_INFO
};
