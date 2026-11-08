'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  generateEphemeralKeyPair,
  buildWrappedEphemeralPub,
  decipherLinkPublicKey,
  buildCompanionFinishBundle,
  sharedKey,
  stripKeyPrefix,
  hkdf
} = require('../lib/PairingCode');
const {
  buildPrimaryHello,
  finishPrimaryFromCompanionBundle,
  buildPairDevicePayload,
  parseCompanionQr,
  allocateCompanionDeviceIndex,
  WA_ADV_ACCOUNT_SIG_PREFIX
} = require('../lib/PrimaryPairing');
const { readFields } = require('../lib/CompanionPairing');
const curveJs = require('../lib/curve');

function identityPair() {
  return generateEphemeralKeyPair();
}

test('wrap/unwrap ephemeral round-trips with a pairing code', async () => {
  const code = 'ABCD2345';
  const eph = generateEphemeralKeyPair();
  const wrapped = await buildWrappedEphemeralPub(code, eph.public);
  assert.equal(wrapped.length, 80);
  const opened = await decipherLinkPublicKey(wrapped, code);
  assert.deepEqual(opened, stripKeyPrefix(eph.public));
});

test('buildPrimaryHello decrypts companion ephemeral and wraps primary', async () => {
  const code = 'XYZW9876';
  const companionEph = generateEphemeralKeyPair();
  const wrappedCompanion = await buildWrappedEphemeralPub(code, companionEph.public);
  const primaryId = identityPair();

  const hello = await buildPrimaryHello({
    pairingCode: code,
    companionWrappedEphemeral: wrappedCompanion,
    primaryIdentityPub: primaryId.public
  });

  assert.deepEqual(hello.companionEphemeralPub, stripKeyPrefix(companionEph.public));
  assert.equal(hello.wrappedPrimaryEphemeral.length, 80);
  assert.equal(hello.primaryIdentityPub.length, 32);

  const openedPrimary = await decipherLinkPublicKey(hello.wrappedPrimaryEphemeral, code);
  assert.deepEqual(openedPrimary, stripKeyPrefix(hello.primaryEphemeralKeyPair.public));
});

test('companion finish and primary finish derive the same adv_secret', async () => {
  const code = 'MNOP3456';
  const companionEph = generateEphemeralKeyPair();
  const companionId = identityPair();
  const primaryId = identityPair();

  const wrappedCompanion = await buildWrappedEphemeralPub(code, companionEph.public);
  const hello = await buildPrimaryHello({
    pairingCode: code,
    companionWrappedEphemeral: wrappedCompanion,
    primaryIdentityPub: primaryId.public
  });

  // Companion side (after receiving primary_hello)
  const companionFinish = await buildCompanionFinishBundle({
    pairingCode: code,
    pairingEphemeralPrivate: companionEph.private,
    primaryEphemeralPubWrapped: hello.wrappedPrimaryEphemeral,
    primaryIdentityPub: hello.primaryIdentityPub,
    identityKeyPair: companionId
  });

  // Primary side (after receiving companion_finish)
  const primaryFinish = finishPrimaryFromCompanionBundle({
    wrappedKeyBundle: companionFinish.wrappedKeyBundle,
    companionIdentityPub: companionId.public,
    companionEphemeralPub: hello.companionEphemeralPub,
    primaryEphemeralPrivate: hello.primaryEphemeralKeyPair.private,
    primaryIdentityKeyPair: primaryId
  });

  assert.equal(
    companionFinish.advSecretKey,
    primaryFinish.advSecretKey.toString('base64')
  );
});

test('buildPairDevicePayload HMAC and account signature verify', () => {
  const primaryId = identityPair();
  const companionId = identityPair();
  const companionNoise = generateEphemeralKeyPair();
  const advSecret = crypto.randomBytes(32);

  const payload = buildPairDevicePayload({
    ref: Buffer.from('3@test-ref', 'utf8'),
    companionNoisePub: companionNoise.public,
    companionIdentityPub: companionId.public,
    advSecret,
    identityKeyPair: primaryId,
    keyIndex: 1,
    validIndexes: [],
    rawId: 1600000001,
    timestamp: 1700000000
  });

  assert.ok(payload.deviceIdentity.length > 0);
  assert.ok(payload.keyIndexList.length > 0);
  assert.equal(payload.pubKey.length, 32);
  assert.equal(payload.keyIndex, 1);

  // Verify HMAC over ADVSignedDeviceIdentity
  const hmacMsg = readFields(payload.deviceIdentity);
  const details = hmacMsg[1];
  const hmac = hmacMsg[2];
  assert.ok(details && hmac);
  const expectedHmac = crypto.createHmac('sha256', advSecret).update(details).digest();
  assert.deepEqual(hmac, expectedHmac);

  // Verify account signature over companion identity
  const account = readFields(details);
  const accountSignatureKey = account[2];
  const accountSignature = account[3];
  const deviceDetails = account[1];
  assert.ok(accountSignatureKey && accountSignature && deviceDetails);

  const accountMsg = Buffer.concat([
    WA_ADV_ACCOUNT_SIG_PREFIX,
    deviceDetails,
    stripKeyPrefix(companionId.public)
  ]);
  assert.ok(
    curveJs.verify(stripKeyPrefix(accountSignatureKey), accountMsg, accountSignature),
    'account signature must verify with primary identity'
  );
});

test('parseCompanionQr accepts CSV and wa.me URL fragment', () => {
  const ref = '3@abc#def';
  const noise = crypto.randomBytes(32).toString('base64');
  const ident = crypto.randomBytes(32).toString('base64');
  const adv = crypto.randomBytes(32).toString('base64');
  const csv = [ref, noise, ident, adv, '1'].join(',');

  const a = parseCompanionQr(csv);
  assert.equal(a.ref.toString('utf8'), ref);
  assert.equal(a.companionNoisePub.length, 32);
  assert.equal(a.platformId, 1);

  const url = 'https://wa.me/settings/linked_devices#' + csv;
  const b = parseCompanionQr(url);
  assert.deepEqual(b.companionNoisePub, a.companionNoisePub);
  assert.deepEqual(b.advSecret, a.advSecret);
});

test('parseCompanionQr rejects malformed input', () => {
  assert.throws(() => parseCompanionQr(''), /empty/);
  assert.throws(() => parseCompanionQr('a,b'), /4 comma/);
  assert.throws(
    () => parseCompanionQr(['r', Buffer.alloc(16).toString('base64'),
      Buffer.alloc(32).toString('base64'),
      Buffer.alloc(32).toString('base64')].join(',')),
    /noise pub/
  );
});

test('allocateCompanionDeviceIndex starts at 1 and advances', () => {
  // validIndexes must include the new companion's own index, otherwise official
  // clients drop the device and never encrypt to it.
  assert.deepEqual(allocateCompanionDeviceIndex([]), { keyIndex: 1, validIndexes: [1] });
  assert.deepEqual(allocateCompanionDeviceIndex([1]), { keyIndex: 2, validIndexes: [1, 2] });
  assert.deepEqual(allocateCompanionDeviceIndex([1, 3]), { keyIndex: 4, validIndexes: [1, 3, 4] });
});

test('shared adv_secret HKDF label matches companion path', () => {
  // Sanity: same inputs → same HKDF output used as adv_secret
  const a = crypto.randomBytes(32);
  const b = crypto.randomBytes(32);
  const r = crypto.randomBytes(32);
  const out1 = hkdf(Buffer.concat([a, b, r]), 32, 'adv_secret');
  const out2 = hkdf(Buffer.concat([a, b, r]), 32, 'adv_secret');
  assert.deepEqual(out1, out2);
});
