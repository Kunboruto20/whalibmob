'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// What a primary sends and receives reaches its message store through the
// paths every message takes: the receive handler, the decrypt paths, the
// sender, receipts. The client here is real. The network, Signal and the
// server are a fake socket and a few stubs, in the manner of the peer in
// test/primary-linking.test.js; the "ciphertext" a stub decrypts is simply the
// plaintext it hands back.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WhalibmobClient } = require('../lib/Client');
const { MessageSender } = require('../lib/messages/MessageSender');
const { createNewStore } = require('../lib/Store');
const { BinaryNode } = require('../lib/BinaryNode');
const { PrimaryMessageStore, STATUS } = require('../lib/primary/MessageStore');
const { type } = require('./helpers/history-proto');
const { Writer } = require('protobufjs/minimal');

const PHONE = '15550000123';
const OWN_LID = '1234567890@lid';
const OWN_DEVICE = PHONE + ':7@s.whatsapp.net';   // a companion of this account
const PEER = '15550000999@s.whatsapp.net';
const PEER_LID = '777000111@lid';
const OTHER = '15550000777@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const MEMBER = '15550000888@s.whatsapp.net';
const T = 1790000000;
const UNDECRYPTABLE = Buffer.from('undecryptable');

const Message = () => type('Message');
const encode = obj => Buffer.from(Message().encode(Message().create(obj)).finish());
const decode = buf => Message().decode(buf);
// A length-delimited field, for the few shapes the fixture schema leaves out.
const field = (number, bytes) => Buffer.from(Writer.create().uint32((number << 3) | 2).bytes(bytes).finish());
// FutureProofMessage { message = 1 }, which the fixture declares as bytes.
const wrapped = inner => field(1, inner);
const logFile = dir => path.join(dir, PHONE + '.primary-messages.log');
const logText = dir => (fs.existsSync(logFile(dir)) ? fs.readFileSync(logFile(dir), 'utf8') : '');
const logEvents = dir => logText(dir).split('\n').filter(Boolean).map(line => JSON.parse(line));
const storeFiles = dir => fs.readdirSync(dir).filter(name => name.includes('primary-messages'));

function fixture(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-capture-test-'));
    fs.chmodSync(dir, 0o700);
    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false, syncAbPropsOnConnect: false,
        ...('messageStore' in options ? { messageStore: options.messageStore } : { messageStore: true }) });
    client._store = createNewStore(PHONE);
    client._store.registered = true;
    client._myLid = OWN_LID;
    client._connected = true;
    client._scheduleReconnect = () => { };
    if (options.mode) client._mode = options.mode;
    // A login without the network: everything _onOpen would ask the server.
    Object.assign(client, {
        _startTimers() { }, _sendActiveIq() { }, _requestMediaConnection() { }, _sendUnifiedSession() { },
        async _ensureServerPreKeys() { }, async _verifyServerKeyBundle() { }, async queryPrivacySettings() { },
        _acceptLoginTos() { }
    });
    // Signal, reduced to what the receive paths call. The stanza carries the
    // plaintext where the ciphertext would be.
    client._signal = {
        store: null, senderKeyStore: null,
        async deleteSession() { },
        async bulkEncryptForDevicesDetailed(jids) {
            return { encrypted: jids.map(jid => ({ jid, type: 'msg', ciphertext: Buffer.from('c') })), failed: [] };
        }
    };
    const open = async buf => { if (buf.equals(UNDECRYPTABLE)) throw new Error('Bad MAC'); return buf; };
    client._decryptWithCandidates = (candidates, encType, cipherBuf) => open(cipherBuf);
    client._senderKeyDecryptWithCandidates = (group, candidates, cipherBuf) => open(cipherBuf);
    client._sendRetryRequest = () => { };
    const errors = [];
    client.on('primary_message_store_error', e => errors.push(e.code));
    const sent = [];
    const f = {
        client, dir, sent, errors,
        // How the server answers each message stanza: ack attributes, or null
        // for no answer at all.
        ack: () => ({ t: String(T + 1) }),
        onMessage: null,
        login() { client._onOpen(new BinaryNode('success', {}, [])); },
        async receive(node) {
            await client._handleMessage(node);
            await client._messageMutex.runExclusive(() => { });
        },
        snapshot() { return client.getPrimaryMessageStore(); },
        // The sender's other half: device lists and sessions, all answered here.
        useSender() {
            client._devMgr = {
                async bulkEnsureSessions(phones) { return phones.map(p => p + '@s.whatsapp.net'); },
                async ensureOwnDeviceSessions() { return []; },
                clearCache() { }, _jidsFromCache() { return []; }, _dcGet() { return null; }, _dcDel() { }
            };
            client._sender = new MessageSender(client);
            return client._sender;
        }
    };
    client._socket = {
        close: () => client._onClose(),
        sendNode(node) {
            sent.push(node);
            if (node.description !== 'message') return;
            if (f.onMessage) f.onMessage(node);
            const reply = f.ack(node);
            if (reply) queueMicrotask(() => client._handleAck(new BinaryNode('ack', { id: node.attrs.id, class: 'message', from: PEER, ...reply }, null)));
        }
    };
    t.after(() => { client.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
    return f;
}

const enc = (encType, content) => new BinaryNode('enc', { type: encType, v: '2' }, content);
const dm = (id, plaintext, attrs = {}) => new BinaryNode('message', { from: PEER, id, t: String(T), type: 'text', notify: 'Ana', ...attrs }, [enc('msg', plaintext)]);
const inGroup = (id, plaintext, attrs = {}) => new BinaryNode('message', { from: GROUP, participant: MEMBER, id, t: String(T), type: 'text', notify: 'Bob', ...attrs }, [enc('skmsg', plaintext)]);
const receipt = (attrs, items = []) => new BinaryNode('receipt', attrs, items.length ? [new BinaryNode('list', {}, items.map(id => new BinaryNode('item', { id }, null)))] : null);
const records = (f, chat) => f.snapshot().records[chat] || [];

test('incoming DM is recorded with raw, pushName and inflight resolved', async t => {
    const f = fixture(t);
    f.login();
    const raw = encode({ conversation: 'merhaba' });
    await f.receive(dm('IN1', raw));
    const snap = f.snapshot();
    assert.equal(snap.capture.lc, f.client._store.connectionLc);
    assert.equal(snap.records[PEER].length, 1);
    const [r] = snap.records[PEER];
    assert.equal(r.id, 'IN1');
    assert.equal(r.fromMe, false);
    assert.equal(r.ts, T);
    assert.equal(r.pushName, 'Ana');
    assert.equal(r.status, STATUS.DELIVERY_ACK);
    assert.ok(r.raw.equals(raw));
    assert.deepEqual(snap.pushNames, [{ id: PEER, pushname: 'Ana' }]);
    assert.deepEqual(logEvents(f.dir).filter(e => e.id === 'IN1').map(e => e.t), ['inflight', 'put']);
    // Nothing is left in flight: a store opened afresh finds no loss.
    f.client.disconnect();
    const reopened = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE });
    try { assert.deepEqual(reopened.snapshot().losses, []); } finally { reopened.close(); }
    assert.deepEqual(f.errors, []);
});

test('inflight is written before the ack is sent', async t => {
    const f = fixture(t);
    f.login();
    const seen = [];
    const ack = f.client._sendMessageAck.bind(f.client);
    f.client._sendMessageAck = (id, ...rest) => {
        seen.push([id, logEvents(f.dir).some(e => e.t === 'inflight' && e.id === id)]);
        return ack(id, ...rest);
    };
    await f.receive(dm('IN2', encode({ conversation: 'a' })));
    await f.receive(inGroup('G2', encode({ conversation: 'b' })));
    assert.deepEqual(seen, [['IN2', true], ['G2', true]]);
    assert.ok(f.sent.some(n => n.description === 'ack' && n.attrs.id === 'IN2'));
});

test('a lid-addressed DM is kept under the phone-number chat and tied to its lid', async t => {
    const f = fixture(t);
    f.login();
    await f.receive(dm('L1', encode({ conversation: 'by lid' }), { from: PEER_LID, sender_pn: PEER }));
    // No pairing known at all: the chat is the jid as addressed.
    await f.receive(dm('L2', encode({ conversation: 'unknown' }), { from: '888000222@lid' }));
    const snap = f.snapshot();
    assert.deepEqual(snap.records[PEER].map(r => r.id), ['L1']);
    assert.equal(snap.records[PEER_LID], undefined);
    const chat = snap.chats.find(c => c.id === PEER);
    assert.equal(chat.pnJid, PEER);
    assert.equal(chat.lidJid, PEER_LID);
    assert.deepEqual(snap.records['888000222@lid'].map(r => r.id), ['L2']);
    assert.deepEqual(f.errors, []);
});

test('group message keeps the participant', async t => {
    const f = fixture(t);
    f.login();
    const raw = encode({ conversation: 'herkese selam' });
    await f.receive(inGroup('G1', raw));
    // A member addressed by lid stays a lid, even with a phone number known
    // for it, and the device the stanza named is not part of who sent it.
    f.client._lidToPn.set('555000333', '15550000666');
    await f.receive(inGroup('G3', encode({ conversation: 'lid' }), { participant: '555000333:4@lid', notify: 'Cem' }));
    const [r, s] = records(f, GROUP);
    assert.equal(r.id, 'G1');
    assert.equal(r.participant, MEMBER);
    assert.equal(r.fromMe, false);
    assert.equal(r.pushName, 'Bob');
    assert.ok(r.raw.equals(raw));
    assert.equal(s.participant, '555000333@lid');
    assert.deepEqual(f.snapshot().pushNames, [{ id: MEMBER, pushname: 'Bob' }, { id: '555000333@lid', pushname: 'Cem' }]);
    assert.deepEqual(f.errors, []);
});

test('device-sent message is recorded fromMe in the destination chat with the inner raw', async t => {
    const f = fixture(t);
    f.login();
    const inner = encode({ conversation: 'from web' });
    await f.receive(dm('DSM1', encode({ deviceSentMessage: { destinationJID: PEER, message: inner } }), { from: OWN_DEVICE, notify: 'Me' }));
    const snap = f.snapshot();
    assert.deepEqual(Object.keys(snap.records), [PEER]);
    const [r] = snap.records[PEER];
    assert.equal(r.id, 'DSM1');
    assert.equal(r.fromMe, true);
    assert.equal(r.status, STATUS.SERVER_ACK);
    assert.equal(r.pushName, undefined);
    assert.ok(r.raw.equals(inner));
    assert.equal(snap.chats.find(c => c.id === PEER).unreadCount, 0);
    assert.deepEqual(f.errors, []);
});

test('revoke received tombstones the stored target', async t => {
    const f = fixture(t);
    f.login();
    await f.receive(dm('IN3', encode({ conversation: 'gizli' })));
    await f.receive(dm('IN4', encode({ conversation: 'kalsin' })));
    const revoke = id => encode({ protocolMessage: { type: 0, key: { remoteJID: PEER, fromMe: false, ID: id } } });
    // From someone else's chat, naming this one: the chat it arrived in is
    // the only one it may touch.
    await f.receive(dm('RV0', revoke('IN4'), { from: OTHER, edit: '7' }));
    await f.receive(dm('RV1', revoke('IN3'), { edit: '7' }));
    // Our own message, sent and then deleted from a companion.
    const inner = encode({ conversation: 'from web' });
    await f.receive(dm('DSM2', encode({ deviceSentMessage: { destinationJID: PEER, message: inner } }), { from: OWN_DEVICE }));
    const ownRevoke = encode({ protocolMessage: { type: 0, key: { remoteJID: PEER, fromMe: true, ID: 'DSM2' } } });
    await f.receive(dm('RV2', encode({ deviceSentMessage: { destinationJID: PEER, message: ownRevoke } }), { from: OWN_DEVICE, edit: '7' }));
    const byId = Object.fromEntries(records(f, PEER).map(r => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['DSM2', 'IN3', 'IN4']);
    assert.equal(byId.IN3.tombstone, 'revoked');
    assert.equal(byId.IN3.raw, undefined);
    assert.equal(byId.DSM2.tombstone, 'revoked');
    assert.equal(byId.DSM2.raw, undefined);
    assert.equal(byId.IN4.tombstone, undefined);
    assert.ok(byId.IN4.raw);
    assert.deepEqual(f.snapshot().losses, []);
    assert.deepEqual(f.errors, []);
});

test('an incoming edit replaces the stored content', async t => {
    const f = fixture(t);
    f.login();
    await f.receive(dm('IN5', encode({ conversation: 'ilk' })));
    const edited = encode({ conversation: 'ikinci' });
    await f.receive(dm('ED1', encode({ protocolMessage: { type: 14, key: { remoteJID: PEER, fromMe: false, ID: 'IN5' }, editedMessage: edited } }), { edit: '1' }));
    const [r] = records(f, PEER);
    assert.equal(r.id, 'IN5');
    assert.ok(r.raw.equals(edited));
    assert.equal(r.edited, T);
    assert.deepEqual(f.errors, []);
});

test('a view-once message is kept without its content', async t => {
    const f = fixture(t);
    f.login();
    const hidden = encode({ conversation: 'bir kez' });
    await f.receive(dm('VO1', encode({ viewOnceMessageV2: wrapped(hidden) })));
    const [r] = records(f, PEER);
    assert.equal(r.id, 'VO1');
    assert.equal(r.tombstone, 'view-once');
    assert.equal(r.raw, undefined);
    assert.ok(!logText(f.dir).includes(hidden.toString('base64')));
    assert.ok(!logText(f.dir).includes('bir kez'));
    assert.deepEqual(f.errors, []);
});

test('a message that fails to decrypt is a loss until its retry decrypts', async t => {
    const f = fixture(t);
    f.login();
    await f.receive(dm('BAD1', UNDECRYPTABLE));
    await f.receive(inGroup('BAD2', UNDECRYPTABLE));
    assert.deepEqual(f.snapshot().losses, [{ reason: 'undecryptable', ids: ['BAD1', 'BAD2'] }]);
    await f.receive(dm('BAD1', encode({ conversation: 'tekrar' })));
    assert.deepEqual(f.snapshot().losses, [{ reason: 'undecryptable', ids: ['BAD2'] }]);
    assert.deepEqual(records(f, PEER).map(r => r.id), ['BAD1']);
    // A message with nothing this client can open is accounted for too.
    await f.receive(new BinaryNode('message', { from: PEER, id: 'NOENC', t: String(T), type: 'text' }, [new BinaryNode('unavailable', {}, null)]));
    assert.deepEqual(f.snapshot().losses, [{ reason: 'undecryptable', ids: ['BAD2', 'NOENC'] }]);
    assert.deepEqual(f.errors, []);
});

test('a listener that throws does not make a decrypted message a loss', async t => {
    const f = fixture(t);
    f.login();
    f.client.on('message', () => { throw new Error('listener bug'); });
    await f.receive(dm('RX2', field(46, field(2, Buffer.from('👍')))));
    await f.receive(dm('IN10', encode({ conversation: 'yine de kayitli' })));
    assert.deepEqual(f.snapshot().losses, []);
    assert.deepEqual(records(f, PEER).map(r => r.id), ['IN10']);
});

test('reactions, sender-key distributions, status and newsletter messages are not kept', async t => {
    const f = fixture(t);
    f.login();
    // Message { reactionMessage = 46 { text = 2 } } and
    // Message { senderKeyDistributionMessage = 2 { groupId = 1, axolotl… = 2 } },
    // which the fixture schema does not declare.
    const reaction = field(46, field(2, Buffer.from('👍')));
    const skdmOnly = field(2, Buffer.concat([field(1, Buffer.from(GROUP)), field(2, Buffer.from([0x01]))]));
    await f.receive(dm('RX1', reaction));
    await f.receive(dm('SK1', skdmOnly));
    // Nothing the decoder knows.
    await f.receive(dm('UK1', field(100, Buffer.alloc(0))));
    await f.receive(dm('ST1', encode({ conversation: 'story' }), { from: 'status@broadcast', participant: PEER }));
    await f.receive(dm('NL1', encode({ conversation: 'news' }), { from: '120363000000000002@newsletter' }));
    const snap = f.snapshot();
    assert.equal(snap.counts.records, 0);
    assert.deepEqual(snap.losses, []);
    // Skipped, yet no longer in flight; status and channels never were.
    for (const id of ['RX1', 'SK1', 'UK1']) assert.deepEqual(logEvents(f.dir).filter(e => e.id === id).map(e => e.t), ['inflight', 'resolve'], id);
    assert.deepEqual(logEvents(f.dir).filter(e => ['ST1', 'NL1'].includes(e.id)), []);
    assert.deepEqual(f.errors, []);
});

test('outgoing send records PENDING then SERVER_ACK on a real ack', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    const atDispatch = [];
    f.onMessage = node => atDispatch.push(records(f, PEER).map(r => [r.id, r.status, node.attrs.id]));
    const result = await sender.sendText(PEER, 'selam');
    assert.deepEqual(atDispatch, [[[result.id, STATUS.PENDING, result.id]]]);
    const [r] = records(f, PEER);
    assert.equal(r.id, result.id);
    assert.equal(r.fromMe, true);
    assert.equal(r.status, STATUS.SERVER_ACK);
    assert.equal(decode(r.raw).conversation, 'selam');
    assert.deepEqual(f.errors, []);
});

test('ack timeout leaves PENDING', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    // What the 20 s timer resolves with: sent, but with no server time on it.
    sender._dispatchAndAck = async (node, id) => ({ id, status: 'sent' });
    const result = await sender.sendText(PEER, 'cevapsiz');
    const [r] = records(f, PEER);
    assert.equal(r.id, result.id);
    assert.equal(r.status, STATUS.PENDING);
});

test('a rejected send is marked ERROR', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    f.ack = () => ({ error: '400' });
    await assert.rejects(sender.sendText(PEER, 'reddedildi', { id: 'REJ1' }), /Send error 400/);
    const [r] = records(f, PEER);
    assert.equal(r.id, 'REJ1');
    assert.equal(r.status, STATUS.ERROR);
});

test('regenerated id after 479 rekeys the same record', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    const ids = [];
    f.ack = node => { ids.push(node.attrs.id); return ids.length === 1 ? { error: '479' } : { t: String(T + 1) }; };
    const result = await sender.sendText(PEER, 'yeniden', { id: 'FIRST' });
    assert.equal(ids.length, 2);
    assert.equal(ids[0], 'FIRST');
    assert.notEqual(ids[1], 'FIRST');
    assert.equal(result.id, ids[1]);
    const all = records(f, PEER);
    assert.deepEqual(all.map(r => [r.id, r.status]), [[ids[1], STATUS.SERVER_ACK]]);
    assert.equal(decode(all[0].raw).conversation, 'yeniden');
    assert.deepEqual(f.errors, []);
});

test('delivery and read receipts raise status, including list items', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    const a = (await sender.sendText(PEER, '1')).id;
    const b = (await sender.sendText(PEER, '2')).id;
    const c = (await sender.sendText(PEER, '3')).id;
    f.client._handleReceipt(receipt({ id: a, from: PEER, t: String(T + 2) }));
    f.client._handleReceipt(receipt({ id: b, from: PEER, type: 'read', t: String(T + 3) }, [c]));
    let status = Object.fromEntries(records(f, PEER).map(r => [r.id, r.status]));
    assert.deepEqual(status, { [a]: STATUS.DELIVERY_ACK, [b]: STATUS.READ, [c]: STATUS.READ });
    // Lower news never lowers a status.
    f.client._handleReceipt(receipt({ id: b, from: PEER, t: String(T + 4) }));
    f.client._handleReceipt(receipt({ id: c, from: PEER, type: 'played', t: String(T + 5) }));
    status = Object.fromEntries(records(f, PEER).map(r => [r.id, r.status]));
    assert.deepEqual(status, { [a]: STATUS.DELIVERY_ACK, [b]: STATUS.READ, [c]: STATUS.PLAYED });
    // Read on another of our devices: the chat is read here too.
    f.client.autoRead = false;
    await f.receive(dm('IN6', encode({ conversation: 'okunmadi' })));
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 1);
    f.client._handleReceipt(receipt({ id: 'IN6', from: PEER, type: 'read-self', t: String(T + 6) }));
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 0);
    assert.equal(records(f, PEER).find(r => r.id === 'IN6').status, STATUS.READ);
    assert.deepEqual(f.errors, []);
});

test('markRead clears the unread count of the chat', async t => {
    const f = fixture(t);
    f.login();
    f.client.autoRead = false;
    await f.receive(dm('IN7', encode({ conversation: 'bir' })));
    await f.receive(dm('IN8', encode({ conversation: 'iki' })));
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 2);
    f.client.markRead(PEER, ['IN7', 'IN8']);
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 0);
    // Read receipts sent on arrival read the chat as they go.
    f.client.autoRead = true;
    await f.receive(dm('IN9', encode({ conversation: 'uc' })));
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 0);
});

test('editMessage replaces the stored content; deleteMessage forEveryone tombstones it', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    const { id } = await sender.sendText(PEER, 'ilk hali');
    const other = (await sender.sendText(PEER, 'sadece bende silinecek')).id;
    await sender.editMessage(id, PEER, 'son hali');
    let byId = Object.fromEntries(records(f, PEER).map(r => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), [id, other].sort());
    assert.equal(decode(byId[id].raw).extendedTextMessage.text, 'son hali');
    assert.equal(typeof byId[id].edited, 'number');
    await sender.deleteMessage(id, PEER, true, true);
    await sender.deleteMessage(other, PEER, true, false);
    byId = Object.fromEntries(records(f, PEER).map(r => [r.id, r]));
    assert.deepEqual(Object.keys(byId), [id]);
    assert.equal(byId[id].tombstone, 'revoked');
    assert.equal(byId[id].raw, undefined);
    // The edit and the revoke went out as messages, and neither became one here.
    assert.equal(f.sent.filter(n => n.description === 'message').length, 4);
    assert.deepEqual(f.errors, []);
});

test('messageStore off records nothing and creates no files', async t => {
    const f = fixture(t, { messageStore: undefined });
    f.login();
    const sender = f.useSender();
    await f.receive(dm('OFF1', encode({ conversation: 'kayit yok' })));
    const { id } = await sender.sendText(PEER, 'kayit yok');
    f.client._handleReceipt(receipt({ id, from: PEER, type: 'read' }));
    f.client.markRead(PEER, ['OFF1']);
    await sender.editMessage(id, PEER, 'yine yok');
    await sender.deleteMessage(id, PEER, true, true);
    assert.equal(f.client._messageStore, null);
    assert.equal(f.client.getPrimaryMessageStore(), null);
    assert.deepEqual(storeFiles(f.dir), []);
});

test('a companion session never opens the primary store', async t => {
    const f = fixture(t, { mode: 'web' });
    f.login();
    await f.receive(dm('WEB1', encode({ conversation: 'web' })));
    assert.equal(f.client._messageStore, null);
    assert.deepEqual(storeFiles(f.dir), []);
});

test('a store that fails to open is reported and the connection carries on', async t => {
    const f = fixture(t);
    const damaged = 'not an event\n{"seq":1}\n';
    fs.writeFileSync(logFile(f.dir), damaged, { mode: 0o600 });
    let connected = false;
    f.client.on('connected', () => { connected = true; });
    f.login();
    assert.equal(connected, true);
    assert.equal(f.client._connected, true);
    assert.deepEqual(f.errors, ['PRIMARY_MESSAGE_STORE_LOG_CORRUPT']);
    assert.equal(f.client._messageStore, null);
    assert.equal(f.client.getPrimaryMessageStore(), null);
    await f.receive(dm('AFTER1', encode({ conversation: 'yine de geldi' })));
    assert.ok(f.sent.some(n => n.description === 'ack' && n.attrs.id === 'AFTER1'));
    assert.equal(fs.readFileSync(logFile(f.dir), 'utf8'), damaged);
});

test('the store stays open across a reconnect and closes when the client stops', async t => {
    const f = fixture(t);
    f.login();
    const store = f.client._messageStore;
    assert.ok(store);
    assert.equal(f.snapshot().capture.lc, 1);
    // A dropped connection the client will dial back: messages still being
    // decrypted from it must find the store open.
    f.client._onClose();
    assert.equal(f.client._messageStore, store);
    f.client._connected = true;
    f.client._socket = { close: () => f.client._onClose(), sendNode() { } };
    f.login();
    assert.equal(f.client._messageStore, store);
    assert.equal(f.snapshot().capture.lc, 2);
    assert.deepEqual(f.snapshot().losses, []);
    f.client.disconnect();
    assert.equal(f.client._messageStore, null);
    // Released, not leaked: the files open again in this same process.
    const reopened = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE, lc: f.client._store.connectionLc });
    try { assert.deepEqual(reopened.snapshot().losses, []); } finally { reopened.close(); }
    assert.deepEqual(f.errors, []);
});
