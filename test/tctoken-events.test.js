'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode } = require('../lib/BinaryNode');
const { TcTokenStore } = require('../lib/messages/TcTokenStore');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tctoken-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
  client._tcTokenStore = new TcTokenStore(path.join(dir, 'x.tctoken.json'));
  return client;
}

function tokenNotification(senderLid, bytes, t) {
  return new BinaryNode('notification', { from: senderLid, sender_lid: senderLid, type: 'privacy_token' }, [
    new BinaryNode('tokens', {}, [
      new BinaryNode('token', { type: 'trusted_contact', t: String(t) }, bytes)
    ])
  ]);
}

test('a received privacy_token emits tctoken and is listed and usable', t => {
  const client = setup(t);
  const now = Math.floor(Date.now() / 1000);
  const events = [];
  client.on('tctoken', e => events.push(e));

  client._handlePrivacyTokenNotification(tokenNotification('273182149869631@lid', Buffer.from('secret-token'), now));

  assert.deepEqual(events, [{ jid: '273182149869631@lid', timestamp: now, size: 12, source: 'received' }]);
  assert.deepEqual(client.getTcTokens(), [{ jid: '273182149869631@lid', timestamp: now, size: 12, expired: false }]);
  assert.equal(client.hasTcToken('273182149869631@lid'), true);
  assert.ok(!JSON.stringify(client.getTcTokens()).includes(Buffer.from('secret-token').toString('base64')));
});

test('an older token neither replaces the stored one nor emits', t => {
  const client = setup(t);
  const now = Math.floor(Date.now() / 1000);
  client._handlePrivacyTokenNotification(tokenNotification('111@lid', Buffer.from('new'), now));
  const events = [];
  client.on('tctoken', e => events.push(e));
  client._handlePrivacyTokenNotification(tokenNotification('111@lid', Buffer.from('old'), now - 60));
  assert.equal(events.length, 0);
  assert.equal(client.getTcTokens()[0].timestamp, now);
});

test('a server-issued token reports source issued', t => {
  const client = setup(t);
  const now = Math.floor(Date.now() / 1000);
  const events = [];
  client.on('tctoken', e => events.push(e));
  const iq = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('tokens', {}, [new BinaryNode('token', { type: 'trusted_contact', t: String(now) }, Buffer.from('abc'))])
  ]);
  client._storeTcTokenFromIqResult(iq, '222@lid', now);
  assert.equal(events[0].source, 'issued');
  assert.equal(events[0].jid, '222@lid');
});

test('no store means no tokens and no usable token', t => {
  const client = setup(t);
  client._tcTokenStore = null;
  assert.deepEqual(client.getTcTokens(), []);
  assert.equal(client.hasTcToken('333@lid'), false);
});
