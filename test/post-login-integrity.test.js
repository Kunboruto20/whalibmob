'use strict';

// Post-login integrity_payload and the ClientPayload fields a real client
// always announces (sessionId 9, lc 24, yearClass 36, memClass 37).
//
// integrity_payload is the blob handed over in <ib><integrity_payload> in answer
// to the server's SafetyNet nonce. It is the same AES-256-CBC envelope as the
// registration _gi (key SHA256(std-base64(authkey)), IV‖ciphertext, PKCS7), but
// the plaintext JSON has a fixed, wider key order and nests _ge and _ga as
// objects. The live key order (reverse of 2.26.37.73) is checked exactly.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const attestation = require('../lib/Attestation');
const { encodeClientPayload } = require('../lib/proto');

function sampleMaterial() {
  return {
    packageName:       'com.whatsapp',
    classesDexSha256:  crypto.randomBytes(32),
    apkSize:           129472282,
    apkSha256Full:     crypto.randomBytes(32),
    apkSha256First10M: crypto.randomBytes(32),
    gpHash:            'XpccAx8EKQswlTL2MtpCnGIMXTCaUbAf95ElLECc6jk=',
    certificates:      [crypto.randomBytes(300)]
  };
}

function decryptEnvelope(blob, authKeyRaw) {
  const key = crypto.createHash('sha256')
    .update(Buffer.from(authKeyRaw.toString('base64'), 'utf8')).digest();
  const raw = Buffer.from(blob, 'base64');
  const d   = crypto.createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16));
  return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
}

test('integrity_payload decrypts with the shared envelope key', () => {
  const authKeyRaw = crypto.randomBytes(32);
  const blob = attestation.generateIntegrityPayload({
    authKeyRaw, material: sampleMaterial(),
    aid: crypto.randomBytes(32).toString('base64'),
    serverNonce: 'ATbE74Q57yF6lIkJ5w6BK8vaZoMQS1TZjH_NbI4AciTkxFV2'
  });
  assert.equal(typeof blob, 'string');
  // standard base64, not URL-safe, no percent-encoding
  assert.match(blob, /^[A-Za-z0-9+/]+=*$/);

  const json = decryptEnvelope(blob, authKeyRaw);
  assert.ok(JSON.parse(json.replace(/\\\//g, '/')), 'decrypts to valid JSON');
});

test('integrity_payload uses the exact live key order', () => {
  const authKeyRaw = crypto.randomBytes(32);
  const nonce = 'ATbE74Q57yF6lIkJ5w6BK8vaZoMQS1TZjH_NbI4AciTkxFV2';
  const blob = attestation.generateIntegrityPayload({
    authKeyRaw, material: sampleMaterial(),
    aid: crypto.randomBytes(32).toString('base64'), serverNonce: nonce
  });
  const json = decryptEnvelope(blob, authKeyRaw);

  // Top-level keys in order; _ge and _ga are nested objects, not flat params.
  const topKeys = [...json.matchAll(/(?:^|[{,])"(_?[a-z]+)":/g)].map(m => m[1]);
  // The first occurrence of each distinct top-level key, in order.
  const order = [];
  for (const k of topKeys) if (!order.includes(k)) order.push(k);
  // sb/sv (inside _ge) and bi/ap/ai/mp/ae/mu (inside _ga) are nested — drop them.
  const nested = new Set(['sb', 'sv', 'bi', 'ap', 'ai', 'mp', 'ae', 'mu']);
  const top = order.filter(k => !nested.has(k));

  assert.deepEqual(top, [
    'aid', '_dh', '_lh', '_iln', '_ln', '_ge', '_gp', '_ga',
    '_ip', '_isb', '_n', '_icr', '_is'
  ]);

  // The server nonce is echoed in plaintext as _n, binding the blob to the request.
  assert.ok(json.includes('"_n":"' + nonce + '"'));
  assert.ok(json.includes('"_ge":{"sb":false,"sv":false}'));
});

test('integrity_payload is omitted when material or identity is missing', () => {
  const authKeyRaw = crypto.randomBytes(32);
  assert.equal(attestation.generateIntegrityPayload({
    authKeyRaw, aid: 'x', serverNonce: 'y'
  }), null, 'no material');
  assert.equal(attestation.generateIntegrityPayload({
    authKeyRaw, material: sampleMaterial(), serverNonce: 'y'
  }), null, 'no aid');
  assert.equal(attestation.generateIntegrityPayload({
    authKeyRaw, material: sampleMaterial(), aid: 'x'
  }), null, 'no nonce');
  assert.equal(attestation.generateIntegrityPayload({
    authKeyRaw: Buffer.alloc(10), material: sampleMaterial(), aid: 'x', serverNonce: 'y'
  }), null, 'bad authkey');
});

test('the _ga token still percent-encodes its inner object', () => {
  const token = attestation.generateGaToken(crypto.randomBytes(32));
  assert.ok(token.startsWith('%7B%22bi%22'), 'still a percent-encoded JSON object');
  const obj = JSON.parse(decodeURIComponent(token).replace(/\\\//g, '/'));
  for (const k of ['bi', 'ap', 'ai', 'mp', 'ae', 'mu']) assert.ok(k in obj, 'has ' + k);
});

function fieldNumbers(buf) {
  let o = 0; const fields = [];
  const rv = () => { let r = 0n, s = 0n; while (o < buf.length) { const b = buf[o++]; r |= (BigInt(b) & 0x7fn) << s; if (!(b & 0x80)) break; s += 7n; } return r; };
  while (o < buf.length) {
    const t = rv(); const f = Number(t >> 3n), w = Number(t & 7n);
    if (w === 2) { o += Number(rv()); } else if (w === 0) { rv(); } else if (w === 5) { o += 4; } else if (w === 1) { o += 8; }
    fields.push(f);
  }
  return fields;
}

test('ClientPayload announces sessionId, lc, yearClass and memClass', () => {
  const ua = {
    platform: 0, version: '2.26.35.75', mcc: '234', mnc: '15', osVersion: '14',
    manufacturer: 'Samsung', device: 'SM-A325F', osBuildNumber: 'TP1A', phoneId: 'X',
    releaseChannel: 0, localeLanguage: 'en', localeCountry: 'GB',
    deviceType: 0, deviceModelType: 'SM-A325F'
  };
  const buf = encodeClientPayload({
    username: 40712345678n, passive: false, userAgent: ua, pushName: null,
    sessionId: 123456, shortConnect: false, connectType: 1, connectReason: 1,
    connectAttemptCount: 0, device: 0, oc: false, lc: 0, yearClass: 2015, memClass: 192
  });
  const fields = fieldNumbers(buf);
  for (const f of [9, 24, 36, 37]) assert.ok(fields.includes(f), 'has field ' + f);
  // ascending field order on the wire
  const sorted = [...fields].sort((a, b) => a - b);
  assert.deepEqual(fields, sorted, 'fields are in ascending order');
});

test('ClientPayload omits the new fields when they are not supplied', () => {
  const ua = {
    platform: 0, version: '2.26.35.75', mcc: '234', mnc: '15', osVersion: '14',
    manufacturer: 'Samsung', device: 'SM-A325F', osBuildNumber: 'TP1A', phoneId: 'X',
    releaseChannel: 0, localeLanguage: 'en', localeCountry: 'GB',
    deviceType: 0, deviceModelType: 'SM-A325F'
  };
  const buf = encodeClientPayload({
    username: 40712345678n, passive: false, userAgent: ua, oc: false
  });
  const fields = fieldNumbers(buf);
  for (const f of [9, 24, 36, 37]) assert.ok(!fields.includes(f), 'no field ' + f);
});
