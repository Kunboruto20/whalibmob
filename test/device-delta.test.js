'use strict';

// Applying a `devices` notification without asking the server again.
//
// When a contact links or unlinks a device the server sends a notification
// saying what changed, and on each change the `device_hash` of the list we
// should end up with. That hash is the thing worth having: it turns "I applied
// the change, probably correctly" into something checkable, so the cached
// device list can be kept instead of thrown away and re-fetched.
//
// The hash is per change, not per notification. Someone linking a laptop and a
// tablet in one sitting sends two children carrying two different hashes — the
// list after the first change, then after the second. Reading them as a single
// change with a single hash, which is what this did, meant such a notification
// could never verify: it was rejected outright, the cache dropped, and a full
// usync round-trip paid on the next send. Exactly the case it was supposed to
// save.
//
// The steps are now applied one at a time and checked one at a time, as
// whatsmeow's handleDeviceNotification does.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { DeviceManager }   = require('../lib/DeviceManager');
const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');
const { computePhash }    = require('../lib/messages/MessageSender');

const PHONE = '40711111111';
const LID   = '112713111982325';

// The hash the server would send for this set of devices.
const hashOf = (ids, user, server) =>
  computePhash(ids.map(d => (d === 0 ? `${user}@${server}` : `${user}:${d}@${server}`)));

const pnHash  = (ids) => hashOf(ids, PHONE, 's.whatsapp.net');
const lidHash = (ids) => hashOf(ids, LID,   'lid');

function devMgr() {
  return new DeviceManager({ _genMsgId: () => 'ID1' });
}

// A <notification type="devices"> with one child per change.
const notif = (children) => new BinaryNode('notification',
  { type: 'devices', from: `${PHONE}@s.whatsapp.net`, id: 'N1' }, children);

const change = (tag, device, hash, opts) => {
  const attrs  = { device_hash: hash };
  const dattrs = { jid: device === 0 ? `${PHONE}@s.whatsapp.net`
                                     : `${PHONE}:${device}@s.whatsapp.net` };
  if (opts && opts.lidHash) attrs.device_lid_hash = opts.lidHash;
  if (opts && opts.lidDevice !== undefined) {
    dattrs.lid = opts.lidDevice === 0 ? `${LID}@lid` : `${LID}:${opts.lidDevice}@lid`;
  }
  return new BinaryNode(tag, attrs, [new BinaryNode('device', dattrs, null)]);
};

// Client.prototype._parseDeviceDelta needs no state.
const parse = (node) => WhalibmobClient.prototype._parseDeviceDelta.call({}, node);

// ─── the parser ──────────────────────────────────────────────────────────────

test('each child keeps its own hash instead of having to agree with the rest', () => {
  const steps = parse(notif([
    change('add', 3, pnHash([0, 3])),
    change('add', 4, pnHash([0, 3, 4]))
  ]));

  assert.equal(steps.length, 2);
  assert.equal(steps[0].deviceId, 3);
  assert.equal(steps[1].deviceId, 4);
  assert.notEqual(steps[0].hash, steps[1].hash, 'two changes, two hashes');
});

test('update survives as a step rather than rejecting the notification', () => {
  const steps = parse(notif([
    new BinaryNode('update', {}, null),
    change('add', 3, pnHash([0, 3]))
  ]));

  assert.equal(steps.length, 2);
  assert.equal(steps[0].tag, 'update');
  assert.equal(steps[1].tag, 'add');
});

test('a tag we do not model is skipped, not treated as a failure', () => {
  const steps = parse(notif([
    new BinaryNode('something_new', {}, null),
    change('add', 3, pnHash([0, 3]))
  ]));

  assert.equal(steps.length, 1);
  assert.equal(steps[0].deviceId, 3);
});

test('a change we cannot read rejects the whole notification', () => {
  assert.equal(parse(notif([change('add', 3, null)])), null, 'no hash');
  assert.equal(parse(notif([
    new BinaryNode('add', { device_hash: '2:AAAA' }, [new BinaryNode('device', {}, null)])
  ])), null, 'no device jid');
});

test('the LID half needs both its hash and its device, or it is left out', () => {
  const [onlyHash]   = parse(notif([change('add', 3, pnHash([0, 3]), { lidHash: '2:X' })]));
  const [onlyDevice] = parse(notif([change('add', 3, pnHash([0, 3]), { lidDevice: 3 })]));

  assert.equal(onlyHash.lidHash, null);
  assert.equal(onlyDevice.lidHash, null);
  assert.equal(onlyHash.lidDeviceId, null);
  assert.equal(onlyDevice.lidDeviceId, null);
});

// ─── applying them ───────────────────────────────────────────────────────────

test('two devices linked in one sitting keep the cache', () => {
  // The case that used to defeat this outright.
  const dm = devMgr();
  dm._dcSet(PHONE, [0]);

  const steps = parse(notif([
    change('add', 3, pnHash([0, 3])),
    change('add', 4, pnHash([0, 3, 4]))
  ]));
  const out = dm.applyDeviceDelta({ priKey: PHONE, priUser: PHONE, steps });

  assert.equal(out.primaryOk, true, 'no usync needed');
  assert.deepEqual(dm._dcGet(PHONE), [0, 3, 4]);
});

test('one added device verifies, the same as before', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([change('add', 3, pnHash([0, 3]))]))
  });

  assert.equal(out.primaryOk, true);
  assert.deepEqual(dm._dcGet(PHONE), [0, 3]);
});

test('an unlinked device is removed', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0, 3, 4]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([change('remove', 4, pnHash([0, 3]))]))
  });

  assert.equal(out.primaryOk, true);
  assert.deepEqual(dm._dcGet(PHONE), [0, 3]);
});

test('a hash that does not match drops the cache', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([change('add', 3, '2:notthehash')]))
  });

  assert.equal(out.primaryOk, false);
  assert.equal(dm._dcGet(PHONE), null, 'thrown away, usync will refill it');
});

test('a later step that does match puts a proven list back', () => {
  // whatsmeow keeps mutating its local copy after dropping the cached one, so a
  // notification that goes wrong in the middle and comes right again ends up
  // with a verified list rather than nothing.
  const dm = devMgr();
  dm._dcSet(PHONE, [0]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([
      change('add', 3, '2:wrong'),
      change('add', 4, pnHash([0, 3, 4]))
    ]))
  });

  assert.equal(out.primaryOk, true);
  assert.deepEqual(dm._dcGet(PHONE), [0, 3, 4]);
});

test('update drops the cache and the rest of the notification still runs', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0, 3]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([
      new BinaryNode('update', {}, null),
      change('add', 4, pnHash([0, 3, 4]))
    ]))
  });

  // The add still applies to the list this side was holding, and its hash
  // proves the result — so the cache comes back rather than staying empty.
  assert.equal(out.primaryOk, true);
  assert.deepEqual(dm._dcGet(PHONE), [0, 3, 4]);
});

test('an update on its own leaves nothing behind', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0, 3]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([new BinaryNode('update', {}, null)]))
  });

  assert.equal(out.primaryOk, false);
  assert.equal(dm._dcGet(PHONE), null);
});

test('no baseline means there is nothing to apply a change to', () => {
  const dm = devMgr();   // cache empty

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    steps: parse(notif([change('add', 3, pnHash([0, 3]))]))
  });

  assert.equal(out.primaryOk, false);
  assert.equal(dm._dcGet(PHONE), null, 'a list of one is not authoritative');
});

// ─── the two halves ──────────────────────────────────────────────────────────

test('the LID list is verified beside the phone one, on its own hash', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0]);
  dm._dcSet('lid:' + LID, [0]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    lidKey: 'lid:' + LID, lidUser: LID,
    steps: parse(notif([
      change('add', 3, pnHash([0, 3]), { lidHash: lidHash([0, 3]), lidDevice: 3 })
    ]))
  });

  assert.equal(out.primaryOk, true);
  assert.equal(out.lidOk, true);
  assert.deepEqual(dm._dcGet(PHONE), [0, 3]);
  assert.deepEqual(dm._dcGet('lid:' + LID), [0, 3]);
});

test('a wrong LID hash costs the phone list nothing', () => {
  const dm = devMgr();
  dm._dcSet(PHONE, [0]);
  dm._dcSet('lid:' + LID, [0]);

  const out = dm.applyDeviceDelta({
    priKey: PHONE, priUser: PHONE,
    lidKey: 'lid:' + LID, lidUser: LID,
    steps: parse(notif([
      change('add', 3, pnHash([0, 3]), { lidHash: '2:wrong', lidDevice: 3 })
    ]))
  });

  assert.equal(out.primaryOk, true, 'the two lists are hashed independently');
  assert.equal(out.lidOk, false);
  assert.deepEqual(dm._dcGet(PHONE), [0, 3]);
  assert.equal(dm._dcGet('lid:' + LID), null);
});

test('a notification addressed under the LID verifies against LID JIDs', () => {
  const dm = devMgr();
  dm._dcSet('lid:' + LID, [0]);

  const steps = [{
    tag: 'add', deviceId: 3, hash: lidHash([0, 3]),
    lidDeviceId: null, lidHash: null
  }];
  const out = dm.applyDeviceDelta({
    priKey: 'lid:' + LID, priUser: LID, priServer: 'lid', steps
  });

  assert.equal(out.primaryOk, true);
  assert.deepEqual(dm._dcGet('lid:' + LID), [0, 3]);
});

test('applyDeviceDelta says no rather than throwing on nonsense', () => {
  const dm = devMgr();
  assert.deepEqual(dm.applyDeviceDelta({}), { primaryOk: false, lidOk: false });
  assert.deepEqual(dm.applyDeviceDelta({ priKey: PHONE, priUser: PHONE, steps: [] }),
    { primaryOk: false, lidOk: false });
});
