'use strict';

// The optional Signal-store wrappers. The cache is on the hot path of every
// send and receive, so what it does and does not remember matters: caching an
// absent session would keep a session that is about to be built looking absent.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  makeCacheableSignalKeyStore, addTransactionCapability, assertMeId, initAuthCreds
} = require('../lib/auth-utils');

/** A minimal SignalStore that records how often it was actually reached. */
function fakeStore() {
  const data  = { session: new Map(), prekey: new Map(), signedprekey: new Map(), identity: new Map() };
  const calls = {};
  const count = name => { calls[name] = (calls[name] || 0) + 1; };

  return {
    calls,
    data,
    async init() { count('init'); },
    hasSession(a) { count('hasSession'); return data.session.has(a); },
    async getOurIdentity() { count('getOurIdentity'); return { pubKey: 'p', privKey: 'k' }; },
    async getIdentityKeyPair() { count('getIdentityKeyPair'); return { pubKey: 'p', privKey: 'k' }; },
    async getLocalRegistrationId() { count('getLocalRegistrationId'); return 1234; },
    async isTrustedIdentity() { count('isTrustedIdentity'); return true; },
    async saveIdentity(id, key) { count('saveIdentity'); data.identity.set(id, key); return true; },
    async loadIdentityKey(id) { count('loadIdentityKey'); return data.identity.get(id); },

    async loadSession(a) { count('loadSession'); return data.session.get(a); },
    async storeSession(a, r) { count('storeSession'); data.session.set(a, r); },
    async deleteSession(a) { count('deleteSession'); data.session.delete(a); },

    async loadPreKey(id) { count('loadPreKey'); return data.prekey.get(id); },
    async storePreKey(id, kp) { count('storePreKey'); data.prekey.set(id, kp); },
    async removePreKey(id) { count('removePreKey'); data.prekey.delete(id); },

    async loadSignedPreKey(id) { count('loadSignedPreKey'); return data.signedprekey.get(id); },
    async storeSignedPreKey(id, kp) { count('storeSignedPreKey'); data.signedprekey.set(id, kp); },
    async removeSignedPreKey(id) { count('removeSignedPreKey'); data.signedprekey.delete(id); },

    /** Not part of the wrapper's own surface — used to prove passthrough works. */
    async somethingCustom(x) { count('somethingCustom'); return 'custom:' + x; }
  };
}

// ── makeCacheableSignalKeyStore ─────────────────────────────────────────────

test('a second read of the same session is served from cache', async () => {
  const base = fakeStore();
  base.data.session.set('919634847671.0', { rec: 1 });
  const cached = makeCacheableSignalKeyStore(base);

  const first  = await cached.loadSession('919634847671.0');
  const second = await cached.loadSession('919634847671.0');

  assert.deepEqual(first, { rec: 1 });
  assert.deepEqual(second, { rec: 1 });
  assert.equal(base.calls.loadSession, 1, 'the underlying store is reached once');
});

test('a lookup that finds nothing is NOT cached', async () => {
  // Absence is the state most likely to change underneath: a session about to
  // be built, a pre-key about to be uploaded. A remembered miss is the one
  // that would hurt.
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  assert.equal(await cached.loadSession('missing.0'), undefined);
  assert.equal(await cached.loadSession('missing.0'), undefined);
  assert.equal(base.calls.loadSession, 2, 'a miss is re-asked every time');

  // ...and once it exists, it is found.
  base.data.session.set('missing.0', { rec: 9 });
  assert.deepEqual(await cached.loadSession('missing.0'), { rec: 9 });
});

test('a write reaches the store and primes the cache', async () => {
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  await cached.storeSession('a.0', { rec: 2 });
  assert.equal(base.calls.storeSession, 1, 'the write went through');
  assert.deepEqual(base.data.session.get('a.0'), { rec: 2 });

  assert.deepEqual(await cached.loadSession('a.0'), { rec: 2 });
  assert.equal(base.calls.loadSession, undefined, 'the read never had to touch the store');
});

test('a delete drops the cached entry as well as the stored one', async () => {
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  await cached.storeSession('a.0', { rec: 3 });
  await cached.deleteSession('a.0');

  assert.equal(base.data.session.has('a.0'), false);
  assert.equal(await cached.loadSession('a.0'), undefined, 'not served from a stale cache');
});

test('pre-keys and signed pre-keys are cached in separate namespaces', async () => {
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  await cached.storePreKey(1, { k: 'pre' });
  await cached.storeSignedPreKey(1, { k: 'signed' });

  // Same id, different type — one must not shadow the other.
  assert.deepEqual(await cached.loadPreKey(1), { k: 'pre' });
  assert.deepEqual(await cached.loadSignedPreKey(1), { k: 'signed' });
});

test('removePreKey invalidates its own entry only', async () => {
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  await cached.storePreKey(1, { k: 'one' });
  await cached.storePreKey(2, { k: 'two' });
  await cached.removePreKey(1);

  assert.equal(await cached.loadPreKey(1), undefined);
  assert.deepEqual(await cached.loadPreKey(2), { k: 'two' }, 'the neighbour is untouched');
});

test('the registration id is fetched once and then remembered', async () => {
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  assert.equal(await cached.getOurRegistrationId(), 1234);
  assert.equal(await cached.getOurRegistrationId(), 1234);
  assert.equal(base.calls.getLocalRegistrationId, 1);
});

test('flushCache makes the next read go back to the store', async () => {
  const base = fakeStore();
  base.data.session.set('a.0', { rec: 1 });
  const cached = makeCacheableSignalKeyStore(base);

  await cached.loadSession('a.0');
  await cached.flushCache();

  // Another process wrote to the same file in the meantime.
  base.data.session.set('a.0', { rec: 'changed elsewhere' });
  assert.deepEqual(await cached.loadSession('a.0'), { rec: 'changed elsewhere' });
  assert.equal(base.calls.loadSession, 2);
});

test('records are returned by reference, not deep-cloned', async () => {
  // SessionRecord objects carry internal state and methods; cloning one breaks
  // the ratchet.
  const base = fakeStore();
  const record = { rec: 1, advance() { this.rec++; } };
  base.data.session.set('a.0', record);
  const cached = makeCacheableSignalKeyStore(base);

  const got = await cached.loadSession('a.0');
  assert.equal(got, record, 'the very same object comes back');
  assert.equal(typeof got.advance, 'function', 'methods survive');
});

test('methods the wrapper does not implement are forwarded to the store', async () => {
  const base = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);

  assert.equal(typeof cached.somethingCustom, 'function', 'it is a drop-in replacement');
  assert.equal(await cached.somethingCustom('x'), 'custom:x');
  assert.equal(base.calls.somethingCustom, 1);
});

test('hasSession stays synchronous, since it reads the in-memory map', async () => {
  const base = fakeStore();
  base.data.session.set('a.0', { rec: 1 });
  const cached = makeCacheableSignalKeyStore(base);
  assert.equal(cached.hasSession('a.0'), true);
  assert.equal(cached.hasSession('nope.0'), false);
});

// ── addTransactionCapability ────────────────────────────────────────────────

test('writes inside a transaction land in the store when it finishes', async () => {
  const base = fakeStore();
  const txn = addTransactionCapability(base);

  await txn.transaction(async () => {
    await txn.storeSession('a.0', { rec: 1 });
    await txn.storePreKey(7, { k: 'seven' });
  }, 'send');

  assert.deepEqual(base.data.session.get('a.0'), { rec: 1 });
  assert.deepEqual(base.data.prekey.get(7), { k: 'seven' });
});

test('a transaction sees its own writes before they are committed', async () => {
  const base = fakeStore();
  const txn = addTransactionCapability(base);

  await txn.transaction(async () => {
    await txn.storeSession('a.0', { rec: 'buffered' });
    const readBack = await txn.loadSession('a.0');
    assert.deepEqual(readBack, { rec: 'buffered' }, 'reads check the buffer first');
  }, 'send');
});

test('a transaction that throws writes nothing at all', async () => {
  const base = fakeStore();
  const txn = addTransactionCapability(base);

  await assert.rejects(
    txn.transaction(async () => {
      await txn.storeSession('a.0', { rec: 1 });
      throw new Error('something went wrong');
    }, 'send'),
    /something went wrong/,
    'the error reaches the caller'
  );

  assert.equal(base.data.session.has('a.0'), false, 'nothing was committed');
});

test('isInTransaction reports the surrounding context', async () => {
  const base = fakeStore();
  const txn = addTransactionCapability(base);

  assert.equal(txn.isInTransaction(), false);
  await txn.transaction(async () => {
    assert.equal(txn.isInTransaction(), true);
  }, 'send');
  assert.equal(txn.isInTransaction(), false, 'the context is gone afterwards');
});

test('a nested transaction reuses the outer one rather than committing early', async () => {
  const base = fakeStore();
  const txn = addTransactionCapability(base);

  await txn.transaction(async () => {
    await txn.storeSession('outer.0', { rec: 'outer' });

    await txn.transaction(async () => {
      await txn.storeSession('inner.0', { rec: 'inner' });
    }, 'send');

    // The inner one returned; if it had committed on its own, this would be set.
    assert.equal(base.data.session.has('inner.0'), false, 'the inner block did not commit alone');
  }, 'send');

  assert.deepEqual(base.data.session.get('outer.0'), { rec: 'outer' });
  assert.deepEqual(base.data.session.get('inner.0'), { rec: 'inner' });
});

test('the cache and the transaction wrapper stack in the recommended order', async () => {
  const base   = fakeStore();
  const cached = makeCacheableSignalKeyStore(base);
  const txn    = addTransactionCapability(cached);

  await txn.transaction(async () => {
    await txn.storeSession('a.0', { rec: 1 });
  }, 'send');

  assert.deepEqual(base.data.session.get('a.0'), { rec: 1 });
  assert.deepEqual(await txn.loadSession('a.0'), { rec: 1 });
});

// ── assertMeId ──────────────────────────────────────────────────────────────

test('assertMeId names what is missing instead of failing vaguely', () => {
  assert.throws(() => assertMeId(null), /store/i);
  assert.throws(() => assertMeId({}), /phone/i);
  assert.throws(() => assertMeId({ phoneNumber: '919634847671' }), /register/i);
});

test('assertMeId builds a JID from the number before the server assigns one', () => {
  const store = initAuthCreds('919634847671');
  store.registered = true;
  assert.equal(assertMeId(store), '919634847671@s.whatsapp.net');
});

test('assertMeId prefers the JID the server assigned, device suffix included', () => {
  const store = initAuthCreds('919634847671');
  store.registered = true;
  store.me = { id: '919634847671:12@s.whatsapp.net' };
  assert.equal(
    assertMeId(store), '919634847671:12@s.whatsapp.net',
    'rebuilding it from the number would silently drop the :12'
  );
});

test('initAuthCreds produces a store that can be registered', () => {
  const store = initAuthCreds('919634847671', { name: 'Ana' });
  assert.equal(store.phoneNumber, '919634847671');
  assert.equal(store.registered, false);
  assert.equal(store.name, 'Ana');
  assert.ok(Buffer.isBuffer(store.identityKeyPair.private));
  assert.ok(Buffer.isBuffer(store.noiseKeyPair.private));
  assert.ok(store.registrationId > 0);
});
