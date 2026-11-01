'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WhalibmobClient } = require('../lib/Client');
const { createNewStore, storeToJson, storeFromJson } = require('../lib/Store');
const { BinaryNode } = require('../lib/BinaryNode');

function fixture(store = createNewStore('447700900001', { name: 'Chosen Name' })) {
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _store: store, _mode: 'mobile', _connected: true, sent: [], saved: [], events: [],
    _pendingIqs: new Map(), _pendingAcks: new Map(), _hasConnectedOnce: true,
    _persistStore() { this.saved.push(storeToJson(this._store)); },
    emit(...args) { this.events.push(args); },
    _startTimers() {}, _updateServerTimeOffset() {}, _sendActiveIq() {},
    _requestMediaConnection() {}, _sendUnifiedSession() {},
    async _ensureServerPreKeys() {}, async _verifyServerKeyBundle() {},
    async queryPrivacySettings() {}, _appStateKeys: () => ({})
  });
  c._socket = { sendNode(n) { c.sent.push(n); } };
  return c;
}
const success = name => new BinaryNode('success', name === undefined ? {} : { display_name: name }, []);
const remoteName = name => [{ index: ['setting_pushName'], action: { pushNameSetting: { name } } }];

test('a stale login name cannot replace the registration name before presence is sent', () => {
  const c = fixture();
  c._store.registered = true;
  c._onOpen(success('Old Name'));
  assert.equal(c._store.name, 'Chosen Name');
  assert.equal(c._store.pushName, 'Chosen Name');
  assert.equal(c._store.serverPushName, 'Old Name');
  assert.equal(c._store.pendingPushName, 'Chosen Name');
  assert.equal(c.sent.find(n => n.description === 'presence').attrs.name, 'Chosen Name');
});

test('rename intent survives disk serialization and a second stale login without changing keys', async () => {
  const c = fixture(createNewStore('447700900001'));
  const before = storeToJson(c._store);
  assert.equal(await c.changeName('New Name'), false);
  const restored = fixture(storeFromJson(JSON.parse(JSON.stringify(c.saved.at(-1)))));
  restored._onOpen(success('Old Name'));
  assert.equal(restored._store.name, 'New Name');
  assert.equal(restored.sent.at(-1).attrs.name, 'New Name');
  const after = storeToJson(restored._store);
  for (const field of ['noiseKeyPair', 'identityKeyPair', 'signedPreKey', 'registrationId', 'deviceId', 'fdid']) {
    assert.deepEqual(after[field], before[field], field);
  }
});

test('only a matching login observation clears the pending server-name confirmation', () => {
  const c = fixture();
  c._parseSuccessNode(success());
  assert.equal(c._store.pendingPushName, 'Chosen Name');
  c._parseSuccessNode(success('Chosen Name'));
  assert.equal(c._store.pendingPushName, null);
  assert.equal(c._store.serverPushName, 'Chosen Name');
});

test('legacy stores without rename intent adopt the server name in both local fields', () => {
  const json = storeToJson(createNewStore('447700900001'));
  delete json.pendingPushName;
  delete json.serverPushName;
  const c = fixture(storeFromJson(json));
  c._store.pushName = 'Stale Presence Name';
  c._onOpen(success('Server Name'));
  assert.equal(c._store.name, 'Server Name');
  assert.equal(c._store.pushName, 'Server Name');
  assert.equal(c.sent.at(-1).attrs.name, 'Server Name');
});

test('without a sync key, rename is announced and retained, but no patch or automatic retry is invented', async () => {
  const c = fixture();
  c._sendAppStatePatch = () => { throw new Error('must not create a patch without a key'); };
  assert.equal(await c.changeName('  New\nName  '), false);
  assert.deepEqual(c.sent.map(n => n.attrs), [{ name: 'New Name' }, { name: 'New Name', type: 'available' }]);
  assert.equal(c.saved.at(-1).pendingPushName, 'New Name');
});

test('an accepted App State write does not pretend to be an account-name readback', async () => {
  const c = fixture();
  c._appStateKeys = () => ({ 'a2V5': { keyData: Buffer.alloc(32), timestamp: 1 } });
  const patches = [];
  c._sendAppStatePatch = async desc => patches.push(desc);
  assert.equal(await c.changeName('New Name'), true);
  assert.equal(patches[0].action.pushNameSetting.name, 'New Name');
  assert.equal(c._store.pendingPushName, 'New Name');
  assert.equal(c._store.serverPushName, null);
});

test('a refused App State write retains the requested name and returns false', async () => {
  const c = fixture();
  c._appStateKeys = () => ({ 'a2V5': { keyData: Buffer.alloc(32) } });
  c._sendAppStatePatch = async () => { throw new Error('server refused patch'); };
  assert.equal(await c.changeName('New Name'), false);
  c._parseSuccessNode(success('Old Name'));
  assert.equal(c._store.name, 'New Name');
});

test('authenticated App State can update the name when login never supplies display_name', async () => {
  const c = fixture();
  await c.changeName('New Name');
  c._parseSuccessNode(success());
  c._applyAppStateMutations('critical_block', remoteName('Remote Name'));
  assert.equal(c._store.name, 'Remote Name');
  assert.deepEqual(c.events.at(-1), ['push_name_update', { name: 'Remote Name', remote: true }]);
  assert.equal(c._store.pendingPushName, null);
  assert.equal(c._store.serverPushName, null, 'App State is not login readback');
});

test('remote renames still apply once no local request is outstanding', () => {
  const c = fixture();
  c._parseSuccessNode(success('Chosen Name'));
  c._applyAppStateMutations('critical_block', remoteName('Remote Name'));
  assert.equal(c._store.name, 'Remote Name');
  assert.equal(c._store.pushName, 'Remote Name');
});

test('invalid/disconnected rename sends nothing and does not change local intent', () => {
  const c = fixture();
  for (const name of ['', ' \n ', null, 42]) assert.throws(() => c.changeName(name));
  c._connected = false;
  assert.throws(() => c.changeName('New Name'), /Not connected/);
  assert.equal(c.sent.length, 0);
  assert.equal(c._store.name, 'Chosen Name');
});
