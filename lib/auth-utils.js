'use strict';

// ─── auth-utils.js ────────────────────────────────────────────────────────────
//
// Provides four utilities that mirror Baileys' auth-utils, adapted to
// whalibmob's architecture (method-based SignalStore, Buffer key pairs, etc.):
//
//  1. makeCacheableSignalKeyStore  — wraps SignalStore with NodeCache (5-min TTL)
//                                   and a Mutex for all read/write operations
//  2. addTransactionCapability     — wraps SignalStore with transaction support
//                                   backed by AsyncLocalStorage + per-type Mutex
//  3. assertMeId                   — validates auth credentials, returns JID or throws
//  4. initAuthCreds                — creates a fresh credential set for a phone number
//
// Usage example:
//   const { SignalStore }                       = require('whalibmob');
//   const { makeCacheableSignalKeyStore,
//           addTransactionCapability,
//           assertMeId, initAuthCreds }         = require('whalibmob/lib/auth-utils');
//
//   const rawStore = new SignalStore();
//   // Optionally stack both capabilities:
//   const txStore     = addTransactionCapability(rawStore, logger, { maxCommitRetries: 5, delayBetweenTriesMs: 250 });
//   const cachedStore = makeCacheableSignalKeyStore(txStore, logger);
//
// ─────────────────────────────────────────────────────────────────────────────

const { NodeCache }         = require('@cacheable/node-cache');
const { AsyncLocalStorage } = require('async_hooks');
const { Mutex }             = require('async-mutex');
const crypto                = require('crypto');
const { createNewStore }    = require('./Store');

// ─── Constants ────────────────────────────────────────────────────────────────

/** In-memory TTL for Signal store cache entries (sessions, keys, identities). */
const SIGNAL_STORE_TTL      = '5m';

/** Default max retry count for transaction commits. */
const MAX_COMMIT_RETRIES    = 5;

/** Milliseconds to wait between commit retries. */
const RETRY_DELAY_MS        = 250;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. makeCacheableSignalKeyStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps a whalibmob SignalStore with:
 *   • NodeCache — in-memory cache with a 5-minute TTL for all key types
 *     (sessions, pre-keys, signed pre-keys, identity keys, registration ID).
 *     After 5 minutes each entry is evicted and re-read from disk on the
 *     next access, keeping memory bounded without ever returning stale data.
 *   • Mutex  — every get/set is serialised through a single Mutex, preventing
 *     Signal session race conditions that would produce undecryptable ciphertexts.
 *
 * @param {SignalStore}  store   - underlying SignalStore instance
 * @param {object}       logger  - optional logger with a .trace() method
 * @param {NodeCache}    _cache  - optional pre-built NodeCache (for testing / sharing)
 * @returns {object} drop-in SignalStore replacement with caching and serialisation
 */
function makeCacheableSignalKeyStore(store, logger, _cache) {
  const cache = _cache || new NodeCache({ ttl: SIGNAL_STORE_TTL, useClones: false });
  const mutex = new Mutex();

  /** Unified cache key: "type:id" */
  const cKey = (type, id) => `${type}:${String(id)}`;

  const log = (msg, data) => logger && logger.trace(data, msg);

  return {
    // ── Initialisation / file attachment (pass-through) ──────────────────────

    init(identityKeyPair, registrationId) {
      cache.set('meta:identityKeyPair', identityKeyPair);
      cache.set('meta:registrationId',  registrationId);
      return store.init(identityKeyPair, registrationId);
    },

    attachFile(filePath)             { return store.attachFile(filePath); },
    setLidMapping(phone, lid)        { return store.setLidMapping(phone, lid); },
    getLidMappings()                 { return store.getLidMappings(); },
    preKeyCount()                    { return store.preKeyCount(); },
    nextPreKeyId()                   { return store.nextPreKeyId(); },
    /** Synchronous hasSession — never cached; always reads from in-memory sessions map. */
    hasSession(encodedAddress)       { return store.hasSession(encodedAddress); },

    // ── Identity / registration ───────────────────────────────────────────────

    async getOurIdentity() {
      return mutex.runExclusive(async () => {
        const hit = cache.get('meta:identityKeyPair');
        if (hit !== undefined) return hit;
        const val = await store.getOurIdentity();
        if (val) cache.set('meta:identityKeyPair', val);
        return val;
      });
    },

    async getIdentityKeyPair() {
      return mutex.runExclusive(async () => {
        const hit = cache.get('meta:identityKeyPair');
        if (hit !== undefined) return hit;
        const val = await store.getIdentityKeyPair();
        if (val) cache.set('meta:identityKeyPair', val);
        return val;
      });
    },

    async getLocalRegistrationId() {
      return mutex.runExclusive(async () => {
        const hit = cache.get('meta:registrationId');
        if (hit !== undefined) return hit;
        const val = await store.getLocalRegistrationId();
        cache.set('meta:registrationId', val);
        return val;
      });
    },

    async getOurRegistrationId() {
      return this.getLocalRegistrationId();
    },

    /** isTrustedIdentity — never cached; always delegates to underlying store. */
    async isTrustedIdentity(identifier, identityKey) {
      return store.isTrustedIdentity(identifier, identityKey);
    },

    async saveIdentity(identifier, identityKey) {
      return mutex.runExclusive(async () => {
        cache.del(cKey('identity', identifier));
        return store.saveIdentity(identifier, identityKey);
      });
    },

    async loadIdentityKey(identifier) {
      return mutex.runExclusive(async () => {
        const k   = cKey('identity', identifier);
        const hit = cache.get(k);
        if (hit !== undefined) {
          log('identity cache hit', { identifier });
          return hit;
        }
        const val = await store.loadIdentityKey(identifier);
        cache.set(k, val !== null && val !== undefined ? val : null);
        return val;
      });
    },

    // ── Sessions (hot path — every message send/receive touches these) ────────

    async loadSession(encodedAddress) {
      return mutex.runExclusive(async () => {
        const k   = cKey('session', encodedAddress);
        const hit = cache.get(k);
        if (hit !== undefined) {
          log('session cache hit', { encodedAddress });
          return hit;
        }
        const val = await store.loadSession(encodedAddress);
        if (val) cache.set(k, val);
        return val;
      });
    },

    async storeSession(encodedAddress, record) {
      return mutex.runExclusive(async () => {
        cache.set(cKey('session', encodedAddress), record);
        return store.storeSession(encodedAddress, record);
      });
    },

    async deleteSession(encodedAddress) {
      return mutex.runExclusive(async () => {
        cache.del(cKey('session', encodedAddress));
        return store.deleteSession(encodedAddress);
      });
    },

    // ── Pre-keys ──────────────────────────────────────────────────────────────

    async loadPreKey(keyId) {
      return mutex.runExclusive(async () => {
        const k   = cKey('prekey', keyId);
        const hit = cache.get(k);
        if (hit !== undefined) {
          log('prekey cache hit', { keyId });
          return hit;
        }
        const val = await store.loadPreKey(keyId);
        if (val) cache.set(k, val);
        return val;
      });
    },

    async storePreKey(keyId, keyPair) {
      return mutex.runExclusive(async () => {
        cache.set(cKey('prekey', keyId), keyPair);
        return store.storePreKey(keyId, keyPair);
      });
    },

    async removePreKey(keyId) {
      return mutex.runExclusive(async () => {
        cache.del(cKey('prekey', keyId));
        return store.removePreKey(keyId);
      });
    },

    // ── Signed pre-keys ───────────────────────────────────────────────────────

    async loadSignedPreKey(keyId) {
      return mutex.runExclusive(async () => {
        const k   = cKey('signedprekey', keyId);
        const hit = cache.get(k);
        if (hit !== undefined) {
          log('signed-prekey cache hit', { keyId });
          return hit;
        }
        const val = await store.loadSignedPreKey(keyId);
        if (val) cache.set(k, val);
        return val;
      });
    },

    async storeSignedPreKey(keyId, keyPair) {
      return mutex.runExclusive(async () => {
        cache.set(cKey('signedprekey', keyId), keyPair);
        return store.storeSignedPreKey(keyId, keyPair);
      });
    },

    async removeSignedPreKey(keyId) {
      return mutex.runExclusive(async () => {
        cache.del(cKey('signedprekey', keyId));
        return store.removeSignedPreKey(keyId);
      });
    },

    // ── Transaction forwarding ────────────────────────────────────────────────
    // If the underlying store was wrapped with addTransactionCapability, forward
    // transaction() and isInTransaction() so stacking both wrappers works correctly.

    /** Returns true if the current async context is inside a transaction. */
    isInTransaction() {
      return typeof store.isInTransaction === 'function'
        ? store.isInTransaction()
        : false;
    },

    /**
     * Delegate to the underlying store's transaction() if available.
     * This lets you stack makeCacheableSignalKeyStore on top of addTransactionCapability
     * and still call .transaction() on the outermost wrapper.
     */
    transaction(work, key) {
      if (typeof store.transaction !== 'function') {
        throw new Error(
          'transaction() is only available when the underlying store was wrapped ' +
          'with addTransactionCapability()'
        );
      }
      return store.transaction(work, key);
    },

    // ── Cache control ─────────────────────────────────────────────────────────

    /** Flush all cached entries (e.g. after a key rotation or re-registration). */
    async flushCache() {
      cache.flushAll();
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. addTransactionCapability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds DB-like transaction capability to a whalibmob SignalStore.
 *
 * Within a transaction all writes are buffered in an in-memory context
 * (scoped via AsyncLocalStorage).  Reads check the buffer first so they see
 * their own writes.  On commit the buffer is flushed to the underlying store
 * in one shot with retry logic.  Nested transactions transparently reuse the
 * enclosing context — no double-commit.
 *
 * Per-type Mutex objects serialise concurrent reads against the underlying
 * store when multiple transactions are in flight simultaneously.
 *
 * @param {SignalStore}  state   - underlying store (may already be cached)
 * @param {object}       logger  - optional logger with .trace() / .warn() / .error()
 * @param {object}       opts    - { maxCommitRetries, delayBetweenTriesMs }
 * @returns {object} drop-in SignalStore replacement with transaction support
 */
function addTransactionCapability(state, logger, opts) {
  opts = opts || {};
  const maxRetries  = opts.maxCommitRetries   ?? MAX_COMMIT_RETRIES;
  const retryDelay  = opts.delayBetweenTriesMs ?? RETRY_DELAY_MS;

  const txStorage     = new AsyncLocalStorage();
  const typeMutexes   = new Map();   // type → Mutex
  const typeMutexRefs = new Map();   // type → refcount

  function getMutex(type) {
    if (!typeMutexes.has(type)) {
      typeMutexes.set(type, new Mutex());
      typeMutexRefs.set(type, 0);
    }
    return typeMutexes.get(type);
  }

  function acquireRef(type) {
    typeMutexRefs.set(type, (typeMutexRefs.get(type) ?? 0) + 1);
  }

  function releaseRef(type) {
    const count = (typeMutexRefs.get(type) ?? 1) - 1;
    typeMutexRefs.set(type, count);
    if (count <= 0) {
      const m = typeMutexes.get(type);
      if (m && !m.isLocked()) {
        typeMutexes.delete(type);
        typeMutexRefs.delete(type);
      }
    }
  }

  function isInTransaction() {
    return !!txStorage.getStore();
  }

  async function commitWithRetry(ctx) {
    const { sessions, preKeys, signedPreKeys, identities } = ctx.mutations;
    const total = (
      Object.keys(sessions).length     +
      Object.keys(preKeys).length       +
      Object.keys(signedPreKeys).length +
      Object.keys(identities).length
    );
    if (total === 0) {
      logger && logger.trace('no mutations in transaction');
      return;
    }

    logger && logger.trace({ mutationCount: total }, 'committing transaction');

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const proms = [];

        for (const [addr, rec] of Object.entries(sessions)) {
          if (rec === null) {
            proms.push(state.deleteSession(addr));
          } else {
            proms.push(state.storeSession(addr, rec));
          }
        }

        for (const [keyId, kp] of Object.entries(preKeys)) {
          if (kp === null) {
            proms.push(state.removePreKey(Number(keyId)));
          } else {
            proms.push(state.storePreKey(Number(keyId), kp));
          }
        }

        for (const [keyId, kp] of Object.entries(signedPreKeys)) {
          if (kp === null) {
            proms.push(state.removeSignedPreKey(Number(keyId)));
          } else {
            proms.push(state.storeSignedPreKey(Number(keyId), kp));
          }
        }

        for (const [identifier, key] of Object.entries(identities)) {
          if (key !== null) {
            proms.push(state.saveIdentity(identifier, key));
          }
        }

        await Promise.all(proms);
        logger && logger.trace({ mutationCount: total }, 'committed transaction');
        return;
      } catch (error) {
        const retriesLeft = maxRetries - attempt - 1;
        logger && logger.warn(`failed to commit transaction mutations, retries left=${retriesLeft}`);
        if (retriesLeft === 0) throw error;
        await _delay(retryDelay);
      }
    }
  }

  // Build the empty mutation / read-buffer context for a new transaction.
  function makeCtx() {
    return {
      // Read buffer: what we've already loaded from the underlying store
      sessions:     {},
      preKeys:      {},
      signedPreKeys:{},
      identities:   {},
      // Pending writes: committed to disk on transaction end
      mutations: {
        sessions:     {},
        preKeys:      {},
        signedPreKeys:{},
        identities:   {}
      },
      dbQueries: 0
    };
  }

  return {
    // ── Pass-through non-transactional methods ────────────────────────────────
    init(ikp, regId)             { return state.init(ikp, regId); },
    attachFile(fp)               { return state.attachFile(fp); },
    setLidMapping(phone, lid)    { return state.setLidMapping(phone, lid); },
    getLidMappings()             { return state.getLidMappings(); },
    preKeyCount()                { return state.preKeyCount(); },
    nextPreKeyId()               { return state.nextPreKeyId(); },
    hasSession(addr)             { return state.hasSession(addr); },
    getOurIdentity()             { return state.getOurIdentity(); },
    getIdentityKeyPair()         { return state.getIdentityKeyPair(); },
    getLocalRegistrationId()     { return state.getLocalRegistrationId(); },
    getOurRegistrationId()       { return state.getOurRegistrationId(); },
    isTrustedIdentity(a, b)      { return state.isTrustedIdentity(a, b); },

    // ── Session ───────────────────────────────────────────────────────────────

    async loadSession(encodedAddress) {
      const ctx = txStorage.getStore();
      if (!ctx) return state.loadSession(encodedAddress);
      if (encodedAddress in ctx.sessions) return ctx.sessions[encodedAddress];
      // Not in buffer: fetch under mutex, cache in buffer
      const val = await getMutex('session').runExclusive(() => state.loadSession(encodedAddress));
      ctx.sessions[encodedAddress] = val;
      ctx.dbQueries++;
      return val;
    },

    async storeSession(encodedAddress, record) {
      const ctx = txStorage.getStore();
      if (!ctx) return state.storeSession(encodedAddress, record);
      ctx.sessions[encodedAddress] = record;
      ctx.mutations.sessions[encodedAddress] = record;
    },

    async deleteSession(encodedAddress) {
      const ctx = txStorage.getStore();
      if (!ctx) return state.deleteSession(encodedAddress);
      ctx.sessions[encodedAddress] = null;
      ctx.mutations.sessions[encodedAddress] = null;
    },

    // ── Pre-keys ──────────────────────────────────────────────────────────────

    async loadPreKey(keyId) {
      const ctx = txStorage.getStore();
      const k   = String(keyId);
      if (!ctx) return state.loadPreKey(keyId);
      if (k in ctx.preKeys) return ctx.preKeys[k];
      const val = await getMutex('preKey').runExclusive(() => state.loadPreKey(keyId));
      ctx.preKeys[k] = val;
      ctx.dbQueries++;
      return val;
    },

    async storePreKey(keyId, keyPair) {
      const ctx = txStorage.getStore();
      const k   = String(keyId);
      if (!ctx) return state.storePreKey(keyId, keyPair);
      ctx.preKeys[k] = keyPair;
      ctx.mutations.preKeys[k] = keyPair;
    },

    async removePreKey(keyId) {
      const ctx = txStorage.getStore();
      const k   = String(keyId);
      if (!ctx) return state.removePreKey(keyId);
      ctx.preKeys[k] = null;
      ctx.mutations.preKeys[k] = null;
    },

    // ── Signed pre-keys ───────────────────────────────────────────────────────

    async loadSignedPreKey(keyId) {
      const ctx = txStorage.getStore();
      const k   = String(keyId);
      if (!ctx) return state.loadSignedPreKey(keyId);
      if (k in ctx.signedPreKeys) return ctx.signedPreKeys[k];
      const val = await getMutex('signedPreKey').runExclusive(() => state.loadSignedPreKey(keyId));
      ctx.signedPreKeys[k] = val;
      ctx.dbQueries++;
      return val;
    },

    async storeSignedPreKey(keyId, keyPair) {
      const ctx = txStorage.getStore();
      const k   = String(keyId);
      if (!ctx) return state.storeSignedPreKey(keyId, keyPair);
      ctx.signedPreKeys[k] = keyPair;
      ctx.mutations.signedPreKeys[k] = keyPair;
    },

    async removeSignedPreKey(keyId) {
      const ctx = txStorage.getStore();
      const k   = String(keyId);
      if (!ctx) return state.removeSignedPreKey(keyId);
      ctx.signedPreKeys[k] = null;
      ctx.mutations.signedPreKeys[k] = null;
    },

    // ── Identity keys ─────────────────────────────────────────────────────────

    async loadIdentityKey(identifier) {
      const ctx = txStorage.getStore();
      if (!ctx) return state.loadIdentityKey(identifier);
      if (identifier in ctx.identities) return ctx.identities[identifier];
      const val = await getMutex('identity').runExclusive(() => state.loadIdentityKey(identifier));
      ctx.identities[identifier] = val;
      ctx.dbQueries++;
      return val;
    },

    async saveIdentity(identifier, identityKey) {
      const ctx = txStorage.getStore();
      if (!ctx) return state.saveIdentity(identifier, identityKey);
      ctx.identities[identifier] = identityKey;
      ctx.mutations.identities[identifier] = identityKey;
      // Inside a transaction we can't know yet if the key changed — return false
      // (the actual changed-flag will be resolved at commit time by the store).
      return false;
    },

    // ── Transaction control ───────────────────────────────────────────────────

    /** Returns true if the current async context is inside a transaction. */
    isInTransaction,

    /**
     * Run `work` inside a transaction scoped to `key`.
     * @param {function} work  async function to execute
     * @param {string}   key   mutex key (typically a key type or custom string)
     */
    transaction: async (work, key) => {
      key = key || 'default';
      const existing = txStorage.getStore();

      // Nested transaction — reuse the enclosing context
      if (existing) {
        logger && logger.trace('reusing existing transaction context');
        return work();
      }

      const mutex = getMutex(key);
      acquireRef(key);

      try {
        return await mutex.runExclusive(async () => {
          const ctx = makeCtx();
          logger && logger.trace('entering transaction');
          try {
            const result = await txStorage.run(ctx, work);
            await commitWithRetry(ctx);
            logger && logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed');
            return result;
          } catch (error) {
            logger && logger.error({ error }, 'transaction failed, rolling back');
            throw error;
          }
        });
      } finally {
        releaseRef(key);
      }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. assertMeId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's JID (phone@s.whatsapp.net) or throws
 * a descriptive error if the store is not yet fully authenticated.
 *
 * Equivalent to Baileys' assertMeId(creds) but for whalibmob's store format.
 * Use this anywhere we'd otherwise reach for `store.phoneNumber` directly,
 * to fail fast with a clear error instead of a silent null-reference crash.
 *
 * @param {object} store  — whalibmob store object (from createNewStore / loadStore)
 * @returns {string}       — JID string e.g. "40712345678@s.whatsapp.net"
 * @throws {Error}         — if store is not initialised or not yet registered
 */
function assertMeId(store) {
  if (!store || !store.phoneNumber) {
    throw new Error(
      'Cannot proceed: store has no phoneNumber — call createNewStore() first'
    );
  }
  if (!store.registered) {
    throw new Error(
      'Cannot proceed: device is not registered yet — ' +
      'complete SMS verification with verifyCode() before sending messages'
    );
  }
  const phone = String(store.phoneNumber).replace(/^\+/, '').replace(/\D/g, '');
  return `${phone}@s.whatsapp.net`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. initAuthCreds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a fresh set of whalibmob auth credentials (key pairs, registration ID,
 * device identifiers) for a given phone number.
 *
 * Equivalent to Baileys' initAuthCreds() but returns whalibmob's store format
 * (Buffer key pairs, signedPreKey as { id, public, private, signature }).
 *
 * Additional Baileys-compatible fields (nextPreKeyId, firstUnuploadedPreKeyId,
 * accountSyncCounter, accountSettings, advSecretKey, etc.) are appended so
 * code that was written against Baileys' credential shape works unchanged.
 *
 * @param {string|number} phoneNumber — full international number (e.g. "40712345678")
 * @param {object}        options     — optional overrides:
 *    registered {boolean}   — mark credentials as already registered (default false)
 *    name       {string}    — WhatsApp display name (default 'User')
 * @returns {object} fresh whalibmob store / credential object
 */
function initAuthCreds(phoneNumber, options) {
  if (!phoneNumber) throw new Error('initAuthCreds: phoneNumber is required');
  options = options || {};

  // Use whalibmob's own key-generation machinery (curve25519-js, proper prefixes)
  const store = createNewStore(phoneNumber);

  // ── Extra Baileys-compatible fields ──────────────────────────────────────────
  // These are not required by whalibmob internally but are commonly expected by
  // application code that was originally written against Baileys.

  /** Next pre-key ID to generate (monotonically increasing). */
  store.nextPreKeyId             = 1;

  /** First pre-key ID not yet uploaded to the WhatsApp server. */
  store.firstUnuploadedPreKeyId  = 1;

  /** Sync counter used in account-sync IQ stanzas. */
  store.accountSyncCounter       = 0;

  /** Account-level settings mirroring Baileys' IAccountSettings shape. */
  store.accountSettings          = { unarchiveChats: false };

  /** Processed history messages — used to avoid duplicate handling on reconnect. */
  store.processedHistoryMessages = [];

  /**
   * 32-byte random secret used for ADV (multi-device) poll encryption.
   * Stored as a base64 string, consistent with Baileys' advSecretKey.
   */
  store.advSecretKey             = crypto.randomBytes(32).toString('base64');

  // Fields that are undefined until populated by the pairing / registration flow
  store.pairingCode              = undefined;
  store.lastPropHash             = undefined;
  store.routingInfo              = undefined;
  store.additionalData           = undefined;

  // Apply optional caller overrides
  if (options.name)       store.name       = String(options.name);
  if (options.registered) store.registered = !!options.registered;

  return store;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  initAuthCreds
};
