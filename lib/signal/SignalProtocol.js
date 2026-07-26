'use strict';

const crypto    = require('crypto');
const libsignal = require('./libsignal');
const { SignalStore }   = require('./SignalStore');
const { SenderKeyStore } = require('./SenderKey');
const { GroupCipher, GroupSessionBuilder, SenderKeyRecord, SenderKeyName, SenderKeyDistributionMessage } = require('./WaSignalGroup/index');

const { SessionCipher, SessionBuilder, ProtocolAddress, keyhelper } = libsignal;

const PRE_KEY_COUNT   = 800;
const PRE_KEY_MIN     = 50;
const PRE_KEY_START   = 1;

// ─── Per-JID async mutex ────────────
// Prevents race conditions when two messages are encrypted simultaneously
// for the same Signal session (e.g. rapid sends or parallel fanout calls).

const _mutexQueues = new Map();

async function _withMutex(key, fn) {
  // If no queue exists for this key, run immediately
  if (!_mutexQueues.has(key)) {
    _mutexQueues.set(key, Promise.resolve());
  }
  const prev = _mutexQueues.get(key);
  let releasePrev;
  const next = new Promise(r => { releasePrev = r; });
  _mutexQueues.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    releasePrev();
    // Cleanup: if no more waiters, remove from map
    if (_mutexQueues.get(key) === next) _mutexQueues.delete(key);
  }
}

// ─── WaSignalGroup storage adapter ──────────────────────────────────────────
// Bridges SenderKeyStore (file-backed) to the async loadSenderKey/storeSenderKey
// interface expected by GroupCipher and GroupSessionBuilder.

class WaSignalGroupStorage {
  constructor(senderKeyStore) {
    this._store = senderKeyStore;
  }

  async loadSenderKey(senderKeyName) {
    const key = typeof senderKeyName === 'string' ? senderKeyName : senderKeyName.toString();
    const raw = this._store.loadRecord(key);
    if (raw) {
      try {
        return SenderKeyRecord.deserialize(raw);
      } catch (_) {}
    }
    return new SenderKeyRecord();
  }

  async storeSenderKey(senderKeyName, record) {
    const key = typeof senderKeyName === 'string' ? senderKeyName : senderKeyName.toString();
    const serialized = Buffer.from(JSON.stringify(record.serialize()), 'utf-8');
    this._store.saveRecord(key, serialized);
  }
}

const BLOCK_SIZE = 16;

function pad(plaintext) {
  const buf = Buffer.from(plaintext);
  const paddingLength = BLOCK_SIZE - (buf.length % BLOCK_SIZE);
  const padded = Buffer.alloc(buf.length + paddingLength);
  buf.copy(padded);
  padded.fill(paddingLength, buf.length);
  return padded;
}

// Signal padding: last byte = pad length, strip it unconditionally
function unpad(data) {
  if (!data || data.length === 0) return data;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const padLen = buf[buf.length - 1];
  if (padLen === 0 || padLen > buf.length) return buf;
  return buf.slice(0, buf.length - padLen);
}

// ─── SignalProtocol ───────────────────────────────────────────────────────────

class SignalProtocol {
  constructor(store) {
    this.store              = store;
    this.senderKeyStore     = new SenderKeyStore();
    this._wsgStorage        = new WaSignalGroupStorage(this.senderKeyStore);
  }

  static fromStore(waStore, signalFilePath, skFilePath) {
    const store = new SignalStore();
    store.init(
      {
        pubKey:  Buffer.from(waStore.identityKeyPair.public),
        privKey: Buffer.from(waStore.identityKeyPair.private)
      },
      waStore.registrationId
    );
    if (signalFilePath) store.attachFile(signalFilePath);

    const proto = new SignalProtocol(store);
    if (skFilePath) proto.senderKeyStore.attachFile(skFilePath);
    proto._wsgStorage = new WaSignalGroupStorage(proto.senderKeyStore);

    proto._ensureSignedPreKey(waStore);
    proto._ensurePreKeys();
    return proto;
  }

  _ensureSignedPreKey(waStore) {
    const spk = waStore.signedPreKey;
    const id  = spk.id;
    this.store.storeSignedPreKey(id, {
      pubKey:  Buffer.from(spk.public),
      privKey: Buffer.from(spk.private)
    });
    this.signedPreKey = {
      keyId:     id,
      keyPair:   { pubKey: Buffer.from(spk.public), privKey: Buffer.from(spk.private) },
      signature: Buffer.from(spk.signature)
    };
  }

  _ensurePreKeys() {
    if (this.store.preKeyCount() >= PRE_KEY_MIN) return;
    this.replenishPreKeys();
  }

  replenishPreKeys() {
    const have    = this.store.preKeyCount();
    const need    = PRE_KEY_COUNT - have;
    if (need <= 0) return [];
    const startId = this.store.nextPreKeyId();
    const newKeys = [];
    for (let i = 0; i < need; i++) {
      const kp = keyhelper.generatePreKey(startId + i);
      this.store.storePreKey(kp.keyId, kp.keyPair);
      newKeys.push({ keyId: kp.keyId, pubKey: kp.keyPair.pubKey });
    }
    return newKeys;
  }

  preKeyCount() {
    return this.store.preKeyCount();
  }

  getPreKeysForUpload(max) {
    max = max || PRE_KEY_COUNT;
    const preKeys = [];
    const ids = Object.keys(this.store._preKeys).map(Number);
    for (const id of ids.slice(0, max)) {
      const raw = this.store._preKeys[String(id)];
      preKeys.push({
        keyId: id,
        pubKey: Buffer.from(raw.pubKey, 'base64')
      });
    }
    return preKeys;
  }

  getSignedPreKeyForUpload() {
    return this.signedPreKey;
  }

  getIdentityKey() {
    return this.store._identityKeyPair.pubKey;
  }

  // ─── Session management ───────────────────────────────────────────────────

  async hasSession(jid) {
    const addr = jidToAddress(jid);
    return this.store.hasSession(addr.toString());
  }

  async deleteSession(jid) {
    const addr = jidToAddress(jid);
    await this.store.deleteSession(addr.toString());
  }

  async buildSessionFromBundle(jid, bundle) {
    const addr    = jidToAddress(jid);
    const builder = new SessionBuilder(this.store, addr);
    await builder.initOutgoing({
      registrationId: bundle.registrationId,
      identityKey:    bundle.identityKey,
      signedPreKey:   {
        keyId:     bundle.signedPreKey.keyId,
        publicKey: bundle.signedPreKey.publicKey,
        signature: bundle.signedPreKey.signature
      },
      preKey: bundle.preKey ? {
        keyId:     bundle.preKey.keyId,
        publicKey: bundle.preKey.publicKey
      } : undefined
    });
  }

  async buildSessionsFromBundles(bundleMap) {
    const results = {};
    for (const [jid, bundle] of bundleMap) {
      try {
        await this.buildSessionFromBundle(jid, bundle);
        results[jid] = 'ok';
      } catch (err) {
        results[jid] = 'error:' + err.message;
      }
    }
    return results;
  }

  // ─── 1-to-1 encrypt / decrypt ─────────────────────────────────────────────

  async encrypt(jid, plaintext) {
    // Mutex per JID — prevents Signal session race conditions
    return _withMutex(jid, async () => {
      const addr   = jidToAddress(jid);
      const cipher = new SessionCipher(this.store, addr);
      const padded = pad(Buffer.from(plaintext));
      const result = await cipher.encrypt(padded);
      return {
        type:       result.type === 3 ? 'pkmsg' : 'msg',
        ciphertext: Buffer.from(result.body, 'binary')
      };
    });
  }

  async decrypt(jid, type, ciphertext) {
    const addr   = jidToAddress(jid);
    const cipher = new SessionCipher(this.store, addr);
    let plaintext;
    if (type === 'pkmsg') {
      plaintext = await cipher.decryptPreKeyWhisperMessage(ciphertext);
    } else {
      plaintext = await cipher.decryptWhisperMessage(ciphertext);
    }
    return unpad(Buffer.from(plaintext));
  }

  // ─── Bulk encrypt for multiple devices (MD fanout) ─────────────────────────
  // All devices encrypted in parallel.
  // Each JID is protected by its own mutex so parallel calls on the
  // same JID are still serialized — no Signal session corruption possible.
  // Returns [{jid, type, ciphertext}]
  async bulkEncryptForDevices(jids, plaintext) {
    const { encrypted } = await this.bulkEncryptForDevicesDetailed(jids, plaintext);
    return encrypted;
  }

  // Same fanout, but also reports the devices that could NOT be encrypted.
  //
  // A dropped device is not a cosmetic loss: every device handed in here becomes
  // a <to><enc> entry in the outgoing stanza, and a stanza whose participants do
  // not cover the recipient's current device list is rejected by the server with
  // ack 479. The caller needs to know which addresses failed so it can rebuild
  // their sessions and fill the gap before the stanza goes out.
  async bulkEncryptForDevicesDetailed(jids, plaintext) {
    const settled = await Promise.allSettled(
      jids.map(jid => this.encrypt(jid, plaintext).then(enc => ({ jid, type: enc.type, ciphertext: enc.ciphertext })))
    );
    const encrypted = [];
    const failed    = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        encrypted.push(r.value);
      } else {
        failed.push({ jid: jids[i], reason: (r.reason && r.reason.message) || String(r.reason) });
      }
    });
    return { encrypted, failed };
  }

  // ─── SenderKey group encrypt / decrypt ────────────────────────────────────
  //
  // Uses WaSignalGroup GroupCipher/GroupSessionBuilder (Baileys-compatible).
  // SenderKeyName format: groupId::senderId::0 (device 0 for group identity).

  _senderKeyName(groupId, senderId) {
    // Strip device suffix (e.g. "1234567890:2@lid" → "1234567890")
    const user = typeof senderId === 'string'
      ? senderId.split('@')[0].split(':')[0]
      : String(senderId);
    return new SenderKeyName(groupId, { id: user, deviceId: 0 });
  }

  async senderKeyEncrypt(groupId, senderId, plaintext) {
    const senderName = this._senderKeyName(groupId, senderId);
    const cipher = new GroupCipher(this._wsgStorage, senderName);
    const padded = pad(Buffer.from(plaintext));
    return cipher.encrypt(padded);
  }

  async senderKeyDecrypt(groupId, senderId, ciphertext) {
    const senderName = this._senderKeyName(groupId, senderId);
    const cipher = new GroupCipher(this._wsgStorage, senderName);
    const raw = await cipher.decrypt(Buffer.from(ciphertext));
    return unpad(Buffer.from(raw));
  }

  async buildSKDM(groupId, senderId) {
    const senderName = this._senderKeyName(groupId, senderId);
    const builder = new GroupSessionBuilder(this._wsgStorage);
    const skdm = await builder.create(senderName);
    return skdm.serialize();
  }

  async processSKDM(groupId, senderId, skdmBytes) {
    const senderName = this._senderKeyName(groupId, senderId);
    const builder = new GroupSessionBuilder(this._wsgStorage);
    const skdmMsg = new SenderKeyDistributionMessage(null, null, null, null, Buffer.from(skdmBytes));
    await builder.process(senderName, skdmMsg);
  }

  async hasSenderKey(groupId, senderId) {
    const senderName = this._senderKeyName(groupId, senderId);
    const record = await this._wsgStorage.loadSenderKey(senderName);
    return !record.isEmpty();
  }
}

// ─── jidToAddress ─────────────────────────────────────────────────────────────

function jidToAddress(jid) {
  let user, deviceId = 0;
  if (typeof jid === 'string') {
    const atIdx = jid.indexOf('@');
    user = atIdx >= 0 ? jid.slice(0, atIdx) : jid;
    const colonIdx = user.indexOf(':');
    if (colonIdx >= 0) {
      deviceId = parseInt(user.slice(colonIdx + 1), 10) || 0;
      user     = user.slice(0, colonIdx);
    }
  } else if (jid && jid.user) {
    user     = jid.user;
    deviceId = jid.device || 0;
    // A @lid JID is encoded as JID_PAIR with the device kept inside the user
    // part ("112713111982325:49"), so an object can carry its device there
    // rather than in .device. Without this the address came out as device 0.
    const colonIdx = String(user).indexOf(':');
    if (colonIdx >= 0) {
      if (!deviceId) deviceId = parseInt(String(user).slice(colonIdx + 1), 10) || 0;
      user = String(user).slice(0, colonIdx);
    }
  } else {
    user = String(jid);
  }
  return new ProtocolAddress(user, deviceId);
}

module.exports = { SignalProtocol, jidToAddress, pad, unpad };
