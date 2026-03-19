'use strict';

const crypto    = require('crypto');
const libsignal = require('./libsignal');
const { SignalStore }   = require('./SignalStore');
const { SenderKeyStore, SenderKeyCrypto } = require('./SenderKey');

const { SessionCipher, SessionBuilder, ProtocolAddress, keyhelper } = libsignal;

const PRE_KEY_COUNT   = 100;
const PRE_KEY_MIN     = 10;
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
    this.store          = store;
    this.senderKeyStore = new SenderKeyStore();
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
    const settled = await Promise.allSettled(
      jids.map(jid => this.encrypt(jid, plaintext).then(enc => ({ jid, type: enc.type, ciphertext: enc.ciphertext })))
    );
    return settled
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
  }

  // ─── SenderKey group encrypt / decrypt ────────────────────────────────────
  //
  // Signal Group Cipher requires an extra padding layer around the plaintext
  // (on top of AES-CBC's own PKCS7) to obscure message lengths.  pad() adds
  // this layer before AES, and unpad() strips it after AES decryption.

  senderKeyEncrypt(groupId, senderId, plaintext) {
    let state = this.senderKeyStore.load(groupId, senderId);
    if (!state) {
      state = SenderKeyCrypto.createState();
    }
    const padded     = pad(Buffer.from(plaintext));
    const ciphertext = SenderKeyCrypto.encrypt(padded, state);
    this.senderKeyStore.save(groupId, senderId, state);
    return ciphertext;
  }

  senderKeyDecrypt(groupId, senderId, ciphertext) {
    const state = this.senderKeyStore.load(groupId, senderId);
    if (!state) throw new Error(`No SenderKey state for ${groupId}::${senderId}`);
    const raw = SenderKeyCrypto.decrypt(ciphertext, state);
    this.senderKeyStore.save(groupId, senderId, state);
    return unpad(raw);
  }

  buildSKDM(groupId, senderId) {
    let state = this.senderKeyStore.load(groupId, senderId);
    if (!state) {
      state = SenderKeyCrypto.createState();
      this.senderKeyStore.save(groupId, senderId, state);
    }
    return SenderKeyCrypto.buildSKDM(state);
  }

  processSKDM(groupId, senderId, skdmBytes) {
    const parsed = SenderKeyCrypto.parseSKDM(skdmBytes);
    const state  = {
      keyId:      parsed.keyId,
      iteration:  parsed.iteration,
      chainKey:   parsed.chainKey,
      signingKey: {
        pub:  parsed.signingKey,
        priv: Buffer.alloc(32)   // receive-only: no private key needed
      },
      messageKeys: {}
    };
    this.senderKeyStore.save(groupId, senderId, state);
  }

  hasSenderKey(groupId, senderId) {
    return !!this.senderKeyStore.load(groupId, senderId);
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
  } else {
    user = String(jid);
  }
  return new ProtocolAddress(user, deviceId);
}

module.exports = { SignalProtocol, jidToAddress, pad, unpad };
