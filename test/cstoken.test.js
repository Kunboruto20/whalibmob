'use strict';

// cstoken — the locally-computed fallback token, on the companion path.
//
// Three things are worth pinning: that the salt is decoded out of the
// nctSaltSyncAction app-state mutation, that the derivation is exactly
// HMAC-SHA256(salt, recipient-LID) the way whatsmeow computes it, and that a
// cstoken is withheld in every case the genuine client withholds one.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WhalibmobClient } = require('../lib/Client');
const SyncdProto  = require('../lib/appstate/SyncdProto');
const { describeIndex } = require('../lib/appstate/Mutations');
const { field, varint, bytes, WIRE_LEN, WIRE_VARINT } = require('../lib/proto/MessageProto');

const SALT = crypto.randomBytes(32);

// ─── the salt is decoded out of the mutation ─────────────────────────────────

test('nctSaltSyncAction (field 80) decodes its salt', () => {
  // SyncActionValue { timestamp = 1, nctSaltSyncAction = 80 }
  //   NctSaltSyncAction { salt = 1 }
  const inner = field(1, WIRE_LEN, bytes(SALT));
  const buf   = Buffer.concat([
    field(1,  WIRE_VARINT, varint(1700000000)),
    field(80, WIRE_LEN,    inner)
  ]);

  const decoded = SyncdProto.decodeSyncActionValue(buf);
  assert.ok(decoded.nctSaltSyncAction, 'the action is present');
  assert.equal(decoded.nctSaltSyncAction.salt.toString('hex'), SALT.toString('hex'));
});

test('the app-state index nct_salt_sync is recognised, with no jid', () => {
  const what = describeIndex(['nct_salt_sync']);
  assert.equal(what.kind, 'nct_salt_sync');
  assert.equal(what.jid, undefined);
});

// ─── the derivation matches whatsmeow, exactly ───────────────────────────────

// _csTokenFor reads this._store.nctSalt and this._pnToLid, and calls crypto and
// TcTokenStore — all reachable without a live connection, so a bare object with
// the prototype method is enough to exercise the real code path.
function client(fields) {
  return Object.assign(Object.create(WhalibmobClient.prototype), fields);
}
const withSalt = (extra) => client(Object.assign({
  _store: { nctSalt: SALT.toString('base64') },
  _pnToLid: new Map()
}, extra));

test('cstoken = HMAC-SHA256(salt, recipient LID) for a phone JID with a LID', () => {
  const c = withSalt();
  c._pnToLid.set('40712345678', '99887766554433');   // PN → LID user

  const got      = c._csTokenFor('40712345678@s.whatsapp.net');
  const expected = crypto.createHmac('sha256', SALT).update('99887766554433@lid', 'utf8').digest();

  assert.ok(Buffer.isBuffer(got));
  assert.equal(got.toString('hex'), expected.toString('hex'));
});

test('a recipient already on the LID server is used as-is', () => {
  const c = withSalt();
  const got      = c._csTokenFor('55443322110099:7@lid');   // device part dropped
  const expected = crypto.createHmac('sha256', SALT).update('55443322110099@lid', 'utf8').digest();
  assert.equal(got.toString('hex'), expected.toString('hex'));
});

// ─── it is withheld exactly where the real client withholds it ───────────────

test('no salt on file → no cstoken', () => {
  const c = client({ _store: {}, _pnToLid: new Map() });
  assert.equal(c._csTokenFor('40712345678@s.whatsapp.net'), null);
});

test('a phone JID with no LID mapping → no cstoken', () => {
  const c = withSalt();   // empty _pnToLid
  assert.equal(c._csTokenFor('40712345678@s.whatsapp.net'), null);
});

test('the PSA account and bots get no cstoken', () => {
  const c = withSalt();
  c._pnToLid.set('0', 'x');
  c._pnToLid.set('13135550002', 'y');
  assert.equal(c._csTokenFor('0@s.whatsapp.net'), null, 'PSA');
  assert.equal(c._csTokenFor('13135550002@s.whatsapp.net'), null, 'bot');
});

test('a group JID gets no cstoken', () => {
  const c = withSalt();
  assert.equal(c._csTokenFor('120363000000000000@g.us'), null);
});

test('_nctSalt returns the bytes, or null when unset or empty', () => {
  assert.equal(withSalt()._nctSalt().toString('hex'), SALT.toString('hex'));
  assert.equal(client({ _store: {} })._nctSalt(), null);
  assert.equal(client({ _store: { nctSalt: '' } })._nctSalt(), null);
});
