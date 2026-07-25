'use strict';

// Regression tests for group handling and LID-addressed recipients.
//
// Covers three defects:
//   1. fetchAllGroups read <group> straight off the <iq>, but the server wraps
//      results in a <groups> node — so it always returned an empty list.
//   2. LID group members (`<user>@lid`) with no PN mapping were dropped from
//      the sender-key recipient list, so they never received the group key.
//   3. changeGroupDescription omitted the `prev` attribute, which the server
//      requires when replacing an existing description.

const assert = require('assert');
const { BinaryNode } = require('../lib/BinaryNode');
const { DeviceManager } = require('../lib/DeviceManager');

// ── 1. fetchAllGroups must read through the <groups> wrapper ────────────────

function testFetchAllGroupsWrapper() {
  const { WhalibmobClient } = require('../lib/Client');

  const groupNode = (id, subject, participants) =>
    new BinaryNode('group', { id, subject, addressing_mode: 'lid' },
      participants.map(p => new BinaryNode('participant', { jid: p }, null)));

  // Real server shape: <iq><groups><group/><group/></groups></iq>
  const response = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('groups', {}, [
      groupNode('111-1@g.us', 'Group One', ['491511111111@s.whatsapp.net']),
      groupNode('222-2@g.us', 'Group Two', ['491522222222@s.whatsapp.net']),
    ]),
  ]);

  const client = Object.create(WhalibmobClient.prototype);
  client._groupMembers        = new Map();
  client._groupAddressingMode = new Map();
  client._groupDescId         = new Map();
  client._lidToPn             = new Map();
  client._pnToLid             = new Map();
  client._genMsgId            = () => 'id1';
  client._sendIq              = async () => response;

  return client.fetchAllGroups().then(groups => {
    assert.strictEqual(groups.length, 2, 'both groups should be parsed');
    assert.strictEqual(groups[0].subject, 'Group One');
    assert.strictEqual(groups[1].jid, '222-2@g.us');
    // Member cache must be populated — group sends depend on it.
    assert.strictEqual(client._getGroupMembers('111-1@g.us').length, 1,
      'member cache populated from fetchAllGroups');
    console.log('  ✓ fetchAllGroups reads through the <groups> wrapper');
  });
}

// ── 2. LID recipients stay LID-addressed and are not dropped ────────────────

async function testLidTargetsPreserved() {
  const LID = '183459283746523';
  const response = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('usync', {}, [
      new BinaryNode('list', {}, [
        new BinaryNode('user', { jid: LID + '@lid' }, [
          new BinaryNode('devices', { version: '2' }, [
            new BinaryNode('device-list', {}, [
              new BinaryNode('device', { id: '0' }, null),
              new BinaryNode('device', { id: '3', 'key-index': '1' }, null),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);

  const dm = new DeviceManager({ _genMsgId: () => 'id', _sendIq: async () => response });
  const jids = await dm._usyncGetDevices([LID + '@lid']);

  assert.deepStrictEqual(jids.sort(), [LID + ':3@lid', LID + '@lid'].sort(),
    'LID targets must stay on the @lid server');
  console.log('  ✓ LID recipients keep the @lid server and enumerate devices');
}

async function testPnAndLidNotConflated() {
  const USER = '491511111111';
  const respFor = (server) => new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('usync', {}, [
      new BinaryNode('list', {}, [
        new BinaryNode('user', { jid: USER + '@' + server }, [
          new BinaryNode('devices', { version: '2' }, [
            new BinaryNode('device-list', {}, [
              new BinaryNode('device', { id: '0' }, null),
              // different linked device per server, to prove no cross-talk
              new BinaryNode('device', { id: server === 'lid' ? '9' : '4', 'key-index': '1' }, null),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);

  let current = 's.whatsapp.net';
  const dm = new DeviceManager({ _genMsgId: () => 'id', _sendIq: async () => respFor(current) });

  const pnJids = await dm._usyncGetDevices([USER]);
  current = 'lid';
  const lidJids = await dm._usyncGetDevices([USER + '@lid']);

  assert.ok(pnJids.includes(USER + ':4@s.whatsapp.net'), 'PN device enumerated');
  assert.ok(lidJids.includes(USER + ':9@lid'), 'LID device enumerated separately');
  assert.ok(!lidJids.some(j => j.endsWith('@s.whatsapp.net')), 'no PN jids leaked into LID result');
  console.log('  ✓ same user on PN and LID is cached separately');
}

async function testClearCacheClearsBothServers() {
  const USER = '491533333333';
  const response = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('usync', {}, [
      new BinaryNode('list', {}, [
        new BinaryNode('user', { jid: USER + '@s.whatsapp.net' }, [
          new BinaryNode('devices', {}, [
            new BinaryNode('device-list', {}, [new BinaryNode('device', { id: '0' }, null)]),
          ]),
        ]),
      ]),
    ]),
  ]);
  let calls = 0;
  const dm = new DeviceManager({ _genMsgId: () => 'id', _sendIq: async () => { calls++; return response; } });

  await dm._usyncGetDevices([USER]);
  assert.strictEqual(calls, 1);
  await dm._usyncGetDevices([USER]);
  assert.strictEqual(calls, 1, 'cached');

  dm.clearCache([USER]);           // bare user must clear the PN entry
  await dm._usyncGetDevices([USER]);
  assert.strictEqual(calls, 2, 'clearCache with a bare user invalidates the entry');
  console.log('  ✓ clearCache with a bare user clears server-qualified entries');
}

// ── 3. changeGroupDescription sends prev ────────────────────────────────────

async function testDescriptionPrev() {
  const { WhalibmobClient } = require('../lib/Client');
  const GJID = '111-1@g.us';

  const client = Object.create(WhalibmobClient.prototype);
  client._groupMembers        = new Map();
  client._groupAddressingMode = new Map();
  client._groupDescId         = new Map([[GJID, 'OLDDESCID']]);
  client._lidToPn             = new Map();
  client._pnToLid             = new Map();
  let sent = null;
  client._genMsgId = () => 'NEWID';
  client._sendIq   = async (node) => { sent = node; return null; };

  await client.changeGroupDescription(GJID, 'new description');

  const descNode = sent.content.find(n => n.description === 'description');
  assert.strictEqual(descNode.attrs.prev, 'OLDDESCID',
    'prev must carry the current description id');
  assert.ok(descNode.attrs.id, 'a new description id must be set');
  console.log('  ✓ changeGroupDescription sends prev with the current desc id');
}

(async () => {
  console.log('Groups and LID addressing:');
  await testFetchAllGroupsWrapper();
  await testLidTargetsPreserved();
  await testPnAndLidNotConflated();
  await testClearCacheClearsBothServers();
  await testDescriptionPrev();
  console.log('\nAll group/LID tests passed.');
})().catch(err => { console.error('\nTEST FAILED:', err && err.stack || err); process.exit(1); });
