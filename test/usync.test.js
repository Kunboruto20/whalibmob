'use strict';

// Regression tests for multi-device fanout (USync device enumeration).
//
// The bug: the USync query response nests devices as
//   <user jid='PHONE@s.whatsapp.net'><devices><device-list>
//     <device id='0'/><device id='11' key-index='2'/>
//   </device-list></devices></user>
// but the parser looked for a `jid` attribute on <device> nodes. Devices are
// identified by an `id` attribute with the JID on the parent <user>, so no
// linked devices were ever extracted and every recipient collapsed to device 0
// — messages reached the primary phone but linked devices showed
// "waiting for this message". This affected both 1:1 and group sends.

const assert = require('assert');
const { BinaryNode } = require('../lib/BinaryNode');
const { DeviceManager } = require('../lib/DeviceManager');

function makeFakeClient(response) {
  let n = 0;
  return {
    _genMsgId: () => 'id' + (++n),
    _sendIq: async () => response,
  };
}

function usyncResponseFor(phone, deviceEntries) {
  const jid = phone + '@s.whatsapp.net';
  const deviceNodes = deviceEntries.map(([id, keyIndex]) =>
    new BinaryNode('device', keyIndex == null ? { id: String(id) } : { id: String(id), 'key-index': String(keyIndex) }, null)
  );
  return new BinaryNode('iq', { type: 'result', from: 's.whatsapp.net' }, [
    new BinaryNode('usync', { sid: 'x' }, [
      new BinaryNode('list', {}, [
        new BinaryNode('user', { jid }, [
          new BinaryNode('devices', { version: '2' }, [
            new BinaryNode('device-list', {}, deviceNodes),
          ]),
        ]),
      ]),
    ]),
  ]);
}

async function testEnumeratesAllDevices() {
  const PHONE = '491511111111';
  const resp = usyncResponseFor(PHONE, [[0], [11, 2], [23, 5]]);
  const dm = new DeviceManager(makeFakeClient(resp));
  const jids = await dm._usyncGetDevices([PHONE]);

  assert.strictEqual(jids.length, 3, 'should enumerate primary + 2 linked devices');
  assert.ok(jids.includes(PHONE + '@s.whatsapp.net'), 'primary device present');
  assert.ok(jids.includes(PHONE + ':11@s.whatsapp.net'), 'linked device 11 present');
  assert.ok(jids.includes(PHONE + ':23@s.whatsapp.net'), 'linked device 23 present');
  console.log('  ✓ enumerates primary + all linked devices');
}

async function testNonZeroWithoutKeyIndexIgnored() {
  const PHONE = '491522222222';
  // device 7 has no key-index → must be skipped (server would reject it).
  const resp = usyncResponseFor(PHONE, [[0], [7], [9, 3]]);
  const dm = new DeviceManager(makeFakeClient(resp));
  const jids = await dm._usyncGetDevices([PHONE]);

  assert.ok(jids.includes(PHONE + '@s.whatsapp.net'), 'primary present');
  assert.ok(!jids.includes(PHONE + ':7@s.whatsapp.net'), 'device 7 (no key-index) skipped');
  assert.ok(jids.includes(PHONE + ':9@s.whatsapp.net'), 'device 9 (with key-index) present');
  console.log('  ✓ non-zero device without key-index is skipped');
}

async function testCachePreventsSecondQuery() {
  const PHONE = '491533333333';
  let calls = 0;
  const resp = usyncResponseFor(PHONE, [[0], [4, 1]]);
  const client = { _genMsgId: () => 'id', _sendIq: async () => { calls++; return resp; } };
  const dm = new DeviceManager(client);

  await dm._usyncGetDevices([PHONE]);
  await dm._usyncGetDevices([PHONE]);
  assert.strictEqual(calls, 1, 'second lookup should hit the cache, not re-query');
  console.log('  ✓ device cache prevents redundant USync IQ');
}

async function testNoDevicesFallsBackToPrimary() {
  const PHONE = '491544444444';
  const empty = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('usync', {}, [new BinaryNode('list', {}, [])]),
  ]);
  const dm = new DeviceManager(makeFakeClient(empty));
  const jids = await dm._usyncGetDevices([PHONE]);
  assert.deepStrictEqual(jids, [PHONE + '@s.whatsapp.net'], 'empty response → primary device only');
  console.log('  ✓ empty response falls back to primary device');
}

(async () => {
  console.log('USync device enumeration:');
  await testEnumeratesAllDevices();
  await testNonZeroWithoutKeyIndexIgnored();
  await testCachePreventsSecondQuery();
  await testNoDevicesFallsBackToPrimary();
  console.log('\nAll USync tests passed.');
})().catch(err => { console.error('\nTEST FAILED:', err.message); process.exit(1); });
