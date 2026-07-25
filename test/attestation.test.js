'use strict';

// Tests for the Frida device-attestation client (lib/AttestationClient.js).
// A local mock HTTP server stands in for the on-device Frida server so the
// Play Integrity / Keystore wire mapping can be asserted without a real phone.

const assert = require('assert');
const http = require('http');
const { FridaAttestor, getAttestorFromEnv, _internals } = require('../lib/AttestationClient');
const { createNewStore } = require('../lib/Store');

const { toBase64Url, toBase64UrlNoPad, fromBase64Url, toHex } = _internals;

// Spin up a mock server mimicking frida/android/integrity/server.js.
function startMockServer(handlers) {
  return new Promise((resolve) => {
    const captured = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      captured.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
      const fn = handlers[u.pathname];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fn ? fn(Object.fromEntries(u.searchParams)) : { error: 'Unknown method' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured }));
  });
}

async function testAndroidAttestationFields() {
  const rawToken = 'PLAY_INTEGRITY_VERDICT_TOKEN';
  const { server, port, captured } = await startMockServer({
    '/integrity': (q) => ({ token: rawToken, _echoAuthKey: q.authKey })
  });
  try {
    const store = createNewStore('4915511497658');
    const att = new FridaAttestor({ host: '127.0.0.1', port, os: 'android' });
    const fields = await att.attestationFields(store);
    const obj = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    assert.strictEqual(obj.gpia, rawToken, 'gpia carries the Play Integrity token');
    assert.ok('_gg' in obj && '_gi' in obj && '_gp' in obj && '_ge' in obj && '_ga' in obj,
      'the full gpia sextuple is present');
    assert.strictEqual(obj._gg, '', 'the Gaia/Instance/PM slots are empty in a frida-only setup');
    assert.strictEqual(captured[0].path, '/integrity', 'called /integrity');
    assert.ok(captured[0].query.authKey, 'a nonce was sent as authKey');
    console.log('  ✓ Android attestationFields returns the gpia sextuple');
  } finally { server.close(); }
}

async function testAndroidAttestBodyWireShape() {
  // Raw signature + certificate bytes the device would produce.
  const sigBytes = Buffer.from([0x30, 0x44, 0x02, 0x20, 0xde, 0xad, 0xbe, 0xef]);
  const certBytes = Buffer.from('FAKE_CERT_CHAIN_BYTES');
  const { server, port, captured } = await startMockServer({
    // Matches the Frida android /cert: signature url-base64 (no pad), certificate std-base64.
    '/cert': () => ({
      signature: toBase64UrlNoPad(sigBytes),
      certificate: certBytes.toString('base64')
    })
  });
  try {
    const store = createNewStore('4915511497658');
    const att = new FridaAttestor({ host: '127.0.0.1', port, os: 'android' });
    const enc = 'ENCODED_ENVELOPE_abc123';
    const body = await att.attestBody(store, enc);
    // Cobalt sends H= as lowercase hex of the raw signature bytes.
    assert.strictEqual(body.h, toHex(sigBytes), 'H= is hex of the raw signature bytes');
    // Authorization is the url-base64 (no pad) certificate chain.
    assert.deepStrictEqual(fromBase64Url(body.authorization), certBytes,
      'Authorization decodes back to the raw certificate chain');
    // The ENC envelope was forwarded to /cert as `enc`.
    assert.strictEqual(captured[0].query.enc, enc, '/cert receives the ENC envelope');
    assert.ok(captured[0].query.authKey, '/cert receives the pubkey as authKey');
    console.log('  ✓ Android attestBody maps signature->hex H= and cert->urlbase64 Authorization');
  } finally { server.close(); }
}

async function testOptionalSwallowsUnreachable() {
  // Nothing listening on this port -> optional attestor must not throw.
  const att = new FridaAttestor({ host: '127.0.0.1', port: 9, os: 'android', optional: true, timeout: 500 });
  const store = createNewStore('4915511497658');
  const fields = await att.attestationFields(store);
  assert.deepStrictEqual(fields, [], 'optional attestor yields no fields when unreachable');
  console.log('  ✓ optional attestor degrades gracefully when the server is down');
}

async function testHardFailsWhenNotOptional() {
  const att = new FridaAttestor({ host: '127.0.0.1', port: 9, os: 'android', optional: false, timeout: 500 });
  const store = createNewStore('4915511497658');
  await assert.rejects(() => att.attestationFields(store), /failed/i,
    'non-optional attestor throws a helpful error when unreachable');
  console.log('  ✓ non-optional attestor throws when the server is unreachable');
}

function testEnvFactoryDefaultOff() {
  const saved = process.env.WA_FRIDA_ATTESTATION;
  delete process.env.WA_FRIDA_ATTESTATION;
  assert.strictEqual(getAttestorFromEnv('android'), null, 'attestation is off by default');
  process.env.WA_FRIDA_ATTESTATION = '0';
  assert.strictEqual(getAttestorFromEnv('android'), null, 'WA_FRIDA_ATTESTATION=0 stays off');
  process.env.WA_FRIDA_ATTESTATION = '1';
  const att = getAttestorFromEnv('android');
  assert.ok(att instanceof FridaAttestor, 'WA_FRIDA_ATTESTATION=1 builds an attestor');
  assert.strictEqual(att.port, 1119, 'defaults to the WhatsApp port 1119');
  if (saved === undefined) delete process.env.WA_FRIDA_ATTESTATION;
  else process.env.WA_FRIDA_ATTESTATION = saved;
  console.log('  ✓ env factory: off by default, 1119 when enabled');
}

function testBusinessPortSelection() {
  const savedFlag = process.env.WA_FRIDA_ATTESTATION;
  const savedApp = process.env.WA_APP;
  process.env.WA_FRIDA_ATTESTATION = '1';
  process.env.WA_APP = 'business';
  assert.strictEqual(getAttestorFromEnv('android').port, 1120, 'business -> port 1120');
  if (savedFlag === undefined) delete process.env.WA_FRIDA_ATTESTATION; else process.env.WA_FRIDA_ATTESTATION = savedFlag;
  if (savedApp === undefined) delete process.env.WA_APP; else process.env.WA_APP = savedApp;
  console.log('  ✓ env factory: WhatsApp Business selects port 1120');
}

(async () => {
  console.log('Frida attestation client:');
  await testAndroidAttestationFields();
  await testAndroidAttestBodyWireShape();
  await testOptionalSwallowsUnreachable();
  await testHardFailsWhenNotOptional();
  testEnvFactoryDefaultOff();
  testBusinessPortSelection();
  console.log('\nAll attestation tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
