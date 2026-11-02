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
const varintField = (number, value) => Buffer.from(Writer.create().uint32(number << 3).uint32(value).finish());
// Whether any record bytes in the log hold `secret`, however they are encoded.
const logHolds = (dir, secret) => logEvents(dir).some(e => typeof e.raw === 'string' && Buffer.from(e.raw, 'base64').includes(secret));
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
        // The sender's other half: device lists, sessions and sender keys, all
        // answered here. GROUP has one member and is phone-number addressed.
        useSender() {
            client._devMgr = {
                async bulkEnsureSessions(phones) { return phones.map(p => p + '@s.whatsapp.net'); },
                async ensureOwnDeviceSessions() { return []; },
                async rebuildSessionsForJids() { return []; },
                clearCache() { }, _jidsFromCache() { return []; }, _dcGet() { return null; }, _dcDel() { }
            };
            Object.assign(client._signal, {
                async buildSKDM() { return Buffer.from('skdm'); },
                async senderKeyEncrypt() { return Buffer.from('skmsg'); },
                senderKeyStore: { getSKDMMap: () => ({}), markSKDMSent() { }, invalidateSKDM() { } }
            });
            client._groupMembers.set(GROUP, new Set([MEMBER]));
            client._groupAddressingMode.set(GROUP, 'pn');
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
    // Delivered, then read by the read receipt autoRead sends on arrival.
    assert.equal(r.status, STATUS.READ);
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
    // Message { messageContextInfo = 35 } and nothing beside it.
    await f.receive(dm('MC1', field(35, field(3, Buffer.alloc(32, 7)))));
    await f.receive(dm('ST1', encode({ conversation: 'story' }), { from: 'status@broadcast', participant: PEER }));
    await f.receive(dm('NL1', encode({ conversation: 'news' }), { from: '120363000000000002@newsletter' }));
    const snap = f.snapshot();
    assert.equal(snap.counts.records, 0);
    assert.deepEqual(snap.losses, []);
    // Skipped, yet no longer in flight; status and channels never were.
    for (const id of ['RX1', 'SK1', 'MC1']) assert.deepEqual(logEvents(f.dir).filter(e => e.id === id).map(e => e.t), ['inflight', 'resolve'], id);
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

test('markRead clears the unread count and marks the messages read', async t => {
    const f = fixture(t);
    f.login();
    f.client.autoRead = false;
    const status = () => Object.fromEntries(records(f, PEER).map(r => [r.id, r.status]));
    await f.receive(dm('IN7', encode({ conversation: 'bir' })));
    await f.receive(dm('IN8', encode({ conversation: 'iki' })));
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 2);
    f.client.markRead(PEER, ['IN7', 'IN8']);
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 0);
    assert.deepEqual(status(), { IN7: STATUS.READ, IN8: STATUS.READ });
    // Read receipts sent on arrival read the chat, and the message, as they go.
    f.client.autoRead = true;
    await f.receive(dm('IN9', encode({ conversation: 'uc' })));
    assert.equal(f.snapshot().chats.find(x => x.id === PEER).unreadCount, 0);
    assert.equal(status().IN9, STATUS.READ);
    // A voice note listened to.
    f.client.markRead(PEER, ['IN9'], { type: 'played' });
    assert.equal(status().IN9, STATUS.PLAYED);
    assert.deepEqual(f.errors, []);
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

test('chat-visible types the decoder does not know are kept as they came', async t => {
    const f = fixture(t);
    f.login();
    // pollCreationMessageV3 = 64, ptvMessage = 66, contactsArrayMessage = 13,
    // liveLocationMessage = 18: none of them has a branch in the decoder.
    const kept = {
        P64: field(64, field(2, Buffer.from('Ne yiyelim?'))),
        P66: field(66, field(1, Buffer.from('https://mmg/x'))),
        P13: field(13, field(1, Buffer.from('2 kisi'))),
        P18: field(18, field(3, Buffer.from('x'))),
        // The first message in a group rides with a sender-key distribution,
        // which the decoder then takes for the whole message.
        PSK: Buffer.concat([field(2, field(1, Buffer.from(GROUP))), field(64, field(2, Buffer.from('ilk')))])
    };
    for (const [id, raw] of Object.entries(kept)) await f.receive(dm(id, raw));
    const byId = Object.fromEntries(records(f, PEER).map(r => [r.id, r]));
    for (const [id, raw] of Object.entries(kept)) {
        assert.ok(byId[id], id);
        assert.ok(byId[id].raw.equals(raw), id);
        assert.equal(byId[id].tombstone, undefined, id);
    }
    // Sent from a companion: ours, in the chat the envelope names.
    const inner = field(64, field(2, Buffer.from('webden anket')));
    await f.receive(dm('PDS', encode({ deviceSentMessage: { destinationJID: OTHER, message: inner } }), { from: OWN_DEVICE }));
    const [own] = records(f, OTHER);
    assert.equal(own.id, 'PDS');
    assert.equal(own.fromMe, true);
    assert.ok(own.raw.equals(inner));
    // A video note sent view-once: kept without its content.
    const ptv = field(66, field(1, Buffer.from('gizli-video')));
    await f.receive(dm('PVO', encode({ viewOnceMessageV2: wrapped(ptv) })));
    const vo = records(f, PEER).find(r => r.id === 'PVO');
    assert.equal(vo.tombstone, 'view-once');
    assert.equal(vo.raw, undefined);
    assert.ok(!logText(f.dir).includes(ptv.toString('base64')));
    // Nothing a chat would show: a keep, a pin, an encrypted reaction, an
    // event response, beside a message context at most.
    const context = field(35, field(3, Buffer.alloc(32, 1)));
    await f.receive(dm('NC1', Buffer.concat([field(51, field(2, Buffer.from('x'))), context])));
    await f.receive(dm('NC2', field(63, field(1, Buffer.from('x')))));
    await f.receive(dm('NC3', field(56, field(2, Buffer.from('x')))));
    await f.receive(dm('NC4', field(76, field(2, Buffer.from('x')))));
    for (const id of ['NC1', 'NC2', 'NC3', 'NC4']) {
        assert.deepEqual(logEvents(f.dir).filter(e => e.id === id).map(e => e.t), ['inflight', 'resolve'], id);
    }
    assert.deepEqual(f.snapshot().losses, []);
    assert.deepEqual(f.errors, []);
});

test('a poll vote is not kept and leaves the chat as it was', async t => {
    const f = fixture(t);
    f.login();
    f.client.autoRead = false;
    await f.receive(dm('POLL1', encode({ conversation: 'anket' })));
    const before = f.snapshot().chats.find(c => c.id === PEER);
    // Message { pollUpdateMessage = 50 { pollCreationMessageKey = 1, vote = 2 } }
    const vote = field(50, Buffer.concat([field(1, field(3, Buffer.from('POLL1'))), field(2, Buffer.concat([field(1, Buffer.from('enc')), field(2, Buffer.from('iv'))]))]));
    await f.receive(dm('V1', vote, { t: String(T + 100) }));
    const after = f.snapshot().chats.find(c => c.id === PEER);
    assert.deepEqual(records(f, PEER).map(r => r.id), ['POLL1']);
    assert.equal(after.unreadCount, before.unreadCount);
    assert.equal(after.conversationTimestamp, before.conversationTimestamp);
    assert.deepEqual(logEvents(f.dir).filter(e => e.id === 'V1').map(e => e.t), ['inflight', 'resolve']);
    assert.deepEqual(f.snapshot().losses, []);
});

test('a device-sent message without a destination is filed by its stanza, never as unreadable', async t => {
    const f = fixture(t);
    f.login();
    // DeviceSentMessage { message = 2, phash = 3 }, naming no chat.
    const phashOnly = inner => field(31, Buffer.concat([field(2, inner), field(3, Buffer.from('2:abcdef'))]));
    const toGroup = encode({ conversation: 'gruba webden' });
    await f.receive(inGroup('DP1', phashOnly(toGroup), { participant: OWN_DEVICE }));
    const toPeer = encode({ conversation: 'birebir' });
    await f.receive(dm('DP2', phashOnly(toPeer), { from: OWN_DEVICE, recipient: PEER }));
    await f.receive(dm('DP3', phashOnly(encode({ conversation: 'nereye' })), { from: OWN_DEVICE }));
    const [g] = records(f, GROUP);
    assert.equal(g.id, 'DP1');
    assert.equal(g.fromMe, true);
    assert.ok(g.raw.equals(toGroup));
    const [p] = records(f, PEER);
    assert.equal(p.id, 'DP2');
    assert.equal(p.fromMe, true);
    assert.ok(p.raw.equals(toPeer));
    assert.equal(f.snapshot().counts.records, 2);
    assert.deepEqual(logEvents(f.dir).filter(e => e.id === 'DP3').map(e => e.t), ['inflight', 'resolve']);
    assert.deepEqual(f.snapshot().losses, []);
});

test('a reaction delivered again and failing to decrypt is not a loss', async t => {
    const f = fixture(t);
    f.login();
    await f.receive(dm('RXD', field(46, field(2, Buffer.from('x')))));
    await f.receive(dm('RXD', UNDECRYPTABLE));
    assert.deepEqual(f.snapshot().losses, []);
    f.client.disconnect();
    const reopened = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE, lc: f.client._store.connectionLc });
    try { assert.deepEqual(reopened.snapshot().losses, []); } finally { reopened.close(); }
});

test('a group admin revoke tombstones another member\'s message', async t => {
    const f = fixture(t);
    f.login();
    await f.receive(inGroup('GA1', encode({ conversation: 'silinecek' })));
    const revoke = encode({ protocolMessage: { type: 0, key: { remoteJID: GROUP, fromMe: false, ID: 'GA1', participant: MEMBER } } });
    await f.receive(inGroup('GA2', revoke, { participant: '15550000444@s.whatsapp.net', edit: '8' }));
    const [r] = records(f, GROUP);
    assert.equal(r.id, 'GA1');
    assert.equal(r.tombstone, 'revoked');
    assert.equal(r.raw, undefined);
    assert.deepEqual(f.errors, []);
});

test('a device-sent message to a lid is filed under the phone number its stanza names', async t => {
    const f = fixture(t);
    f.login();
    const inner = encode({ conversation: 'lid adresine' });
    await f.receive(dm('DL1', encode({ deviceSentMessage: { destinationJID: PEER_LID, message: inner } }), { from: OWN_DEVICE, peer_recipient_pn: PEER }));
    const snap = f.snapshot();
    assert.deepEqual(Object.keys(snap.records), [PEER]);
    assert.equal(snap.records[PEER][0].fromMe, true);
    assert.ok(snap.records[PEER][0].raw.equals(inner));
    const chat = snap.chats.find(c => c.id === PEER);
    assert.equal(chat.pnJid, PEER);
    assert.equal(chat.lidJid, PEER_LID);
});

test('both sides of a phone-number and lid pair carry the tie', async t => {
    const f = fixture(t);
    f.login();
    // Before the pairing is known the chat is the lid; after, the phone number.
    await f.receive(dm('LT1', encode({ conversation: 'once' }), { from: PEER_LID }));
    await f.receive(dm('LT2', encode({ conversation: 'sonra' }), { from: PEER_LID, sender_pn: PEER }));
    const snap = f.snapshot();
    assert.deepEqual(snap.records[PEER_LID].map(r => r.id), ['LT1']);
    assert.deepEqual(snap.records[PEER].map(r => r.id), ['LT2']);
    for (const id of [PEER, PEER_LID]) {
        const chat = snap.chats.find(c => c.id === id);
        assert.equal(chat.pnJid, PEER, id);
        assert.equal(chat.lidJid, PEER_LID, id);
    }
});

test('the record follows a send through the group 479, NO_OPEN_SESSION and 463 retries', async t => {
    const f = fixture(t);
    f.login();
    const sender = f.useSender();
    // Group, 479: the stanza is sent again under a new id.
    let ids = [];
    f.ack = node => { ids.push(node.attrs.id); return ids.length === 1 ? { error: '479' } : { t: String(T + 1) }; };
    const g = await sender.sendText(GROUP, 'grup', { id: 'G479' });
    assert.equal(ids[0], 'G479');
    assert.equal(g.id, ids[1]);
    assert.deepEqual(records(f, GROUP).map(r => [r.id, r.status]), [[ids[1], STATUS.SERVER_ACK]]);
    // NO_OPEN_SESSION: nothing went out under the first id at all.
    ids = [];
    f.ack = node => { ids.push(node.attrs.id); return { t: String(T + 1) }; };
    const encrypt = f.client._signal.bulkEncryptForDevicesDetailed;
    let refused = false;
    f.client._signal.bulkEncryptForDevicesDetailed = async jids => {
        if (refused) return encrypt(jids);
        refused = true;
        return { encrypted: [], failed: jids.map(jid => ({ jid, reason: 'no session' })) };
    };
    const n = await sender.sendText(PEER, 'oturum', { id: 'NOS1' });
    f.client._signal.bulkEncryptForDevicesDetailed = encrypt;
    assert.deepEqual(ids, [n.id]);
    assert.notEqual(n.id, 'NOS1');
    assert.deepEqual(records(f, PEER).map(r => [r.id, r.status]), [[n.id, STATUS.SERVER_ACK]]);
    // 463: the same stanza again under a new id, once a token is in hand.
    Object.assign(f.client, {
        _tcTokenStore: { get: () => ({ token: Buffer.from('tok'), timestamp: Math.floor(Date.now() / 1000) }), shouldIssue: () => false, clearToken() { } },
        async ensureTcTokenBeforeSend() { }, async _issuePrivacyTokens() { return {}; }, _storeTcTokenFromIqResult() { },
        _refreshReachoutTimelockAfter463() { }, _resolveTcTokenJid: jid => String(jid), _resolveTcTokenIssuanceJid: jid => String(jid)
    });
    ids = [];
    f.ack = node => { ids.push(node.attrs.id); return ids.length === 1 ? { error: '463' } : { t: String(T + 1) }; };
    const tc = await sender.sendText(OTHER, 'token', { id: 'TC1' });
    assert.equal(ids[0], 'TC1');
    assert.equal(tc.id, ids[1]);
    assert.deepEqual(records(f, OTHER).map(r => [r.id, r.status]), [[ids[1], STATUS.SERVER_ACK]]);
    assert.deepEqual(f.errors, []);
});

test('a store that throws never breaks the message path', async t => {
    const f = fixture(t);
    f.client.on('primary_message_store_error', () => { throw new Error('a listener that throws too'); });
    // Even working out where the store lives can fail.
    f.client._sessionDir = 42;
    f.login();
    assert.equal(f.client._messageStore, null);
    assert.equal(f.client._connected, true);
    assert.deepEqual(f.errors, ['PRIMARY_MESSAGE_STORE_FAILED']);
    f.client._sessionDir = f.dir;
    f.login();
    assert.ok(f.client._messageStore);
    // A store that refuses a record, and a chat that cannot be worked out.
    const messages = [];
    f.client.on('message', m => messages.push(m.id));
    f.client._messageStore.recordIncoming = () => { throw new TypeError('store bug'); };
    await f.receive(dm('TH1', encode({ conversation: 'yine de' })));
    f.client._captureChat = () => { throw new TypeError('chat bug'); };
    await f.receive(dm('TH2', encode({ conversation: 'yine de' })));
    assert.deepEqual(messages, ['TH1', 'TH2']);
    assert.ok(f.sent.some(n => n.description === 'ack' && n.attrs.id === 'TH2'));
    assert.deepEqual(f.errors.slice(1), ['PRIMARY_MESSAGE_STORE_FAILED', 'PRIMARY_MESSAGE_STORE_FAILED', 'PRIMARY_MESSAGE_STORE_FAILED']);
});

test('a snapshot whose sweep cannot be written is still handed out, without expired content', async t => {
    const f = fixture(t);
    f.login();
    // A disappearing message long past its minute.
    await f.receive(dm('EX1', encode({ extendedTextMessage: { text: 'bir dakika', contextInfo: { expiration: 60 } } })));
    await f.receive(dm('EX2', encode({ conversation: 'kalici' })));
    f.client._messageStore._sweep = () => {
        const err = new Error('PRIMARY_MESSAGE_STORE_WRITE_FAILED: disk full');
        err.code = 'PRIMARY_MESSAGE_STORE_WRITE_FAILED';
        throw err;
    };
    const snap = f.client.getPrimaryMessageStore();
    assert.deepEqual(f.errors, ['PRIMARY_MESSAGE_STORE_WRITE_FAILED']);
    const byId = Object.fromEntries(snap.records[PEER].map(r => [r.id, r]));
    assert.equal(byId.EX1.tombstone, 'expired');
    assert.equal(byId.EX1.raw, undefined);
    assert.ok(byId.EX2.raw);
});

test('disconnect lets the messages still being decrypted reach the store first', async t => {
    const f = fixture(t);
    f.login();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const decrypt = f.client._decryptWithCandidates;
    f.client._decryptWithCandidates = async (...args) => { await gate; return decrypt(...args); };
    await f.client._handleMessage(dm('Q1', encode({ conversation: 'kuyrukta' })));
    const store = f.client._messageStore;
    f.client.disconnect();
    assert.equal(f.client._messageStore, store);
    release();
    await f.client._messageMutex.waitForUnlock();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.client._messageStore, null);
    const reopened = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE, lc: f.client._store.connectionLc });
    try {
        const snap = reopened.snapshot();
        assert.deepEqual(snap.records[PEER].map(r => r.id), ['Q1']);
        assert.deepEqual(snap.losses, []);
    } finally { reopened.close(); }
});

test('disconnect waits for the decrypt queue only briefly', async t => {
    const f = fixture(t);
    f.login();
    f.client._messageStoreDrainMs = 20;
    f.client._decryptWithCandidates = () => new Promise(() => { });   // never
    await f.client._handleMessage(dm('Q2', encode({ conversation: 'takildi' })));
    f.client.disconnect();
    assert.ok(f.client._messageStore);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.client._messageStore, null);
    const reopened = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE, lc: f.client._store.connectionLc });
    try { assert.deepEqual(reopened.snapshot().losses, [{ reason: 'received-not-stored', ids: ['Q2'] }]); } finally { reopened.close(); }
});

test('view-once is never kept, whatever wrapper or media flag it hides behind', async t => {
    const f = fixture(t);
    f.login();
    const secret = Buffer.from('MEDIAKEY-SECRET');
    // VideoMessage { URL = 1, mediaKey = 6 }, ImageMessage { URL = 1, mediaKey = 8 }
    const video = Buffer.concat([field(1, Buffer.from('https://mmg/v')), field(6, secret)]);
    const image = Buffer.concat([field(1, Buffer.from('https://mmg/i')), field(8, secret)]);
    const viewOnceVideo = field(55, wrapped(field(66, video)));   // viewOnceMessageV2 { ptvMessage }
    const hidden = {
        // FutureProofMessage wrappers the decoder does not open: groupMentioned,
        // botInvoke, associatedChild, botForwarded, spoiler.
        W62: field(62, wrapped(viewOnceVideo)),
        W67: field(67, wrapped(viewOnceVideo)),
        W91: field(91, wrapped(viewOnceVideo)),
        W104: field(104, wrapped(viewOnceVideo)),
        W118: field(118, wrapped(viewOnceVideo)),
        // Two of them, one inside the other.
        W2: field(118, wrapped(field(62, wrapped(viewOnceVideo)))),
        // No envelope at all, only the media's own flag: VideoMessage.viewOnce = 20
        // on a video note, ImageMessage.viewOnce = 25 on an image the decoder
        // knows and on an instant image it does not.
        FPTV: field(66, Buffer.concat([video, varintField(20, 1)])),
        FIMG: field(3, Buffer.concat([image, varintField(25, 1)])),
        FINS: field(135, Buffer.concat([image, varintField(25, 1)])),
        // Cut short: what cannot be read is treated as hiding one.
        CUT: Buffer.concat([field(66, video), Buffer.from([0x92, 0x04, 0x7f, 0x0a])])
    };
    for (const [id, raw] of Object.entries(hidden)) await f.receive(dm(id, raw));
    const byId = Object.fromEntries(records(f, PEER).map(r => [r.id, r]));
    for (const id of Object.keys(hidden)) {
        assert.ok(byId[id], id);
        assert.equal(byId[id].tombstone, 'view-once', id);
        assert.equal(byId[id].raw, undefined, id);
    }
    // An edit that would bring view-once content in is not applied.
    const plain = encode({ conversation: 'duz metin' });
    await f.receive(dm('ED2', plain));
    await f.receive(dm('ED3', encode({ protocolMessage: { type: 14, key: { remoteJID: PEER, fromMe: false, ID: 'ED2' }, editedMessage: hidden.W62 } }), { edit: '1' }));
    const edited = records(f, PEER).find(r => r.id === 'ED2');
    assert.ok(edited.raw.equals(plain));
    assert.equal(edited.edited, undefined);
    assert.equal(logHolds(f.dir, secret), false);
    // An ordinary image, flag unset or absent, is kept with its content.
    const normal = field(3, image);
    await f.receive(dm('IMG', normal));
    await f.receive(dm('IMG0', field(3, Buffer.concat([image, varintField(25, 0)]))));
    for (const id of ['IMG', 'IMG0']) {
        const r = records(f, PEER).find(x => x.id === id);
        assert.equal(r.tombstone, undefined, id);
        assert.ok(r.raw.includes(secret), id);
    }
    assert.deepEqual(f.snapshot().losses, []);
    assert.deepEqual(f.errors, []);
});

test('view-once a companion sent, or that this client sends, is never kept either', async t => {
    const f = fixture(t);
    f.login();
    const secret = Buffer.from('MEDIAKEY-SECRET');
    const video = Buffer.concat([field(1, Buffer.from('https://mmg/v')), field(6, secret)]);
    const inner = field(118, wrapped(field(55, wrapped(field(66, video)))));
    await f.receive(dm('DVO', encode({ deviceSentMessage: { destinationJID: OTHER, message: inner } }), { from: OWN_DEVICE }));
    const [own] = records(f, OTHER);
    assert.equal(own.tombstone, 'view-once');
    assert.equal(own.raw, undefined);
    const sender = f.useSender();
    const { id } = await sender._sendMessage(PEER, 'OUTVO', field(9, Buffer.concat([video, varintField(20, 1)])), 'media', {});
    const out = records(f, PEER).find(r => r.id === id);
    assert.equal(out.tombstone, 'view-once');
    assert.equal(out.raw, undefined);
    assert.equal(logHolds(f.dir, secret), false);
});

test('add-ons that act on another message are not kept', async t => {
    const f = fixture(t);
    f.login();
    // MessageKey { remoteJid = 1, id = 3 }
    const key = field(1, Buffer.concat([field(1, Buffer.from(PEER)), field(3, Buffer.from('TARGET'))]));
    const addOns = {
        SCE: field(65, Buffer.concat([key, varintField(2, 1)])),         // scheduledCallEditMessage, CANCEL
        DPR: field(23, key),                                              // declinePaymentRequestMessage
        CPR: field(24, key),                                              // cancelPaymentRequestMessage
        LSM: field(99, wrapped(field(12, varintField(1, 27)))),           // limitSharingMessage { protocolMessage }
        ACP: field(133, wrapped(field(12, varintField(1, 27))))           // acp2SettingMessage { protocolMessage }
    };
    for (const [id, raw] of Object.entries(addOns)) await f.receive(dm(id, raw));
    assert.equal(f.snapshot().counts.records, 0);
    for (const id of Object.keys(addOns)) {
        assert.deepEqual(logEvents(f.dir).filter(e => e.id === id).map(e => e.t), ['inflight', 'resolve'], id);
    }
    assert.deepEqual(f.snapshot().losses, []);
});
