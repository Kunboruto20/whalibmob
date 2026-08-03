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
//
// Two rules keep that from costing the account everything it knows:
//
//   • Every write goes to a temp file and is renamed into place. Writing over
//     the live path is not one step — it is an open, a truncate and as many
//     writes as the file needs — and anything that reads or writes in the
//     middle of that sees a mixture of two snapshots. That mixture is not
//     valid JSON, and _load() below answers unreadable state with an empty
//     store, so a single interleaved write silently costs the account every
//     session, pre-key, identity and LID mapping it had. rename(2) is atomic:
//     the file is one whole snapshot or the other, never a blend.
//
//   • A write never lands if newer state reached the disk while it was in
//     flight. The async write started by the debounce is not cancellable, and
//     a synchronous flush — detach(), or the exit handlers — can easily
//     overtake it; letting the older snapshot finish last would undo every
//     session written since. _writtenRev records what the file holds, and a
//     write that has been overtaken drops its temp file instead of renaming.
//
// In-memory state is always the newest thing there is, so any write we abandon
// costs nothing: the next one writes what is current.

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

    // Debounce state.  _rev counts mutations so an async write that started
    // before a mutation landed cannot clear _dirty on its behalf.
    this._dirty            = false;
    this._rev              = 0;
    this._saveTimer        = null;
    // The revision the file on disk actually holds.  An async write compares
    // against it before renaming: if a synchronous flush got there first, the
    // write it is holding is stale and must not land.
    this._writtenRev       = 0;
    // One async write at a time.  Two of them running together on one path
    // interleave, and _writeAgain remembers that another one came due while
    // the first was still going so it can be re-run from a fresh snapshot.
    this._writing          = false;
    this._writeAgain       = false;

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
    // Clearing the path is also what tells a write that is still in flight to
    // stand down — it checks the path it started with before renaming. The
    // caller detaches in order to move these files, so leave nothing of ours
    // behind in the directory it is about to rename.
    const stale = this._filePath ? [this._tmpPath(true), this._tmpPath(false)] : [];
    this._filePath   = null;
    this._writeAgain = false;
    for (const f of stale) { try { fs.unlinkSync(f); } catch (_) {} }
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

  // Everything that is persisted, as it goes on disk.
  _snapshot() {
    return JSON.stringify({
      sessions:      this._sessions,
      preKeys:       this._preKeys,
      signedPreKeys: this._signedPreKeys,
      identities:    this._identities,
      lidMappings:   this._lidMappings
    });
  }

  // Where a write assembles the file before it becomes the file. The sync and
  // async writers get separate names so the one can never find the other's
  // half-written temp file under it.
  _tmpPath(sync) {
    return this._filePath + (sync ? '.stmp' : '.atmp');
  }

  // A rename replaces the file, so the one that lands carries the temp file's
  // permissions and not the old file's. This holds Signal private keys, and an
  // operator who tightened its mode would find it loosened again by the next
  // write — so carry whatever the file already had across. null when there is
  // no file yet, which leaves the default the old writes produced.
  _modeOf(file) {
    try { return fs.statSync(file).mode & 0o777; } catch (_) { return null; }
  }

  // Immediate synchronous flush (process exit, and detach())
  _flushSync() {
    if (!this._dirty || !this._filePath) return;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const rev  = this._rev;
    const file = this._filePath;
    const tmp  = this._tmpPath(true);
    try {
      const dir  = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const mode = this._modeOf(file);
      fs.writeFileSync(tmp, this._snapshot(), mode !== null
        ? { encoding: 'utf8', mode } : 'utf8');
      if (mode !== null) fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, file);
      // Take the async writer's temp file away from it.
      //
      // Its "have I been overtaken?" check runs on this thread, but the rename
      // it authorises is carried out on a pool thread afterwards — and at exit
      // the pool is usually busy, so that rename can still be queued now and
      // execute during teardown, putting this snapshot back to an older one.
      // Its callback never runs there, so nothing would notice or repair it.
      // Removing the source makes that queued rename fail ENOENT instead.
      // detach() does the same thing, which is why detach() was never exposed
      // to this; the exit path simply was not doing it.
      try { fs.unlinkSync(this._tmpPath(false)); } catch (_) {}
      // Nothing ran between the snapshot and the rename — this is synchronous —
      // so the file now holds exactly this revision and there is nothing left
      // to write.
      this._writtenRev = rev;
      this._dirty      = false;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  // Schedule an async (non-blocking) write after DEBOUNCE_MS inactivity.
  // Called on every in-memory mutation — replaces the old synchronous _save().
  _save() {
    this._dirty = true;
    this._rev++;
    if (!this._filePath) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeAsync();
    }, DEBOUNCE_MS);
  }

  // The debounced write itself: temp file, then rename into place, and only if
  // nothing newer reached the disk in the meantime.
  _writeAsync() {
    if (!this._filePath || !this._dirty) return;
    // Fold a write that comes due mid-write into the one already running
    // rather than starting a second one over the same temp file.
    if (this._writing) { this._writeAgain = true; return; }

    // The revision this write is a snapshot of, and the path it is for. Both
    // are read once, here: by the time the callbacks run either may have moved
    // on, and that is exactly what they have to notice.
    const rev  = this._rev;
    const file = this._filePath;
    const tmp  = this._tmpPath(false);

    let data, mode;
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

    // Create the temp file already tight rather than widening the window in
    // which a store full of private keys sits at the umask default.
    fs.writeFile(tmp, data, mode !== null ? { encoding: 'utf8', mode } : 'utf8', (err) => {
      if (err) return abandon();
      // detach() let the file go, or a synchronous flush wrote newer state
      // while this one was running. Renaming now would put an older snapshot
      // back and take every session written since with it.
      if (file !== this._filePath || rev <= this._writtenRev) return abandon();
      if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch (_) {} }
      fs.rename(tmp, file, (renameErr) => {
        if (renameErr) return abandon();
        // Never walk it backwards: a synchronous flush can land — and record a
        // higher revision — between the check above and this callback.
        if (rev > this._writtenRev) this._writtenRev = rev;
        // Only clear the flag when nothing changed while the write was
        // running. A mutation that arrived after the snapshot is not in
        // `data`, and clearing here would make the exit-time _flushSync()
        // skip it and lose it.
        if (this._rev === rev) this._dirty = false;
        finish();
      });
    });
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
  // The fix is to validate the record itself on every check rather than
  // trusting that a cached entry still holds an open session.
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
