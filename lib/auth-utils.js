'use strict';

// ─── auth-utils.js ────────────────────────────────────────────────────────────
//
// Optional helpers for code that manages its own SignalStore — a custom storage
// backend, a multi-account server, anything that wants caching or transactional
// writes around the store the library would otherwise use directly.
//
//  1. makeCacheableSignalKeyStore  — an in-memory cache with a 5-minute TTL in
//                                    front of the store, serialised by a Mutex
//  2. addTransactionCapability     — buffered writes committed in one shot,
//                                    scoped with AsyncLocalStorage
//  3. assertMeId                   — the account's JID, or a clear error
//  4. initAuthCreds                — a fresh credential set for a phone number
//
// Stacking order matters. The cache belongs *underneath* the transaction:
//
//   const { SignalStore } = require('whalibmob');
//   const { makeCacheableSignalKeyStore,
//           addTransactionCapability } = require('whalibmob/lib/auth-utils');
//
//   const raw    = new SignalStore();
//   const cached = makeCacheableSignalKeyStore(raw, logger);
//   const store  = addTransactionCapability(cached, logger);
//
// That way a transaction that throws never reaches the cache at all — its
// writes are still sitting in the transaction buffer when it is discarded. The
// other order works too, and a rollback flushes the cache to stay honest, but
// it throws away entries that were perfectly good.
//
// ─────────────────────────────────────────────────────────────────────────────

const { NodeCache }         = require('@cacheable/node-cache');
const { AsyncLocalStorage } = require('async_hooks');
const { Mutex }             = require('async-mutex');
const crypto                = require('crypto');
const { createNewStore }    = require('./Store');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How long a cached entry lives, in seconds.
 *
 * The option is `stdTTL` and the unit is seconds — `ttl`, and a string like
 * '5m', are both accepted without complaint and then ignored, which leaves a
 * cache that never evicts anything and answers from it forever.
 */
const SIGNAL_STORE_TTL_SECONDS = 5 * 60;

/** Default max retry count for transaction commits. */
const MAX_COMMIT_RETRIES    = 5;

/** Milliseconds to wait between commit retries. */
const RETRY_DELAY_MS        = 250;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Forward every method the wrapper did not define itself.
 *
 * Both wrappers claim to be drop-in replacements, and a hand-written list stops
 * being one the moment the store grows a method — the call does not fail
 * loudly, it lands on `undefined`. Anything the wrapper has an opinion about is
 * already on it and is left alone; the rest is passed straight through.
 */
function _fillPassthrough(wrapper, store) {
  const seen = new Set();
  let level  = store;

  while (level && level !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (seen.has(name) || name === 'constructor' || name.startsWith('_')) continue;
      seen.add(name);
      if (name in wrapper) continue;                  // the wrapper handles it
      let fn;
      try { fn = store[name]; } catch (_) { continue; }   // skip throwing getters
      if (typeof fn !== 'function') continue;
      wrapper[name] = (...args) => store[name](...args);
    }
    level = Object.getPrototypeOf(level);
  }

  return wrapper;
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. makeCacheableSignalKeyStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps a SignalStore with:
 *   • NodeCache — an in-memory cache with a 5-minute TTL for every key type
 *     (sessions, pre-keys, signed pre-keys, identity keys, registration ID).
 *     Each entry is evicted after that and re-read on the next access, which
 *     bounds memory and puts a ceiling on how long another writer's change can
 *     go unnoticed.
 *   • Mutex  — every get/set is serialised, so two concurrent operations cannot
 *     interleave a read against a write to the same key.
 *
 * A lookup that finds nothing is *not* cached. Absence is the state most likely
 * to change from underneath — a session about to be built, a pre-key about to
 * be uploaded — and a remembered miss is the one that hurts.
 *
 * @param {SignalStore}  store   - underlying SignalStore instance
 * @param {object}       logger  - optional logger with a .trace() method
 * @param {NodeCache}    _cache  - optional pre-built cache (for testing / sharing)
 * @returns {object} drop-in SignalStore replacement with caching and serialisation
 */
function makeCacheableSignalKeyStore(store, logger, _cache) {
  const cache = _cache || new NodeCache({
    stdTTL:         SIGNAL_STORE_TTL_SECONDS,
    useClones:      false,
    deleteOnExpire: true
  });
  const mutex = new Mutex();

  /** Unified cache key: "type:id" */
  const cKey = (type, id) => `${type}:${String(id)}`;

  const log = (msg, data) => logger && logger.trace(data, msg);

  // Read through the cache, remembering only what was actually found.
  function cachedRead(type, id, load) {
    return mutex.runExclusive(async () => {
      const k   = cKey(type, id);
      const hit = cache.get(k);
      if (hit !== undefined) {
        log(type + ' cache hit', { id });
        return hit;
      }
      const val = await load();
      if (val !== undefined && val !== null) cache.set(k, val);
      return val;
    });
  }

  function cachedWrite(type, id, value, write) {
    return mutex.runExclusive(async () => {
      cache.set(cKey(type, id), value);
      return write();
    });
  }

  function cachedDelete(type, id, remove) {
    return mutex.runExclusive(async () => {
      cache.del(cKey(type, id));
      return remove();
    });
  }

  // Named rather than reached for through `this`, so a caller may pull a method
  // off the object — `const { loadSession } = cachedStore` — and still call it.
  async function getLocalRegistrationId() {
    return mutex.runExclusive(async () => {
      const hit = cache.get('meta:registrationId');
      if (hit !== undefined) return hit;
      const val = await store.getLocalRegistrationId();
      if (val !== undefined && val !== null) cache.set('meta:registrationId', val);
      return val;
    });
  }

  async function identity(load) {
    return mutex.runExclusive(async () => {
      const hit = cache.get('meta:identityKeyPair');
      if (hit !== undefined) return hit;
      const val = await load();
      if (val) cache.set('meta:identityKeyPair', val);
      return val;
    });
  }

  const wrapper = {
    // ── Initialisation ───────────────────────────────────────────────────────

    init(identityKeyPair, registrationId) {
      cache.set('meta:identityKeyPair', identityKeyPair);
      cache.set('meta:registrationId',  registrationId);
      return store.init(identityKeyPair, registrationId);
    },

    /** Synchronous — never cached; reads the store's own in-memory session map. */
    hasSession(encodedAddress) { return store.hasSession(encodedAddress); },

    // ── Identity / registration ───────────────────────────────────────────────

    getOurIdentity()         { return identity(() => store.getOurIdentity()); },
    getIdentityKeyPair()     { return identity(() => store.getIdentityKeyPair()); },
    getLocalRegistrationId,
    getOurRegistrationId()   { return getLocalRegistrationId(); },

    /** Never cached; the store decides trust from its own current state. */
    async isTrustedIdentity(identifier, identityKey) {
      return store.isTrustedIdentity(identifier, identityKey);
    },

    saveIdentity(identifier, identityKey) {
      return cachedDelete('identity', identifier,
        () => store.saveIdentity(identifier, identityKey));
    },

    loadIdentityKey(identifier) {
      return cachedRead('identity', identifier,
        () => store.loadIdentityKey(identifier));
    },

    // ── Sessions (hot path — every message send and receive touches these) ────

    loadSession(encodedAddress) {
      return cachedRead('session', encodedAddress,
        () => store.loadSession(encodedAddress));
    },

    storeSession(encodedAddress, record) {
      return cachedWrite('session', encodedAddress, record,
        () => store.storeSession(encodedAddress, record));
    },

    deleteSession(encodedAddress) {
      return cachedDelete('session', encodedAddress,
        () => store.deleteSession(encodedAddress));
    },

    // ── Pre-keys ──────────────────────────────────────────────────────────────

    loadPreKey(keyId) {
      return cachedRead('prekey', keyId, () => store.loadPreKey(keyId));
    },

    storePreKey(keyId, keyPair) {
      return cachedWrite('prekey', keyId, keyPair,
        () => store.storePreKey(keyId, keyPair));
    },

    removePreKey(keyId) {
      return cachedDelete('prekey', keyId, () => store.removePreKey(keyId));
    },

    // ── Signed pre-keys ───────────────────────────────────────────────────────

    loadSignedPreKey(keyId) {
      return cachedRead('signedprekey', keyId, () => store.loadSignedPreKey(keyId));
    },

    storeSignedPreKey(keyId, keyPair) {
      return cachedWrite('signedprekey', keyId, keyPair,
        () => store.storeSignedPreKey(keyId, keyPair));
    },

    removeSignedPreKey(keyId) {
      return cachedDelete('signedprekey', keyId, () => store.removeSignedPreKey(keyId));
    },

    // ── Transaction forwarding ────────────────────────────────────────────────
    // Present so the cache can sit on top of addTransactionCapability as well as
    // underneath it, even though underneath is the better place for it.

    /** True when the current async context is inside a transaction. */
    isInTransaction() {
      return typeof store.isInTransaction === 'function'
        ? store.isInTransaction()
        : false;
    },

    /**
     * Delegate to the underlying store's transaction, dropping the cache if it
     * does not go through.
     *
     * Writes reach the cache as they are made, but a transaction that throws
     * never commits them — so without this the cache would keep serving values
     * the store never took, and go on doing it until the entries expired.
     */
    transaction(work, key) {
      if (typeof store.transaction !== 'function') {
        throw new Error(
          'transaction() is only available when the underlying store was wrapped ' +
          'with addTransactionCapability()'
        );
      }
      return (async () => {
        try {
          return await store.transaction(work, key);
        } catch (error) {
          cache.flushAll();
          logger && logger.trace('transaction failed — cache flushed');
          throw error;
        }
      })();
    },

    // ── Cache control ─────────────────────────────────────────────────────────

    /** Drop every cached entry, here and in anything wrapped below. */
    async flushCache() {
      cache.flushAll();
      if (typeof store.flushCache === 'function') await store.flushCache();
    }
  };

  return _fillPassthrough(wrapper, store);
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. addTransactionCapability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds DB-like transaction capability to a SignalStore.
 *
 * Within a transaction all writes are buffered in an in-memory context (scoped
 * with AsyncLocalStorage). Reads check the buffer first so they see their own
 * writes. On commit the buffer is flushed to the underlying store in one shot,
 * with retries. Nested transactions reuse the enclosing context, so there is no
 * double commit.
 *
 * @param {SignalStore}  state   - underlying store (may already be cached)
 * @param {object}       logger  - optional logger with .trace() / .warn() / .error()
 * @param {object}       opts    - { maxCommitRetries, delayBetweenTriesMs }
 * @returns {object} drop-in SignalStore replacement with transaction support
 */
function addTransactionCapability(state, logger, opts) {
  opts = opts || {};
  const maxRetries  = opts.maxCommitRetries    ?? MAX_COMMIT_RETRIES;
  const retryDelay  = opts.delayBetweenTriesMs ?? RETRY_DELAY_MS;

  const txStorage = new AsyncLocalStorage();

  // Two separate sets of locks, and they must stay separate.
  //
  // A transaction holds its lock for as long as the work runs, and reads inside
  // that work take a lock of their own. Sharing one map means transaction('…',
  // 'session') takes the session lock and then waits for itself the first time
  // it loads a session — a deadlock with no error and no timeout, reachable
  // from nothing worse than an unlucky choice of key.
  const readMutexes = new Map();   // data type → Mutex, held only for one read
  const txMutexes   = new Map();   // transaction key → Mutex, held for the work
  const txMutexRefs = new Map();   // transaction key → refcount

  function getReadMutex(type) {
    if (!readMutexes.has(type)) readMutexes.set(type, new Mutex());
    return readMutexes.get(type);
  }

  function getTxMutex(key) {
    if (!txMutexes.has(key)) {
      txMutexes.set(key, new Mutex());
      txMutexRefs.set(key, 0);
    }
    return txMutexes.get(key);
  }

  function acquireRef(key) {
    txMutexRefs.set(key, (txMutexRefs.get(key) ?? 0) + 1);
  }

  function releaseRef(key) {
    const count = (txMutexRefs.get(key) ?? 1) - 1;
    txMutexRefs.set(key, count);
    if (count <= 0) {
      const m = txMutexes.get(key);
      if (m && !m.isLocked()) {
        txMutexes.delete(key);
        txMutexRefs.delete(key);
      }
    }
  }

  function isInTransaction() {
    return !!txStorage.getStore();
  }

  async function commitWithRetry(ctx) {
    const { sessions, preKeys, signedPreKeys, identities } = ctx.mutations;
    const total = (
      Object.keys(sessions).length      +
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
          proms.push(rec === null ? state.deleteSession(addr)
                                  : state.storeSession(addr, rec));
        }

        for (const [keyId, kp] of Object.entries(preKeys)) {
          proms.push(kp === null ? state.removePreKey(Number(keyId))
                                 : state.storePreKey(Number(keyId), kp));
        }

        for (const [keyId, kp] of Object.entries(signedPreKeys)) {
          proms.push(kp === null ? state.removeSignedPreKey(Number(keyId))
                                 : state.storeSignedPreKey(Number(keyId), kp));
        }

        for (const [identifier, key] of Object.entries(identities)) {
          if (key !== null) proms.push(state.saveIdentity(identifier, key));
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

  // The empty read buffer and pending writes for a new transaction.
  function makeCtx() {
    return {
      // Read buffer: what has already been loaded from the underlying store
      sessions:      {},
      preKeys:       {},
      signedPreKeys: {},
      identities:    {},
      // Pending writes: flushed to the store when the transaction ends
      mutations: {
        sessions:      {},
        preKeys:       {},
        signedPreKeys: {},
        identities:    {}
      },
      dbQueries: 0
    };
  }

  // Read through the transaction buffer, or straight through when there is no
  // transaction in this async context.
  async function bufferedRead(bucket, type, id, load) {
    const ctx = txStorage.getStore();
    if (!ctx) return load();
    const k = String(id);
    if (k in ctx[bucket]) return ctx[bucket][k];
    const val = await getReadMutex(type).runExclusive(load);
    ctx[bucket][k] = val;
    ctx.dbQueries++;
    return val;
  }

  async function bufferedWrite(bucket, id, value, write) {
    const ctx = txStorage.getStore();
    if (!ctx) return write();
    const k = String(id);
    ctx[bucket][k] = value;
    ctx.mutations[bucket][k] = value;
  }

  const wrapper = {
    // ── Session ───────────────────────────────────────────────────────────────

    loadSession(encodedAddress) {
      return bufferedRead('sessions', 'session', encodedAddress,
        () => state.loadSession(encodedAddress));
    },

    storeSession(encodedAddress, record) {
      return bufferedWrite('sessions', encodedAddress, record,
        () => state.storeSession(encodedAddress, record));
    },

    deleteSession(encodedAddress) {
      return bufferedWrite('sessions', encodedAddress, null,
        () => state.deleteSession(encodedAddress));
    },

    // ── Pre-keys ──────────────────────────────────────────────────────────────

    loadPreKey(keyId) {
      return bufferedRead('preKeys', 'preKey', keyId, () => state.loadPreKey(keyId));
    },

    storePreKey(keyId, keyPair) {
      return bufferedWrite('preKeys', keyId, keyPair,
        () => state.storePreKey(keyId, keyPair));
    },

    removePreKey(keyId) {
      return bufferedWrite('preKeys', keyId, null, () => state.removePreKey(keyId));
    },

    // ── Signed pre-keys ───────────────────────────────────────────────────────

    loadSignedPreKey(keyId) {
      return bufferedRead('signedPreKeys', 'signedPreKey', keyId,
        () => state.loadSignedPreKey(keyId));
    },

    storeSignedPreKey(keyId, keyPair) {
      return bufferedWrite('signedPreKeys', keyId, keyPair,
        () => state.storeSignedPreKey(keyId, keyPair));
    },

    removeSignedPreKey(keyId) {
      return bufferedWrite('signedPreKeys', keyId, null,
        () => state.removeSignedPreKey(keyId));
    },

    // ── Identity keys ─────────────────────────────────────────────────────────

    loadIdentityKey(identifier) {
      return bufferedRead('identities', 'identity', identifier,
        () => state.loadIdentityKey(identifier));
    },

    async saveIdentity(identifier, identityKey) {
      const ctx = txStorage.getStore();
      if (!ctx) return state.saveIdentity(identifier, identityKey);
      ctx.identities[identifier] = identityKey;
      ctx.mutations.identities[identifier] = identityKey;
      // The store answers whether the key changed, and that answer only exists
      // once the write lands. Inside a transaction it has not, so say so.
      return false;
    },

    // ── Transaction control ───────────────────────────────────────────────────

    /** True when the current async context is inside a transaction. */
    isInTransaction,

    /** Forwarded so a cache wrapped underneath can still be flushed. */
    async flushCache() {
      if (typeof state.flushCache === 'function') return state.flushCache();
    },

    /**
     * Run `work` inside a transaction scoped to `key`.
     *
     * @param {function} work  async function to execute
     * @param {string}   key   scope; separate keys run concurrently
     */
    transaction: async (work, key) => {
      key = key || 'default';
      const existing = txStorage.getStore();

      // Nested transaction — reuse the enclosing context rather than opening a
      // second one that would commit separately.
      if (existing) {
        logger && logger.trace('reusing existing transaction context');
        return work();
      }

      const mutex = getTxMutex(key);
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

  return _fillPassthrough(wrapper, state);
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. assertMeId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the authenticated account's JID, or throws a descriptive error when
 * the store is not authenticated yet.
 *
 * Use this anywhere the alternative is reaching for `store.phoneNumber` and
 * hoping, so the failure arrives as a sentence rather than as a null reference
 * several frames later.
 *
 * The JID the server assigned is preferred when there is one — it carries the
 * device suffix, and reconstructing it from the phone number silently drops
 * that. Only a store that has never completed a connection falls back to
 * building one.
 *
 * @param {object} store  — store object (from createNewStore / loadStore)
 * @returns {string}       — JID, e.g. "40712345678:12@s.whatsapp.net"
 * @throws {Error}         — when the store is not initialised or not registered
 */
function assertMeId(store) {
  if (!store) {
    throw new Error(
      'Cannot proceed: no store was given — call createNewStore() first'
    );
  }

  const assigned = store.me && store.me.id;
  if (assigned) return String(assigned);

  if (!store.phoneNumber) {
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
 * Creates a fresh set of auth credentials (key pairs, registration ID, device
 * identifiers) for a given phone number.
 *
 * Returns the library's store format: Buffer key pairs, and signedPreKey as
 * { id, public, private, signature }.
 *
 * A few extra fields (nextPreKeyId, firstUnuploadedPreKeyId, accountSyncCounter,
 * accountSettings, advSecretKey and so on) are appended for account sync and for
 * application code that expects them.
 *
 * There is no stored pairing ephemeral key: a fresh pair is generated per
 * attempt, so a code that was requested and never used cannot be completed
 * later with a key still lying around in the store.
 *
 * @param {string|number} phoneNumber — full international number, e.g. "40712345678"
 * @param {object}        options     — optional overrides:
 *    registered {boolean}   — mark the credentials as already registered (default false)
 *    name       {string}    — display name (default 'User')
 * @returns {object} fresh store / credential object
 */
function initAuthCreds(phoneNumber, options) {
  if (!phoneNumber) throw new Error('initAuthCreds: phoneNumber is required');
  options = options || {};

  // The library's own key generation — curve25519, with the right prefixes.
  const store = createNewStore(phoneNumber);

  // ── Extra credential fields ──────────────────────────────────────────────────
  // Not required internally, but commonly expected by application code.

  /** Next pre-key ID to generate (monotonically increasing). */
  store.nextPreKeyId             = 1;

  /** First pre-key ID not yet uploaded to the server. */
  store.firstUnuploadedPreKeyId  = 1;

  /** Sync counter used in account-sync IQ stanzas. */
  store.accountSyncCounter       = 0;

  /** Account-level settings. */
  store.accountSettings          = { unarchiveChats: false };

  /** Processed history messages — avoids handling the same one twice on reconnect. */
  store.processedHistoryMessages = [];

  /**
   * 32-byte random secret used for multi-device poll encryption.
   * Stored as a base64 string.
   */
  store.advSecretKey             = crypto.randomBytes(32).toString('base64');

  // Fields left undefined until the pairing / registration flow fills them in
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
  initAuthCreds,
  SIGNAL_STORE_TTL_SECONDS
};
