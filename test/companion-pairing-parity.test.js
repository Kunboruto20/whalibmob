'use strict';

// Linking as a companion, the parts the reference client does and this did not.
//
//   - a refused pairing-code request is an error, not a code that cannot work
//   - the notification that completes a code has to name the ref that was issued
//   - a pair-success that is turned down is answered, with the reason
//   - prePair can turn a link down before it is confirmed
//   - the phone's identity key is recorded when the link is made
//   - the adv secret is replaced when the server asks, and the QR follows
//   - linking with a passkey, end to end against a stand-in for the phone
//   - the login payload and the history settings carry what the reference sends
//
// No server is involved: the client is a prototype instance over a stub socket,
// and the phone's side of each exchange is computed here with node's own
// crypto, so a mistake in the library's derivations does not check itself.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');
const { createNewWebStore } = require('../lib/WebStore');
const curveJs  = require('../lib/curve');
const Passkey  = require('../lib/PasskeyPairing');
const { configureSuccessfulPairing, buildPairErrorReply, PAIR_ERROR } = require('../lib/CompanionPairing');
const { encodeCompanionLoginPayload, encodeCompanionRegisterPayload, encodeHistorySyncConfig } =
  require('../lib/webproto');
const { stripKeyPrefix, bytesToCrockford } = require('../lib/PairingCode');

const SERVER = 's.whatsapp.net';
const PHONE  = '40712345678';

const child = (node, desc) =>
  (Array.isArray(node && node.content) ? node.content.find(c => c.description === desc) : null) || null;

// ─── a client with no network ────────────────────────────────────────────────

function client(opts) {
  opts = opts || {};
  const sent = [], iqs = [], emitted = [], identities = {};
  let n = 0;
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _mode:    'web',
    _store:   createNewWebStore(PHONE),
    _socket:  { secured: true, sendNode: (node) => sent.push(node) },
    _lidToPn: new Map(),
    _pnToLid: new Map(),
    _serverTimeOffsetMs: 0,
    _signal:  { store: { saveIdentity: async (id, key) => { identities[id] = Buffer.from(key); } } },
    _genMsgId: () => 'IQ' + (++n),
    _sendIq:  async (node) => { iqs.push(node); return opts.reply ? opts.reply(node) : ok(node); }
  });
  c.emit = (name, payload) => { emitted.push({ name, payload }); return true; };
  Object.assign(c, { sent, iqs, emitted, identities });
  c.events = (name) => emitted.filter(e => e.name === name).map(e => e.payload);
  return c;
}

const ok = (node, children) =>
  new BinaryNode('iq', { type: 'result', id: node.attrs.id, from: SERVER }, children || null);
const refused = (node, code, text) =>
  new BinaryNode('iq', { type: 'error', id: node.attrs.id, from: SERVER },
    [new BinaryNode('error', { code: String(code), text }, null)]);
const codeReply = (ref) => (node) => ok(node, [
  new BinaryNode('link_code_companion_reg', {}, [
    new BinaryNode('link_code_pairing_ref', {}, Buffer.from(ref))
  ])
]);

// ─── protobuf, written out by hand ───────────────────────────────────────────

function varint(v) {
  const out = [];
  do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
const lenField = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
const intField = (num, v)   => Buffer.concat([varint(num << 3), varint(v)]);

function keyPair() {
  const kp = curveJs.generateKeyPair(crypto.randomBytes(32));
  return { private: Buffer.from(kp.private), public: Buffer.from(kp.public) };
}

// X25519 with node's crypto, not the library's curve.
function x25519(priv32, pub32) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), priv32]),
    format: 'der', type: 'pkcs8'
  });
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), pub32]),
    format: 'der', type: 'spki'
  });
  return crypto.diffieHellman({ privateKey, publicKey });
}

// A pair-success as the phone would issue it for this store.
function pairSuccess(store, opts) {
  opts = opts || {};
  const primary = opts.primary || keyPair();
  const deviceDetails = Buffer.concat([intField(1, 1234), intField(2, 1700000000), intField(3, 7)]);
  const ourIdentity = stripKeyPrefix(store.identityKeyPair.public);
  const accountSignature = Buffer.from(curveJs.sign(primary.private,
    Buffer.concat([Buffer.from([6, 0]), deviceDetails, opts.signFor || ourIdentity])));
  const identity = Buffer.concat([
    lenField(1, deviceDetails),
    lenField(2, stripKeyPrefix(primary.public)),
    lenField(3, accountSignature)
  ]);
  const hmac = crypto.createHmac('sha256', opts.hmacKey || Buffer.from(store.advSecretKey, 'base64'))
    .update(identity).digest();
  const node = new BinaryNode('iq', { id: 'PAIR1', from: SERVER, type: 'set', t: '1700000100' }, [
    new BinaryNode('pair-success', {}, [
      new BinaryNode('device-identity', {}, Buffer.concat([lenField(1, identity), lenField(2, hmac)])),
      new BinaryNode('platform', { name: 'android' }, null),
      new BinaryNode('device', { jid: PHONE + ':7@s.whatsapp.net', lid: '112713111982325:7@lid' }, null)
    ])
  ]);
  return { node, primary };
}

// ─── the pairing code ────────────────────────────────────────────────────────

test('a pairing code is handed out only once the server has taken the request', async () => {
  const c = client({ reply: codeReply('REF-ONE') });
  const code = await c.requestPairingCode(PHONE);

  assert.equal(code.length, 8);
  assert.equal(c.iqs.length, 1, 'the request waits for its answer');
  assert.equal(child(c.iqs[0], 'link_code_companion_reg').attrs.stage, 'companion_hello');
  assert.equal(c._store.pairingRef, 'REF-ONE');
  assert.deepEqual(c.events('pairing_code'), [{ code, phoneNumber: PHONE }]);
});

test('a refused pairing-code request throws and leaves no code behind', async () => {
  const c = client({ reply: (node) => refused(node, 429, 'rate-overlimit') });
  await assert.rejects(c.requestPairingCode(PHONE), (err) => {
    assert.equal(err.code, 'PAIRING_CODE_REFUSED');
    assert.equal(err.serverCode, '429');
    assert.match(err.message, /too many pairing codes/);
    return true;
  });
  assert.equal(c._store.pairingCode, null);
  assert.deepEqual(c.events('pairing_code'), [], 'no code is announced for a refused request');

  const bad = client({ reply: (node) => refused(node, 400, 'bad-request') });
  await assert.rejects(bad.requestPairingCode(PHONE), /\(400\).*browser name/);
});

test('a pairing-code request with no answer, or no ref in it, throws', async () => {
  const silent = client({ reply: () => null });
  await assert.rejects(silent.requestPairingCode(PHONE), { code: 'PAIRING_CODE_NO_RESPONSE' });

  const empty = client({ reply: (node) => ok(node) });
  await assert.rejects(empty.requestPairingCode(PHONE), { code: 'PAIRING_CODE_NO_REF' });
});

function finishNotification(ref) {
  return new BinaryNode('notification', { from: SERVER, type: 'link_code_companion_reg', id: 'N1' }, [
    new BinaryNode('link_code_companion_reg', {}, [
      new BinaryNode('link_code_pairing_ref', {}, Buffer.from(ref)),
      new BinaryNode('primary_identity_pub', {}, stripKeyPrefix(keyPair().public)),
      new BinaryNode('link_code_pairing_wrapped_primary_ephemeral_pub', {}, crypto.randomBytes(80))
    ])
  ]);
}

test('a completion that names another ref does not touch the adv secret', async () => {
  const c = client({ reply: codeReply('REF-ONE') });
  await c.requestPairingCode(PHONE);
  c.iqs.length = 0;

  await c._handleCompanionFinish(finishNotification('REF-OTHER'));
  assert.equal(c._store.advSecretKey, null);
  assert.equal(c.iqs.length, 0, 'nothing is sent for a notification that is not ours');
  assert.match(c.events('error')[0].message, /another pairing request/);

  await c._handleCompanionFinish(finishNotification('REF-ONE'));
  assert.ok(c._store.advSecretKey, 'the matching ref goes through');
  assert.equal(child(c.iqs[0], 'link_code_companion_reg').attrs.stage, 'companion_finish');
});

test('a completion with no code pending is ignored', async () => {
  const c = client();
  await c._handleCompanionFinish(finishNotification('REF-ONE'));
  assert.equal(c._store.advSecretKey, null);
  assert.equal(c.iqs.length, 0);
});

// ─── pair-success ────────────────────────────────────────────────────────────

test('an accepted pair-success links, and records the phone as device 0', async () => {
  const c = client();
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  const { node, primary } = pairSuccess(c._store);

  await c._handlePairSuccess(node);

  assert.equal(c._store.registered, true);
  assert.equal(c.events('paired')[0].jid, PHONE + ':7@s.whatsapp.net');
  const reply = c.sent.find(s => s.description === 'iq');
  assert.equal(reply.attrs.type, 'result');
  assert.ok(child(reply, 'pair-device-sign'));
  // The 33-byte form the session code compares against.
  assert.deepEqual(c.identities['112713111982325.0'],
    Buffer.concat([Buffer.from([5]), stripKeyPrefix(primary.public)]));
  assert.equal(c._serverTimeOffsetMs !== 0, true, 'the server clock is read off the stanza');
});

test('a pair-success under the wrong adv secret is answered with hmac-mismatch', async () => {
  const c = client();
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  const { node } = pairSuccess(c._store, { hmacKey: crypto.randomBytes(32) });

  await c._handlePairSuccess(node);

  assert.equal(c._store.registered, false);
  const reply = c.sent[0];
  assert.deepEqual(reply.attrs, { to: SERVER, type: 'error', id: 'PAIR1' });
  assert.deepEqual(child(reply, 'error').attrs, { code: '401', text: 'hmac-mismatch' });
  assert.equal(c.events('pair_error').length, 1);
  assert.equal(c.events('paired').length, 0);
  assert.deepEqual(c.identities, {});
});

test('a pair-success signed for another identity is answered with signature-mismatch', async () => {
  const c = client();
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  const { node } = pairSuccess(c._store, { signFor: crypto.randomBytes(32) });

  await c._handlePairSuccess(node);

  assert.deepEqual(child(c.sent[0], 'error').attrs, { code: '401', text: 'signature-mismatch' });
  assert.equal(c._store.registered, false);
});

test('a pair-success that cannot be read is answered with internal-error', async () => {
  const c = client();
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  await c._handlePairSuccess(new BinaryNode('iq', { id: 'PAIR1', from: SERVER }, [
    new BinaryNode('pair-success', {}, [])
  ]));
  assert.deepEqual(child(c.sent[0], 'error').attrs, { code: '500', text: 'internal-error' });

  assert.throws(() => configureSuccessfulPairing(new BinaryNode('iq', { id: 'X' }, []), {}, BinaryNode),
    (err) => err.pairError === PAIR_ERROR.INTERNAL);
  assert.deepEqual(child(buildPairErrorReply('X', undefined, BinaryNode), 'error').attrs,
    { code: '500', text: 'internal-error' });
});

test('prePair sees who is linking and can turn it down', async () => {
  const seen = [];
  const c = client();
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  c._prePair = async (info) => { seen.push(info); return false; };

  await c._handlePairSuccess(pairSuccess(c._store).node);

  assert.deepEqual(seen, [{
    jid: PHONE + ':7@s.whatsapp.net', lid: '112713111982325:7@lid',
    platform: 'android', businessName: null
  }]);
  assert.equal(c._store.registered, false);
  assert.deepEqual(child(c.sent[0], 'error').attrs, { code: '500', text: 'internal-error' });
  assert.equal(c.events('pair_error')[0].err.code, 'PAIR_REJECTED_LOCALLY');

  const yes = client();
  yes._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  yes._prePair = () => true;
  await yes._handlePairSuccess(pairSuccess(yes._store).node);
  assert.equal(yes._store.registered, true);
});

// ─── the adv secret ──────────────────────────────────────────────────────────

const notification = (type, children, from) =>
  new BinaryNode('notification', { from: from || SERVER, type, id: 'N1' }, children);

test('a refresh from the server replaces the adv secret and redraws the QR', (t) => {
  const c = client();
  t.after(() => c._stopQrRotation());
  c._startQrRotation(['ref-a', 'ref-b']);
  const before = c._store.advSecretKey;
  assert.equal(c.events('qr').length, 1);
  assert.ok(c.events('qr')[0].qr.includes(before));

  c._handleNotification(notification('companion_reg_refresh',
    [new BinaryNode('companion_reg_refresh', {}, null)]));

  const after = c._store.advSecretKey;
  assert.notEqual(after, before);
  const qrs = c.events('qr');
  assert.equal(qrs.length, 2, 'the QR on screen is shown again');
  assert.equal(qrs[1].ref, 'ref-a', 'same ref, it has not expired');
  assert.ok(qrs[1].qr.includes(after) && !qrs[1].qr.includes(before));
  assert.ok(qrs[1].ttlMs <= 60000);

  c._handleNotification(notification('companion_reg_refresh',
    [new BinaryNode('pair-device-rotate-qr', {}, null)]));
  assert.notEqual(c._store.advSecretKey, after, 'the other spelling rotates too');
});

test('a refresh is ignored from anyone but the server, and once linked', () => {
  const c = client();
  c._store.advSecretKey = 'c2VjcmV0';
  c._handleNotification(notification('companion_reg_refresh',
    [new BinaryNode('companion_reg_refresh', {}, null)], '40700000000@s.whatsapp.net'));
  assert.equal(c._store.advSecretKey, 'c2VjcmV0');

  c._handleNotification(notification('companion_reg_refresh', [new BinaryNode('something_else', {}, null)]));
  assert.equal(c._store.advSecretKey, 'c2VjcmV0');

  c._store.registered = true;
  c._handleNotification(notification('companion_reg_refresh',
    [new BinaryNode('companion_reg_refresh', {}, null)]));
  assert.equal(c._store.advSecretKey, 'c2VjcmV0');
});

// ─── passkey: the pieces ─────────────────────────────────────────────────────

test('the prologue commits to the ephemeral identity and the nonce', () => {
  const kp = keyPair(), nonce = crypto.randomBytes(32);
  const { prologuePayload, companionNonce } = Passkey.buildPrologue({ ref: 'the-ref', deviceType: 1, keyPair: kp, nonce });

  const identity = Buffer.concat([
    lenField(1, stripKeyPrefix(kp.public)), intField(2, 1), lenField(3, Buffer.from('the-ref'))
  ]);
  const commitment = crypto.createHash('sha256').update(Buffer.concat([identity, nonce])).digest();
  assert.deepEqual(prologuePayload, Buffer.concat([lenField(1, identity), lenField(2, lenField(1, commitment))]));
  assert.deepEqual(companionNonce, nonce);
});

test('both sides of a passkey exchange reach the same key and the same code', () => {
  const companion = keyPair(), primary = keyPair();
  const companionNonce = crypto.randomBytes(32), primaryNonce = crypto.randomBytes(32);
  const primaryPub = stripKeyPrefix(primary.public);

  const ours = Passkey.deriveContinuation({
    ephemeralPrivate: companion.private, primaryPublicKey: primaryPub, primaryNonce,
    companionNonce, deviceType: 1, ref: 'the-ref'
  });

  // The phone's side, from its own private key.
  const shared = x25519(stripKeyPrefix(primary.private), stripKeyPrefix(companion.public));
  const theirKey = Buffer.from(crypto.hkdfSync('sha256', shared,
    Buffer.from('Companion Pairing 1 with ref the-ref'),
    Buffer.from('Pairing Information Encryption Key'), 32));
  assert.deepEqual(ours.encryptionKey, theirKey);

  const digest = crypto.createHash('sha256').update(Buffer.concat([companionNonce, primaryPub])).digest();
  const bytes = Buffer.from([0, 1, 2, 3, 4].map(i => primaryNonce[i] ^ digest[i]));
  const encoded = bytesToCrockford(bytes);
  assert.equal(ours.code, encoded.slice(0, 4) + '-' + encoded.slice(4));
  assert.match(ours.code, /^[1-9A-HJ-NP-TV-Z]{4}-[1-9A-HJ-NP-TV-Z]{4}$/);
});

test('the pairing request opens under the exchanged key and carries the three keys', () => {
  const encryptionKey = crypto.randomBytes(32), advSecret = crypto.randomBytes(32);
  const noise = keyPair(), identity = keyPair();
  const wrapped = Passkey.readFields(Passkey.buildEncryptedPairingRequest({
    encryptionKey, noisePublicKey: noise.public, identityPublicKey: identity.public, advSecret
  }));
  const sealed = wrapped[1], iv = wrapped[2];
  assert.equal(iv.length, 12);

  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  d.setAuthTag(sealed.slice(-16));
  const plain = Passkey.readFields(Buffer.concat([d.update(sealed.slice(0, -16)), d.final()]));
  assert.deepEqual(plain[1], stripKeyPrefix(noise.public));
  assert.deepEqual(plain[2], stripKeyPrefix(identity.public));
  assert.deepEqual(plain[3], advSecret);
});

test('the handoff key is HKDF over the old adv secret, and the proof an HMAC under it', () => {
  const advSecret = crypto.randomBytes(32), payload = crypto.randomBytes(40);
  const key = Passkey.deriveHandoffKey(advSecret);
  assert.deepEqual(key, Buffer.from(crypto.hkdfSync('sha256', advSecret, Buffer.alloc(0),
    Buffer.from('shortcake-passkey-handoff-v1'), 32)));
  assert.deepEqual(Passkey.handoffProof(key, payload),
    crypto.createHmac('sha256', key).update(payload).digest());
});

test('an assertion is normalised to unpadded base64url, whatever it came in as', () => {
  const rawId = Buffer.from([0xfb, 0xff, 0xfe, 1, 2]);
  const expected = {
    id: rawId.toString('base64url'), rawId: rawId.toString('base64url'), type: 'public-key',
    response: { clientDataJSON: 'e30', authenticatorData: '-_8', signature: 'AQID', userHandle: null }
  };

  const fromBytes = Passkey.encodeWebAuthnResponse({
    rawId, response: {
      clientDataJSON: Buffer.from('{}'), authenticatorData: new Uint8Array([0xfb, 0xff]),
      signature: Uint8Array.from([1, 2, 3]).buffer
    }
  });
  assert.deepEqual(JSON.parse(fromBytes.json.toString()), expected);
  assert.deepEqual(fromBytes.credentialId, rawId);
  assert.deepEqual(Object.keys(JSON.parse(fromBytes.json.toString())), ['id', 'rawId', 'type', 'response']);

  // What a browser's credential.toJSON() gives, and padded standard base64.
  const fromJson = Passkey.encodeWebAuthnResponse({
    id: expected.id, rawId: expected.rawId, type: 'public-key',
    response: { clientDataJSON: 'e30=', authenticatorData: '+/8=', signature: 'AQID', userHandle: 'dXNlcg' }
  });
  assert.deepEqual(JSON.parse(fromJson.json.toString()),
    Object.assign({}, expected, { response: Object.assign({}, expected.response, { userHandle: 'dXNlcg' }) }));

  assert.throws(() => Passkey.encodeWebAuthnResponse({ rawId, response: { clientDataJSON: 'e30' } }),
    /authenticatorData is missing/);
  assert.throws(() => Passkey.encodeWebAuthnResponse({ rawId: 'not base64!', response: {} }), /not base64/);
  assert.throws(() => Passkey.encodeWebAuthnResponse(null), /assertion object is required/);
});

test('request options are read as JSON and need a challenge', () => {
  const options = { challenge: 'abc', rpId: 'whatsapp.com', allowCredentials: [], userVerification: 'required' };
  assert.deepEqual(Passkey.parseRequestOptions(Buffer.from(JSON.stringify(options))), options);
  assert.throws(() => Passkey.parseRequestOptions(Buffer.from('{')), /not valid JSON/);
  assert.throws(() => Passkey.parseRequestOptions(Buffer.from('{"rpId":"x"}')), /no challenge/);
  assert.throws(() => Passkey.parseRequestOptions(null), /missing/);
});

test('a primary identity of the wrong size is refused', () => {
  const good = Buffer.concat([lenField(1, crypto.randomBytes(32)), lenField(2, crypto.randomBytes(32))]);
  assert.equal(Passkey.decodePrimaryEphemeralIdentity(good).nonce.length, 32);
  assert.throws(() => Passkey.decodePrimaryEphemeralIdentity(
    Buffer.concat([lenField(1, crypto.randomBytes(31)), lenField(2, crypto.randomBytes(32))])), /public key length 31/);
  assert.throws(() => Passkey.decodePrimaryEphemeralIdentity(lenField(1, crypto.randomBytes(32))), /nonce length 0/);
});

// ─── passkey: the whole link ─────────────────────────────────────────────────

const OPTIONS = { challenge: 'Y2hhbGxlbmdl', rpId: 'whatsapp.com', timeout: 60000, allowCredentials: [] };
const ASSERTION = {
  id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AAEC', signature: 'AQID' }
};
const passkeyReply = (node) => {
  const first = node.content[0];
  if (first.description === 'ref') return ok(node, [new BinaryNode('ref', {}, Buffer.from('companion-ref'))]);
  return ok(node);
};
const flush = () => new Promise(r => setImmediate(r));

test('a passkey link, from the request to the pairing request', async () => {
  const c = client({ reply: passkeyReply });
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  const qrSecret = Buffer.from(c._store.advSecretKey, 'base64');

  // 1. the server asks
  c._handleNotification(notification('passkey_prologue_request',
    [new BinaryNode('passkey_request_options', {}, Buffer.from(JSON.stringify(OPTIONS)))]));
  await flush();
  assert.deepEqual(c.events('passkey_request'), [{ publicKey: OPTIONS }]);
  const advSecret = Buffer.from(c._store.advSecretKey, 'base64');
  assert.notDeepEqual(advSecret, qrSecret, 'the adv secret is replaced');

  // 2. the assertion goes out with a commitment and a handoff proof
  await c.sendPasskeyResponse(ASSERTION);
  assert.deepEqual(c.iqs.map(n => [n.attrs.type, n.attrs.xmlns, n.content[0].description]),
    [['get', 'md', 'ref'], ['set', 'md', 'passkey_prologue']]);
  const prologue = c.iqs[1].content[0];
  assert.deepEqual(prologue.content.map(n => n.description),
    ['credential_id', 'webauthn_assertion', 'prologue_payload', 'pairing_handoff_proof']);
  assert.deepEqual(child(prologue, 'credential_id').content, Buffer.from('cred'));
  assert.equal(JSON.parse(child(prologue, 'webauthn_assertion').content.toString()).response.userHandle, null);
  const payload = child(prologue, 'prologue_payload').content;
  assert.deepEqual(child(prologue, 'pairing_handoff_proof').content,
    crypto.createHmac('sha256', Passkey.deriveHandoffKey(qrSecret)).update(payload).digest());

  const identity = Passkey.readFields(Passkey.readFields(payload)[1]);
  assert.equal(identity[2], 1, 'Chrome');
  assert.equal(identity[3].toString(), 'companion-ref');
  const companionPub = identity[1];

  // 3. the phone answers; we reveal the nonce and both derive the code
  const primary = keyPair(), primaryNonce = crypto.randomBytes(32);
  const primaryPub = stripKeyPrefix(primary.public);
  c._passkeyAutoConfirm = false;
  c._handleNotification(notification('crsc_continuation', [
    new BinaryNode('primary_ephemeral_identity', {},
      Buffer.concat([lenField(1, primaryPub), lenField(2, primaryNonce)]))
  ]));
  await flush();
  assert.deepEqual(c.events('passkey_error'), []);

  const nonceIq = c.iqs[2].content[0];
  assert.equal(nonceIq.description, 'companion_nonce');
  // The revealed nonce opens the commitment sent in step 2.
  assert.deepEqual(
    crypto.createHash('sha256').update(Buffer.concat([Passkey.readFields(payload)[1], nonceIq.content])).digest(),
    Passkey.readFields(Passkey.readFields(payload)[2])[1]);

  const digest = crypto.createHash('sha256').update(Buffer.concat([nonceIq.content, primaryPub])).digest();
  const encoded = bytesToCrockford(Buffer.from([0, 1, 2, 3, 4].map(i => primaryNonce[i] ^ digest[i])));
  assert.deepEqual(c.events('passkey_confirmation'),
    [{ code: encoded.slice(0, 4) + '-' + encoded.slice(4), skipHandoffUx: true, autoConfirmed: false }]);
  assert.equal(c.iqs.length, 3, 'nothing more is sent until the caller confirms');

  // 4. confirmed: the keys go over, sealed for the phone
  await c.sendPasskeyConfirmation();
  const request = Passkey.readFields(c.iqs[3].content[0].content);
  assert.equal(c.iqs[3].content[0].description, 'encrypted_pairing_request');
  const key = Buffer.from(crypto.hkdfSync('sha256',
    x25519(stripKeyPrefix(primary.private), companionPub),
    Buffer.from('Companion Pairing 1 with ref companion-ref'),
    Buffer.from('Pairing Information Encryption Key'), 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key, request[2]);
  d.setAuthTag(request[1].slice(-16));
  const plain = Passkey.readFields(Buffer.concat([d.update(request[1].slice(0, -16)), d.final()]));
  assert.deepEqual(plain[1], stripKeyPrefix(c._store.noiseKeyPair.public));
  assert.deepEqual(plain[2], stripKeyPrefix(c._store.identityKeyPair.public));
  assert.deepEqual(plain[3], advSecret);

  await assert.rejects(c.sendPasskeyConfirmation(), { code: 'PASSKEY_NOT_PENDING' });

  // 5. and the pair-success that follows verifies under the new secret
  await c._handlePairSuccess(pairSuccess(c._store).node);
  assert.equal(c._store.registered, true);
});

test('with a handoff proof the confirmation is sent without asking', async () => {
  const c = client({ reply: passkeyReply });
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  c._handleNotification(notification('passkey_prologue_request',
    [new BinaryNode('passkey_request_options', {}, Buffer.from(JSON.stringify(OPTIONS)))]));
  await flush();
  await c.sendPasskeyResponse(ASSERTION);
  c._handleNotification(notification('crsc_continuation', [
    new BinaryNode('primary_ephemeral_identity', {},
      Buffer.concat([lenField(1, stripKeyPrefix(keyPair().public)), lenField(2, crypto.randomBytes(32))]))
  ]));
  await flush(); await flush();

  assert.equal(c.events('passkey_confirmation')[0].autoConfirmed, true);
  assert.equal(c.iqs[3].content[0].description, 'encrypted_pairing_request');
});

test('a handoff key that has gone stale is not used, and the code must be confirmed', async () => {
  const c = client({ reply: passkeyReply });
  c._store.advSecretKey = crypto.randomBytes(32).toString('base64');
  c._handleNotification(notification('passkey_prologue_request',
    [new BinaryNode('passkey_request_options', {}, Buffer.from(JSON.stringify(OPTIONS)))]));
  await flush();
  c._passkeyHandoff.at = Date.now() - Passkey.HANDOFF_TTL_MS - 1;

  await c.sendPasskeyResponse(ASSERTION);
  assert.equal(child(c.iqs[1].content[0], 'pairing_handoff_proof'), null);

  c._handleNotification(notification('crsc_continuation', [
    new BinaryNode('primary_ephemeral_identity', {},
      Buffer.concat([lenField(1, stripKeyPrefix(keyPair().public)), lenField(2, crypto.randomBytes(32))]))
  ]));
  await flush(); await flush();
  assert.deepEqual(c.events('passkey_confirmation').map(e => [e.skipHandoffUx, e.autoConfirmed]), [[false, false]]);
  assert.equal(c.iqs.length, 3);
});

test('unreadable options in the push are fetched instead', async () => {
  const c = client({
    reply: (node) => node.content[0].description === 'passkey_request_options'
      ? ok(node, [new BinaryNode('passkey_request_options', {}, Buffer.from(JSON.stringify(OPTIONS)))])
      : ok(node)
  });
  c._handleNotification(notification('passkey_prologue_request', []));
  await flush(); await flush();
  assert.deepEqual(c.iqs.map(n => [n.attrs.type, n.content[0].description]), [['get', 'passkey_request_options']]);
  assert.deepEqual(c.events('passkey_request'), [{ publicKey: OPTIONS }]);

  const broken = client({ reply: (node) => refused(node, 500, 'internal-server-error') });
  broken._handleNotification(notification('passkey_prologue_request', []));
  await flush(); await flush();
  assert.equal(broken.events('passkey_request').length, 0);
  assert.equal(broken.events('passkey_error')[0].continuation, false);
});

test('passkey steps out of order, or refused, say so', async () => {
  const c = client({ reply: passkeyReply });
  await assert.rejects(c.sendPasskeyConfirmation(), { code: 'PASSKEY_NOT_PENDING' });

  c._handleNotification(notification('crsc_continuation', [
    new BinaryNode('primary_ephemeral_identity', {}, Buffer.alloc(0))
  ]));
  await flush();
  assert.deepEqual(c.events('passkey_error').map(e => [e.err.code, e.continuation]), [['PASSKEY_NOT_PENDING', true]]);

  await c.sendPasskeyResponse(ASSERTION);
  await assert.rejects(c.sendPasskeyConfirmation(), { code: 'PASSKEY_NOT_READY' });

  const refusing = client({ reply: (node) => refused(node, 401, 'not-authorized') });
  await assert.rejects(refusing.sendPasskeyResponse(ASSERTION), (err) => {
    assert.equal(err.code, 'PASSKEY_REFUSED');
    assert.equal(err.serverCode, '401');
    return true;
  });

  const linked = client();
  linked._store.registered = true;
  await assert.rejects(linked.sendPasskeyResponse(ASSERTION), { code: 'PASSKEY_ALREADY_LINKED' });
  linked._handleNotification(notification('passkey_prologue_request',
    [new BinaryNode('passkey_request_options', {}, Buffer.from(JSON.stringify(OPTIONS)))]));
  await flush();
  assert.equal(linked.events('passkey_request').length, 0, 'a linked session ignores the request');

  const mobile = client();
  mobile._mode = 'mobile';
  await assert.rejects(mobile.sendPasskeyResponse(ASSERTION), { code: 'PASSKEY_WRONG_MODE' });
});

// ─── what the payloads announce ──────────────────────────────────────────────

const base = () => {
  const s = createNewWebStore(PHONE);
  return {
    version: [2, 3000, 1], browser: ['Ubuntu', 'Chrome', '120'], registrationId: s.registrationId,
    identityKeyPair: s.identityKeyPair, signedPreKey: s.signedPreKey
  };
};

test('the login payload says the chats are kept by LID, unless told otherwise', () => {
  const login = Passkey.readFields(encodeCompanionLoginPayload(
    Object.assign(base(), { username: PHONE, device: 7 })));
  assert.equal(login[41], 1, 'lidDbMigrated');
  assert.equal(login[24], 1, 'lc');
  assert.equal(login[18], 7);
  assert.equal(login[3], 1, 'passive');

  const off = Passkey.readFields(encodeCompanionLoginPayload(
    Object.assign(base(), { username: PHONE, device: 7, lidDbMigrated: false })));
  assert.equal(off[41], 0);

  const register = Passkey.readFields(encodeCompanionRegisterPayload(base()));
  assert.equal(register[41], undefined, 'not on the registration payload');
});

test('the history settings ask for call logs, group history and thumbnails', () => {
  const config = Passkey.readFields(encodeHistorySyncConfig());
  assert.equal(config[6], 1, 'supportCallLogHistory');
  assert.equal(config[15], 1, 'supportGroupHistory');
  assert.equal(config[19], 60, 'thumbnailSyncDaysLimit');
  assert.equal(config[21], 1, 'supportManusHistory');
  assert.equal(config[22], 1, 'supportHatchHistory');
  assert.equal(config[3], 10240);

  const off = Passkey.readFields(encodeHistorySyncConfig({
    supportCallLogHistory: false, supportGroupHistory: false, thumbnailSyncDaysLimit: 0
  }));
  assert.deepEqual([off[6], off[15], off[19]], [0, 0, 0]);
});
