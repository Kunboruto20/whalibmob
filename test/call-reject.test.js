'use strict';

// Refusing calls, or deciding not to.
//
// Every incoming call was refused unconditionally, with nothing to turn it off.
// That is the right default and the wrong only option: a caller that wants to
// let some calls ring and reject the rest had no way in, because the refusal
// was already on the wire before any event handler saw it.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');

// A client with the socket stubbed: enough to exercise _handleCall end to end
// and see exactly what it would have put on the wire.
function client(opts) {
  const sent = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true,
    _pendingIqs: new Map(),
    _genMsgId: () => 'ID1',
    _socket: { sendNode: (n) => sent.push(n) },
    _autoRejectCalls: !opts || opts.autoRejectCalls !== false,
    _events: {},
    emit: function (name, payload) { (this._events[name] = this._events[name] || []).push(payload); }
  });
  c.sent = sent;
  c.seen = (name) => c._events[name] || [];
  return c;
}

const offerNode = (from, callId) => new BinaryNode('call', { from }, [
  new BinaryNode('offer', { call_id: callId }, null)
]);

test('by default an incoming call is refused', () => {
  const c = client();
  c._handleCall(offerNode('40712345678@s.whatsapp.net', 'CALL-1'));

  assert.equal(c.sent.length, 1, 'a reject went out');
  const [node] = c.sent;
  assert.equal(node.description, 'call');
  assert.equal(node.attrs.to, '40712345678@s.whatsapp.net');
  const reject = node.content[0];
  assert.equal(reject.description, 'reject');
  assert.equal(reject.attrs.call_id, 'CALL-1');
  assert.equal(reject.attrs.call_creator, '40712345678@s.whatsapp.net');
});

test('with autoRejectCalls off nothing is sent on its own', () => {
  const c = client({ autoRejectCalls: false });
  c._handleCall(offerNode('40712345678@s.whatsapp.net', 'CALL-2'));

  assert.equal(c.sent.length, 0, 'the call is left to ring');
  assert.equal(c.seen('call').length, 1, 'but it is still announced');
});

test('the event carries the id and the stage, not just the caller', () => {
  const c = client({ autoRejectCalls: false });
  c._handleCall(offerNode('40799999999@s.whatsapp.net', 'CALL-3'));

  const [evt] = c.seen('call');
  assert.equal(evt.from, '40799999999@s.whatsapp.net');
  assert.equal(evt.id, 'CALL-3');
  assert.equal(evt.status, 'offer');
  assert.ok(evt.node, 'the raw node is still there');
});

test('rejectCall refuses the one it was given', () => {
  const c = client({ autoRejectCalls: false });
  assert.equal(c.rejectCall('CALL-4', '40700000000@s.whatsapp.net'), true);

  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].content[0].attrs.call_id, 'CALL-4');
});

test('rejectCall says no rather than throwing when it cannot send', () => {
  const c = client({ autoRejectCalls: false });
  assert.equal(c.rejectCall('', 'x@s.whatsapp.net'), false, 'no call id');

  c._connected = false;
  assert.equal(c.rejectCall('CALL-5', 'x@s.whatsapp.net'), false, 'not connected');
  assert.equal(c.sent.length, 0);
});

test('a terminate is reported, and never answered with a reject', () => {
  const c = client();   // auto-reject ON
  c._handleCall(new BinaryNode('call', { from: 'x@s.whatsapp.net' }, [
    new BinaryNode('terminate', { call_id: 'CALL-6' }, null)
  ]));

  assert.equal(c.seen('call')[0].status, 'terminate');
  assert.equal(c.sent.length, 0, 'a call that already ended is not rejected');
});

test('a reply to something we asked for is not treated as an incoming call', () => {
  const c = client();
  let handed = null;
  c._pendingIqs.set('REQ-1', (n) => { handed = n; });

  c._handleCall(new BinaryNode('call', { from: 's.whatsapp.net', id: 'REQ-1' }, [
    new BinaryNode('relaylatency', {}, null)
  ]));

  assert.ok(handed, 'it went to whoever was waiting for it');
  assert.equal(c.seen('call').length, 0, 'and was not announced as a call');
  assert.equal(c.sent.length, 0);
});
