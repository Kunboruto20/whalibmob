'use strict';

const fs   = require('fs');
const path = require('path');
const { SessionRecord } = require('./libsignal');

// ─── Debounced async writer ────────────────────────────────────────────────────
//
// Signal state is written asynchronously so encryption never blocks the
// event loop waiting for disk I/O.  We implement the same pattern:
//   • mark dirty immediately (in-memory state is always current)
//   • schedule a single async flush after DEBOUNCE_MS of inactivity
//   • if another write arrives before the timer fires, reset the timer
//   • on process exit, flush synchronously (so state is never lost)
//
// Result: zero blocking disk I/O during the encryption hot-path.

const DEBOUNCE_MS = 300;

class SignalStore {
  constructor() {
    this._identityKeyPair  = null;
    this._registrationId   = 0;
    this._sessions         = {};
    this._preKeys          = {};
    this._signedPreKeys    = {};
    this._identities       = {};
    this._filePath         = null;
    this._lidMappings      = {};   // phone → lid — persisted alongside sessions
    // address → { value, open } — memoises the haveOpenSession() check below.
    // Keyed on the stored record value, so storeSession() (which always assigns
    // a freshly serialised object) invalidates the entry by identity.
    this._openSessionMemo  = new Map();

    // Debounce state
    this._dirty            = false;
    this._saveTimer        = null;

    // Flush synchronously on exit so no state is ever lost.
    //
    // Kept as references so they can be taken off again: a store that has been
    // replaced — when a session is re-filed under a different number, say —
    // would otherwise stay reachable from process forever, and every store ever
    // built would add three more listeners.
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
    this._filePath = null;
  }

  init(identityKeyPair, registrationId) {
    this._identityKeyPair = identityKeyPair;
    this._registrationId  = registrationId;
  }

  attachFile(filePath) {
    this._filePath = filePath;
    this._load();
  }

  _load() {
    if (!this._filePath || !fs.existsSync(this._filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      this._sessions      = raw.sessions      || {};
      this._preKeys       = raw.preKeys       || {};
      this._signedPreKeys = raw.signedPreKeys || {};
      this._identities    = raw.identities    || {};
      this._lidMappings   = raw.lidMappings   || {};  // phone → lid, persisted
    } catch (_) {}
  }

  // Persist a phone ↔ LID mapping.  Called any time we learn a new mapping from
  // incoming messages or from a contact usync fallback query.
  setLidMapping(phone, lid) {
    if (!phone || !lid) return;
    if (this._lidMappings[phone] === lid) return; // already stored, skip disk write
    this._lidMappings[phone] = lid;
    this._save();
  }

  // Return all stored phone → lid mappings (used to populate Client._pnToLid on startup)
  getLidMappings() {
    return this._lidMappings;
  }

  // Immediate synchronous flush (used on process exit only)
  _flushSync() {
    if (!this._dirty || !this._filePath) return;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      const data = JSON.stringify({
        sessions:      this._sessions,
        preKeys:       this._preKeys,
        signedPreKeys: this._signedPreKeys,
        identities:    this._identities,
        lidMappings:   this._lidMappings
      });
      const dir = path.dirname(this._filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._filePath, data, 'utf8');
      this._dirty = false;
    } catch (_) {}
  }

  // Schedule an async (non-blocking) write after DEBOUNCE_MS inactivity.
  // Called on every in-memory mutation — replaces the old synchronous _save().
  _save() {
    this._dirty = true;
    if (!this._filePath) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const data = JSON.stringify({
        sessions:      this._sessions,
        preKeys:       this._preKeys,
        signedPreKeys: this._signedPreKeys,
        identities:    this._identities,
        lidMappings:   this._lidMappings
      });
      const dir = path.dirname(this._filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFile(this._filePath, data, 'utf8', () => { this._dirty = false; });
    }, DEBOUNCE_MS);
  }

  // ─── Identity / registration ─────────────────────────────────────────────

  async getOurIdentity() {
    return this._identityKeyPair;
  }

  async getIdentityKeyPair() {
    return this._identityKeyPair;
  }

  async getLocalRegistrationId() {
    return this._registrationId;
  }

  async getOurRegistrationId() {
    return this._registrationId;
  }

  async isTrustedIdentity(identifier, identityKey) {
    const stored = this._identities[identifier];
    if (!stored) return true;
    return stored === identityKey.toString('base64');
  }

  async saveIdentity(identifier, identityKey) {
    const existing = this._identities[identifier];
    const keyStr   = identityKey.toString('base64');
    const changed  = existing !== undefined && existing !== keyStr;
    this._identities[identifier] = keyStr;
    this._save();
    return changed;
  }

  async loadIdentityKey(identifier) {
    const stored = this._identities[identifier];
    if (!stored) return null;
    return Buffer.from(stored, 'base64');
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async loadSession(encodedAddress) {
    const data = this._sessions[encodedAddress];
    if (!data) return undefined;
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    return SessionRecord.deserialize(obj);
  }

  async storeSession(encodedAddress, record) {
    this._sessions[encodedAddress] = record.serialize();
    this._save();
  }

  async deleteSession(encodedAddress) {
    delete this._sessions[encodedAddress];
    this._save();
  }

  // True only when the stored record still has an OPEN session — i.e. one we can
  // actually encrypt with.
  //
  // A SessionRecord can hold sessions that libsignal has closed: session_builder
  // closes the current one whenever it processes an incoming prekey bundle or
  // installs a new outgoing one, and it stays in the record as archived state.
  // The record therefore keeps existing long after it stops being usable.
  //
  // This used to answer `!!this._sessions[addr]`, so DeviceManager treated a
  // closed session as ready, skipped the prekey fetch, and handed the address to
  // SessionCipher.encrypt — which throws "No open session". bulkEncryptForDevices
  // drops whatever it cannot encrypt, so the stanza went out with a <to> entry
  // missing for that device and the server nacked the whole send with ack 479.
  // Baileys hit the same class of bug with its peerSessionsCache and fixed it by
  // validating through haveOpenSession() on every check.
  hasSession(encodedAddress) {
    if (!this._openSessionMemo) this._openSessionMemo = new Map();
    const data = this._sessions[encodedAddress];
    if (!data) {
      this._openSessionMemo.delete(encodedAddress);
      return false;
    }
    const memo = this._openSessionMemo.get(encodedAddress);
    if (memo && memo.value === data) return memo.open;

    let open = false;
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      open = SessionRecord.deserialize(obj).haveOpenSession();
    } catch (_) {
      open = false;
    }
    this._openSessionMemo.set(encodedAddress, { value: data, open });
    return open;
  }

  // ─── PreKeys ──────────────────────────────────────────────────────────────

  async loadPreKey(keyId) {
    const data = this._preKeys[String(keyId)];
    if (!data) return undefined;
    return {
      pubKey:  Buffer.from(data.pubKey,  'base64'),
      privKey: Buffer.from(data.privKey, 'base64')
    };
  }

  async storePreKey(keyId, keyPair) {
    this._preKeys[String(keyId)] = {
      pubKey:  Buffer.from(keyPair.pubKey).toString('base64'),
      privKey: Buffer.from(keyPair.privKey).toString('base64')
    };
    this._save();
  }

  async removePreKey(keyId) {
    delete this._preKeys[String(keyId)];
    this._save();
  }

  // ─── Signed PreKeys ───────────────────────────────────────────────────────

  async loadSignedPreKey(keyId) {
    const data = this._signedPreKeys[String(keyId)];
    if (!data) return undefined;
    return {
      pubKey:  Buffer.from(data.pubKey,  'base64'),
      privKey: Buffer.from(data.privKey, 'base64')
    };
  }

  async storeSignedPreKey(keyId, keyPair) {
    this._signedPreKeys[String(keyId)] = {
      pubKey:  Buffer.from(keyPair.pubKey).toString('base64'),
      privKey: Buffer.from(keyPair.privKey).toString('base64')
    };
    this._save();
  }

  async removeSignedPreKey(keyId) {
    delete this._signedPreKeys[String(keyId)];
    this._save();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  preKeyCount() {
    return Object.keys(this._preKeys).length;
  }

  nextPreKeyId() {
    const ids = Object.keys(this._preKeys).map(Number);
    return ids.length ? Math.max(...ids) + 1 : 1;
  }
}

module.exports = { SignalStore };
