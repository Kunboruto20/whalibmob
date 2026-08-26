'use strict';

// App state, against whatsmeow's behaviour.
//
// Three things here are worth pinning down, because getting any of them wrong
// is silent: the shape of an app-state key request (a collection stays
// unreadable forever if the ask never goes out, and nothing errors), the LT
// hash arithmetic on a snapshot as against a patch (a wrong subtraction fails
// the snapshot MAC and the whole collection is discarded), and the fields a
// decoded mutation carries out to a caller.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  encodeAppStateSyncKeyRequest, encodeProtocolMessage, decodeFields,
  PROTOCOL_TYPE_APP_STATE_SYNC_KEY_REQUEST
} = require('../lib/proto/MessageProto');
const { makeGenerator, newState, PATCH_INTEGRITY } = require('../lib/appstate/LTHash');
const AppStateSync = require('../lib/appstate/AppStateSync');
const SyncdProto   = require('../lib/appstate/SyncdProto');
const { WhalibmobClient } = require('../lib/Client');

// ─── the key request goes out in the shape the phone expects ─────────────────

test('AppStateSyncKeyRequest wraps each id as AppStateSyncKeyId { keyId = 1 }', () => {
  const a = Buffer.from('0102030405e6', 'hex');
  const b = Buffer.from('aabbccddeeff', 'hex');

  const f  = decodeFields(encodeAppStateSyncKeyRequest([a, b]));
  const ids = Array.isArray(f[1]) ? f[1] : [f[1]];

  assert.equal(ids.length, 2, 'keyIds is repeated field 1');
  assert.equal(decodeFields(ids[0])[1].toString('hex'), a.toString('hex'));
  assert.equal(decodeFields(ids[1])[1].toString('hex'), b.toString('hex'));
});

test('the request rides on ProtocolMessage type 7, field 8', () => {
  const inner = encodeAppStateSyncKeyRequest([Buffer.from('beef', 'hex')]);
  const f = decodeFields(encodeProtocolMessage({
    type: PROTOCOL_TYPE_APP_STATE_SYNC_KEY_REQUEST,
    appStateSyncKeyRequest: inner
  }));

  assert.equal(PROTOCOL_TYPE_APP_STATE_SYNC_KEY_REQUEST, 7);
  assert.equal(Number(f[2]), 7, 'type = APP_STATE_SYNC_KEY_REQUEST');
  assert.equal(f[8].toString('hex'), inner.toString('hex'), 'carried at field 8');
});

test('an empty id list encodes to nothing', () => {
  assert.equal(encodeAppStateSyncKeyRequest([]).length, 0);
  assert.equal(encodeAppStateSyncKeyRequest(null).length, 0);
});

// ─── requestAppStateKeys: sent once, then held down ──────────────────────────

// The method reads _sender, _connected, _store and _genMsgId and nothing else,
// so a bare object with the prototype exercises the real path without a socket.
function fakeClient() {
  const sent = [];
  return Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true,
    _store:     { me: { id: '40712345678@s.whatsapp.net' } },
    _genMsgId:  () => 'MSGID' + sent.length,
    _sender:    {
      _sendMessage(to, id, buf, kind, opts) { sent.push({ to, id, buf, opts }); }
    },
    sent
  });
}

test('a missing key is asked for once, and not again inside the day', async () => {
  const c  = fakeClient();
  const id = Buffer.from('0a0b0c0d0e0f', 'hex').toString('base64');

  const first = await c.requestAppStateKeys([id]);
  assert.ok(first, 'the first ask goes out');
  assert.equal(c.sent.length, 1);

  const again = await c.requestAppStateKeys([id]);
  assert.equal(again, null, 'the second is held down');
  assert.equal(c.sent.length, 1, 'and nothing more was sent');
});

test('the request is a peer message to yourself', async () => {
  const c = fakeClient();
  await c.requestAppStateKeys([Buffer.from('112233', 'hex').toString('base64')]);

  const { to, opts } = c.sent[0];
  assert.equal(to, '40712345678@s.whatsapp.net', 'addressed to this account');
  assert.equal(opts.category, 'peer', 'routed to our own devices');
  assert.equal(opts._protocol, true, 'kept off the tcToken gate');
});

test('hex and base64 spellings of one id are the same id', async () => {
  const c   = fakeClient();
  const raw = Buffer.from('a1b2c3d4e5f6', 'hex');

  await c.requestAppStateKeys([raw.toString('hex')]);
  assert.equal(c.sent.length, 1);

  await c.requestAppStateKeys([raw.toString('base64')]);
  assert.equal(c.sent.length, 1, 'the same key, so still held down');
});

test('nothing is sent with no keys, or while disconnected', async () => {
  const c = fakeClient();
  assert.equal(await c.requestAppStateKeys([]), null);
  assert.equal(await c.requestAppStateKeys(null), null);

  c._connected = false;
  assert.equal(await c.requestAppStateKeys(['//8=']), null);
  assert.equal(c.sent.length, 0);
});

// ─── the LT hash, snapshot against patch ─────────────────────────────────────

const idx = (n) => crypto.createHash('sha256').update('index' + n).digest();
const val = (n) => crypto.createHash('sha256').update('value' + n).digest();

// whatsmeow's arithmetic, written out plainly: subtract every displaced value,
// then add every SET value. Anything the generator does has to agree with this.
function expected(base, added, removed) {
  return PATCH_INTEGRITY.subtractThenAdd(base, added, removed);
}

test('a patch displacing an earlier value subtracts it', () => {
  const st = newState();
  st.indexValueMap = { [idx(1).toString('base64')]: { valueMac: val(1) } };

  const gen = makeGenerator(st);
  gen.mix({ indexMac: idx(1), valueMac: val(2), remove: false });
  const got = gen.finish();

  assert.equal(got.hash.toString('hex'),
    expected(st.hash, [val(2)], [val(1)]).toString('hex'));
  assert.equal(got.indexValueMap[idx(1).toString('base64')].valueMac.toString('hex'),
    val(2).toString('hex'), 'and the index now carries the new value');
});

test('a snapshot adds every record and subtracts none', () => {
  // Two records sharing an index. whatsmeow hands its snapshot pass a callback
  // that always answers "no previous value", so both are added and neither
  // displaces the other. Displacing the first would leave us one value short
  // of the hash the snapshot is signed against.
  const gen = makeGenerator(newState(), { snapshot: true });
  gen.mix({ indexMac: idx(1), valueMac: val(1), remove: false });
  gen.mix({ indexMac: idx(1), valueMac: val(2), remove: false });
  const got = gen.finish();

  assert.equal(got.hash.toString('hex'),
    expected(Buffer.alloc(128), [val(1), val(2)], []).toString('hex'));
});

test('the same two records in a patch do displace', () => {
  const fold = (opts) => {
    const g = makeGenerator(newState(), opts);
    g.mix({ indexMac: idx(1), valueMac: val(1), remove: false });
    g.mix({ indexMac: idx(1), valueMac: val(2), remove: false });
    return g.finish().hash.toString('hex');
  };

  assert.equal(fold(),
    expected(Buffer.alloc(128), [val(1), val(2)], [val(1)]).toString('hex'));
  assert.notEqual(fold(), fold({ snapshot: true }),
    'so the two passes really do differ');
});

test('a REMOVE subtracts what the index held, and forgets it', () => {
  const st = newState();
  st.indexValueMap = { [idx(1).toString('base64')]: { valueMac: val(1) } };

  const gen = makeGenerator(st);
  gen.mix({ indexMac: idx(1), valueMac: val(1), remove: true });
  const got = gen.finish();

  assert.equal(got.hash.toString('hex'),
    expected(st.hash, [], [val(1)]).toString('hex'));
  assert.equal(got.indexValueMap[idx(1).toString('base64')], undefined);
});

test('a REMOVE for something we never had changes nothing', () => {
  const gen = makeGenerator(newState());
  gen.mix({ indexMac: idx(9), valueMac: val(9), remove: true });
  assert.equal(gen.finish().hash.toString('hex'), Buffer.alloc(128).toString('hex'));
});

// ─── a decoded mutation reports what the server said about it ────────────────

test('decodeMutations hands out the index, action, operation, version and MACs', () => {
  const keyData = crypto.randomBytes(32);
  const keyId   = Buffer.from('0102030405', 'hex');
  const keys    = AppStateSync.mutationKeys(keyData);

  const index  = ['pin_v1', '40712345678@s.whatsapp.net'];
  const idxBuf = Buffer.from(JSON.stringify(index), 'utf8');

  const body = SyncdProto.encodeSyncActionData({
    index: idxBuf,
    value: { pinAction: { pinned: true } },
    apiVersion: 5,
    timestampMs: 1700000000000
  });
  const enc  = AppStateSync.aesEncrypt(body, keys.valueEncryptionKey);
  const vMac = AppStateSync.valueMac(SyncdProto.SET, enc, keyId, keys.valueMacKey);
  const iMac = crypto.createHmac('sha256', keys.indexKey).update(idxBuf).digest();

  const seen = [];
  AppStateSync.decodeMutations(
    [{ operation: SyncdProto.SET, keyId, indexBlob: iMac,
       valueBlob: Buffer.concat([enc, vMac]) }],
    newState(),
    () => ({ keyData }),
    (m) => seen.push(m),
    true
  );

  assert.equal(seen.length, 1, 'it decoded and verified');
  const m = seen[0];
  assert.deepEqual(m.index, index);
  assert.equal(m.operation, SyncdProto.SET);
  assert.equal(m.action.pinAction.pinned, true);
  assert.equal(m.version, 5, 'the api version the mutation was written under');
  assert.equal(m.indexMac.toString('hex'), iMac.toString('hex'));
  assert.equal(m.valueMac.toString('hex'), vMac.toString('hex'));
});
