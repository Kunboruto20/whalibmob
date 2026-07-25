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

    // Debounce state
    this._dirty            = false;
    this._saveTimer        = null;

    // Flush synchronously on exit so no state is ever lost
    const flush = () => this._flushSync();
    process.once('exit',    flush);
    process.once('SIGTERM', () => { flush(); process.exit(0); });
    process.once('SIGINT',  () => { flush(); process.exit(0); });
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

  hasSession(encodedAddress) {
    return !!this._sessions[encodedAddress];
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
