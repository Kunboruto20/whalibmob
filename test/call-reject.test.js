'use strict';

// Refusing calls, or deciding not to.
//
// Every incoming call was refused unconditionally, with nothing to turn it off.
// That is the right default and the wrong only option: a caller that wants to
// let some calls ring and reject the rest had no way in, because the refusal
// was already on the wire before any event handler saw it.
//
// And then it refused nothing at all. The call id was read as `call_id`, a name
// no stanza carries — the protocol spells it `call-id`, and the binary token
// table this library ships proves it: `call-id` and `call-creator` are in there,
// the underscored spellings are not. So the id was always null, the event
// announced a call nobody could identify, and the automatic refusal never fired.
// These tests use the real attribute names.

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
    _store: { phoneNumber: '40711111111' },
    _myLid: (opts && opts.myLid) || null,
    _events: {},
    emit: function (name, payload) { (this._events[name] = this._events[name] || []).push(payload); }
  });
  c.sent = sent;
  c.seen = (name) => c._events[name] || [];
  // The ack every incoming call now gets is not what these tests are about.
  c.rejects = () => sent.filter(n => n.description === 'call');
  c.acks    = () => sent.filter(n => n.description === 'ack');
  return c;
}

const callNode = (tag, from, attrs) =>
  new BinaryNode('call', { from, id: 'STANZA-1', t: '1788651994' },
    [new BinaryNode(tag, attrs || {}, null)]);

const offerNode = (from, callId) => callNode('offer', from, { 'call-id': callId });

test('by default an incoming call is refused', () => {
  const c = client();
  c._handleCall(offerNode('40712345678@s.whatsapp.net', 'CALL-1'));

  assert.equal(c.rejects().length, 1, 'a reject went out');
  const [node] = c.rejects();
  assert.equal(String(node.attrs.to), '40712345678@s.whatsapp.net');
  assert.equal(String(node.attrs.from), '40711111111@s.whatsapp.net',
    'and it says who is refusing');
  const reject = node.content[0];
  assert.equal(reject.description, 'reject');
  assert.equal(reject.attrs['call-id'], 'CALL-1');
  assert.equal(String(reject.attrs['call-creator']), '40712345678@s.whatsapp.net');
  assert.equal(reject.attrs.count, '0');
  assert.equal(reject.attrs.call_id, undefined, 'not under the name nothing uses');
});

test('the id is read from call-id, which is what the server sends', () => {
  const c = client({ autoRejectCalls: false });
  c._handleCall(offerNode('40712345678@s.whatsapp.net', 'A4B2B693BE4ADC'));

  assert.equal(c.seen('call')[0].id, 'A4B2B693BE4ADC');
});

test('a LID caller is refused as a LID, with the device dropped from both ends', () => {
  const c = client({ myLid: '250139683860650@lid' });
  const from = Object.assign(Object.create({
    toString() { return '112713111982325@lid'; }
  }), { user: '112713111982325', agent: 1, device: 0, server: 'lid' });

  c._handleCall(new BinaryNode('call', { from, id: 'S1', version: '2.26.33.74', platform: 'smba' }, [
    new BinaryNode('offer', { 'call-id': 'CALL-LID', 'call-creator': '112713111982325:7@lid' }, null)
  ]));

  const [node] = c.rejects();
  assert.equal(String(node.attrs.to), '112713111982325@lid', 'device stripped');
  assert.equal(String(node.attrs.from), '250139683860650@lid', 'answered from our own LID');
  assert.equal(String(node.content[0].attrs['call-creator']), '112713111982325@lid');
});

test('the creator, not the stanza sender, is what gets refused', () => {
  const c = client();
  c._handleCall(new BinaryNode('call', { from: '120363000000000000@g.us', id: 'S2' }, [
    new BinaryNode('offer', {
      'call-id': 'CALL-G', 'call-creator': '40799999999@s.whatsapp.net',
      'group-jid': '120363000000000000@g.us'
    }, null)
  ]));

  const [evt] = c.seen('call');
  assert.equal(evt.creator,  '40799999999@s.whatsapp.net');
  assert.equal(evt.groupJid, '120363000000000000@g.us');
  assert.equal(String(c.rejects()[0].attrs.to), '40799999999@s.whatsapp.net');
});

test('every incoming call is acknowledged, refused or not', () => {
  const c = client({ autoRejectCalls: false });
  c._handleCall(offerNode('40712345678@s.whatsapp.net', 'CALL-ACK'));

  assert.equal(c.acks().length, 1);
  const [ack] = c.acks();
  assert.equal(ack.attrs.class, 'call');
  assert.equal(ack.attrs.id, 'STANZA-1');
  assert.equal(String(ack.attrs.to), '40712345678@s.whatsapp.net');
});

test('a call whose shape we do not know is still acknowledged', () => {
  const c = client();
  c._handleCall(new BinaryNode('call', { from: 'x@s.whatsapp.net', id: 'S3' }, [
    new BinaryNode('something_new', {}, null)
  ]));

  assert.equal(c.acks().length, 1, 'the server hears that it arrived');
  assert.equal(c.seen('call')[0].status, 'unknown');
  assert.equal(c.seen('call')[0].tag, 'something_new', 'and the tag is not lost');
  assert.equal(c.rejects().length, 0);
});

test('with autoRejectCalls off nothing is refused on its own', () => {
  const c = client({ autoRejectCalls: false });
  c._handleCall(offerNode('40712345678@s.whatsapp.net', 'CALL-2'));

  assert.equal(c.rejects().length, 0, 'the call is left to ring');
  assert.equal(c.seen('call').length, 1, 'but it is still announced');
});

test('the event carries the id and the stage, not just the caller', () => {
  const c = client({ autoRejectCalls: false });
  c._handleCall(new BinaryNode('call',
    { from: '40799999999@s.whatsapp.net', id: 'S4', t: '1788651994',
      platform: 'smba', version: '2.26.33.74' },
    [new BinaryNode('offer', { 'call-id': 'CALL-3', caller_lid: '250139683860650@lid' }, null)]));

  const [evt] = c.seen('call');
  assert.equal(evt.from, '40799999999@s.whatsapp.net');
  assert.equal(evt.id, 'CALL-3');
  assert.equal(evt.status, 'offer');
  assert.equal(evt.platform, 'smba');
  assert.equal(evt.version, '2.26.33.74');
  assert.equal(evt.ts, 1788651994);
  assert.equal(evt.creatorAlt, '250139683860650@lid', 'the caller\'s other name');
  assert.ok(evt.node, 'the raw node is still there');
});

test('rejectCall refuses the one it was given', () => {
  const c = client({ autoRejectCalls: false });
  assert.equal(c.rejectCall('CALL-4', '40700000000@s.whatsapp.net'), true);

  assert.equal(c.rejects().length, 1);
  assert.equal(c.rejects()[0].content[0].attrs['call-id'], 'CALL-4');
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
  c._handleCall(callNode('terminate', 'x@s.whatsapp.net',
    { 'call-id': 'CALL-6', reason: 'timeout' }));

  const [evt] = c.seen('call');
  assert.equal(evt.status, 'terminate');
  assert.equal(evt.id, 'CALL-6');
  assert.equal(evt.reason, 'timeout');
  assert.equal(c.rejects().length, 0, 'a call that already ended is not rejected');
});

test('every stage the protocol uses gets a name', () => {
  const stages = [
    ['offer', 'offer'], ['offer_notice', 'offer_notice'], ['relaylatency', 'ringing'],
    ['accept', 'accept'], ['preaccept', 'preaccept'], ['transport', 'transport'],
    ['terminate', 'terminate'], ['reject', 'reject']
  ];
  for (const [tag, status] of stages) {
    const c = client({ autoRejectCalls: false });
    c._handleCall(callNode(tag, 'x@s.whatsapp.net', { 'call-id': 'C' }));
    assert.equal(c.seen('call')[0].status, status, tag);
  }
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
  assert.equal(c.sent.length, 0, 'nor acknowledged — it is an answer, not a push');
});
