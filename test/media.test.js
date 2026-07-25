'use strict';

// Regression tests for media connection refresh and upload timeouts.
//
// Symptom: sending an image/video/sticker showed "connection expired". Two
// causes: the upload request had no timeout (a stale media host hung until the
// send-ack timeout fired), and the media connection (hosts + auth token) was
// fetched once and cached forever, so an expired auth token never recovered.

const assert = require('assert');
const http   = require('http');
const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode } = require('../lib/BinaryNode');

// ── media connection freshness / refresh ────────────────────────────────────

async function testRefreshRefetchesWhenStale() {
  const client = Object.create(WhalibmobClient.prototype);
  let iqCount = 0;
  client._genMsgId = () => 'id' + (++iqCount);
  client._sendIq = async () => new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('media_conn', { auth: 'AUTH' + iqCount, ttl: '1' }, [
      new BinaryNode('host', { hostname: 'mmg.whatsapp.net' }, null),
    ]),
  ]);
  client.emit = () => {};
  client._mediaConn = null;

  const c1 = await client.refreshMediaConn(false);
  assert.strictEqual(c1.hosts[0], 'mmg.whatsapp.net', 'hosts parsed');
  assert.strictEqual(c1.auth, 'AUTH1', 'auth parsed');

  // Immediately fresh → no new IQ
  const c2 = await client.refreshMediaConn(false);
  assert.strictEqual(iqCount, 1, 'fresh connection is reused, no second IQ');
  assert.strictEqual(c2.auth, 'AUTH1');

  // ttl was 1s — wait past it, then it must refetch
  client._mediaConn.fetchDate = Date.now() - 2000;
  await client.refreshMediaConn(false);
  assert.strictEqual(iqCount, 2, 'stale connection triggers a refetch');
  console.log('  ✓ media connection refetches only when stale');
}

async function testForceRefreshAlwaysRefetches() {
  const client = Object.create(WhalibmobClient.prototype);
  let iqCount = 0;
  client._genMsgId = () => 'id' + (++iqCount);
  client._sendIq = async () => new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('media_conn', { auth: 'A', ttl: '3600' }, [
      new BinaryNode('host', { hostname: 'h' }, null),
    ]),
  ]);
  client.emit = () => {};
  client._mediaConn = null;

  await client.refreshMediaConn(false);
  await client.refreshMediaConn(true); // forced, despite being fresh
  assert.strictEqual(iqCount, 2, 'forceGet always refetches (dead-token recovery)');
  console.log('  ✓ forced refresh always refetches');
}

async function testTtlCapturedFromNode() {
  const client = Object.create(WhalibmobClient.prototype);
  const parsed = client._parseMediaConn(new BinaryNode('iq', {}, [
    new BinaryNode('media_conn', { auth: 'X', ttl: '900' }, [
      new BinaryNode('host', { hostname: 'a' }, null),
      new BinaryNode('host', { hostname: 'b' }, null),
    ]),
  ]));
  assert.strictEqual(parsed.ttl, 900, 'ttl captured');
  assert.deepStrictEqual(parsed.hosts, ['a', 'b'], 'all hosts captured');
  console.log('  ✓ ttl and all hosts captured from media_conn node');
}

// ── upload timeout: a hung host must reject, not hang forever ────────────────

async function testUploadTimesOut() {
  const { uploadMedia } = require('../lib/MediaService');
  // A server that accepts the connection but never responds.
  const server = http.createServer(() => { /* never write a response */ });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  // uploadMedia targets https:443; we can't easily point it at our http server,
  // so instead assert the timeout wiring via a direct _tryUpload-style probe:
  // upload to an unroutable host with a short timeout must reject quickly.
  const start = Date.now();
  let threw = false;
  try {
    await uploadMedia('image', Buffer.from('hello'), ['10.255.255.1'], 'auth', { timeoutMs: 1500 });
  } catch (err) {
    threw = true;
    assert.ok(/failed on all hosts/i.test(err.message), 'surfaces an all-hosts failure: ' + err.message);
  }
  const elapsed = Date.now() - start;
  server.close();
  assert.ok(threw, 'upload to a dead host must reject');
  assert.ok(elapsed < 8000, `must fail fast, took ${elapsed}ms`);
  console.log(`  ✓ upload to a dead host fails fast (${elapsed}ms) instead of hanging`);
}

async function testNoHostsErrorsClearly() {
  const { uploadMedia } = require('../lib/MediaService');
  let msg = '';
  try { await uploadMedia('image', Buffer.from('x'), [], 'auth'); }
  catch (e) { msg = e.message; }
  assert.ok(/no media hosts/i.test(msg), 'clear error when no hosts: ' + msg);
  console.log('  ✓ empty host list produces a clear error');
}

// ── chatstate carries `from` ────────────────────────────────────────────────

function testChatStateHasFrom() {
  const client = Object.create(WhalibmobClient.prototype);
  client._connected = true;
  client._myLid = null;
  client._store = { phoneNumber: '491511111111' };
  let sent = null;
  client._socket = { sendNode: (n) => { sent = n; } };

  client.setChatPresence('491522222222@s.whatsapp.net', 'composing');
  assert.strictEqual(sent.description, 'chatstate');
  assert.strictEqual(sent.attrs.from, '491511111111@s.whatsapp.net', 'from is our JID');
  assert.strictEqual(sent.attrs.to, '491522222222@s.whatsapp.net', 'to is the chat');
  assert.strictEqual(sent.content[0].description, 'composing');

  client.setChatPresence('491522222222@s.whatsapp.net', 'recording');
  assert.strictEqual(sent.content[0].attrs.media, 'audio', 'recording maps to composing media=audio');
  console.log('  ✓ chatstate includes from and recording sets media=audio');
}

(async () => {
  console.log('Media connection and presence:');
  await testTtlCapturedFromNode();
  await testRefreshRefetchesWhenStale();
  await testForceRefreshAlwaysRefetches();
  await testNoHostsErrorsClearly();
  await testUploadTimesOut();
  testChatStateHasFrom();
  console.log('\nAll media/presence tests passed.');
})().catch(err => { console.error('\nTEST FAILED:', err && err.stack || err); process.exit(1); });
