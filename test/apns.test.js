'use strict';

// APNs — the push line an iOS profile announces.
//
// Nothing here touches Apple. What is worth pinning is everything that has to
// be right *before* a packet leaves: the FairPlay credential albert checks, the
// DER of the certificate request, the bytes the activation signature covers,
// and the framing the courier reads. Each of those is a place where a silent
// mistake would look exactly like a network refusal, and the fail-soft contract
// would hide it.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const apns    = require('../lib/apns');
const courier = require('../lib/apns-courier');
const plist   = require('../lib/plist');
const { pushClientFor, supportsPush, APNS_PUSH_CLIENT } = require('../lib/PushClient');

// ─── the FairPlay credential ─────────────────────────────────────────────────

test('the FairPlay key is the one the certificate chain vouches for', () => {
  // albert verifies the activation signature against the leaf of the chain the
  // same request carries. A key and a chain that drifted apart would be
  // refused by Apple and by nothing else, so the pairing is checked here.
  const key = crypto.createPrivateKey({
    key: apns.FAIRPLAY_PRIVATE_KEY_PKCS1, format: 'der', type: 'pkcs1'
  });
  const leaf = new crypto.X509Certificate(apns.FAIRPLAY_CERT_CHAIN);

  const message = Buffer.from('activation info');
  const signature = crypto.sign('sha1', message, key);
  assert.equal(crypto.verify('sha1', message, leaf.publicKey, signature), true,
    'the signature verifies against the leaf certificate');
  assert.match(leaf.subject, /Apple Inc\./);
});

// ─── the certificate request ─────────────────────────────────────────────────

// One DER element at `offset`, read by walking rather than by searching for a
// tag byte: a 2048-bit modulus contains every byte value, so anything that goes
// looking for one finds it in the wrong place sooner or later.
function readTlv(buf, offset) {
  const tag = buf[offset];
  let length = buf[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const width = length & 0x7f;
    length = buf.readUIntBE(offset + 2, width);
    header = 2 + width;
  }
  return {
    tag,
    element: buf.subarray(offset, offset + header + length),
    value:   buf.subarray(offset + header, offset + header + length),
    end:     offset + header + length
  };
}

function csrDer(pem) {
  return Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
}

test('the CSR is a well-formed PKCS#10 carrying our own public key', () => {
  const keyPair = apns.newKeyPair();
  const pem = apns.generateCsr(keyPair).toString('utf8');

  assert.ok(pem.startsWith('-----BEGIN CERTIFICATE REQUEST-----\n'), 'PEM armour');
  assert.ok(pem.trimEnd().endsWith('-----END CERTIFICATE REQUEST-----'), 'and closed');
  assert.ok(pem.split('\n').slice(1, -2).every(line => line.length <= 64), 'wrapped at 64 columns');

  // CertificationRequest ::= SEQUENCE { info, algorithm, signature }
  const request = readTlv(csrDer(pem), 0);
  assert.equal(request.tag, 0x30, 'the request is a SEQUENCE');

  const info = readTlv(request.value, 0);
  const algorithm = readTlv(request.value, info.end);
  const signature = readTlv(request.value, algorithm.end);
  assert.equal(info.tag, 0x30);
  assert.equal(algorithm.tag, 0x30, 'the signature algorithm identifier');
  assert.equal(signature.tag, 0x03, 'the signature is a BIT STRING');
  assert.equal(signature.end, request.value.length, 'and nothing follows it');

  assert.ok(info.value.includes(keyPair.publicKeyDer), 'the public key we generated is in the request');
});

test('the CSR signature verifies, which is what makes it a request and not a blob', () => {
  const keyPair = apns.newKeyPair();
  const der = csrDer(apns.generateCsr(keyPair).toString('utf8'));

  const request = readTlv(der, 0);
  const info = readTlv(request.value, 0);
  const algorithm = readTlv(request.value, info.end);
  const signature = readTlv(request.value, algorithm.end);

  // The signed region is the info element including its own header. The BIT
  // STRING's first content byte counts unused trailing bits and is not part of
  // the signature.
  assert.equal(signature.value[0], 0x00);
  assert.equal(
    crypto.verify('sha256', info.element, keyPair.publicKey, signature.value.subarray(1)),
    true);
});

// ─── the activation body ─────────────────────────────────────────────────────

test('the activation body is the inner plist, the chain, and a signature over it', () => {
  const info = apns.buildActivationInfo(Buffer.from('-----BEGIN CERTIFICATE REQUEST-----\nAA==\n-----END CERTIFICATE REQUEST-----\n'));
  const outer = plist.parse(apns.buildActivationBody(info));

  assert.equal(outer.ActivationInfoComplete, true);
  assert.ok(outer.ActivationInfoXML.equals(info), 'the inner document is carried verbatim');
  assert.ok(outer.FairPlayCertChain.equals(apns.FAIRPLAY_CERT_CHAIN));

  const leaf = new crypto.X509Certificate(apns.FAIRPLAY_CERT_CHAIN);
  assert.equal(
    crypto.verify('sha1', outer.ActivationInfoXML, leaf.publicKey, outer.FairPlaySignature),
    true,
    'the signature covers the bytes that are actually sent');
});

test('the activation claims the device class the credential belongs to', () => {
  // The FairPlay credential is a desktop one. A request signed with it while
  // claiming to be a handset is the one inconsistency albert checks for.
  const info = plist.parse(apns.buildActivationInfo(Buffer.from('csr')));
  assert.equal(info.DeviceClass, 'Windows');
  assert.equal(info.ProductType, 'windows1,1');
  assert.equal(info.ActivationState, 'Unactivated');
  assert.ok(info.DeviceCertRequest.equals(Buffer.from('csr')), 'the CSR rides as data');
  assert.match(info.UniqueDeviceID, /^[0-9a-f-]{36}$/, 'a fresh identifier per activation');
  assert.notEqual(info.UniqueDeviceID, info.ActivationRandomness);
});

test('the activation response gives up its certificate, and says so when it has none', () => {
  const record = plist.writeXml({
    'device-activation': {
      'activation-record': { DeviceCertificate: Buffer.from('CERTIFICATE BYTES') }
    }
  }).toString('utf8');

  const page = '<html><body><Protocol>' + record + '</Protocol></body></html>';
  assert.equal(apns.parseActivationResponse(page).toString('utf8'), 'CERTIFICATE BYTES');

  assert.throws(() => apns.parseActivationResponse('<html>nothing here</html>'),
    /no <Protocol> block/);
  assert.throws(() => apns.parseActivationResponse(
    '<Protocol>' + plist.writeXml({ 'device-activation': {} }).toString('utf8') + '</Protocol>'),
    /no DeviceCertificate/);
});

// ─── the session on the store ────────────────────────────────────────────────

test('a session round-trips through the JSON the store is written as', () => {
  const session = {
    privateKeyDer:     Buffer.from([1, 2, 3]),
    publicKeyDer:      Buffer.from([4, 5, 6]),
    deviceCertificate: Buffer.from('cert'),
    deviceToken:       Buffer.from('0011ff', 'hex')
  };
  const saved = apns.encodeSession(session);
  assert.equal(typeof saved.privateKeyDer, 'string', 'everything on the store is text');
  assert.equal(saved.deviceToken, '0011ff');

  const restored = apns.decodeSession(JSON.parse(JSON.stringify(saved)));
  assert.ok(restored.privateKeyDer.equals(session.privateKeyDer));
  assert.ok(restored.deviceCertificate.equals(session.deviceCertificate));
  assert.ok(restored.deviceToken.equals(session.deviceToken));
});

test('a half-written session reads as no session at all', () => {
  // Better to activate again than to present a certificate with no key.
  assert.equal(apns.decodeSession(null), null);
  assert.equal(apns.decodeSession({}), null);
  assert.equal(apns.decodeSession({ privateKeyDer: 'AA==', publicKeyDer: 'AA==' }), null);
});

test('the Business profile subscribes to the Business bundle', () => {
  assert.equal(apns.configFor({ os: 'ios' }).topics[0], 'net.whatsapp.WhatsApp');
  assert.equal(apns.configFor({ os: 'ios', business: true }).topics[0], 'net.whatsapp.WhatsAppSMB');
  for (const config of [apns.APNS_CONFIG.personal, apns.APNS_CONFIG.business]) {
    assert.equal(config.topics.length, 2, 'the messaging topic and its .voip sibling');
    assert.ok(config.topics[1].endsWith('.voip'));
  }
});

// ─── framing ─────────────────────────────────────────────────────────────────

test('a frame is a tag, a big-endian length, and length-prefixed fields', () => {
  const frame = courier.encodeFrame(0x07, [[0x01, Buffer.from('ab')], [0x02, Buffer.from('c')]]);
  assert.equal(frame[0], 0x07, 'the tag leads');
  assert.equal(frame.readUInt32BE(1), frame.length - 5, 'the length covers the payload only');

  const fields = courier.decodeFields(frame.subarray(5));
  assert.equal(courier.first(fields, 0x01).toString(), 'ab');
  assert.equal(courier.first(fields, 0x02).toString(), 'c');
});

test('a repeated field id survives, because that is how FILTER carries topics', () => {
  // Collapsing repeats into one value would subscribe to the last topic only,
  // and the verification push rides on the other one.
  const frame = courier.encodeFrame(courier.TAG.FILTER, [
    [0x01, Buffer.from('token')],
    [0x02, courier.topicHash('net.whatsapp.WhatsApp')],
    [0x02, courier.topicHash('net.whatsapp.WhatsApp.voip')]
  ]);
  const fields = courier.decodeFields(frame.subarray(5));
  assert.equal(fields.get(0x02).length, 2, 'both topics are on the wire');
  assert.ok(fields.get(0x02)[0].equals(courier.topicHash('net.whatsapp.WhatsApp')));
  assert.ok(fields.get(0x02)[1].equals(courier.topicHash('net.whatsapp.WhatsApp.voip')));
});

test('a null field is dropped rather than sent empty', () => {
  const frame = courier.encodeFrame(0x07, [[0x01, null], [0x02, Buffer.from('x')]]);
  const fields = courier.decodeFields(frame.subarray(5));
  assert.equal(fields.has(0x01), false);
  assert.equal(courier.first(fields, 0x02).toString(), 'x');
});

test('a field whose length runs past the frame is ignored, not read out of bounds', () => {
  const payload = Buffer.from([0x01, 0x00, 0x40, 0x61, 0x62]);  // claims 64 bytes, has 2
  assert.equal(courier.decodeFields(payload).size, 0);
});

test('frames are reassembled across arbitrary chunk boundaries', () => {
  // TLS hands over whatever it has; a frame can arrive in pieces and two can
  // arrive in one read.
  const connection = new courier.ApnsCourierConnection({
    privateKeyDer: Buffer.alloc(0), publicKeyDer: Buffer.alloc(0), deviceCertificate: Buffer.alloc(0)
  });
  const seen = [];
  connection._dispatch = (packet) => seen.push(packet);

  const one = courier.encodeFrame(courier.TAG.KEEP_ALIVE_ACK, []);
  const two = courier.encodeFrame(courier.TAG.TOKEN_RESPONSE, [[0x02, Buffer.from('tok')]]);
  const stream = Buffer.concat([one, two]);

  for (let i = 0; i < stream.length; i++) connection._onData(stream.subarray(i, i + 1));

  assert.equal(seen.length, 2, 'both frames came out of a byte-at-a-time stream');
  assert.equal(seen[0].tag, courier.TAG.KEEP_ALIVE_ACK);
  assert.equal(courier.first(seen[1].fields, 0x02).toString(), 'tok');
});

test('a notification is acknowledged and its code handed on', () => {
  const codes = [];
  const connection = new courier.ApnsCourierConnection({
    privateKeyDer: Buffer.alloc(0), publicKeyDer: Buffer.alloc(0), deviceCertificate: Buffer.alloc(0)
  }, { onNotification: (packet) => codes.push(courier.extractRegCode(packet)) });

  const sent = [];
  connection.deviceToken = Buffer.from('aa', 'hex');
  connection._send = (tag, fields) => sent.push({ tag, fields });

  connection._onData(courier.encodeFrame(courier.TAG.NOTIFICATION, [
    [courier.F_NOTIFICATION_TOPIC,   courier.topicHash('net.whatsapp.WhatsApp')],
    [courier.F_NOTIFICATION_PAYLOAD, Buffer.from(JSON.stringify({ regcode: '123456' }))],
    [courier.F_NOTIFICATION_ID,      Buffer.from([0x00, 0x01])]
  ]));

  assert.deepEqual(codes, ['123456']);
  assert.equal(sent.length, 1, 'exactly one ACK');
  assert.equal(sent[0].tag, courier.TAG.ACK, 'an unacknowledged push is redelivered forever');
});

// The two issuers actually seen on the courier port. The first is what Apple's
// courier presents on a clean network; the second is what an egress gateway
// that terminates TLS presents in its place. Both came with no ALPN echo, which
// is why ALPN cannot tell them apart and the issuer has to.
const APPLE_COURIER_ISSUER = {
  CN: 'Apple Server Authentication CA', OU: 'Certification Authority', O: 'Apple Inc.', C: 'US'
};
const INTERCEPTING_GATEWAY_ISSUER = {
  O: 'Anthropic', CN: 'Egress Gateway SDS Issuing CA (production)'
};

test('the real courier is told from a middlebox by who signed its certificate', () => {
  assert.equal(courier.isApplePeer(APPLE_COURIER_ISSUER), true, 'Apple\'s own courier');
  assert.equal(courier.isApplePeer(INTERCEPTING_GATEWAY_ISSUER), false, 'a gateway in front of it');

  // Node reports a repeated field as an array rather than a string.
  assert.equal(courier.isApplePeer({ O: ['Apple Inc.', 'Something Else'] }), true);
  assert.equal(courier.isApplePeer(null), false);
  assert.equal(courier.isApplePeer({}), false);
});

test('the issuer is named in a way a person can act on', () => {
  assert.equal(courier.describeIssuer(INTERCEPTING_GATEWAY_ISSUER),
    '"Egress Gateway SDS Issuing CA (production)"');
  assert.equal(courier.describeIssuer({ O: 'Some Antivirus' }), '"Some Antivirus"',
    'the organisation stands in when there is no common name');
  assert.equal(courier.describeIssuer(null), 'an unnamed issuer');
});

test('no interception note is possible before a socket exists', () => {
  // The note is attached only when a certificate was seen and Apple did not
  // sign it. A failure before any socket — the bag, the dial — must not be
  // blamed on interception it had no way to observe.
  const connection = new courier.ApnsCourierConnection({
    privateKeyDer: Buffer.alloc(0), publicKeyDer: Buffer.alloc(0), deviceCertificate: Buffer.alloc(0)
  });
  assert.equal(connection.peerIssuer, null);
});

test('a lost connection is reported, so nobody waits out a timeout on a dead socket', () => {
  const lost = [];
  const connection = new courier.ApnsCourierConnection({
    privateKeyDer: Buffer.alloc(0), publicKeyDer: Buffer.alloc(0), deviceCertificate: Buffer.alloc(0)
  }, { onLost: (err) => lost.push(err) });

  connection._fail(new Error('reset by peer'));
  assert.equal(lost.length, 1);
  assert.match(lost[0].message, /reset by peer/);

  // Closing on purpose is not the line being lost, and must not report twice.
  const quiet = new courier.ApnsCourierConnection({
    privateKeyDer: Buffer.alloc(0), publicKeyDer: Buffer.alloc(0), deviceCertificate: Buffer.alloc(0)
  }, { onLost: () => lost.push('closed') });
  quiet.close();
  quiet._fail(new Error('close event follows a destroy'));
  assert.equal(lost.length, 1, 'a deliberate close stays quiet');
});

test('a request outstanding when the line drops is rejected, not left hanging', async () => {
  const connection = new courier.ApnsCourierConnection({
    privateKeyDer: Buffer.alloc(0), publicKeyDer: Buffer.alloc(0), deviceCertificate: Buffer.alloc(0)
  });
  connection._send = () => {};

  const waiting = connection._exchange(courier.TAG.GET_TOKEN, [], () => false);
  connection._fail(new Error('courier went away'));
  await assert.rejects(waiting, /courier went away/);
});

test('a push that is not the verification one reads as no code', () => {
  const make = (payload) => ({ fields: courier.decodeFields(
    courier.encodeFrame(0, [[courier.F_NOTIFICATION_PAYLOAD, Buffer.from(payload)]]).subarray(5)) });

  assert.equal(courier.extractRegCode(make(JSON.stringify({ regcode: '654321' }))), '654321');
  assert.equal(courier.extractRegCode(make(JSON.stringify({ aps: { alert: 'hi' } }))), null);
  assert.equal(courier.extractRegCode(make('not json at all')), null);
  assert.equal(courier.extractRegCode({ fields: new Map() }), null);
});

// ─── connection credentials ──────────────────────────────────────────────────

test('the connect nonce is 17 bytes with a fresh timestamp in it', () => {
  // Apple checks the timestamp is recent; that is what stops a captured
  // signature from being replayed.
  const before = Date.now();
  const nonce = courier.createNonce();
  assert.equal(nonce.length, 17);
  assert.equal(nonce[0], 0x00);

  const stamped = Number(nonce.readBigUInt64BE(1));
  assert.ok(stamped >= before && stamped <= Date.now(), 'the time is now');
  assert.notEqual(courier.createNonce().subarray(9).toString('hex'),
    nonce.subarray(9).toString('hex'), 'and the tail is random');
});

test('a topic goes on the wire as its SHA-1', () => {
  assert.ok(courier.topicHash('net.whatsapp.WhatsApp').equals(
    crypto.createHash('sha1').update('net.whatsapp.WhatsApp').digest()));
  assert.equal(courier.topicHash('net.whatsapp.WhatsApp').length, 20);
});

test('a PEM certificate is normalised to the DER the courier wants', () => {
  // Apple hands the activation certificate back as PEM; the CONNECT field is
  // DER, and a certificate that cannot be read has to fail here rather than as
  // an unexplained disconnect.
  const leaf = new crypto.X509Certificate(apns.FAIRPLAY_CERT_CHAIN);

  assert.ok(courier.certificateDer(Buffer.from(leaf.toString(), 'utf8')).equals(leaf.raw),
    'PEM in, DER out');
  assert.ok(courier.certificateDer(leaf.raw).equals(leaf.raw),
    'DER in, the same DER out');
  assert.throws(() => courier.certificateDer(Buffer.from('not a certificate')));
});

test('the bag is never asked for around a configured proxy', () => {
  // The plain-HTTP fallback cannot go through the SOCKS agent, which is an
  // https.Agent. Trying it anyway would send the request out direct — past the
  // proxy the user set precisely so that nothing does.
  const previous = process.env.SOCKS_PROXY;
  const previousTor = process.env.TOR_PROXY;
  try {
    delete process.env.SOCKS_PROXY;
    delete process.env.TOR_PROXY;
    const direct = courier.bagUrls();
    assert.equal(direct.length, 2, 'the canonical http url, then https');
    // The bag host serves a certificate for images.apple.com rather than its
    // own name, so HTTPS fails the hostname check every time. Asking over the
    // canonical URL first is what actually answers.
    assert.ok(direct[0].startsWith('http://'), 'plain http leads when nothing has to be routed');

    process.env.SOCKS_PROXY = 'socks5://127.0.0.1:9050';
    const proxied = courier.bagUrls();
    assert.equal(proxied.length, 1, 'only the routable one is tried');
    assert.ok(proxied[0].startsWith('https://'), 'and it is the one the agent can carry');
  } finally {
    if (previous === undefined) delete process.env.SOCKS_PROXY;
    else process.env.SOCKS_PROXY = previous;
    if (previousTor === undefined) delete process.env.TOR_PROXY;
    else process.env.TOR_PROXY = previousTor;
  }
});

test('the default courier pool stands in when the bag cannot be read', () => {
  assert.equal(courier.DEFAULT_BAG.hostname, 'courier.push.apple.com');
  assert.ok(courier.DEFAULT_BAG.hostCount > 1);
  assert.deepEqual(
    courier.parseBag(plist.writeXml({
      bag: plist.writeXml({ APNSCourierHostcount: 12, APNSCourierHostname: 'x.example' })
    })),
    { hostCount: 12, hostname: 'x.example' });
  assert.throws(() => courier.parseBag(plist.writeXml({ bag: plist.writeXml({}) })));
});

// ─── the seam ────────────────────────────────────────────────────────────────

test('an iOS profile is routed to APNs and an Android one is not', () => {
  assert.equal(pushClientFor({ os: 'ios' }), APNS_PUSH_CLIENT);
  assert.equal(pushClientFor({ os: 'ios', business: true }), APNS_PUSH_CLIENT);
  assert.equal(pushClientFor({ os: 'android' }).platform, 'android');
  assert.equal(pushClientFor({ os: 'symbian' }).supportsPush, false);
  assert.equal(supportsPush({ os: 'ios' }), true);
});

test('a cached token is returned without opening anything', async () => {
  const store = { apns: { token: 'deadbeef', topic: 'net.whatsapp.WhatsApp' } };
  assert.equal(await apns.getPushToken(store, { os: 'ios' }), 'deadbeef');
});

test('a token cached for another bundle is not a cache hit', () => {
  // A token is issued per bundle id. Handing the consumer app's token to a
  // Business registration would address an install that is not the one
  // registering, so the topic has to match before anything is reused.
  const store = { apns: { token: 'deadbeef', topic: 'net.whatsapp.WhatsApp' } };
  assert.equal(apns.cachedToken(store, 'net.whatsapp.WhatsApp'), 'deadbeef');
  assert.equal(apns.cachedToken(store, 'net.whatsapp.WhatsAppSMB'), null);
  assert.equal(apns.cachedToken({ apns: { topic: 'net.whatsapp.WhatsApp' } }, 'net.whatsapp.WhatsApp'), null);
  assert.equal(apns.cachedToken({}, 'net.whatsapp.WhatsApp'), null);
});

test('switched off, nothing is attempted and nothing is thrown', async () => {
  const previous = process.env.WA_APNS_PUSH;
  process.env.WA_APNS_PUSH = '0';
  try {
    assert.equal(apns.enabled(), false);
    assert.equal(await apns.getPushToken({ apns: { token: 'x', topic: 'net.whatsapp.WhatsApp' } }, { os: 'ios' }), null);
    assert.equal(await apns.receivePushCode({}, { os: 'ios' }, { timeoutMs: 10 }), null);
  } finally {
    if (previous === undefined) delete process.env.WA_APNS_PUSH;
    else process.env.WA_APNS_PUSH = previous;
  }
});

test('no store means no token, rather than a crash on the registration path', async () => {
  assert.equal(await apns.getPushToken(null, { os: 'ios' }), null);
  assert.equal(await apns.receivePushCode(null, { os: 'ios' }), null);
});
