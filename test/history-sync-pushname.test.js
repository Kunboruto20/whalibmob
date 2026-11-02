'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { type } = require('./helpers/history-proto');
const { decodeWebMessageInfo } = require('../lib/HistorySyncHandler');

// A WebMessageInfo carries the sender's JID in field 5 (participant) and the
// sender's name in field 19 (pushName). The decoder read the name from five, so
// a group message came back with the JID where the name belonged.

function encode(props) {
  const WMI = type('WebMessageInfo');
  return Buffer.from(WMI.encode(WMI.create(props)).finish());
}

test('pushName is field 19 and participant is field 5', () => {
  const d = decodeWebMessageInfo(encode({
    key: { remoteJID: '120363@g.us', fromMe: false, ID: 'ABC', participant: '4477@s.whatsapp.net' },
    messageTimestamp: 1793620000,
    status: 3,
    participant: '4477@s.whatsapp.net',
    pushName: 'Ayşe'
  }));
  assert.equal(d.pushName, 'Ayşe');
  assert.equal(d.participant, '4477@s.whatsapp.net');
  assert.equal(d.key.id, 'ABC');
});

test('a one-to-one message keeps its pushName and has no participant', () => {
  const d = decodeWebMessageInfo(encode({
    key: { remoteJID: '4477@s.whatsapp.net', fromMe: false, ID: 'DEF' },
    messageTimestamp: 1793620001,
    status: 4,
    pushName: 'Ayşe'
  }));
  assert.equal(d.pushName, 'Ayşe');
  assert.equal(d.participant, undefined);
});
