'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The history a primary hands a newly linked WhatsApp Web, as a HistorySync.
//
// Web never says what it disliked about one: it sits on "Loading chats" and
// then logs itself out. So nothing here decodes with the library. Every
// assertion reads the bytes back through protobufjs over the fixture schema,
// which is written from WhatsApp's field numbers and shares no code with the
// encoder. The one thing compared to the library is the empty export, against
// the bootstrap that was validated live, and that comparison is byte for byte.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { type } = require('./helpers/history-proto');
const Bootstrap = require('../lib/PrimaryBootstrap');
const { PrimaryMessageStore } = require('../lib/primary/MessageStore');
const { INLINE_MAX, buildHistorySync, buildNotification, recordsAfter, exportedCounts } = require('../lib/primary/HistoryExport');

const ANA   = '40799999999@s.whatsapp.net';
const BOB   = '40788888888@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const T     = 1790000000;   // seconds, as the store keeps ts

// A Snapshot in the shape PrimaryMessageStore.snapshot() returns it.
function snapshot({ seq = 0, chats = [], records = {}, pushNames = [] } = {}) {
  let count = 0;
  for (const list of Object.values(records)) count += list.length;
  return {
    seq,
    capture: { since: T * 1000, origin: 'enabled', lc: 0 },
    chats,
    records,
    losses: [],
    retained: { evicted: 0 },
    pushNames,
    counts: { chats: chats.length, records: count }
  };
}
function rec(id, seq, ts, extra = {}) {
  return { id, seq, fromMe: false, ts, status: 3, raw: Buffer.from('raw-' + id), ...extra };
}
// Real Message bytes, so "verbatim" is checked on something Web would parse.
function textMessage(text) {
  const M = type('Message');
  return Buffer.from(M.encode(M.create({ conversation: text })).finish());
}

// The independent read: inflate, decode with the fixture, numbers as numbers.
// Without `defaults`, a field the encoder did not write is absent from the
// object, so `'name' in conv` means the field was on the wire.
// The HistorySync as it goes over the wire.
function decodeSyncWire(deflated) {
  const H = type('HistorySync');
  return H.toObject(H.decode(zlib.inflateSync(deflated)), { longs: Number });
}
// The same with each chat's messages in the order they happened, by msgOrderID
// (the wire carries them newest first, pinned by its own test below).
function decodeSync(deflated) {
  const sync = decodeSyncWire(deflated);
  for (const conv of sync.conversations || []) if (conv.messages) conv.messages.sort((a, b) => a.msgOrderID - b.msgOrderID);
  return sync;
}
function decodeNotification(bytes) {
  const M = type('Message');
  const msg = M.toObject(M.decode(bytes), { longs: Number });
  return { type: msg.protocolMessage.type, hsn: msg.protocolMessage.historySyncNotification };
}
const ids = conv => (conv.messages || []).map(m => m.message.key.ID);

test('empty snapshot is byte-identical to the live-validated bootstrap', () => {
  const empty = snapshot();
  assert.ok(zlib.inflateSync(buildHistorySync(empty)).equals(Bootstrap.proto([[1, 0], [5, 0], [6, 100]])));
  assert.ok(buildNotification({ inline: buildHistorySync(empty) })
    .equals(Bootstrap.initialHistory({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 })));
});

// The encoder does not sort. The store hands chats out by conversationTimestamp
// desc and records by ts asc. Chats go over in that order; a chat's messages go
// newest first, as the phone sends them: Web reverses the list it is given
// (handleInitialSyncMsgs) and takes the last one's msgOrderID as the oldest it
// holds. msgOrderID counts up from the oldest, 1..n. Found live: sent oldest
// first, Web showed the chat upside down with the oldest message as its last.
test('a chat\'s messages go newest first, with msgOrderID counting up from the oldest', () => {
  const snap = snapshot({
    chats: [
      { id: ANA, name: 'Ana', conversationTimestamp: T + 300, unreadCount: 2 },
      { id: BOB, conversationTimestamp: T + 200, unreadCount: 0 },
      { id: GROUP, name: 'Family', conversationTimestamp: T + 100, unreadCount: 1 }
    ],
    records: {
      [ANA]: [rec('A1', 4, T + 250, { fromMe: true, status: 4 }), rec('A2', 2, T + 260), rec('A3', 6, T + 300)],
      [BOB]: [rec('B1', 1, T + 150), rec('B2', 5, T + 200, { fromMe: true, status: 2 })],
      [GROUP]: [rec('G1', 3, T + 100, { participant: BOB })]
    }
  });
  const sync = decodeSyncWire(buildHistorySync(snap));

  assert.equal(sync.syncType, 0);
  assert.equal(sync.chunkOrder, 0);
  assert.equal(sync.progress, 100);
  assert.deepEqual(sync.conversations.map(c => c.ID), [ANA, BOB, GROUP]);
  assert.deepEqual(sync.conversations.map(ids), [['A3', 'A2', 'A1'], ['B2', 'B1'], ['G1']]);
  assert.deepEqual(sync.conversations.map(c => c.messages.map(m => m.msgOrderID)), [[3, 2, 1], [2, 1], [1]]);

  // From here on, in the order they happened.
  for (const conv of sync.conversations) conv.messages.reverse();
  const [ana, bob, group] = sync.conversations;
  assert.equal(ana.conversationTimestamp, T + 300);
  assert.equal(ana.unreadCount, 2);
  assert.equal(ana.name, 'Ana');
  assert.equal(bob.unreadCount, 0);
  assert.equal(group.name, 'Family');
  // Only what the chat has goes on the wire.
  assert.ok(!('name' in bob));
  assert.ok(!('pnJID' in ana) && !('lidJID' in ana));

  const a1 = ana.messages[0].message;
  assert.deepEqual(a1.key, { remoteJID: ANA, fromMe: true, ID: 'A1' });
  assert.equal(a1.messageTimestamp, T + 250);
  assert.equal(a1.status, 4);
  assert.equal(ana.messages[1].message.key.fromMe, false);
  assert.equal(bob.messages[1].message.status, 2);

  // The same snapshot gives the same bytes.
  assert.ok(buildHistorySync(snap).equals(buildHistorySync(snap)));

  // Explicit chunk fields, zero included.
  const chunk = decodeSync(buildHistorySync(snapshot(), { syncType: 3, chunkOrder: 2, progress: 0 }));
  assert.equal(chunk.syncType, 3);
  assert.equal(chunk.chunkOrder, 2);
  assert.ok('progress' in chunk);
  assert.equal(chunk.progress, 0);
});

test('raw content is embedded verbatim', () => {
  const hello = textMessage('Merhaba 👋');
  const edited = textMessage('düzeltildi');
  const opaque = Buffer.from([0x0a, 0x00, 0xff, 0x80, 0x01]);
  const records = [
    rec('M1', 1, T, { raw: hello }),
    rec('M2', 3, T + 1, { raw: edited, edited: T + 5 }),
    rec('M3', 2, T + 2, { raw: opaque })
  ];
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [{ id: ANA, conversationTimestamp: T + 2, unreadCount: 0 }],
    records: { [ANA]: records }
  })));
  const messages = sync.conversations[0].messages;
  assert.equal(messages.length, 3);
  messages.forEach((m, i) => assert.ok(Buffer.from(m.message.message).equals(records[i].raw), records[i].id));
  const M = type('Message');
  assert.equal(M.decode(messages[0].message.message).conversation, 'Merhaba 👋');
});

test('export keeps a LID participant verbatim in key and info', () => {
  const lid = '123456789012345@lid';
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: GROUP, conversationTimestamp: T + 1, unreadCount: 1 },
      { id: ANA, conversationTimestamp: T, unreadCount: 1 }
    ],
    records: {
      [GROUP]: [rec('G1', 1, T + 1, { participant: lid, pushName: 'Ayşe' })],
      [ANA]: [rec('A1', 2, T, { pushName: 'Ana' })]
    }
  })));
  const g1 = sync.conversations[0].messages[0].message;
  assert.equal(g1.key.remoteJID, GROUP);
  assert.equal(g1.key.participant, lid);
  assert.equal(g1.participant, lid);
  assert.equal(g1.pushName, 'Ayşe');

  // A one-to-one message has no participant anywhere.
  const a1 = sync.conversations[1].messages[0].message;
  assert.ok(!('participant' in a1.key));
  assert.ok(!('participant' in a1));
  assert.equal(a1.pushName, 'Ana');
});

test('revoked is exported as stub REVOKE without content; expired and view-once are absent', () => {
  // The store has already dropped the bytes of everything buried. These carry
  // raw anyway, as a store bug would, to prove the encoder alone keeps them out.
  const secret = id => Buffer.from('SECRET-CONTENT-' + id);
  const records = [
    rec('M1', 1, T, { raw: textMessage('kept one') }),
    rec('M2', 7, T + 1, { tombstone: 'revoked', raw: secret('M2'), fromMe: true, status: 4 }),
    rec('M3', 8, T + 2, { tombstone: 'expired', raw: secret('M3') }),
    rec('M4', 9, T + 3, { tombstone: 'view-once', raw: secret('M4') }),
    rec('M5', 5, T + 4, { raw: textMessage('kept two') }),
    rec('M6', 6, T + 5, { tombstone: 'revoked' })
  ];
  const deflated = buildHistorySync(snapshot({
    chats: [{ id: ANA, conversationTimestamp: T + 5, unreadCount: 0 }],
    records: { [ANA]: records }
  }));
  const plain = zlib.inflateSync(deflated);
  for (const id of ['M2', 'M3', 'M4']) assert.equal(plain.indexOf(secret(id)), -1, id + ' content leaked');

  const conv = decodeSync(deflated).conversations[0];
  assert.deepEqual(ids(conv), ['M1', 'M2', 'M5', 'M6']);
  assert.deepEqual(conv.messages.map(m => m.msgOrderID), [1, 2, 3, 4]);

  const m2 = conv.messages[1].message;
  assert.ok(!('message' in m2), 'a revoked message carries no content');
  assert.equal(m2.messageStubType, 1);
  assert.deepEqual(m2.key, { remoteJID: ANA, fromMe: true, ID: 'M2' });
  assert.equal(m2.messageTimestamp, T + 1);
  assert.ok(!('message' in conv.messages[3].message));
  assert.equal(conv.messages[3].message.messageStubType, 1);

  // Content is never a stub.
  assert.ok(!('messageStubType' in conv.messages[0].message));
  assert.ok(!('messageStubType' in conv.messages[2].message));
});

test('pushnames and pn-lid mappings are exported', () => {
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: '99999@lid', pnJid: ANA, lidJid: '99999@lid', conversationTimestamp: T + 3, unreadCount: 0 },
      { id: BOB, pnJid: BOB, conversationTimestamp: T + 2, unreadCount: 0 },
      { id: '88888@lid', lidJid: '88888@lid', conversationTimestamp: T + 1, unreadCount: 0 },
      { id: GROUP, conversationTimestamp: T, unreadCount: 0 }
    ],
    pushNames: [{ id: ANA, pushname: 'Ana' }, { id: '77777@lid', pushname: 'Ayşe' }]
  })));

  assert.deepEqual(sync.pushnames, [{ ID: ANA, pushname: 'Ana' }, { ID: '77777@lid', pushname: 'Ayşe' }]);
  // Only a chat that knows both of its jids makes a mapping.
  assert.deepEqual(sync.phoneNumberToLidMappings, [{ pnJID: ANA, lidJID: '99999@lid' }]);

  const [lidChat, bob, other, group] = sync.conversations;
  assert.equal(lidChat.pnJID, ANA);
  assert.equal(lidChat.lidJID, '99999@lid');
  assert.equal(bob.pnJID, BOB);
  assert.ok(!('lidJID' in bob));
  assert.equal(other.lidJID, '88888@lid');
  assert.ok(!('pnJID' in other));
  assert.ok(!('pnJID' in group) && !('lidJID' in group));
});

// Web on an account moved to LIDs skips a 1:1 chat that comes under a number
// without accountLid ("Migrated account not sending accountLid for a PN chat
// in history sync" in its handleInitialSyncMsgs): the chat and every message
// in it are dropped. Found live: the history arrived, Web acked it, no chats.
test('a 1:1 chat under a number carries its lid as accountLid, which Web needs to keep it', () => {
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: ANA, pnJid: ANA, lidJid: '99999@lid', conversationTimestamp: T + 3, unreadCount: 0 },
      { id: BOB, pnJid: BOB, conversationTimestamp: T + 2, unreadCount: 0 },
      { id: '88888@lid', pnJid: '40777777777@s.whatsapp.net', lidJid: '88888@lid', conversationTimestamp: T + 1, unreadCount: 0 },
      { id: GROUP, lidJid: '77777@lid', conversationTimestamp: T, unreadCount: 0 }
    ]
  })));
  const [ana, bob, lidChat, group] = sync.conversations;
  assert.equal(ana.accountLid, '99999@lid');
  // No lid known: nothing to send (Web will not keep it, but a guess is worse).
  assert.ok(!('accountLid' in bob));
  // Under its lid already: Web takes the id itself.
  assert.ok(!('accountLid' in lidChat));
  assert.ok(!('accountLid' in group));
});

// The inline payload is the initial bootstrap's alone (its name says so). Found
// live: a RECENT chunk sent inline left Web's chunk status at "downloading"
// for good, and Web never counted the sync as complete.
test('only the initial bootstrap may go inline; any other chunk is a blob', () => {
  const inline = buildHistorySync(snapshot(), { syncType: 3 });
  assert.throws(() => buildNotification({ inline }, { syncType: 3 }), { code: 'PRIMARY_HISTORY_EXPORT_INLINE_NOT_INITIAL' });
  assert.ok(Buffer.isBuffer(buildNotification({ inline: buildHistorySync(snapshot()) }, { syncType: 0 })));
});

test('blob notification carries all five media fields and no inline payload', () => {
  const blob = {
    directPath: '/v/t62.7119-24/12345_67890?ccb=11-4&oh=01_x&oe=6A0B1C2D',
    mediaKey: Buffer.alloc(32, 1),
    fileSha256: Buffer.alloc(32, 2),
    fileEncSha256: Buffer.alloc(32, 3),
    fileLength: 734003
  };
  const { type: kind, hsn } = decodeNotification(buildNotification({ blob }, { syncType: 0, chunkOrder: 0, progress: 100 }));
  assert.equal(kind, 5);   // HISTORY_SYNC_NOTIFICATION
  assert.ok(Buffer.from(hsn.fileSHA256).equals(blob.fileSha256));
  assert.equal(hsn.fileLength, blob.fileLength);
  assert.ok(Buffer.from(hsn.mediaKey).equals(blob.mediaKey));
  assert.ok(Buffer.from(hsn.fileEncSHA256).equals(blob.fileEncSha256));
  assert.equal(hsn.directPath, blob.directPath);
  // Zero is written, not left for Web to assume.
  assert.ok('syncType' in hsn && 'chunkOrder' in hsn);
  assert.equal(hsn.syncType, 0);
  assert.equal(hsn.chunkOrder, 0);
  assert.equal(hsn.progress, 100);
  assert.ok(!('initialHistBootstrapInlinePayload' in hsn));

  const later = decodeNotification(buildNotification({ blob }, { syncType: 3, chunkOrder: 4, progress: 80 })).hsn;
  assert.equal(later.syncType, 3);
  assert.equal(later.chunkOrder, 4);
  assert.equal(later.progress, 80);

  // The inline form carries the payload and none of the media fields.
  const inline = decodeNotification(buildNotification({ inline: buildHistorySync(snapshot()) })).hsn;
  assert.ok(Buffer.from(inline.initialHistBootstrapInlinePayload).equals(buildHistorySync(snapshot())));
  for (const field of ['fileSHA256', 'fileLength', 'mediaKey', 'fileEncSHA256', 'directPath']) assert.ok(!(field in inline), field);
});

test('a notification takes exactly one payload, and inline only up to INLINE_MAX', () => {
  const blob = { directPath: '/v/x', mediaKey: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), fileLength: 1 };
  const code = /^PRIMARY_HISTORY_EXPORT_[A-Z_]+$/;
  const fails = fn => assert.throws(fn, e => code.test(e.code));
  assert.equal(INLINE_MAX, 64 * 1024);
  assert.doesNotThrow(() => buildNotification({ inline: Buffer.alloc(INLINE_MAX) }));
  // Bigger than this goes as an md-msg-hist blob; inline it would be refused.
  fails(() => buildNotification({ inline: Buffer.alloc(INLINE_MAX + 1) }));
  fails(() => buildNotification({}));
  fails(() => buildNotification({ inline: Buffer.alloc(1), blob }));
  fails(() => buildNotification({ blob: { ...blob, mediaKey: undefined } }));
  fails(() => buildNotification({ blob: { ...blob, directPath: '' } }));

  // An inline that is not a Buffer is not "no inline". protobufjs would take a
  // string as base64 and write it, so each of these is refused outright.
  const invalid = fn => assert.throws(fn, e => e.code === 'PRIMARY_HISTORY_EXPORT_PAYLOAD_INVALID');
  invalid(() => buildNotification({ inline: 'QUJD', blob }));
  invalid(() => buildNotification({ inline: new Uint8Array([1, 2, 3]), blob }));
  invalid(() => buildNotification({ inline: 'x', blob: {} }));
  invalid(() => buildNotification({ inline: 'QUJD' }));
  invalid(() => buildNotification(null));
});

test('chunk options are non-negative integers and progress is at most 100', () => {
  const empty = snapshot();
  const blob = { directPath: '/v/x', mediaKey: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), fileLength: 1 };
  const invalid = fn => assert.throws(fn, e => e.code === 'PRIMARY_HISTORY_EXPORT_OPTIONS_INVALID');
  for (const bad of [{ progress: 101 }, { progress: -1 }, { syncType: -1 }, { chunkOrder: 1.5 }, { syncType: '0' },
    { progress: NaN }, { chunkOrder: null }, { chunkOrder: 2 ** 32 }]) {
    invalid(() => buildHistorySync(empty, bad));
    invalid(() => buildNotification({ blob }, bad));
  }
  assert.doesNotThrow(() => buildHistorySync(empty, { syncType: 6, chunkOrder: 0xffffffff, progress: 0 }));
  assert.doesNotThrow(() => buildNotification({ blob }, { syncType: 3, chunkOrder: 7, progress: 100 }));
});

test('an ephemeral chat exports its timer and when it was set; a non-ephemeral chat has neither', () => {
  const week = 7 * 24 * 3600;
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: ANA, conversationTimestamp: T + 4, unreadCount: 0, ephemeral: { seconds: week, setAt: T + 1 } },
      { id: BOB, conversationTimestamp: T + 3, unreadCount: 0 },
      // Turned off again: the store keeps { seconds: 0 }, Web gets nothing.
      { id: GROUP, conversationTimestamp: T + 2, unreadCount: 0, ephemeral: { seconds: 0, setAt: T + 2 } },
      // Set, but not known when.
      { id: '99999@lid', conversationTimestamp: T + 1, unreadCount: 0, ephemeral: { seconds: 86400 } }
    ]
  })));
  const [ana, bob, group, lid] = sync.conversations;
  assert.equal(ana.ephemeralExpiration, week);
  assert.equal(ana.ephemeralSettingTimestamp, T + 1);   // seconds, as the store keeps setAt
  for (const conv of [bob, group]) {
    assert.ok(!('ephemeralExpiration' in conv) && !('ephemeralSettingTimestamp' in conv), conv.ID);
  }
  assert.equal(lid.ephemeralExpiration, 86400);
  assert.ok(!('ephemeralSettingTimestamp' in lid));
});

test('a record with an expiration exports ephemeralStartTimestamp and ephemeralDuration', () => {
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [{ id: ANA, conversationTimestamp: T + 3, unreadCount: 0 }],
    records: { [ANA]: [
      rec('M1', 1, T, { expiration: 86400 }),
      rec('M2', 2, T + 1),
      rec('M3', 3, T + 2, { expiration: 0 }),
      rec('M4', 4, T + 3, { tombstone: 'revoked', expiration: 86400 })
    ] }
  })));
  const [m1, m2, m3, m4] = sync.conversations[0].messages.map(m => m.message);
  assert.equal(m1.ephemeralStartTimestamp, T);
  assert.equal(m1.ephemeralDuration, 86400);
  // Only content carries a timer; a stub has nothing left to expire.
  for (const m of [m2, m3, m4]) {
    assert.ok(!('ephemeralStartTimestamp' in m) && !('ephemeralDuration' in m), m.key.ID);
  }
});

test('a content record without its bytes is refused, not dropped', () => {
  // Leaving it out would hand Web a history with a hole in it and no word.
  const chats = [{ id: ANA, conversationTimestamp: T + 1, unreadCount: 0 }];
  for (const raw of [undefined, null, 'raw-M2', new Uint8Array([1, 2])]) {
    const records = { [ANA]: [rec('M1', 1, T), rec('M2', 2, T + 1, { raw })] };
    assert.throws(() => buildHistorySync(snapshot({ chats, records })),
      e => e.code === 'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID' && /M2/.test(e.message));
  }
});

test('a chat with nothing to show and no timestamp is not exported, and timestamp 0 is never written', () => {
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: ANA, conversationTimestamp: T + 2, unreadCount: 0 },
      { id: GROUP, conversationTimestamp: 0, unreadCount: 0 },
      { id: BOB, conversationTimestamp: 0, unreadCount: 0 },
      // Only names known: no conversation, but the mapping is still true.
      { id: '99999@lid', pnJid: '40777777777@s.whatsapp.net', lidJid: '99999@lid', conversationTimestamp: 0, unreadCount: 0 },
      { id: '88888@lid', conversationTimestamp: 0, unreadCount: 0 }
    ],
    records: {
      [ANA]: [],
      // It has a message, so it goes over, just without a 1970 timestamp.
      [GROUP]: [rec('G1', 1, T)],
      // Everything in it expired: nothing to show.
      [BOB]: [rec('B1', 2, T, { tombstone: 'expired' })]
    }
  })));
  assert.deepEqual(sync.conversations.map(c => c.ID), [ANA, GROUP]);
  assert.equal(sync.conversations[0].conversationTimestamp, T + 2);
  assert.ok(!('conversationTimestamp' in sync.conversations[1]));
  assert.deepEqual(ids(sync.conversations[1]), ['G1']);
  assert.deepEqual(sync.phoneNumberToLidMappings, [{ pnJID: '40777777777@s.whatsapp.net', lidJID: '99999@lid' }]);
});

test('a pn-lid mapping goes over once', () => {
  // The same contact can be two chats, one per jid, each knowing both.
  const sync = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: '99999@lid', pnJid: ANA, lidJid: '99999@lid', conversationTimestamp: T + 3, unreadCount: 0 },
      { id: ANA, pnJid: ANA, lidJid: '99999@lid', conversationTimestamp: T + 2, unreadCount: 0 },
      { id: '66666@lid', pnJid: ANA, lidJid: '66666@lid', conversationTimestamp: T + 1, unreadCount: 0 }
    ]
  })));
  assert.deepEqual(sync.phoneNumberToLidMappings, [
    { pnJID: ANA, lidJID: '99999@lid' },
    { pnJID: ANA, lidJID: '66666@lid' }
  ]);
});

test('records for a chat that is not in the snapshot are refused', () => {
  // Skipping them would lose them quietly; recordsAfter would count them.
  const snap = snapshot({
    chats: [{ id: ANA, conversationTimestamp: T, unreadCount: 0 }],
    records: { [ANA]: [rec('A1', 1, T)], [BOB]: [rec('B1', 2, T)] }
  });
  const invalid = fn => assert.throws(fn, e => e.code === 'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID' && e.message.includes(BOB));
  invalid(() => buildHistorySync(snap));
  invalid(() => recordsAfter(snap, { seq: 0 }));
});

test('recordsAfter returns only post-cutoff records', () => {
  const snap = snapshot({
    seq: 9,
    chats: [
      { id: ANA, conversationTimestamp: T + 30, unreadCount: 1 },
      { id: BOB, conversationTimestamp: T + 20, unreadCount: 0 }
    ],
    records: {
      // A2 was edited after the cutoff, so its seq moved past it.
      [ANA]: [rec('A1', 1, T + 10), rec('A2', 8, T + 20), rec('A3', 3, T + 30)],
      // B1 is a late arrival: an old ts, but stored after the cutoff.
      [BOB]: [rec('B1', 6, T + 5), rec('B2', 4, T + 20)]
    }
  });
  const before = JSON.stringify(snap);
  const after = recordsAfter(snap, { seq: 4 });

  assert.deepEqual(after.records[ANA].map(r => r.id), ['A2']);
  assert.deepEqual(after.records[BOB].map(r => r.id), ['B1']);
  assert.equal(after.counts.records, 2);
  assert.equal(after.seq, 9);
  assert.deepEqual(after.chats, snap.chats);
  assert.equal(JSON.stringify(snap), before, 'the input snapshot is not changed');

  assert.deepEqual(recordsAfter(snap, { seq: 0 }).records, snap.records);
  const nothing = recordsAfter(snap, { seq: 9 });
  assert.deepEqual([nothing.chats, nothing.records, nothing.counts], [[], {}, { chats: 0, records: 0 }]);

  // What goes over is the post-cutoff records, numbered from 1.
  const sync = decodeSync(buildHistorySync(after));
  assert.deepEqual(sync.conversations.map(ids), [['A2'], ['B1']]);
  assert.deepEqual(sync.conversations.map(c => c.messages[0].msgOrderID), [1, 1]);

  // A cutoff that is not a seq would quietly select nothing; it is refused.
  for (const bad of [undefined, {}, { seq: -1 }, { seq: 1.5 }, { seq: '4' }]) {
    assert.throws(() => recordsAfter(snap, bad), e => /^PRIMARY_HISTORY_EXPORT_/.test(e.code));
  }
});

// A RECENT chunk that brought back a chat with nothing new in it would show it
// on Web again, empty, with whatever unread count it had.
test('recordsAfter keeps only the chats with something new that goes over, and their push names', () => {
  const CAROL = '40777777777@s.whatsapp.net', DAVE = '40766666666@s.whatsapp.net';
  const snap = snapshot({
    seq: 9,
    chats: [
      { id: ANA, conversationTimestamp: T + 30, unreadCount: 1, pnJid: ANA, lidJid: '111@lid' },
      { id: BOB, conversationTimestamp: T + 20, unreadCount: 7 },
      { id: GROUP, conversationTimestamp: T + 10, unreadCount: 0 }
    ],
    records: {
      // Revoked after the cutoff: its stub goes over.
      [ANA]: [rec('A1', 1, T + 1), rec('A2', 8, T + 2, { tombstone: 'revoked', raw: undefined })],
      // Expired after the cutoff: nothing of it goes over, so neither does Bob.
      [BOB]: [rec('B1', 2, T + 3), rec('B2', 7, T + 4, { tombstone: 'expired', raw: undefined })],
      [GROUP]: [rec('G1', 3, T + 5, { participant: CAROL }), rec('G2', 6, T + 6, { participant: DAVE })]
    },
    pushNames: [{ id: '111@lid', pushname: 'Ana' }, { id: BOB, pushname: 'Bob' }, { id: CAROL, pushname: 'Carol' }, { id: DAVE, pushname: 'Dave' }]
  });
  const after = recordsAfter(snap, { seq: 5 });
  assert.deepEqual(after.chats.map(c => c.id), [ANA, GROUP]);
  assert.deepEqual(Object.keys(after.records), [ANA, GROUP]);
  assert.deepEqual(after.records[ANA].map(r => r.id), ['A2']);
  assert.deepEqual(after.records[GROUP].map(r => r.id), ['G2']);
  assert.deepEqual(after.counts, { chats: 2, records: 2 });
  // Ana's (under her lid) and the sender's; not Bob's, not Carol's.
  assert.deepEqual(after.pushNames, [{ id: '111@lid', pushname: 'Ana' }, { id: DAVE, pushname: 'Dave' }]);
  const sync = decodeSync(buildHistorySync(after));
  assert.deepEqual(sync.conversations.map(c => c.ID), [ANA, GROUP]);
  assert.deepEqual(sync.pushnames.map(p => p.ID), ['111@lid', DAVE]);
});

test('exportedCounts counts what buildHistorySync carries', () => {
  const snap = snapshot({
    chats: [
      { id: ANA, conversationTimestamp: T + 30, unreadCount: 0 },
      // Nothing goes over and no time to place it at: left out of the export.
      { id: BOB, unreadCount: 0 },
      // Nothing goes over, but it has a time: it goes over, empty.
      { id: GROUP, conversationTimestamp: T + 10, unreadCount: 0 }
    ],
    records: {
      [ANA]: [rec('A1', 1, T), rec('A2', 2, T, { tombstone: 'revoked', raw: undefined }), rec('A3', 3, T, { tombstone: 'view-once', raw: undefined })],
      [BOB]: [rec('B1', 4, T, { tombstone: 'expired', raw: undefined })],
      [GROUP]: [rec('G1', 5, T, { tombstone: 'expired', raw: undefined })]
    }
  });
  assert.deepEqual(exportedCounts(snap), { chats: 2, records: 2 });
  const sync = decodeSync(buildHistorySync(snap));
  assert.equal(sync.conversations.length, 2);
  assert.equal(sync.conversations.flatMap(c => c.messages || []).length, 2);
});

test('a real store snapshot goes through the encoder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalib-phe-'));
  const store = PrimaryMessageStore.open({ dir, phone: '40712345678', now: () => (T + 1000) * 1000 });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const content = (id, chat, ts, extra = {}) => store.recordIncoming({ id, chat, fromMe: false, ts, pushName: 'Ana',
    raw: textMessage('text ' + id), info: { kind: 'content' }, ...extra });
  content('A2', ANA, T + 20);
  content('B1', BOB, T + 15);
  content('A1', ANA, T + 10);   // arrives after A2, belongs before it
  content('V1', ANA, T + 12, { raw: Buffer.from('view-once-photo'), info: { kind: 'content', viewOnce: true } });
  content('A3', ANA, T + 25);
  store.recordIncoming({ id: 'P1', chat: ANA, fromMe: false, ts: T + 30, info: { kind: 'protocol', protocol: { type: 0, key: { remoteJid: ANA, id: 'A3' } } } });
  store.setChatMeta(ANA, { name: 'Ana', pnJid: ANA, lidJid: '99999@lid' });

  const deflated = buildHistorySync(store.snapshot());
  assert.equal(zlib.inflateSync(deflated).indexOf(Buffer.from('view-once-photo')), -1);
  const sync = decodeSync(deflated);
  assert.deepEqual(sync.conversations.map(c => c.ID), [ANA, BOB]);
  const [ana] = sync.conversations;
  assert.deepEqual(ids(ana), ['A1', 'A2', 'A3']);
  assert.ok(Buffer.from(ana.messages[0].message.message).equals(textMessage('text A1')));
  assert.equal(ana.messages[2].message.messageStubType, 1);
  assert.ok(!('message' in ana.messages[2].message));
  assert.equal(ana.conversationTimestamp, T + 25);
  assert.equal(ana.name, 'Ana');
  assert.deepEqual(sync.phoneNumberToLidMappings, [{ pnJID: ANA, lidJID: '99999@lid' }]);
  assert.deepEqual(sync.pushnames, [{ ID: ANA, pushname: 'Ana' }, { ID: BOB, pushname: 'Ana' }]);
});

// ─── one contact, two jids ──────────────────────────────────────────────────
//
// A contact first seen by lid and later by phone number (or the other way
// round) can be two chats in the store, tied by setChatMeta on both sides. The
// official phone shows one chat for them, so Web must get one conversation:
// under the phone number, with both jids, and every message once.

const ANA_LID = '99999@lid';

test('a contact seen by number and by lid goes over as one conversation, its records merged in time order', () => {
  const snap = snapshot({
    seq: 9,
    chats: [
      { id: ANA_LID, pnJid: ANA, lidJid: ANA_LID, name: 'Ana (lid)', conversationTimestamp: T + 50, unreadCount: 2, ephemeral: { seconds: 86400, setAt: T + 40 } },
      { id: BOB, conversationTimestamp: T + 40, unreadCount: 1 },
      { id: ANA, pnJid: ANA, lidJid: ANA_LID, name: 'Ana', conversationTimestamp: T + 30, unreadCount: 3, ephemeral: { seconds: 604800, setAt: T + 10 } }
    ],
    records: {
      [ANA_LID]: [rec('L1', 5, T + 20), rec('L2', 6, T + 50)],
      [BOB]: [rec('B1', 4, T + 40)],
      [ANA]: [rec('A1', 1, T + 10, { fromMe: true }), rec('A2', 2, T + 20), rec('A3', 3, T + 30)]
    }
  });
  const sync = decodeSync(buildHistorySync(snap));

  // One conversation, where the first of its chats stood, under the number.
  assert.deepEqual(sync.conversations.map(c => c.ID), [ANA, BOB]);
  const [ana, bob] = sync.conversations;
  // In time order; within the same second, the chats in snapshot order.
  assert.deepEqual(ids(ana), ['A1', 'L1', 'A2', 'A3', 'L2']);
  assert.deepEqual(ana.messages.map(m => m.msgOrderID), [1, 2, 3, 4, 5]);
  assert.deepEqual(ana.messages.map(m => m.message.key.remoteJID), [ANA, ANA, ANA, ANA, ANA]);
  assert.equal(ana.messages[0].message.key.fromMe, true);
  assert.equal(ana.pnJID, ANA);
  assert.equal(ana.lidJID, ANA_LID);
  assert.equal(ana.conversationTimestamp, T + 50, 'the latest of the two');
  assert.equal(ana.unreadCount, 5, 'both chats unread, added');
  assert.equal(ana.name, 'Ana', 'the name of the chat under the number');
  // The timer set last is the one in force.
  assert.equal(ana.ephemeralExpiration, 86400);
  assert.equal(ana.ephemeralSettingTimestamp, T + 40);
  // Bob is as he was, and the mapping still goes over once.
  assert.deepEqual(ids(bob), ['B1']);
  assert.equal(bob.unreadCount, 1);
  assert.deepEqual(sync.phoneNumberToLidMappings, [{ pnJID: ANA, lidJID: ANA_LID }]);
  assert.deepEqual(exportedCounts(snap), { chats: 2, records: 6 });
});

test('either side naming the other is a tie, and the number is the conversation even without its own chat', () => {
  // The lid chat began before the pairing was known and was never told; the number's chat names it.
  const byNumber = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: ANA, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 2, unreadCount: 0 },
      { id: ANA_LID, conversationTimestamp: T + 1, unreadCount: 1 }
    ],
    records: { [ANA]: [rec('A1', 2, T + 2)], [ANA_LID]: [rec('L1', 1, T + 1)] }
  })));
  assert.deepEqual(byNumber.conversations.map(c => [c.ID, c.pnJID, c.lidJID, ids(c)]), [[ANA, ANA, ANA_LID, ['L1', 'A1']]]);
  assert.equal(byNumber.conversations[0].unreadCount, 1);

  // Only the lid chat knows the number, and the number's chat knows nothing.
  const byLid = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: ANA_LID, pnJid: ANA, conversationTimestamp: T + 2, unreadCount: 0 },
      { id: ANA, conversationTimestamp: T + 1, unreadCount: 0 }
    ],
    records: { [ANA_LID]: [rec('L1', 2, T + 2)], [ANA]: [rec('A1', 1, T + 1)] }
  })));
  assert.deepEqual(byLid.conversations.map(c => [c.ID, c.pnJID, c.lidJID, ids(c)]), [[ANA, ANA, ANA_LID, ['A1', 'L1']]]);

  // Two lid chats that both name the number, and no chat under it: one conversation, under the number.
  const lids = decodeSync(buildHistorySync(snapshot({
    chats: [
      { id: ANA_LID, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 2, unreadCount: 0 },
      { id: '66666@lid', pnJid: ANA, lidJid: '66666@lid', conversationTimestamp: T + 1, unreadCount: 0 }
    ],
    records: { [ANA_LID]: [rec('L1', 2, T + 2)], '66666@lid': [rec('K1', 1, T + 1)] }
  })));
  assert.deepEqual(lids.conversations.map(c => [c.ID, c.pnJID, c.lidJID, ids(c)]), [[ANA, ANA, ANA_LID, ['K1', 'L1']]]);
});

test('a message kept under both jids goes over once, and a tombstone under either wins', () => {
  const snap = snapshot({
    seq: 12,
    chats: [
      { id: ANA, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 5, unreadCount: 0 },
      { id: ANA_LID, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 4, unreadCount: 0 }
    ],
    records: {
      [ANA]: [
        rec('M1', 1, T + 1),
        rec('M2', 2, T + 2, { raw: Buffer.from('M2 as first stored') }),
        rec('M3', 3, T + 3, { tombstone: 'revoked', raw: undefined }),
        rec('M4', 4, T + 4, { tombstone: 'expired', raw: undefined }),
        rec('M5', 5, T + 5)
      ],
      [ANA_LID]: [
        // Revoked here, after the copy under the number was stored.
        rec('M1', 6, T + 1, { tombstone: 'revoked', raw: undefined }),
        // Two copies with content: the one the store changed last.
        rec('M2', 7, T + 2, { raw: Buffer.from('M2 as edited') }),
        // Content here, changed later than the revoke under the number: the revoke still wins.
        rec('M3', 8, T + 3),
        // Expired under the number: it does not come back from here.
        rec('M4', 9, T + 4)
      ]
    }
  });
  const sync = decodeSync(buildHistorySync(snap));
  assert.equal(sync.conversations.length, 1);
  const [ana] = sync.conversations;
  assert.deepEqual(ids(ana), ['M1', 'M2', 'M3', 'M5']);
  assert.deepEqual(ana.messages.map(m => m.msgOrderID), [1, 2, 3, 4]);
  const [m1, m2, m3, m5] = ana.messages.map(m => m.message);
  for (const stub of [m1, m3]) {
    assert.equal(stub.messageStubType, 1, stub.key.ID);
    assert.ok(!('message' in stub), stub.key.ID);
  }
  assert.equal(Buffer.from(m2.message).toString(), 'M2 as edited');
  assert.ok(!('messageStubType' in m5));
  assert.deepEqual(exportedCounts(snap), { chats: 1, records: 4 });
});

// The server can deliver a message again under the contact's other jid after
// it was edited. The copy stored later then holds the text as first sent, and
// it must not undo the edit.
test('between two copies with content, the edited one wins over one the store changed later', () => {
  const tied = [
    { id: ANA, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 9, unreadCount: 0 },
    { id: ANA_LID, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 8, unreadCount: 0 }
  ];
  const snap = snapshot({
    seq: 9,
    chats: tied,
    records: {
      [ANA_LID]: [
        // Edited under the lid...
        rec('X', 2, T + 1, { raw: textMessage('X as edited'), edited: T + 5 }),
        // ...two edits, the later one under the lid with the lower seq.
        rec('Y', 4, T + 2, { raw: textMessage('Y second edit'), edited: T + 7 })
      ],
      [ANA]: [
        // ...then delivered again under the number, as first sent.
        rec('X', 3, T + 1, { raw: textMessage('X as first sent') }),
        rec('Y', 6, T + 2, { raw: textMessage('Y first edit'), edited: T + 6 })
      ]
    }
  });
  const text = m => type('Message').decode(m.message.message).conversation;
  for (const order of [snap, { ...snap, chats: [tied[1], tied[0]] }]) {
    const [ana] = decodeSync(buildHistorySync(order)).conversations;
    assert.deepEqual(ana.messages.map(m => [m.message.key.ID, text(m)]), [['X', 'X as edited'], ['Y', 'Y second edit']]);
  }
});

test('chats that are not tied, groups, and chats of two different numbers go over as they were', () => {
  const OLD = '40711111111@s.whatsapp.net', NEW = '40722222222@s.whatsapp.net';
  const snap = snapshot({
    chats: [
      // A lid nobody has tied to a number.
      { id: '88888@lid', lidJid: '88888@lid', conversationTimestamp: T + 9, unreadCount: 1 },
      // A lid that names a number with no chat of its own: alone, under its lid.
      { id: '77777@lid', pnJid: BOB, lidJid: '77777@lid', conversationTimestamp: T + 8, unreadCount: 0 },
      // A group is never a person, whatever its metadata says.
      { id: GROUP, pnJid: ANA, lidJid: ANA_LID, name: 'Family', conversationTimestamp: T + 7, unreadCount: 2 },
      { id: ANA, conversationTimestamp: T + 6, unreadCount: 0 },
      // A number change: the lid now belongs to the new number, and the old number's chat stays its own.
      { id: OLD, pnJid: OLD, lidJid: '55555@lid', conversationTimestamp: T + 5, unreadCount: 0 },
      { id: '55555@lid', pnJid: NEW, lidJid: '55555@lid', conversationTimestamp: T + 4, unreadCount: 0 },
      { id: NEW, pnJid: NEW, lidJid: '55555@lid', conversationTimestamp: T + 3, unreadCount: 0 }
    ],
    records: {
      // Not in time order: an untied chat is not re-sorted.
      '88888@lid': [rec('X2', 2, T + 2), rec('X1', 1, T + 1)],
      '77777@lid': [rec('Y1', 3, T + 3)],
      [GROUP]: [rec('G1', 4, T + 4, { participant: ANA_LID })],
      [ANA]: [rec('A1', 5, T + 5)],
      [OLD]: [rec('O1', 6, T + 1)],
      '55555@lid': [rec('N1', 7, T + 2)],
      [NEW]: [rec('N2', 8, T + 3)]
    }
  });
  const sync = decodeSync(buildHistorySync(snap));
  assert.deepEqual(sync.conversations.map(c => [c.ID, ids(c)]), [
    ['88888@lid', ['X2', 'X1']],
    ['77777@lid', ['Y1']],
    [GROUP, ['G1']],
    [ANA, ['A1']],
    [OLD, ['O1']],
    [NEW, ['N1', 'N2']]
  ]);
  const [lone, named, group, ana, old, now] = sync.conversations;
  assert.equal(lone.lidJID, '88888@lid');
  assert.equal(named.pnJID, BOB);
  assert.equal(named.lidJID, '77777@lid');
  assert.equal(group.name, 'Family');
  assert.equal(group.unreadCount, 2);
  assert.equal(group.messages[0].message.key.remoteJID, GROUP);
  assert.ok(!('pnJID' in ana) && !('lidJID' in ana));
  assert.equal(old.lidJID, '55555@lid');
  assert.deepEqual([now.pnJID, now.lidJID], [NEW, '55555@lid']);
});

test('recordsAfter and the export give the merged result for a delta', () => {
  const snap = snapshot({
    seq: 9,
    chats: [
      { id: ANA, pnJid: ANA, lidJid: ANA_LID, name: 'Ana', conversationTimestamp: T + 4, unreadCount: 1 },
      { id: BOB, conversationTimestamp: T + 3, unreadCount: 0 },
      { id: ANA_LID, pnJid: ANA, lidJid: ANA_LID, conversationTimestamp: T + 2, unreadCount: 2 }
    ],
    records: {
      [ANA]: [
        rec('A1', 1, T + 1),
        // Changed after the cutoff, but revoked under the lid before it: Web already has the stub.
        rec('A2', 7, T + 2)
      ],
      [BOB]: [rec('B1', 2, T + 3)],
      [ANA_LID]: [
        rec('A2', 3, T + 2, { tombstone: 'revoked', raw: undefined }),
        rec('L1', 6, T + 4)
      ]
    },
    pushNames: [{ id: ANA, pushname: 'Ana' }, { id: ANA_LID, pushname: 'Ana' }, { id: BOB, pushname: 'Bob' }]
  });
  // The full history has A2 as the stub.
  const full = decodeSync(buildHistorySync(snap));
  assert.deepEqual(full.conversations.map(c => [c.ID, ids(c)]), [[ANA, ['A1', 'A2', 'L1']], [BOB, ['B1']]]);
  assert.equal(full.conversations[0].messages[1].message.messageStubType, 1);

  const after = recordsAfter(snap, { seq: 4 });
  // Only the lid chat has something new, and the number's chat comes with it, so the two still go over as one.
  assert.deepEqual(after.chats.map(c => c.id), [ANA, ANA_LID]);
  assert.deepEqual(after.records[ANA].map(r => r.id), []);
  assert.deepEqual(after.records[ANA_LID].map(r => r.id), ['L1']);
  assert.deepEqual(after.pushNames.map(p => p.id), [ANA, ANA_LID]);
  assert.deepEqual(exportedCounts(after), { chats: 1, records: 1 });
  const delta = decodeSync(buildHistorySync(after));
  assert.deepEqual(delta.conversations.map(c => [c.ID, c.pnJID, c.lidJID, ids(c)]), [[ANA, ANA, ANA_LID, ['L1']]]);
  assert.equal(delta.conversations[0].messages[0].msgOrderID, 1);
  assert.equal(delta.conversations[0].messages[0].message.key.remoteJID, ANA);
  // The same totals as the full history: one conversation, both chats' unread.
  assert.equal(delta.conversations[0].unreadCount, 3);
  assert.equal(delta.conversations[0].conversationTimestamp, T + 4);
  assert.equal(delta.conversations[0].name, 'Ana');

  // A revoke after the cutoff under either jid goes over as the stub.
  const revoked = recordsAfter({ ...snap, records: { ...snap.records, [ANA_LID]: [rec('A2', 8, T + 2, { tombstone: 'revoked', raw: undefined })] } }, { seq: 4 });
  const stub = decodeSync(buildHistorySync(revoked)).conversations;
  assert.deepEqual(stub.map(c => [c.ID, ids(c)]), [[ANA, ['A2']]]);
  assert.equal(stub[0].messages[0].message.messageStubType, 1);
});

test('a real store with a contact under both jids exports one conversation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalib-phe-'));
  const store = PrimaryMessageStore.open({ dir, phone: '40712345678', now: () => (T + 1000) * 1000 });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const content = (id, chat, ts) => store.recordIncoming({ id, chat, fromMe: false, ts, raw: textMessage('text ' + id), info: { kind: 'content' } });
  // Before the pairing was known the chat was the lid; after, the number. Both sides carry the tie.
  content('LT1', ANA_LID, T + 10);
  content('LT2', ANA, T + 20);
  store.setChatMeta(ANA, { pnJid: ANA, lidJid: ANA_LID });
  store.setChatMeta(ANA_LID, { pnJid: ANA, lidJid: ANA_LID });
  content('B1', BOB, T + 15);

  const sync = decodeSync(buildHistorySync(store.snapshot()));
  assert.deepEqual(sync.conversations.map(c => [c.ID, ids(c)]), [[ANA, ['LT1', 'LT2']], [BOB, ['B1']]]);
  assert.deepEqual([sync.conversations[0].pnJID, sync.conversations[0].lidJID], [ANA, ANA_LID]);
  assert.ok(Buffer.from(sync.conversations[0].messages[0].message.message).equals(textMessage('text LT1')));
});
