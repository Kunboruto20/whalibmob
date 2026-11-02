'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The store a primary keeps of what it sent and received, so a newly linked
// companion can be handed its chat history. Two things matter more than
// anything else here: nothing that was seen may vanish without a trace, and
// nothing revoked, expired or view-once may come back out.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { PrimaryMessageStore, STATUS } = require('../lib/primary/MessageStore');

const PHONE = '40712345678';
const CHAT  = '40799999999@s.whatsapp.net';
const OTHER = '40788888888@s.whatsapp.net';
const LID   = '99999@lid';                    // the same person as CHAT, by lid
const GROUP = '120363000000000000@g.us';
const V     = '40711111111@s.whatsapp.net';   // two group members
const W     = '40722222222@s.whatsapp.net';
const T     = 1790000000000;
const CODE  = /^PRIMARY_MESSAGE_STORE_[A-Z0-9_]+$/;

const logFile  = dir => path.join(dir, PHONE + '.primary-messages.log');
const snapFile = dir => path.join(dir, PHONE + '.primary-messages.json');

// A tmp dir, a clock the test moves by hand, and every store opened in it
// closed before the dir goes away, even when an assertion fails half way.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalib-pms-'));
  const clock = { ms: T };
  const stores = [];
  t.after(() => {
    for (const s of stores) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = (opts = {}) => {
    const s = PrimaryMessageStore.open({ dir, phone: PHONE, now: () => clock.ms, ...opts });
    stores.push(s);
    return s;
  };
  return { dir, clock, open };
}

function incoming(store, id, ts, extra = {}) {
  store.recordIncoming({ id, chat: CHAT, fromMe: false, ts, pushName: 'Ana',
    raw: Buffer.from('raw-' + id), info: { kind: 'content' }, ...extra });
}
function outgoing(store, id, ts, extra = {}) {
  store.recordOutgoing({ id, chat: CHAT, ts, raw: Buffer.from('out-' + id), info: { kind: 'content' }, ...extra });
}
// A protocol message as it arrived: in `chat`, from `fromMe`/`participant`.
function protocol(store, id, ts, proto, { chat = CHAT, fromMe = false, participant } = {}) {
  store.recordIncoming({ id, chat, fromMe, participant, ts, info: { kind: 'protocol', protocol: proto } });
}
const inGroup = (store, id, ts, participant, raw) => store.recordIncoming({ id, chat: GROUP, fromMe: false, participant, ts,
  raw: Buffer.from(raw || 'raw-' + id), info: { kind: 'content' } });
const b64 = s => Buffer.from(s).toString('base64');

// What a kill -9 leaves behind: both files exactly as they are on disk now.
const crashImage = dir => ({ log: fs.readFileSync(logFile(dir)), snap: fs.readFileSync(snapFile(dir)) });
function restore(dir, image) {
  fs.writeFileSync(logFile(dir), image.log);
  fs.writeFileSync(snapFile(dir), image.snap);
}
const byId = (snap, id, chat = CHAT) => snap.records[chat].find(r => r.id === id);

test('files are created 0600', (t) => {
  // umask can only take bits away; zero proves the mode is asked for, not inherited.
  const old = process.umask(0);
  try {
    const { dir, open } = setup(t);
    const s = open();
    assert.equal(fs.statSync(logFile(dir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(snapFile(dir)).mode & 0o777, 0o600);
    incoming(s, 'M1', 100);
    s.close();
    assert.equal(fs.statSync(snapFile(dir)).mode & 0o777, 0o600, 'a compacted snapshot stays private');

    // A log someone else left world-readable is tightened, not trusted.
    fs.chmodSync(logFile(dir), 0o644);
    fs.chmodSync(snapFile(dir), 0o644);
    open().close();
    assert.equal(fs.statSync(logFile(dir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(snapFile(dir)).mode & 0o777, 0o600);
  } finally { process.umask(old); }
});

test('incoming record round-trips through reopen with raw intact', (t) => {
  const { open } = setup(t);
  const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const s = open();
  s.recordIncoming({ id: 'M1', chat: CHAT, fromMe: false, participant: undefined, ts: 100, pushName: 'Ana', raw, info: { kind: 'content' } });
  s.close();

  const snap = open().snapshot();
  const r = byId(snap, 'M1');
  assert.ok(Buffer.isBuffer(r.raw));
  assert.ok(r.raw.equals(raw));
  assert.equal(r.fromMe, false);
  assert.equal(r.ts, 100);
  assert.equal(r.pushName, 'Ana');
  assert.equal(r.status, STATUS.DELIVERY_ACK);
  assert.deepEqual(snap.pushNames, [{ id: CHAT, pushname: 'Ana' }]);
  assert.deepEqual(snap.chats, [{ id: CHAT, conversationTimestamp: 100, unreadCount: 1 }]);
  assert.deepEqual(snap.counts, { chats: 1, records: 1 });
});

test('out-of-order arrival is stored in ts order', (t) => {
  const { open } = setup(t);
  const s = open();
  incoming(s, 'M2', 200);
  incoming(s, 'M1', 100);
  incoming(s, 'A', 150);
  incoming(s, 'B', 150);
  const order = snap => snap.records[CHAT].map(r => r.id);
  assert.deepEqual(s.snapshot().records[CHAT].map(r => r.ts), [100, 150, 150, 200]);
  assert.deepEqual(order(s.snapshot()), ['M1', 'A', 'B', 'M2'], 'equal ts keeps arrival order');
  s.close();
  assert.deepEqual(order(open().snapshot()), ['M1', 'A', 'B', 'M2']);
});

test('revoke tombstones the target and drops raw', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100, { raw: Buffer.from('secret-content') });
  protocol(s, 'P1', 110, { type: 0, key: { remoteJid: CHAT, id: 'M1' } });
  // Neither an edit after the revoke nor the server delivering it again may
  // bring content back.
  protocol(s, 'P2', 120, { type: 14, key: { remoteJid: CHAT, id: 'M1' }, editedRaw: Buffer.from('edited-content') });
  incoming(s, 'M1', 100, { raw: Buffer.from('secret-content') });

  let snap = s.snapshot();
  assert.equal(snap.records[CHAT].length, 1, 'the protocol messages themselves are not stored');
  const r = byId(snap, 'M1');
  assert.equal(r.tombstone, 'revoked');
  assert.equal('raw' in r, false);
  s.close();

  snap = open().snapshot();
  assert.equal(byId(snap, 'M1').tombstone, 'revoked');
  assert.equal('raw' in byId(snap, 'M1'), false);
  const onDisk = fs.readFileSync(snapFile(dir), 'utf8');
  assert.equal(onDisk.includes(Buffer.from('secret-content').toString('base64')), false, 'the compacted snapshot holds no revoked bytes');
});

test('a revoke that arrives before its target still keeps the content out', (t) => {
  const { open } = setup(t);
  const s = open();
  protocol(s, 'P1', 110, { type: 0, key: { remoteJid: CHAT, id: 'M7' } });
  incoming(s, 'M7', 100);
  // The other jid of the same conversation counts once setChatMeta has tied
  // the two together: a revoke arriving under the lid finds the phone-number copy,
  s.setChatMeta(CHAT, { pnJid: CHAT, lidJid: LID });
  incoming(s, 'M8', 120);
  protocol(s, 'P2', 130, { type: 0, key: { id: 'M8' } }, { chat: LID });
  // a message kept under both jids loses its content in both,
  incoming(s, 'M9', 140);
  incoming(s, 'M9', 140, { chat: LID });
  protocol(s, 'P3', 150, { type: 0, key: { id: 'M9' } });
  // and a revoke that came first under one jid catches the target under the other.
  protocol(s, 'P4', 160, { type: 0, key: { id: 'M10' } }, { chat: LID });
  incoming(s, 'M10', 155);
  s.close();

  const snap = open().snapshot();
  for (const [id, chat] of [['M7', CHAT], ['M8', CHAT], ['M9', CHAT], ['M9', LID], ['M10', CHAT]]) {
    assert.equal(byId(snap, id, chat).tombstone, 'revoked', id + ' in ' + chat);
    assert.equal('raw' in byId(snap, id, chat), false, id + ' in ' + chat);
  }
});

// key.remoteJid is the sender's view of the chat and is never trusted to pick
// it: an edit or revoke reaches only the chat it arrived in.
test('a forged cross-chat edit is ignored', (t) => {
  const { open } = setup(t);
  const s = open();
  inGroup(s, 'M1', 100, V, 'original');
  let n = 0;
  for (const remoteJid of [OTHER, GROUP, undefined]) {
    protocol(s, 'P' + n++, 110, { type: 14, key: { remoteJid, id: 'M1' }, editedRaw: Buffer.from('forged') }, { chat: OTHER });
    s.recordIncoming({ id: 'P' + n++, chat: OTHER, ts: 111, raw: Buffer.from('forged'), info: { kind: 'content', editOf: 'M1' } });
  }
  const r = byId(s.snapshot(), 'M1', GROUP);
  assert.ok(r.raw.equals(Buffer.from('original')));
  assert.equal('edited' in r, false);
});

test('a forged cross-chat revoke is ignored', (t) => {
  const { open } = setup(t);
  const s = open();
  inGroup(s, 'M1', 100, V, 'original');
  for (const remoteJid of [OTHER, GROUP, undefined]) protocol(s, 'P1', 110, { type: 0, key: { remoteJid, id: 'M1' } }, { chat: OTHER });
  let r = byId(s.snapshot(), 'M1', GROUP);
  assert.ok(r.raw.equals(Buffer.from('original')));
  assert.equal('tombstone' in r, false);
  // Nor does the forged revoke wait for the id: the group copy delivered again keeps its content.
  s.drop(GROUP, 'M1');
  inGroup(s, 'M1', 100, V, 'original');
  s.close();
  r = byId(open().snapshot(), 'M1', GROUP);
  assert.ok(r.raw.equals(Buffer.from('original')));
});

test('a group admin revoke is accepted', (t) => {
  const { open } = setup(t);
  const s = open();
  inGroup(s, 'M1', 100, V, 'by v');
  s.recordOutgoing({ id: 'O1', chat: GROUP, ts: 101, raw: Buffer.from('by us'), info: { kind: 'content' } });
  protocol(s, 'P1', 110, { type: 0, key: { id: 'M1' } }, { chat: GROUP, participant: W });
  protocol(s, 'P2', 111, { type: 0, key: { id: 'O1' } }, { chat: GROUP, participant: W });
  const snap = s.snapshot();
  for (const id of ['M1', 'O1']) {
    assert.equal(byId(snap, id, GROUP).tombstone, 'revoked', id);
    assert.equal('raw' in byId(snap, id, GROUP), false, id);
  }
});

test('a non-matching sender edit is ignored', (t) => {
  const { open } = setup(t);
  const s = open();
  inGroup(s, 'M1', 100, V, 'by v');
  protocol(s, 'P1', 110, { type: 14, key: { id: 'M1' }, editedRaw: Buffer.from('by w') }, { chat: GROUP, participant: W });
  protocol(s, 'P2', 111, { type: 14, key: { id: 'M1' }, editedRaw: Buffer.from('by us') }, { chat: GROUP, fromMe: true });
  assert.ok(byId(s.snapshot(), 'M1', GROUP).raw.equals(Buffer.from('by v')));
  protocol(s, 'P3', 112, { type: 14, key: { id: 'M1' }, editedRaw: Buffer.from('v again') }, { chat: GROUP, participant: V });
  assert.ok(byId(s.snapshot(), 'M1', GROUP).raw.equals(Buffer.from('v again')), 'its author may edit it');

  // In a 1:1 chat the peer can neither edit nor revoke what we sent.
  outgoing(s, 'O1', 120);
  protocol(s, 'P4', 130, { type: 14, key: { id: 'O1' }, editedRaw: Buffer.from('peer') });
  protocol(s, 'P5', 131, { type: 0, key: { id: 'O1' } });
  const r = byId(s.snapshot(), 'O1');
  assert.ok(r.raw.equals(Buffer.from('out-O1')));
  assert.equal('tombstone' in r, false);
  // and we can revoke it, from this device or another of ours.
  protocol(s, 'P6', 132, { type: 0, key: { id: 'O1' } }, { fromMe: true });
  assert.equal(byId(s.snapshot(), 'O1').tombstone, 'revoked');
  // A peer's revoke waiting for an id does not catch our message with that id.
  protocol(s, 'P7', 140, { type: 0, key: { id: 'O9' } });
  outgoing(s, 'O9', 141);
  assert.equal('tombstone' in byId(s.snapshot(), 'O9'), false);
});

test('edit replaces raw and sets edited', (t) => {
  const { open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  const before = byId(s.snapshot(), 'M1').seq;
  protocol(s, 'P1', 150, { type: 14, key: { remoteJid: CHAT, id: 'M1' }, editedRaw: Buffer.from('edited') });

  let r = byId(s.snapshot(), 'M1');
  assert.ok(r.raw.equals(Buffer.from('edited')));
  assert.equal(r.edited, 150);
  assert.ok(r.seq > before, 'the record carries the seq of the event that changed it');
  assert.equal(s.snapshot().records[CHAT].length, 1);
  incoming(s, 'M1', 100);   // a redelivery of the original does not undo the edit
  assert.ok(byId(s.snapshot(), 'M1').raw.equals(Buffer.from('edited')));
  s.recordEdit(CHAT, 'M1', Buffer.from('older edit'), 120);   // nor does an earlier edit arriving late
  assert.ok(byId(s.snapshot(), 'M1').raw.equals(Buffer.from('edited')));
  s.close();

  r = byId(open().snapshot(), 'M1');
  assert.ok(r.raw.equals(Buffer.from('edited')));
  assert.equal(r.edited, 150);
});

test('content that names editOf edits its target instead of adding a message', (t) => {
  const { open } = setup(t);
  const s = open();
  outgoing(s, 'O1', 100);
  s.recordOutgoing({ id: 'O2', chat: CHAT, ts: 140, raw: Buffer.from('fixed'), info: { kind: 'content', editOf: 'O1' } });
  const snap = s.snapshot();
  assert.deepEqual(snap.records[CHAT].map(r => r.id), ['O1']);
  assert.ok(byId(snap, 'O1').raw.equals(Buffer.from('fixed')));
  assert.equal(byId(snap, 'O1').edited, 140);
});

test('view-once is stored as a tombstone without raw', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  incoming(s, 'V1', 100, { raw: Buffer.from('view-once-photo'), info: { kind: 'content', viewOnce: true } });
  const r = byId(s.snapshot(), 'V1');
  assert.equal(r.tombstone, 'view-once');
  assert.equal('raw' in r, false);
  const secret = Buffer.from('view-once-photo').toString('base64');
  assert.equal(fs.readFileSync(logFile(dir), 'utf8').includes(secret), false, 'view-once bytes never reach the disk');
  s.close();
  assert.equal(byId(open().snapshot(), 'V1').tombstone, 'view-once');
});

test('expired records are tombstoned at snapshot time', (t) => {
  const { open } = setup(t);
  const s = open();
  s.setChatMeta(CHAT, { ephemeral: { seconds: 60, setAt: 50 } });
  const ts = 1000;
  incoming(s, 'E1', ts);
  // A per-message expiration wins over the chat setting.
  incoming(s, 'E2', ts, { info: { kind: 'content', expiration: 3600 } });
  // The same id in a chat that does not disappear is a different record.
  incoming(s, 'E1', ts, { chat: OTHER });

  let snap = s.snapshot({ now: ts * 1000 + 59000 });
  assert.ok(byId(snap, 'E1').raw, 'not yet');
  snap = s.snapshot({ now: ts * 1000 + 61000 });
  assert.equal(byId(snap, 'E1').tombstone, 'expired');
  assert.equal('raw' in byId(snap, 'E1'), false);
  assert.ok(byId(snap, 'E2').raw, 'an hour has not passed for E2');
  assert.ok(byId(snap, 'E1', OTHER).raw, 'expiry stays in its own chat');
  assert.deepEqual(snap.chats.find(c => c.id === CHAT).ephemeral, { seconds: 60, setAt: 50 });
  s.close();
  assert.equal('raw' in byId(open().snapshot({ now: ts * 1000 }), 'E1'), false, 'expiry is written down, not recomputed');
});

// The history sent to Web carries each disappearing message's timer, so Web
// expires it when the phone would.
test('a record carries the disappearing timer that applied to it', (t) => {
  const { open } = setup(t);
  const ts = Math.floor(T / 1000);
  const s = open();
  s.setChatMeta(CHAT, { ephemeral: { seconds: 86400, setAt: ts } });
  incoming(s, 'E1', ts);                                                           // the chat's setting
  incoming(s, 'E2', ts, { info: { kind: 'content', expiration: 604800 } });        // its own wins
  s.recordIncoming({ id: 'N1', chat: OTHER, ts, raw: Buffer.from('n1'), info: { kind: 'content' } });
  for (const snap of [s.snapshot(), (s.close(), open().snapshot())]) {
    assert.equal(byId(snap, 'E1').expiration, 86400);
    assert.equal(byId(snap, 'E2').expiration, 604800);
    assert.equal('expiration' in byId(snap, 'N1', OTHER), false, 'a normal record has none');
  }
});

test('expired records are swept on open', (t) => {
  const { dir, open, clock } = setup(t);
  const ts = Math.floor(T / 1000);
  const s = open();
  s.setChatMeta(CHAT, { ephemeral: { seconds: 60, setAt: ts } });
  incoming(s, 'E1', ts, { raw: Buffer.from('disappearing') });
  s.close();
  assert.ok(fs.readFileSync(snapFile(dir), 'utf8').includes(b64('disappearing')), 'not due when the store closed');

  // Nothing asks for a snapshot; opening after the deadline is enough.
  clock.ms = T + 61000;
  open();
  assert.equal(fs.readFileSync(snapFile(dir), 'utf8').includes(b64('disappearing')), false);
  assert.equal(fs.readFileSync(logFile(dir), 'utf8').includes(b64('disappearing')), false);
});

test('leftover inflight not stored becomes a precise loss on reopen', (t) => {
  const { open } = setup(t);
  const s = open();
  s.recordInflight({ id: 'M9', chat: CHAT, ts: 100 });
  s.close();

  const again = open();
  assert.deepEqual(again.snapshot().losses[0], { reason: 'received-not-stored', ids: ['M9'] });
  again.close();
  assert.equal(open().snapshot().losses.length, 1, 'a second reopen does not count it twice');
});

test('leftover inflight that was stored is not a loss', (t) => {
  const { open } = setup(t);
  const s = open();
  s.recordInflight({ id: 'M1', chat: CHAT, ts: 100 });
  incoming(s, 'M1', 100);
  incoming(s, 'M2', 110);
  s.recordInflight({ id: 'M2', chat: CHAT, ts: 110 });   // a redelivery of something already kept
  s.close();
  assert.deepEqual(open().snapshot().losses, []);
});

test('skipped and protocol messages resolve their inflight id without being stored', (t) => {
  const { open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  s.recordInflight({ id: 'S1', chat: CHAT, ts: 101 });
  s.recordIncoming({ id: 'S1', chat: CHAT, fromMe: false, ts: 101, info: { kind: 'skip' } });
  s.recordInflight({ id: 'P1', chat: CHAT, ts: 102 });
  protocol(s, 'P1', 102, { type: 0, key: { id: 'M1' } });
  s.close();
  const snap = open().snapshot();
  assert.deepEqual(snap.losses, []);
  assert.deepEqual(snap.records[CHAT].map(r => r.id), ['M1']);
});

test('decrypt failure becomes an undecryptable loss', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  s.recordInflight({ id: 'M5', chat: CHAT, ts: 100 });
  s.recordDecryptFailure({ id: 'M5' });
  s.recordDecryptFailure({ id: 'M6' });   // a failure counts even without an inflight mark
  const image = crashImage(dir);
  s.close();
  restore(dir, image);

  assert.deepEqual(open().snapshot().losses, [{ reason: 'undecryptable', ids: ['M5', 'M6'] }]);
});

test('a decrypt failure is a loss in the live snapshot, withdrawn if a retry decrypts it', (t) => {
  const { open } = setup(t);
  const s = open();
  s.recordInflight({ id: 'M5', chat: CHAT, ts: 100 });
  s.recordDecryptFailure({ id: 'M5' });
  assert.deepEqual(s.snapshot().losses, [{ reason: 'undecryptable', ids: ['M5'] }], 'no reopen needed to see it');
  incoming(s, 'M5', 100);
  assert.deepEqual(s.snapshot().losses, []);
  incoming(s, 'M6', 110);
  s.recordDecryptFailure({ id: 'M6' });   // a redelivery that failed of something already kept
  assert.deepEqual(s.snapshot().losses, []);
  s.close();
  assert.deepEqual(open().snapshot().losses, []);
});

test('a loss is withdrawn when the message arrives after all', (t) => {
  const { open } = setup(t);
  const s = open();
  s.recordInflight({ id: 'M9', chat: CHAT, ts: 100 });
  s.recordInflight({ id: 'M10', chat: CHAT, ts: 101 });
  s.close();
  const again = open();
  assert.deepEqual(again.snapshot().losses, [{ reason: 'received-not-stored', ids: ['M9', 'M10'] }]);
  incoming(again, 'M9', 100);   // the server delivered it again
  assert.deepEqual(again.snapshot().losses, [{ reason: 'received-not-stored', ids: ['M10'] }]);
  incoming(again, 'M10', 101);
  again.close();
  assert.deepEqual(open().snapshot().losses, []);
});

test('login counter jump records a store-disabled window', (t) => {
  const { open, clock } = setup(t);
  const s = open({ lc: 5 });
  s.noteLogin(5);
  clock.ms = T + 1000;
  incoming(s, 'M1', 100);
  clock.ms = T + 2000;
  s.close();

  clock.ms = T + 9000;
  const again = open({ lc: 7 });
  const disabled = again.snapshot().losses.filter(l => l.reason === 'store-disabled');
  assert.deepEqual(disabled, [{ reason: 'store-disabled', from: T + 1000, to: T + 9000 }]);
  assert.equal(again.capture.lc, 7);
  assert.equal(again.capture.since, T);
  assert.equal(again.capture.origin, 'enabled');
  again.close();
  assert.equal(open({ lc: 7 }).snapshot().losses.length, 1, 'the same gap is not reported twice');
});

test('torn final line is ignored, earlier events survive', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  incoming(s, 'M2', 110);
  const image = crashImage(dir);
  s.close();
  restore(dir, image);
  fs.appendFileSync(logFile(dir), '{"seq":99,"t":"put","id":"M3","raw":"AAE');

  const again = open();
  assert.deepEqual(again.snapshot().records[CHAT].map(r => r.id), ['M1', 'M2']);
  incoming(again, 'M3', 120);
  // The torn bytes were cut, so the next event starts on a line of its own.
  const lines = fs.readFileSync(logFile(dir), 'utf8').split('\n');
  assert.equal(lines.pop(), '');
  for (const line of lines) JSON.parse(line);
  again.close();
  assert.deepEqual(open().snapshot().records[CHAT].map(r => r.id), ['M1', 'M2', 'M3']);
});

test('a complete final event that only lost its newline is kept', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  incoming(s, 'M2', 110);
  const image = crashImage(dir);
  s.close();
  restore(dir, { log: image.log.subarray(0, image.log.length - 1), snap: image.snap });

  const again = open();
  incoming(again, 'M3', 120);
  // Its newline was put back, so the events after it are lines of their own.
  const lines = fs.readFileSync(logFile(dir), 'utf8').split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 4);
  for (const line of lines) JSON.parse(line);
  again.close();
  assert.deepEqual(open().snapshot().records[CHAT].map(r => r.id), ['M1', 'M2', 'M3']);
});

test('a corrupt line in the middle of the log stops open with a clear code', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  incoming(s, 'M2', 110);
  const image = crashImage(dir);
  s.close();
  const lines = image.log.toString('utf8').split('\n');
  lines[0] = lines[0].slice(0, 20);
  const damaged = Buffer.from(lines.join('\n'));
  restore(dir, { log: damaged, snap: image.snap });

  assert.throws(() => open(), e => e.code === 'PRIMARY_MESSAGE_STORE_LOG_CORRUPT' && /line 1/.test(e.message));
  assert.ok(fs.readFileSync(logFile(dir)).equals(damaged), 'nothing is cut or rewritten for someone to inspect');
});

test('outgoing intent is PENDING and status only rises', (t) => {
  const { open } = setup(t);
  const s = open();
  outgoing(s, 'O1', 100);
  incoming(s, 'M1', 101);
  let r = byId(s.snapshot(), 'O1');
  assert.equal(r.status, STATUS.PENDING);
  assert.equal(r.fromMe, true);

  s.setStatus(CHAT, ['O1'], STATUS.READ);
  s.setStatus(CHAT, ['O1'], STATUS.DELIVERY_ACK);
  assert.equal(byId(s.snapshot(), 'O1').status, STATUS.READ);

  // A receipt addressed to the other jid of the chat still lands on our own message
  s.setStatus('99999@lid', ['O1'], STATUS.PLAYED);
  assert.equal(byId(s.snapshot(), 'O1').status, STATUS.PLAYED);
  // but never on somebody else's.
  s.setStatus('99999@lid', ['M1'], STATUS.PLAYED);
  assert.equal(byId(s.snapshot(), 'M1').status, STATUS.DELIVERY_ACK);
  s.close();
  assert.equal(byId(open().snapshot(), 'O1').status, STATUS.PLAYED);
  assert.deepEqual(STATUS, { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 });
});

test('a rejected send can become ERROR, and nothing past PENDING falls to it', (t) => {
  const { open } = setup(t);
  const s = open();
  outgoing(s, 'O1', 100);
  s.setStatus(CHAT, ['O1'], STATUS.ERROR);
  assert.equal(byId(s.snapshot(), 'O1').status, STATUS.ERROR, 'PENDING → ERROR');
  outgoing(s, 'O2', 110);
  s.setStatus(CHAT, ['O2'], STATUS.DELIVERY_ACK);
  s.setStatus(CHAT, ['O2'], STATUS.ERROR);
  assert.equal(byId(s.snapshot(), 'O2').status, STATUS.DELIVERY_ACK, 'DELIVERY_ACK stays');
  s.close();
  const again = open();
  assert.equal(byId(again.snapshot(), 'O1').status, STATUS.ERROR);
  again.setStatus(CHAT, ['O1'], STATUS.SERVER_ACK);   // a real ack after all
  assert.equal(byId(again.snapshot(), 'O1').status, STATUS.SERVER_ACK, 'ERROR → SERVER_ACK');
});

test('a second open of the same store is refused while the first is open', (t) => {
  const { dir, open } = setup(t);
  const a = open();
  incoming(a, 'M1', 100);
  // Two stores over one pair of files would each compact its own memory over
  // the other's, and one of them would silently lose.
  assert.throws(() => open(), { code: 'PRIMARY_MESSAGE_STORE_BUSY' });
  assert.throws(() => open({ dir: path.join(dir, '.') }), { code: 'PRIMARY_MESSAGE_STORE_BUSY' }, 'the same dir by another spelling');
  const other = open({ phone: '40700000000' });   // another account in the same dir is fine
  incoming(other, 'X1', 100);
  a.close();
  const b = open();
  incoming(b, 'M2', 110);
  b.close();
  assert.deepEqual(open().snapshot().records[CHAT].map(r => r.id), ['M1', 'M2']);
});

test('supersedes rekeys instead of duplicating', (t) => {
  const { open } = setup(t);
  const s = open();
  outgoing(s, 'A1', 100);
  s.setStatus(CHAT, ['A1'], STATUS.SERVER_ACK);
  s.recordOutgoing({ id: 'B2', chat: CHAT, ts: 100, raw: Buffer.from('final'), info: { kind: 'content' }, supersedes: 'A1' });
  let records = s.snapshot().records[CHAT];
  assert.deepEqual(records.map(r => r.id), ['B2']);
  assert.ok(records[0].raw.equals(Buffer.from('final')));
  assert.equal(records[0].status, STATUS.SERVER_ACK, 'rekeying keeps the status it had');
  s.setStatus(CHAT, ['B2'], STATUS.DELIVERY_ACK);
  // Superseding itself is not a reason to lose the record.
  s.recordOutgoing({ id: 'B2', chat: CHAT, ts: 100, raw: Buffer.from('final'), info: { kind: 'content' }, supersedes: 'B2' });
  assert.deepEqual(s.snapshot().records[CHAT].map(r => r.id), ['B2']);
  s.close();
  records = open().snapshot().records[CHAT];
  assert.deepEqual(records.map(r => [r.id, r.status]), [['B2', STATUS.DELIVERY_ACK]]);
});

test('a revoked message that left memory stays revoked when delivered again', (t) => {
  const { dir, open } = setup(t);
  const s = open({ perChat: 2 });
  incoming(s, 'M1', 10, { raw: Buffer.from('revoked-secret') });
  protocol(s, 'P1', 11, { type: 0, key: { id: 'M1' } });
  incoming(s, 'M2', 20);
  incoming(s, 'M3', 30);
  assert.equal(byId(s.snapshot(), 'M1'), undefined, 'evicted');
  s.drop(CHAT, 'M2');                                         // a slot is free again
  incoming(s, 'M1', 10, { raw: Buffer.from('revoked-secret') });   // and the server delivers it again
  // The same through drop rather than eviction.
  incoming(s, 'M4', 40, { chat: OTHER, raw: Buffer.from('revoked-secret') });
  protocol(s, 'P2', 41, { type: 0, key: { id: 'M4' } }, { chat: OTHER });
  s.drop(OTHER, 'M4');
  incoming(s, 'M4', 40, { chat: OTHER, raw: Buffer.from('revoked-secret') });
  s.close();

  const snap = open({ perChat: 2 }).snapshot();
  for (const [id, chat] of [['M1', CHAT], ['M4', OTHER]]) {
    const r = byId(snap, id, chat);
    assert.equal(r.tombstone, 'revoked', id);
    assert.equal('raw' in r, false, id);
  }
  assert.equal(fs.readFileSync(snapFile(dir), 'utf8').includes(b64('revoked-secret')), false);
});

test('retention keeps the newest perChat and counts evictions', (t) => {
  const { open } = setup(t);
  const s = open({ perChat: 3 });
  for (let i = 1; i <= 5; i++) incoming(s, 'M' + i, i * 10);
  let snap = s.snapshot();
  assert.deepEqual(snap.records[CHAT].map(r => r.id), ['M3', 'M4', 'M5']);
  assert.equal(snap.retained.evicted, 2);
  s.close();
  snap = open({ perChat: 3 }).snapshot();
  assert.equal(snap.records[CHAT].length, 3);
  assert.equal(snap.retained.evicted, 2);
});

test('maxMessages evicts the oldest records of the least-recent chats', (t) => {
  const { open } = setup(t);
  const s = open({ perChat: 10, maxMessages: 3 });
  incoming(s, 'A1', 10);
  incoming(s, 'A2', 20);
  s.recordIncoming({ id: 'B1', chat: OTHER, ts: 30, raw: Buffer.from('b1'), info: { kind: 'content' } });
  s.recordIncoming({ id: 'B2', chat: OTHER, ts: 40, raw: Buffer.from('b2'), info: { kind: 'content' } });
  let snap = s.snapshot();
  assert.deepEqual(snap.records[CHAT].map(r => r.id), ['A2'], 'the chat that went quiet first gives way');
  incoming(s, 'A3', 50);
  snap = s.snapshot();
  assert.deepEqual(snap.records[CHAT].map(r => r.id), ['A2', 'A3']);
  assert.deepEqual(snap.records[OTHER].map(r => r.id), ['B2']);
  assert.equal(snap.retained.evicted, 2);
  assert.deepEqual(snap.chats.map(c => c.id), [CHAT, OTHER], 'chats come newest first');
  s.close();
  assert.equal(open({ perChat: 10, maxMessages: 3 }).snapshot().retained.evicted, 2);
});

test('compaction truncates the log and preserves the snapshot', (t) => {
  const { dir, open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  outgoing(s, 'O1', 110);
  s.setStatus(CHAT, ['O1'], STATUS.SERVER_ACK);
  assert.ok(fs.statSync(logFile(dir)).size > 0);
  s.compact();
  assert.equal(fs.statSync(logFile(dir)).size, 0);
  const seq = JSON.parse(fs.readFileSync(snapFile(dir), 'utf8')).seq;
  assert.equal(seq, s.snapshot().seq);
  incoming(s, 'M2', 120);
  s.close();

  const snap = open().snapshot();
  assert.deepEqual(snap.records[CHAT].map(r => [r.id, r.status]), [['M1', STATUS.DELIVERY_ACK], ['O1', STATUS.SERVER_ACK], ['M2', STATUS.DELIVERY_ACK]]);
});

test('the log compacts itself past 5 000 lines', (t) => {
  const { dir, open } = setup(t);
  const s = open({ perChat: 10 });
  for (let i = 0; i < 5001; i++) s.recordInflight({ id: 'I' + i, chat: CHAT, ts: i });
  const lines = fs.readFileSync(logFile(dir), 'utf8').split('\n').length - 1;
  assert.ok(lines < 5000, `${lines} lines`);
  assert.ok(JSON.parse(fs.readFileSync(snapFile(dir), 'utf8')).seq > 5000);
});

test('a crash between snapshot write and log truncation replays idempotently', (t) => {
  const { dir, open } = setup(t);
  const s = open({ perChat: 2 });
  for (let i = 1; i <= 4; i++) incoming(s, 'M' + i, i * 10);
  outgoing(s, 'O1', 50);
  s.setStatus(CHAT, ['O1'], STATUS.READ);
  s.recordInflight({ id: 'X1', chat: CHAT, ts: 60 });
  const before = s.snapshot();
  const oldLog = fs.readFileSync(logFile(dir));
  assert.ok(oldLog.length > 0);
  // close() writes the snapshot and then truncates; put the log back as if
  // the truncation never happened.
  s.close();
  fs.writeFileSync(logFile(dir), oldLog);

  const after = open({ perChat: 2 }).snapshot();
  const shape = snap => snap.records[CHAT].map(r => [r.id, r.status, r.seq]);
  assert.deepEqual(shape(after), shape(before));
  assert.equal(after.counts.records, before.counts.records);
  assert.equal(after.retained.evicted, before.retained.evicted);
  assert.equal(after.retained.evicted, 3);
  assert.deepEqual(after.losses, [{ reason: 'received-not-stored', ids: ['X1'] }]);
  assert.equal(after.chats[0].unreadCount, before.chats[0].unreadCount);
});

test('markRead and chat meta are kept', (t) => {
  const { open } = setup(t);
  const s = open();
  incoming(s, 'M1', 100);
  incoming(s, 'M2', 110);
  s.setChatMeta(CHAT, { name: 'Ana', pnJid: CHAT, lidJid: '99999@lid' });
  assert.equal(s.snapshot().chats[0].unreadCount, 2);
  s.markRead(CHAT);
  s.drop(CHAT, 'M1');
  s.close();
  const snap = open().snapshot();
  assert.deepEqual(snap.chats, [{ id: CHAT, name: 'Ana', pnJid: CHAT, lidJid: '99999@lid', conversationTimestamp: 110, unreadCount: 0 }]);
  assert.deepEqual(snap.records[CHAT].map(r => r.id), ['M2']);
});

test('misuse fails with a PRIMARY_MESSAGE_STORE_ code', (t) => {
  const { dir, open } = setup(t);
  const fails = (fn, code) => assert.throws(fn, e => CODE.test(e.code) && (!code || e.code === code));
  fails(() => PrimaryMessageStore.open({ dir, phone: '../x' }), 'PRIMARY_MESSAGE_STORE_OPTIONS_INVALID');
  fails(() => PrimaryMessageStore.open({ dir, phone: PHONE, perChat: 0 }), 'PRIMARY_MESSAGE_STORE_OPTIONS_INVALID');
  const s = open();
  fails(() => s.setStatus(CHAT, ['O1'], 9));
  fails(() => s.tombstone(CHAT, 'M1', 'deleted'));
  fails(() => s.recordIncoming({ id: 'M1', chat: CHAT, ts: 1, info: { kind: 'content' } }));
  fails(() => s.recordIncoming({ id: 'M1', chat: CHAT, ts: 1, raw: Buffer.from('x'), info: { kind: 'other' } }));
  fails(() => s.recordOutgoing({ id: '', chat: CHAT, ts: 1, raw: Buffer.from('x'), info: { kind: 'content' } }));
  fails(() => s.setChatMeta(CHAT, { ephemeral: { seconds: -1 } }));
  fails(() => incoming(s, 'M1', 1, { info: { kind: 'content', expiration: 1.5 } }), 'PRIMARY_MESSAGE_STORE_INPUT_INVALID');
  // A revoke whose type is not the number it should be is refused, not
  // quietly ignored with the content left in place.
  fails(() => protocol(s, 'P9', 1, { type: 'REVOKE', key: { id: 'M1' } }), 'PRIMARY_MESSAGE_STORE_INPUT_INVALID');
  s.close();
  s.close();   // closing twice is harmless
  fails(() => incoming(s, 'M1', 1), 'PRIMARY_MESSAGE_STORE_CLOSED');
  fails(() => s.snapshot(), 'PRIMARY_MESSAGE_STORE_CLOSED');

  fs.writeFileSync(snapFile(dir), '{"version":1,');
  fails(() => open(), 'PRIMARY_MESSAGE_STORE_SNAPSHOT_CORRUPT');
});
